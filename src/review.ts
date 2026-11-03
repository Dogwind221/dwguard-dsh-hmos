/**
 * The gate engine: pre-review and delivery audit rules, plus the markdown the
 * workflow leaves behind (pre-review record, audit record, rework order,
 * acceptance report).
 *
 * The rules are deliberately mechanical. The one thing this plugin must never
 * do is accept "the executor says it is done": every `must` criterion needs a
 * check with its own evidence, or the gate stays closed.
 *
 * @module dwguard-dsh-hmos/review
 */

import type { Options } from './config.js';
import type {
  Check,
  CheckResult,
  Criterion,
  CriterionAssertion,
  DeviceEvidence,
  Dimension,
  Finding,
  ReviewDimension,
  ScreenFamily,
  Severity,
  TaskPack
} from './model.js';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  SCREEN_FAMILY_LABELS
} from './model.js';
import type { DeviceConfig } from './device.js';
import { matrixFamilies } from './device.js';
import type { AestheticProfile } from './aesthetic.js';
import { AREA_LABELS, findProfileEntry, valueLabel } from './aesthetic.js';
import type { BaselineCompareResult } from './baseline.js';
import { renderCompareMarkdown } from './baseline.js';
import type { DesignCard } from './design.js';
import { designCardTokenSummary } from './design.js';
import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { isKnownRuleId } from './rules.js';
import { assertionLabel } from './spec.js';
import { bullets, inline, table, truncate } from './util/md.js';

/** Model-supplied finding. */
export interface FindingInput {
  readonly id?: string;
  readonly dimension: ReviewDimension;
  readonly severity: Severity;
  readonly title: string;
  readonly evidence: string;
  readonly ruleId?: string;
  readonly criterionId?: string;
  readonly suggestion?: string;
  readonly rebuttal?: string;
  readonly status?: 'open' | 'dismissed' | 'fixed';
}

/** Model-supplied check. */
export interface CheckInput {
  readonly criterionId: string;
  readonly result: CheckResult;
  readonly evidence: string;
  readonly note?: string;
  readonly evidenceFiles?: readonly string[];
  /** Measured value for a criterion that carries an `assertion`. */
  readonly actual?: string;
  /** Device serial the evidence was taken on. */
  readonly device?: string;
  /** Screen family the device belongs to. */
  readonly family?: ScreenFamily;
  /** Aesthetic-profile entry this check measured against (0.6.1). */
  readonly profileRef?: string;
  /** Design-library cards this check compared against (0.6.2). */
  readonly designRefs?: readonly string[];
}

