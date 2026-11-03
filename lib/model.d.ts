/**
 * Vocabulary shared by every stage: the four acceptance dimensions, the task
 * pack, review findings, checks, and the persisted protocol state.
 *
 * @module dwguard-dsh-hmos/model
 */
/** The four acceptance dimensions the workflow gates on. */
export declare const DIMENSIONS: readonly ["function", "aesthetic", "performance", "accessibility"];
/** One acceptance dimension. */
export type Dimension = (typeof DIMENSIONS)[number];
/** Chinese labels used by every generated document. */
export declare const DIMENSION_LABELS: Record<Dimension, string>;
/** Recommended criterion-id prefix per dimension (`F-01`, `A-01`, ...). */
export declare const DIMENSION_PREFIX: Record<Dimension, string>;
/** What a criterion in each dimension must be able to name. */
export declare const DIMENSION_EVIDENCE: Record<Dimension, string>;
/** Whether a criterion must be verified before acceptance. */
export type CriterionWeight = 'must' | 'should';
/** Huawei screen families the multi-device matrix verifies against. */
export declare const SCREEN_FAMILIES: readonly ["phone", "widefold", "foldable", "triplefold"];
/** One screen family (bar phone / wide fold / dual fold / triple fold). */
export type ScreenFamily = (typeof SCREEN_FAMILIES)[number];
/** Chinese labels used by generated documents. */
export declare const SCREEN_FAMILY_LABELS: Record<ScreenFamily, string>;
/** One device in the configured pool. */
export interface DeviceEntry {
    readonly sn: string;
    readonly family: ScreenFamily;
    readonly apiLevel?: number;
    readonly kind: 'emulator' | 'real';
}
/** Whether a string is one of the screen families. */
export declare function isScreenFamily(value: unknown): value is ScreenFamily;
/** Matchers a criterion assertion can use. */
export declare const ASSERTION_MATCHERS: readonly ["equals", "contains", "regex", "range", "gte", "lte", "oneOf", "present"];
/** How a criterion assertion compares the measured value. */
export type AssertionMatcher = (typeof ASSERTION_MATCHERS)[number];
/**
 * Optional machine-checkable expectation on a criterion.
 *
 * A criterion without an assertion is judged by the auditor's evidence alone;
 * one with an assertion must also carry the measured `actual` value in the
 * delivery audit, and the gate recomputes pass/fail from it.
 */
