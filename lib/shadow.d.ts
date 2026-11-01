/**
 * Shadow review (increment ②): a read-only pass over the code and, when the
 * device tool is available, the structured UI tree — while DevEco is coding.
 *
 * Each run is recorded as `artifacts/shadow-<n>.json` and stamped into
 * `state.json`, so `dwguard_status` can nudge when the last pass is stale.
 *
 * @module dwguard-dsh-hmos/shadow
 */
import type { ScanHit } from './scan.js';
import type { SharedPaths } from './paths.js';
/** Structured UI snapshot recorded with a shadow round. */
export interface UiTreeSummary {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    /** Node count when the file is JSON with children/nodes arrays. */
    readonly nodes?: number;
    /** Max nesting depth when the file is JSON. */
    readonly depth?: number;
}
/** One shadow round. */
export interface ShadowReport {
    readonly schemaVersion: 1;
    readonly index: number;
    readonly scannedAt: string;
    readonly phase: string;
    readonly files: number;
    readonly must: number;
    readonly warn: number;
    readonly hits: readonly ScanHit[];
    readonly note: string;
    /** Must-level hits that were not already reported by the previous round. */
    readonly newRisks: readonly ScanHit[];
    readonly uiTree?: UiTreeSummary;
}
/**
 * Read a UI-tree dump (JSON from `harmony_ui_tree` or a text tree) and describe it.
 * @param paths - resolved protocol layout.
 * @param file - path relative to `.shared/`.
 */
export declare function summariseUiTree(paths: SharedPaths, file: string): Promise<UiTreeSummary>;
/**
 * Run one shadow review and persist it.
 * @param paths - resolved protocol layout.
 * @param phase - current phase (`dispatched` / `rework`).
 * @param uiTree - optional UI-tree file relative to `.shared/`.
 * @param note - optional one-liner for the record.
 * @param now - ISO timestamp.
 * @param sinceMs - only re-scan files modified at/after this epoch (incremental).
 */
export declare function runShadow(paths: SharedPaths, phase: string, uiTree: string | undefined, note: string, now: string, sinceMs?: number): Promise<{
    report: ShadowReport;
    file: string;
}>;
/** Shorthand used in tool output. */
export declare function describeUiTree(summary: UiTreeSummary, paths: SharedPaths): string;