/** Gate outcome. */
export interface Gate {
  readonly pass: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Coverage summary of one delivery audit. */
export interface Coverage {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly unverified: number;
  readonly missing: readonly string[];
}

/** One dimension's row in the audit table. */
export interface DimensionSummary {
  readonly dimension: Dimension;
  readonly criteria: number;
  readonly assessed: number;
  readonly passed: number;
}

/** A persisted pre-review record. */
export interface PrereviewReport {
  readonly id: number;
  readonly stage: 'prereview';
  readonly createdAt: string;
  readonly specVersion: number;
  readonly note: string;
  readonly findings: readonly Finding[];
  readonly gate: Gate;
}

/** One profile reference recorded by an audit. */
export interface AestheticAuditRef {
  readonly criterionId: string;
  readonly profileRef: string;
  readonly status: 'active' | 'missing' | 'superseded';
  readonly decision?: string;
  readonly area?: string;
  readonly value?: string;
}

/** One design reference recorded by an audit (0.6.2 P2). */
export interface DesignAuditRef {
  readonly criterionId: string;
  readonly designRef: string;
  readonly status: 'active' | 'blocked' | 'missing';
  readonly title?: string;
  readonly license?: string;
  readonly tokens?: string;
}

/** Aesthetic evidence attached to an audit report (0.6.1). */
export interface AestheticAuditSummary {
  readonly profileRefs: readonly AestheticAuditRef[];
  /** Baseline comparisons recorded for this pack version (one per page/state). */
  readonly compares?: readonly BaselineCompareResult[];
}

/** Design evidence attached to an audit report (0.6.2 P2). */
export interface DesignAuditSummary {
  readonly refs: readonly DesignAuditRef[];
}

/** A persisted delivery audit. */
export interface AuditReport {
  readonly id: number;
  readonly stage: 'delivery';
  readonly createdAt: string;
  readonly specVersion: number;
  readonly note: string;
  readonly checks: readonly Check[];
  readonly findings: readonly Finding[];
  readonly gate: Gate;
  readonly coverage: Coverage;
  readonly dimensions: readonly DimensionSummary[];
  /** Devices referenced by this audit (matrix mode), in first-seen order. */
  readonly devices?: readonly DeviceEvidence[];
  /** Aesthetic profile refs and baseline diff (0.6.1). */
  readonly aesthetic?: AestheticAuditSummary;
  /** Design reference cards named by this audit (0.6.2 P2). */
  readonly design?: DesignAuditSummary;
}

const SELF_REPORT_MARKERS = ['自测通过', '自认为', '开发者确认', 'deveco 已确认', '应该没问题', '目测没问题', '看起来正常'];

/** Duplicate-detection key: one verdict per criterion (single) or per criterion+family (matrix). */
function checkKey(check: Check, policy?: DeviceConfig): string {
  return policy?.mode === 'matrix' ? `${check.criterionId}::${check.family ?? '?'}` : check.criterionId;
}

const SEVERITY_LABELS: Record<Severity, string> = {
  blocker: '阻断',
  major: '严重',
  minor: '轻微'
};

const RESULT_LABELS: Record<CheckResult, string> = {
  pass: '通过',
  fail: '未通过',
  unverified: '未验证'
};

/** Rebuild canonical findings from model input, numbering untitled ids. */
export function normalizeFindings(input: readonly FindingInput[]): Finding[] {
  return input.map((item, index) => {
    const finding: Finding = {
      id: inline(item.id ?? '') || `R-${String(index + 1).padStart(2, '0')}`,
      dimension: item.dimension,
      severity: item.severity,
      title: inline(item.title),
      evidence: inline(item.evidence),
      status: item.status ?? 'open',
      ...(item.ruleId === undefined ? {} : { ruleId: inline(item.ruleId) }),
      ...(item.criterionId === undefined ? {} : { criterionId: inline(item.criterionId) }),
      ...(item.suggestion === undefined ? {} : { suggestion: inline(item.suggestion) }),
      ...(item.rebuttal === undefined ? {} : { rebuttal: inline(item.rebuttal) })
    };
    if (finding.ruleId !== undefined && !isKnownRuleId(finding.ruleId)) {
      throw new Error(
        `发现 ${finding.id} 引用了未知规则「${finding.ruleId}」；请改用规则目录里的 ID（DW-* / STATE-002 / AGC-RJ-* 等）。`
      );
    }
    return finding;
  });
}

/** Rebuild canonical checks from model input. */
export function normalizeChecks(input: readonly CheckInput[]): Check[] {
  return input.map((item) => ({
    criterionId: inline(item.criterionId),
    result: item.result,
    evidence: inline(item.evidence),
    ...(item.note === undefined ? {} : { note: inline(item.note) }),
    ...(item.actual === undefined || item.actual.trim().length === 0 ? {} : { actual: item.actual.trim() }),
    ...(item.device === undefined || item.device.trim().length === 0 ? {} : { device: item.device.trim() }),
    ...(item.family === undefined ? {} : { family: item.family }),
    ...(item.profileRef === undefined || item.profileRef.trim().length === 0
      ? {}
      : { profileRef: item.profileRef.trim() }),
    ...(item.designRefs === undefined || item.designRefs.length === 0
      ? {}
      : { designRefs: [...new Set(item.designRefs.map((ref) => ref.trim()).filter((ref) => ref.length > 0))] }),
    ...(item.evidenceFiles === undefined || item.evidenceFiles.length === 0
      ? {}
      : { evidenceFiles: [...new Set(item.evidenceFiles.map((file) => file.trim()).filter((file) => file.length > 0))] })
  }));
}

function looksSelfReported(evidence: string): boolean {
  const lower = evidence.toLowerCase();
  return SELF_REPORT_MARKERS.some((marker) => lower.includes(marker));
}

/** Machine verdict of one criterion assertion against the measured value. */
export interface AssertionEvaluation {
  readonly verdict: 'pass' | 'fail';
  readonly reason: string;
}

function firstNumber(value: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  return match === null ? undefined : Number(match[0]);
}

/**
 * Recompute a criterion assertion from the measured `actual` value.
 *
 * Numeric matchers read the first number in `actual` (`"12vp"` → 12,
 * `"720ms"` → 720), so measurements can keep their unit in the evidence text.
 *
 * @param assertion - the frozen expectation from the task pack.
 * @param actual - the measured value the auditor supplied.
 * @returns the recomputed verdict and the comparison that produced it.
 */
export function evaluateAssertion(assertion: CriterionAssertion, actual: string): AssertionEvaluation {
  const measured = actual.trim();
  const expected = Array.isArray(assertion.expected)
    ? assertion.expected.map((item) => String(item))
    : assertion.expected === undefined
      ? undefined
      : [String(assertion.expected)];
  const numeric = firstNumber(measured);
  const pass = (reason: string): AssertionEvaluation => ({ verdict: 'pass', reason });
  const fail = (reason: string): AssertionEvaluation => ({ verdict: 'fail', reason });
  const wanted = expected === undefined ? '' : (expected[0] ?? '');

  switch (assertion.matcher) {
    case 'present':
      return measured.length === 0
        ? fail('actual 为空，不满足 present')
        : pass(`actual「${truncate(measured, 40)}」非空`);
    case 'equals': {
      if (numeric !== undefined) {
        const expectedNumber = firstNumber(wanted);
        if (expectedNumber !== undefined && expectedNumber === numeric) {
          return pass(`actual ${numeric} = expected ${expectedNumber}`);
        }
      }
      return measured === wanted.trim()
        ? pass(`actual「${measured}」= expected「${wanted}」`)
        : fail(`actual「${measured}」≠ expected「${wanted}」`);
    }
    case 'contains':
      return measured.toLowerCase().includes(wanted.trim().toLowerCase())
        ? pass(`actual「${truncate(measured, 40)}」包含「${truncate(wanted, 40)}」`)
        : fail(`actual「${truncate(measured, 40)}」不包含「${truncate(wanted, 40)}」`);
    case 'regex': {
      try {
        return new RegExp(wanted).test(measured)
          ? pass(`actual 命中正则 /${wanted}/`)
          : fail(`actual 未命中正则 /${wanted}/`);
      } catch (error) {
        return fail(`正则非法：${(error as Error).message}`);
      }
    }
    case 'oneOf': {
      const list = expected ?? [];
      return list.some((item) => item.trim() === measured)
        ? pass(`actual「${truncate(measured, 40)}」∈ {${list.join(', ')}}`)
        : fail(`actual「${truncate(measured, 40)}」不在 {${list.join(', ')}} 中`);
    }
    case 'range': {
      if (numeric === undefined) return fail('actual 不是数值，无法与 range 比较');
      const { min, max } = assertion;
      if (min !== undefined && numeric < min) return fail(`actual ${numeric} < min ${min}`);
      if (max !== undefined && numeric > max) return fail(`actual ${numeric} > max ${max}`);
      return pass(`actual ${numeric} ∈ [${min ?? '−∞'}, ${max ?? '∞'}]`);
    }
    case 'gte': {
      if (numeric === undefined) return fail('actual 不是数值，无法与 gte 比较');
      const bound = Number(wanted);
      return Number.isFinite(bound) && numeric >= bound
        ? pass(`actual ${numeric} ≥ ${bound}`)
        : fail(`actual ${numeric} < ${bound}`);
    }
    case 'lte': {
      if (numeric === undefined) return fail('actual 不是数值，无法与 lte 比较');
      const bound = Number(wanted);
      return Number.isFinite(bound) && numeric <= bound
        ? pass(`actual ${numeric} ≤ ${bound}`)
        : fail(`actual ${numeric} > ${bound}`);
    }
  }
}

/** Fill `assertionVerdict` on checks whose criterion carries an assertion. */
export function applyAssertionVerdicts(pack: TaskPack, checks: readonly Check[]): Check[] {
  const known = new Map(pack.criteria.map((criterion) => [criterion.id, criterion]));
  return checks.map((check) => {
    const criterion = known.get(check.criterionId);
    if (criterion?.assertion === undefined || check.actual === undefined || check.actual.length === 0) {
      return check;
    }
    return { ...check, assertionVerdict: evaluateAssertion(criterion.assertion, check.actual).verdict };
  });
}

function openFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => (finding.status ?? 'open') === 'open');
}

