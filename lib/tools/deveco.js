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
import { acquireDeviceLock, defaultDevice, releaseDeviceLock, renewDeviceLease } from '../device.js';
import { findProjectRoot, readProjectInfo, resolveInside } from '../harmonyProject.js';
import { findSdkLayout, listSdkModules, lookupSdkApi } from '../harmonySdk.js';
import { scanDeprecatedApi } from '../apiScan.js';
import { fingerprintLayout } from '../uiFingerprint.js';
import { parseCrashLog, parseHilog } from '../forensics.js';
import { rotateActiveLog } from '../util/fs.js';
import { recordObservation } from '../observation.js';
import { validateImageFile } from '../media.js';
import { buildFallbackTiers } from '../fallback.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
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
    'compat'
];
/** Background lease heartbeat timers, keyed by deveco index. */
const backgroundLeases = new Map();
/** Active background log guards, keyed by deveco index. */
const backgroundLogGuards = new Map();
function stopBackgroundHeartbeat(index) {
    const lease = backgroundLeases.get(index);
    if (lease === undefined)
        return;
    clearInterval(lease.timer);
    backgroundLeases.delete(index);
}
function stopBackgroundLogGuard(index) {
    const guard = backgroundLogGuards.get(index);
    if (guard === undefined)
        return;
    clearInterval(guard.timer);
    backgroundLogGuards.delete(index);
}
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function defaultStart(command, args, cwd, logFile) {
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
export function quoteShellArg(value) {
    if (/[\r\n&|<>^%!`]/u.test(value)) {
        throw new Error(`参数包含 shell 元字符，拒绝执行：${value}`);
    }
    if (!/[\s"]/u.test(value))
        return value;
    return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
function assertSafeCommand(command) {
    if (process.platform === 'win32' && /[\r\n&|<>^%!`]/u.test(command)) {
        throw new Error(`命令路径包含 shell 元字符，拒绝执行：${command}`);
    }
}
function defaultStop(pid) {
    if (!pidAlive(pid))
        return true;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
        else {
            process.kill(pid, 'SIGTERM');
        }
        return true;
    }
    catch {
        return false;
    }
}
const DEFAULT_TIMEOUT_MS = 180_000;
/** Keep a runaway CLI from exhausting the host's memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
async function killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return;
    if (process.platform === 'win32') {
        await new Promise((resolve) => {
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
    }
    catch {
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch {
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
function spawnRunner(command, args, cwd) {
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
        const finish = (work) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            work();
        };
        const abort = (reason) => {
            if (settled)
                return;
            const pid = child.pid;
            if (pid !== undefined)
                void killTree(pid);
            finish(() => reject(new Error(reason)));
        };
        const timer = setTimeout(() => {
            abort(`devecocli 超时（${DEFAULT_TIMEOUT_MS / 1000}s）`);
        }, DEFAULT_TIMEOUT_MS);
        child.stdout?.on('data', (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                abort(`devecocli 输出超过上限（${MAX_OUTPUT_BYTES} B）`);
                return;
            }
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
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
            finish(() => resolvePromise({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started }));
        });
    });
}
function tail(text, lines = 40) {
    const split = text.trimEnd().split('\n');
    return split.slice(-lines).join('\n');
}
/** `devecocli` may append a docs-update notice to stdout; extract the JSON body. */
function extractJsonText(text) {
    const first = text.search(/[[{]/);
    if (first < 0)
        return null;
    const opener = text[first];
    const closer = opener === '[' ? ']' : '}';
    const last = text.lastIndexOf(closer);
    if (last <= first)
        return null;
    const candidate = text.slice(first, last + 1);
    try {
        JSON.parse(candidate);
        return candidate;
    }
    catch {
        return null;
    }
}
function safeToken(value) {
    return /^[\w./:=@-]+$/.test(value);
}
/** Parse the first JSON value embedded in CLI output; `null` when absent. */
function jsonValue(text) {
    const jsonText = extractJsonText(text);
    if (jsonText === null)
        return null;
    try {
        return JSON.parse(jsonText);
    }
    catch {
        return null;
    }
}
/** Count matched UI nodes from the various shapes `ui find --format json` may use. */
function countMatches(value) {
    if (Array.isArray(value))
        return value.length;
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    for (const key of ['matches', 'elements', 'nodes', 'results', 'items', 'result']) {
        const candidate = record[key];
        if (Array.isArray(candidate))
            return candidate.length;
    }
    // A single matched node (has bounds/id/type/text) counts as one.
    if (Array.isArray(record['bounds']) || typeof record['id'] === 'string' || typeof record['type'] === 'string') {
        return 1;
    }
    return null;
}
/** Count compatibility change records from `check compat --format json`. */
function countCompatChanges(value) {
    if (Array.isArray(value))
        return value.length;
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    for (const key of ['changes', 'incompatible', 'records', 'items', 'details', 'results']) {
        const candidate = record[key];
        if (Array.isArray(candidate))
            return candidate.length;
    }
    return null;
}
/** Split a comma/whitespace separated token list. */
function splitTokens(text) {
    return text
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}
/** Extract hitrace tag names from `hitrace -l` output. */
function extractHitraceCategories(text) {
    const tags = [];
    for (const line of text.split('\n')) {
        const match = /^\s*([a-z][a-z0-9_]*)\s+-\s+/.exec(line);
        if (match?.[1] !== undefined && !tags.includes(match[1]))
            tags.push(match[1]);
    }
    return tags;
}
/** Render a display-safe relative path (or the absolute path when outside). */
function safeDisplay(paths, file) {
    return displayPath(paths, file);
}
/** Write the standard `deveco-<n>/result.json` + `output.log` record. */
async function writeDevecoRecord(paths, action, command, startedAt, result, extra = {}) {
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
/** Flatten the nested layout tree into a node list. */
function flattenA11y(value, out = []) {
    if (Array.isArray(value)) {
        for (const item of value)
            flattenA11y(item, out);
        return out;
    }
    if (typeof value !== 'object' || value === null)
        return out;
    const record = value;
    out.push({
        ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
        ...(typeof record['type'] === 'string' ? { type: record['type'] } : {}),
        ...(typeof record['text'] === 'string' ? { text: record['text'] } : {}),
        ...(Array.isArray(record['bounds']) ? { bounds: record['bounds'] } : {}),
        ...(record['clickable'] === true ? { clickable: true } : {}),
        ...(typeof record['accessibilityId'] === 'string' ? { accessibilityId: record['accessibilityId'] } : {})
    });
    if (Array.isArray(record['children']))
        flattenA11y(record['children'], out);
    return out;
}
/** Resolve `devecocli`: configured path, npm global bins, then PATH. */
function resolveBinary(configured) {
    if (configured.length > 0)
        return resolve(configured);
    const candidates = [];
    if (process.env['LOCALAPPDATA'] !== undefined) {
        candidates.push(join(process.env['LOCALAPPDATA'], 'Programs', 'nodejs', 'devecocli.cmd'));
    }
    if (process.env['APPDATA'] !== undefined) {
        candidates.push(join(process.env['APPDATA'], 'npm', 'devecocli.cmd'));
    }
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
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
export function createDevecoTool(options, ctx, runner = spawnRunner, background = {}) {
    const startJob = background.start ?? defaultStart;
    const stopJob = background.stop ?? defaultStop;
    const alive = background.alive ?? pidAlive;
    return defineTool({
        name: TOOL,
        description: 'Run DevEco CLI (`devecocli`) + HarmonyOS workbench evidence commands. ' +
            'Base: env / build / sign / run / log / lint / device / uiHelp / ui / screenshot / layout / a11y / verify / pipeline / attach / jobs / stop. ' +
            'Workbench: emulator (list/start/stop/create/delete/rotate/volume/fold/battery/geolocation/scene/sensor/power/shake), app (list/foreground/info/start/install/uninstall/stop/clearcache/cleardata), file (send/recv/exist/delete), uiassert (selector present/absent/count/fingerprint, device=all 逐台出表), trace (hdc hitrace capture), project (read build-profile/app/module/oh-package + HAP artifacts), api (lookup/versions/list + scan deprecated API usage), compat (check compat source→target), log (op=crash parses jscrash/cppcrash/appfreeze top frames; op=hilog folds errors and filters by regex/pid). ' +
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
            bufferKb: { type: 'number', description: 'trace：hitrace 缓冲区大小 KB（64–65536，默认 4096）。' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
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
            const expect = optionalEnum(args, 'expect', ['present', 'absent', 'count', 'fingerprint'], TOOL) ?? 'present';
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
            if (level !== undefined && !/^[DIWEF]$/i.test(level))
                return fail('level 只能是 D/I/W/E/F。');
            if (applyFile !== undefined && (/[\\/]/.test(applyFile) || applyFile.includes('..'))) {
                return fail('apply 只接受工程 `.hvigor/` 下的文件名，不能带路径。');
            }
            const extra = [];
            if (uiArgs !== undefined) {
                for (const token of uiArgs.split(/\s+/).filter((part) => part.length > 0)) {
                    if (!safeToken(token))
                        return fail(`ui 参数含不允许的字符：${token}`);
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
                'trace'
            ]);
            const deviceAction = DEVICE_ACTIONS.has(action);
            const resolvedDevice = device ?? defaultDevice(policy)?.sn;
            if (device === undefined && deviceAction && resolvedDevice !== undefined)
                device = resolvedDevice;
            // Job control: list or stop background devecocli runs.
            if (action === 'jobs') {
                const entries = await listDir(paths.artifactsDir);
                const jobs = [];
                for (const name of entries) {
                    const match = /^deveco-(\d+)$/.exec(name);
                    if (match?.[1] === undefined)
                        continue;
                    const raw = await readTextOrNull(`${paths.artifactsDir}/deveco-${match[1]}/job.json`);
                    if (raw === null)
                        continue;
                    try {
                        const job = JSON.parse(raw);
                        const running = alive(job.pid);
                        if (!running) {
                            stopBackgroundHeartbeat(job.index);
                            stopBackgroundLogGuard(job.index);
                            if (job.device !== undefined && job.deviceToken !== undefined) {
                                await releaseDeviceLock(paths, job.device, job.deviceToken);
                            }
                        }
                        jobs.push({ ...job, running });
                    }
                    catch {
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
                if (target === undefined)
                    return fail('stop 需要 `job`（deveco-<n> 的 n，或 pid）。');
                const entries = await listDir(paths.artifactsDir);
                let found = null;
                for (const name of entries) {
                    const match = /^deveco-(\d+)$/.exec(name);
                    if (match?.[1] === undefined)
                        continue;
                    const raw = await readTextOrNull(`${paths.artifactsDir}/deveco-${match[1]}/job.json`);
                    if (raw === null)
                        continue;
                    try {
                        const job = JSON.parse(raw);
                        if (String(job.index) === target || String(job.pid) === target)
                            found = job;
                    }
                    catch {
                        /* skip corrupt job file */
                    }
                }
                if (found === null)
                    return fail(`找不到后台任务：${target}`);
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
                if (file === undefined)
                    return fail('attach 需要 `file`（相对工作区或 `.shared/`）。');
                const source = resolve(paths.workspace, file);
                const inside = (base) => source === base || source.startsWith(`${base}${sep}`);
                if (!inside(paths.workspace) && !inside(paths.shared)) {
                    return fail('attach 的文件必须在工作区或 `.shared/` 内。');
                }
                const info = await stat(source).catch(() => null);
                if (info === null || !info.isFile())
                    return fail(`attach 文件不存在：${file}`);
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
                        const parsed = JSON.parse(specRaw);
                        if (typeof parsed.specVersion === 'number')
                            specVersion = Math.trunc(parsed.specVersion);
                    }
                    catch {
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
                const completed = new Set();
                if (resume) {
                    const dirs = (await listDir(paths.artifactsDir))
                        .filter((name) => /^deveco-\d+$/.test(name))
                        .sort((left, right) => Number.parseInt(right.slice(7), 10) - Number.parseInt(left.slice(7), 10));
                    for (const name of dirs) {
                        const raw = await readTextOrNull(`${paths.artifactsDir}/${name}/pipeline.json`);
                        if (raw === null)
                            continue;
                        try {
                            const parsed = JSON.parse(raw);
                            if (parsed.specVersion !== specVersion || !Array.isArray(parsed.steps))
                                continue;
                            for (const step of parsed.steps) {
                                if (step.ok === true && typeof step.name === 'string')
                                    completed.add(step.name);
                            }
                            break;
                        }
                        catch {
                            /* skip corrupt pipeline record */
                        }
                    }
                }
                let lockHolder = null;
                let lockToken = null;
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
                const hapPath = requestedHap !== undefined && existsSync(requestedHap) && requestedHap.startsWith(`${paths.workspace}${sep}`)
                    ? requestedHap
                    : undefined;
                const records = [];
                let failed;
                let layoutWritten = false;
                const attempt = async (tier, command, commandArgs) => {
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
                    }
                    catch (error) {
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
                            if (step.name === 'layout')
                                layoutWritten = existsSync(`${dir}/layout.json`);
                            continue;
                        }
                        const attempts = [await attempt('devecocli', binary, step.args)];
                        let success = attempts[0];
                        if (success?.ok !== true) {
                            const tiers = buildFallbackTiers({
                                step: step.name,
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
                                const tierAttempts = [];
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
                            const layoutSource = final.tier === 'hdc+hvigor' && existsSync(layoutFallbackPath)
                                ? await readTextOrNull(layoutFallbackPath)
                                : final.stdout;
                            const json = layoutSource === null ? null : extractJsonText(layoutSource);
                            if (json !== null) {
                                await writeTextAtomic(`${dir}/layout.json`, `${json}\n`);
                                layoutWritten = true;
                            }
                        }
                    }
                }
                finally {
                    if (lockHolder !== null && lockToken !== null)
                        await releaseDeviceLock(paths, lockHolder, lockToken);
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
                    }
                    else if (!completed.has('layout') && !layoutWritten) {
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
                let observationRef;
                if (failed === undefined) {
                    const observationFiles = [
                        `${dir}/pipeline.json`,
                        ...(layoutWritten ? [`${dir}/layout.json`] : []),
                        ...(existsSync(shotPath) ? [shotPath] : [])
                    ].filter((file) => existsSync(file));
                    observationRef = await recordObservation(paths, { action: 'pipeline', ...(device === undefined ? {} : { device }), specVersion, files: observationFiles }, now);
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
                if (target === null)
                    return fail('project 的 path 必须在工作区内（相对路径或工作区内的绝对路径）。');
                if (!existsSync(target))
                    return fail(`目录不存在：${requested}`);
                const root = findProjectRoot(target);
                if (root === null) {
                    return fail('没有找到 build-profile.json5：请把 path 指向 DevEco 工程根目录（或只含一个工程的工作区）。', {
                        next: '确认工程根目录有 build-profile.json5；也可以用 `dwguard_deveco` action=env 先确认 SDK/devecocli。'
                    });
                }
                const info = readProjectInfo(root);
                const now = nowIso();
                const { dir } = await writeDevecoRecord(paths, 'project', `local project ${safeDisplay(paths, root)}`, now, { code: 0, stdout: JSON.stringify(info), stderr: '', durationMs: 0 }, { projectRoot: safeDisplay(paths, root) });
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
                    ...info.modules.map((entry) => `| ${entry.name} | ${entry.type} | ${entry.deviceTypes.join(',') || '-'} | ${String(entry.abilities.length)} | ${String(entry.permissions.length)} | ${String(entry.pages.length)} |`),
                    '',
                    ...info.modules.map((entry) => `- 模块 \`${entry.name}\`：abilities ${entry.abilities.length === 0 ? '（无）' : entry.abilities.join(', ')}；pages ${entry.pages.length === 0 ? '（无）' : entry.pages.join(', ')}`),
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
                    await writeTextAtomic(`${dir}/sdk-modules.json`, `${JSON.stringify({ modules, kits, hmsModules }, null, 2)}\n`);
                    return ok(`SDK 模块：${String(modules.length)} API / ${String(kits.length)} Kit`, {
                        detail,
                        files: [safeDisplay(paths, `${dir}/sdk-modules.json`)],
                        next: '用 action=api op=lookup module=@ohos.xxx 查具体声明与 @since/@deprecated。'
                    });
                }
                if (apiOp === 'scan') {
                    const requested = projectPath ?? '.';
                    const start = resolveInside(paths.workspace, requested);
                    if (start === null)
                        return fail('api scan 的 path 必须在工作区内。');
                    if (!existsSync(start))
                        return fail(`目录不存在：${requested}`);
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
                                ...top.map((finding) => `| \`${finding.file}:${String(finding.line)}\` | \`${finding.symbol}\` | \`${finding.module}\` | ${finding.deprecated.replace(/\|/g, '\\|')} |`)
                            ]),
                        ...(scan.findings.length > top.length ? ['', `仅显示前 ${String(top.length)} 条，完整结果见 api-scan.json。`] : [])
                    ].join('\n');
                    const scanSummary = scan.findings.length === 0
                        ? 'api scan：未发现废弃 API 引用'
                        : `api scan：${String(scan.findings.length)} 处废弃 API 引用（${String(new Set(scan.findings.map((finding) => finding.file)).size)} 个文件）`;
                    return ok(scanSummary, {
                        detail,
                        files: [safeDisplay(paths, `${dir}/api-scan.json`), safeDisplay(paths, `${dir}/result.json`)],
                        next: scan.findings.length === 0
                            ? '把 api-scan.json 作为兼容性判据的证据；零命中也要保留扫描范围。'
                            : '把 api-scan.json 写进兼容性判据的 evidenceFiles；是否阻断由任务包的兼容性判据决定。'
                    });
                }
                if (module === undefined)
                    return fail('api lookup 需要 module（如 @ohos.promptAction 或 @kit.ArkUI）。');
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
            // Deterministic UI assertion (`uiassert`): evidence, not a vision model guess.
            if (action === 'uiassert') {
                if (expect !== 'fingerprint' && selector === undefined) {
                    return fail('uiassert 需要 selector（如 text=登录 / id=submit / text*=Log）；指纹断言用 expect=fingerprint。');
                }
                if (expect === 'count' && expectCount < 0)
                    return fail('expect=count 需要 count（期望匹配数）。');
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
                    : [{ sn: device, family: undefined }];
                const runOne = async (target) => {
                    const sn = target.sn;
                    const commandArgs = [];
                    if (expect === 'fingerprint') {
                        commandArgs.push('ui', 'layout', '--format', 'json', '--mode', 'full');
                        if (windowId !== undefined)
                            commandArgs.push('--window', windowId);
                    }
                    else if (expect === 'absent') {
                        commandArgs.push('ui', 'wait', selector ?? '', String(timeoutMs), '--disappear');
                        if (windowId !== undefined)
                            commandArgs.push('--window', windowId);
                    }
                    else {
                        commandArgs.push('ui', 'find', selector ?? '', '--format', 'json', '--timeout', String(timeoutMs));
                        if (expect === 'count')
                            commandArgs.push('--all');
                        if (windowId !== undefined)
                            commandArgs.push('--window', windowId);
                    }
                    if (sn !== undefined)
                        commandArgs.push('--device', sn);
                    let lockHolder = null;
                    let lockToken = null;
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
                    let result = null;
                    let error;
                    try {
                        result = await runner(binary, commandArgs, paths.workspace);
                    }
                    catch (caught) {
                        error = caught instanceof Error ? caught.message : String(caught);
                    }
                    finally {
                        if (lockHolder !== null && lockToken !== null)
                            await releaseDeviceLock(paths, lockHolder, lockToken);
                    }
                    const parsed = jsonValue(result?.stdout ?? '');
                    let matches = null;
                    let fingerprint;
                    let nodes;
                    if (expect === 'fingerprint') {
                        if (parsed !== null) {
                            const computed = fingerprintLayout(parsed);
                            fingerprint = computed.fingerprint;
                            nodes = computed.nodes;
                        }
                    }
                    else {
                        matches = countMatches(parsed);
                    }
                    let passed = false;
                    let actual = '';
                    if (error !== undefined) {
                        actual = `执行失败：${error}`;
                    }
                    else if (expect === 'fingerprint') {
                        if (fingerprint === undefined) {
                            actual = '无法从 ui layout 输出解析布局 JSON';
                        }
                        else if (fingerprintArg === undefined) {
                            passed = true;
                            actual = `采集 ${fingerprint}（${String(nodes ?? 0)} 节点）`;
                        }
                        else {
                            passed = fingerprint === fingerprintArg;
                            actual = `${fingerprint}（期望 ${fingerprintArg}）`;
                        }
                    }
                    else if (expect === 'present') {
                        passed = result !== null && result.code === 0 && (matches === null || matches > 0);
                        actual = `exit ${String(result?.code ?? 1)} · matches ${matches === null ? '（未解析）' : String(matches)}`;
                    }
                    else if (expect === 'absent') {
                        passed = result !== null && result.code === 0;
                        actual = `exit ${String(result?.code ?? 1)}（0 = 已消失）`;
                    }
                    else {
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
                const results = [];
                for (const target of targets) {
                    try {
                        results.push(await runOne(target));
                    }
                    catch (caught) {
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
                const { dir } = await writeDevecoRecord(paths, 'uiassert', results.map((result) => result.command.join(' ')).join(' | '), now, {
                    code: allPassed ? 0 : 1,
                    stdout: aggregateStdout,
                    stderr: results.map((result) => result.stderr).filter((line) => line.length > 0).join('\n'),
                    durationMs: totalMs
                }, {
                    mode: multi ? 'all' : 'single',
                    expect,
                    ...(expect === 'count' ? { expectedCount: expectCount } : {}),
                    ...(fingerprintArg === undefined ? {} : { expectedFingerprint: fingerprintArg }),
                    passed: allPassed
                });
                let specVersion;
                const specRaw = await readTextOrNull(paths.specJson);
                if (specRaw !== null) {
                    try {
                        const parsedSpec = JSON.parse(specRaw);
                        if (typeof parsedSpec.specVersion === 'number')
                            specVersion = Math.trunc(parsedSpec.specVersion);
                    }
                    catch {
                        /* no spec version */
                    }
                }
                const fileSafe = (value) => value.replace(/[^A-Za-z0-9._-]+/g, '_');
                const observationRefs = [];
                const matrixFiles = [];
                for (let index = 0; index < results.length; index += 1) {
                    const result = results[index];
                    if (result === undefined)
                        continue;
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
                        const ref = await recordObservation(paths, {
                            action: 'uiassert',
                            device: result.device,
                            ...(specVersion === undefined ? {} : { specVersion }),
                            files: observationFiles
                        }, now);
                        observationRefs.push({ device: result.device, ref });
                    }
                }
                if (multi) {
                    await writeTextAtomic(`${dir}/uiassert-matrix.json`, `${JSON.stringify({
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
                    }, null, 2)}\n`);
                    matrixFiles.push(safeDisplay(paths, `${dir}/uiassert-matrix.json`));
                }
                const detailLines = [
                    ...(selector === undefined ? [] : [`选择器：\`${selector}\``]),
                    `期望：${expect}${expect === 'count' ? ` = ${String(expectCount)}` : ''}${fingerprintArg === undefined ? '' : `（fingerprint ${fingerprintArg}）`}`,
                    ...(multi
                        ? [
                            '| 设备 | 结果 | 实际 |',
                            '| --- | --- | --- |',
                            ...results.map((result) => `| ${result.device ?? 'default'} | ${result.passed ? 'pass' : 'fail'} | ${result.actual.replace(/\|/g, '\\|')} |`)
                        ]
                        : []),
                    ...(multi ? [] : [`实际：${results[0]?.actual ?? '（无结果）'}`]),
                    `命令：\`${results.map((result) => result.command.join(' ')).join(' | ')}\``,
                    `记录：\`${displayPath(paths, dir)}/\``,
                    ...observationRefs.map((entry) => `observationRef${entry.device === undefined ? '' : `（${entry.device}）`}：\`${entry.ref}\`（可作为 audit 的结构化证据）`)
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
                        next: expect === 'fingerprint' && fingerprintArg === undefined
                            ? '把采集到的 fingerprint 写进判据；下次用 expect=fingerprint + fingerprint 复核。'
                            : '把 uiassert.json 写进审计 checks 的 evidenceFiles；断言通过不等于验收通过。'
                    })
                    : fail(summary, {
                        detail: detailLines.join('\n'),
                        files,
                        next: '看 output.log 定位是元素不存在、超时、数量不符还是指纹变化；不要放宽判据来让它通过。'
                    });
            }
            // Performance trace capture via hdc (`trace`): evidence only, no analysis claims.
            if (action === 'trace') {
                const hdc = options.hdcPath.trim().length > 0 ? options.hdcPath.trim() : 'hdc';
                const categoryList = categoriesArg === undefined ? ['ability', 'graphic', 'ace', 'app'] : splitTokens(categoriesArg);
                for (const token of categoryList) {
                    if (!safeToken(token))
                        return fail(`trace 分类含不允许的字符：${token}`);
                }
                const hdcArgs = [
                    ...(device === undefined ? [] : ['-t', device]),
                    'shell',
                    'hitrace',
                    '-t',
                    String(durationArg),
                    '-b',
                    String(bufferKb),
                    ...categoryList
                ];
                let lockHolder = null;
                let lockToken = null;
                if (device !== undefined) {
                    const lock = await acquireDeviceLock(paths, device, `${TOOL}:trace:${Date.now()}`, policy.lockTimeoutMs, {
                        staleAfterMs: policy.lockTimeoutMs,
                        leaseTtlMs: Math.max(policy.lockTimeoutMs, 5 * 60_000)
                    });
                    if (!lock.ok)
                        return fail(lock.reason, { next: '等占用设备的取证结束再抓 trace。' });
                    lockHolder = device;
                    lockToken = lock.token;
                }
                const now = nowIso();
                let result;
                try {
                    result = await runner(hdc, hdcArgs, paths.workspace);
                }
                catch (error) {
                    return fail(`trace 执行失败：${error instanceof Error ? error.message : String(error)}`, {
                        next: '确认 hdc 可用（hdcPath）且设备在线；hitrace 需要设备支持。'
                    });
                }
                finally {
                    if (lockHolder !== null && lockToken !== null)
                        await releaseDeviceLock(paths, lockHolder, lockToken);
                }
                const { dir } = await writeDevecoRecord(paths, 'trace', `${hdc} ${hdcArgs.join(' ')}`, now, result, {
                    device,
                    durationSeconds: durationArg,
                    bufferKb,
                    categories: categoryList
                });
                await writeTextAtomic(`${dir}/trace.txt`, result.stdout);
                const lineCount = result.stdout.trim().length === 0 ? 0 : result.stdout.trim().split('\n').length;
                // hitrace returns exit code 0 even for invalid categories/arguments; the
                // error text is the only reliable signal (verified on HarmonyOS 6).
                const traceError = /error:|not support category|parsing args failed|tag is empty/i.test(result.stdout);
                let availableCategories = [];
                if (traceError) {
                    try {
                        const listing = await runner(hdc, [...(device === undefined ? [] : ['-t', device]), 'shell', 'hitrace', '-l'], paths.workspace);
                        availableCategories = extractHitraceCategories(listing.stdout);
                    }
                    catch {
                        /* the category hint is best-effort */
                    }
                }
                let observationRef;
                if (!traceError && result.code === 0 && device !== undefined) {
                    observationRef = await recordObservation(paths, { action: 'trace', device, files: [`${dir}/trace.txt`, `${dir}/result.json`] }, now);
                }
                const detail = [
                    `命令：\`${hdc} ${hdcArgs.join(' ')}\``,
                    `退出码：${String(result.code)} · 耗时：${String(result.durationMs)}ms`,
                    `抓取：${String(durationArg)}s · buffer ${String(bufferKb)}KB · 分类：${categoryList.join(', ')}`,
                    `行数：${String(lineCount)}`,
                    `trace：\`${displayPath(paths, `${dir}/trace.txt`)}\``,
                    ...(observationRef === undefined ? [] : [`observationRef：\`${observationRef}\``]),
                    ...(traceError ? ['', 'hitrace 报告了错误（即使 hdc 退出码为 0）：', '```text', tail(result.stdout, 6), '```'] : []),
                    ...(availableCategories.length === 0
                        ? []
                        : ['', `可用分类：${availableCategories.slice(0, 40).join(', ')}`]),
                    '',
                    '注意：这里只抓原始 trace，没有做 fps/jank 判定；性能判据仍需独立测量值。'
                ].join('\n');
                const files = [safeDisplay(paths, `${dir}/trace.txt`), safeDisplay(paths, `${dir}/result.json`)];
                if (traceError) {
                    return fail(`trace 失败：hitrace 报错（${String(lineCount)} 行输出）`, {
                        detail,
                        files,
                        next: '按“可用分类”重新选 categories（常见：ability / graphic / ace / app）；`hitrace -l` 可列全部标签。'
                    });
                }
                return result.code === 0
                    ? ok(`trace 捕获 ${String(lineCount)} 行（${String(durationArg)}s）`, {
                        detail,
                        files,
                        next: '把 trace.txt 作为性能证据的原始素材；fps/jank 结论要另给测量值。'
                    })
                    : fail(`trace 失败（exit ${String(result.code)}）`, { detail, files, next: '看 output.log；确认 hitrace 在设备上可用。' });
            }
            // Device-side evidence: screenshot, UI layout tree, natural-language verify.
            let screenshotPath = null;
            if (action === 'screenshot') {
                screenshotPath = `${paths.artifactsDir}/devshots/shot-${Date.now()}.png`;
                await ensureDir(dirname(screenshotPath));
            }
            const command = [];
            switch (action) {
                case 'env':
                    command.push('--version');
                    break;
                case 'build':
                    command.push('build');
                    if (module !== undefined)
                        command.push('--modules', module);
                    break;
                case 'sign':
                    command.push('signature', 'generate');
                    break;
                case 'run':
                    command.push('run');
                    if (module !== undefined)
                        command.push('--module', module);
                    if (device !== undefined)
                        command.push('--device', device);
                    if (applyFile !== undefined)
                        command.push('--apply', applyFile);
                    break;
                case 'log': {
                    const logOp = opArg ?? 'raw';
                    if (logOp !== 'raw' && logOp !== 'crash' && logOp !== 'hilog') {
                        return fail(`log 的 op 只能是 raw / crash / hilog（收到 ${logOp}）。`);
                    }
                    command.push('log');
                    if (logOp === 'crash') {
                        command.push('--crash');
                    }
                    else if (logOp === 'hilog') {
                        if (level !== undefined)
                            command.push('--level', level.toUpperCase());
                        if (bundleArg !== undefined)
                            command.push('--bundle-name', bundleArg);
                    }
                    else {
                        if (level !== undefined)
                            command.push('--level', level.toUpperCase());
                        if (crash)
                            command.push('--crash');
                    }
                    if (device !== undefined)
                        command.push('--device', device);
                    for (const token of extra)
                        command.push(token);
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
                    }
                    else if (emulatorOp === 'start') {
                        command.push(...names);
                    }
                    else if (emulatorOp === 'stop') {
                        if (names.length === 0)
                            return fail('emulator stop 需要 emulator（实例名或序列号，可逗号分隔）。');
                        command.push(...names);
                    }
                    else if (emulatorOp === 'create' || emulatorOp === 'delete') {
                        const name = names[0];
                        if (name === undefined || names.length > 1) {
                            return fail(`emulator ${emulatorOp} 需要且仅需要一个实例名。`);
                        }
                        command.push(name);
                    }
                    else {
                        if (emulatorName !== undefined)
                            command.push('--target', emulatorName);
                        if ((emulatorOp === 'rotate' || emulatorOp === 'volume') && direction !== undefined) {
                            command.push(direction);
                        }
                    }
                    for (const token of extra)
                        command.push(token);
                    break;
                }
                case 'app': {
                    const allowed = ['list', 'foreground', 'info', 'start', 'install', 'uninstall', 'stop', 'clearcache', 'cleardata'];
                    const appOp = opArg ?? 'list';
                    if (!allowed.includes(appOp)) {
                        return fail(`app 的 op 只能是 ${allowed.join(' / ')}。`);
                    }
                    command.push('device', 'app', appOp);
                    if (appOp === 'list' || appOp === 'foreground')
                        command.push('--format', 'json');
                    if (appOp === 'info') {
                        if (bundleArg === undefined)
                            return fail('app info 需要 bundle。');
                        command.push(bundleArg, '--format', 'json');
                    }
                    if (appOp === 'start') {
                        if (bundleArg === undefined)
                            return fail('app start 需要 bundle。');
                        command.push('--bundle', bundleArg);
                        if (abilityArg !== undefined)
                            command.push('--ability', abilityArg);
                    }
                    if (appOp === 'install') {
                        if (hapArg === undefined)
                            return fail('app install 需要 hap（相对工作区或绝对路径）。');
                        const local = resolve(paths.workspace, hapArg);
                        if (!existsSync(local))
                            return fail(`安装包不存在：${hapArg}`);
                        command.push(local);
                    }
                    if (appOp === 'uninstall' || appOp === 'stop' || appOp === 'clearcache' || appOp === 'cleardata') {
                        if (bundleArg === undefined)
                            return fail(`app ${appOp} 需要 bundle。`);
                        command.push('--bundle', bundleArg);
                    }
                    for (const token of extra)
                        command.push(token);
                    if (device !== undefined)
                        command.push('--device', device);
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
                    }
                    else if (fileOp === 'recv') {
                        if (srcArg === undefined || dstArg === undefined) {
                            return fail('file recv 需要 src（设备路径）与 dst（本地路径）。');
                        }
                        const local = resolveInside(paths.workspace, dstArg);
                        if (local === null)
                            return fail('file recv 的 dst 必须在工作区内。');
                        await ensureDir(dirname(local));
                        command.push(srcArg, local);
                    }
                    else {
                        if (srcArg === undefined)
                            return fail(`file ${fileOp} 需要 src（设备路径）。`);
                        command.push(srcArg);
                    }
                    if (device !== undefined)
                        command.push('--device', device);
                    break;
                }
                case 'compat': {
                    const allowed = ['check', 'versions'];
                    const compatOp = opArg ?? 'check';
                    if (!allowed.includes(compatOp))
                        return fail(`compat 的 op 只能是 ${allowed.join(' / ')}。`);
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
                    if (moduleList.length > 0 && fileList.length > 0)
                        return fail('compat 的 modules 与 files 互斥。');
                    command.push('check', 'compat', '--format', 'json', '--source-version', source, '--target-version', target);
                    if (moduleList.length > 0)
                        command.push('--modules', ...moduleList);
                    for (const file of fileList)
                        command.push(file);
                    break;
                }
                case 'screenshot':
                    command.push('ui', 'screenshot', '--path', screenshotPath ?? '');
                    if (device !== undefined)
                        command.push('--device', device);
                    break;
                case 'layout':
                    command.push('ui', 'layout', '--format', 'json', '--mode', 'full');
                    if (device !== undefined)
                        command.push('--device', device);
                    break;
                case 'a11y':
                    command.push('ui', 'layout', '--format', 'json', '--mode', 'full');
                    if (device !== undefined)
                        command.push('--device', device);
                    break;
                case 'verify': {
                    const plan = optionalString(args, 'plan', TOOL, 2000);
                    const bundle = optionalString(args, 'bundle', TOOL, 200);
                    if (plan === undefined || bundle === undefined) {
                        return fail('verify 需要 `plan`（自然语言测试步骤）与 `bundle`（bundleName）。');
                    }
                    command.push('verify', '--test-plan', plan, '--bundle-name', bundle);
                    if (device !== undefined)
                        command.push('--device', device);
                    break;
                }
            }
            const binary = resolveBinary(options.devecocliPath);
            const now = nowIso();
            // Non-blocking execution: return a job id immediately, log to disk.
            const useBackground = args['background'] === true &&
                ((action === 'build' || action === 'run') ||
                    (action === 'log' && (opArg ?? 'raw') === 'raw') ||
                    (action === 'emulator' && (opArg ?? 'list') === 'start'));
            if (useBackground) {
                await ensureShared(paths);
                let backgroundDevice;
                let backgroundToken;
                if (deviceAction && device !== undefined) {
                    const lease = await acquireDeviceLock(paths, device, `${TOOL}:${action}:${Date.now()}`, policy.lockTimeoutMs, {
                        staleAfterMs: policy.lockTimeoutMs,
                        leaseTtlMs: 30 * 60_000
                    });
                    if (!lease.ok)
                        return fail(lease.reason, { next: '等占用设备的任务结束后再启动后台任务。' });
                    backgroundDevice = device;
                    backgroundToken = lease.token;
                }
                const index = await nextIndex(paths.artifactsDir, 'deveco');
                const dir = `${paths.artifactsDir}/deveco-${index}`;
                await ensureDir(dir);
                const logFile = `${dir}/output.log`;
                let pid;
                try {
                    pid = await startJob(binary, command, paths.workspace, logFile);
                }
                catch (error) {
                    if (backgroundDevice !== undefined && backgroundToken !== undefined) {
                        await releaseDeviceLock(paths, backgroundDevice, backgroundToken);
                    }
                    return fail(`后台启动失败：${error instanceof Error ? error.message : String(error)}`);
                }
                const job = {
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
            let lockHolder = null;
            let lockToken = null;
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
            let result;
            try {
                result = await runner(binary, command, paths.workspace);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const missing = /ENOENT|not recognized|cannot find/i.test(message);
                return fail(missing
                    ? `找不到 devecocli：${message}。请安装 DevEco CLI（或设置 devecocliPath）。`
                    : `devecocli 执行失败：${message}`, { next: '确认 Command Line Tool 已安装、`devecocli --version` 可运行；或改用 hdc/DevEco Studio 取证。' });
            }
            finally {
                if (lockHolder !== null && lockToken !== null)
                    await releaseDeviceLock(paths, lockHolder, lockToken);
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
            let extraSummary;
            const specialFiles = [];
            if (action === 'emulator' && (opArg ?? 'list') === 'list') {
                const parsed = jsonValue(result.stdout);
                if (Array.isArray(parsed)) {
                    const instances = parsed.slice(0, 10).map((item) => {
                        const entry = typeof item === 'object' && item !== null ? item : {};
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
                }
                else if (appOp === 'foreground' && Array.isArray(parsed)) {
                    extraSummary = `app foreground：${parsed.length === 0 ? '（无前台应用）' : `${String(parsed.length)} 条记录`}`;
                }
                else if (appOp === 'foreground' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const entry = parsed;
                    extraSummary = `app foreground：${String(entry['bundleName'] ?? entry['bundle'] ?? '?')}`;
                }
                else if (appOp === 'info' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const entry = parsed;
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
                        const parsed = JSON.parse(jsonText);
                        const changeCount = countCompatChanges(parsed);
                        extraSummary = `compat：${changeCount === null ? '结果已保存' : `${String(changeCount)} 条兼容性变更`}`;
                    }
                    catch {
                        extraSummary = 'compat：结果已保存（JSON 解析失败）';
                    }
                    await writeTextAtomic(`${dir}/compat.json`, `${jsonText}\n`);
                    specialFiles.push(displayPath(paths, `${dir}/compat.json`));
                }
                else if (result.stdout.trim().length > 0) {
                    extraSummary = 'compat：已返回文本结果（未解析为 JSON）';
                }
            }
            if (action === 'log' && result.code === 0) {
                const logOp = opArg ?? 'raw';
                if (logOp === 'crash') {
                    const reports = parseCrashLog(result.stdout);
                    await writeTextAtomic(`${dir}/crash.json`, `${JSON.stringify({ schemaVersion: 1, capturedAt: now, ...(device === undefined ? {} : { device }), reports }, null, 2)}\n`);
                    specialFiles.push(displayPath(paths, `${dir}/crash.json`));
                    extraSummary =
                        reports.length === 0
                            ? 'crash：未解析到 crash 记录'
                            : `crash：${String(reports.length)} 条记录（${reports.map((report) => report.type).join('/')}），栈顶：${reports[0]?.topFrame ?? '（无栈）'}`;
                }
                else if (logOp === 'hilog') {
                    const hilogSummary = parseHilog(result.stdout, {
                        ...(regexArg === undefined ? {} : { regex: regexArg }),
                        ...(pidArg >= 0 ? { pid: pidArg } : {})
                    });
                    await writeTextAtomic(`${dir}/hilog-summary.json`, `${JSON.stringify({ schemaVersion: 1, capturedAt: now, ...(device === undefined ? {} : { device }), ...hilogSummary }, null, 2)}\n`);
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
            let a11ySummary = null;
            if (action === 'a11y' && result.stdout.trim().length > 0) {
                const json = extractJsonText(result.stdout);
                if (json === null) {
                    /* keep raw output only; a11y summary is impossible without valid JSON */
                }
                else {
                    try {
                        const nodes = flattenA11y(JSON.parse(json));
                        const scan = await scanWorkspace(paths.workspace, true, now);
                        const a11yHits = scan.hits.filter((hit) => hit.dimension === 'accessibility');
                        a11ySummary = {
                            nodes: nodes.length,
                            clickable: nodes.filter((node) => node.clickable === true).length,
                            clickableWithoutText: nodes.filter((node) => node.clickable === true && node.text === undefined && node.accessibilityId === undefined).length,
                            withAccessibilityId: nodes.filter((node) => node.accessibilityId !== undefined).length,
                            staticHits: a11yHits.length
                        };
                        await writeTextAtomic(`${dir}/a11y.json`, `${json}\n`);
                        await writeTextAtomic(`${dir}/a11y-summary.json`, `${JSON.stringify({
                            schemaVersion: 1,
                            capturedAt: now,
                            ...a11ySummary,
                            staticHits: a11yHits,
                            note: '布局树只含 bounds/text/clickable/accessibilityId，不含 accessibilityText/Level/Group；' +
                                '读屏名称与层级需结合源码静态扫描或人工走查。'
                        }, null, 2)}\n`);
                    }
                    catch {
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
            const extraFiles = [];
            if (screenshotPath !== null && existsSync(screenshotPath)) {
                extraFiles.push(displayPath(paths, screenshotPath));
            }
            if (action === 'layout' && existsSync(`${dir}/layout.json`)) {
                extraFiles.push(displayPath(paths, `${dir}/layout.json`));
            }
            if (a11ySummary !== null) {
                extraFiles.push(displayPath(paths, `${dir}/a11y.json`), displayPath(paths, `${dir}/a11y-summary.json`));
            }
            if (specialFiles.length > 0)
                extraFiles.push(...specialFiles);
            let observationRef;
            const observationFiles = [
                ...(screenshotPath !== null && existsSync(screenshotPath) ? [screenshotPath] : []),
                ...(existsSync(`${dir}/layout.json`) ? [`${dir}/layout.json`] : []),
                ...(existsSync(`${dir}/a11y.json`) ? [`${dir}/a11y.json`] : [])
            ];
            if (deviceAction && result.code === 0 && observationFiles.length > 0) {
                let observationSpecVersion;
                const specRaw = await readTextOrNull(paths.specJson);
                if (specRaw !== null) {
                    try {
                        const parsed = JSON.parse(specRaw);
                        if (typeof parsed.specVersion === 'number')
                            observationSpecVersion = Math.trunc(parsed.specVersion);
                    }
                    catch {
                        /* no spec version; observation still records files/device */
                    }
                }
                observationRef = await recordObservation(paths, {
                    action,
                    ...(device === undefined ? {} : { device }),
                    ...(observationSpecVersion === undefined ? {} : { specVersion: observationSpecVersion }),
                    files: observationFiles
                }, now);
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
