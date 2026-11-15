/**
 * dwguard_code - run the frozen Goal brief through the DevEco Code CLI.
 *
 * This is the zero-click path: DSH starts "deveco run" in a background
 * process, streams its JSON events into artifacts/code-<n>/, and returns a
 * job id. It never treats the agent's own claims as acceptance - the audit
 * still runs independently.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nextIndex, readState } from '../state.js';
import { readTextOrNull, writeTextAtomic } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalBoolean, optionalInt, optionalString, requiredEnum } from './args.js';
import { pathsOf, requireSpec } from './common.js';
import { quoteShellArg } from './deveco.js';

const TOOL = 'dwguard_code';
const ACTIONS = ['run', 'status', 'stop', 'list'] as const;

interface CodeJob {
  readonly id: string;
  readonly dir: string;
  readonly logPath: string;
  readonly metaPath: string;
  readonly startedAt: string;
  readonly pid: number;
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'timeout';
  exitCode?: number;
  endedAt?: string;
  sessionID?: string;
  lastText?: string;
  lastError?: string;
}

const jobs = new Map<string, CodeJob>();

function tail(text: string, lines = 20): string {
  const split = text.trimEnd().split('\n');
  return split.slice(Math.max(0, split.length - lines)).join('\n');
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

function killTree(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

export function resolveCodeBinary(configured: string): string {
  if (configured.length > 0) return resolve(configured);
  const candidates: string[] = [];
  if (process.env['APPDATA'] !== undefined) {
    candidates.push(join(process.env['APPDATA'], 'npm', 'deveco.cmd'));
  }
  if (process.env['LOCALAPPDATA'] !== undefined) {
    candidates.push(join(process.env['LOCALAPPDATA'], 'Programs', 'nodejs', 'deveco.cmd'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'deveco';
}

export function buildCodeArgs(input: {
  readonly dir: string;
  readonly prompt: string;
  readonly model?: string;
  readonly agent?: string;
  readonly auto: boolean;
}): string[] {
  const args = ['run', '--dir', input.dir, '--format', 'json'];
  if (input.auto) args.push('--auto');
  if (input.model !== undefined && input.model.length > 0) args.push('--model', input.model);
  if (input.agent !== undefined && input.agent.length > 0) args.push('--agent', input.agent);
  args.push(input.prompt);
  return args;
}

function parseEvent(line: string): { sessionID?: string; text?: string; error?: string } | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const out: { sessionID?: string; text?: string; error?: string } = {};
    if (typeof value['sessionID'] === 'string') out.sessionID = value['sessionID'];
    const part = value['part'];
    if (typeof part === 'object' && part !== null) {
      const record = part as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string') out.text = record['text'];
      if (record['type'] === 'error' && typeof record['message'] === 'string') out.error = record['message'];
    }
    return out;
  } catch {
    return undefined;
  }
}

function activeJobFor(dir: string): CodeJob | undefined {
  for (const job of jobs.values()) {
    if (job.dir === dir && (job.status === 'running' || job.status === 'stopping')) return job;
  }
  return undefined;
}

export function createCodeTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: TOOL,
    description:
      'Run the frozen Goal brief through DevEco Code CLI (deveco run), stream JSON events into artifacts, and return a background job id. ' +
      'action=run starts it; status/stop/list manage jobs. It does not replace dwguard_audit: the executor still only produces evidence, DSH decides acceptance.',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'run | status | stop | list' },
      dir: { type: 'string', description: '工程根目录；默认取配置 codeProjectDir，否则工作区根目录' },
      model: { type: 'string', description: 'provider/model，可选；默认使用 deveco 当前登录通道' },
      agent: { type: 'string', description: 'deveco agent 名称，可选' },
      auto: { type: 'boolean', description: '是否传 --auto；默认取配置 codeAuto' },
      timeoutMinutes: { type: 'number', description: '超时分钟数；默认取配置 codeTimeoutMinutes' },
      id: { type: 'string', description: 'status/stop 的 job id；省略时取最近一个 job' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const action = requiredEnum(args, 'action', ACTIONS, TOOL);
      const id = optionalString(args, 'id', TOOL, 80);

      if (action === 'list') {
        if (jobs.size === 0) return ok('当前没有 DevEco Code job。');
        return ok('当前 ' + String(jobs.size) + ' 个 DevEco Code job。', {
          detail: [...jobs.values()]
            .map((job) => '- ' + job.id + ' · ' + job.status + ' · ' + job.dir + ' · ' + job.startedAt)
            .join('\n')
        });
      }

      if (action === 'status') {
        const job = id === undefined ? [...jobs.values()].pop() : jobs.get(id);
        if (job === undefined) return fail('找不到该 DevEco Code job。', { next: '用 dwguard_code action=list 查看现有 job。' });
        const paths = await pathsOf(exec, { options, ctx }, TOOL);
        return ok(job.id + ' · ' + job.status, {
          detail: [
            '- dir: ' + job.dir,
            '- pid: ' + String(job.pid),
            '- started: ' + job.startedAt,
            job.endedAt === undefined ? '' : '- ended: ' + job.endedAt,
            job.exitCode === undefined ? '' : '- exit: ' + String(job.exitCode),
            job.sessionID === undefined ? '' : '- session: ' + job.sessionID,
            job.lastError === undefined ? '' : '- last error: ' + job.lastError,
            '',
            'events: ' + displayPath(paths, job.logPath)
          ]
            .filter((line) => line.length > 0)
            .join('\n')
        });
      }

      if (action === 'stop') {
        const job = id === undefined ? [...jobs.values()].pop() : jobs.get(id);
        if (job === undefined) return fail('找不到该 DevEco Code job。');
        job.status = 'stopping';
        killTree(job.pid);
        return ok('已请求停止 ' + job.id + '。', { next: '用 action=status 确认退出。' });
      }

      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const pack = await requireSpec(paths, options, TOOL);
      const state = await readState(paths, nowIso());
      const brief = await readTextOrNull(paths.briefMd);
      if (brief === null) {
        return fail('还没有 Goal 简报，不能自动运行。', { next: '先调用 dwguard_dispatch 生成 tasks/goal-brief.md。' });
      }
      const configuredDir = optionalString(args, 'dir', TOOL, 500) ?? options.codeProjectDir;
      const projectDir = configuredDir.length > 0 ? resolve(paths.workspace, configuredDir) : paths.workspace;
      if (!existsSync(projectDir)) return fail('工程目录不存在：' + projectDir);
      const active = activeJobFor(projectDir);
      if (active !== undefined) {
        return ok('该目录已有运行中的 job：' + active.id, { next: '用 action=status 查看进度，或先 action=stop。' });
      }

      const auto = optionalBoolean(args, 'auto', options.codeAuto);
      const timeoutMinutes = optionalInt(args, 'timeoutMinutes', options.codeTimeoutMinutes, TOOL, 1, 240);
      const model = optionalString(args, 'model', TOOL, 200) ?? options.codeModel;
      const agent = optionalString(args, 'agent', TOOL, 200) ?? options.codeAgent;
      const binary = resolveCodeBinary(options.devecoCodePath);
      const prompt = [
        '请读取并严格执行 ' + paths.briefMd + '。',
        '这是任务包 v' + String(pack.specVersion) + '，派发 #d-' + String(state.dispatches) + '。',
        '不要修改任务包或验收标准；完成后按简报要求把交付记录追加到 ' + paths.outboxDeveco + '，',
        '记录必须带 re=#d-' + String(state.dispatches) + '。'
      ].join(' ');

      const artifactId = await nextIndex(paths.artifactsDir, 'code');
      const artifactDir = join(paths.artifactsDir, 'code-' + String(artifactId));
      mkdirSync(artifactDir, { recursive: true });
      const logPath = join(artifactDir, 'events.jsonl');
      const metaPath = join(artifactDir, 'meta.json');
      await ensureShared(paths);
      const log = createWriteStream(logPath, { flags: 'a' });
      log.write('# ' + nowIso() + ' ' + binary + ' ' + projectDir + '\n');

      const argv = buildCodeArgs({ dir: projectDir, prompt, model, agent, auto });
      let child;
      try {
        child = spawn(binary, process.platform === 'win32' ? argv.map(quoteShellArg) : argv, {
          cwd: projectDir,
          shell: process.platform === 'win32',
          windowsHide: true,
          env: process.env
        });
      } catch (error) {
        log.end();
        return fail('启动 deveco 失败：' + (error instanceof Error ? error.message : String(error)));
      }

      const jobId = 'code-' + String(artifactId);
      const job: CodeJob = {
        id: jobId,
        dir: projectDir,
        logPath,
        metaPath,
        startedAt: nowIso(),
        pid: child.pid ?? -1,
        status: 'running'
      };
      jobs.set(jobId, job);

      const timer = setTimeout(() => {
        job.status = 'timeout';
        killTree(job.pid);
      }, timeoutMinutes * 60_000);
      timer.unref?.();

      const writeMeta = (): void => {
        void writeTextAtomic(metaPath, JSON.stringify(job, null, 2) + '\n').catch(() => undefined);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        log.write(text);
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) continue;
          const event = parseEvent(line);
          if (event?.sessionID !== undefined) job.sessionID = event.sessionID;
          if (event?.text !== undefined) job.lastText = event.text;
          if (event?.error !== undefined) job.lastError = event.error;
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        log.write('# stderr: ' + text);
        job.lastError = tail(text, 3);
      });
      child.on('error', (error) => {
        job.lastError = error.message;
        job.status = 'failed';
        job.endedAt = nowIso();
        writeMeta();
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (job.status !== 'timeout') job.status = code === 0 ? 'completed' : 'failed';
        job.exitCode = code ?? -1;
        job.endedAt = nowIso();
        log.end();
        writeMeta();
      });

      return ok('DevEco Code 已在后台启动：' + jobId, {
        detail: [
          '- 工程：' + projectDir,
          '- pid：' + String(job.pid),
          '- 日志：' + displayPath(paths, logPath),
          '- 模式：' + (auto ? '--auto' : '交互审批') + '；超时 ' + String(timeoutMinutes) + ' 分钟',
          '',
          '运行结束后用 dwguard_code action=status 查看，再用 dwguard_status / dwguard_audit 取证。'
        ].join('\n'),
        files: [displayPath(paths, logPath)],
        next: '用 dwguard_code action=status 监视；不要用它的自述代替 dwguard_audit。'
      });
    },
    presentCall(rawArgs) {
      return presentCall('DevEco Code CLI · 后台运行', 'other', rawArgs);
    }
  });
}