/**
 * Pre-review gate: a finding only survives if its author tried to refute it,
 * and any surviving blocker stops the dispatch.
 * @param findings - normalized findings.
 * @param note - the reviewed surface (required when there are no findings).
 * @param options - resolved options.
 */
export function gatePrereview(
  findings: readonly Finding[],
  note: string,
  options: Options
): Gate {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (findings.length === 0 && inline(note).length < 12) {
    errors.push('零发现的预审必须在 `note` 里写明审阅范围（读了哪些文件、覆盖哪些视角），否则视为未审。');
  }

  for (const finding of findings) {
    const label = `\`${finding.id}\` ${finding.title}`;
    if (finding.evidence.length < 8) {
      errors.push(`${label} 缺少证据（至少写明具体失败场景/日志/截图路径）。`);
    }
    if (finding.severity === 'blocker' && options.requireRebuttalOnBlocker) {
      if (finding.rebuttal === undefined || finding.rebuttal.length < 8) {
        errors.push(`${label} 是阻断项，但没有记录反驳尝试（\`rebuttal\`）；未经历自我反驳的阻断项不得上报。`);
      }
    }
    if (finding.severity !== 'minor' && finding.suggestion === undefined) {
      warnings.push(`${label} 没有给出修改建议，返工时执行者需要自行猜方向。`);
    }
  }

  const openBlockers = openFindings(findings).filter((finding) => finding.severity === 'blocker');
  if (openBlockers.length > 0) {
    errors.push(`仍有 ${openBlockers.length} 条未关闭的阻断项，不能派发。`);
  }
  if (findings.length === 0) {
    warnings.push('预审没有任何发现：确认这确实是因为规格足够扎实，而不是审阅范围过窄。');
  }
  if (!findings.some((finding) => finding.dimension === 'architecture')) {
    warnings.push('预审没有覆盖「架构」视角（性能 / 生命周期 / 并发 / API 兼容），建议至少交叉质询一次。');
  }

  return { pass: errors.length === 0, errors, warnings };
}

/**
 * Delivery gate: all `must` criteria checked with their own evidence, every
 * dimension assessed, and no open blocker/major finding.
 * @param pack - the frozen task pack.
 * @param checks - criterion verification records.
 * @param findings - additional findings.
 * @param options - resolved options.
 */
