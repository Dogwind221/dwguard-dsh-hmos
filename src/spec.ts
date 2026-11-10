/**
 * The task pack: build, validate, render, parse.
 *
 * Validation is the product, not a formality — a packed spec that cannot fail
 * cannot be audited. Errors block writing; warnings are printed so the model
 * can tighten the wording before it dispatches.
 *
 * @module dwguard-dsh-hmos/spec
 */

import type { Options } from './config.js';
import type { AestheticProfile } from './aesthetic.js';
import { AREA_LABELS, detectAestheticAreas, isAestheticId } from './aesthetic.js';
import type { AssertionMatcher, Criterion, CriterionAssertion, CriterionWeight, Dimension, EvidenceKind, TaskPack } from './model.js';
import { findRule } from './rules.js';
import {
  ASSERTION_MATCHERS,
  DIMENSIONS,
  DIMENSION_EVIDENCE,
  DIMENSION_LABELS,
  DIMENSION_PREFIX,
  EVIDENCE_KINDS,
  isDimension
} from './model.js';
import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { bullets, inline, table } from './util/md.js';

/** The model-supplied shape of one criterion. */
export interface CriterionInput {
  readonly id: string;
  readonly dimension: Dimension;
  readonly statement: string;
  readonly verify: string;
  readonly weight?: CriterionWeight;
  /** Optional catalog rule ID or alias; unknown IDs are rejected. */
  readonly ruleId?: string;
  /** Optional machine-checkable expectation (see {@link normalizeAssertion}). */
  readonly assertion?: CriterionAssertion;
  /** Optional typed evidence required for this criterion (0.9.6). */
  readonly requiredEvidence?: readonly EvidenceKind[];
  /** Aesthetic-profile entry this criterion follows (`AES-RADIUS-01`). */
  readonly profileRef?: string;
  /** Design-library cards this criterion follows (`DSG-0007`, 0.6.2). */
  readonly designRefs?: readonly string[];
  /** Anti-pattern cards this criterion must not violate (`AP-0001`, 0.6.4). */
  readonly antiPatternRefs?: readonly string[];
  /** Principle cards this criterion uses as direction (`PR-0001`, 0.6.7). */
  readonly principleRefs?: readonly string[];
}

/** The model-supplied shape of a task pack. */
export interface TaskPackInput {
  readonly title: string;
  readonly requirement: string;
  readonly spec: string;
  readonly constraints?: readonly string[];
  readonly criteria: readonly CriterionInput[];
  readonly executor?: 'auto' | 'ide' | 'cli';
}

/** One validation message. */
export interface Issue {
  readonly code: string;
  readonly message: string;
  readonly criterionId?: string;
}

/** Validation outcome: errors block, warnings inform. */
export interface ValidationResult {
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
}

const VAGUE_STATEMENTS = new Set([
  '好',
  '好看',
  '美观',
  '漂亮',
  '简洁',
  '流畅',
  '友好',
  '大气',
  '高级',
  '一致',
  'good',
  'nice',
  'beautiful',
  'clean',
  'smooth'
]);

const SELF_REPORT_MARKERS = ['自测通过', '自认为', '开发者确认', 'deveco 已确认', '应该没问题', '目测没问题', '编译通过', '看起来正常'];

const EVIDENCE_HINTS = [
  'hdc',
  'uitest',
  'dumpLayout',
  '截图',
  '日志',
  'hilog',
  '对比度',
  '像素',
  'vp',
  'ms',
  '帧',
  '耗时',
  '启动',
  '布局树',
  '声明的证据',
  '命令行'
];

const CRITERION_ID = /^[A-Za-z][A-Za-z0-9]*-\d{2,}$/;

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Normalize one model-supplied assertion into its canonical shape.
 *
 * The assertion is what makes a criterion machine-checkable: the audit gate
 * recomputes pass/fail from `matcher` + `expected` and the measured `actual`.
 * Invalid assertions are rejected here, before the pack is frozen.
 *
 * @param value - raw `assertion` value from the model.
 * @returns the canonical assertion, or a Chinese `error` explaining refusal.
 */
