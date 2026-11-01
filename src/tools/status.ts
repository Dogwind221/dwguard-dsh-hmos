/**
 * `dwguard_status` — where the round stands and what to do next.
 *
 * @module dwguard-dsh-hmos/tools/status
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { displayPath } from '../paths.js';
import { ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { collectSnapshot, phaseLabel, renderStatusMarkdown } from '../status.js';
import { updateState } from '../state.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalBoolean } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_status';

/** Wait until a new delivery appears or the timeout expires. */
async function waitForDelivery(
  paths: Parameters<typeof collectSnapshot>[0],
  options: Options,
  seconds: number,
  initial: Awaited<ReturnType<typeof collectSnapshot>>
): Promise<Awaited<ReturnType<typeof collectSnapshot>>> {
  if (seconds <= 0 || initial.unread.length > 0) return initial;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const next = await collectSnapshot(paths, options, nowIso());
    if (next.unread.length > 0) return next;
  }
  return initial;
}

/**
 * Create the `dwguard_status` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createStatusTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_status',
    description:
      'Show the DwGuard round status: derived phase, task-pack validation gaps, latest pre-review and audit gates, unread DevEco delivery records from `outbox-deveco.md`, and the one next action. ' +
      'Pass markInboxRead=true to move the delivery cursor past the records just shown. 每轮开工、DevEco 交付后、返工前都先跑一次。',
    parameters: {
      markInboxRead: {
        type: 'boolean',
        description: '把这些交付记录标记为已读（游标前移）。默认 false。'
      },
      waitSeconds: {
        type: 'number',
        description: '长轮询等待新交付的秒数（0–120，默认 0）。相当于订阅一次“交付事件”。'
      }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const markRead = optionalBoolean(args, 'markInboxRead', false);
      const waitRaw = args['waitSeconds'];
      const waitSeconds =
        typeof waitRaw === 'number' && Number.isFinite(waitRaw) && waitRaw > 0 ? Math.min(120, Math.trunc(waitRaw)) : 0;
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const now = nowIso();
      const initial = await collectSnapshot(paths, options, now);
      const snapshot = await waitForDelivery(paths, options, waitSeconds, initial);
      if (markRead && snapshot.outboxEntries.length > snapshot.state.inboxCursor) {
        await updateState(paths, now, (current) => ({
          ...current,
          inboxCursor: snapshot.outboxEntries.length
        }));
      }
      return ok(
        `${phaseLabel(snapshot.phase)}${snapshot.unread.length > 0 ? ` · ${snapshot.unread.length} 条未读交付` : ''}`,
        {
          detail: renderStatusMarkdown(snapshot),
          files: [displayPath(paths, paths.shared)],
          next: snapshot.nextAction
        }
      );
    },
    presentCall(args) {
      return presentCall('DwGuard · 状态', 'read', args);
    }
  });
}