export function gateDelivery(
  pack: TaskPack,
  checks: readonly Check[],
  findings: readonly Finding[],
  policy?: DeviceConfig,
  aesthetic?: AestheticProfile,
  design?: ReadonlyMap<string, DesignCard>
): Gate {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Map(pack.criteria.map((criterion) => [criterion.id, criterion]));
  const seen = new Set<string>();

  for (const check of checks) {
    const label = `\`${check.criterionId}\``;
    const criterion = known.get(check.criterionId);
    if (criterion === undefined) {
      errors.push(`${label} 不是任务包里的判据 ID，检查记录无法归档。`);
      continue;
    }
    if (seen.has(checkKey(check, policy))) {
      errors.push(
        policy?.mode === 'matrix'
          ? `${label} 在屏幕族「${check.family === undefined ? '?' : SCREEN_FAMILY_LABELS[check.family]}」上出现了多次检查记录，同一判据同一族只允许一个结论。`
          : `${label} 出现了多次检查记录，一条判据只允许一个结论。`
      );
    }
    seen.add(checkKey(check, policy));
    if (check.result !== 'unverified' && check.evidence.length < 4) {
      errors.push(`${label} 判为「${RESULT_LABELS[check.result]}」但没有证据。`);
    }
    if (check.result === 'fail') {
      if (criterion.weight === 'must') {
        errors.push(`${label} 的结论是「未通过」，must 判据未通过就不能宣告验收。`);
      } else {
        warnings.push(`${label} 的结论是「未通过」（should 判据），可以带风险通过但需写进遗留风险。`);
      }
    }
    if (looksSelfReported(check.evidence)) {
      warnings.push(`${label} 的证据像执行者自述（「${truncate(check.evidence, 24)}」），DSH 需要独立取证。`);
    }
    if (criterion.assertion !== undefined) {
      const described = assertionLabel(criterion.assertion);
      if (check.actual === undefined || check.actual.length === 0) {
        if (check.result === 'pass') {
          errors.push(`${label} 带可执行断言（${described}），但检查记录缺少 \`actual\` 实测值；断言未执行不得判 pass。`);
        } else {
          warnings.push(`${label} 带可执行断言（${described}），但缺少 \`actual\` 实测值，无法自动复核。`);
        }
      } else {
        const evaluation = evaluateAssertion(criterion.assertion, check.actual);
        if (evaluation.verdict === 'fail' && check.result === 'pass') {
          errors.push(`${label} 的断言判定不通过（${evaluation.reason}），但检查结论是「通过」；两者矛盾，请复核 actual 或证据。`);
        } else if (evaluation.verdict === 'pass' && check.result === 'fail') {
          warnings.push(`${label} 的断言实测值看起来通过（${evaluation.reason}），但结论是「未通过」；确认是否有其它证据导致失败。`);
        }
      }
    }
  }

  const missing: string[] = [];
  for (const criterion of pack.criteria) {
    if (criterion.weight !== 'must') continue;
    const own = checks.filter((item) => item.criterionId === criterion.id);
    if (own.length === 0) {
      missing.push(criterion.id);
      continue;
    }
    if (own.some((item) => item.result === 'unverified')) {
      errors.push(`\`${criterion.id}\` 是 must 判据，但结论是「未验证」。`);
    }
  }
  if (missing.length > 0) {
    errors.push(`以下 must 判据没有检查记录：${missing.map((id) => `\`${id}\``).join('、')}。`);
  }

  // Aesthetic profile references: a ref that does not resolve to an active
  // entry cannot be used as an acceptance basis (0.6.1 AEST-H).
  if (aesthetic !== undefined) {
    const checkRef = (ref: string, owner: string): void => {
      const entry = findProfileEntry(aesthetic, ref);
      if (entry === undefined) {
        errors.push(`${owner} 引用的审美档案 \`${ref}\` 不存在；先在 \`dwguard_aesthetic\` 里建立该偏好。`);
        return;
      }
      if (entry.status !== 'active') {
        errors.push(`${owner} 引用的审美档案 \`${ref}\` 已 superseded，不能作为本轮验收依据。`);
      }
    };
    for (const criterion of pack.criteria) {
      if (criterion.profileRef !== undefined && criterion.profileRef.length > 0) {
        checkRef(criterion.profileRef, `判据 \`${criterion.id}\``);
      }
    }
    for (const check of checks) {
      if (check.profileRef !== undefined && check.profileRef.length > 0) {
        checkRef(check.profileRef, `检查 \`${check.criterionId}\``);
      }
    }
  }

  // Design references (0.6.2 P2): a ref that does not resolve to an active card
  // cannot be used as an acceptance basis. A missing library is an error only
  // when a pack/check actually names a ref.
  const designRefs: Array<{ ref: string; owner: string }> = [];
  for (const criterion of pack.criteria) {
    for (const ref of criterion.designRefs ?? []) designRefs.push({ ref, owner: `判据 \`${criterion.id}\`` });
  }
  for (const check of checks) {
    for (const ref of check.designRefs ?? []) designRefs.push({ ref, owner: `检查 \`${check.criterionId}\`` });
  }
  if (designRefs.length > 0) {
    if (design === undefined) {
      errors.push('判据/检查引用了设计参考，但设计库不可用；先初始化并 ingest 设计库。');
    } else {
      for (const { ref, owner } of designRefs) {
        const card = design.get(ref);
        if (card === undefined) {
          errors.push(`${owner} 引用的设计参考 \`${ref}\` 不存在；先 ingest 该卡片或换一个 ref。`);
        } else if (card.status !== 'active') {
          errors.push(`${owner} 引用的设计参考 \`${ref}\` 已被 block，不能作为验收依据。`);
        }
      }
    }
  }

  for (const dimension of DIMENSIONS) {
    const ids = pack.criteria.filter((criterion) => criterion.dimension === dimension).map((criterion) => criterion.id);
    if (ids.length === 0) {
      errors.push(`「${DIMENSION_LABELS[dimension]}」维度没有判据，无法宣告四维验收。`);
      continue;
    }
    const assessed = checks.filter(
      (check) => ids.includes(check.criterionId) && check.result !== 'unverified'
    ).length;
    if (assessed === 0) {
      errors.push(`「${DIMENSION_LABELS[dimension]}」维度没有任何已取证的检查项。`);
    }
  }

  if (policy !== undefined && policy.mode === 'matrix') {
    for (const check of checks) {
      if (check.device === undefined || check.family === undefined) {
        errors.push(
          `\`${check.criterionId}\` 在 matrix 模式（主机内存 ${policy.hostMemoryGb}GB）下缺少 \`device\` / \`family\`；矩阵取证必须标明设备与屏幕族。`
        );
      }
    }
    for (const criterion of pack.criteria) {
      for (const family of matrixFamilies(policy, criterion.dimension)) {
        const found = checks.find((check) => check.criterionId === criterion.id && check.family === family);
        if (found === undefined) {
          const message = `matrix 模式：「${DIMENSION_LABELS[criterion.dimension]}」判据 \`${criterion.id}\` 缺少屏幕族「${SCREEN_FAMILY_LABELS[family]}」（\`${family}\`）的检查记录。`;
          if (policy.allowMissing) {
            warnings.push(`${message}（allowMissingMatrixFamilies=true，降级为警告）`);
          } else {
            errors.push(message);
          }
        } else if (found.result === 'unverified' && criterion.weight === 'must') {
          errors.push(`\`${criterion.id}\` 在「${SCREEN_FAMILY_LABELS[family]}」族上的结论是「未验证」（must 判据）。`);
        }
      }
    }
  }

  const open = openFindings(findings);
  for (const finding of open) {
    const label = `\`${finding.id}\` ${finding.title}`;
    if (finding.severity === 'blocker' || finding.severity === 'major') {
      errors.push(`${label}（${SEVERITY_LABELS[finding.severity]}）仍未关闭。`);
    } else {
      warnings.push(`${label} 仍是开放状态（轻微），可带风险通过但需在验收报告里列明。`);
    }
    if (finding.evidence.length < 8) {
      errors.push(`${label} 缺少可复核证据。`);
    }
  }

  if (checks.length === 0) {
    errors.push('没有任何检查记录；DSH 尚未做外部审计。');
  }
  return { pass: errors.length === 0, errors, warnings };
}