export function normalizeAssertion(value: unknown): { assertion?: CriterionAssertion; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'assertion 必须是对象。' };
  const record = value as Record<string, unknown>;
  const matcher = record['matcher'];
  if (typeof matcher !== 'string' || !(ASSERTION_MATCHERS as readonly string[]).includes(matcher)) {
    return { error: `assertion.matcher 只能是 ${ASSERTION_MATCHERS.map((item) => `\`${item}\``).join(' / ')}。` };
  }
  const unitRaw = typeof record['unit'] === 'string' ? record['unit'].trim() : '';
  const sourceRaw = typeof record['source'] === 'string' ? record['source'].trim() : '';
  const optional = {
    ...(unitRaw.length > 0 ? { unit: unitRaw } : {}),
    ...(sourceRaw.length > 0 ? { source: sourceRaw } : {})
  };
  const typedMatcher = matcher as AssertionMatcher;

  if (typedMatcher === 'present') return { assertion: { matcher: typedMatcher, ...optional } };

  if (typedMatcher === 'range') {
    const min = numeric(record['min']);
    const max = numeric(record['max']);
    if (min === undefined && max === undefined) return { error: 'assertion.matcher=range 需要 min 和/或 max 数值。' };
    if (min !== undefined && max !== undefined && min > max) return { error: 'assertion.range 的 min 不能大于 max。' };
    return {
      assertion: { matcher: typedMatcher, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ...optional }
    };
  }

  let expected: string | number | (string | number)[] | undefined = undefined;
  if (typedMatcher === 'oneOf') {
    let list: unknown[] | undefined;
    if (Array.isArray(record['expected'])) list = record['expected'];
    else if (typeof record['expected'] === 'string' && record['expected'].trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(record['expected']);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        return { error: 'assertion.matcher=oneOf 的 expected 需要数组（或 JSON 数组字符串）。' };
      }
    }
    if (list === undefined || list.length === 0) return { error: 'assertion.matcher=oneOf 需要非空 expected 数组。' };
    const values: (string | number)[] = [];
    for (const item of list) {
      if (typeof item === 'string' || typeof item === 'number') values.push(item);
      else return { error: 'assertion.expected 的每一项都必须是字符串或数字。' };
    }
    expected = values;
  } else {
    const raw = record['expected'];
    if (raw === undefined || raw === null) return { error: `assertion.matcher=${typedMatcher} 需要 expected。` };
    if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'assertion.expected 必须是字符串或数字。' };
    expected = typeof raw === 'string' ? raw.trim() : raw;
    if (expected === '') return { error: 'assertion.expected 不能为空。' };
    if (typedMatcher === 'gte' || typedMatcher === 'lte') {
      const bound = numeric(expected);
      if (bound === undefined) return { error: `assertion.matcher=${typedMatcher} 的 expected 必须是数字。` };
      expected = bound;
    }
    if (typedMatcher === 'regex') {
      try {
        new RegExp(String(expected));
      } catch (error) {
        return { error: `assertion.regex 不是合法正则：${(error as Error).message}` };
      }
    }
  }
  return { assertion: { matcher: typedMatcher, expected, ...optional } };
}

/** Compact one-line rendering of an assertion (used by specs, briefs and audits). */
export function assertionLabel(assertion: CriterionAssertion): string {
  const unit = assertion.unit === undefined ? '' : ` ${assertion.unit}`;
  switch (assertion.matcher) {
    case 'present':
      return 'present（非空）';
    case 'range': {
      const min = assertion.min === undefined ? '−∞' : String(assertion.min);
      const max = assertion.max === undefined ? '∞' : String(assertion.max);
      return `range ${min}–${max}${unit}`;
    }
    case 'oneOf': {
      const list = Array.isArray(assertion.expected) ? assertion.expected.map(String).join(' | ') : String(assertion.expected ?? '');
      return `oneOf（${list}）${unit}`;
    }
    default:
      return `${assertion.matcher} ${String(assertion.expected ?? '')}${unit}`;
  }
}

function hasEvidenceHint(verify: string): boolean {
  const lower = verify.toLowerCase();
  return EVIDENCE_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}

function looksSelfReported(evidence: string): boolean {
  const lower = evidence.toLowerCase();
  return SELF_REPORT_MARKERS.some((marker) => lower.includes(marker));
}

function criterionIssue(input: CriterionInput, index: number): Issue[] {
  const issues: Issue[] = [];
  const label = inline(input.id).length > 0 ? inline(input.id) : `#${index + 1}`;
  const statement = inline(input.statement);
  const verify = inline(input.verify);

  if (statement.length < 8) {
    issues.push({
      code: 'E_CRITERION_STATEMENT_SHORT',
      message: `判据 \`${label}\` 的陈述过短（<8 字），无法判断是否达成。`,
      criterionId: label
    });
  } else if (VAGUE_STATEMENTS.has(statement.toLowerCase())) {
    issues.push({
      code: 'E_CRITERION_STATEMENT_VAGUE',
      message: `判据 \`${label}\` 只有形容词（「${statement}」），不可证伪；请写成可观察的结果。`,
      criterionId: label
    });
  }

  if (verify.length < 6) {
    issues.push({
      code: 'E_CRITERION_VERIFY_SHORT',
      message: `判据 \`${label}\` 缺少独立验证方式。`,
      criterionId: label
    });
  } else if (looksSelfReported(verify)) {
    issues.push({
      code: 'E_CRITERION_VERIFY_SELF_REPORT',
      message: `判据 \`${label}\` 的验证方式依赖执行者自述（「${verify}」）；验收必须由 DSH 独立取证。`,
      criterionId: label
    });
  }

  if (!CRITERION_ID.test(label)) {
    issues.push({
      code: 'E_CRITERION_ID_FORMAT',
      message: `判据 ID \`${label}\` 不符合 \`前缀-两位数字\`（如 \`F-01\`）。`,
      criterionId: label
    });
  }

  const expectedPrefix = DIMENSION_PREFIX[input.dimension];
  if (CRITERION_ID.test(label) && !label.toUpperCase().startsWith(`${expectedPrefix}-`) && !label.toUpperCase().startsWith(expectedPrefix)) {
    issues.push({
      code: 'W_CRITERION_ID_PREFIX',
      message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」维度，建议使用 \`${expectedPrefix}-\` 前缀。`,
      criterionId: label
    });
  }

  if (input.ruleId !== undefined && inline(input.ruleId).length > 0) {
    const rule = findRule(input.ruleId);
    if (rule === undefined) {
      issues.push({
        code: 'E_CRITERION_RULE_UNKNOWN',
        message: `判据 \`${label}\` 引用的规则 \`${inline(input.ruleId)}\` 不存在；可选 ID 见规则目录（DW-* / STATE-002 / AGC-RJ-* 等）。`,
        criterionId: label
      });
    } else if (rule.dimension !== input.dimension) {
      issues.push({
        code: 'W_CRITERION_RULE_DIMENSION',
        message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」，但规则 \`${rule.id}\` 属于「${DIMENSION_LABELS[rule.dimension]}」。`,
        criterionId: label
      });
    }
  }

  if (input.assertion !== undefined) {
    const normalized = normalizeAssertion(input.assertion);
    if (normalized.error !== undefined) {
      issues.push({
        code: 'E_CRITERION_ASSERTION_INVALID',
        message: `判据 \`${label}\` 的 assertion 无效：${normalized.error}`,
        criterionId: label
      });
    }
  }

  for (const kind of input.requiredEvidence ?? []) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      issues.push({
        code: 'E_CRITERION_EVIDENCE_KIND',
        message: `判据 \`${label}\` 的 requiredEvidence 含有未知类型 \`${String(kind)}\`；可选 ${EVIDENCE_KINDS.join(' / ')}。`,
        criterionId: label
      });
    }
  }

  if (input.profileRef !== undefined && inline(input.profileRef).length > 0) {
    const ref = inline(input.profileRef);
    if (!isAestheticId(ref)) {
      issues.push({
        code: 'E_CRITERION_PROFILE_FORMAT',
        message: `判据 \`${label}\` 的 profileRef \`${ref}\` 格式不对；应为 \`AES-<领域>-<两位数字>\`（如 \`AES-RADIUS-01\`）。`,
        criterionId: label
      });
    } else if (input.dimension !== 'aesthetic') {
      issues.push({
        code: 'W_CRITERION_PROFILE_DIMENSION',
        message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」，却引用了审美档案 \`${ref}\`；只有审美判据应带 profileRef。`,
        criterionId: label
      });
    }
  }

  for (const raw of input.designRefs ?? []) {
    const ref = inline(raw);
    if (!isDesignRefId(ref)) {
      issues.push({
        code: 'E_CRITERION_DESIGN_REF_FORMAT',
        message: `判据 \`${label}\` 的 designRef \`${ref}\` 格式不对；应为 \`DSG-<四位数字>\`（如 \`DSG-0007\`）。`,
        criterionId: label
      });
    } else if (input.dimension !== 'aesthetic') {
      issues.push({
        code: 'W_CRITERION_DESIGN_DIMENSION',
        message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」，却引用了设计参考 \`${ref}\`；只有审美判据应带 designRefs。`,
        criterionId: label
      });
    }
  }

  for (const raw of input.antiPatternRefs ?? []) {
    const ref = inline(raw);
    if (!isAntiPatternRefId(ref)) {
      issues.push({
        code: 'E_CRITERION_ANTIPATTERN_FORMAT',
        message: `判据 \`${label}\` 的 antiPatternRef \`${ref}\` 格式不对；应为 \`AP-<四位数字>\`（如 \`AP-0001\`）。`,
        criterionId: label
      });
    } else if (input.dimension !== 'aesthetic') {
      issues.push({
        code: 'W_CRITERION_ANTIPATTERN_DIMENSION',
        message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」，却引用了反模式 \`${ref}\`；只有审美判据应带 antiPatternRefs。`,
        criterionId: label
      });
    }
  }

  for (const raw of input.principleRefs ?? []) {
    const ref = inline(raw);
    if (!isPrincipleRefId(ref)) {
      issues.push({
        code: 'E_CRITERION_PRINCIPLE_FORMAT',
        message: `判据 \`${label}\` 的 principleRef \`${ref}\` 格式不对；应为 \`PR-<四位数字>\`（如 \`PR-0001\`）。`,
        criterionId: label
      });
    } else if (input.dimension !== 'aesthetic') {
      issues.push({
        code: 'W_CRITERION_PRINCIPLE_DIMENSION',
        message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」，却引用了原则 \`${ref}\`；只有审美判据应带 principleRefs。`,
        criterionId: label
      });
    }
  }

  return issues;
}

