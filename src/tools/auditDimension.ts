/**
 * `dwguard_audit_dimension` — record one audit dimension as its sub-agent returns.
 *
 * The four dimensions are audited in parallel by four sub-agents; this tool is
 * the point where a finished one becomes visible, so the panel can light the
 * cards up one by one instead of all at once.
 *
 * @module dwguard-dsh-hmos/tools/audit-dimension
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { DIMENSIONS, DIMENSION_LABELS } from '../model.js';
import { displayPath } from '../paths.js';
import { ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { recordDimension } from '../progress.js';
import { ensureShared } from '../scaffold.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalString, requiredEnum, requiredInt } from './args.js';
import { pathsOf, requireSpec } from './common.js';

const TOOL = 'dwguard_audit_dimension';

/**
 * Create the per-dimension audit progress tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createAuditDimensionTool(
  options: Options,
  ctx?: PluginContext
): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_audit_dimension',
    description:
      'Record one of the four audit dimensions the moment its sub-agent returns, before the whole audit is ready. ' +
      'Give the dimension, how many criteria passed and failed, and an optional one-line note. ' +
      '每返回一个维度就调一次，DshHoms 面板上的四张子代理卡会逐张落地；四维齐全后再用 `dwguard_audit` 汇总过闸门。',
    parameters: {
      dimension: {
        type: 'string',
        required: true,
        enum: [...DIMENSIONS],
        description: 'function / aesthetic / performance / accessibility。'
      },
      passed: { type: 'integer', required: true, description: '这一维通过的判据数。' },
      failed: { type: 'integer', required: true, description: '这一维未通过的判据数（没有就填 0）。' },
      note: { type: 'string', description: '一句话结论（可选），显示在卡片说明里。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const pack = await requireSpec(paths, options, TOOL);
      const dimension = requiredEnum(args, 'dimension', DIMENSIONS, TOOL);
      const passed = requiredInt(args, 'passed', TOOL, 500);
      const failed = requiredInt(args, 'failed', TOOL, 500);
      const note = optionalString(args, 'note', TOOL, 200);
      const now = nowIso();

      await ensureShared(paths);
      const progress = await recordDimension(paths, pack.specVersion, dimension, passed, failed, note, now);
      const returned = DIMENSIONS.filter((key) => progress.dims[key] !== undefined);
      const remaining = DIMENSIONS.filter((key) => progress.dims[key] === undefined);
      const lines = [
        `- \`${dimension}\`（${DIMENSION_LABELS[dimension]}）：${passed} 通过 / ${failed} 未过${note === undefined ? '' : ` · ${note}`}`,
        `- 已返回 ${returned.length}/4：${returned.map((key) => DIMENSION_LABELS[key]).join('、')}`,
        remaining.length > 0 ? `- 等待：${remaining.map((key) => DIMENSION_LABELS[key]).join('、')}` : ''
      ].filter((line) => line.length > 0);

      return ok(`${DIMENSION_LABELS[dimension]}子代理已返回（${passed} 通过 / ${failed} 未过），进度 ${returned.length}/4。`, {
        detail: lines.join('\n'),
        files: [displayPath(paths, paths.auditProgress)],
        next:
          remaining.length > 0
            ? `继续等其余 ${remaining.length} 个维度的子代理；每回来一个就记一次。`
            : '四维都回来了，用 `dwguard_audit` 汇总 checks 并过闸门。'
      });
    },
    presentCall(args) {
      return presentCall('Audit · 维度返回', 'other', args);
    }
  });
}