/** Summarize coverage of a delivery audit. */
export function summarizeCoverage(pack: TaskPack, checks: readonly Check[], policy?: DeviceConfig): Coverage {
  const must = pack.criteria.filter((criterion) => criterion.weight === 'must');
  let passed = 0;
  let failed = 0;
  let unverified = 0;
  const missing: string[] = [];
  for (const criterion of must) {
    const own = checks.filter((check) => check.criterionId === criterion.id);
    if (own.length === 0) {
      missing.push(criterion.id);
      continue;
    }
    if (policy !== undefined && policy.mode === 'matrix') {
      const required = matrixFamilies(policy, criterion.dimension);
      if (required.some((family) => !own.some((check) => check.family === family))) {
        missing.push(criterion.id);
        continue;
      }
    }
    if (own.some((check) => check.result === 'unverified')) unverified += 1;
    else if (own.some((check) => check.result === 'fail')) failed += 1;
    else passed += 1;
  }
  return { total: must.length, passed, failed, unverified, missing };
}

/** Per-dimension coverage rows for the audit table. */
export function summarizeDimensions(pack: TaskPack, checks: readonly Check[]): DimensionSummary[] {
  const byId = new Map(checks.map((check) => [check.criterionId, check]));
  return DIMENSIONS.map((dimension) => {
    const criteria = pack.criteria.filter((criterion) => criterion.dimension === dimension);
    const assessed = criteria.filter((criterion) => {
      const check = byId.get(criterion.id);
      return check !== undefined && check.result !== 'unverified';
    });
    return {
      dimension,
      criteria: criteria.length,
      assessed: assessed.length,
      passed: assessed.filter((criterion) => byId.get(criterion.id)?.result === 'pass').length
    };
  });
}

function findingRow(finding: Finding): string[] {
  return [
    `\`${finding.id}\``,
    finding.dimension === 'architecture' ? '架构' : DIMENSION_LABELS[finding.dimension],
    SEVERITY_LABELS[finding.severity],
    finding.title,
    finding.evidence,
    finding.ruleId ?? '—',
    finding.status ?? 'open'
  ];
}

function issueBlock(gate: Gate): string {
  const parts: string[] = [];
  if (gate.errors.length > 0) {
    parts.push('**未通过原因**', '', bullets(gate.errors), '');
  }
  if (gate.warnings.length > 0) {
    parts.push('**提醒**', '', bullets(gate.warnings), '');
  }
  return parts.join('\n').trimEnd();
}

