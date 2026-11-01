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
import type { Criterion, CriterionWeight, Dimension, TaskPack } from './model.js';
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
 * Validate a pack against the workflow's acceptance contract.
 * @param pack - the built task pack.
 * @param options - resolved plugin options (dimension minimums).
 */
export declare function validateTaskPack(pack: TaskPack, options: Options): ValidationResult;
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
export declare function renderSpecMarkdown(pack: TaskPack, paths: SharedPaths): string;
