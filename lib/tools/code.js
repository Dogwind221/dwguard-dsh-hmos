/**
 * `dwguard_code` — zero-click executor: hand the frozen Goal brief to the
 * DevEco Code CLI (`deveco run`) in the background, stream its JSON events into
 * `artifacts/code-<n>/`, and manage the job (run / status / stop / list).
 *
 * The executor produces evidence only. Acceptance still comes from
 * `dwguard_audit`: an agent's own report is never a `pass`.
 *
 * @module dwguard-dsh-hmos/tools/code
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nextIndex, readState } from '../state.js';
import { listDir, readTextOrNull, writeTextAtomic } from '../util/fs.js';
import { nowIso, truncate } from '../util/md.js';
import { asRecord, optionalBoolean, optionalInt, optionalString, requiredEnum } from './args.js';
import { pathsOf, requireSpec } from './common.js';
import { quoteShellArg } from './deveco.js';
const TOOL = 'dwguard_code';
const ACTIONS = ['run', 'status', 'stop', 'list'];
const MAX_TIMEOUT_MINUTES = 240;
const MAX_JOBS_KEPT = 50;
const LAST_TEXT_LIMIT = 800;
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
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
function killTree(pid) {
    if (!pidAlive(pid))
        return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
        else {
            process.kill(pid, 'SIGTERM');
        }
    }
    catch {
        /* already gone */
    }
}
function defaultTimer(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
}
function defaultSpawn(command, args, options) {
    return spawn(command, [...args], {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: options.windowsHide,
        env: options.env
    });
}
/**
 * Resolve the `deveco` binary: explicit path first, then npm-global shims, then
 * the bare name for PATH resolution by the shell.
 */
export function resolveCodeBinary(configured) {
    if (configured.length > 0)
        return resolve(configured);
    const candidates = [];
    const { APPDATA, LOCALAPPDATA } = process.env;
    if (typeof APPDATA === 'string' && APPDATA.length > 0)
        candidates.push(join(APPDATA, 'npm', 'deveco.cmd'));
    if (typeof LOCALAPPDATA === 'string' && LOCALAPPDATA.length > 0) {
        candidates.push(join(LOCALAPPDATA, 'Programs', 'nodejs', 'deveco.cmd'));
    }
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return 'deveco';
}
/** Build the `deveco run` argv; the prompt goes last so long briefs stay a file reference. */
export function buildCodeArgs(input) {
    const args = ['run', '--dir', input.dir, '--format', 'json'];
    if (input.auto)
        args.push('--auto');
    if (input.model !== undefined && input.model.length > 0)
        args.push('--model', input.model);
    if (input.agent !== undefined && input.agent.length > 0)
        args.push('--agent', input.agent);
    args.push(input.prompt);
    return args;
}
/** Parse one JSON event line; unparseable or unrelated lines are ignored. */
export function parseCodeEvent(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    const event = {};
    if (typeof record['sessionID'] === 'string')
        event.sessionID = record['sessionID'];
    const part = record['part'];
    if (typeof part === 'object' && part !== null && !Array.isArray(part)) {
        const partRecord = part;
        if (partRecord['type'] === 'text' && typeof partRecord['text'] === 'string')
            event.text = partRecord['text'];
        if (partRecord['type'] === 'error' && typeof partRecord['message'] === 'string') {
            event.error = partRecord['message'];
        }
    }
    return event;
}
function jobFromMeta(raw, fallback) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    const status = record['status'];
    const allowed = ['running', 'stopping', 'completed', 'failed', 'timeout', 'stopped'];
    if (typeof status !== 'string' || !allowed.includes(status))
        return undefined;
    const pid = typeof record['pid'] === 'number' && Number.isFinite(record['pid']) ? Math.trunc(record['pid']) : -1;
    return {
        id: typeof record['id'] === 'string' ? record['id'] : fallback.id,
        dir: typeof record['dir'] === 'string' ? record['dir'] : fallback.dir,
        logPath: fallback.logPath,
        metaPath: fallback.metaPath,
        startedAt: typeof record['startedAt'] === 'string' ? record['startedAt'] : nowIso(),
        pid,
        command: typeof record['command'] === 'string' ? record['command'] : '',
        status: status,
        eventCount: typeof record['eventCount'] === 'number' ? Math.max(0, Math.trunc(record['eventCount'])) : 0,
        ...(typeof record['exitCode'] === 'number' ? { exitCode: Math.trunc(record['exitCode']) } : {}),
        ...(typeof record['endedAt'] === 'string' ? { endedAt: record['endedAt'] } : {}),
        ...(typeof record['sessionID'] === 'string' ? { sessionID: record['sessionID'] } : {}),
        ...(typeof record['lastText'] === 'string' ? { lastText: record['lastText'] } : {}),
        ...(typeof record['lastError'] === 'string' ? { lastError: record['lastError'] } : {})
    };
}
function metaOf(job) {
    return `${JSON.stringify({
        id: job.id,
        dir: job.dir,
        pid: job.pid,
        command: job.command,
        startedAt: job.startedAt,
        status: job.status,
        eventCount: job.eventCount,
        ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
        ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
        ...(job.sessionID === undefined ? {} : { sessionID: job.sessionID }),
        ...(job.lastText === undefined ? {} : { lastText: job.lastText }),
        ...(job.lastError === undefined ? {} : { lastError: job.lastError })
    }, null, 2)}\n`;
}
async function readDiskJob(paths, id) {
    if (!/^code-\d+$/.test(id))
        return undefined;
    const dir = join(paths.artifactsDir, id);
    const metaPath = join(dir, 'meta.json');
    const raw = await readTextOrNull(metaPath);
    if (raw === null)
        return undefined;
    const dirValue = join(paths.artifactsDir, id);
    return jobFromMeta(raw, { id, dir: dirValue, logPath: join(dir, 'events.jsonl'), metaPath });
}
/**
 * Create the zero-click executor tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (optional; tests omit it).
 * @param deps - injectable spawn/kill/timer seam for tests.
 */
