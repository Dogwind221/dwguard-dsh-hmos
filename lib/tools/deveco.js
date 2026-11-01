/**
 * `dwguard_deveco` — read-only-ish evidence adapter for DevEco CLI.
 *
 * Runs a fixed set of `devecocli` subcommands (build / run / log / lint / device
 * / ui) from the workspace, captures stdout/stderr + exit code into
 * `artifacts/deveco-<n>/`, and reports the exact command. DSH uses the output as
 * evidence; the executor's own claims are still not trusted.
 *
 * @module dwguard-dsh-hmos/tools/deveco
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { nextIndex, updateState } from '../state.js';
import { ensureShared } from '../scaffold.js';
import { ensureDir, writeTextAtomic } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalString, requiredEnum } from './args.js';
import { pathsOf } from './common.js';
const TOOL = 'dwguard_deveco';
const ACTIONS = ['env', 'build', 'run', 'log', 'lint', 'device', 'uiHelp', 'ui'];
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
function safeToken(value) {
    return /^[\w./:=@-]+$/.test(value);
}
/**
 * Create the DevEco CLI adapter tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context.
 * @param runner - injectable runner (tests pass a fake).
 */
export function createDevecoTool(options, ctx, runner = spawnRunner) {
    return defineTool({
        name: TOOL,
        description: 'Run DevEco CLI (`devecocli`) read-only evidence commands: env / build / run / log / lint / device / uiHelp / ui. Writes command + exit code + output under `artifacts/deveco-<n>/`; DSH cites this as evidence, never as executor self-verification. ' +
            '先在设备/模拟器上用 env 确认工具链和在线设备；`ui` 若参数不明先用 uiHelp 探测。',
        parameters: {
            action: { type: 'string', required: true, enum: [...ACTIONS], description: '要执行的 devecocli 动作。' },
            module: { type: 'string', description: 'build/run 的模块名（可选）。' },
            device: { type: 'string', description: 'run/log 的设备序列号或名称（可选）。' },
            level: { type: 'string', description: 'log 的级别 D/I/W/E/F（可选）。' },
            crash: { type: 'boolean', description: 'log 是否只看崩溃日志（可选）。' },
            apply: { type: 'string', description: 'run 的增量部署清单文件名（放在工程 .hvigor/ 下，可选）。' },
            args: { type: 'string', description: 'ui 的附加参数（空格分隔，仅允许安全字符）。' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            const action = requiredEnum(args, 'action', ACTIONS, TOOL);
            const module = optionalString(args, 'module', TOOL, 120);
            const device = optionalString(args, 'device', TOOL, 200);
            const level = optionalString(args, 'level', TOOL, 1);
            const crash = args['crash'] === true;
            const applyFile = optionalString(args, 'apply', TOOL, 200);
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
            let command;
            switch (action) {
                case 'env':
                    command = ['--version'];
                    break;
                case 'build':
                    command = ['build'];
                    if (module !== undefined)
                        command.push('--modules', module);
                    break;
                case 'run':
                    command = ['run'];
                    if (module !== undefined)
                        command.push('--module', module);
                    if (device !== undefined)
                        command.push('--device', device);
                    if (applyFile !== undefined)
                        command.push('--apply', applyFile);
                    break;
                case 'log':
                    command = ['log'];
                    if (level !== undefined)
                        command.push('--level', level.toUpperCase());
                    if (crash)
                        command.push('--crash');
                    if (device !== undefined)
                        command.push('--device', device);
                    break;
                case 'lint':
                    command = ['check', 'lint'];
                    break;
                case 'device':
                    command = ['device', 'list'];
                    break;
                case 'uiHelp':
                    command = ['ui', '--help'];
                    break;
                case 'ui':
                    command = ['ui', ...extra];
                    break;
            }
            const binary = options.devecocliPath.length > 0 ? resolve(options.devecocliPath) : 'devecocli';
            const now = nowIso();
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
            await updateState(paths, now, (current) => ({ ...current, lastDevecoAt: now }));
            const summary = `devecocli ${action} → exit ${result.code}（${result.durationMs}ms）`;
            const detail = [
                `命令：\`${record.command}\``,
                `退出码：${result.code} · 耗时：${result.durationMs}ms`,
                '',
                result.stdout.trim().length === 0 ? '（无 stdout）' : '```text\n' + tail(result.stdout) + '\n```',
                result.stderr.trim().length === 0 ? '' : '\nstderr:\n```text\n' + tail(result.stderr, 20) + '\n```',
                '',
                `记录：\`${displayPath(paths, dir)}/\``
            ]
                .filter((line) => line.length > 0)
                .join('\n');
            return result.code === 0
                ? ok(summary, { detail, files: [displayPath(paths, `${dir}/result.json`)], next: '继续下一步；证据文件可直接写进审计 checks 的 evidenceFiles。' })
                : fail(summary, { detail, files: [displayPath(paths, `${dir}/result.json`)], next: '看输出定位失败原因；不要把它当成"通过"。' });
        },
        presentCall(args) {
            return presentCall('DwGuard · DevEco CLI 取证', 'read', args);
        }
    });
}
