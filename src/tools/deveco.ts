/**
 * `dwguard_deveco` — read-only-ish evidence adapter for DevEco CLI.
 *
 * Runs a fixed set of `devecocli` subcommands (build / run / log / lint / device
 * / ui / verify) from the workspace, captures stdout/stderr + exit code into
 * `artifacts/deveco-<n>/`, and reports the exact command. DSH uses the output as
 * evidence; the executor's own claims are still not trusted.
 *
 * @module dwguard-dsh-hmos/tools/deveco
 */

import { spawn } from 'node:child_process';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { acquireDeviceLock, defaultDevice, releaseDeviceLock, renewDeviceLease } from '../device.js';
import { findProjectRoot, readProjectInfo, resolveInside } from '../harmonyProject.js';
import { findSdkLayout, listSdkModules, lookupSdkApi } from '../harmonySdk.js';
import { scanDeprecatedApi } from '../apiScan.js';
import { fingerprintLayout } from '../uiFingerprint.js';
import { parseCrashLog, parseHilog, type CrashReport, type HilogSummary } from '../forensics.js';
import { summarizeTrace } from '../traceSummary.js';
import { auditPackage } from '../packageAudit.js';
import { analyzeA11yRuntime } from '../a11yRuntime.js';
import { parseScenario, type ScenarioStep } from '../scenario.js';
import { parseFpsOutput, parseHidumperMem, summarizeSamples } from '../perf.js';
import { rotateActiveLog } from '../util/fs.js';
import { recordObservation } from '../observation.js';
import { validateImageFile } from '../media.js';
import { buildFallbackTiers, type FallbackStep } from '../fallback.js';
import type { SharedPaths } from '../paths.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { scanWorkspace } from '../scan.js';
import { nextIndex, updateState } from '../state.js';
import { ensureShared } from '../scaffold.js';
import { ensureDir, listDir, readTextOrNull, writeTextAtomic } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalEnum, optionalInt, optionalString, requiredEnum } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_deveco';
const ACTIONS = [
  'env',
  'build',
  'sign',
  'run',
  'log',
  'lint',
  'device',
  'uiHelp',
  'ui',
  'screenshot',
  'layout',
  'verify',
  'a11y',
  'pipeline',
  'attach',
  'jobs',
  'stop',
  'emulator',
  'app',
  'file',
  'uiassert',
  'trace',
  'project',
  'api',
  'compat',
  'db',
  'perf',
  'scenario',
  'stability'
] as const;

/** Result of one child-process run. */
export interface DevecoRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type DevecoRunner = (command: string, args: readonly string[], cwd: string) => Promise<DevecoRun>;

/** Background job hooks (injectable so tests do not spawn real processes). */
export interface BackgroundDeps {
  start?: (command: string, args: readonly string[], cwd: string, logFile: string) => Promise<number> | number;
  stop?: (pid: number) => Promise<boolean> | boolean;
  alive?: (pid: number) => boolean;
}

/** One recorded background job. */
interface JobFile {
  readonly index: number;
  readonly action: string;
  readonly pid: number;
  readonly command: string;
  readonly startedAt: string;
  readonly logFile: string;
  /** Device lease held for the whole background job (0.8.5). */
  readonly device?: string;
  readonly deviceToken?: string;
}

/** Background lease heartbeat timers, keyed by deveco index. */
const backgroundLeases = new Map<number, { readonly device: string; readonly token: string; readonly timer: NodeJS.Timeout }>();
/** Active background log guards, keyed by deveco index. */
const backgroundLogGuards = new Map<number, { readonly timer: NodeJS.Timeout }>();

function stopBackgroundHeartbeat(index: number): void {
  const lease = backgroundLeases.get(index);
  if (lease === undefined) return;
  clearInterval(lease.timer);
  backgroundLeases.delete(index);
}

function stopBackgroundLogGuard(index: number): void {
  const guard = backgroundLogGuards.get(index);
  if (guard === undefined) return;
  clearInterval(guard.timer);
  backgroundLogGuards.delete(index);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultStart(
  command: string,
  args: readonly string[],
  cwd: string,
  logFile: string
): Promise<number> {
  const { openSync, closeSync } = await import('node:fs');
  const out = openSync(logFile, 'a');
  assertSafeCommand(command);
  const child = spawn(command, process.platform === 'win32' ? args.map(quoteShellArg) : [...args], {
    cwd,
    shell: process.platform === 'win32',
    windowsHide: true,
    detached: true,
    stdio: ['ignore', out, out]
  });
  closeSync(out);
  child.unref();
  return child.pid ?? -1;
}

/** Quote an argument for `cmd.exe`; reject shell metacharacters first. */
export function quoteShellArg(value: string): string {
  if (/[\r\n&|<>^%!`]/u.test(value)) {
    throw new Error(`参数包含 shell 元字符，拒绝执行：${value}`);
  }
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

function assertSafeCommand(command: string): void {
  if (process.platform === 'win32' && /[\r\n&|<>^%!`]/u.test(command)) {
    throw new Error(`命令路径包含 shell 元字符，拒绝执行：${command}`);
  }
}

function defaultStop(pid: number): boolean {
  if (!pidAlive(pid)) return true;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;
/** Keep a runaway CLI from exhausting the host's memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

async function killTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Default runner: spawn `devecocli`, capture output, enforce a timeout.
 * @param command - resolved binary.
 * @param args - fixed subcommand arguments.
 * @param cwd - project root.
 */
function spawnRunner(command: string, args: readonly string[], cwd: string): Promise<DevecoRun> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    assertSafeCommand(command);
    const child = spawn(command, process.platform === 'win32' ? args.map(quoteShellArg) : [...args], {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const abort = (reason: string): void => {
      if (settled) return;
      const pid = child.pid;
      if (pid !== undefined) void killTree(pid);
      finish(() => reject(new Error(reason)));
    };
    const timer = setTimeout(() => {
      abort(`devecocli 超时（${DEFAULT_TIMEOUT_MS / 1000}s）`);
    }, DEFAULT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        abort(`devecocli 输出超过上限（${MAX_OUTPUT_BYTES} B）`);
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        abort(`devecocli 输出超过上限（${MAX_OUTPUT_BYTES} B）`);
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      finish(() =>
        resolvePromise({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started })
      );
    });
  });
}

function tail(text: string, lines = 40): string {
  const split = text.trimEnd().split('\n');
  return split.slice(-lines).join('\n');
}

/** `devecocli` may append a docs-update notice to stdout; extract the JSON body. */
function extractJsonText(text: string): string | null {
  const first = text.search(/[[{]/);
  if (first < 0) return null;
  const opener = text[first];
  const closer = opener === '[' ? ']' : '}';
  const last = text.lastIndexOf(closer);
  if (last <= first) return null;
  const candidate = text.slice(first, last + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function safeToken(value: string): boolean {
  return /^[\w./:=@-]+$/.test(value);
}

/** Parse the first JSON value embedded in CLI output; `null` when absent. */
function jsonValue(text: string): unknown {
  const jsonText = extractJsonText(text);
  if (jsonText === null) return null;
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
}

/** Count matched UI nodes from the various shapes `ui find --format json` may use. */
function countMatches(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['matches', 'elements', 'nodes', 'results', 'items', 'result']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate.length;
  }
  // A single matched node (has bounds/id/type/text) counts as one.
  if (Array.isArray(record['bounds']) || typeof record['id'] === 'string' || typeof record['type'] === 'string') {
    return 1;
  }
  return null;
}

/** Count compatibility change records from `check compat --format json`. */
function countCompatChanges(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['changes', 'incompatible', 'records', 'items', 'details', 'results']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate.length;
  }
  return null;
}

/** Split a comma/whitespace separated token list. */
function splitTokens(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Extract hitrace tag names from `hitrace -l` output. */
function extractHitraceCategories(text: string): string[] {
  const tags: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*([a-z][a-z0-9_]*)\s+-\s+/.exec(line);
    if (match?.[1] !== undefined && !tags.includes(match[1])) tags.push(match[1]);
  }
  return tags;
}

/** Render a display-safe relative path (or the absolute path when outside). */
function safeDisplay(paths: SharedPaths, file: string): string {
  return displayPath(paths, file);
}

/** Write the standard `deveco-<n>/result.json` + `output.log` record. */
async function writeDevecoRecord(
  paths: SharedPaths,
  action: string,
  command: string,
  startedAt: string,
  result: DevecoRun,
  extra: Record<string, unknown> = {}
): Promise<{ index: number; dir: string }> {
  await ensureShared(paths);
  const index = await nextIndex(paths.artifactsDir, 'deveco');
  const dir = `${paths.artifactsDir}/deveco-${index}`;
  await ensureDir(dir);
  const record = {
    schemaVersion: 1,
    index,
    action,
    command,
    cwd: paths.workspace,
    startedAt,
    exitCode: result.code,
    durationMs: result.durationMs,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
    ...extra
  };
  await writeTextAtomic(`${dir}/result.json`, `${JSON.stringify(record, null, 2)}\n`);
  await writeTextAtomic(`${dir}/output.log`, `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`);
  return { index, dir };
}

/** Allocate one `artifacts/deveco-<n>/` directory before a multi-step capture. */
async function prepareActionDir(paths: SharedPaths): Promise<{ index: number; dir: string }> {
  await ensureShared(paths);
  const index = await nextIndex(paths.artifactsDir, 'deveco');
  const dir = `${paths.artifactsDir}/deveco-${index}`;
  await ensureDir(dir);
  return { index, dir };
}

/** Write `result.json` + `output.log` into an already-allocated action directory. */
async function writeActionRecord(
  dir: string,
  action: string,
  command: string,
  startedAt: string,
  result: DevecoRun,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await writeTextAtomic(
    `${dir}/result.json`,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        action,
        command,
        cwd: '',
        startedAt,
        exitCode: result.code,
        durationMs: result.durationMs,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
        ...extra
      },
      null,
      2
    )}\n`
  );
  await writeTextAtomic(`${dir}/output.log`, `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StabilityResult {
  readonly crashes: readonly CrashReport[];
  readonly freezes: readonly CrashReport[];
  readonly errors: number;
  readonly hilog: HilogSummary | null;
  readonly passed: boolean;
  readonly crashTail: string;
  readonly hilogTail: string;
}

/** Collect crash + hilog evidence for a scenario/stability window. */
async function collectStability(
  runner: DevecoRunner,
  binary: string,
  device: string | undefined,
  tailLines: number,
  cwd: string
): Promise<StabilityResult> {
  const baseArgs = device === undefined ? [] : ['--device', device];
  const crashRun = await runner(binary, ['log', '--crash', ...baseArgs], cwd);
  const hilogRun = await runner(binary, ['log', '--tail', String(tailLines), ...baseArgs], cwd);
  const crashes = parseCrashLog(crashRun.stdout);
  const freezes = crashes.filter((report) => report.type === 'appfreeze');
  const hilog = parseHilog(hilogRun.stdout, { maxLines: tailLines });
  return {
    crashes,
    freezes,
    errors: hilog.errors.reduce((sum, entry) => sum + entry.count, 0),
    hilog,
    passed: crashes.length === 0,
    crashTail: tail(crashRun.stdout, 20),
    hilogTail: tail(hilogRun.stdout, 10)
  };
}

/** One node of the layout-tree snapshot. */
interface A11yNode {
  readonly id?: string;
  readonly type?: string;
  readonly text?: string;
  readonly bounds?: readonly number[];
  readonly clickable?: boolean;
  readonly accessibilityId?: string;
  readonly children?: readonly A11yNode[];
}

/** Flatten the nested layout tree into a node list. */
function flattenA11y(value: unknown, out: A11yNode[] = []): A11yNode[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenA11y(item, out);
    return out;
  }
  if (typeof value !== 'object' || value === null) return out;
  const record = value as Record<string, unknown>;
  out.push({
    ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    ...(typeof record['type'] === 'string' ? { type: record['type'] } : {}),
    ...(typeof record['text'] === 'string' ? { text: record['text'] } : {}),
    ...(Array.isArray(record['bounds']) ? { bounds: record['bounds'] as number[] } : {}),
    ...(record['clickable'] === true ? { clickable: true } : {}),
    ...(typeof record['accessibilityId'] === 'string' ? { accessibilityId: record['accessibilityId'] } : {})
  });
  if (Array.isArray(record['children'])) flattenA11y(record['children'], out);
  return out;
}

