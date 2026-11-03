/**
 * `dwguard_audit` — the independent delivery audit and its two exits.
 *
 * A passing audit writes the acceptance report; a failing one writes the rework
 * order and puts it on the outbox. There is no third exit: a partially verified
 * pack is a failure.
 *
 * @module dwguard-dsh-hmos/tools/audit
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import type { AestheticProfile } from '../aesthetic.js';
import { AREA_LABELS, findProfileEntry, readProfile, valueLabel } from '../aesthetic.js';
import { appendOutboxDsh } from '../dispatch.js';
import { appendCalibration, dimensionVerdicts } from '../calibration.js';
import { readCompareResults } from '../baseline.js';
import { collectDeviceEvidence } from '../device.js';
import { EvidenceError, missingEvidence, writeEvidenceBundle } from '../evidence.js';
import { DIMENSIONS, DIMENSION_LABELS, SCREEN_FAMILIES } from '../model.js';
import type { Check, TaskPack } from '../model.js';
import { displayPath } from '../paths.js';
import { clearAuditProgress } from '../progress.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import type { AestheticAuditRef, AestheticAuditSummary, AuditReport, CheckInput, FindingInput } from '../review.js';
import {
  applyAssertionVerdicts,
  gateDelivery,
  normalizeChecks,
  normalizeFindings,
  renderAcceptanceMarkdown,
  renderAuditMarkdown,
  renderReworkMarkdown,
  summarizeCoverage,
  summarizeDimensions
} from '../review.js';
import { ensureShared } from '../scaffold.js';
import { nextIndex, updateState } from '../state.js';
import { writeTextAtomic } from '../util/fs.js';
import { nowIso, table } from '../util/md.js';
import {
  arrayOfRecords,
  asRecord,
  optionalEnum,
  optionalString,
  optionalStringArray,
  requiredEnum,
  requiredString
} from './args.js';
import { pathsOf, requireSpec } from './common.js';

const TOOL = 'dwguard_audit';
const RESULTS = ['pass', 'fail', 'unverified'] as const;
const SEVERITIES = ['blocker', 'major', 'minor'] as const;
const REVIEW_DIMENSIONS = [...DIMENSIONS, 'architecture'] as const;
const FINDING_STATUSES = ['open', 'dismissed', 'fixed'] as const;

function parseChecks(raw: Record<string, unknown>): CheckInput[] {
  const rows = arrayOfRecords(raw, 'checks', TOOL, 128);
  if (rows.length === 0) {
    throw new Error(`${TOOL}: \`checks\` 不能为空；每条 must 判据都需要一条检查记录。`);
  }
  return rows.map((item, index) => {
    const label = `${TOOL}.checks[${index}]`;
    return {
      criterionId: requiredString(item, 'criterionId', label, 40),
      result: requiredEnum(item, 'result', RESULTS, label),
      evidence: optionalString(item, 'evidence', label, 2000) ?? '',
      note: optionalString(item, 'note', label, 600),
      evidenceFiles: optionalStringArray(item, 'evidenceFiles', label, 8),
      actual: optionalString(item, 'actual', label, 500),
      device: optionalString(item, 'device', label, 200),
      family: optionalEnum(item, 'family', SCREEN_FAMILIES, label),
      profileRef: optionalString(item, 'profileRef', label, 40)
    };
  });
}

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
      status: optionalEnum(item, 'status', FINDING_STATUSES, label)
    };
  });
}

function coverageLine(coverage: ReturnType<typeof summarizeCoverage>): string {
  const parts = [`must 判据 ${coverage.passed}/${coverage.total} 通过`];
  if (coverage.failed > 0) parts.push(`${coverage.failed} 未通过`);
  if (coverage.unverified > 0) parts.push(`${coverage.unverified} 未验证`);
  if (coverage.missing.length > 0) parts.push(`${coverage.missing.length} 未覆盖`);
  return parts.join(' · ');
}

/** Resolve every `profileRef` named by the pack/checks into a report entry. */
function collectAestheticRefs(
  pack: TaskPack,
  checks: readonly Check[],
  profile: AestheticProfile
): AestheticAuditRef[] {
  const refs = new Map<string, AestheticAuditRef>();
  const add = (criterionId: string, profileRef: string): void => {
    if (refs.has(profileRef)) return;
    const entry = findProfileEntry(profile, profileRef);
    refs.set(profileRef, {
      criterionId,
      profileRef,
      status: entry === undefined ? 'missing' : entry.status,
      ...(entry === undefined
        ? {}
        : { decision: entry.decision, area: AREA_LABELS[entry.area], value: valueLabel(entry.value) })
    });
  };
  for (const criterion of pack.criteria) {
    if (criterion.profileRef !== undefined && criterion.profileRef.length > 0) add(criterion.id, criterion.profileRef);
  }
  for (const check of checks) {
    if (check.profileRef !== undefined && check.profileRef.length > 0) add(check.criterionId, check.profileRef);
  }
  return [...refs.values()];
}

