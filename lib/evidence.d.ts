/**
 * Audit evidence bundles.
 *
 * A check can name files (screenshots, layout-tree dumps, log excerpts). This
 * module copies them into `artifacts/audit-<n>/evidence/`, records their SHA-256
 * in a manifest, and refuses paths outside `.shared/` — so a later reviewer can
 * prove which bytes backed which verdict.
 *
 * @module dwguard-dsh-hmos/evidence
 */
import type { Check } from './model.js';
import type { SharedPaths } from './paths.js';
/** One copied evidence file. */
export interface EvidenceFile {
    readonly criterionId: string;
    /** Path as given by the auditor, relative to `.shared/`. */
    readonly path: string;
    /** Location inside the bundle, e.g. `evidence/artifacts__shot.png`. */
    readonly storedAs: string;
    readonly sha256: string;
    readonly bytes: number;
}
/** `artifacts/audit-<n>/manifest.json`. */
export interface EvidenceManifest {
    readonly schemaVersion: 1;
    readonly auditId: number;
    readonly specVersion: number;
    readonly generatedAt: string;
    readonly files: readonly EvidenceFile[];
    readonly checks: ReadonlyArray<{
        readonly criterionId: string;
        readonly result: string;
        readonly evidence: string;
        readonly evidenceFiles: readonly string[];
    }>;
}
/** Raised when an evidence path is missing or escapes the shared directory. */
export declare class EvidenceError extends Error {
}
/** Bundle directory for one audit. */
export declare function bundleDir(paths: SharedPaths, auditId: number): string;
/** Resolve one evidence path, refusing anything outside `.shared/`. */
export declare function resolveSharedPath(paths: SharedPaths, file: string): string;
/**
 * Check every referenced file exists before anything is written.
 * @returns missing paths, in input order.
 */
export declare function missingEvidence(paths: SharedPaths, checks: readonly Check[]): Promise<string[]>;
/**
 * Copy every referenced file into the bundle and write `manifest.json`.
 * @param paths - resolved protocol layout.
 * @param auditId - audit number (matches `audit-<n>.md`).
 * @param specVersion - pack version under audit.
 * @param checks - normalized checks carrying `evidenceFiles`.
 * @param now - ISO timestamp.
 * @param limits - optional size caps (tests use tiny values).
 */
export declare function writeEvidenceBundle(paths: SharedPaths, auditId: number, specVersion: number, checks: readonly Check[], now: string, limits?: {
    perFileBytes?: number;
    totalBytes?: number;
}): Promise<EvidenceManifest>;