/** Whether a string is a well-formed anti-pattern id (`AP-0001`). */
export function isAntiPatternRefId(value: string): boolean {
  return /^AP-\d{4}$/.test(value);
}

/** Whether a string is a well-formed principle id (`PR-0001`). */
export function isPrincipleRefId(value: string): boolean {
  return /^PR-\d{4}$/.test(value);
}

/** Whether a string is a well-formed design-library id (`DSG-0007`). */
export function isDesignRefId(value: string): boolean {
  return /^DSG-\d{4}$/.test(value);
}

function criterionWarnings(input: CriterionInput, index: number, profile?: AestheticProfile): Issue[] {
  const warnings: Issue[] = [];
  const label = inline(input.id).length > 0 ? inline(input.id) : `#${index + 1}`;
  const statement = inline(input.statement);
  const verify = inline(input.verify);

  if (!/\d/.test(statement) && statement.length < 16) {
    warnings.push({
      code: 'W_CRITERION_NO_MEASURE',
      message: `判据 \`${label}\` 没有数值或可计数结果，验收时容易变成主观判断。`,
      criterionId: label
    });
  }
  if (!hasEvidenceHint(verify)) {
    warnings.push({
      code: 'W_CRITERION_NO_EVIDENCE_HINT',
      message: `判据 \`${label}\` 的验证方式没有指明证据类型（截图 / 日志 / 布局树 / 数值），审计员可能无从取证。`,
      criterionId: label
    });
  }
  if (input.ruleId === undefined || inline(input.ruleId).length === 0) {
    warnings.push({
      code: 'W_CRITERION_NO_RULE',
      message: `判据 \`${label}\` 没有引用规则 ID；审计无法把结论追到规则库（可用 \`ruleId\` 指向 \`DW-*\` / \`STATE-002\` / \`AGC-RJ-*\`）。`,
      criterionId: label
    });
  }
  if (input.assertion === undefined && (input.weight ?? 'must') === 'must' && /\d/.test(statement)) {
    warnings.push({
      code: 'W_CRITERION_NO_ASSERTION',
      message: `判据 \`${label}\` 有可度量数值但没有 \`assertion\`；补一条（\`equals\` / \`range\` / \`gte\` / \`lte\` / \`oneOf\` / \`present\`）后，审计可以自动复核实测值，减少人工判定争议。`,
      criterionId: label
    });
  }

  if (input.dimension === 'aesthetic' && profile !== undefined) {
    const ref = input.profileRef === undefined ? '' : inline(input.profileRef);
    if (ref.length === 0) {
      const areas = detectAestheticAreas(statement);
      const candidates = profile.entries
        .filter((entry) => entry.status === 'active' && (areas.length === 0 || areas.includes(entry.area)))
        .slice(0, 3);
      if (candidates.length > 0) {
        warnings.push({
          code: 'W_AEST_PROFILE_HINT',
          message: `判据 \`${label}\` 没有引用审美档案；档案里已有 ${candidates
            .map((entry) => `\`${entry.id}\`（${AREA_LABELS[entry.area]} ${entry.decision}）`)
            .join('、')}，可用 \`profileRef\` 引用，让审计自动对照并写进报告。`,
          criterionId: label
        });
      }
    } else if (!profile.entries.some((entry) => entry.id === ref && entry.status === 'active')) {
      warnings.push({
        code: 'W_CRITERION_PROFILE_UNKNOWN',
        message: `判据 \`${label}\` 引用的审美档案 \`${ref}\` 不存在或已 superseded；审计闸门会因此报错。`,
        criterionId: label
      });
    }
  }

  return warnings;
}