/** Render `artifacts/prereview-<n>.md`. */
export function renderPrereviewMarkdown(report: PrereviewReport, pack: TaskPack, paths: SharedPaths): string {
  const counts = {
    blocker: report.findings.filter((finding) => finding.severity === 'blocker').length,
    major: report.findings.filter((finding) => finding.severity === 'major').length,
    minor: report.findings.filter((finding) => finding.severity === 'minor').length
  };
  return [
    `# 派发前架构预审 · #${report.id}`,
    '',
    `> 任务包 \`${displayPath(paths, paths.specMd)}\` v${pack.specVersion} · ${report.createdAt}`,
    `> 结论：${report.gate.pass ? '通过，可以派发' : '未通过，先修任务包'} · 发现 ${report.findings.length} 条（阻断 ${counts.blocker} / 严重 ${counts.major} / 轻微 ${counts.minor}）`,
    '',
    '## 审阅范围',
    '',
    report.note.length > 0 ? report.note : '（未填写）',
    '',
    '## 发现',
    '',
    report.findings.length === 0
      ? '（本轮零发现）'
      : table(['ID', '视角', '严重度', '问题', '证据', '规则', '状态'], report.findings.map(findingRow)),
    '',
    '## 闸门',
    '',
    issueBlock(report.gate).length > 0 ? issueBlock(report.gate) : '通过：没有未关闭的阻断项。',
    '',
    '## 反驳记录',
    '',
    report.findings
      .filter((finding) => finding.rebuttal !== undefined)
      .map((finding) => `- \`${finding.id}\` 的反驳尝试：${finding.rebuttal}`)
      .join('\n') || '（无）',
    ''
  ].join('\n');
}

/** Render the「判据 × 屏幕族」matrix; empty string in single-device mode. */
export function renderDeviceMatrix(pack: TaskPack, checks: readonly Check[], policy: DeviceConfig): string {
  if (policy.mode !== 'matrix') return '';
  const families = policy.matrix;
  const rows = pack.criteria.map((criterion) => {
    const row = [`\`${criterion.id}\``, DIMENSION_LABELS[criterion.dimension]];
    for (const family of families) {
      const check = checks.find((item) => item.criterionId === criterion.id && item.family === family);
      row.push(check === undefined ? '—' : check.result === 'pass' ? '✓' : check.result === 'fail' ? '✗' : '·');
    }
    return row;
  });
  return table(['判据', '维度', ...families.map((family) => SCREEN_FAMILY_LABELS[family])], rows);
}

/** One cell for the aesthetic-profile column. */
function aestheticCell(profileRef: string | undefined, profile: AestheticProfile | undefined): string {
  if (profileRef === undefined || profileRef.length === 0) return '—';
  if (profile === undefined) return `\`${profileRef}\``;
  const entry = findProfileEntry(profile, profileRef);
  if (entry === undefined) return `\`${profileRef}\`<br>缺失`;
  return `\`${profileRef}\`<br>${AREA_LABELS[entry.area]} ${valueLabel(entry.value)}`;
}

/** One cell for the design-reference column (0.6.2 P2). */
function designCell(
  refs: readonly string[] | undefined,
  design: ReadonlyMap<string, DesignCard> | undefined
): string {
  if (refs === undefined || refs.length === 0) return '—';
  return refs
    .map((ref) => {
      if (design === undefined) return `\`${ref}\`<br>库不可用`;
      const card = design.get(ref);
      if (card === undefined) return `\`${ref}\`<br>缺失`;
      const tokens = designCardTokenSummary(card);
      return `\`${ref}\`<br>${card.title}${tokens.length === 0 ? '' : `<br>${tokens}`}`;
    })
    .join('<br><br>');
}

