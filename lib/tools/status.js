/**
 * `dwguard_status` — where the round stands and what to do next.
 *
 * @module dwguard-dsh-hmos/tools/status
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { displayPath } from '../paths.js';
import { ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { collectSnapshot, phaseLabel, renderStatusMarkdown } from '../status.js';
import { updateState } from '../state.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalBoolean } from './args.js';
import { pathsOf } from './common.js';
const TOOL = 'dwguard_status';
/**
 * Create the `dwguard_status` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createStatusTool(options, ctx) {
    return defineTool({
        name: 'dwguard_status',
        description: 'Show the DwGuard round status: derived phase, task-pack validation gaps, latest pre-review and audit gates, unread DevEco delivery records from `outbox-deveco.md`, and the one next action. ' +
            'Pass markInboxRead=true to move the delivery cursor past the records just shown. 每轮开工、DevEco 交付后、返工前都先跑一次。',
        parameters: {
            markInboxRead: {
                type: 'boolean',
                description: '把这些交付记录标记为已读（游标前移）。默认 false。'
            }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const markRead = optionalBoolean(args, 'markInboxRead', false);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            const now = nowIso();
            const snapshot = await collectSnapshot(paths, options, now);
            if (markRead && snapshot.outboxEntries.length > snapshot.state.inboxCursor) {
                await updateState(paths, now, (current) => ({
                    ...current,
                    inboxCursor: snapshot.outboxEntries.length
                }));
            }
            return ok(`${phaseLabel(snapshot.phase)}${snapshot.unread.length > 0 ? ` · ${snapshot.unread.length} 条未读交付` : ''}`, {
                detail: renderStatusMarkdown(snapshot),
                files: [displayPath(paths, paths.shared)],
                next: snapshot.nextAction
            });
        },
        presentCall(args) {
            return presentCall('DwGuard · 状态', 'read', args);
        }
    });
}
