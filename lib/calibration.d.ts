/**
 * Gate calibration ledger.
 *
 * Every audit, every confirmation and every later "this passed but the user
 * found a bug" report is appended to `knowledge/calibration.jsonl`. The report
 * then shows, per dimension, how often the gate was right — the thing a rule
 * corpus alone can never tell you.
 *
 * @module dwguard-dsh-hmos/calibration
 */
import type { Check, Dimension, TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
/** One ledger line. */
export interface CalibrationRecord {
    readonly kind: 'audit' | 'confirm' | 'miss';
    readonly at: string;
    readonly specVersion: number;
    readonly round?: number;
    readonly auditId?: number;
    readonly pass?: boolean;
    readonly decision?: 'accept' | 'new_round';
    readonly dimension?: Dimension;
    readonly note?: string;
    /** Per-dimension verdict snapshot taken at audit time. */
    readonly dimensions?: Readonly<Record<string, {
        passed: number;
        failed: number;
        missing: number;
    }>>;
}
/** Per-dimension calibration row. */
export interface CalibrationRow {
    readonly dimension: Dimension;
    readonly audits: number;
    readonly failedAudits: number;
    readonly misses: number;
    /** `misses / audits`, or `null` when there were no audits yet. */
    readonly missRate: number | null;
}
/** Build per-dimension verdicts from a pack + its checks. */
export declare function dimensionVerdicts(pack: TaskPack, checks: readonly Check[]): Record<string, {
    passed: number;
    failed: number;
    missing: number;
}>;
/** Append one line, creating the ledger. */
export declare function appendCalibration(paths: SharedPaths, record: CalibrationRecord): Promise<void>;
/** Read the ledger, tolerating blank/corrupt lines. */
export declare function readCalibration(paths: SharedPaths): Promise<CalibrationRecord[]>;
/** Aggregate the ledger into one row per dimension. */
export declare function summariseCalibration(records: readonly CalibrationRecord[]): CalibrationRow[];
/** One-line human summary of a row. */
export declare function describeRow(row: CalibrationRow): string;