/**
 * Validate a pack against the workflow's acceptance contract.
 * @param pack - the built task pack.
 * @param options - resolved plugin options (dimension minimums).
 * @param profile - optional aesthetic profile, used for profileRef hints.
 */
export function validateTaskPack(
  pack: TaskPack,
  options: Options,
  profile?: AestheticProfile
): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (inline(pack.title).length < 2) {
    errors.push({ code: 'E_TITLE', message: '任务标题至少需要 2 个字。' });
  }
  if (inline(pack.requirement).length < 20) {
    errors.push({
      code: 'E_REQUIREMENT',
      message: '需求描述少于 20 字；先把用户原话与目标补齐，再冻结任务包。'
    });
  }
  if (inline(pack.spec).length < 20) {
    errors.push({
      code: 'E_SPEC',
      message: '实现规格少于 20 字；至少写清页面/组件结构、状态流向与关键交互。'
    });
  }
  if (pack.constraints.length === 0) {
    warnings.push({
      code: 'W_CONSTRAINTS',
      message: '没有写约束（API 版本、目录、不可改动文件、性能预算）；缺少约束会导致返工时范围失控。'
    });
  }

  if (pack.criteria.length === 0) {
    errors.push({ code: 'E_NO_CRITERIA', message: '没有任何验收标准。' });
    return { errors, warnings };
  }

  const counts = new Map<Dimension, number>();
  for (const dimension of DIMENSIONS) counts.set(dimension, 0);
  const seen = new Set<string>();

  pack.criteria.forEach((criterion, index) => {
    const key = inline(criterion.id);
    if (key.length === 0) {
      errors.push({ code: 'E_CRITERION_ID_EMPTY', message: `第 ${index + 1} 条判据没有 ID。` });
    } else if (seen.has(key)) {
      errors.push({ code: 'E_CRITERION_ID_DUPLICATE', message: `判据 ID \`${key}\` 重复。`, criterionId: key });
    } else {
      seen.add(key);
    }
    counts.set(criterion.dimension, (counts.get(criterion.dimension) ?? 0) + 1);
    const input: CriterionInput = criterion;
    for (const issue of criterionIssue(input, index)) {
      if (issue.code.startsWith('E_')) errors.push(issue);
      else warnings.push(issue);
    }
    for (const warning of criterionWarnings(input, index, profile)) warnings.push(warning);
  });

  for (const dimension of DIMENSIONS) {
    const count = counts.get(dimension) ?? 0;
    if (count < options.minCriteriaPerDimension) {
      errors.push({
        code: 'E_DIMENSION_EMPTY',
        message: `「${DIMENSION_LABELS[dimension]}」维度只有 ${count} 条验收标准，至少要 ${options.minCriteriaPerDimension} 条。验收必须四维齐全，缺一维就不算验收。`
      });
    }
  }

  const mustCount = pack.criteria.filter((criterion) => criterion.weight === 'must').length;
  if (mustCount === 0) {
    errors.push({ code: 'E_NO_MUST', message: '所有判据都是 should；至少要有 1 条 must 作为验收闸门。' });
  }

  if (pack.iteration < 1) errors.push({ code: 'E_ITERATION', message: '迭代号必须 ≥ 1。' });

  return { errors, warnings };
}