/** Render `artifacts/audit-<n>.md`. */
export function renderAuditMarkdown(
  report: AuditReport,
  pack: TaskPack,
  paths: SharedPaths,
  policy?: DeviceConfig,
  aesthetic?: AestheticProfile,
  design?: ReadonlyMap<string, DesignCard>
): string {
  const criteria = new Map(pack.criteria.map((criterion) => [criterion.id, criterion]));
  const checkRows = report.checks.map((check) => {
    const criterion = criteria.get(check.criterionId);
    const files = check.evidenceFiles ?? [];
    return [
      `\`${check.criterionId}\``,
      criterion === undefined ? '—' : DIMENSION_LABELS[criterion.dimension],
      check.device ?? '—',
      check.family === undefined ? '—' : SCREEN_FAMILY_LABELS[check.family],
      aestheticCell(check.profileRef ?? criterion?.profileRef, aesthetic),
      designCell(check.designRefs ?? criterion?.designRefs, design),
      RESULT_LABELS[check.result],
      criterion?.assertion === undefined ? '—' : assertionLabel(criterion.assertion),
      check.actual === undefined ? '—' : check.actual,
      check.assertionVerdict === undefined
        ? '—'
        : check.assertionVerdict === 'pass'
          ? '✓ 通过'
          : '✗ 不通过',
      check.evidence,
      files.length === 0 ? '—' : files.map((file) => `\`${file}\``).join('<br>'),
      check.note ?? '—'
    ];
  });
  return [
    `# 外部审计 · #${report.id}`,
    '',
    `> 任务包 \`${displayPath(paths, paths.specMd)}\` v${pack.specVersion} · ${report.createdAt}`,
    `> 证据包 \`${displayPath(paths, `${paths.artifactsDir}/audit-${report.id}/manifest.json`)}\`（内含每个文件的 sha256）`,
    `> 结论：${report.gate.pass ? '通过' : '未通过'} · must 判据 ${report.coverage.passed}/${report.coverage.total} 通过` +
      `${report.coverage.failed > 0 ? ` · ${report.coverage.failed} 未通过` : ''}` +
      `${report.coverage.unverified > 0 ? ` · ${report.coverage.unverified} 未验证` : ''}` +
      `${report.coverage.missing.length > 0 ? ` · ${report.coverage.missing.length} 未覆盖` : ''}`,
    '',
    '## 维度结论',
    '',
    table(
      ['维度', '判据数', '已取证', '通过'],
      report.dimensions.map((row) => [
        DIMENSION_LABELS[row.dimension],
        String(row.criteria),
        String(row.assessed),
        String(row.passed)
      ])
    ),
    '',
    '## 设备矩阵',
    '',
    policy === undefined || policy.mode !== 'matrix'
      ? `单机验证（主机内存 ${policy?.hostMemoryGb ?? '?'}GB，未启用矩阵）。`
      : renderDeviceMatrix(pack, report.checks, policy),
    '',
    '### 设备清单',
    '',
    report.devices === undefined || report.devices.length === 0
      ? '（无设备记录）'
      : table(
          ['设备', '屏幕族', 'API', '类型'],
          report.devices.map((device) => [
            device.sn,
            SCREEN_FAMILY_LABELS[device.family],
            device.apiLevel === undefined ? '—' : String(device.apiLevel),
            device.kind ?? '—'
          ])
        ),
    '',
    '## 逐条检查（独立取证）',
    '',
    report.checks.length === 0
      ? '（无）'
      : table(
          ['判据', '维度', '设备', '屏幕族', '审美档案', '参考对照', '结论', '断言', '实测值', '断言判定', '证据', '证据文件', '备注'],
          checkRows
        ),
    '',
    '## 发现',
    '',
    report.findings.length === 0
      ? '（无）'
      : table(['ID', '维度', '严重度', '问题', '证据', '规则', '状态'], report.findings.map(findingRow)),
    '',
    '## 闸门',
    '',
    issueBlock(report.gate).length > 0 ? issueBlock(report.gate) : '通过：四维均已取证，且没有未关闭的阻断/严重问题。',
    '',
    '## 备注',
    '',
    report.note.length > 0 ? report.note : '（未填写）',
    ''
  ].join('\n');
}

/** Render `tasks/rework-<n>.md` from a failed audit. */
export function renderReworkMarkdown(report: AuditReport, pack: TaskPack, paths: SharedPaths): string {
  const criteria = new Map(pack.criteria.map((criterion) => [criterion.id, criterion]));
  const failed = report.checks.filter((check) => check.result === 'fail');
  const unverified = report.checks.filter((check) => check.result === 'unverified');
  const open = openFindings(report.findings).filter(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major'
  );
  const rows: string[][] = [];
  for (const check of failed) {
    const criterion = criteria.get(check.criterionId);
    rows.push([
      `\`${check.criterionId}\``,
      criterion?.statement ?? '—',
      RESULT_LABELS[check.result],
      check.actual ?? '—',
      check.evidence
    ]);
  }
  for (const id of report.coverage.missing) {
    const criterion = criteria.get(id);
    rows.push([`\`${id}\``, criterion?.statement ?? '—', '未覆盖', '—', '没有任何检查记录']);
  }
  for (const check of unverified) {
    const criterion = criteria.get(check.criterionId);
    rows.push([`\`${check.criterionId}\``, criterion?.statement ?? '—', '未验证', check.actual ?? '—', check.evidence || '—']);
  }
  return [
    `# 返工单 · 审计 #${report.id} 未通过`,
    '',
    `> 任务包 \`${displayPath(paths, paths.specMd)}\` v${pack.specVersion}`,
    `> 审计报告 \`${displayPath(paths, paths.artifactsDir)}/audit-${report.id}.md\``,
    `> 生成时间 ${report.createdAt} · 返工范围以本单为准，不得扩大或缩小`,
    '',
    '## 1. 失败的验收标准',
    '',
    table(['判据', '原始判据', '结论', '实测值', '证据'], rows),
    '',
    '### 闸门问题',
    '',
    bullets(report.gate.errors),
    '',
    '## 2. 阻断/严重问题',
    '',
    open.length === 0
      ? '（无）'
      : open
          .map(
            (finding) =>
              `### [${SEVERITY_LABELS[finding.severity]}] \`${finding.id}\` ${finding.title}\n\n` +
              `- 证据：${finding.evidence}\n` +
              `- 规则：${finding.ruleId ?? '—'}\n` +
              `- 修复建议：${finding.suggestion ?? '（未给出）'}`
          )
          .join('\n\n'),
    '',
    '## 3. 返工要求',
    '',
    bullets([
      '只修复上面列出的条目，不顺手改无关代码；',
      '每条修复后补充新的证据（命令输出 / 截图路径 / 测量值），写回 `outbox-deveco.md`；',
      '不得修改 `tasks/spec.md` 或降低验收标准；判据确实不可达时，写入 `tasks/question.md` 说明原因；',
      '重新跑一遍四维自检后再交付，DSH 会再次独立取证。'
    ]),
    '',
    '## 4. 交付记录格式',
    '',
    '```markdown',
    `## [<ISO 时间>] rework-${report.id} · 第 ${pack.iteration} 轮`,
    '- 状态: 完成 / 部分完成',
    '- 修复条目: F-01, X-02',
    '- 变更文件: entry/src/main/ets/pages/Index.ets',
    '- 新证据: <命令输出 / 截图路径>',
    '- 未解决: <如有>',
    '```',
    ''
  ].join('\n');
}

