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
import { copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { nextIndex, updateState } from '../state.js';
import { ensureShared } from '../scaffold.js';
import { ensureDir, listDir, readTextOrNull, writeTextAtomic } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalString, requiredEnum } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_deveco';
const ACTIONS = [
  'env',
  'build',
  'run',
  'log',
  'lint',
  'device',
  'uiHelp',
  'ui',
  'screenshot',
  'layout',
  'verify',
  'attach',
  'jobs',
  'stop'
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
  const child = spawn(command, [...args], {
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

/**
 * Default runner: spawn `devecocli`, capture output, enforce a timeout.
 * @param command - resolved binary.
 * @param args - fixed subcommand arguments.
 * @param cwd - project root.
 */
function spawnRunner(command: string, args: readonly string[], cwd: string): Promise<DevecoRun> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(command, [...args], {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`devecocli 超时（${DEFAULT_TIMEOUT_MS / 1000}s）`));
    }, DEFAULT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

function tail(text: string, lines = 40): string {
  const split = text.trimEnd().split('\n');
  return split.slice(-lines).join('\n');
}

function safeToken(value: string): boolean {
  return /^[\w./:=@-]+$/.test(value);
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
      'Run DevEco CLI (`devecocli`) evidence commands: env / build / run / log / lint / device / uiHelp / ui / screenshot / layout / verify / attach / jobs / stop. Writes command + exit code + output under `artifacts/deveco-<n>/`; DSH cites this as evidence, never as executor self-verification. ' +
      '长命令加 `background: true` 会立即返回 job id，之后用 `jobs` 查看、`stop` 终止；`attach` 复用已有日志，不重复构建；`screenshot` / `layout` / `verify` 走真实设备取证。',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: '要执行的 devecocli 动作。' },
      module: { type: 'string', description: 'build/run 的模块名（可选）。' },
      device: { type: 'string', description: 'run/log 的设备序列号或名称（可选）。' },
      level: { type: 'string', description: 'log 的级别 D/I/W/E/F（可选）。' },
      crash: { type: 'boolean', description: 'log 是否只看崩溃日志（可选）。' },
      apply: { type: 'string', description: 'run 的增量部署清单文件名（放在工程 .hvigor/ 下，可选）。' },
      args: { type: 'string', description: 'ui 的附加参数（空格分隔，仅允许安全字符）。' },
      file: { type: 'string', description: 'attach：要登记为证据的已有文件（相对工作区或 `.shared/`）。' },
      background: { type: 'boolean', description: 'build/run/log 是否后台执行并立即返回 job id（默认 false）。' },
      job: { type: 'string', description: 'stop：job id（即 deveco-<n> 的 n，或 pid）。' },
      plan: { type: 'string', description: 'verify：自然语言测试步骤与预期结果。' },
      bundle: { type: 'string', description: 'verify：被测应用 bundleName。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const action = requiredEnum(args, 'action', ACTIONS, TOOL);
      const module = optionalString(args, 'module', TOOL, 120);
      const device = optionalString(args, 'device', TOOL, 200);
      const level = optionalString(args, 'level', TOOL, 1);
      const crash = args['crash'] === true;
      const applyFile = optionalString(args, 'apply', TOOL, 200);
      const uiArgs = optionalString(args, 'args', TOOL, 400);

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
            jobs.push({ ...job, running: alive(job.pid) });
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
        case 'run':
          command.push('run');
          if (module !== undefined) command.push('--module', module);
          if (device !== undefined) command.push('--device', device);
          if (applyFile !== undefined) command.push('--apply', applyFile);
          break;
        case 'log':
          command.push('log');
          if (level !== undefined) command.push('--level', level.toUpperCase());
          if (crash) command.push('--crash');
          if (device !== undefined) command.push('--device', device);
          break;
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
        case 'screenshot':
          command.push('ui', 'screenshot', '--path', screenshotPath ?? '');
          if (device !== undefined) command.push('--device', device);
          break;
        case 'layout':
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
      const useBackground = args['background'] === true && (action === 'build' || action === 'run' || action === 'log');
      if (useBackground) {
        await ensureShared(paths);
        const index = await nextIndex(paths.artifactsDir, 'deveco');
        const dir = `${paths.artifactsDir}/deveco-${index}`;
        await ensureDir(dir);
        const logFile = `${dir}/output.log`;
        let pid: number;
        try {
          pid = await startJob(binary, command, paths.workspace, logFile);
        } catch (error) {
          return fail(`后台启动失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const job: JobFile = {
          index,
          action,
          pid,
          command: `${binary} ${command.join(' ')}`,
          startedAt: now,
          logFile
        };
        await writeTextAtomic(`${dir}/job.json`, `${JSON.stringify(job, null, 2)}\n`);
        await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));
        return ok(`后台任务 deveco-${index} 已启动（pid ${pid}）`, {
          detail: [`任务：deveco-${index}`, `命令：\`${job.command}\``, `日志：\`${displayPath(paths, logFile)}\``].join('\n'),
          files: [displayPath(paths, `${dir}/job.json`)],
          next: '`dwguard_deveco`（action: jobs）查看进度；不需要时 `stop` + `job`。'
        });
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
      if (action === 'layout' && result.stdout.trim().length > 0) {
        try {
          JSON.parse(result.stdout);
          await writeTextAtomic(`${dir}/layout.json`, `${result.stdout.trim()}\n`);
        } catch {
          /* keep raw output only */
        }
      }
      await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));

      const summary = `devecocli ${action} → exit ${result.code}（${result.durationMs}ms）`;
      const extraFiles: string[] = [];
      if (screenshotPath !== null && existsSync(screenshotPath)) {
        extraFiles.push(displayPath(paths, screenshotPath));
      }
      if (action === 'layout' && existsSync(`${dir}/layout.json`)) {
        extraFiles.push(displayPath(paths, `${dir}/layout.json`));
      }
      const detail = [
        `命令：\`${record.command}\``,
        `退出码：${result.code} · 耗时：${result.durationMs}ms`,
        '',
        result.stdout.trim().length === 0 ? '（无 stdout）' : '```text\n' + tail(result.stdout) + '\n```',
        result.stderr.trim().length === 0 ? '' : '\nstderr:\n```text\n' + tail(result.stderr, 20) + '\n```',
        '',
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
