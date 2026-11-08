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
import { recordObservation } from '../observation.js';
import { buildFallbackTiers } from '../fallback.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { scanWorkspace } from '../scan.js';
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
    'stop'
];
/** Background lease heartbeat timers, keyed by deveco index. */
const backgroundLeases = new Map();
function stopBackgroundHeartbeat(index) {
    const lease = backgroundLeases.get(index);
    if (lease === undefined)
        return;
    clearInterval(lease.timer);
    backgroundLeases.delete(index);
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
/** Quote an argument for `cmd.exe` when spawn uses `shell: true` on Windows. */
function quoteShellArg(value) {
    if (!/[\s"]/u.test(value))
        return value;
    return `"${value.replace(/(["\\])/g, '\\$1')}"`;
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
/**
 * Default runner: spawn `devecocli`, capture output, enforce a timeout.
 * @param command - resolved binary.
 * @param args - fixed subcommand arguments.
 * @param cwd - project root.
 */
function spawnRunner(command, args, cwd) {
    return new Promise((resolvePromise, reject) => {
        const started = Date.now();
        const child = spawn(command, process.platform === 'win32' ? args.map(quoteShellArg) : [...args], {
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
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
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
        description: 'Run DevEco CLI (`devecocli`) evidence commands: env / build / sign / run / log / lint / device / uiHelp / ui / screenshot / layout / a11y / verify / pipeline / attach / jobs / stop. ' +
            '`pipeline` = sign → build → run → screenshot → layout with per-step evidence, stop-on-failure, optional resume; it never claims acceptance. ' +
            'Writes command + exit code + output under `artifacts/deveco-<n>/`; DSH cites this as evidence, never as executor self-verification. ' +
            '`a11y` = 布局树快照 + accessibilityId + 工作区静态无障碍扫描；长命令加 `background: true` 立即返回 job id；`attach` 复用已有日志；`screenshot` / `layout` / `verify` 走真实设备取证。',
        parameters: {
            action: { type: 'string', required: true, enum: [...ACTIONS], description: '要执行的 devecocli 动作。' },
            module: { type: 'string', description: 'build/run 的模块名（可选）。' },
            device: { type: 'string', description: '设备序列号（可选；缺省取设备池里的直板机）。' },
            level: { type: 'string', description: 'log 的级别 D/I/W/E/F（可选）。' },
            crash: { type: 'boolean', description: 'log 是否只看崩溃日志（可选）。' },
            apply: { type: 'string', description: 'run 的增量部署清单文件名（放在工程 .hvigor/ 下，可选）。' },
            hap: { type: 'string', description: 'pipeline 的 hdc fallback 安装包路径（可选；相对工作区或绝对路径）。' },
            bundle: { type: 'string', description: 'verify/pipeline fallback 的 bundleName。' },
            ability: { type: 'string', description: 'pipeline fallback 启动的 Ability 名（如 EntryAbility）。' },
            args: { type: 'string', description: 'ui 的附加参数（空格分隔，仅允许安全字符）。' },
            file: { type: 'string', description: 'attach：要登记为证据的已有文件（相对工作区或 `.shared/`）。' },
            background: { type: 'boolean', description: 'build/run/log 是否后台执行并立即返回 job id（默认 false）。' },
            resume: { type: 'boolean', description: 'pipeline：跳过上一次 pipeline 已成功的步骤（默认 false）。' },
            job: { type: 'string', description: 'stop：job id（即 deveco-<n> 的 n，或 pid）。' },
            plan: { type: 'string', description: 'verify：自然语言测试步骤与预期结果。' }
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
            const DEVICE_ACTIONS = new Set(['run', 'log', 'ui', 'screenshot', 'layout', 'a11y', 'verify', 'pipeline']);
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
                case 'log':
                    command.push('log');
                    if (level !== undefined)
                        command.push('--level', level.toUpperCase());
                    if (crash)
                        command.push('--crash');
                    if (device !== undefined)
                        command.push('--device', device);
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
            const useBackground = args['background'] === true && (action === 'build' || action === 'run' || action === 'log');
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
            const summary = a11ySummary === null
                ? `devecocli ${action} → exit ${result.code}（${result.durationMs}ms）`
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