/** Render `artifacts/acceptance-report.md` from a passing audit. */
export function renderAcceptanceMarkdown(
  report: AuditReport,
  pack: TaskPack,
  paths: SharedPaths,
  policy?: DeviceConfig,
  aesthetic?: AestheticProfile,
  design?: ReadonlyMap<string, DesignCard>
): string {
  const criteria = new Map(pack.criteria.map((criterion) => [criterion.id, criterion]));
  const passed = report.checks.filter((check) => check.result === 'pass');
  const minor = report.findings.filter((finding) => finding.severity === 'minor');
  const compares = report.aesthetic?.compares ?? [];
  const failedCompares = compares.filter((compare) => !compare.pass);
  const rows = passed.map((check) => {
    const criterion = criteria.get(check.criterionId);
    return [
      `\`${check.criterionId}\``,
      criterion === undefined ? '—' : DIMENSION_LABELS[criterion.dimension],
      criterion?.statement ?? '—',
      criterion?.assertion === undefined ? '—' : assertionLabel(criterion.assertion),
      check.actual ?? '—',
      check.family === undefined ? check.device ?? '—' : `${check.device ?? '—'} · ${SCREEN_FAMILY_LABELS[check.family]}`,
      aestheticCell(check.profileRef ?? criterion?.profileRef, aesthetic),
      designCell(check.designRefs ?? criterion?.designRefs, design),
      check.evidence
    ];
  });
  return [
    `# 验收报告 · ${pack.title}`,
    '',
    `> 结论：**通过**（四维齐全，must 判据 ${report.coverage.passed}/${report.coverage.total} 全部通过）` +
      (failedCompares.length === 0 ? '' : `；注意：审美基线有 ${failedCompares.length} 个页面/状态未通过（见 §2.2）`),
    `> 任务包 v${pack.specVersion} · 审计 #${report.id} · ${report.createdAt}`,
    `> 任务包：\`${displayPath(paths, paths.specMd)}\` · 审计记录：\`${displayPath(paths, paths.artifactsDir)}/audit-${report.id}.md\``,
    '',
    '## 1. 维度结论',
    '',
    table(
      ['维度', '判据数', '已取证', '通过'],
      report.dimensions.map((row) => [
        DIMENSION_LABELS[row.dimension],
        String(row.criteria),
        String(row.assessed),
        String(row.passed)
      ])
    ),
    '',
    '## 2. 证据索引',
    '',
    table(['判据', '维度', '判据原文', '断言', '实测值', '设备', '审美档案', '参考对照', '独立证据'], rows),
    '',
    '### 2.1 屏幕族矩阵',
    '',
    policy === undefined || policy.mode !== 'matrix'
      ? `单机验证（主机内存 ${policy?.hostMemoryGb ?? '?'}GB）。`
      : renderDeviceMatrix(pack, report.checks, policy),
    '',
    report.devices === undefined || report.devices.length === 0
      ? ''
      : table(
          ['设备', '屏幕族', 'API', '类型'],
          report.devices.map((device) => [
            device.sn,
            SCREEN_FAMILY_LABELS[device.family],
            device.apiLevel === undefined ? '—' : String(device.apiLevel),
            device.kind ?? '—'
          ])
        ),
    '',
    '### 2.2 审美基线差异',
    '',
    compares.length === 0
      ? '（本轮未运行 `dwguard_aesthetic compare`；审美判据以档案与截图证据为准。）'
      : compares
          .map(
            (compare) =>
              `#### ${compare.page} · ${compare.state}\n\n${renderCompareMarkdown(compare, '', false)}`
          )
          .join('\n\n'),
    '',
    '## 3. 遗留风险',
    '',
    minor.length === 0
      ? '无开放发现。'
      : bullets(minor.map((finding) => `\`${finding.id}\` ${finding.title} — ${finding.evidence}`)),
    '',
    ...(failedCompares.length === 0
      ? []
      : [
          '**审美基线未通过**',
          '',
          bullets(
            failedCompares.map(
              (compare) =>
                `${compare.page} · ${compare.state} 有 ${compare.rows.filter((row) => row.verdict === 'fail').length} 项超差——如这是用户要求的新设计，需在用户确认后重建基线；否则按回归处理。`
            )
          ),
          ''
        ]),
    '',
    '## 4. 下一步',
    '',
    bullets([
      '请用户确认验收结论；如需继续迭代，新增需求会开启下一轮任务包。',
      '已通过的结论与返工模式可沉淀到 `.shared/knowledge/`（`dwguard_knowledge`）。',
      'DevEco Code 侧的交付记录保留在 `outbox-deveco.md`，作为本轮追溯材料。'
    ]),
    ''
  ].join('\n');
}

/** One criterion as a bullet line, used by briefs and gap reports. */
export function criterionLine(criterion: Criterion): string {
  return `\`${criterion.id}\`（${criterion.weight}）${criterion.statement} — 验证：${criterion.verify}`;
}
