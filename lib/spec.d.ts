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
import type { Criterion, CriterionAssertion, CriterionWeight, Dimension, TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
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
export declare function normalizeAssertion(value: unknown): {
    assertion?: CriterionAssertion;
    error?: string;
};
/** Compact one-line rendering of an assertion (used by specs, briefs and audits). */
export declare function assertionLabel(assertion: CriterionAssertion): string;
/** Whether a string is a well-formed anti-pattern id (`AP-0001`). */
export declare function isAntiPatternRefId(value: string): boolean;
/** Whether a string is a well-formed principle id (`PR-0001`). */
export declare function isPrincipleRefId(value: string): boolean;
/** Whether a string is a well-formed design-library id (`DSG-0007`). */
export declare function isDesignRefId(value: string): boolean;
/**
 * Validate a pack against the workflow's acceptance contract.
 * @param pack - the built task pack.
 * @param options - resolved plugin options (dimension minimums).
 * @param profile - optional aesthetic profile, used for profileRef hints.
 */
export declare function validateTaskPack(pack: TaskPack, options: Options, profile?: AestheticProfile): ValidationResult;
/**
 * Normalize model input into a canonical pack. Trims text, dedupes constraints,
 * assigns `must` as the default weight, and fills counters from the caller.
 * @param input - model-supplied fields.
 * @param meta - iteration, spec version and timestamps owned by the workflow.
 */
export declare function buildTaskPack(input: TaskPackInput, meta: {
    iteration: number;
    specVersion: number;
    createdAt: string;
    updatedAt: string;
}): TaskPack;
/** Parse a stored `spec.json`, returning `null` when it is absent or unreadable. */
export declare function parseTaskPack(raw: string | null): TaskPack | null;
/** Group criteria by dimension, keeping pack order. */
export declare function criteriaByDimension(pack: TaskPack): Record<Dimension, Criterion[]>;
/** Dimensions with no criterion at all. */
export declare function missingDimensions(pack: TaskPack): Dimension[];
/** Render the human-readable `tasks/spec.md`. */
export declare function renderSpecMarkdown(pack: TaskPack, paths: SharedPaths, inherited?: ReadonlyMap<string, readonly {
    readonly ref: string;
    readonly from: string;
}[]>): string;