/** Resolve `devecocli`: configured path, npm global bins, then PATH. */
function resolveBinary(configured: string): string {
  if (configured.length > 0) return resolve(configured);
  const candidates: string[] = [];
  if (process.env['LOCALAPPDATA'] !== undefined) {
    candidates.push(join(process.env['LOCALAPPDATA'], 'Programs', 'nodejs', 'devecocli.cmd'));
  }
  if (process.env['APPDATA'] !== undefined) {
    candidates.push(join(process.env['APPDATA'], 'npm', 'devecocli.cmd'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'devecocli';
}

/**
 * Create the DevEco CLI adapter tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context.
 * @param runner - injectable runner (tests pass a fake).
 * @param background - injectable background start/stop/alive hooks.
 */
export function createDevecoTool(
  options: Options,
  ctx?: PluginContext,
  runner: DevecoRunner = spawnRunner,
  background: BackgroundDeps = {}
): ToolDefinition<unknown, ToolResult> {
  const startJob = background.start ?? defaultStart;
  const stopJob = background.stop ?? defaultStop;
  const alive = background.alive ?? pidAlive;
  return defineTool<unknown, ToolResult>({
    name: TOOL,
    description:
      'Run DevEco CLI (`devecocli`) + HarmonyOS workbench evidence commands. ' +
      'Base: env / build / sign / run / log / lint / device / uiHelp / ui / screenshot / layout / a11y / verify / pipeline / attach / jobs / stop. ' +
      'Workbench: emulator (list/start/stop/create/delete/rotate/volume/fold/battery/geolocation/scene/sensor/power/shake + fold/battery/GPS/sensor 状态注入), app (list/foreground/info/start/install/uninstall/stop/clearcache/cleardata; device=all 逐台查询), file (send/recv/exist/delete), db (device sqlite3 只读 SELECT/WITH/EXPLAIN), uiassert (selector present/absent/count/fingerprint, device=all 逐台出表), trace (hdc hitrace 原始抓取 + 切片统计摘要，device=all), project (read build-profile/app/module/oh-package + HAP artifacts), api (lookup/versions/list + scan deprecated API usage), compat (check compat source→target), log (op=crash parses jscrash/cppcrash/appfreeze top frames; op=hilog folds errors, supports regex/pid/keyword filters and follow). ' +
      '`pipeline` = sign → build → run → screenshot → layout with per-step evidence, stop-on-failure, optional resume; `uiassert` is a deterministic UI assertion (not vision); `project` / `api` are read-only and execute nothing; `trace` runs `hdc shell hitrace`. ' +
      'Writes command + exit code + output under `artifacts/deveco-<n>/`; DSH cites this as evidence, never as executor self-verification. ' +
      '`a11y` = 布局树快照 + accessibilityId + 工作区静态无障碍扫描；长命令加 `background: true` 立即返回 job id；`attach` 复用已有日志；`screenshot` / `layout` / `verify` 走真实设备取证。',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: '要执行的 devecocli 动作。' },
      module: { type: 'string', description: 'build/run 的模块名；api 的模块名（如 @ohos.promptAction / @kit.ArkUI）。' },
      device: { type: 'string', description: '设备序列号（可选；缺省取设备池里的直板机）。' },
      level: { type: 'string', description: 'log 的级别 D/I/W/E/F（可选）。' },
      crash: { type: 'boolean', description: 'log 是否只看崩溃日志（可选）。' },
      apply: { type: 'string', description: 'run 的增量部署清单文件名（放在工程 .hvigor/ 下，可选）。' },
      hap: { type: 'string', description: 'pipeline fallback / app install 的安装包路径（相对工作区或绝对路径）。' },
      bundle: { type: 'string', description: 'verify/pipeline fallback/app 的 bundleName。' },
      ability: { type: 'string', description: 'pipeline fallback / app start 的 Ability 名（如 EntryAbility）。' },
      args: { type: 'string', description: 'ui / emulator / app 的附加参数（空格分隔，仅允许安全字符）。' },
      file: { type: 'string', description: 'attach：要登记为证据的已有文件（相对工作区或 `.shared/`）。' },
      background: { type: 'boolean', description: 'build/run/log/emulator start 是否后台执行并立即返回 job id（默认 false）。' },
      resume: { type: 'boolean', description: 'pipeline：跳过上一次 pipeline 已成功的步骤（默认 false）。' },
      job: { type: 'string', description: 'stop：job id（即 deveco-<n> 的 n，或 pid）。' },
      plan: { type: 'string', description: 'verify：自然语言测试步骤与预期结果。' },
      op: { type: 'string', description: 'emulator/app/file/api/compat/log 的子动作；不传时用各自默认值。' },
      emulator: { type: 'string', description: 'emulator：实例名或序列号（start/stop/create/delete 可逗号分隔多个）。' },
      direction: { type: 'string', description: 'emulator rotate/volume 的方向参数。' },
      selector: { type: 'string', description: 'uiassert：控件选择器（如 text=登录 / id=submit / text*=Log）。' },
      expect: { type: 'string', enum: ['present', 'absent', 'count', 'fingerprint'], description: 'uiassert 的期望（默认 present）。' },
      count: { type: 'number', description: 'uiassert：expect=count 时的期望匹配数。' },
      fingerprint: { type: 'string', description: 'uiassert：expect=fingerprint 时的期望布局指纹；不传则只采集。' },
      regex: { type: 'string', description: 'log op=hilog：消息正则过滤（可选）。' },
      pid: { type: 'number', description: 'log op=hilog：按进程 pid 过滤（可选）。' },
      timeoutMs: { type: 'number', description: 'uiassert：等待超时毫秒（100–120000，默认 3000）。' },
      window: { type: 'string', description: 'uiassert：目标窗口 id（可选）。' },
      src: { type: 'string', description: 'file send 的本地路径 / file recv 与 exist/delete 的设备路径。' },
      dst: { type: 'string', description: 'file send 的设备目标路径 / file recv 的本地目标路径。' },
      path: { type: 'string', description: 'project：工程目录（相对工作区，默认工作区）。' },
      name: { type: 'string', description: 'api：可选声明名过滤（如 showToast）。' },
      sourceVersion: { type: 'string', description: 'compat：当前 SDK 版本（缺省从工程 build-profile 推断）。' },
      targetVersion: { type: 'string', description: 'compat：目标 SDK 版本（缺省从工程 build-profile 推断）。' },
      modules: { type: 'string', description: 'compat：要检查的模块（逗号/空格分隔，可选）。' },
      files: { type: 'string', description: 'compat：要检查的文件（逗号/空格分隔，可选；与 modules 互斥）。' },
      duration: { type: 'number', description: 'trace：抓取秒数（1–60，默认 5）。' },
      categories: { type: 'string', description: 'trace：hitrace 分类（逗号/空格分隔，可选）。' },
      bufferKb: { type: 'number', description: 'trace：hitrace 缓冲区大小 KB（64–65536，默认 4096）。' },
      db: { type: 'string', description: 'db：设备上的 SQLite 数据库路径。' },
      sql: { type: 'string', description: 'db：只读 SQL（仅 SELECT / WITH / EXPLAIN）。' },
      follow: { type: 'boolean', description: 'log op=hilog：持续跟踪日志（自动转后台任务，默认 false）。' },
      keyword: { type: 'string', description: 'log op=hilog：关键字过滤（--keyword）。' },
      batteryLevel: { type: 'number', description: 'emulator battery：电量 0–100。' },
      batteryStatus: { type: 'string', enum: ['charging', 'discharging'], description: 'emulator battery：充电状态。' },
      latitude: { type: 'number', description: 'emulator geolocation：纬度 -90–90。' },
      longitude: { type: 'number', description: 'emulator geolocation：经度 -180–180。' },
      foldState: { type: 'string', description: 'emulator fold：折叠态（open / half-open / close / vertical-open / single）。' },
      sensor: { type: 'string', description: 'emulator sensor：key=value 列表（light-intensity / humidity / temperature / steps / heartrate）。' },
      samples: { type: 'number', description: 'perf：采样次数（1–20，默认 3）。' },
      warmup: { type: 'number', description: 'perf startup：预热次数（默认 1，不计入样本）。' },
      scenario: { type: 'string', description: 'scenario：步骤 JSON 或工作区内 JSON 文件路径。' },
      continueOnFailure: { type: 'boolean', description: 'scenario：某步失败后是否继续（默认 false，失败即停）。' },
      stability: { type: 'boolean', description: 'scenario：结束后收集 crash/hilog 并写 stability.json（默认 false）。' },
      tail: { type: 'number', description: 'scenario/stability：hilog 收集行数（默认 300）。' },
      maxHapMb: { type: 'number', description: 'project audit：单个 HAP 体积预算 MB（0 = 不设预算）。' },
      minTouch: { type: 'number', description: 'a11y op=runtime：最小触控目标尺寸（默认 44）。' },
      minContrast: { type: 'number', description: 'a11y op=runtime：最低对比度（默认 4.5）。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const action = requiredEnum(args, 'action', ACTIONS, TOOL);
      const module = optionalString(args, 'module', TOOL, 120);
      let device = optionalString(args, 'device', TOOL, 200);
      const level = optionalString(args, 'level', TOOL, 1);
      const crash = args['crash'] === true;
      const applyFile = optionalString(args, 'apply', TOOL, 200);
      const hapArg = optionalString(args, 'hap', TOOL, 400);
      const bundleArg = optionalString(args, 'bundle', TOOL, 200);
      const abilityArg = optionalString(args, 'ability', TOOL, 200);
      const uiArgs = optionalString(args, 'args', TOOL, 400);
      const opArg = optionalString(args, 'op', TOOL, 40);
      const emulatorName = optionalString(args, 'emulator', TOOL, 120);
      const direction = optionalString(args, 'direction', TOOL, 40);
      const selector = optionalString(args, 'selector', TOOL, 400);
      const expect = optionalEnum(args, 'expect', ['present', 'absent', 'count', 'fingerprint'] as const, TOOL) ?? 'present';
      const expectCount = optionalInt(args, 'count', -1, TOOL, 0, 100000);
      const fingerprintArg = optionalString(args, 'fingerprint', TOOL, 120);
      const regexArg = optionalString(args, 'regex', TOOL, 300);
      const pidArg = optionalInt(args, 'pid', -1, TOOL, 0, 1000000);
      const timeoutMs = optionalInt(args, 'timeoutMs', 3000, TOOL, 100, 120000);
      const windowId = optionalString(args, 'window', TOOL, 80);
      const srcArg = optionalString(args, 'src', TOOL, 500);
      const dstArg = optionalString(args, 'dst', TOOL, 500);
      const projectPath = optionalString(args, 'path', TOOL, 500);
      const apiName = optionalString(args, 'name', TOOL, 120);
      const sourceVersion = optionalString(args, 'sourceVersion', TOOL, 120);
      const targetVersion = optionalString(args, 'targetVersion', TOOL, 120);
      const modulesArg = optionalString(args, 'modules', TOOL, 400);
      const filesArg = optionalString(args, 'files', TOOL, 800);
      const durationArg = optionalInt(args, 'duration', 5, TOOL, 1, 60);
      const categoriesArg = optionalString(args, 'categories', TOOL, 300);
      const bufferKb = optionalInt(args, 'bufferKb', 4096, TOOL, 64, 65536);
      const dbArg = optionalString(args, 'db', TOOL, 500);
      const sqlArg = optionalString(args, 'sql', TOOL, 4000);
      const follow = args['follow'] === true;
      const keywordArg = optionalString(args, 'keyword', TOOL, 200);
      const batteryLevel =
        typeof args['batteryLevel'] === 'number' && Number.isFinite(args['batteryLevel']) ? args['batteryLevel'] : undefined;
      const batteryStatus = optionalEnum(args, 'batteryStatus', ['charging', 'discharging'] as const, TOOL);
      const latitude =
        typeof args['latitude'] === 'number' && Number.isFinite(args['latitude']) ? args['latitude'] : undefined;
      const longitude =
        typeof args['longitude'] === 'number' && Number.isFinite(args['longitude']) ? args['longitude'] : undefined;
      const foldState = optionalString(args, 'foldState', TOOL, 40);
      const sensorArg = optionalString(args, 'sensor', TOOL, 300);
      const samplesArg = optionalInt(args, 'samples', 3, TOOL, 1, 20);
      const warmupArg = optionalInt(args, 'warmup', 1, TOOL, 0, 10);
      const scenarioArg = optionalString(args, 'scenario', TOOL, 12000);
      const continueOnFailure = args['continueOnFailure'] === true;
      const stabilityFlag = args['stability'] === true;
      const tailArg = optionalInt(args, 'tail', 300, TOOL, 1, 2000);
      const maxHapMb =
        typeof args['maxHapMb'] === 'number' && Number.isFinite(args['maxHapMb']) ? args['maxHapMb'] : undefined;
      const minTouch = optionalInt(args, 'minTouch', 44, TOOL, 1, 1000);
      const minContrast =
        typeof args['minContrast'] === 'number' && Number.isFinite(args['minContrast']) ? args['minContrast'] : 4.5;

      if (level !== undefined && !/^[DIWEF]$/i.test(level)) return fail('level 只能是 D/I/W/E/F。');
      if (applyFile !== undefined && (/[\\/]/.test(applyFile) || applyFile.includes('..'))) {
        return fail('apply 只接受工程 `.hvigor/` 下的文件名，不能带路径。');
      }
      const extra: string[] = [];
      if (uiArgs !== undefined) {
        for (const token of uiArgs.split(/\s+/).filter((part) => part.length > 0)) {
          if (!safeToken(token)) return fail(`ui 参数含不允许的字符：${token}`);
          extra.push(token);
        }
      }

      const policy = options.device;
      const DEVICE_ACTIONS = new Set([
        'run',
        'log',
        'ui',
        'screenshot',
        'layout',
        'a11y',
        'verify',
        'pipeline',
        'app',
        'file',
        'uiassert',
        'trace',
        'db'
      ]);
      const deviceAction = DEVICE_ACTIONS.has(action);
      const resolvedDevice = device ?? defaultDevice(policy)?.sn;
      if (device === undefined && deviceAction && resolvedDevice !== undefined) device = resolvedDevice;

      // Job control: list or stop background devecocli runs.
      if (action === 'jobs') {
        const entries = await listDir(paths.artifactsDir);
        const jobs: (JobFile & { running: boolean })[] = [];
        for (const name of entries) {
          const match = /^deveco-(\d+)$/.exec(name);
          if (match?.[1] === undefined) continue;
          const raw = await readTextOrNull(`${paths.artifactsDir}/deveco-${match[1]}/job.json`);
          if (raw === null) continue;
          try {
            const job = JSON.parse(raw) as JobFile;
            const running = alive(job.pid);
            if (!running) {
              stopBackgroundHeartbeat(job.index);
              stopBackgroundLogGuard(job.index);
              if (job.device !== undefined && job.deviceToken !== undefined) {
                await releaseDeviceLock(paths, job.device, job.deviceToken);
              }
            }
            jobs.push({ ...job, running });
          } catch {
            /* skip corrupt job file */
          }
        }
        jobs.sort((left, right) => right.index - left.index);
        const running = jobs.filter((job) => job.running).length;
        const detail = jobs.length === 0
          ? '还没有后台任务。给 build/run/log 加 `background: true` 即可。'
          : jobs
              .map((job) => `- deveco-${job.index} · ${job.action} · pid ${job.pid} · ${job.running ? 'running' : 'finished'} · \`${job.command}\``)
              .join('\n');
        return ok(`后台任务 ${jobs.length} 个（${running} 个运行中）`, {
          detail,
          next: running > 0 ? '用 `stop` + `job` 终止不需要的任务。' : '没有运行中的任务。'
        });
      }

      if (action === 'stop') {
        const target = optionalString(args, 'job', TOOL, 120);
        if (target === undefined) return fail('stop 需要 `job`（deveco-<n> 的 n，或 pid）。');
        const entries = await listDir(paths.artifactsDir);
        let found: JobFile | null = null;
        for (const name of entries) {
          const match = /^deveco-(\d+)$/.exec(name);
          if (match?.[1] === undefined) continue;
          const raw = await readTextOrNull(`${paths.artifactsDir}/deveco-${match[1]}/job.json`);
          if (raw === null) continue;
          try {
            const job = JSON.parse(raw) as JobFile;
            if (String(job.index) === target || String(job.pid) === target) found = job;
          } catch {
            /* skip corrupt job file */
          }
        }
        if (found === null) return fail(`找不到后台任务：${target}`);
        const stopped = await stopJob(found.pid);
        stopBackgroundHeartbeat(found.index);
        stopBackgroundLogGuard(found.index);
        if (found.device !== undefined && found.deviceToken !== undefined) {
          await releaseDeviceLock(paths, found.device, found.deviceToken);
        }
        return stopped
          ? ok(`已停止 deveco-${found.index}（pid ${found.pid}）`, { next: '用 `jobs` 确认没有残留；日志仍在 artifacts 里。' })
          : fail(`停止 deveco-${found.index} 失败（pid ${found.pid}）`);
      }

      // Evidence reuse: register an existing build/deploy log without rebuilding.
      if (action === 'attach') {
        const file = optionalString(args, 'file', TOOL, 400);
        if (file === undefined) return fail('attach 需要 `file`（相对工作区或 `.shared/`）。');
        const source = resolve(paths.workspace, file);
        const inside = (base: string): boolean => source === base || source.startsWith(`${base}${sep}`);
        if (!inside(paths.workspace) && !inside(paths.shared)) {
          return fail('attach 的文件必须在工作区或 `.shared/` 内。');
        }
        const info = await stat(source).catch(() => null);
        if (info === null || !info.isFile()) return fail(`attach 文件不存在：${file}`);
        await ensureShared(paths);
        const index = await nextIndex(paths.artifactsDir, 'deveco');
        const dir = `${paths.artifactsDir}/deveco-${index}`;
        await ensureDir(dir);
        const stored = `attached-${basename(source)}`;
        await copyFile(source, `${dir}/${stored}`);
        const now = nowIso();
        const record = {
          schemaVersion: 1,
          index,
          action,
          command: `attach ${file}`,
          cwd: paths.workspace,
          startedAt: now,
          exitCode: 0,
          durationMs: 0,
          bytes: info.size,
          stdout: `attached ${file} (${info.size} B)`,
          stderr: ''
        };
        await writeTextAtomic(`${dir}/result.json`, `${JSON.stringify(record, null, 2)}\n`);
        await writeTextAtomic(`${dir}/output.log`, record.stdout);
        await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));
        return ok(`已登记证据：${stored}（${info.size} B）`, {
          detail: [
            `来源：\`${file}\``,
            `证据：\`${displayPath(paths, `${dir}/${stored}`)}\``,
            '没有执行构建，避免和已有构建重复。'
          ].join('\n'),
          files: [displayPath(paths, `${dir}/result.json`), displayPath(paths, `${dir}/${stored}`)],
          next: '把证据路径写进 `checks[].evidenceFiles`（相对 `.shared/`）。'
        });
      }

      // End-to-end execution chain: sign → build → run → screenshot → layout.
      // It records every step and stops at the first failure; it is evidence,
      // never an acceptance claim (the audit still decides).
      if (action === 'pipeline') {
        const resume = args['resume'] === true;
        const binary = resolveBinary(options.devecocliPath);
        const now = nowIso();
        const specRaw = await readTextOrNull(paths.specJson);
        let specVersion = 0;
        if (specRaw !== null) {
          try {
            const parsed = JSON.parse(specRaw) as { specVersion?: unknown };
            if (typeof parsed.specVersion === 'number') specVersion = Math.trunc(parsed.specVersion);
          } catch {
            /* a missing/broken spec is recorded as version 0 */
          }
        }
        const shotPath = `${paths.artifactsDir}/devshots/pipeline-${Date.now()}.png`;
        await ensureDir(dirname(shotPath));
        const steps = [
          { name: 'sign', args: ['signature', 'generate'] },
          { name: 'build', args: ['build', ...(module === undefined ? [] : ['--modules', module])] },
          {
            name: 'run',
            args: ['run', ...(module === undefined ? [] : ['--module', module]), ...(device === undefined ? [] : ['--device', device]), ...(applyFile === undefined ? [] : ['--apply', applyFile])]
          },
          { name: 'screenshot', args: ['ui', 'screenshot', '--path', shotPath, ...(device === undefined ? [] : ['--device', device])] },
          { name: 'layout', args: ['ui', 'layout', '--format', 'json', '--mode', 'full', ...(device === undefined ? [] : ['--device', device])] }
        ];
        const completed = new Set<string>();
        if (resume) {
          const dirs = (await listDir(paths.artifactsDir))
            .filter((name) => /^deveco-\d+$/.test(name))
            .sort((left, right) => Number.parseInt(right.slice(7), 10) - Number.parseInt(left.slice(7), 10));
          for (const name of dirs) {
            const raw = await readTextOrNull(`${paths.artifactsDir}/${name}/pipeline.json`);
            if (raw === null) continue;
            try {
              const parsed = JSON.parse(raw) as { specVersion?: number; steps?: Array<{ name?: string; ok?: boolean }> };
              if (parsed.specVersion !== specVersion || !Array.isArray(parsed.steps)) continue;
              for (const step of parsed.steps) {
                if (step.ok === true && typeof step.name === 'string') completed.add(step.name);
              }
              break;
            } catch {
              /* skip corrupt pipeline record */
            }
          }
        }
        let lockHolder: string | null = null;
        let lockToken: string | null = null;
        if (device !== undefined) {
          const lock = await acquireDeviceLock(paths, device, `${TOOL}:pipeline:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: Math.max(policy.lockTimeoutMs, 10 * 60_000)
          });
          if (!lock.ok) {
            return fail(lock.reason, {
              next: '等占用设备的一轮取证结束，或用 `dwguard_deveco`（action: device）查看设备池。'
            });
          }
          lockHolder = device;
          lockToken = lock.token;
        }
        await ensureShared(paths);
        const index = await nextIndex(paths.artifactsDir, 'deveco');
        const dir = `${paths.artifactsDir}/deveco-${index}`;
        await ensureDir(dir);
        const started = Date.now();
        const layoutFallbackPath = `${dir}/layout-fallback.json`;
        const requestedHap = hapArg === undefined ? undefined : resolve(paths.workspace, hapArg);
        const hapPath =
          requestedHap !== undefined && existsSync(requestedHap) && requestedHap.startsWith(`${paths.workspace}${sep}`)
            ? requestedHap
            : undefined;
        type StepAttempt = {
          tier: 'devecocli' | 'mcp' | 'hdc+hvigor';
          command: string;
          args: string[];
          code: number;
          durationMs: number;
          ok: boolean;
          stdout: string;
          stderr: string;
        };
        type StepRecord = {
          name: string;
          command: string;
          code: number;
          durationMs: number;
          ok: boolean;
          stdout: string;
          stderr: string;
          tier?: string;
          attempts?: StepAttempt[];
          skipped?: boolean;
        };
        const records: StepRecord[] = [];
        let failed: string | undefined;
        let layoutWritten = false;

        const attempt = async (
          tier: StepAttempt['tier'],
          command: string,
          commandArgs: readonly string[]
        ): Promise<StepAttempt> => {
          try {
            const run = await runner(command, commandArgs, paths.workspace);
            return {
              tier,
              command: `${command} ${commandArgs.join(' ')}`,
              args: [...commandArgs],
              code: run.code,
              durationMs: run.durationMs,
              ok: run.code === 0,
              stdout: run.stdout,
              stderr: run.stderr
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              tier,
              command: `${command} ${commandArgs.join(' ')}`,
              args: [...commandArgs],
              code: -1,
              durationMs: 0,
              ok: false,
              stdout: '',
              stderr: message
            };
          }
        };

        try {
          for (const step of steps) {
            if (completed.has(step.name)) {
              records.push({
                name: step.name,
                command: '(resumed: already successful)',
                code: 0,
                durationMs: 0,
                ok: true,
                stdout: '',
                stderr: '',
                skipped: true
              });
              if (step.name === 'layout') layoutWritten = existsSync(`${dir}/layout.json`);
              continue;
            }

            const attempts: StepAttempt[] = [await attempt('devecocli', binary, step.args)];
            let success = attempts[0];
            if (success?.ok !== true) {
              const tiers = buildFallbackTiers({
                step: step.name as FallbackStep,
                primaryArgs: step.args,
                mcpCommand: options.devecoMcpCommand,
                hdcPath: options.hdcPath,
                hvigorPath: options.hvigorPath,
                ...(device === undefined ? {} : { device }),
                ...(hapPath === undefined ? {} : { hapPath }),
                ...(bundleArg === undefined ? {} : { bundle: bundleArg }),
                ...(abilityArg === undefined ? {} : { ability: abilityArg }),
                screenshotPath: shotPath,
                layoutPath: layoutFallbackPath
              });
              for (const tier of tiers) {
                const tierAttempts: StepAttempt[] = [];
                let allOk = true;
                for (const command of tier.commands) {
                  const one = await attempt(tier.name, command.command, command.args);
                  tierAttempts.push(one);
                  attempts.push(one);
                  if (!one.ok) {
                    allOk = false;
                    break;
                  }
                }
                if (allOk && tierAttempts.length > 0) {
                  success = tierAttempts[tierAttempts.length - 1];
                  break;
                }
              }
            }

            const final = success ?? attempts[attempts.length - 1];
            if (final === undefined) {
              failed = step.name;
              records.push({ name: step.name, command: '', code: -1, durationMs: 0, ok: false, stdout: '', stderr: 'no attempt', attempts });
              break;
            }
            records.push({
              name: step.name,
              command: final.command,
              code: final.code,
              durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0),
              ok: final.ok,
              stdout: tail(final.stdout),
              stderr: tail(final.stderr),
              tier: final.tier,
              attempts: attempts.map((item) => ({ ...item, stdout: tail(item.stdout, 12), stderr: tail(item.stderr, 12) }))
            });
            if (!final.ok) {
              failed = step.name;
              break;
            }
            if (step.name === 'layout') {
              const layoutSource =
                final.tier === 'hdc+hvigor' && existsSync(layoutFallbackPath)
                  ? await readTextOrNull(layoutFallbackPath)
                  : final.stdout;
              const json = layoutSource === null ? null : extractJsonText(layoutSource);
              if (json !== null) {
                await writeTextAtomic(`${dir}/layout.json`, `${json}\n`);
                layoutWritten = true;
              }
            }
          }
        } finally {
          if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
        }
        if (failed === undefined && !completed.has('screenshot')) {
          const screenshotCheck = await validateImageFile(shotPath);
          if (!screenshotCheck.ok) {
            failed = 'screenshot';
            const record = records.find((item) => item.name === 'screenshot');
            if (record !== undefined) {
              record.ok = false;
              record.stderr = `截图校验失败：${screenshotCheck.reason ?? '未知原因'}`;
            }
          } else if (!completed.has('layout') && !layoutWritten) {
            failed = 'layout';
            const record = records.find((item) => item.name === 'layout');
            if (record !== undefined) {
              record.ok = false;
              record.stderr = '布局树没有可解析的 JSON';
            }
          }
        }
        const record = {
          schemaVersion: 1,
          index,
          action: 'pipeline',
          specVersion,
          command: `${binary} pipeline`,
          startedAt: now,
          exitCode: failed === undefined ? 0 : 1,
          durationMs: Date.now() - started,
          device,
          steps: records,
          ...(failed === undefined ? {} : { failedStep: failed })
        };
        let observationRef: string | undefined;
        if (failed === undefined) {
          const observationFiles = [
            `${dir}/pipeline.json`,
            ...(layoutWritten ? [`${dir}/layout.json`] : []),
            ...(existsSync(shotPath) ? [shotPath] : [])
          ].filter((file) => existsSync(file));
          observationRef = await recordObservation(
            paths,
            { action: 'pipeline', ...(device === undefined ? {} : { device }), specVersion, files: observationFiles },
            now
          );
        }
        const finalRecord = { ...record, ...(observationRef === undefined ? {} : { observationRef }) };
        await writeTextAtomic(`${dir}/pipeline.json`, `${JSON.stringify(finalRecord, null, 2)}\n`);
        await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));
        const files = [displayPath(paths, `${dir}/pipeline.json`), ...(layoutWritten ? [displayPath(paths, `${dir}/layout.json`)] : [])];
        if (failed !== undefined) {
          return fail(`pipeline 在 \`${failed}\` 失败，后续步骤已停止。`, {
            detail: [
              `- 证据：\`${displayPath(paths, `${dir}/pipeline.json`)}\``,
              `- 失败步骤：\`${failed}\``,
              `- resume：修复后可用 \`pipeline\` + \`resume: true\` 跳过已成功步骤。`,
              '- fallback：`devecocli` → `deveco-mcp` → `hdc+hvigor`；每次切换保留失败原因与已完成步骤。'
            ].join('\n'),
            files,
            next: '先按失败步骤分类（环境/代码/设备/签名），再 resume 或转人工；不要跳过审计。'
          });
        }
        return ok(`pipeline 完成 ${records.length} 步（sign/build/run/screenshot/layout）。`, {
          detail: [
            `- 证据：\`${displayPath(paths, `${dir}/pipeline.json`)}\``,
            `- 设备：${device ?? '默认'}`,
            `- specVersion：${specVersion}`,
            ...(observationRef === undefined ? [] : [`- observationRef：\`${observationRef}\``]),
            '- 这只是执行证据；是否通过仍由 `dwguard_audit` 的四维判据决定。'
          ].join('\n'),
          files,
          next: '把 pipeline 证据交给 `dwguard_audit`；不要用“跑通了”替代四维验收。'
        });
      }

      // Read-only project introspection: no CLI, no build, nothing written outside artifacts.
      if (action === 'project') {
        const requested = projectPath ?? '.';
        const target = resolveInside(paths.workspace, requested);
        if (target === null) return fail('project 的 path 必须在工作区内（相对路径或工作区内的绝对路径）。');
        if (!existsSync(target)) return fail(`目录不存在：${requested}`);
        const root = findProjectRoot(target);
        if (root === null) {
          return fail('没有找到 build-profile.json5：请把 path 指向 DevEco 工程根目录（或只含一个工程的工作区）。', {
            next: '确认工程根目录有 build-profile.json5；也可以用 `dwguard_deveco` action=env 先确认 SDK/devecocli。'
          });
        }
        const projectOp = opArg ?? 'summary';
        if (projectOp !== 'summary' && projectOp !== 'audit') {
          return fail(`project 的 op 只能是 summary / audit（收到 ${projectOp}）。`);
        }
        if (projectOp === 'audit') {
          const audit = auditPackage(root, { ...(maxHapMb === undefined ? {} : { maxHapMb }) });
          const now = nowIso();
          const { dir } = await writeDevecoRecord(paths, 'project', `local project audit ${safeDisplay(paths, root)}`, now, {
            code: 0,
            stdout: JSON.stringify(audit),
            stderr: '',
            durationMs: 0
          });
          await writeTextAtomic(`${dir}/project-audit.json`, `${JSON.stringify(audit, null, 2)}\n`);
          const blockers = audit.findings.filter((finding) => finding.severity === 'blocker');
          const majors = audit.findings.filter((finding) => finding.severity === 'major');
          const detail = [
            `工程：\`${safeDisplay(paths, root)}\``,
            `声明权限：${String(audit.declared.length)} · 源码引用：${String(audit.referenced.length)} · 扫描文件：${String(audit.scannedFiles)}`,
            `产物：${audit.artifacts.length === 0 ? '（未构建）' : audit.artifacts.map((artifact) => `\`${artifact.path}\` ${(artifact.bytes / 1024 / 1024).toFixed(2)}MB ${artifact.structurallySigned ? '签名结构存在' : '未发现签名文件'}`).join('<br>')}`,
            '',
            '| 类别 | 级别 | 说明 |',
            '| --- | --- | --- |',
            ...audit.findings.slice(0, 30).map(
              (finding) => `| ${finding.kind} | ${finding.severity} | ${finding.message.replace(/\|/g, '\\|')} |`
            ),
            ...(audit.findings.length === 0 ? ['| — | — | 未发现权限/隐私/体积/签名问题 |'] : [])
          ].join('\n');
          const summary = `project audit：${String(audit.findings.length)} 个问题（blocker ${String(blockers.length)} / major ${String(majors.length)}）`;
          return blockers.length === 0
            ? ok(summary, {
                detail,
                files: [safeDisplay(paths, `${dir}/project-audit.json`)],
                next: '把 project-audit.json 写进权限/隐私/包体判据的 evidenceFiles；major 是否阻断由任务包决定。'
              })
            : fail(summary, {
                detail,
                files: [safeDisplay(paths, `${dir}/project-audit.json`)],
                next: '先补声明或移除未声明权限引用；签名/隐私问题按任务包判据处理。'
              });
        }
        const info = readProjectInfo(root);
        const now = nowIso();
        const { dir } = await writeDevecoRecord(
          paths,
          'project',
          `local project ${safeDisplay(paths, root)}`,
          now,
          { code: 0, stdout: JSON.stringify(info), stderr: '', durationMs: 0 },
          { projectRoot: safeDisplay(paths, root) }
        );
        await writeTextAtomic(`${dir}/project.json`, `${JSON.stringify(info, null, 2)}\n`);
        await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));
        const detail = [
          `工程：\`${safeDisplay(paths, root)}\``,
          `bundleName：${info.bundleName ?? '（未声明）'}`,
          `版本：${info.versionName ?? '?'}（versionCode ${info.versionCode ?? '?'}）`,
          `SDK：compile ${info.apiVersions.compileSdkVersion ?? '?'} · compatible ${info.apiVersions.compatibleSdkVersion ?? '?'} · target ${info.apiVersions.targetSdkVersion ?? '?'}`,
          `产品：${info.products.length === 0 ? '（无）' : info.products.join(' · ')}`,
          `构建模式：${info.buildModes.length === 0 ? '（无）' : info.buildModes.join(' · ')}`,
          `签名配置：${info.signingConfigs.length === 0 ? '（无）' : info.signingConfigs.join(' · ')}（只读名称，不读证书/密码）`,
          '',
          '| 模块 | 类型 | 设备 | Ability | 权限 | 页面 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...info.modules.map(
            (entry) =>
              `| ${entry.name} | ${entry.type} | ${entry.deviceTypes.join(',') || '-'} | ${String(entry.abilities.length)} | ${String(entry.permissions.length)} | ${String(entry.pages.length)} |`
          ),
          '',
          ...info.modules.map(
            (entry) =>
              `- 模块 \`${entry.name}\`：abilities ${entry.abilities.length === 0 ? '（无）' : entry.abilities.join(', ')}；pages ${entry.pages.length === 0 ? '（无）' : entry.pages.join(', ')}`
          ),
          '',
          `依赖：${info.dependencies.length === 0 ? '（无）' : info.dependencies.slice(0, 20).join(' · ')}`,
          `磁盘产物：${info.artifacts.length === 0 ? '（未构建）' : info.artifacts.map((item) => `\`${item.path}\`（${String(item.bytes)} B）`).join(' · ')}`
        ].join('\n');
        return ok(`project：${info.bundleName ?? root} · ${String(info.modules.length)} 个模块`, {
          detail,
          files: [safeDisplay(paths, `${dir}/project.json`), safeDisplay(paths, `${dir}/result.json`)],
          next: '把 project.json 里的 bundleName/SDK/产物写进审计证据；它只是工程事实，不是验收结论。'
        });
      }

      // Read-only SDK API lookup (`api`): never downloads, never executes.
      if (action === 'api') {
        const apiOp = opArg ?? 'lookup';
        if (apiOp !== 'lookup' && apiOp !== 'versions' && apiOp !== 'list' && apiOp !== 'scan') {
          return fail(`api 的 op 只能是 lookup / versions / list / scan（收到 ${apiOp}）。`);
        }
        const layout = findSdkLayout(options.harmonySdkPath);
        if (layout === null) {
          return fail('找不到 HarmonyOS SDK：设置 harmonySdkPath，或确保 DEVECO_SDK_HOME / DevEco Studio 的 sdk 目录存在。', {
            next: '装 DevEco Studio / Command Line Tools；或在 cordis.patch.yml 里设置 harmonySdkPath。'
          });
        }
        const now = nowIso();
        if (apiOp === 'versions') {
          const detail = [
            `SDK：\`${layout.root}\``,
            `apiVersion：${layout.apiVersion ?? '?'}`,
            `platformVersion：${layout.platformVersion ?? '?'}`,
            `sdkVersion：${layout.sdkVersion ?? '?'}`
          ].join('\n');
          const { dir } = await writeDevecoRecord(paths, 'api', `local sdk ${layout.root}`, now, {
            code: 0,
            stdout: detail,
            stderr: '',
            durationMs: 0
          });
          return ok(`SDK apiVersion ${layout.apiVersion ?? '?'}`, {
            detail,
            files: [safeDisplay(paths, `${dir}/result.json`)]
          });
        }
        if (apiOp === 'list') {
          const modules = listSdkModules(layout, 'openharmony');
          const kits = listSdkModules(layout, 'kit');
          const hmsModules = listSdkModules(layout, 'hms');
          const detail = [
            `SDK：\`${layout.root}\`（api ${layout.apiVersion ?? '?'}）`,
            `OpenHarmony API：${String(modules.length)} 个`,
            `OpenHarmony Kit：${String(kits.length)} 个`,
            `HMS API：${String(hmsModules.length)} 个`,
            '',
            '前 40 个 API 模块：',
            '```text',
            modules.slice(0, 40).join('\n'),
            '```'
          ].join('\n');
          const { dir } = await writeDevecoRecord(paths, 'api', `local sdk list ${layout.root}`, now, {
            code: 0,
            stdout: JSON.stringify({ modules, kits, hmsModules }),
            stderr: '',
            durationMs: 0
          });
          await writeTextAtomic(
            `${dir}/sdk-modules.json`,
            `${JSON.stringify({ modules, kits, hmsModules }, null, 2)}\n`
          );
          return ok(`SDK 模块：${String(modules.length)} API / ${String(kits.length)} Kit`, {
            detail,
            files: [safeDisplay(paths, `${dir}/sdk-modules.json`)],
            next: '用 action=api op=lookup module=@ohos.xxx 查具体声明与 @since/@deprecated。'
          });
        }
        if (apiOp === 'scan') {
          const requested = projectPath ?? '.';
          const start = resolveInside(paths.workspace, requested);
          if (start === null) return fail('api scan 的 path 必须在工作区内。');
          if (!existsSync(start)) return fail(`目录不存在：${requested}`);
          const root = findProjectRoot(start);
          if (root === null) {
            return fail('api scan 找不到工程根（build-profile.json5），请把 path 指向 DevEco 工程目录。');
          }
          const scan = scanDeprecatedApi(root, layout);
          const nowScan = nowIso();
          const { dir } = await writeDevecoRecord(paths, 'api', `local sdk scan ${safeDisplay(paths, root)}`, nowScan, {
            code: 0,
            stdout: JSON.stringify(scan),
            stderr: '',
            durationMs: 0
          });
          await writeTextAtomic(`${dir}/api-scan.json`, `${JSON.stringify(scan, null, 2)}\n`);
          const top = scan.findings.slice(0, 20);
          const detail = [
            `工程：\`${safeDisplay(paths, root)}\``,
            `扫描文件：${String(scan.filesScanned)} · 导入 SDK 模块：${String(scan.imports.length)} · 废弃符号：${String(scan.deprecatedSymbols)}`,
            `命中：${String(scan.findings.length)} 处`,
            ...(scan.imports.length === 0 ? [] : ['', `导入模块：${scan.imports.slice(0, 12).join(', ')}${scan.imports.length > 12 ? ' …' : ''}`]),
            ...(top.length === 0
              ? ['', '未发现对 @deprecated API 的引用。']
              : [
                  '',
                  '| 文件:行 | 符号 | 模块 | 废弃说明 |',
                  '| --- | --- | --- | --- |',
                  ...top.map(
                    (finding) =>
                      `| \`${finding.file}:${String(finding.line)}\` | \`${finding.symbol}\` | \`${finding.module}\` | ${finding.deprecated.replace(/\|/g, '\\|')} |`
                  )
                ]),
            ...(scan.findings.length > top.length ? ['', `仅显示前 ${String(top.length)} 条，完整结果见 api-scan.json。`] : [])
          ].join('\n');
          const scanSummary =
            scan.findings.length === 0
              ? 'api scan：未发现废弃 API 引用'
              : `api scan：${String(scan.findings.length)} 处废弃 API 引用（${String(new Set(scan.findings.map((finding) => finding.file)).size)} 个文件）`;
          return ok(scanSummary, {
            detail,
            files: [safeDisplay(paths, `${dir}/api-scan.json`), safeDisplay(paths, `${dir}/result.json`)],
            next:
              scan.findings.length === 0
                ? '把 api-scan.json 作为兼容性判据的证据；零命中也要保留扫描范围。'
                : '把 api-scan.json 写进兼容性判据的 evidenceFiles；是否阻断由任务包的兼容性判据决定。'
          });
        }
        if (module === undefined) return fail('api lookup 需要 module（如 @ohos.promptAction 或 @kit.ArkUI）。');
        const lookup = lookupSdkApi(layout, module, apiName);
        if (lookup === null) {
          return fail(`SDK 里找不到模块：${module}`, {
            next: '先用 `dwguard_deveco` action=api op=list 看可用模块名。'
          });
        }
        const { dir } = await writeDevecoRecord(paths, 'api', `local sdk lookup ${lookup.module}`, now, {
          code: 0,
          stdout: JSON.stringify(lookup),
          stderr: '',
          durationMs: 0
        });
        await writeTextAtomic(`${dir}/api.json`, `${JSON.stringify(lookup, null, 2)}\n`);
        const tagLines = lookup.tags.map((tag) => `- \`${tag.tag}\`${tag.value.length === 0 ? '' : ` ${tag.value}`}（L${String(tag.line)}）`);
        const detail = [
          `模块：\`${lookup.module}\`（${lookup.kind}）`,
          `声明文件：\`${lookup.file}\``,
          '',
          '文档标签：',
          tagLines.length === 0 ? '（未找到 @since/@deprecated/@syscap 等标签）' : tagLines.join('\n'),
          '',
          '声明片段：',
          '```text',
          lookup.declarations.length === 0 ? '（没有匹配的声明行）' : lookup.declarations.join('\n'),
          '```'
        ].join('\n');
        return ok(`${lookup.module}：${String(lookup.tags.length)} 个标签 / ${String(lookup.declarations.length)} 条声明`, {
          detail,
          files: [safeDisplay(paths, `${dir}/api.json`)],
          next: '把 @since/@deprecated 作为“兼容性/废弃”判据的独立证据写进 checks；它不替代审计结论。'
        });
      }

      // Runtime accessibility check (`a11y op=runtime`): touch targets + contrast sampling.
      if (action === 'a11y' && (opArg ?? 'summary') === 'runtime') {
        const binary = resolveBinary(options.devecocliPath);
        const shotPath = `${paths.artifactsDir}/devshots/a11y-${Date.now()}.png`;
        await ensureDir(dirname(shotPath));
        let lockHolder: string | null = null;
        let lockToken: string | null = null;
        if (device !== undefined) {
          const lock = await acquireDeviceLock(paths, device, `${TOOL}:a11y-runtime:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: Math.max(policy.lockTimeoutMs, 60_000)
          });
          if (!lock.ok) return fail(lock.reason, { next: '等占用设备的取证结束再做运行时无障碍检查。' });
          lockHolder = device;
          lockToken = lock.token;
        }
        const now = nowIso();
        const baseArgs = device === undefined ? [] : ['--device', device];
        let shotResult: DevecoRun | null = null;
        let layoutResult: DevecoRun | null = null;
        try {
          shotResult = await runner(binary, ['ui', 'screenshot', '--path', shotPath, ...baseArgs], paths.workspace);
          layoutResult = await runner(binary, ['ui', 'layout', '--format', 'json', '--mode', 'full', ...baseArgs], paths.workspace);
        } catch (caught) {
          return fail(`a11y runtime 执行失败：${caught instanceof Error ? caught.message : String(caught)}`, {
            next: '确认 devecocli 可用、设备在线。'
          });
        } finally {
          if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
        }
        if (shotResult === null || shotResult.code !== 0) {
          return fail('a11y runtime 截图失败。', { detail: tail(shotResult?.stdout ?? '', 10) });
        }
        if (layoutResult === null || layoutResult.code !== 0) {
          return fail('a11y runtime 布局树获取失败。', { detail: tail(layoutResult?.stdout ?? '', 10) });
        }
        const layout = jsonValue(layoutResult.stdout);
        if (layout === null) return fail('a11y runtime 无法解析布局树 JSON。');
        let report;
        try {
          report = analyzeA11yRuntime(layout, await readFile(shotPath), {
            minTouchSize: minTouch,
            minContrast,
            maxItems: 50
          });
        } catch (caught) {
          return fail(`a11y runtime 分析失败：${caught instanceof Error ? caught.message : String(caught)}`, {
            next: '确认截图是有效 PNG、布局树是 ui layout --format json 的输出。'
          });
        }
        const { dir } = await writeDevecoRecord(paths, 'a11y', 'ui layout + screenshot (runtime)', now, {
          code: 0,
          stdout: layoutResult.stdout,
          stderr: '',
          durationMs: layoutResult.durationMs
        });
        await writeTextAtomic(
          `${dir}/a11y-runtime.json`,
          `${JSON.stringify({ schemaVersion: 1, capturedAt: now, ...(device === undefined ? {} : { device }), minTouch, minContrast, ...report }, null, 2)}\n`
        );
        const detail = [
          `节点：${String(report.nodes)} · 可点击：${String(report.clickable)} · 文本节点：${String(report.textNodes)}`,
          `触控目标过小：${String(report.touchTargetViolations)} · 对比度风险：${String(report.contrastViolations)}`,
          ...(report.touchTargets.length === 0
            ? []
            : [
                '',
                '| 触控目标 | 尺寸 | 阈值 |',
                '| --- | --- | --- |',
                ...report.touchTargets.slice(0, 10).map(
                  (finding) => `| ${finding.node.replace(/\|/g, '\\|')} | ${String(finding.measured)} | ${String(finding.threshold)} |`
                )
              ]),
          ...(report.contrasts.length === 0
            ? []
            : [
                '',
                '| 对比度风险 | 估算 | 阈值 |',
                '| --- | --- | --- |',
                ...report.contrasts.slice(0, 10).map(
                  (finding) => `| ${finding.node.replace(/\|/g, '\\|')} | ${String(finding.measured)}:1 | ${String(finding.threshold)}:1 |`
                )
              ]),
          '',
          '注意：对比度为文本区域亮度范围估算；触控尺寸单位与布局树一致。是否阻断由审美/无障碍判据决定。'
        ].join('\n');
        const files = [
          safeDisplay(paths, `${dir}/a11y-runtime.json`),
          safeDisplay(paths, shotPath),
          safeDisplay(paths, `${dir}/result.json`)
        ];
        return ok(
          `a11y runtime：节点 ${String(report.nodes)} · 触控风险 ${String(report.touchTargetViolations)} · 对比度风险 ${String(report.contrastViolations)}`,
          {
            detail,
            files,
            next: '把 a11y-runtime.json 写进无障碍判据的 evidenceFiles；风险项需人工确认后决定是否阻断。'
          }
        );
      }

      // Deterministic UI assertion (`uiassert`): evidence, not a vision model guess.
      if (action === 'uiassert') {
        if (expect !== 'fingerprint' && selector === undefined) {
          return fail('uiassert 需要 selector（如 text=登录 / id=submit / text*=Log）；指纹断言用 expect=fingerprint。');
        }
        if (expect === 'count' && expectCount < 0) return fail('expect=count 需要 count（期望匹配数）。');
        if (expect === 'fingerprint' && fingerprintArg !== undefined && !/^fp-[0-9a-f]{8,}$/i.test(fingerprintArg)) {
          return fail('fingerprint 必须是 fp- 开头的布局指纹（先用 expect=fingerprint 不传 fingerprint 采集）。');
        }
        const binary = resolveBinary(options.devecocliPath);
        const multi = device === 'all';
        if (multi && policy.pool.length === 0) {
          return fail('device=all 需要配置设备池 `device.pool`，否则没有可逐台执行的设备。', {
            next: '在 cordis.patch.yml 的 device.pool 里填设备序列号，或传具体 device。'
          });
        }
        const targets = multi
          ? policy.pool.map((entry) => ({ sn: entry.sn, family: entry.family }))
          : [{ sn: device, family: undefined as string | undefined }];
        interface UiRunResult {
          readonly device?: string;
          readonly family?: string;
          readonly command: string[];
          readonly exitCode: number;
          readonly stdout: string;
          readonly stderr: string;
          readonly durationMs: number;
          readonly matches: number | null;
          readonly fingerprint?: string;
          readonly nodes?: number;
          readonly passed: boolean;
          readonly actual: string;
          readonly error?: string;
        }
        const runOne = async (target: { sn?: string; family?: string }): Promise<UiRunResult> => {
          const sn = target.sn;
          const commandArgs: string[] = [];
          if (expect === 'fingerprint') {
            commandArgs.push('ui', 'layout', '--format', 'json', '--mode', 'full');
            if (windowId !== undefined) commandArgs.push('--window', windowId);
          } else if (expect === 'absent') {
            commandArgs.push('ui', 'wait', selector ?? '', String(timeoutMs), '--disappear');
            if (windowId !== undefined) commandArgs.push('--window', windowId);
          } else {
            commandArgs.push('ui', 'find', selector ?? '', '--format', 'json', '--timeout', String(timeoutMs));
            if (expect === 'count') commandArgs.push('--all');
            if (windowId !== undefined) commandArgs.push('--window', windowId);
          }
          if (sn !== undefined) commandArgs.push('--device', sn);
          let lockHolder: string | null = null;
          let lockToken: string | null = null;
          if (sn !== undefined) {
            const lock = await acquireDeviceLock(paths, sn, `${TOOL}:uiassert:${Date.now()}`, policy.lockTimeoutMs, {
              staleAfterMs: policy.lockTimeoutMs,
              leaseTtlMs: Math.max(policy.lockTimeoutMs, 120_000)
            });
            if (!lock.ok) {
              return {
                device: sn,
                ...(target.family === undefined ? {} : { family: target.family }),
                command: commandArgs,
                exitCode: 1,
                stdout: '',
                stderr: lock.reason,
                durationMs: 0,
                matches: null,
                passed: false,
                actual: `设备锁失败：${lock.reason}`,
                error: lock.reason
              };
            }
            lockHolder = sn;
            lockToken = lock.token;
          }
          let result: DevecoRun | null = null;
          let error: string | undefined;
          try {
            result = await runner(binary, commandArgs, paths.workspace);
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
          } finally {
            if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
          }
          const parsed = jsonValue(result?.stdout ?? '');
          let matches: number | null = null;
          let fingerprint: string | undefined;
          let nodes: number | undefined;
          if (expect === 'fingerprint') {
            if (parsed !== null) {
              const computed = fingerprintLayout(parsed);
              fingerprint = computed.fingerprint;
              nodes = computed.nodes;
            }
          } else {
            matches = countMatches(parsed);
          }
          let passed = false;
          let actual = '';
          if (error !== undefined) {
            actual = `执行失败：${error}`;
          } else if (expect === 'fingerprint') {
            if (fingerprint === undefined) {
              actual = '无法从 ui layout 输出解析布局 JSON';
            } else if (fingerprintArg === undefined) {
              passed = true;
              actual = `采集 ${fingerprint}（${String(nodes ?? 0)} 节点）`;
            } else {
              passed = fingerprint === fingerprintArg;
              actual = `${fingerprint}（期望 ${fingerprintArg}）`;
            }
          } else if (expect === 'present') {
            passed = result !== null && result.code === 0 && (matches === null || matches > 0);
            actual = `exit ${String(result?.code ?? 1)} · matches ${matches === null ? '（未解析）' : String(matches)}`;
          } else if (expect === 'absent') {
            passed = result !== null && result.code === 0;
            actual = `exit ${String(result?.code ?? 1)}（0 = 已消失）`;
          } else {
            passed = matches === expectCount;
            actual = `matches ${matches === null ? '（未解析）' : String(matches)}（期望 ${String(expectCount)}）`;
          }
          return {
            ...(sn === undefined ? {} : { device: sn }),
            ...(target.family === undefined ? {} : { family: target.family }),
            command: commandArgs,
            exitCode: result?.code ?? 1,
            stdout: result?.stdout ?? '',
            stderr: result?.stderr ?? '',
            durationMs: result?.durationMs ?? 0,
            matches,
            ...(fingerprint === undefined ? {} : { fingerprint }),
            ...(nodes === undefined ? {} : { nodes }),
            passed,
            actual,
            ...(error === undefined ? {} : { error })
          };
        };

        const results: UiRunResult[] = [];
        for (const target of targets) {
          try {
            results.push(await runOne(target));
          } catch (caught) {
            results.push({
              ...(target.sn === undefined ? {} : { device: target.sn }),
              ...(target.family === undefined ? {} : { family: target.family }),
              command: [],
              exitCode: 1,
              stdout: '',
              stderr: '',
              durationMs: 0,
              matches: null,
              passed: false,
              actual: `执行失败：${caught instanceof Error ? caught.message : String(caught)}`
            });
          }
        }
        const passedCount = results.filter((result) => result.passed).length;
        const allPassed = results.length > 0 && passedCount === results.length;
        const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
        const aggregateStdout = results
          .map((result) => `[${result.device ?? 'default'}] exit=${String(result.exitCode)}\n${result.stdout}`)
          .join('\n---\n');
        const now = nowIso();
        const { dir } = await writeDevecoRecord(
          paths,
          'uiassert',
          results.map((result) => result.command.join(' ')).join(' | '),
          now,
          {
            code: allPassed ? 0 : 1,
            stdout: aggregateStdout,
            stderr: results.map((result) => result.stderr).filter((line) => line.length > 0).join('\n'),
            durationMs: totalMs
          },
          {
            mode: multi ? 'all' : 'single',
            expect,
            ...(expect === 'count' ? { expectedCount: expectCount } : {}),
            ...(fingerprintArg === undefined ? {} : { expectedFingerprint: fingerprintArg }),
            passed: allPassed
          }
        );

        let specVersion: number | undefined;
        const specRaw = await readTextOrNull(paths.specJson);
        if (specRaw !== null) {
          try {
            const parsedSpec = JSON.parse(specRaw) as { specVersion?: unknown };
            if (typeof parsedSpec.specVersion === 'number') specVersion = Math.trunc(parsedSpec.specVersion);
          } catch {
            /* no spec version */
          }
        }

        const fileSafe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '_');
        const observationRefs: Array<{ device?: string; ref: string }> = [];
        const matrixFiles: string[] = [];
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          if (result === undefined) continue;
          const record = {
            schemaVersion: 1,
            capturedAt: now,
            mode: multi ? 'all' : 'single',
            selector: selector ?? null,
            expect,
            ...(expect === 'count' ? { expectedCount: expectCount } : {}),
            ...(fingerprintArg === undefined ? {} : { expectedFingerprint: fingerprintArg }),
            ...(result.device === undefined ? {} : { device: result.device }),
            ...(result.family === undefined ? {} : { family: result.family }),
            actualMatches: result.matches,
            ...(result.fingerprint === undefined ? {} : { fingerprint: result.fingerprint }),
            ...(result.nodes === undefined ? {} : { nodes: result.nodes }),
            passed: result.passed,
            exitCode: result.exitCode,
            actual: result.actual,
            command: result.command
          };
          const fileName = multi ? `uiassert-${String(index)}-${fileSafe(result.device ?? 'default')}.json` : 'uiassert.json';
          await writeTextAtomic(`${dir}/${fileName}`, `${JSON.stringify(record, null, 2)}\n`);
          matrixFiles.push(safeDisplay(paths, `${dir}/${fileName}`));
          if (multi) {
            await writeTextAtomic(`${dir}/output-${String(index)}.log`, `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`);
          }
          if (result.passed && result.device !== undefined) {
            const observationFiles = multi
              ? [`${dir}/${fileName}`, `${dir}/output-${String(index)}.log`]
              : [`${dir}/uiassert.json`, `${dir}/output.log`];
            const ref = await recordObservation(
              paths,
              {
                action: 'uiassert',
                device: result.device,
                ...(specVersion === undefined ? {} : { specVersion }),
                files: observationFiles
              },
              now
            );
            observationRefs.push({ device: result.device, ref });
          }
        }
        if (multi) {
          await writeTextAtomic(
            `${dir}/uiassert-matrix.json`,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                capturedAt: now,
                expect,
                ...(expect === 'count' ? { expectedCount: expectCount } : {}),
                ...(fingerprintArg === undefined ? {} : { expectedFingerprint: fingerprintArg }),
                passed: allPassed,
                passedCount,
                total: results.length,
                results: results.map((result) => ({
                  ...(result.device === undefined ? {} : { device: result.device }),
                  ...(result.family === undefined ? {} : { family: result.family }),
                  passed: result.passed,
                  actual: result.actual,
                  ...(result.matches === null ? {} : { matches: result.matches }),
                  ...(result.fingerprint === undefined ? {} : { fingerprint: result.fingerprint })
                }))
              },
              null,
              2
            )}\n`
          );
          matrixFiles.push(safeDisplay(paths, `${dir}/uiassert-matrix.json`));
        }

        const detailLines = [
          ...(selector === undefined ? [] : [`选择器：\`${selector}\``]),
          `期望：${expect}${expect === 'count' ? ` = ${String(expectCount)}` : ''}${
            fingerprintArg === undefined ? '' : `（fingerprint ${fingerprintArg}）`
          }`,
          ...(multi
            ? [
                '| 设备 | 结果 | 实际 |',
                '| --- | --- | --- |',
                ...results.map(
                  (result) => `| ${result.device ?? 'default'} | ${result.passed ? 'pass' : 'fail'} | ${result.actual.replace(/\|/g, '\\|')} |`
                )
              ]
            : []),
          ...(multi ? [] : [`实际：${results[0]?.actual ?? '（无结果）'}`]),
          `命令：\`${results.map((result) => result.command.join(' ')).join(' | ')}\``,
          `记录：\`${displayPath(paths, dir)}/\``,
          ...observationRefs.map(
            (entry) => `observationRef${entry.device === undefined ? '' : `（${entry.device}）`}：\`${entry.ref}\`（可作为 audit 的结构化证据）`
          )
        ];
        const files = [
          ...matrixFiles,
          safeDisplay(paths, `${dir}/result.json`),
          safeDisplay(paths, `${dir}/output.log`)
        ];
        const summary = multi
          ? `uiassert all：${String(passedCount)}/${String(results.length)} 台通过`
          : expect === 'fingerprint' && fingerprintArg === undefined
            ? `uiassert 指纹：${results[0]?.fingerprint ?? '（未解析）'}`
            : `uiassert ${allPassed ? '通过' : '未通过'}：${selector ?? 'fingerprint'} ${expect}`;
        return allPassed
          ? ok(summary, {
              detail: detailLines.join('\n'),
              files,
              next:
                expect === 'fingerprint' && fingerprintArg === undefined
                  ? '把采集到的 fingerprint 写进判据；下次用 expect=fingerprint + fingerprint 复核。'
                  : '把 uiassert.json 写进审计 checks 的 evidenceFiles；断言通过不等于验收通过。'
            })
          : fail(summary, {
              detail: detailLines.join('\n'),
              files,
              next: '看 output.log 定位是元素不存在、超时、数量不符还是指纹变化；不要放宽判据来让它通过。'
            });
      }

      // Performance sampling (`perf`): startup / memory / fps with N samples.
      if (action === 'perf') {
        const perfOp = opArg ?? 'startup';
        if (perfOp !== 'startup' && perfOp !== 'memory' && perfOp !== 'frame') {
          return fail(`perf 的 op 只能是 startup / memory / frame（收到 ${perfOp}）。`);
        }
        const hdc = options.hdcPath.trim().length > 0 ? options.hdcPath.trim() : 'hdc';
        let lockHolder: string | null = null;
        let lockToken: string | null = null;
        if (device !== undefined) {
          const lock = await acquireDeviceLock(paths, device, `${TOOL}:perf:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: Math.max(policy.lockTimeoutMs, 5 * 60_000)
          });
          if (!lock.ok) return fail(lock.reason, { next: '等占用设备的取证结束再测性能。' });
          lockHolder = device;
          lockToken = lock.token;
        }
        const hdcArgs = (args: string[]): string[] => [...(device === undefined ? [] : ['-t', device]), 'shell', ...args];
        const samples: number[] = [];
        let unit = 'ms';
        let rawOutput = '';
        let failure: string | undefined;
        try {
          if (perfOp === 'startup') {
            if (bundleArg === undefined || abilityArg === undefined) {
              return fail('perf startup 需要 bundle 与 ability（如 com.demo.app / EntryAbility）。');
            }
            for (let index = 0; index < warmupArg; index += 1) {
              await runner(hdc, hdcArgs(['aa', 'start', '-b', bundleArg, '-a', abilityArg]), paths.workspace);
              await delay(400);
            }
            for (let index = 0; index < samplesArg; index += 1) {
              const started = Date.now();
              const run = await runner(hdc, hdcArgs(['aa', 'start', '-b', bundleArg, '-a', abilityArg]), paths.workspace);
              const elapsed = Date.now() - started;
              rawOutput += run.stdout;
              if (run.code !== 0) {
                failure = `aa start 失败（exit ${String(run.code)}）：${tail(run.stderr || run.stdout, 4)}`;
                break;
              }
              samples.push(elapsed);
              await delay(400);
            }
          } else if (perfOp === 'memory') {
            if (bundleArg === undefined) return fail('perf memory 需要 bundle。');
            const pidRun = await runner(hdc, hdcArgs(['pidof', bundleArg]), paths.workspace);
            const pid = /^\s*(\d+)/m.exec(pidRun.stdout)?.[1];
            if (pid === undefined) return fail(`perf memory 找不到进程：${bundleArg}`, { detail: tail(pidRun.stdout, 5) });
            const run = await runner(hdc, hdcArgs(['hidumper', '--mem', pid]), paths.workspace);
            rawOutput = run.stdout;
            const parsed = parseHidumperMem(run.stdout);
            if (parsed.pssKb === undefined) {
              failure = 'hidumper --mem 输出里没有解析到 Pss（kB）';
            } else {
              samples.push(parsed.pssKb);
              unit = 'KB';
            }
          } else {
            const run = await runner(hdc, hdcArgs(['hidumper', '-s', 'RenderService', '-a', 'fpsCount']), paths.workspace);
            rawOutput = run.stdout;
            const parsed = parseFpsOutput(run.stdout);
            const value = parsed.fps ?? parsed.refreshRate;
            if (value === undefined) {
              failure = 'hidumper RenderService fpsCount 输出里没有解析到 fps/Refresh Rate';
            } else {
              samples.push(value);
              unit = parsed.fps === undefined ? 'Hz' : 'fps';
            }
          }
        } catch (caught) {
          failure = caught instanceof Error ? caught.message : String(caught);
        } finally {
          if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
        }
        if (failure !== undefined) {
          return fail(`perf ${perfOp} 失败：${failure}`, {
            detail: tail(rawOutput, 20),
            next: '确认设备在线、bundle/ability 正确；frame 依赖 RenderService 的 hidumper 输出。'
          });
        }
        const summary = summarizeSamples(samples, unit);
        const now = nowIso();
        const { dir } = await writeDevecoRecord(
          paths,
          'perf',
          `perf ${perfOp} ${bundleArg ?? ''}`.trim(),
          now,
          { code: 0, stdout: rawOutput, stderr: '', durationMs: 0 },
          { op: perfOp, samples: summary.samples, unit }
        );
        await writeTextAtomic(
          `${dir}/perf.json`,
          `${JSON.stringify({ schemaVersion: 1, capturedAt: now, op: perfOp, ...(device === undefined ? {} : { device }), ...(bundleArg === undefined ? {} : { bundle: bundleArg }), ...(abilityArg === undefined ? {} : { ability: abilityArg }), ...summary }, null, 2)}\n`
        );
        const detail = [
          `op：${perfOp} · 样本：${String(summary.count)} · 单位：${unit}`,
          `均值 ${String(summary.mean)} · 最小 ${String(summary.min)} · 最大 ${String(summary.max)} · p95 ${String(summary.p95)}`,
          '',
          '| # | 样本 |',
          '| --- | --- |',
          ...summary.samples.map((value, index) => `| ${String(index + 1)} | ${String(value)} |`),
          '',
          '注意：startup 为主机侧调用时长（含 hdc 开销），frame 依赖 RenderService 输出；判据阈值由任务包设定。'
        ].join('\n');
        return ok(`perf ${perfOp}：p95 ${String(summary.p95)}${unit}（${String(summary.count)} 样本）`, {
          detail,
          files: [safeDisplay(paths, `${dir}/perf.json`)],
          next: '把 perf.json 的 samples/p95 写进性能判据的 actual（assertion 支持 samples + aggregation）。'
        });
      }

      // Scenario replay (`scenario`): ordered UI steps with per-step evidence.
      if (action === 'scenario') {
        if (scenarioArg === undefined) return fail('scenario 需要 scenario（步骤 JSON 或工作区内 JSON 文件路径）。');
        let text = scenarioArg.trim();
        if (!text.startsWith('[') && !text.startsWith('{')) {
          const file = resolveInside(paths.workspace, text);
          if (file === null) return fail('scenario 文件必须在工作区内。');
          const raw = await readTextOrNull(file);
          if (raw === null) return fail(`scenario 文件不存在：${text}`);
          text = raw;
        }
        let steps: ScenarioStep[];
        try {
          steps = parseScenario(text);
        } catch (error) {
          return fail(`scenario 解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const binary = resolveBinary(options.devecocliPath);
        const { dir } = await prepareActionDir(paths);
        const now = nowIso();
        let lockHolder: string | null = null;
        let lockToken: string | null = null;
        if (device !== undefined) {
          const lock = await acquireDeviceLock(paths, device, `${TOOL}:scenario:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: Math.max(policy.lockTimeoutMs, 10 * 60_000)
          });
          if (!lock.ok) return fail(lock.reason, { next: '等占用设备的取证结束再跑 scenario。' });
          lockHolder = device;
          lockToken = lock.token;
        }
        const baseArgs = device === undefined ? [] : ['--device', device];
        const rows: Array<Record<string, unknown>> = [];
        let passedCount = 0;
        let stability: StabilityResult | undefined;
        let allPassed = true;
        try {
          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index];
            if (step === undefined) continue;
            const started = Date.now();
            let command: string[] = [];
            let code = 0;
            let stdout = '';
            let stderr = '';
            let passed = true;
            let detail = '';
            try {
              if (step.op === 'sleep') {
                await delay(step.ms);
                detail = `sleep ${String(step.ms)}ms`;
              } else if (step.op === 'screenshot') {
                const name = `step-${String(index)}-${step.name ?? 'shot'}.png`;
                command = ['ui', 'screenshot', '--path', `${dir}/${name}`, ...baseArgs];
                const run = await runner(binary, command, paths.workspace);
                code = run.code;
                stdout = run.stdout;
                stderr = run.stderr;
                passed = run.code === 0;
                detail = `${dir}/${name}`;
              } else if (step.op === 'assert') {
                command = [
                  'ui',
                  'find',
                  step.selector,
                  '--format',
                  'json',
                  '--timeout',
                  String(step.timeoutMs ?? 3000),
                  ...(step.expect === 'count' ? ['--all'] : []),
                  ...baseArgs
                ];
                const run = await runner(binary, command, paths.workspace);
                code = run.code;
                stdout = run.stdout;
                stderr = run.stderr;
                const parsed = jsonValue(run.stdout);
                const matches = countMatches(parsed);
                if (step.expect === 'absent') passed = run.code === 0;
                else if (step.expect === 'count') passed = matches === step.count;
                else passed = run.code === 0 && (matches === null || matches > 0);
                detail = `exit=${String(run.code)} matches=${matches === null ? '?' : String(matches)}`;
              } else {
                if (step.op === 'click') {
                  command = step.id !== undefined ? ['ui', 'click', '--id', step.id, ...baseArgs] : ['ui', 'click', String(step.x), String(step.y), ...baseArgs];
                } else if (step.op === 'text') {
                  command = [
                    'ui',
                    'text',
                    step.text,
                    ...(step.id === undefined ? [] : ['--id', step.id]),
                    ...(step.x === undefined || step.y === undefined ? [] : [String(step.x), String(step.y)]),
                    ...baseArgs
                  ];
                } else {
                  command = [
                    'ui',
                    'swipe',
                    String(step.x1),
                    String(step.y1),
                    String(step.x2),
                    String(step.y2),
                    ...(step.speed === undefined ? [] : ['--speed', String(step.speed)]),
                    ...baseArgs
                  ];
                }
                const run = await runner(binary, command, paths.workspace);
                code = run.code;
                stdout = run.stdout;
                stderr = run.stderr;
                passed = run.code === 0;
                detail = `exit=${String(run.code)}`;
              }
            } catch (caught) {
              passed = false;
              detail = `执行失败：${caught instanceof Error ? caught.message : String(caught)}`;
            }
            const row = {
              index,
              op: step.op,
              command: command.join(' '),
              exitCode: code,
              passed,
              detail,
              durationMs: Date.now() - started,
              stdout: tail(stdout, 20),
              stderr: tail(stderr, 10)
            };
            rows.push(row);
            await writeTextAtomic(`${dir}/step-${String(index)}.json`, `${JSON.stringify(row, null, 2)}\n`);
            if (passed) passedCount += 1;
            else {
              allPassed = false;
              if (!continueOnFailure) break;
            }
          }
          if (stabilityFlag) {
            stability = await collectStability(runner, binary, device, tailArg, paths.workspace);
            await writeTextAtomic(
              `${dir}/stability.json`,
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  capturedAt: now,
                  ...(device === undefined ? {} : { device }),
                  crashes: stability.crashes,
                  freezes: stability.freezes,
                  errorCount: stability.errors,
                  passed: stability.passed,
                  crashTail: stability.crashTail,
                  hilogTail: stability.hilogTail
                },
                null,
                2
              )}\n`
            );
            if (!stability.passed) allPassed = false;
          }
        } finally {
          if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
        }
        const totalMs = rows.reduce((sum, row) => sum + (typeof row['durationMs'] === 'number' ? row['durationMs'] : 0), 0);
        await writeActionRecord(dir, 'scenario', `scenario ${String(steps.length)} steps`, now, {
          code: allPassed ? 0 : 1,
          stdout: rows.map((row) => `[${String(row['index'])}] ${String(row['op'])} exit=${String(row['exitCode'])}`).join('\n'),
          stderr: '',
          durationMs: totalMs
        });
        await writeTextAtomic(
          `${dir}/scenario-run.json`,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              capturedAt: now,
              ...(device === undefined ? {} : { device }),
              total: steps.length,
              passedCount,
              passed: allPassed,
              steps: rows,
              ...(stability === undefined ? {} : { stability: { passed: stability.passed, crashes: stability.crashes.length, freezes: stability.freezes.length, errorCount: stability.errors } })
            },
            null,
            2
          )}\n`
        );
        let specVersion: number | undefined;
        const specRaw = await readTextOrNull(paths.specJson);
        if (specRaw !== null) {
          try {
            const parsedSpec = JSON.parse(specRaw) as { specVersion?: unknown };
            if (typeof parsedSpec.specVersion === 'number') specVersion = Math.trunc(parsedSpec.specVersion);
          } catch {
            /* no spec version */
          }
        }
        let observationRef: string | undefined;
        if (allPassed && device !== undefined) {
          observationRef = await recordObservation(
            paths,
            {
              action: 'scenario',
              device,
              ...(specVersion === undefined ? {} : { specVersion }),
              files: [`${dir}/scenario-run.json`, ...(stability === undefined ? [] : [`${dir}/stability.json`])]
            },
            now
          );
        }
        const detail = [
          `步骤：${String(steps.length)} · 通过：${String(passedCount)} · ${allPassed ? '整体通过' : '存在失败步骤'}`,
          ...(stability === undefined
            ? []
            : [`稳定性：${stability.passed ? '未发现崩溃' : `发现 ${String(stability.crashes.length)} 条崩溃`} · hilog 错误 ${String(stability.errors)} 条`]),
          '',
          '| # | 步骤 | 结果 | 说明 |',
          '| --- | --- | --- | --- |',
          ...rows.map(
            (row) =>
              `| ${String(row['index'])} | ${String(row['op'])} | ${row['passed'] === true ? 'pass' : 'fail'} | ${String(row['detail']).replace(/\|/g, '\\|')} |`
          ),
          ...(observationRef === undefined ? [] : ['', `observationRef：\`${observationRef}\``])
        ].join('\n');
        const files = [
          safeDisplay(paths, `${dir}/scenario-run.json`),
          ...(stability === undefined ? [] : [safeDisplay(paths, `${dir}/stability.json`)]),
          safeDisplay(paths, `${dir}/result.json`)
        ];
        return allPassed
          ? ok(`scenario：${String(passedCount)}/${String(steps.length)} 步通过`, {
              detail,
              files,
              next: '把 scenario-run.json 作为功能/稳定性判据的证据；单步失败先看 step-<i>.json。'
            })
          : fail(`scenario：${String(passedCount)}/${String(steps.length)} 步通过`, {
              detail,
              files,
              next: '看失败步骤的 step-<i>.json 与 output.log；不要跳过后重跑掩盖失败。'
            });
      }

      // Direct stability check (`stability`): crash + hilog window.
      if (action === 'stability') {
        const binary = resolveBinary(options.devecocliPath);
        let lockHolder: string | null = null;
        let lockToken: string | null = null;
        if (device !== undefined) {
          const lock = await acquireDeviceLock(paths, device, `${TOOL}:stability:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: Math.max(policy.lockTimeoutMs, 5 * 60_000)
          });
          if (!lock.ok) return fail(lock.reason, { next: '等占用设备的取证结束再做稳定性检查。' });
          lockHolder = device;
          lockToken = lock.token;
        }
        const now = nowIso();
        let stability: StabilityResult;
        try {
          stability = await collectStability(runner, binary, device, tailArg, paths.workspace);
        } catch (caught) {
          return fail(`stability 执行失败：${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
          if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
        }
        const { dir } = await writeDevecoRecord(paths, 'stability', 'log --crash + log --tail', now, {
          code: stability.passed ? 0 : 1,
          stdout: stability.crashTail,
          stderr: stability.hilogTail,
          durationMs: 0
        });
        await writeTextAtomic(
          `${dir}/stability.json`,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              capturedAt: now,
              ...(device === undefined ? {} : { device }),
              crashes: stability.crashes,
              freezes: stability.freezes,
              errorCount: stability.errors,
              passed: stability.passed,
              crashTail: stability.crashTail,
              hilogTail: stability.hilogTail
            },
            null,
            2
          )}\n`
        );
        const detail = [
          `崩溃：${String(stability.crashes.length)} · 冻屏：${String(stability.freezes.length)} · hilog 错误：${String(stability.errors)}`,
          ...(stability.crashes.length === 0
            ? []
            : ['', '| 类型 | pid | 栈顶 |', '| --- | --- | --- |', ...stability.crashes.slice(0, 8).map((report) => `| ${report.type} | ${String(report.pid ?? '?')} | ${(report.topFrame ?? '（无栈）').replace(/\|/g, '\\|')} |`)]),
          '',
          '注意：这里只判断“窗口内是否出现 crash/freeze”；ANR 计数以 hilog 摘要为准，是否阻断由任务包判据决定。'
        ].join('\n');
        return stability.passed
          ? ok(`stability：未发现崩溃（hilog 错误 ${String(stability.errors)} 条）`, {
              detail,
              files: [safeDisplay(paths, `${dir}/stability.json`)],
              next: '把 stability.json 写进稳定性判据；错误数是否阻断由判据阈值决定。'
            })
          : fail(`stability：发现 ${String(stability.crashes.length)} 条崩溃 / ${String(stability.freezes.length)} 条冻屏`, {
              detail,
              files: [safeDisplay(paths, `${dir}/stability.json`)],
              next: '看 stability.json 的栈顶帧与 crashTail；修复后重跑同一场景。'
            });
      }

      // Performance trace capture via hdc (`trace`): raw capture + deterministic
      // slice statistics; never claims fps/jank.
      if (action === 'trace') {
        const hdc = options.hdcPath.trim().length > 0 ? options.hdcPath.trim() : 'hdc';
        const categoryList =
          categoriesArg === undefined ? ['ability', 'graphic', 'ace', 'app'] : splitTokens(categoriesArg);
        for (const token of categoryList) {
          if (!safeToken(token)) return fail(`trace 分类含不允许的字符：${token}`);
        }
        const multi = device === 'all';
        if (multi && policy.pool.length === 0) {
          return fail('trace device=all 需要配置设备池 `device.pool`。', {
            next: '在 cordis.patch.yml 的 device.pool 里填设备序列号，或传具体 device。'
          });
        }
        interface TraceRun {
          readonly device?: string;
          readonly hdcArgs: string[];
          readonly code: number;
          readonly stdout: string;
          readonly stderr: string;
          readonly durationMs: number;
          readonly error?: string;
        }
        const runOne = async (sn: string | undefined): Promise<TraceRun> => {
          const hdcArgs = [
            ...(sn === undefined ? [] : ['-t', sn]),
            'shell',
            'hitrace',
            '-t',
            String(durationArg),
            '-b',
            String(bufferKb),
            ...categoryList
          ];
          let lockHolder: string | null = null;
          let lockToken: string | null = null;
          if (sn !== undefined) {
            const lock = await acquireDeviceLock(paths, sn, `${TOOL}:trace:${Date.now()}`, policy.lockTimeoutMs, {
              staleAfterMs: policy.lockTimeoutMs,
              leaseTtlMs: Math.max(policy.lockTimeoutMs, 5 * 60_000)
            });
            if (!lock.ok) {
              return {
                device: sn,
                hdcArgs,
                code: 1,
                stdout: '',
                stderr: lock.reason,
                durationMs: 0,
                error: lock.reason
              };
            }
            lockHolder = sn;
            lockToken = lock.token;
          }
          try {
            const result = await runner(hdc, hdcArgs, paths.workspace);
            return {
              ...(sn === undefined ? {} : { device: sn }),
              hdcArgs,
              code: result.code,
              stdout: result.stdout,
              stderr: result.stderr,
              durationMs: result.durationMs
            };
          } catch (caught) {
            return {
              ...(sn === undefined ? {} : { device: sn }),
              hdcArgs,
              code: 1,
              stdout: '',
              stderr: '',
              durationMs: 0,
              error: caught instanceof Error ? caught.message : String(caught)
            };
          } finally {
            if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
          }
        };
        const targets: Array<string | undefined> = multi ? policy.pool.map((entry) => entry.sn) : [device];
        const runs: TraceRun[] = [];
        for (const target of targets) runs.push(await runOne(target));
        const totalMs = runs.reduce((sum, run) => sum + run.durationMs, 0);
        const aggregateStdout = runs
          .map((run) => `[${run.device ?? 'default'}] exit=${String(run.code)}\n${run.stdout}`)
          .join('\n---\n');
        const now = nowIso();
        const { dir } = await writeDevecoRecord(
          paths,
          'trace',
          runs.map((run) => `${hdc} ${run.hdcArgs.join(' ')}`).join(' | '),
          now,
          {
            code: runs.every((run) => run.code === 0) ? 0 : 1,
            stdout: aggregateStdout,
            stderr: runs.map((run) => run.stderr).filter((line) => line.length > 0).join('\n'),
            durationMs: totalMs
          },
          { mode: multi ? 'all' : 'single', durationSeconds: durationArg, bufferKb, categories: categoryList }
        );
        const fileSafe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '_');
        const availableCategories = new Set<string>();
        const observationRefs: Array<{ device?: string; ref: string }> = [];
        const files: string[] = [];
        const matrixRows: Array<Record<string, unknown>> = [];
        let anyError = false;
        for (let index = 0; index < runs.length; index += 1) {
          const run = runs[index];
          if (run === undefined) continue;
          const traceFile = multi ? `trace-${String(index)}-${fileSafe(run.device ?? 'default')}.txt` : 'trace.txt';
          const summaryFile = multi
            ? `trace-summary-${String(index)}-${fileSafe(run.device ?? 'default')}.json`
            : 'trace-summary.json';
          await writeTextAtomic(`${dir}/${traceFile}`, run.stdout);
          const summary = summarizeTrace(run.stdout);
          await writeTextAtomic(
            `${dir}/${summaryFile}`,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                capturedAt: now,
                ...(run.device === undefined ? {} : { device: run.device }),
                durationSeconds: durationArg,
                bufferKb,
                categories: categoryList,
                ...summary
              },
              null,
              2
            )}\n`
          );
          files.push(safeDisplay(paths, `${dir}/${traceFile}`), safeDisplay(paths, `${dir}/${summaryFile}`));
          const traceError =
            run.error !== undefined || /error:|not support category|parsing args failed|tag is empty/i.test(run.stdout);
          if (traceError) {
            anyError = true;
            try {
              const listing = await runner(
                hdc,
                [...(run.device === undefined ? [] : ['-t', run.device]), 'shell', 'hitrace', '-l'],
                paths.workspace
              );
              for (const tag of extractHitraceCategories(listing.stdout)) availableCategories.add(tag);
            } catch {
              /* category hint is best-effort */
            }
          }
          if (!traceError && run.code === 0 && run.device !== undefined) {
            const ref = await recordObservation(
              paths,
              {
                action: 'trace',
                device: run.device,
                files: [`${dir}/${traceFile}`, `${dir}/${summaryFile}`, `${dir}/result.json`]
              },
              now
            );
            observationRefs.push({ device: run.device, ref });
          }
          matrixRows.push({
            ...(run.device === undefined ? {} : { device: run.device }),
            exitCode: run.code,
            error: traceError,
            lines: summary.lines,
            events: summary.events,
            functions: summary.functions,
            ...(summary.spanMs === undefined ? {} : { spanMs: summary.spanMs }),
            topFunction: summary.topFunctions[0]?.name,
            trace: traceFile,
            summary: summaryFile
          });
        }
        if (multi) {
          await writeTextAtomic(
            `${dir}/trace-matrix.json`,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                capturedAt: now,
                durationSeconds: durationArg,
                bufferKb,
                categories: categoryList,
                total: runs.length,
                rows: matrixRows
              },
              null,
              2
            )}\n`
          );
          files.push(safeDisplay(paths, `${dir}/trace-matrix.json`));
        }
        files.push(safeDisplay(paths, `${dir}/result.json`));
        const totals = runs.map((run) => summarizeTrace(run.stdout));
        const totalEvents = totals.reduce((sum, item) => sum + item.events, 0);
        const totalLines = totals.reduce((sum, item) => sum + item.lines, 0);
        const detailLines = [
          `命令：\`${runs.map((run) => `${hdc} ${run.hdcArgs.join(' ')}`).join(' | ')}\``,
          `抓取：${String(durationArg)}s · buffer ${String(bufferKb)}KB · 分类：${categoryList.join(', ')}`,
          ...(multi
            ? [
                '| 设备 | 行数 | 事件 | 函数 | 最长切片 | 状态 |',
                '| --- | --- | --- | --- | --- | --- |',
                ...totals.map((item, index) => {
                  const run = runs[index];
                  const traceError =
                    run !== undefined &&
                    (run.error !== undefined || /error:|not support category|parsing args failed|tag is empty/i.test(run.stdout));
                  return `| ${run?.device ?? 'default'} | ${String(item.lines)} | ${String(item.events)} | ${String(item.functions)} | ${
                    item.slowest[0]?.ms === undefined ? '-' : `${String(item.slowest[0].ms)}ms`
                  } | ${traceError ? 'hitrace 报错' : 'ok'} |`;
                })
              ]
            : [
                `退出码：${String(runs[0]?.code ?? 1)} · 耗时：${String(runs[0]?.durationMs ?? 0)}ms`,
                `行数：${String(totalLines)} · 事件：${String(totalEvents)} · 函数：${String(totals[0]?.functions ?? 0)} · 跨度：${
                  totals[0]?.spanMs === undefined ? '?' : `${String(totals[0].spanMs)}ms`
                }`,
                ...(totals[0] === undefined || totals[0].topFunctions.length === 0
                  ? []
                  : [
                      '',
                      '| 函数 | 次数 | 总时长 | 最长 | 平均 |',
                      '| --- | --- | --- | --- | --- |',
                      ...totals[0].topFunctions.slice(0, 8).map(
                        (entry) =>
                          `| \`${entry.name.replace(/\|/g, '\\|')}\` | ${String(entry.count)} | ${String(entry.totalMs)}ms | ${String(entry.maxMs)}ms | ${String(entry.avgMs)}ms |`
                      )
                    ]),
                ...(totals[0] === undefined || totals[0].slowest.length === 0
                  ? []
                  : ['', `最长切片：${totals[0].slowest.slice(0, 5).map((slice) => `\`${slice.name}\` ${String(slice.ms)}ms`).join(' · ')}`])
              ]),
          ...observationRefs.map(
            (entry) => `observationRef${entry.device === undefined ? '' : `（${entry.device}）`}：\`${entry.ref}\``
          ),
          ...(availableCategories.size === 0 ? [] : ['', `可用分类：${[...availableCategories].slice(0, 40).join(', ')}`]),
          '',
          '注意：summary 只描述切片分布，不做 fps/jank 判定；性能判据仍需独立测量值。'
        ];
        const summaryLine = multi
          ? `trace all：${String(runs.length)} 台 · 共 ${String(totalEvents)} 事件（${String(totalLines)} 行）`
          : `trace：${String(totalLines)} 行 · ${String(totalEvents)} 事件 · ${String(totals[0]?.functions ?? 0)} 个函数`;
        if (anyError) {
          return fail('trace 失败：hitrace 报错或执行失败', {
            detail: detailLines.join('\n'),
            files,
            next: '按“可用分类”重新选 categories（常见：ability / graphic / ace / app）；`hitrace -l` 可列全部标签。'
          });
        }
        return runs.every((run) => run.code === 0)
          ? ok(summaryLine, {
              detail: detailLines.join('\n'),
              files,
              next: 'trace-summary.json 可作性能证据的量化描述；fps/jank 结论仍要独立测量。'
            })
          : fail(`trace 失败（exit ${String(runs.find((run) => run.code !== 0)?.code ?? 1)}）`, {
              detail: detailLines.join('\n'),
              files,
              next: '看 output.log；确认 hitrace 在设备上可用。'
            });
      }

      // App read-only queries across the whole pool (`app device=all`).
      if (action === 'app' && device === 'all') {
        const appOp = opArg ?? 'list';
        if (appOp !== 'list' && appOp !== 'foreground' && appOp !== 'info') {
          return fail('app device=all 只支持只读查询 list / foreground / info；install/start/stop/clear 请逐台指定设备。');
        }
        if (policy.pool.length === 0) return fail('app device=all 需要配置设备池 `device.pool`。');
        if (appOp === 'info' && bundleArg === undefined) return fail('app info 需要 bundle。');
        const binary = resolveBinary(options.devecocliPath);
        interface AppRun {
          readonly device: string;
          readonly args: string[];
          readonly code: number;
          readonly stdout: string;
          readonly stderr: string;
          readonly durationMs: number;
          readonly error?: string;
        }
        const runOne = async (sn: string): Promise<AppRun> => {
          const commandArgs = ['device', 'app', appOp];
          if (appOp === 'list' || appOp === 'foreground') commandArgs.push('--format', 'json');
          if (appOp === 'info') commandArgs.push(bundleArg ?? '', '--format', 'json');
          commandArgs.push('--device', sn);
          const lock = await acquireDeviceLock(paths, sn, `${TOOL}:app:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: Math.max(policy.lockTimeoutMs, 120_000)
          });
          if (!lock.ok) {
            return { device: sn, args: commandArgs, code: 1, stdout: '', stderr: lock.reason, durationMs: 0, error: lock.reason };
          }
          try {
            const result = await runner(binary, commandArgs, paths.workspace);
            return {
              device: sn,
              args: commandArgs,
              code: result.code,
              stdout: result.stdout,
              stderr: result.stderr,
              durationMs: result.durationMs
            };
          } catch (caught) {
            return {
              device: sn,
              args: commandArgs,
              code: 1,
              stdout: '',
              stderr: '',
              durationMs: 0,
              error: caught instanceof Error ? caught.message : String(caught)
            };
          } finally {
            await releaseDeviceLock(paths, sn, lock.token);
          }
        };
        const runs: AppRun[] = [];
        for (const entry of policy.pool) runs.push(await runOne(entry.sn));
        const allOk = runs.every((run) => run.code === 0);
        const now = nowIso();
        const { dir } = await writeDevecoRecord(
          paths,
          'app',
          runs.map((run) => `${binary} ${run.args.join(' ')}`).join(' | '),
          now,
          {
            code: allOk ? 0 : 1,
            stdout: runs.map((run) => `[${run.device}] exit=${String(run.code)}\n${run.stdout}`).join('\n---\n'),
            stderr: runs.map((run) => run.stderr).filter((line) => line.length > 0).join('\n'),
            durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0)
          },
          { mode: 'all', op: appOp }
        );
        const rows: Array<Record<string, unknown>> = [];
        const files: string[] = [];
        for (let index = 0; index < runs.length; index += 1) {
          const run = runs[index];
          if (run === undefined) continue;
          const parsed = jsonValue(run.stdout);
          const file = `app-${String(index)}-${run.device.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
          await writeTextAtomic(
            `${dir}/${file}`,
            `${JSON.stringify({ schemaVersion: 1, capturedAt: now, device: run.device, op: appOp, exitCode: run.code, data: parsed }, null, 2)}\n`
          );
          files.push(safeDisplay(paths, `${dir}/${file}`));
          const entry = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
          rows.push({
            device: run.device,
            exitCode: run.code,
            error: run.error,
            count: Array.isArray(parsed) ? parsed.length : undefined,
            bundle:
              typeof entry['bundleName'] === 'string'
                ? entry['bundleName']
                : appOp === 'info'
                  ? bundleArg
                  : undefined
          });
        }
        await writeTextAtomic(
          `${dir}/app-matrix.json`,
          `${JSON.stringify({ schemaVersion: 1, capturedAt: now, op: appOp, passed: allOk, rows }, null, 2)}\n`
        );
        files.push(safeDisplay(paths, `${dir}/app-matrix.json`), safeDisplay(paths, `${dir}/result.json`));
        const detail = [
          `op：${appOp}`,
          '| 设备 | 结果 | 应用数 / bundle |',
          '| --- | --- | --- |',
          ...runs.map(
            (run, index) =>
              `| ${run.device} | ${run.code === 0 ? 'ok' : `exit ${String(run.code)}`} | ${
                rows[index]?.['count'] !== undefined
                  ? String(rows[index]?.['count'])
                  : String(rows[index]?.['bundle'] ?? (appOp === 'info' ? bundleArg : '-'))
              } |`
          )
        ];
        return allOk
          ? ok(`app all（${appOp}）：${String(runs.length)} 台`, {
              detail: detail.join('\n'),
              files,
              next: '把 app-matrix.json 作为逐台查询证据；写操作请逐台执行并确认目标设备。'
            })
          : fail(`app all（${appOp}）：部分设备失败`, {
              detail: detail.join('\n'),
              files,
              next: '看各设备 app-<i>.json / output.log 定位；不要用单台结果代替整个矩阵。'
            });
      }

      // Device-side evidence: screenshot, UI layout tree, natural-language verify.
      let screenshotPath: string | null = null;
      if (action === 'screenshot') {
        screenshotPath = `${paths.artifactsDir}/devshots/shot-${Date.now()}.png`;
        await ensureDir(dirname(screenshotPath));
      }
      const command: string[] = [];
      switch (action) {
        case 'env':
          command.push('--version');
          break;
        case 'build':
          command.push('build');
          if (module !== undefined) command.push('--modules', module);
          break;
        case 'sign':
          command.push('signature', 'generate');
          break;
        case 'run':
          command.push('run');
          if (module !== undefined) command.push('--module', module);
          if (device !== undefined) command.push('--device', device);
          if (applyFile !== undefined) command.push('--apply', applyFile);
          break;
        case 'log': {
          const logOp = opArg ?? 'raw';
          if (logOp !== 'raw' && logOp !== 'crash' && logOp !== 'hilog') {
            return fail(`log 的 op 只能是 raw / crash / hilog（收到 ${logOp}）。`);
          }
          command.push('log');
          if (logOp === 'crash') {
            command.push('--crash');
          } else if (logOp === 'hilog') {
            if (level !== undefined) command.push('--level', level.toUpperCase());
            if (bundleArg !== undefined) command.push('--bundle-name', bundleArg);
            if (keywordArg !== undefined) command.push('--keyword', keywordArg);
            if (follow) command.push('--follow');
          } else {
            if (level !== undefined) command.push('--level', level.toUpperCase());
            if (crash) command.push('--crash');
          }
          if (device !== undefined) command.push('--device', device);
          for (const token of extra) command.push(token);
          break;
        }
        case 'lint':
          command.push('check', 'lint');
          break;
        case 'device':
          command.push('device', 'list');
          break;
        case 'uiHelp':
          command.push('ui', '--help');
          break;
        case 'ui':
          command.push('ui', ...extra);
          break;
        case 'emulator': {
          const allowed = [
            'list',
            'start',
            'stop',
            'create',
            'delete',
            'rotate',
            'volume',
            'fold',
            'battery',
            'geolocation',
            'scene',
            'sensor',
            'power',
            'shake'
          ];
          const emulatorOp = opArg ?? 'list';
          if (!allowed.includes(emulatorOp)) {
            return fail(`emulator 的 op 只能是 ${allowed.join(' / ')}。`);
          }
          command.push('emulator', emulatorOp);
          const names = splitTokens(emulatorName ?? '');
          if (emulatorOp === 'list') {
            command.push('--format', 'json');
          } else if (emulatorOp === 'start') {
            command.push(...names);
          } else if (emulatorOp === 'stop') {
            if (names.length === 0) return fail('emulator stop 需要 emulator（实例名或序列号，可逗号分隔）。');
            command.push(...names);
          } else if (emulatorOp === 'create' || emulatorOp === 'delete') {
            const name = names[0];
            if (name === undefined || names.length > 1) {
              return fail(`emulator ${emulatorOp} 需要且仅需要一个实例名。`);
            }
            command.push(name);
          } else {
            if (emulatorName !== undefined) command.push('--target', emulatorName);
            if ((emulatorOp === 'rotate' || emulatorOp === 'volume') && direction !== undefined) {
              command.push(direction);
            }
            if (emulatorOp === 'fold') {
              if (foldState !== undefined) {
                if (!safeToken(foldState)) return fail(`foldState 含不允许的字符：${foldState}`);
                command.push(foldState);
              }
            }
            if (emulatorOp === 'battery') {
              if (batteryLevel !== undefined && (batteryLevel < 0 || batteryLevel > 100)) {
                return fail('batteryLevel 必须在 0–100 之间。');
              }
              if (batteryLevel !== undefined) command.push('--level', String(batteryLevel));
              if (batteryStatus !== undefined) command.push('--status', batteryStatus);
            }
            if (emulatorOp === 'geolocation') {
              if (latitude !== undefined && (latitude < -90 || latitude > 90)) return fail('latitude 必须在 -90–90 之间。');
              if (longitude !== undefined && (longitude < -180 || longitude > 180)) return fail('longitude 必须在 -180–180 之间。');
              if (latitude !== undefined) command.push('--latitude', String(latitude));
              if (longitude !== undefined) command.push('--longitude', String(longitude));
            }
            if (emulatorOp === 'sensor' && sensorArg !== undefined) {
              const allowedSensor = new Set(['light-intensity', 'humidity', 'temperature', 'steps', 'heartrate']);
              for (const pair of splitTokens(sensorArg)) {
                const [key, value] = pair.split('=', 2);
                if (key === undefined || value === undefined || !allowedSensor.has(key) || !/^-?\d+(?:\.\d+)?$/.test(value)) {
                  return fail(`sensor 只接受 key=number（${[...allowedSensor].join(' / ')}）：${pair}`);
                }
                command.push(`--${key}`, value);
              }
            }
          }
          for (const token of extra) command.push(token);
          break;
        }
        case 'app': {
          const allowed = ['list', 'foreground', 'info', 'start', 'install', 'uninstall', 'stop', 'clearcache', 'cleardata'];
          const appOp = opArg ?? 'list';
          if (!allowed.includes(appOp)) {
            return fail(`app 的 op 只能是 ${allowed.join(' / ')}。`);
          }
          command.push('device', 'app', appOp);
          if (appOp === 'list' || appOp === 'foreground') command.push('--format', 'json');
          if (appOp === 'info') {
            if (bundleArg === undefined) return fail('app info 需要 bundle。');
            command.push(bundleArg, '--format', 'json');
          }
          if (appOp === 'start') {
            if (bundleArg === undefined) return fail('app start 需要 bundle。');
            command.push('--bundle', bundleArg);
            if (abilityArg !== undefined) command.push('--ability', abilityArg);
          }
          if (appOp === 'install') {
            if (hapArg === undefined) return fail('app install 需要 hap（相对工作区或绝对路径）。');
            const local = resolve(paths.workspace, hapArg);
            if (!existsSync(local)) return fail(`安装包不存在：${hapArg}`);
            command.push(local);
          }
          if (appOp === 'uninstall' || appOp === 'stop' || appOp === 'clearcache' || appOp === 'cleardata') {
            if (bundleArg === undefined) return fail(`app ${appOp} 需要 bundle。`);
            command.push('--bundle', bundleArg);
          }
          for (const token of extra) command.push(token);
          if (device !== undefined) command.push('--device', device);
          break;
        }
        case 'file': {
          const allowed = ['send', 'recv', 'exist', 'delete'];
          const fileOp = opArg ?? 'send';
          if (!allowed.includes(fileOp)) {
            return fail(`file 的 op 只能是 ${allowed.join(' / ')}。`);
          }
          command.push('device', 'file', fileOp);
          if (fileOp === 'send') {
            if (srcArg === undefined || dstArg === undefined) {
              return fail('file send 需要 src（本地）与 dst（设备路径）。');
            }
            const local = resolveInside(paths.workspace, srcArg);
            if (local === null || !existsSync(local)) {
              return fail('file send 的 src 必须是工作区内存在的文件。');
            }
            command.push(local, dstArg);
          } else if (fileOp === 'recv') {
            if (srcArg === undefined || dstArg === undefined) {
              return fail('file recv 需要 src（设备路径）与 dst（本地路径）。');
            }
            const local = resolveInside(paths.workspace, dstArg);
            if (local === null) return fail('file recv 的 dst 必须在工作区内。');
            await ensureDir(dirname(local));
            command.push(srcArg, local);
          } else {
            if (srcArg === undefined) return fail(`file ${fileOp} 需要 src（设备路径）。`);
            command.push(srcArg);
          }
          if (device !== undefined) command.push('--device', device);
          break;
        }
        case 'compat': {
          const allowed = ['check', 'versions'];
          const compatOp = opArg ?? 'check';
          if (!allowed.includes(compatOp)) return fail(`compat 的 op 只能是 ${allowed.join(' / ')}。`);
          if (compatOp === 'versions') {
            command.push('check', 'compat', 'versions');
            break;
          }
          let source = sourceVersion;
          let target = targetVersion;
          if (source === undefined || target === undefined) {
            const root = findProjectRoot(paths.workspace);
            if (root !== null) {
              const info = readProjectInfo(root);
              source = source ?? info.apiVersions.compileSdkVersion ?? info.apiVersions.compatibleSdkVersion;
              target = target ?? info.apiVersions.compatibleSdkVersion ?? info.apiVersions.targetSdkVersion;
            }
          }
          if (source === undefined || target === undefined) {
            return fail('compat 需要 sourceVersion 与 targetVersion（或工程 build-profile 里的 compileSdkVersion/compatibleSdkVersion）。', {
              next: '先用 `dwguard_deveco` action=compat op=versions 查看可用版本。'
            });
          }
          const moduleList = splitTokens(modulesArg ?? '');
          const fileList = splitTokens(filesArg ?? '');
          if (moduleList.length > 0 && fileList.length > 0) return fail('compat 的 modules 与 files 互斥。');
          command.push('check', 'compat', '--format', 'json', '--source-version', source, '--target-version', target);
          if (moduleList.length > 0) command.push('--modules', ...moduleList);
          for (const file of fileList) command.push(file);
          break;
        }
        case 'db': {
          if (dbArg === undefined || dbArg.trim().length === 0) return fail('db 需要 db（设备上的 SQLite 数据库路径）。');
          if (sqlArg === undefined || sqlArg.trim().length === 0) return fail('db 需要 sql（只读查询）。');
          const sql = sqlArg.trim();
          if (!/^(?:select|with|explain)\b/i.test(sql)) {
            return fail('db 只允许只读查询（SELECT / WITH / EXPLAIN）。', {
              next: '需要写库时用 file send 拉取数据库到工作区，本地只读分析。'
            });
          }
          if (sql.includes(';')) return fail('db 一次只允许一条只读语句，不能包含分号。');
          if (!safeToken(dbArg)) return fail(`db 路径含不允许的字符：${dbArg}`);
          command.push('device', 'sqlite3', dbArg, sql);
          if (device !== undefined) command.push('--device', device);
          break;
        }
        case 'screenshot':
          command.push('ui', 'screenshot', '--path', screenshotPath ?? '');
          if (device !== undefined) command.push('--device', device);
          break;
        case 'layout':
          command.push('ui', 'layout', '--format', 'json', '--mode', 'full');
          if (device !== undefined) command.push('--device', device);
          break;
        case 'a11y':
          command.push('ui', 'layout', '--format', 'json', '--mode', 'full');
          if (device !== undefined) command.push('--device', device);
          break;
        case 'verify': {
          const plan = optionalString(args, 'plan', TOOL, 2000);
          const bundle = optionalString(args, 'bundle', TOOL, 200);
          if (plan === undefined || bundle === undefined) {
            return fail('verify 需要 `plan`（自然语言测试步骤）与 `bundle`（bundleName）。');
          }
          command.push('verify', '--test-plan', plan, '--bundle-name', bundle);
          if (device !== undefined) command.push('--device', device);
          break;
        }
      }

      const binary = resolveBinary(options.devecocliPath);
      const now = nowIso();

      // Non-blocking execution: return a job id immediately, log to disk.
      const useBackground =
        args['background'] === true &&
        ((action === 'build' || action === 'run') ||
          (action === 'log' && (opArg ?? 'raw') === 'raw') ||
          (action === 'emulator' && (opArg ?? 'list') === 'start')) ||
        (action === 'log' && (opArg ?? 'raw') === 'hilog' && follow);
      if (useBackground) {
        await ensureShared(paths);
        let backgroundDevice: string | undefined;
        let backgroundToken: string | undefined;
        if (deviceAction && device !== undefined) {
          const lease = await acquireDeviceLock(paths, device, `${TOOL}:${action}:${Date.now()}`, policy.lockTimeoutMs, {
            staleAfterMs: policy.lockTimeoutMs,
            leaseTtlMs: 30 * 60_000
          });
          if (!lease.ok) return fail(lease.reason, { next: '等占用设备的任务结束后再启动后台任务。' });
          backgroundDevice = device;
          backgroundToken = lease.token;
        }
        const index = await nextIndex(paths.artifactsDir, 'deveco');
        const dir = `${paths.artifactsDir}/deveco-${index}`;
        await ensureDir(dir);
        const logFile = `${dir}/output.log`;
        let pid: number;
        try {
          pid = await startJob(binary, command, paths.workspace, logFile);
        } catch (error) {
          if (backgroundDevice !== undefined && backgroundToken !== undefined) {
            await releaseDeviceLock(paths, backgroundDevice, backgroundToken);
          }
          return fail(`后台启动失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const job: JobFile = {
          index,
          action,
          pid,
          command: `${binary} ${command.join(' ')}`,
          startedAt: now,
          logFile,
          ...(backgroundDevice === undefined ? {} : { device: backgroundDevice }),
          ...(backgroundToken === undefined ? {} : { deviceToken: backgroundToken })
        };
        await writeTextAtomic(`${dir}/job.json`, `${JSON.stringify(job, null, 2)}\n`);
        const logTimer = setInterval(() => {
          void (async () => {
            if (!alive(pid)) {
              stopBackgroundLogGuard(index);
              return;
            }
            await rotateActiveLog(logFile, options.maxDevecoLogBytes).catch(() => false);
          })();
        }, 5_000);
        logTimer.unref?.();
        backgroundLogGuards.set(index, { timer: logTimer });
        if (backgroundDevice !== undefined && backgroundToken !== undefined) {
          const timer = setInterval(() => {
            void (async () => {
              if (!alive(pid)) {
                stopBackgroundHeartbeat(index);
                await releaseDeviceLock(paths, backgroundDevice, backgroundToken);
                return;
              }
              await renewDeviceLease(paths, backgroundDevice, backgroundToken, 30 * 60_000).catch(() => false);
            })();
          }, 60_000);
          timer.unref?.();
          backgroundLeases.set(index, { device: backgroundDevice, token: backgroundToken, timer });
        }
        await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));
        return ok(`后台任务 deveco-${index} 已启动（pid ${pid}）`, {
          detail: [`任务：deveco-${index}`, `命令：\`${job.command}\``, `日志：\`${displayPath(paths, logFile)}\``].join('\n'),
          files: [displayPath(paths, `${dir}/job.json`)],
          next: '`dwguard_deveco`（action: jobs）查看进度；不需要时 `stop` + `job`。'
        });
      }

      let lockHolder: string | null = null;
      let lockToken: string | null = null;
      let lockNote = '';
      if (deviceAction && device !== undefined) {
        const lock = await acquireDeviceLock(paths, device, `${TOOL}:${action}:${Date.now()}`, policy.lockTimeoutMs, {
          staleAfterMs: policy.lockTimeoutMs,
          leaseTtlMs: Math.max(policy.lockTimeoutMs, 10 * 60_000)
        });
        if (!lock.ok) {
          return fail(lock.reason, {
            next: '等占用设备的一轮取证结束，或用 `dwguard_deveco`（action: device）查看设备池与模式。'
          });
        }
        lockHolder = device;
        lockToken = lock.token;
        lockNote = lock.staleStolen ? '（回收了过期锁）' : lock.waitedMs > 0 ? `（排队 ${lock.waitedMs}ms）` : '';
      }

      let result: DevecoRun;
      try {
        result = await runner(binary, command, paths.workspace);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const missing = /ENOENT|not recognized|cannot find/i.test(message);
        return fail(
          missing
            ? `找不到 devecocli：${message}。请安装 DevEco CLI（或设置 devecocliPath）。`
            : `devecocli 执行失败：${message}`,
          { next: '确认 Command Line Tool 已安装、`devecocli --version` 可运行；或改用 hdc/DevEco Studio 取证。' }
        );
      } finally {
        if (lockHolder !== null && lockToken !== null) await releaseDeviceLock(paths, lockHolder, lockToken);
      }

      await ensureShared(paths);
      const index = await nextIndex(paths.artifactsDir, 'deveco');
      const dir = `${paths.artifactsDir}/deveco-${index}`;
      await ensureDir(dir);
      const record = {
        schemaVersion: 1,
        index,
        action,
        command: `${binary} ${command.join(' ')}`,
        cwd: paths.workspace,
        startedAt: now,
        exitCode: result.code,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr
      };
      await writeTextAtomic(`${dir}/result.json`, `${JSON.stringify(record, null, 2)}\n`);
      await writeTextAtomic(`${dir}/output.log`, `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`);

      // Structured summaries + dedicated evidence files for the workbench actions.
      let extraSummary: string | undefined;
      const specialFiles: string[] = [];
      if (action === 'emulator' && (opArg ?? 'list') === 'list') {
        const parsed = jsonValue(result.stdout);
        if (Array.isArray(parsed)) {
          const instances = parsed.slice(0, 10).map((item) => {
            const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
            return `${String(entry['name'] ?? '?')}(${String(entry['status'] ?? '?')})`;
          });
          extraSummary = `emulator list：${String(parsed.length)} 个实例${instances.length === 0 ? '' : `（${instances.join(' · ')}）`}`;
          await writeTextAtomic(`${dir}/emulators.json`, `${JSON.stringify(parsed, null, 2)}\n`);
          specialFiles.push(displayPath(paths, `${dir}/emulators.json`));
        }
      }
      if (action === 'app') {
        const appOp = opArg ?? 'list';
        const parsed = jsonValue(result.stdout);
        if (appOp === 'list' && Array.isArray(parsed)) {
          extraSummary = `app list：${String(parsed.length)} 个应用`;
        } else if (appOp === 'foreground' && Array.isArray(parsed)) {
          extraSummary = `app foreground：${parsed.length === 0 ? '（无前台应用）' : `${String(parsed.length)} 条记录`}`;
        } else if (appOp === 'foreground' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const entry = parsed as Record<string, unknown>;
          extraSummary = `app foreground：${String(entry['bundleName'] ?? entry['bundle'] ?? '?')}`;
        } else if (appOp === 'info' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const entry = parsed as Record<string, unknown>;
          extraSummary = `app info：${String(entry['bundleName'] ?? bundleArg ?? '?')}`;
        }
        if (parsed !== null && (appOp === 'list' || appOp === 'foreground' || appOp === 'info')) {
          await writeTextAtomic(`${dir}/app.json`, `${JSON.stringify(parsed, null, 2)}\n`);
          specialFiles.push(displayPath(paths, `${dir}/app.json`));
        }
      }
      if (action === 'compat' && (opArg ?? 'check') === 'check') {
        const jsonText = extractJsonText(result.stdout);
        if (jsonText !== null) {
          try {
            const parsed = JSON.parse(jsonText) as unknown;
            const changeCount = countCompatChanges(parsed);
            extraSummary = `compat：${changeCount === null ? '结果已保存' : `${String(changeCount)} 条兼容性变更`}`;
          } catch {
            extraSummary = 'compat：结果已保存（JSON 解析失败）';
          }
          await writeTextAtomic(`${dir}/compat.json`, `${jsonText}\n`);
          specialFiles.push(displayPath(paths, `${dir}/compat.json`));
        } else if (result.stdout.trim().length > 0) {
          extraSummary = 'compat：已返回文本结果（未解析为 JSON）';
        }
      }
      if (action === 'db' && result.code === 0) {
        const outputLines = result.stdout.trim().length === 0 ? 0 : result.stdout.trim().split('\n').length;
        await writeTextAtomic(
          `${dir}/db-query.json`,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              capturedAt: now,
              ...(device === undefined ? {} : { device }),
              db: dbArg,
              sql: sqlArg,
              exitCode: result.code,
              outputLines,
              stdout: tail(result.stdout, 400)
            },
            null,
            2
          )}\n`
        );
        specialFiles.push(displayPath(paths, `${dir}/db-query.json`));
        extraSummary = `db：${String(outputLines)} 行输出`;
      }
      if (action === 'log' && result.code === 0) {
        const logOp = opArg ?? 'raw';
        if (logOp === 'crash') {
          const reports = parseCrashLog(result.stdout);
          await writeTextAtomic(
            `${dir}/crash.json`,
            `${JSON.stringify({ schemaVersion: 1, capturedAt: now, ...(device === undefined ? {} : { device }), reports }, null, 2)}\n`
          );
          specialFiles.push(displayPath(paths, `${dir}/crash.json`));
          extraSummary =
            reports.length === 0
              ? 'crash：未解析到 crash 记录'
              : `crash：${String(reports.length)} 条记录（${reports.map((report) => report.type).join('/')}），栈顶：${
                  reports[0]?.topFrame ?? '（无栈）'
                }`;
        } else if (logOp === 'hilog') {
          const hilogSummary = parseHilog(result.stdout, {
            ...(regexArg === undefined ? {} : { regex: regexArg }),
            ...(pidArg >= 0 ? { pid: pidArg } : {})
          });
          await writeTextAtomic(
            `${dir}/hilog-summary.json`,
            `${JSON.stringify({ schemaVersion: 1, capturedAt: now, ...(device === undefined ? {} : { device }), ...hilogSummary }, null, 2)}\n`
          );
          specialFiles.push(displayPath(paths, `${dir}/hilog-summary.json`));
          const errorCount = hilogSummary.errors.reduce((sum, entry) => sum + entry.count, 0);
          extraSummary = `hilog：${String(hilogSummary.total)} 行 · 错误 ${String(errorCount)} 条 · ${String(hilogSummary.folded.length)} 类模板`;
        }
      }

      if (action === 'layout' && result.stdout.trim().length > 0) {
        const json = extractJsonText(result.stdout);
        if (json !== null) {
          await writeTextAtomic(`${dir}/layout.json`, `${json}\n`);
        }
      }
      let a11ySummary: {
        readonly nodes: number;
        readonly clickable: number;
        readonly clickableWithoutText: number;
        readonly withAccessibilityId: number;
        readonly staticHits: number;
      } | null = null;
      if (action === 'a11y' && result.stdout.trim().length > 0) {
        const json = extractJsonText(result.stdout);
        if (json === null) {
          /* keep raw output only; a11y summary is impossible without valid JSON */
        } else {
          try {
            const nodes = flattenA11y(JSON.parse(json) as unknown);
            const scan = await scanWorkspace(paths.workspace, true, now);
            const a11yHits = scan.hits.filter((hit) => hit.dimension === 'accessibility');
            a11ySummary = {
              nodes: nodes.length,
              clickable: nodes.filter((node) => node.clickable === true).length,
              clickableWithoutText: nodes.filter(
                (node) => node.clickable === true && node.text === undefined && node.accessibilityId === undefined
              ).length,
              withAccessibilityId: nodes.filter((node) => node.accessibilityId !== undefined).length,
              staticHits: a11yHits.length
            };
            await writeTextAtomic(`${dir}/a11y.json`, `${json}\n`);
            await writeTextAtomic(
              `${dir}/a11y-summary.json`,
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  capturedAt: now,
                  ...a11ySummary,
                  staticHits: a11yHits,
                  note:
                    '布局树只含 bounds/text/clickable/accessibilityId，不含 accessibilityText/Level/Group；' +
                    '读屏名称与层级需结合源码静态扫描或人工走查。'
                },
                null,
                2
              )}\n`
            );
          } catch {
            /* keep raw output only */
          }
        }
      }
      await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));

      if (action === 'screenshot' && result.code === 0 && screenshotPath !== null) {
        const screenshotCheck = await validateImageFile(screenshotPath);
        if (!screenshotCheck.ok) {
          return fail(`截图命令退出码为 0，但没有生成有效截图：${screenshotCheck.reason ?? '未知原因'}`, {
            detail: `路径：\`${displayPath(paths, screenshotPath)}\`\n没有把“退出码 0”当作成功；请检查设备/路径权限。`,
            next: '重新执行 screenshot，或改用 hdc snapshot_display + file recv 并确认文件头。'
          });
        }
      }

      const baseSummary = `devecocli ${action} → exit ${result.code}（${result.durationMs}ms）`;
      const summary = a11ySummary === null
        ? extraSummary ?? baseSummary
        : `a11y 快照：节点 ${a11ySummary.nodes} · 可点击 ${a11ySummary.clickable} · 无文本 ${a11ySummary.clickableWithoutText} · 静态命中 ${a11ySummary.staticHits}`;
      const extraFiles: string[] = [];
      if (screenshotPath !== null && existsSync(screenshotPath)) {
        extraFiles.push(displayPath(paths, screenshotPath));
      }
      if (action === 'layout' && existsSync(`${dir}/layout.json`)) {
        extraFiles.push(displayPath(paths, `${dir}/layout.json`));
      }
      if (a11ySummary !== null) {
        extraFiles.push(displayPath(paths, `${dir}/a11y.json`), displayPath(paths, `${dir}/a11y-summary.json`));
      }
      if (specialFiles.length > 0) extraFiles.push(...specialFiles);
      let observationRef: string | undefined;
      const observationFiles = [
        ...(screenshotPath !== null && existsSync(screenshotPath) ? [screenshotPath] : []),
        ...(existsSync(`${dir}/layout.json`) ? [`${dir}/layout.json`] : []),
        ...(existsSync(`${dir}/a11y.json`) ? [`${dir}/a11y.json`] : [])
      ];
      if (deviceAction && result.code === 0 && observationFiles.length > 0) {
        let observationSpecVersion: number | undefined;
        const specRaw = await readTextOrNull(paths.specJson);
        if (specRaw !== null) {
          try {
            const parsed = JSON.parse(specRaw) as { specVersion?: unknown };
            if (typeof parsed.specVersion === 'number') observationSpecVersion = Math.trunc(parsed.specVersion);
          } catch {
            /* no spec version; observation still records files/device */
          }
        }
        observationRef = await recordObservation(
          paths,
          {
            action,
            ...(device === undefined ? {} : { device }),
            ...(observationSpecVersion === undefined ? {} : { specVersion: observationSpecVersion }),
            files: observationFiles
          },
          now
        );
      }
      const detail = [
        `命令：\`${record.command}\``,
        `退出码：${result.code} · 耗时：${result.durationMs}ms`,
        `设备策略：${policy.mode === 'matrix' ? `矩阵 ${policy.matrix.length} 族 · 并发≤${policy.maxConcurrency}` : `单机（主机内存 ${policy.hostMemoryGb}GB）`}${lockNote}`,
        ...(observationRef === undefined ? [] : [`observationRef：\`${observationRef}\`（可作为 audit 的结构化证据）`]),
        ...(extraSummary === undefined ? [] : [`摘要：${extraSummary}`]),
        action === 'device'
          ? `设备池：${policy.pool.length === 0 ? '（未配置）' : policy.pool.map((entry) => `${entry.sn}（${entry.family}/${entry.kind}）`).join(' · ')}`
          : '',
        ...policy.warnings.map((warning) => `提醒：${warning}`),
        '',
        result.stdout.trim().length === 0 ? '（无 stdout）' : '```text\n' + tail(result.stdout) + '\n```',
        result.stderr.trim().length === 0 ? '' : '\nstderr:\n```text\n' + tail(result.stderr, 20) + '\n```',
        '',
        a11ySummary === null
          ? ''
          : `快照：节点 ${a11ySummary.nodes} · 可点击 ${a11ySummary.clickable} · 带 accessibilityId ${a11ySummary.withAccessibilityId} · 可点击但无文本/ID ${a11ySummary.clickableWithoutText} · 静态无障碍命中 ${a11ySummary.staticHits}`,
        a11ySummary === null
          ? ''
          : '注意：布局树不含 accessibilityText/Level/Group，读屏名称与层级以静态扫描 + 人工走查为准。',
        screenshotPath === null ? '' : `截图：\`${displayPath(paths, screenshotPath)}\`（${existsSync(screenshotPath) ? '已生成' : '未生成'}）`,
        `记录：\`${displayPath(paths, dir)}/\``
      ]
        .filter((line) => line.length > 0)
        .join('\n');
      const files = [displayPath(paths, `${dir}/result.json`), ...extraFiles];

      return result.code === 0
        ? ok(summary, { detail, files, next: '继续下一步；证据文件可直接写进审计 checks 的 evidenceFiles。' })
        : fail(summary, { detail, files, next: '看输出定位失败原因；不要把它当成"通过"。' });
    },
    presentCall(args) {
      return presentCall('DwGuard · DevEco CLI 取证', 'read', args);
    }
  });
}
