/**
 * `dwguard_confirm` — record the user's decision on an acceptance report.
 *
 * The framework's last diamond is "用户确认完成，还是提新要求？". Without a record
 * that is only chat text; this tool writes `artifacts/confirmation-<n>.json`,
 * stamps the user decision into `state.json`, and (for `new_round`) bumps the
 * iteration so the next `dwguard_spec` starts the next round.
 *
 * @module dwguard-dsh-hmos/tools/confirm
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendCalibration } from '../calibration.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { nextIndex, updateState } from '../state.js';
import { collectSnapshot } from '../status.js';
import { ensureShared } from '../scaffold.js';
import { fileExists, writeTextAtomic } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalString, requiredEnum } from './args.js';
import { pathsOf } from './common.js';
const TOOL = 'dwguard_confirm';
const DECISIONS = ['accept', 'new_round'];
/**
 * Create the `dwguard_confirm` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createConfirmTool(options, ctx) {
    return defineTool({
        name: 'dwguard_confirm',
        description: 'Record the user decision on a finished round: `accept` confirms the acceptance report (round done), `new_round` confirms and bumps the iteration so the next `dwguard_spec` starts a new round. ' +
            '需要已有通过的审计与 `artifacts/acceptance-report.md`；用户确认不再是聊天里的一句话，而是 `artifacts/confirmation-<n>.json` + state。',
        parameters: {
            decision: {
                type: 'string',
                required: true,
                enum: [...DECISIONS],
                description: 'accept = 确认完成；new_round = 确认并开下一轮。'
            },
            note: { type: 'string', description: '用户原话或补充说明（可选）。' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            const decision = requiredEnum(args, 'decision', DECISIONS, TOOL);
            const note = optionalString(args, 'note', TOOL, 1000) ?? '';
            const now = nowIso();
            const snapshot = await collectSnapshot(paths, options, now);
            if (snapshot.spec === null)
                return fail('还没有任务包，无法确认。', { next: '先用 `dwguard_spec` 写任务包。' });
            if (snapshot.audit === null || !snapshot.audit.value.gate.pass) {
                return fail('还没有通过的审计，不能确认。', {
                    next: '先完成 `dwguard_audit`（四维通过）并生成验收报告。'
                });
            }
            const report = `${paths.artifactsDir}/acceptance-report.md`;
            if (!(await fileExists(report))) {
                return fail('找不到 `artifacts/acceptance-report.md`。', { next: '重新跑一次通过的 `dwguard_audit`。' });
            }
            await ensureShared(paths);
            const index = await nextIndex(paths.artifactsDir, 'confirmation');
            const record = {
                schemaVersion: 1,
                index,
                createdAt: now,
                decision,
                note,
                specVersion: snapshot.spec.specVersion,
                iteration: snapshot.spec.iteration,
                auditId: snapshot.audit.index,
                auditPass: snapshot.audit.value.gate.pass
            };
            const file = `${paths.artifactsDir}/confirmation-${index}.json`;
            await writeTextAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
            await appendCalibration(paths, {
                kind: 'confirm',
                at: now,
                specVersion: snapshot.spec.specVersion,
                round: snapshot.spec.iteration,
                auditId: snapshot.audit.index,
                decision,
                ...(note.length === 0 ? {} : { note })
            });
            await updateState(paths, now, (current) => ({
                ...current,
                confirmations: (current.confirmations ?? 0) + 1,
                confirmedAt: now,
                confirmedSpecVersion: snapshot.spec?.specVersion ?? current.confirmedSpecVersion ?? 0,
                ...(decision === 'new_round' ? { iteration: current.iteration + 1, phase: 'intake' } : { phase: 'accepted' })
            }));
            const nextIteration = snapshot.spec.iteration + 1;
            return ok(decision === 'accept'
                ? `用户确认完成（第 ${snapshot.spec.iteration} 轮，任务包 v${snapshot.spec.specVersion}）。`
                : `用户确认并开下一轮：迭代号 → ${nextIteration}。`, {
                detail: [
                    `- 决定：${decision === 'accept' ? '确认完成' : '确认并开下一轮'}`,
                    `- 记录：\`${displayPath(paths, file)}\``,
                    `- 审计：#${snapshot.audit.index}（通过）· 任务包 v${snapshot.spec.specVersion}`,
                    note.length > 0 ? `- 备注：${note}` : ''
                ]
                    .filter((line) => line.length > 0)
                    .join('\n'),
                files: [displayPath(paths, file), displayPath(paths, report)],
                next: decision === 'accept'
                    ? '本轮结束；如本轮有用户确认过的审美取舍，用 `dwguard_aesthetic` 的 `learn` 记录（用户确认后再 apply），下一轮用 `profileRef` 引用。'
                    : `用 \`dwguard_spec\` 写第 ${nextIteration} 轮任务包（迭代号已自动 +1）；本轮审美取舍可先 \`learn\` 记账。`
            });
        },
        presentCall(args) {
            return presentCall('DwGuard · 用户确认', 'edit', args);
        }
    });
}
