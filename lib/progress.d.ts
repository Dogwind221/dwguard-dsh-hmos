/**
 * Per-dimension audit progress.
 *
 * Four independent sub-agents gather evidence for one dimension each. Recording
 * each dimension as it returns lets the panel show four cards landing one by one
 * instead of all at once — the visible difference between "running" and "done".
 *
 * @module dwguard-dsh-hmos/progress
 */
import type { Dimension } from './model.js';
import type { SharedPaths } from './paths.js';
/** One dimension's returned result. */
export interface DimensionProgress {
    /** `failed` wins over `done` when any criterion in the dimension failed. */
    readonly state: 'done' | 'failed';
    readonly passed: number;
    readonly failed: number;
    readonly note?: string;
    readonly at: string;
}
/** The progress document. */
export interface AuditProgress {
    readonly schemaVersion: 1;
    readonly specVersion: number;
    readonly updatedAt: string;
    readonly dims: Readonly<Partial<Record<Dimension, DimensionProgress>>>;
}
/** Read the progress document, or `null` when absent/unreadable. */
export declare function readAuditProgress(paths: SharedPaths): Promise<AuditProgress | null>;
/**
 * Record one returned dimension, keeping the others as they were.
 * @param paths - resolved protocol layout.
 * @param specVersion - the pack version this audit runs against.
 * @param dimension - which dimension returned.
 * @param passed - criteria that passed in this dimension.
 * @param failed - criteria that failed in this dimension.
 * @param note - optional one-liner for the card.
 * @param now - ISO timestamp.
 */
export declare function recordDimension(paths: SharedPaths, specVersion: number, dimension: Dimension, passed: number, failed: number, note: string | undefined, now: string): Promise<AuditProgress>;
/** Drop the progress document (after the final audit recorded all four). */
export declare function clearAuditProgress(paths: SharedPaths): Promise<void>;
/** Dimensions that already returned for this pack version. */
export declare function returnedDimensions(progress: AuditProgress | null, specVersion: number): Dimension[];