/**
 * Create the `dwguard_audit` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createAuditTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_audit',
    description:
      'Record the external delivery audit: one check per acceptance criterion with the evidence you gathered yourself (screenshot path, layout tree, log excerpt, measurement) plus any extra findings. ' +
      'The gate needs every must criterion checked, all four dimensions assessed, and no open blocker/major finding. ' +
      'Pass writes `artifacts/acceptance-report.md`; fail writes `tasks/rework-<n>.md` and appends it to the outbox. ' +
      '绝不把 DevEco Code 的自验证结论当作唯一依据。',
    parameters: {
      checks: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterionId: { type: 'string', required: true, description: '任务包里的判据 ID。' },
            result: {
              type: 'string',
              required: true,
              enum: [...RESULTS],
              description: 'pass / fail / unverified（unverified 不能用于 must 判据）。'
            },
            evidence: {
              type: 'string',
              required: true,
              description: '你独立取得的证据：命令输出、截图路径、布局树片段、测量数值。'
            },
            actual: {
              type: 'string',
              description:
                '实测值（可选但带 assertion 的判据必须给）：如 "12vp"、"720ms"、"4.9:1"。闸门用任务包里的 assertion 重算结论，断言不通过却标 pass 会被拒绝。'
            },
            device: { type: 'string', description: '取证设备序列号（matrix 模式必填）。' },
            family: {
              type: 'string',
              enum: [...SCREEN_FAMILIES],
              description: '屏幕族：phone / widefold / foldable / triplefold（matrix 模式必填）。'
            },
            profileRef: {
              type: 'string',
              description:
                '审美档案 ID（如 `AES-RADIUS-01`，0.6.1）。引用不存在或已 superseded 的档案会被闸门拒绝；档案值会渲染进审计与验收报告。'
            },
            evidenceFiles: {
              type: 'array',
              items: { type: 'string' },
              description:
                '支撑这条结论的文件，写相对 `.shared/` 的路径（截图 / 布局树 / 日志）。工具会校验存在、复制进 artifacts/audit-<n>/evidence/ 并记 sha256；文件缺失时整次审计不落盘。'
            },
            note: { type: 'string', description: '补充说明（可选）。' }
          }
        },
        description: '逐条判据的检查记录。'
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: '如 `R-01`。' },
            dimension: { type: 'string', required: true, enum: [...REVIEW_DIMENSIONS] },
            severity: { type: 'string', required: true, enum: [...SEVERITIES] },
            title: { type: 'string', required: true },
            evidence: { type: 'string', required: true },
            ruleId: { type: 'string', description: '如 `DW-A11Y-01`。' },
            criterionId: { type: 'string' },
            suggestion: { type: 'string' },
            status: {
              type: 'string',
              enum: [...FINDING_STATUSES],
              description: '默认 open；只有确实复核过才可置 fixed/dismissed。'
            }
          }
        },
        description: '判据之外的问题（可选）。'
      },
      note: { type: 'string', description: '审计说明：覆盖了哪些状态/机型/字体档。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const pack = await requireSpec(paths, options, TOOL);
      const policy = options.device;
      const profile = await readProfile(paths);
      const compares = await readCompareResults(paths, pack.specVersion);
      const checks = applyAssertionVerdicts(pack, normalizeChecks(parseChecks(args)));
      const findings = normalizeFindings(parseFindings(args));
      const note = optionalString(args, 'note', TOOL, 2000) ?? '';
      const now = nowIso();
      const id = await nextIndex(paths.artifactsDir, 'audit');
      const devices = collectDeviceEvidence(checks).map((device) => {
        const pooled = policy.pool.find((entry) => entry.sn === device.sn);
        return {
          sn: device.sn,
          family: device.family,
          ...(pooled?.apiLevel === undefined ? {} : { apiLevel: pooled.apiLevel }),
          ...(pooled?.kind === undefined ? {} : { kind: pooled.kind })
        };
      });

      // Evidence first: a check that names a file must prove the file exists,
      // and the bundle is written before any verdict can be recorded.
      try {
        const missing = await missingEvidence(paths, checks);
        if (missing.length > 0) {
          return fail(`证据文件不存在：${missing.join('、')}。本次审计未记录。`, {
            detail: missing.map((file) => `- \`${file}\``).join('\n'),
            next: '先把证据取到 `.shared/` 下，再重新调用 `dwguard_audit`。'
          });
        }
        await writeEvidenceBundle(paths, id, pack.specVersion, checks, now);
      } catch (error) {
        if (error instanceof EvidenceError) return fail(`证据路径非法：${error.message}`);
        throw error;
      }

      const baseGate = gateDelivery(pack, checks, findings, policy, profile);
      const failedCompares = compares.filter((compare) => !compare.pass);
      const gate =
        failedCompares.length === 0
          ? baseGate
          : {
              ...baseGate,
              warnings: [
                ...baseGate.warnings,
                ...failedCompares.map(
                  (compare) =>
                    `审美基线 compare 未通过（${compare.page} · ${compare.state}，${compare.rows.filter((row) => row.verdict === 'fail').length} 项超差）：若这是用户要求的新设计，需在用户确认后重建基线；否则按回归记为 finding。`
                )
              ]
            };
      const coverage = summarizeCoverage(pack, checks, policy);
      const dimensions = summarizeDimensions(pack, checks);
      const aestheticRefs = collectAestheticRefs(pack, checks, profile);
      const aesthetic: AestheticAuditSummary = {
        profileRefs: aestheticRefs,
        ...(compares.length === 0 ? {} : { compares })
      };
      const report: AuditReport = {
        id,
        stage: 'delivery',
        createdAt: now,
        specVersion: pack.specVersion,
        note,
        checks,
        findings,
        gate,
        coverage,
        dimensions,
        devices,
        aesthetic
      };

      await ensureShared(paths);
      await writeTextAtomic(
        `${paths.artifactsDir}/audit-${id}.md`,
        renderAuditMarkdown(report, pack, paths, policy, profile)
      );
      await writeTextAtomic(`${paths.artifactsDir}/audit-${id}.json`, `${JSON.stringify(report, null, 2)}\n`);
      // Calibration ledger: every gate verdict is a data point.
      await appendCalibration(paths, {
        kind: 'audit',
        at: now,
        specVersion: pack.specVersion,
        round: pack.iteration,
        auditId: id,
        pass: gate.pass,
        dimensions: dimensionVerdicts(pack, checks)
      });

      const dimTable = table(
        ['维度', '判据', '已取证', '通过'],
        dimensions.map((row) => [
          DIMENSION_LABELS[row.dimension],
          String(row.criteria),
          String(row.assessed),
          String(row.passed)
        ])
      );
      const files = [
        displayPath(paths, `${paths.artifactsDir}/audit-${id}.md`),
        displayPath(paths, `${paths.artifactsDir}/audit-${id}.json`),
        displayPath(paths, `${paths.artifactsDir}/audit-${id}/manifest.json`)
      ];
      const deviceLine =
        policy.mode === 'matrix'
          ? `设备矩阵：${policy.matrix.length} 族（${policy.matrix.join(' / ')}）· 并发上限 ${policy.maxConcurrency} · 本轮设备 ${devices.length} 台`
          : `设备：单机验证（主机内存 ${policy.hostMemoryGb}GB，< ${policy.matrixMinMemoryGb}GB 不启用矩阵）`;

      if (gate.pass) {
        const acceptance = renderAcceptanceMarkdown(report, pack, paths, policy, profile);
        await writeTextAtomic(`${paths.artifactsDir}/acceptance-report.md`, acceptance);
        await clearAuditProgress(paths);
        await updateState(paths, now, (current) => ({
          ...current,
          audits: current.audits + 1,
        roundAudits: (current.roundAudits ?? 0) + 1,
          phase: 'accepted'
        }));
        return ok(`审计 #${id} 通过：${coverageLine(coverage)}。`, {
          detail: [dimTable, '', deviceLine, '', acceptance].join('\n'),
          files: [...files, displayPath(paths, `${paths.artifactsDir}/acceptance-report.md`)],
          next: '把验收报告交给用户确认；确认后用 `dwguard_knowledge` 沉淀本轮经验，再开始下一轮需求。'
        });
      }

      const reworkPath = `${paths.tasksDir}/rework-${id}.md`;
      const rework = renderReworkMarkdown(report, pack, paths);
      await writeTextAtomic(reworkPath, rework);
      await appendOutboxDsh(
        paths,
        `rework #${id} · 审计未通过`,
        `${gate.errors.map((error) => `- ${error}`).join('\n')}\n\n返工单：\`${displayPath(paths, reworkPath)}\``,
        now,
        { kind: 'rework', id: `r-${id}`, from: 'dsh', to: 'deveco' }
      );
      await clearAuditProgress(paths);
      await updateState(paths, now, (current) => ({
        ...current,
        audits: current.audits + 1,
        roundAudits: (current.roundAudits ?? 0) + 1,
        phase: 'rework'
      }));
      return fail(`审计 #${id} 未通过：${gate.errors.length} 条闸门问题。`, {
        detail: [dimTable, '', deviceLine, '', rework].join('\n'),
        files: [...files, displayPath(paths, reworkPath)],
        next: '把返工单交给 DevEco Code（或让它在 Goal 模式读该文件），修完再 `dwguard_audit`。'
      });
    },
    presentCall(args) {
      return presentCall('Audit · 外部验收', 'other', args);
    }
  });
}
