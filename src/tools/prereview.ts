/**
 * `dwguard_prereview` — the adversarial pre-dispatch review record.
 *
 * @module dwguard-dsh-hmos/tools/prereview
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { DIMENSIONS, DIMENSION_LABELS } from '../model.js';
import type { Severity } from '../model.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import type { FindingInput, PrereviewReport } from '../review.js';
import { gatePrereview, normalizeFindings, renderPrereviewMarkdown } from '../review.js';
import { ensureShared } from '../scaffold.js';
import { nextIndex, updateState } from '../state.js';
import { writeTextAtomic } from '../util/fs.js';
import { nowIso, table } from '../util/md.js';
import {
  arrayOfRecords,
  asRecord,
  optionalEnum,
  optionalString,
  requiredEnum,
  requiredString
} from './args.js';
import { pathsOf, requireSpec } from './common.js';

const TOOL = 'dwguard_prereview';
const REVIEW_DIMENSIONS = [...DIMENSIONS, 'architecture'] as const;
const SEVERITIES = ['blocker', 'major', 'minor'] as const;
const STATUSES = ['open', 'dismissed', 'fixed'] as const;

function parseFindings(raw: Record<string, unknown>): FindingInput[] {
  if (raw['findings'] === undefined || raw['findings'] === null) return [];
  const rows = arrayOfRecords(raw, 'findings', TOOL, 48);
  return rows.map((item, index) => {
    const label = `${TOOL}.findings[${index}]`;
    return {
      id: optionalString(item, 'id', label, 40),
      dimension: requiredEnum(item, 'dimension', REVIEW_DIMENSIONS, label),
      severity: requiredEnum(item, 'severity', SEVERITIES, label),
      title: requiredString(item, 'title', label, 200),
      evidence: requiredString(item, 'evidence', label, 2000),
      ruleId: optionalString(item, 'ruleId', label, 60),
      criterionId: optionalString(item, 'criterionId', label, 40),
      suggestion: optionalString(item, 'suggestion', label, 600),
      rebuttal: optionalString(item, 'rebuttal', label, 600),
      status: optionalEnum(item, 'status', STATUSES, label)
    };
  });
}

/**
 * Create the `dwguard_prereview` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createPrereviewTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_prereview',
    description:
      'Record the pre-dispatch adversarial review of the task pack: findings from the performance / lifecycle / concurrency / API-compatibility / acceptance-feasibility perspectives. ' +
      'Every blocker must carry the rebuttal you attempted against it; findings without evidence are rejected. ' +
      'A passing pre-review is required before `dwguard_dispatch`. 写入 `artifacts/prereview-<n>.md`。',
    parameters: {
      note: {
        type: 'string',
        description: '审阅范围：读了哪些文件、覆盖哪些视角。零发现时必填（≥12 字）。'
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: '如 `R-01`；省略时自动编号。' },
            dimension: {
              type: 'string',
              required: true,
              enum: [...REVIEW_DIMENSIONS],
              description: 'architecture 或四维之一。'
            },
            severity: { type: 'string', required: true, enum: [...SEVERITIES] },
            title: { type: 'string', required: true, description: '一句话问题。' },
            evidence: {
              type: 'string',
              required: true,
              description: '具体失败场景 / 日志 / 代码位置（≥8 字）。'
            },
            ruleId: { type: 'string', description: '规则 ID，如 `DW-PERF-02`。' },
            criterionId: { type: 'string', description: '关联的验收判据 ID。' },
            suggestion: { type: 'string', description: 'ArkUI / 架构修改建议。' },
            rebuttal: {
              type: 'string',
              description: '你对这条发现的反驳尝试；blocker 必填（≥8 字）。'
            },
            status: {
              type: 'string',
              enum: [...STATUSES],
              description: '默认 open；已在任务包修正记 fixed，用户确认不在本轮范围记 dismissed。'
            }
          }
        },
        description: '发现列表；可以为零，但要用 note 说明审阅范围。'
      }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const pack = await requireSpec(paths, options, TOOL);
      const note = optionalString(args, 'note', TOOL, 2000) ?? '';
      const findings = normalizeFindings(parseFindings(args));
      const gate = gatePrereview(findings, note, options);
      const now = nowIso();
      const id = await nextIndex(paths.artifactsDir, 'prereview');
      const report: PrereviewReport = {
        id,
        stage: 'prereview',
        createdAt: now,
        specVersion: pack.specVersion,
        note,
        findings,
        gate
      };

      await ensureShared(paths);
      await writeTextAtomic(`${paths.artifactsDir}/prereview-${id}.md`, renderPrereviewMarkdown(report, pack, paths));
      await writeTextAtomic(`${paths.artifactsDir}/prereview-${id}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await updateState(paths, now, (current) => ({
        ...current,
        prereviews: current.prereviews + 1,
        phase: gate.pass ? 'ready' : 'prereview'
      }));

      const rows = findings.map((finding) => [
        `\`${finding.id}\``,
        finding.dimension === 'architecture' ? '架构' : DIMENSION_LABELS[finding.dimension],
        finding.severity,
        finding.title,
        finding.rebuttal === undefined ? '—' : '已反驳'
      ]);
      const detail = [
        countSeverities(findings),
        '',
        findings.length === 0 ? '本轮零发现。' : table(['ID', '视角', '严重度', '问题', '反驳'], rows),
        '',
        ...gate.errors.map((error) => `- **未通过** ${error}`),
        ...gate.warnings.map((warning) => `- 提醒 ${warning}`)
      ]
        .join('\n')
        .trim();
      const files = [
        displayPath(paths, `${paths.artifactsDir}/prereview-${id}.md`),
        displayPath(paths, `${paths.artifactsDir}/prereview-${id}.json`)
      ];
      return gate.pass
        ? ok(`预审 #${id} 通过（${findings.length} 条发现，阻断已清零）。`, {
            detail,
            files,
            next: '用 `dwguard_dispatch` 生成 Goal 模式简报并派发给 DevEco Code。'
          })
        : fail(`预审 #${id} 未通过：${gate.errors.length} 条闸门问题。`, {
            detail,
            files,
            next: '修订任务包或关闭阻断项后重跑 `dwguard_prereview`；未通过不得派发。'
          });
    },
    presentCall(args) {
      return presentCall('Pre-review · 派发前对抗审查', 'other', args);
    }
  });
}

function countSeverities(findings: readonly { severity: Severity }[]): string {
  const blocker = findings.filter((finding) => finding.severity === 'blocker').length;
  const major = findings.filter((finding) => finding.severity === 'major').length;
  const minor = findings.filter((finding) => finding.severity === 'minor').length;
  return `发现 ${findings.length} 条：阻断 ${blocker} / 严重 ${major} / 轻微 ${minor}`;
}
