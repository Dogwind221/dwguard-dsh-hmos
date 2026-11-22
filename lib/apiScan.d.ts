/**
 * Scan project sources for references to SDK APIs marked `@deprecated`.
 *
 * Read-only: parses imports of `@ohos.*` / `@kit.*`, reads the matching SDK
 * declarations for deprecated symbols, then reports every remaining call site
 * with file:line. Findings are facts; whether they fail a gate is the task pack's
 * compatibility criterion.
 *
 * @module dwguard-dsh-hmos/apiScan
 */
import type { SdkLayout } from './harmonySdk.js';
export interface ApiScanFinding {
    /** Project-relative POSIX path. */
    readonly file: string;
    readonly line: number;
    readonly symbol: string;
    readonly module: string;
    readonly deprecated: string;
}
export interface ApiScanResult {
    readonly projectRoot: string;
    readonly filesScanned: number;
    readonly imports: readonly string[];
    readonly deprecatedSymbols: number;
    readonly findings: readonly ApiScanFinding[];
}
/** Scan one project for deprecated SDK API call sites. */
export declare function scanDeprecatedApi(projectRoot: string, layout: SdkLayout, options?: {
    maxFiles?: number;
    maxFindings?: number;
}): ApiScanResult;
