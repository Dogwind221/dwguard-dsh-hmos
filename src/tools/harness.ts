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
  closeHarness,
  failHarness,
  fallbackHarness,
  HARNESS_FALLBACK_CHAIN,
  readHarnessSnapshot,
  resumeHarness,
  retryHarness,
  type HarnessRun
} from '../harness.js';
import { displayPath } from '../paths.js';
import { ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalInt, optionalString, optionalStringArray, requiredEnum, requiredString } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_harness';
const ACTIONS = ['status', 'checkpoint', 'resume', 'retry', 'fail', 'fallback', 'close'] as const;

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
      'Cross-session run journal for the DwGuard protocol: `status` / `checkpoint` / `resume` / `retry` / `fail` / `fallback` / `close`. ' +
      'Stores checkpoints, attempt counts, last error and fallback level in `.shared/harness/run.json`; `resume` tells the next session where to continue. ' +
      'App-side AI and mobile development runtimes are out of scope.',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'status / checkpoint / resume / retry / fail / fallback / close。' },
      step: { type: 'string', description: 'checkpoint/retry/fail/fallback 的步骤名，如 `pipeline` / `audit`。' },
      note: { type: 'string', description: 'checkpoint 的说明（可选）。' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'checkpoint 的证据路径（可选）。' },
      error: { type: 'string', description: 'retry/fail 的错误摘要（可选）。' },
      level: { type: 'number', description: 'fallback 档位（1=devecocli，2=deveco-mcp，3=hdc+hvigor；默认 1）。' }
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
