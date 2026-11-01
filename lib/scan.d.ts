/**
 * Independent ArkTS/ArkUI static scan.
 *
 * The audit must not rely on "I read the code": these checks run over the
 * workspace and turn the highest-frequency ArkTS/ArkUI mistakes (LLM写鸿蒙的
 * 老坑) into rule-ID findings with file:line evidence. Deliberately small and
 * dependency-free — the goal is a defensible baseline, not a full linter.
 *
 * @module dwguard-dsh-hmos/scan
 */
import type { Dimension } from './model.js';
/** Severity of one scan hit. */
export type ScanSeverity = 'must' | 'warn';
/** One rule finding. */
export interface ScanHit {
    readonly ruleId: string;
    readonly dimension: Dimension;
    readonly severity: ScanSeverity;
    /** Path relative to the scan root, POSIX separators. */
    readonly file: string;
    readonly line: number;
    readonly excerpt: string;
    readonly message: string;
    readonly suggestion: string;
}
/** The scan report written to `artifacts/scan-<n>.json`. */
export interface ScanReport {
    readonly schemaVersion: 1;
    readonly scannedAt: string;
    readonly root: string;
    readonly files: number;
    readonly hits: readonly ScanHit[];
    readonly counts: {
        readonly must: number;
        readonly warn: number;
    };
}
/**
 * Scan one workspace for ArkTS/ArkUI pitfalls.
 * @param root - absolute directory to scan.
 * @param includeWarnings - include `warn` hits (default true).
 * @param now - ISO timestamp.
 * @param options - `sinceMs`: only files modified at/after this epoch (incremental).
 */
export declare function scanWorkspace(root: string, includeWarnings?: boolean, now?: string, options?: {
    sinceMs?: number;
}): Promise<ScanReport>;
/** Resolve and validate a scan path inside the workspace. */
export declare function resolveScanRoot(workspace: string, requested?: string): string;