/**
 * Normalize model input into a canonical pack. Trims text, dedupes constraints,
 * assigns `must` as the default weight, and fills counters from the caller.
 * @param input - model-supplied fields.
 * @param meta - iteration, spec version and timestamps owned by the workflow.
 */
export function buildTaskPack(
  input: TaskPackInput,
  meta: { iteration: number; specVersion: number; createdAt: string; updatedAt: string }
): TaskPack {
  const criteria: Criterion[] = input.criteria.map((criterion) => ({
    id: inline(criterion.id),
    dimension: criterion.dimension,
    statement: inline(criterion.statement),
    verify: inline(criterion.verify),
    weight: criterion.weight ?? 'must',
    ...(criterion.ruleId === undefined || inline(criterion.ruleId).length === 0
      ? {}
      : { ruleId: inline(criterion.ruleId) }),
    ...(criterion.profileRef === undefined || inline(criterion.profileRef).length === 0
      ? {}
      : { profileRef: inline(criterion.profileRef) }),
    ...(criterion.designRefs === undefined || criterion.designRefs.length === 0
      ? {}
      : { designRefs: dedupe(criterion.designRefs.map((ref) => inline(ref)).filter((ref) => ref.length > 0)) }),
    ...(criterion.antiPatternRefs === undefined || criterion.antiPatternRefs.length === 0
      ? {}
      : {
          antiPatternRefs: dedupe(criterion.antiPatternRefs.map((ref) => inline(ref)).filter((ref) => ref.length > 0))
        }),
    ...(criterion.principleRefs === undefined || criterion.principleRefs.length === 0
      ? {}
      : {
          principleRefs: dedupe(criterion.principleRefs.map((ref) => inline(ref)).filter((ref) => ref.length > 0))
        }),
    ...(criterion.assertion === undefined ? {} : { assertion: criterion.assertion }),
    ...(criterion.requiredEvidence === undefined || criterion.requiredEvidence.length === 0
      ? {}
      : { requiredEvidence: [...new Set(criterion.requiredEvidence)] })
  }));
  const constraints = dedupe((input.constraints ?? []).map((item) => inline(item)).filter((item) => item.length > 0));
  return {
    schemaVersion: 1,
    ...(input.executor === undefined || input.executor === 'auto' ? {} : { executor: input.executor }),
    title: inline(input.title),
    requirement: input.requirement.trim(),
    spec: input.spec.trim(),
    constraints,
    criteria,
    iteration: meta.iteration,
    specVersion: meta.specVersion,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt
  };
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Parse a stored `spec.json`, returning `null` when it is absent or unreadable. */
export function parseTaskPack(raw: string | null): TaskPack | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record['title'] !== 'string' || !Array.isArray(record['criteria'])) return null;
  const criteria: Criterion[] = [];
  for (const item of record['criteria']) {
    if (typeof item !== 'object' || item === null) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry['id'] !== 'string' || typeof entry['statement'] !== 'string' || typeof entry['verify'] !== 'string') {
      return null;
    }
    if (!isDimension(entry['dimension'])) return null;
    const weight = entry['weight'] === 'should' ? 'should' : 'must';
    const assertion: CriterionAssertion | undefined = normalizeAssertion(entry['assertion']).assertion;
    criteria.push({
      id: entry['id'],
      dimension: entry['dimension'],
      statement: entry['statement'],
      verify: entry['verify'],
      weight,
      ...(typeof entry['ruleId'] === 'string' && entry['ruleId'].trim().length > 0
        ? { ruleId: entry['ruleId'].trim() }
        : {}),
      ...(typeof entry['profileRef'] === 'string' && entry['profileRef'].trim().length > 0
        ? { profileRef: entry['profileRef'].trim() }
        : {}),
      ...(Array.isArray(entry['designRefs'])
        ? {
            designRefs: (entry['designRefs'] as unknown[])
              .filter((item2): item2 is string => typeof item2 === 'string')
              .map((item2) => item2.trim())
              .filter((item2) => item2.length > 0)
          }
        : {}),
      ...(Array.isArray(entry['antiPatternRefs'])
        ? {
            antiPatternRefs: (entry['antiPatternRefs'] as unknown[])
              .filter((item2): item2 is string => typeof item2 === 'string')
              .map((item2) => item2.trim())
              .filter((item2) => item2.length > 0)
          }
        : {}),
      ...(Array.isArray(entry['principleRefs'])
        ? {
            principleRefs: (entry['principleRefs'] as unknown[])
              .filter((item2): item2 is string => typeof item2 === 'string')
              .map((item2) => item2.trim())
              .filter((item2) => item2.length > 0)
          }
        : {}),
      ...(assertion === undefined ? {} : { assertion }),
      ...(Array.isArray(entry['requiredEvidence'])
        ? {
            requiredEvidence: (entry['requiredEvidence'] as unknown[])
              .filter((item2): item2 is EvidenceKind => typeof item2 === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(item2))
          }
        : {})
    });
  }
  const strings = (key: string): string[] =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  return {
    schemaVersion: 1,
    ...(record['executor'] === 'ide' || record['executor'] === 'cli' ? { executor: record['executor'] } : {}),
    title: record['title'],
    requirement: typeof record['requirement'] === 'string' ? record['requirement'] : '',
    spec: typeof record['spec'] === 'string' ? record['spec'] : '',
    constraints: strings('constraints'),
    criteria,
    iteration: typeof record['iteration'] === 'number' ? record['iteration'] : 1,
    specVersion: typeof record['specVersion'] === 'number' ? record['specVersion'] : 1,
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : ''
  };
}