export interface CriterionAssertion {
    readonly matcher: AssertionMatcher;
    /** Expected scalar, or the list for `oneOf` (absent for `present`/`range`). */
    readonly expected?: string | number | readonly (string | number)[];
    /** Inclusive lower bound (`range`). */
    readonly min?: number;
    /** Inclusive upper bound (`range`). */
    readonly max?: number;
    /** Unit of the measured value (`ms`, `vp`, `ratio`…); documentation only. */
    readonly unit?: string;
    /** Where the auditor should measure the value from. */
    readonly source?: string;
}
/** One falsifiable acceptance criterion. */
export interface Criterion {
    /** Stable id, unique inside the pack (e.g. `F-01`). */
    readonly id: string;
    readonly dimension: Dimension;
    /** Observable statement that can fail. */
    readonly statement: string;
    /** How an independent auditor verifies it. */
    readonly verify: string;
    readonly weight: CriterionWeight;
    /** Catalog rule this criterion implements (`DW-A11Y-02`, `STATE-002`…). */
    readonly ruleId?: string;
    /** Optional declarative expectation the audit gate can recompute. */
    readonly assertion?: CriterionAssertion;
    /** Aesthetic-profile entry this criterion follows (`AES-RADIUS-01`, 0.6.1). */
    readonly profileRef?: string;
    /** Design-library cards this criterion follows (`DSG-0007`, 0.6.2). */
    readonly designRefs?: readonly string[];
}
/** The frozen task pack DSH hands to the executor agent. */
export interface TaskPack {
    readonly schemaVersion: 1;
    /** Executor chosen for this pack; `auto` = IDE-first with CLI only where it wins. */
    readonly executor?: 'auto' | 'ide' | 'cli';
    readonly title: string;
    readonly requirement: string;
    readonly spec: string;
    readonly constraints: readonly string[];
    readonly criteria: readonly Criterion[];
    readonly iteration: number;
    readonly specVersion: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** Severity of a review finding. */
export type Severity = 'blocker' | 'major' | 'minor';
/** Review dimension: the four acceptance dimensions plus architecture. */
export type ReviewDimension = Dimension | 'architecture';
/** One review finding. */
export interface Finding {
    readonly id: string;
    readonly dimension: ReviewDimension;
    readonly severity: Severity;
    readonly title: string;
    /** Independent evidence: screenshot path, log excerpt, measurement. */
    readonly evidence: string;
    readonly ruleId?: string;
    readonly criterionId?: string;
    readonly suggestion?: string;
    /** Pre-review only: the author's own attempt to refute the finding. */
    readonly rebuttal?: string;
    readonly status?: 'open' | 'dismissed' | 'fixed';
}
/** Result of verifying one criterion. */
export type CheckResult = 'pass' | 'fail' | 'unverified';
/** One criterion verification with independent evidence. */
export interface Check {
    readonly criterionId: string;
    readonly result: CheckResult;
    readonly evidence: string;
    readonly note?: string;
    /** Files backing this check, relative to `.shared/`; copied into the audit bundle. */
    readonly evidenceFiles?: readonly string[];
    /** Measured value for a criterion that carries an `assertion`. */
    readonly actual?: string;
    /** Machine verdict recomputed from `assertion` + `actual` by the audit gate. */
    readonly assertionVerdict?: 'pass' | 'fail';
    /** Device serial the evidence was taken on (matrix mode requires it). */
    readonly device?: string;
    /** Screen family the device belongs to (matrix mode requires it). */
    readonly family?: ScreenFamily;
    /** Aesthetic-profile entry this check measured against (0.6.1). */
    readonly profileRef?: string;
    /** Design-library cards this check compared against (0.6.2). */
    readonly designRefs?: readonly string[];
}
/** One device recorded in an audit report. */
export interface DeviceEvidence {
    readonly sn: string;
    readonly family: ScreenFamily;
    readonly apiLevel?: number;
    readonly kind?: 'emulator' | 'real';
    readonly fontScale?: number;
    readonly theme?: string;
}
/** Persisted workflow counters and cursor. */
export interface SharedState {
    readonly schemaVersion: 1;
    readonly iteration: number;
    readonly specVersion: number;
    readonly prereviews: number;
    readonly dispatches: number;
    readonly audits: number;
    /** Dispatches that belong to the current task-pack version. */
    readonly roundDispatches?: number;
    /** Audits that belong to the current task-pack version. */
    readonly roundAudits?: number;
    /** Design-library searches performed in this round (0.6.3 budget). */
    readonly roundDesignSearches?: number;
    /** Total design-library searches (cumulative). */
    readonly designSearches?: number;
    /** Number of DevEco outbox entries already consumed by `dwguard_status`. */
    readonly inboxCursor: number;
    /** Shadow-review rounds recorded during execution. */
    readonly shadowRuns?: number;
    /** ISO time of the last shadow review (staleness nudge in status). */
    readonly lastShadowAt?: string;
    /** ISO time of the last `devecocli` evidence run. */
    readonly lastDevecoAt?: string;
    /** How many times the user confirmed an acceptance report. */
    readonly confirmations?: number;
    /** ISO time of the latest user confirmation. */
    readonly confirmedAt?: string;
    /** Pack version the latest confirmation belongs to. */
    readonly confirmedSpecVersion?: number;
    /** Last phase written by a tool; `dwguard_status` re-derives it from artifacts. */
    readonly phase: string;
    readonly updatedAt: string;
}
/** Whether a string is one of the four dimensions. */
export declare function isDimension(value: unknown): value is Dimension;
/** Whether a string is a review dimension. */
export declare function isReviewDimension(value: unknown): value is ReviewDimension;
/** A fresh state document. */
export declare function emptyState(now: string): SharedState;