export function createCodeTool(options, ctx, deps = {}) {
    const spawnProcess = deps.spawn ?? defaultSpawn;
    const kill = deps.kill ?? killTree;
    const alive = deps.alive ?? pidAlive;
    const timer = deps.timer ?? defaultTimer;
    /** Jobs started by this plugin instance; disk `meta.json` covers the rest. */
    const jobs = new Map();
    /** Serialize meta.json writes per job so an older snapshot can never win. */
    const pendingWrites = new Map();
    function persist(job) {
        const content = metaOf(job);
        const next = (pendingWrites.get(job.id) ?? Promise.resolve())
            .then(() => writeTextAtomic(job.metaPath, content))
            .catch(() => undefined);
        pendingWrites.set(job.id, next);
    }
    function findJob(id) {
        if (id !== undefined)
            return jobs.get(id);
        let newest;
        for (const job of jobs.values()) {
            if (newest === undefined || job.startedAt > newest.startedAt)
                newest = job;
        }
        return newest;
    }
    function activeFor(dir) {
        for (const job of jobs.values()) {
            if (job.dir === dir && (job.status === 'running' || job.status === 'stopping'))
                return job;
        }
        return undefined;
    }
    async function activeOnDisk(paths, dir) {
        const entries = await listDir(paths.artifactsDir);
        for (const entry of entries) {
            if (!/^code-\d+$/.test(entry))
                continue;
            const job = await readDiskJob(paths, entry);
            if (job === undefined)
                continue;
            if (job.dir !== dir)
                continue;
            if (job.status !== 'running' && job.status !== 'stopping')
                continue;
            if (!alive(job.pid))
                continue;
            return job;
        }
        return undefined;
    }
    function prune() {
        if (jobs.size <= MAX_JOBS_KEPT)
            return;
        const finished = [...jobs.values()]
            .filter((job) => job.status !== 'running' && job.status !== 'stopping')
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        for (const job of finished) {
            if (jobs.size <= MAX_JOBS_KEPT)
                break;
            jobs.delete(job.id);
        }
    }
    function renderJob(job) {
        const lines = [
            `- id: ${job.id}`,
            `- 状态: ${job.status}`,
            `- 工程: ${job.dir}`,
            `- pid: ${String(job.pid)}`,
            `- 启动: ${job.startedAt}`,
            job.endedAt === undefined ? '' : `- 结束: ${job.endedAt}`,
            job.exitCode === undefined ? '' : `- 退出码: ${String(job.exitCode)}`,
            job.sessionID === undefined ? '' : `- session: ${job.sessionID}`,
            `- 事件: ${String(job.eventCount)} 条`,
            job.lastText === undefined ? '' : `- 最后输出: ${job.lastText}`,
            job.lastError === undefined ? '' : `- 最后错误: ${job.lastError}`
        ];
        if (job.status === 'running' && !alive(job.pid)) {
            lines.push('- 注意: 进程已退出，但结束状态未写入（可能是宿主被强制结束）');
        }
        return lines.filter((line) => line.length > 0).join('\n');
    }
    return defineTool({
        name: TOOL,
        description: 'Zero-click executor for the frozen Goal brief: `run` starts `deveco run --dir <project> --format json` in the background, streams JSON events into `artifacts/code-<n>/events.jsonl`, and returns a job id; `status` / `stop` / `list` manage it. ' +
            'It never replaces `dwguard_audit` — the executor produces evidence, DSH decides acceptance, and an agent self-report is still not a pass. ' +
            '`--auto` is off by default (interactive approval); one job per project directory; the run times out after `codeTimeoutMinutes` (default 45).',
        parameters: {
            action: { type: 'string', required: true, enum: [...ACTIONS], description: 'run | status | stop | list' },
            dir: { type: 'string', description: '工程根目录；默认取配置 codeProjectDir，否则工作区根目录' },
            model: { type: 'string', description: 'provider/model，可选；默认使用 deveco 当前登录通道' },
            agent: { type: 'string', description: 'deveco agent 名称，可选' },
            auto: { type: 'boolean', description: '是否传 --auto；默认取配置 codeAuto（默认 false）' },
            timeoutMinutes: { type: 'number', description: '超时分钟数（1–240）；默认取配置 codeTimeoutMinutes' },
            id: { type: 'string', description: 'status/stop 的 job id；省略时取最近一个 job' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const action = requiredEnum(args, 'action', ACTIONS, TOOL);
            const id = optionalString(args, 'id', TOOL, 80);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            if (action === 'list') {
                const merged = new Map();
                for (const job of jobs.values())
                    merged.set(job.id, job);
                for (const entry of await listDir(paths.artifactsDir)) {
                    if (!/^code-\d+$/.test(entry))
                        continue;
                    const job = await readDiskJob(paths, entry);
                    if (job !== undefined)
                        merged.set(job.id, job);
                }
                const all = [...merged.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
                if (all.length === 0)
                    return ok('当前没有 DevEco Code job。');
                return ok(`当前 ${String(all.length)} 个 DevEco Code job。`, {
                    detail: all
                        .map((job) => `- ${job.id} · ${job.status}${job.status === 'running' && !alive(job.pid) ? '（进程已退出）' : ''} · ${job.dir} · ${job.startedAt}`)
                        .join('\n'),
                    files: all.map((job) => displayPath(paths, job.logPath)).filter((file) => file.length > 0)
                });
            }
            if (action === 'status' || action === 'stop') {
                const memoryJob = findJob(id);
                const job = memoryJob ?? (id === undefined ? undefined : await readDiskJob(paths, id));
                if (job === undefined) {
                    return fail('找不到该 DevEco Code job。', {
                        next: '用 dwguard_code action=list 查看现有 job（省略 id 时取最近一个）。'
                    });
                }
                if (action === 'status') {
                    return ok(`${job.id} · ${job.status}`, { detail: renderJob(job), files: [displayPath(paths, job.logPath)] });
                }
                if (job.status !== 'running' && job.status !== 'stopping') {
                    return fail(`${job.id} 已经结束（${job.status}），无需停止。`);
                }
                if (memoryJob === undefined) {
                    // Disk-only job (another session started it): we cannot observe its
                    // close event, so record the stop directly after signalling the tree.
                    job.status = 'stopped';
                    job.endedAt = nowIso();
                    persist(job);
                    kill(job.pid);
                    return ok(`已请求停止 ${job.id}（跨会话 job）。`, {
                        detail: `- pid: ${String(job.pid)}\n- 该 job 由其他会话启动，状态直接记为 stopped`,
                        next: '用 action=status 确认；结束后仍要补 dwguard_audit。'
                    });
                }
                job.status = 'stopping';
                persist(job);
                kill(job.pid);
                return ok(`已请求停止 ${job.id}。`, {
                    detail: `- pid: ${String(job.pid)}\n- 若进程树未在几秒内退出，可用系统任务管理器结束该 pid`,
                    next: '用 action=status 确认退出；结束后仍要补 dwguard_audit。'
                });
            }
            // action === 'run'
            const pack = await requireSpec(paths, options, TOOL);
            const brief = await readTextOrNull(paths.briefMd);
            if (brief === null || brief.trim().length === 0) {
                return fail('还没有 Goal 简报，不能自动运行。', {
                    next: '先调用 dwguard_dispatch 生成 tasks/goal-brief.md。'
                });
            }
            const state = await readState(paths, nowIso());
            const dirArg = optionalString(args, 'dir', TOOL, 500);
            const configuredDir = dirArg ?? options.codeProjectDir;
            const projectDir = configuredDir.length > 0 ? resolve(paths.workspace, configuredDir) : paths.workspace;
            if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
                return fail(`工程目录不存在或不是目录：${projectDir}`, {
                    next: '用 dir 参数指定工程根目录，或检查 codeProjectDir 配置。'
                });
            }
            const active = activeFor(projectDir) ?? (await activeOnDisk(paths, projectDir));
            if (active !== undefined) {
                return fail(`该工程目录已有运行中的 job：${active.id}`, {
                    next: '用 action=status 查看进度，或先 action=stop 再重试。'
                });
            }
            const auto = optionalBoolean(args, 'auto', options.codeAuto);
            const timeoutMinutes = optionalInt(args, 'timeoutMinutes', options.codeTimeoutMinutes, TOOL, 1, MAX_TIMEOUT_MINUTES);
            const model = optionalString(args, 'model', TOOL, 200) ?? options.codeModel;
            const agent = optionalString(args, 'agent', TOOL, 200) ?? options.codeAgent;
            const binary = resolveCodeBinary(options.devecoCodePath);
            if (options.devecoCodePath.length > 0 && !existsSync(binary)) {
                return fail(`配置的 devecoCodePath 不存在：${binary}`, {
                    next: '检查 devecoCodePath 配置，或留空让它从 PATH / npm 全局解析。'
                });
            }
            const prompt = [
                `请读取并严格执行 ${paths.briefMd} 里的 Goal 简报。`,
                `这是任务包 v${String(pack.specVersion)}、派发 #d-${String(state.dispatches)}。`,
                '不要修改任务包或验收标准。',
                `完成后把交付记录追加到 ${paths.outboxDeveco}，记录必须带 re=#d-${String(state.dispatches)}。`
            ].join(' ');
            const argv = buildCodeArgs({ dir: projectDir, prompt, model, agent, auto });
            let shellArgs;
            try {
                shellArgs = process.platform === 'win32' ? argv.map((arg) => quoteShellArg(arg)) : argv;
            }
            catch (error) {
                return fail(`命令行参数包含不允许的字符：${describeError(error)}`, {
                    next: '把工程目录或简报路径里的 shell 元字符去掉，或换一个更简单的路径。'
                });
            }
            const artifactId = await nextIndex(paths.artifactsDir, 'code');
            const jobId = `code-${String(artifactId)}`;
            const artifactDir = join(paths.artifactsDir, jobId);
            mkdirSync(artifactDir, { recursive: true });
            await ensureShared(paths);
            const logPath = join(artifactDir, 'events.jsonl');
            const metaPath = join(artifactDir, 'meta.json');
            const log = createWriteStream(logPath, { flags: 'a' });
            log.write(`# ${nowIso()} ${binary} ${projectDir}\n`);
            let child;
            try {
                child = spawnProcess(binary, shellArgs, {
                    cwd: projectDir,
                    shell: process.platform === 'win32',
                    windowsHide: true,
                    env: process.env
                });
            }
            catch (error) {
                log.end();
                return fail(`启动 deveco 失败：${describeError(error)}`, {
                    next: '确认已安装 @deveco/deveco-code（`npm i -g @deveco/deveco-code`）并完成 `deveco auth login`。'
                });
            }
            const job = {
                id: jobId,
                dir: projectDir,
                logPath,
                metaPath,
                startedAt: nowIso(),
                pid: child.pid ?? -1,
                command: [binary, ...argv].join(' '),
                status: 'running',
                eventCount: 0
            };
            jobs.set(job.id, job);
            persist(job);
            let finalized = false;
            const finalize = (code) => {
                if (finalized)
                    return;
                finalized = true;
                timeoutTimer.cancel();
                if (job.status === 'stopping')
                    job.status = 'stopped';
                else if (job.status === 'running')
                    job.status = code === 0 ? 'completed' : 'failed';
                job.exitCode = code ?? -1;
                job.endedAt = nowIso();
                log.end();
                persist(job);
                prune();
            };
            const timeoutTimer = timer(timeoutMinutes * 60_000, () => {
                if (job.status !== 'running')
                    return;
                job.status = 'timeout';
                job.endedAt = nowIso();
                kill(job.pid);
                persist(job);
                log.write(`# ${nowIso()} 超时（${String(timeoutMinutes)} 分钟），已请求终止进程树\n`);
            });
            let stdoutBuffer = '';
            const handleLine = (line) => {
                const trimmed = line.trim();
                if (trimmed.length === 0)
                    return;
                job.eventCount += 1;
                const event = parseCodeEvent(trimmed);
                if (event?.sessionID !== undefined)
                    job.sessionID = event.sessionID;
                if (event?.text !== undefined)
                    job.lastText = truncate(event.text, LAST_TEXT_LIMIT);
                if (event?.error !== undefined)
                    job.lastError = truncate(event.error, LAST_TEXT_LIMIT);
            };
            child.stdout?.on('data', (chunk) => {
                const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                log.write(text);
                stdoutBuffer += text;
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop() ?? '';
                for (const line of lines)
                    handleLine(line);
            });
            child.stderr?.on('data', (chunk) => {
                const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                log.write(`# stderr: ${text}`);
                job.lastError = truncate(text, LAST_TEXT_LIMIT);
            });
            child.on('error', (error) => {
                job.lastError = truncate(error.message, LAST_TEXT_LIMIT);
                if (job.status === 'running')
                    job.status = 'failed';
                finalize(null);
            });
            child.on('close', (code) => {
                finalize(code);
            });
            return ok(`DevEco Code 已在后台启动：${jobId}`, {
                detail: [
                    `- 工程：${projectDir}`,
                    `- pid：${String(job.pid)}`,
                    `- 日志：${displayPath(paths, logPath)}`,
                    `- 模式：${auto ? '--auto（自动批准未被拒绝的工具）' : '交互审批'}`,
                    `- 超时：${String(timeoutMinutes)} 分钟`,
                    '',
                    '执行器输出只是证据：结束后用 dwguard_status / dwguard_audit 做独立取证，不要把执行器自述当验收。'
                ].join('\n'),
                files: [displayPath(paths, logPath)],
                next: '用 dwguard_code action=status 监视；结束后照常跑 dwguard_audit。'
            });
        },
        presentCall(rawArgs) {
            return presentCall('DevEco Code CLI · 后台运行', 'other', rawArgs);
        }
    });
}