/** Group criteria by dimension, keeping pack order. */
export function criteriaByDimension(pack: TaskPack): Record<Dimension, Criterion[]> {
  const grouped: Record<Dimension, Criterion[]> = {
    function: [],
    aesthetic: [],
    performance: [],
    accessibility: []
  };
  for (const criterion of pack.criteria) grouped[criterion.dimension].push(criterion);
  return grouped;
}

/** Dimensions with no criterion at all. */
export function missingDimensions(pack: TaskPack): Dimension[] {
  const grouped = criteriaByDimension(pack);
  return DIMENSIONS.filter((dimension) => grouped[dimension].length === 0);
}

/** Render the human-readable `tasks/spec.md`. */
export function renderSpecMarkdown(
  pack: TaskPack,
  paths: SharedPaths,
  inherited?: ReadonlyMap<string, readonly { readonly ref: string; readonly from: string }[]>
): string {
  const grouped = criteriaByDimension(pack);
  const criteriaRows: string[][] = [];
  for (const dimension of DIMENSIONS) {
    for (const criterion of grouped[dimension]) {
      criteriaRows.push([
        `\`${criterion.id}\``,
        DIMENSION_LABELS[dimension],
        criterion.weight,
        criterion.ruleId === undefined ? '—' : `\`${criterion.ruleId}\``,
        criterion.profileRef === undefined ? '—' : `\`${criterion.profileRef}\``,
        criterion.designRefs === undefined || criterion.designRefs.length === 0
          ? '—'
          : criterion.designRefs.map((ref) => `\`${ref}\``).join('<br>'),
        criterion.antiPatternRefs === undefined || criterion.antiPatternRefs.length === 0
          ? '—'
          : criterion.antiPatternRefs.map((ref) => `\`${ref}\``).join('<br>'),
        criterion.principleRefs === undefined || criterion.principleRefs.length === 0
          ? '—'
          : criterion.principleRefs.map((ref) => `\`${ref}\``).join('<br>'),
        criterion.assertion === undefined ? '—' : assertionLabel(criterion.assertion),
        criterion.requiredEvidence === undefined || criterion.requiredEvidence.length === 0
          ? '—'
          : criterion.requiredEvidence.map((kind) => `\`${kind}\``).join('<br>'),
        criterion.statement,
        criterion.verify
      ]);
    }
  }
  const coverage = DIMENSIONS.map((dimension) => [
    DIMENSION_LABELS[dimension],
    String(grouped[dimension].length),
    DIMENSION_EVIDENCE[dimension]
  ]);
  const must = pack.criteria.filter((criterion) => criterion.weight === 'must').length;
  const should = pack.criteria.length - must;

  return [
    `# 任务包 · ${pack.title}`,
    '',
    `> 迭代 v${pack.iteration} · 任务包 v${pack.specVersion} · 更新于 ${pack.updatedAt}`,
    `> 生成者：\`dwguard_spec\` · 共享目录：\`${displayPath(paths, paths.shared)}/\``,
    '> DevEco Code 不得修改本文件的验收标准；需要变更时向 DSH 提问。',
    '',
    '## 1. 用户需求',
    '',
    pack.requirement.trim(),
    '',
    '## 2. 实现规格',
    '',
    pack.spec.trim(),
    '',
    '## 3. 验收标准',
    '',
    `共 ${pack.criteria.length} 条（must ${must} / should ${should}）。验收由 DSH 独立取证，不采信执行者自述。`,
    '',
    table(['ID', '维度', '权重', '规则', '审美档案', '设计参考', '反模式', '原则', '断言', '证据类型', '判据（可证伪）', '独立验证方式'], criteriaRows),
    '',
    ...(inherited === undefined || inherited.size === 0
      ? []
      : [
          '### 自动继承的反模式（0.6.5）',
          '',
          '> 引用了设计参考卡时，卡上的 `antiPatterns` 会自动进入审计清单；下面列出继承关系。',
          '',
          ...[...inherited.entries()].flatMap(([criterionId, refs]) =>
            refs.map((item) => `- \`${criterionId}\` ← \`${item.from}\`：\`${item.ref}\``)
          ),
          ''
        ]),
    '### 维度覆盖',
    '',
    table(['维度', '条数', '必须提供的证据'], coverage),
    '',
    '## 4. 约束',
    '',
    bullets(pack.constraints),
    '',
    '## 5. 交付与取证约定',
    '',
    '- 执行者只在 `outbox-deveco.md` 追加交付记录，不修改任务包。',
    '- 每条 must 判据都必须能被第三方用命令/截图复现；「编译通过」不是功能验收。',
    '- 带「断言」的判据：交付审计时必须给出 `actual` 实测值（`dwguard_audit.checks[].actual`）；闸门会按断言重算结论，断言不通过却标 pass 的审计会被拒绝。',
    '- 需求模糊时写入 `tasks/question.md` 并暂停相关实现，不要用猜测填满验收标准。',
    ''
  ].join('\n');
}
