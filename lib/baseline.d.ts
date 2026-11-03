/**
 * Visual baselines: snapshot a measured layout into `artifacts/visual-baseline/`
 * and compare a later dump against it.
 *
 * The comparison is deliberately numeric, not pixel-based: spacing/radius allow
 * ±2vp, font size has zero tolerance, colours are compared exactly. Screenshots
 * are stored for human review, never auto-verdicted.
 *
 * @module dwguard-dsh-hmos/baseline
 */
import type { SharedPaths } from './paths.js';
/** One measured layout value. */
export type BaselineMetricValue = {
    readonly kind: 'number';
    readonly value: number;
    readonly unit: string;
} | {
    readonly kind: 'color';
    readonly value: string;
};
/** Node key → field → measured value. */
export type MetricMap = Map<string, Map<string, BaselineMetricValue>>;
/** One saved baseline entry. */
export interface BaselineEntry {
    readonly page: string;
    readonly state: string;
    /** File name inside the baseline directory. */
    readonly boundsFile: string;
    readonly screenshotFile?: string;
    readonly boundsSha256: string;
    readonly screenshotSha256?: string;
    readonly savedAt: string;
    readonly auditId: number;
    readonly confirmationId: number;
}
/** `<specVersion>/index.json`. */
export interface BaselineIndex {
    readonly schemaVersion: 1;
    readonly specVersion: number;
    readonly entries: readonly BaselineEntry[];
}
/** One diff row for the compare table and the acceptance report. */
export interface BaselineDiffRow {
    readonly node: string;
    readonly field: string;
    readonly baseline: string;
    readonly current: string;
    readonly delta: string;
    readonly verdict: 'pass' | 'fail';
    readonly reason?: string;
}
/** The persisted compare result (`artifacts/aesthetic/compare-latest.json`). */
export interface BaselineCompareResult {
    readonly schemaVersion: 1;
    readonly at: string;
    readonly specVersion: number;
    readonly page: string;
    readonly state: string;
    readonly toleranceVp: number;
    readonly pass: boolean;
    readonly rows: readonly BaselineDiffRow[];
    readonly missingNodes: readonly string[];
    readonly addedNodes: number;
    readonly boundsSha256: string;
    readonly baselineBoundsSha256: string;
}
/** Directory holding one task-pack version's baselines. */
export declare function baselineDir(paths: SharedPaths, specVersion: number): string;
/** Read one version's index, tolerating a missing or corrupt file. */
export declare function readBaselineIndex(paths: SharedPaths, specVersion: number): Promise<BaselineIndex>;
/** Write one version's index. */
export declare function writeBaselineIndex(paths: SharedPaths, specVersion: number, index: BaselineIndex): Promise<void>;
/** Find the saved entry for a page/state pair. */
export declare function findBaselineEntry(index: BaselineIndex, page: string, state: string): BaselineEntry | undefined;
/** Sanitize a page/state name into a file stem. */
export declare function sanitizeBaselineKey(raw: string, fallback: string): string;
/**
 * Walk a layout-tree dump and collect the measurable fields per node.
 *
 * Nodes are keyed by their `id` when present (the stable name in a layout dump)
 * and by their path otherwise. Field names stay stable so a later dump compares
 * like for like.
 */
export declare function extractMetrics(root: unknown): MetricMap;
/** Render one metric for display (missing → `—`). */
export declare function metricLabel(metric: BaselineMetricValue | undefined): string;
/**
 * Compare two measured trees.
 * @param baseline - metrics captured when the baseline was saved.
 * @param current - metrics from the current layout dump.
 * @param meta - identity/timestamps for the persisted result.
 */
export declare function compareMetrics(baseline: MetricMap, current: MetricMap, meta: {
    readonly at: string;
    readonly specVersion: number;
    readonly page: string;
    readonly state: string;
    readonly toleranceVp?: number;
    readonly boundsSha256?: string;
    readonly baselineBoundsSha256?: string;
}): BaselineCompareResult;
/** Persist the latest comparison so audit reports can render it. */
export declare function writeCompareResult(paths: SharedPaths, result: BaselineCompareResult): Promise<string>;
/** Read the latest comparison (or `null` when none exists for this pack version). */
export declare function readCompareResult(paths: SharedPaths, specVersion: number): Promise<BaselineCompareResult | null>;
/** Read a bounds JSON file as parsed data. */
export declare function readBoundsJson(file: string): Promise<{
    value: unknown;
} | {
    error: string;
}>;
/** Copy a bounds/screenshot pair into the baseline directory and record hashes. */
export declare function saveBaselineFiles(paths: SharedPaths, specVersion: number, input: {
    readonly page: string;
    readonly state: string;
    readonly boundsSource: string;
    readonly screenshotSource?: string;
    readonly auditId: number;
    readonly confirmationId: number;
    readonly now: string;
}): Promise<BaselineEntry>;
/** Render the compare result as a markdown section. */
export declare function renderCompareMarkdown(result: BaselineCompareResult, headingLevel?: string): string;
/** List all baseline versions present on disk. */
export declare function listBaselineVersions(paths: SharedPaths): Promise<number[]>;
/** Display path for one baseline entry's bounds file. */
export declare function baselineDisplayPath(paths: SharedPaths, specVersion: number, entry: BaselineEntry): string;
/** Basename of a source file, used for error messages. */
export declare function sourceName(file: string): string;
