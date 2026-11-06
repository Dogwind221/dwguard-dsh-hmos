/**
 * `dwguard_harness` — cross-session run journal (0.8.0).
 *
 * This is the recovery interface: checkpoint the current phase, resume in a new
 * session, count attempts, record failures and choose a fallback. It does not
 * replace `dwguard_status` (which derives the phase from artifacts); it stores
 * the history that status alone cannot reconstruct.
 *
 * @module dwguard-dsh-hmos/tools/harness
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import {
  checkpointHarness,
  claimHarnessTask,
  closeHarness,
  completeHarnessTask,
  enqueueHarnessTask,
  failHarness,
  failHarnessTask,
  fallbackHarness,
  HARNESS_FALLBACK_CHAIN,
  readHarnessQueue,
  readHarnessSnapshot,
  resumeHarness,
  retryHarness,
  type HarnessQueue,
  type HarnessRun
} from '../harness.js';
import { displayPath } from '../paths.js';
import { ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalInt, optionalString, optionalStringArray, requiredEnum, requiredString } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_harness';
const ACTIONS = [
  'status',
  'checkpoint',
  'resume',
  'retry',
  'fail',
  'fallback',
  'close',
  'enqueue',
  'queue',
  'claim',
  'complete',
  'task-fail'
] as const;

function queueDetail(queue: HarnessQueue): string {
  if (queue.tasks.length === 0) return '（队列为空）';
  return [
    '| task | status | step | attempts | lease | note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...queue.tasks.map(
      (task) =>
        `| \`${task.id}\` | ${task.status} | ${task.step} | ${task.attempts} | ${task.lease === undefined ? '—' : `${task.lease.owner} @ ${task.lease.until}`} | ${task.note ?? '—'} |`
    )
  ].join('\n');
}

function runDetail(run: HarnessRun): string {
  const last = run.checkpoints.at(-1);
  const attempts = Object.entries(run.attempts)
    .map(([step, value]) => `${step}=${value.count}`)
    .join(' / ');
  return [
    `- run：\`${run.runId}\` · iteration ${run.iteration} · spec v${run.specVersion}`,
    `- 状态：${run.status} · 阶段：${run.phase}`,
    `- checkpoint：${last === undefined ? '无' : `\`${last.id}\` ${last.step} @ ${last.at}${last.note === undefined ? '' : `（${last.note}）`}`}`,
    `- attempts：${attempts.length === 0 ? '无' : attempts}`,
    run.lastError === undefined ? '' : `- 最近错误：\`${run.lastError.step}\` ${run.lastError.message}`,
    run.fallback === undefined
      ? ''
      : `- fallback：${run.fallback.step} → 档位 ${run.fallback.level + 1}/${HARNESS_FALLBACK_CHAIN.length}（${HARNESS_FALLBACK_CHAIN[run.fallback.level]}）`,
    `- 下一步：${run.nextAction}`
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Create the `dwguard_harness` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createHarnessTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: TOOL,
    description:
      'Cross-session run journal + persistent queue: `status` / `checkpoint` / `resume` / `retry` / `fail` / `fallback` / `close` plus `enqueue` / `queue` / `claim` / `complete` / `task-fail`. ' +
      'Stores checkpoints, attempt counts, last error and fallback level in `.shared/harness/run.json`; the queue lives in `.shared/harness/queue.json` so a scheduled worker can claim/resume without a human opening a new round. ' +
      'App-side AI and mobile development runtimes are out of scope.',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'status/checkpoint/resume/retry/fail/fallback/close/enqueue/queue/claim/complete/task-fail。' },
      step: { type: 'string', description: 'checkpoint/retry/fail/fallback/enqueue 的步骤名，如 `pipeline` / `audit`。' },
      note: { type: 'string', description: 'checkpoint/enqueue 的说明（可选）。' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'checkpoint/complete 的证据路径（可选）。' },
      error: { type: 'string', description: 'retry/fail/task-fail 的错误摘要（可选）。' },
      level: { type: 'number', description: 'fallback 档位（1=devecocli，2=deveco-mcp，3=hdc+hvigor；默认 1）。' },
      taskId: { type: 'string', description: 'complete/task-fail 的 task id（如 `task-0001`）。' },
      owner: { type: 'string', description: 'claim 的 worker 名（默认 `dsh-<pid>`）。' },
      leaseSeconds: { type: 'number', description: 'claim 的租约秒数（默认 300，最小 10）。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      await ensureShared(paths);
      const now = nowIso();
      const { snapshot, run } = await readHarnessSnapshot(paths, options, now);
      const action = requiredEnum(args, 'action', ACTIONS, TOOL);

      if (action === 'status') {
        return ok(`Harness ${run.status} · ${run.phase}`, {
          detail: runDetail(run),
          files: [displayPath(paths, paths.harnessRun)],
          next: run.nextAction
        });
      }

      if (action === 'checkpoint') {
        const step = optionalString(args, 'step', TOOL, 80) ?? 'manual';
        const note = optionalString(args, 'note', TOOL, 300);
        const evidence = optionalStringArray(args, 'evidence', TOOL, 32);
        const next = await checkpointHarness(
          paths,
          snapshot,
          { phase: snapshot.phase, step, ...(note === undefined ? {} : { note }), ...(evidence === undefined ? {} : { evidence }) },
          now
        );
        return ok(`已 checkpoint：${step}`, {
          detail: runDetail(next),
          files: [displayPath(paths, paths.harnessRun)],
          next: next.nextAction
        });
      }

      if (action === 'resume') {
        const result = await resumeHarness(paths, snapshot, now);
        return ok(`Harness resume：${result.stale ? 'stale，需要重新 spec' : '可继续'}`, {
          detail: `${runDetail(result.run)}\n\n- stale：${result.stale}`,
          files: [displayPath(paths, paths.harnessRun)],
          next: result.nextAction
        });
      }

      if (action === 'enqueue') {
        const step = requiredString(args, 'step', TOOL, 80);
        const note = optionalString(args, 'note', TOOL, 300);
        const queue = await enqueueHarnessTask(paths, now, { step, ...(note === undefined ? {} : { note }) });
        const task = queue.tasks.at(-1);
        return ok(`已入队：${task?.id ?? step}`, {
          detail: queueDetail(queue),
          files: [displayPath(paths, paths.harnessQueue)],
          next: '用 `claim` 领取（或让 scripts/harness-worker.mjs 定时领取），完成后 `complete`。'
        });
      }

      if (action === 'queue') {
        const queue = await readHarnessQueue(paths, now);
        const queued = queue.tasks.filter((task) => task.status === 'queued').length;
        return ok(`队列 ${queue.tasks.length} 个任务（queued ${queued}）。`, {
          detail: queueDetail(queue),
          files: [displayPath(paths, paths.harnessQueue)],
          next: queued > 0 ? '用 `claim` 领取下一个任务。' : '队列为空；可用 `enqueue` 加入续跑任务。'
        });
      }

      if (action === 'claim') {
        const owner = optionalString(args, 'owner', TOOL, 80) ?? `dsh-${process.pid}`;
        const leaseSeconds = optionalInt(args, 'leaseSeconds', 300, TOOL, 10, 86_400);
        const result = await claimHarnessTask(paths, now, owner, leaseSeconds);
        if (result.task === null) {
          return ok('队列里没有可领取的任务。', {
            detail: queueDetail(result.queue),
            files: [displayPath(paths, paths.harnessQueue)],
            next: '等待 `enqueue` 或定时 worker。'
          });
        }
        return ok(`已领取 ${result.task.id}（${result.task.step}）。`, {
          detail: `${queueDetail(result.queue)}\n\n- lease：${result.task.lease?.owner} @ ${result.task.lease?.until}`,
          files: [displayPath(paths, paths.harnessQueue)],
          next: '执行该 step；成功后 `complete` + taskId，失败用 `task-fail`。'
        });
      }

      if (action === 'complete') {
        const taskId = requiredString(args, 'taskId', TOOL, 40);
        const evidence = optionalStringArray(args, 'evidence', TOOL, 32);
        const queue = await completeHarnessTask(paths, now, taskId, evidence);
        return ok(`任务 ${taskId} 已标记 done。`, {
          detail: queueDetail(queue),
          files: [displayPath(paths, paths.harnessQueue)],
          next: '继续 `claim` 下一个任务，或结束。'
        });
      }

      if (action === 'task-fail') {
        const taskId = requiredString(args, 'taskId', TOOL, 40);
        const error = requiredString(args, 'error', TOOL, 600);
        const queue = await failHarnessTask(paths, now, taskId, error);
        return ok(`任务 ${taskId} 已标记 failed。`, {
          detail: queueDetail(queue),
          files: [displayPath(paths, paths.harnessQueue)],
          next: '保留现场转人工，或重新 `enqueue` 一个修复任务。'
        });
      }

      const step = requiredString(args, 'step', TOOL, 80);
      if (action === 'retry') {
        const error = optionalString(args, 'error', TOOL, 600);
        const result = await retryHarness(paths, snapshot, step, options.harnessMaxRetries, now, error);
        return ok(
          result.decision === 'human'
            ? `\`${step}\` 超过重试上限，转人工。`
            : `\`${step}\` 第 ${result.attempt.count}/${options.harnessMaxRetries} 次重试。`,
          {
            detail: runDetail(result.run),
            files: [displayPath(paths, paths.harnessRun)],
            next: result.nextAction
          }
        );
      }

      if (action === 'fail') {
        const error = requiredString(args, 'error', TOOL, 600);
        const next = await failHarness(paths, snapshot, step, error, now);
        return ok(`已记录 \`${step}\` 失败，run 置为 blocked。`, {
          detail: runDetail(next),
          files: [displayPath(paths, paths.harnessRun)],
          next: next.nextAction
        });
      }

      if (action === 'fallback') {
        const level = optionalInt(args, 'level', 1, TOOL, 1, HARNESS_FALLBACK_CHAIN.length);
        const next = await fallbackHarness(paths, snapshot, step, level - 1, now);
        return ok(`\`${step}\` 使用 fallback 档位 ${level}/${HARNESS_FALLBACK_CHAIN.length}：${HARNESS_FALLBACK_CHAIN[level - 1]}。`, {
          detail: runDetail(next),
          files: [displayPath(paths, paths.harnessRun)],
          next: next.nextAction
        });
      }

      // action === 'close'
      const next = await closeHarness(paths, snapshot, now);
      return ok('Harness run 已标记 done。', {
        detail: runDetail(next),
        files: [displayPath(paths, paths.harnessRun)],
        next: next.nextAction
      });
    },
    presentCall(args) {
      return presentCall('Harness · run state', 'read', args);
    }
  });
}
