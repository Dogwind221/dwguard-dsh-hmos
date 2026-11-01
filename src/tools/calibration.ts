/**
 * `dwguard_calibration` — the gate's accuracy ledger.
 *
 * `report` aggregates every audit/confirm/miss record into per-dimension
 * "audited / failed / missed / miss-rate" rows. `miss` records the case that
 * matters: the gate said pass, but the user later found a problem. Without this,
 * the framework can only claim rigor; with it, it can show whether the gate
 * actually catches things.
 *
 * @module dwguard-dsh-hmos/tools/calibration
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { appendCalibration, describeRow, readCalibration, summariseCalibration } from '../calibration.js';
import { DIMENSIONS, DIMENSION_LABELS } from '../model.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { collectSnapshot } from '../status.js';
import { nowIso, table } from '../util/md.js';
import { asRecord, optionalString, requiredEnum } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_calibration';
const ACTIONS = ['report', 'miss'] as const;

/**
 * Create the `dwguard_calibration` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createCalibrationTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_calibration',
    description:
      'Gate accuracy ledger. `report` aggregates audits/confirmations/misses into per-dimension miss rates; `miss` records "audit passed but the user later found a bug" for one dimension, which is the only way to know whether the gate is trustworthy. ' +
      '每轮审计/确认都会自动记账；用户后来发现问题时用 `miss` 补一笔，`report` 看四维漏检率。',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'report / miss。' },
      dimension: {
        type: 'string',
        enum: [...DIMENSIONS],
        description: '`miss`：出问题的维度。'
      },
      note: { type: 'string', description: '`miss`：用户反馈或证据（可选）。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const action = requiredEnum(args, 'action', ACTIONS, TOOL);

      if (action === 'report') {
        const records = await readCalibration(paths);
        const rows = summariseCalibration(records);
        const audits = records.filter((record) => record.kind === 'audit').length;
        const confirms = records.filter((record) => record.kind === 'confirm').length;
        const misses = records.filter((record) => record.kind === 'miss').length;
        const detail = [
          `账本：\`${displayPath(paths, paths.calibration)}\``,
          '',
          table(
            ['维度', '审计', '未过', '漏检', '漏检率'],
            rows.map((row) => [
              DIMENSION_LABELS[row.dimension],
              String(row.audits),
              String(row.failedAudits),
              String(row.misses),
              row.missRate === null ? '—' : `${Math.round(row.missRate * 100)}%`
            ])
          ),
          '',
          rows.map(describeRow).join('\n'),
          '',
          audits === 0 ? '还没有审计记录：先跑一轮 `dwguard_audit`。' : '',
          audits > 0 && audits < 5 ? '样本不足 5 次，漏检率只作参考。' : ''
        ]
          .filter((line) => line.length > 0)
          .join('\n');
        return ok(`闸门账本：审计 ${audits} 次 · 确认 ${confirms} 次 · 漏检 ${misses} 次`, {
          detail,
          files: [displayPath(paths, paths.calibration)],
          next:
            misses === 0
              ? '继续累计；当用户后续反馈问题时用 `dwguard_calibration --action miss` 记账。'
              : '看一下漏检集中在哪个维度，把对应规则补进 `dwguard_rules` 目录。'
        });
      }

      // miss
      const dimension = requiredEnum(args, 'dimension', DIMENSIONS, TOOL);
      const note = optionalString(args, 'note', TOOL, 600) ?? '';
      const now = nowIso();
      const snapshot = await collectSnapshot(paths, options, now);
      if (snapshot.spec === null) return fail('还没有任务包，无法记录漏检。', { next: '先写任务包并完成审计。' });
      if (snapshot.audit === null || !snapshot.audit.value.gate.pass) {
        return fail('当前任务包没有"审计通过"的记录，无法标记漏检。', {
          next: '漏检只针对"判定通过、但后来发现有问题"的场景。'
        });
      }
      await appendCalibration(paths, {
        kind: 'miss',
        at: now,
        specVersion: snapshot.spec.specVersion,
        round: snapshot.spec.iteration,
        auditId: snapshot.audit.index,
        dimension,
        ...(note.length === 0 ? {} : { note })
      });
      return ok(`已记录漏检：${DIMENSION_LABELS[dimension]}（任务包 v${snapshot.spec.specVersion}，审计 #${snapshot.audit.index}）`, {
        detail: [
          `- 维度：${DIMENSION_LABELS[dimension]}`,
          note.length === 0 ? '' : `- 说明：${note}`,
          `- 账本：\`${displayPath(paths, paths.calibration)}\``
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
        next: '用 `dwguard_knowledge` 把这条教训沉淀下来；下次判据要能覆盖它。'
      });
    },
    presentCall(args) {
      return presentCall('DwGuard · 闸门校准', 'read', args);
    }
  });
}
