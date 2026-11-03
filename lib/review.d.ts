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
import type { Check, CheckResult, Criterion, CriterionAssertion, DeviceEvidence, Dimension, Finding, ReviewDimension, ScreenFamily, Severity, TaskPack } from './model.js';
import type { DeviceConfig } from './device.js';
import type { AestheticProfile } from './aesthetic.js';
import type { BaselineCompareResult } from './baseline.js';
import type { SharedPaths } from './paths.js';
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
/** Aesthetic evidence attached to an audit report (0.6.1). */
export interface AestheticAuditSummary {
    readonly profileRefs: readonly AestheticAuditRef[];
    /** Latest baseline comparison, when one was run for this pack version. */
    readonly compare?: BaselineCompareResult;
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
}
/** Rebuild canonical findings from model input, numbering untitled ids. */
export declare function normalizeFindings(input: readonly FindingInput[]): Finding[];
/** Rebuild canonical checks from model input. */
export declare function normalizeChecks(input: readonly CheckInput[]): Check[];
/** Machine verdict of one criterion assertion against the measured value. */
export interface AssertionEvaluation {
    readonly verdict: 'pass' | 'fail';
    readonly reason: string;
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
export declare function evaluateAssertion(assertion: CriterionAssertion, actual: string): AssertionEvaluation;
/** Fill `assertionVerdict` on checks whose criterion carries an assertion. */
export declare function applyAssertionVerdicts(pack: TaskPack, checks: readonly Check[]): Check[];
/**
 * Pre-review gate: a finding only survives if its author tried to refute it,
 * and any surviving blocker stops the dispatch.
 * @param findings - normalized findings.
 * @param note - the reviewed surface (required when there are no findings).
 * @param options - resolved options.
 */
export declare function gatePrereview(findings: readonly Finding[], note: string, options: Options): Gate;
/**
 * Delivery gate: all `must` criteria checked with their own evidence, every
 * dimension assessed, and no open blocker/major finding.
 * @param pack - the frozen task pack.
 * @param checks - criterion verification records.
 * @param findings - additional findings.
 * @param options - resolved options.
 */
export declare function gateDelivery(pack: TaskPack, checks: readonly Check[], findings: readonly Finding[], policy?: DeviceConfig, aesthetic?: AestheticProfile): Gate;
/** Summarize coverage of a delivery audit. */
export declare function summarizeCoverage(pack: TaskPack, checks: readonly Check[], policy?: DeviceConfig): Coverage;
/** Per-dimension coverage rows for the audit table. */
export declare function summarizeDimensions(pack: TaskPack, checks: readonly Check[]): DimensionSummary[];
/** Render `artifacts/prereview-<n>.md`. */
export declare function renderPrereviewMarkdown(report: PrereviewReport, pack: TaskPack, paths: SharedPaths): string;
/** Render the「判据 × 屏幕族」matrix; empty string in single-device mode. */
export declare function renderDeviceMatrix(pack: TaskPack, checks: readonly Check[], policy: DeviceConfig): string;
/** Render `artifacts/audit-<n>.md`. */
export declare function renderAuditMarkdown(report: AuditReport, pack: TaskPack, paths: SharedPaths, policy?: DeviceConfig, aesthetic?: AestheticProfile): string;
/** Render `tasks/rework-<n>.md` from a failed audit. */
export declare function renderReworkMarkdown(report: AuditReport, pack: TaskPack, paths: SharedPaths): string;
/** Render `artifacts/acceptance-report.md` from a passing audit. */
export declare function renderAcceptanceMarkdown(report: AuditReport, pack: TaskPack, paths: SharedPaths, policy?: DeviceConfig, aesthetic?: AestheticProfile): string;
/** One criterion as a bullet line, used by briefs and gap reports. */
export declare function criterionLine(criterion: Criterion): string;
