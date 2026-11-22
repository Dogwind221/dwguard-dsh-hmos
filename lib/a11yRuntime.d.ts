/**
 * Runtime accessibility checks on a live layout tree + screenshot:
 * touch-target sizes from bounds and contrast estimates sampled from text regions.
 *
 * The contrast estimate is approximate (text region luminance range vs. WCAG
 * ratio), not a glyph/background sampling of the actual font colour. Findings are
 * facts for the acceptance criterion, never a verdict.
 *
 * @module dwguard-dsh-hmos/a11yRuntime
 */
export interface A11yRuntimeOptions {
    readonly minTouchSize?: number;
    readonly minContrast?: number;
    readonly maxItems?: number;
}
export interface A11yRuntimeFinding {
    readonly kind: 'touch-target' | 'contrast';
    readonly node: string;
    readonly bounds: readonly [number, number, number, number];
    readonly measured: number;
    readonly threshold: number;
    readonly detail: string;
}
export interface A11yRuntimeReport {
    readonly nodes: number;
    readonly clickable: number;
    readonly textNodes: number;
    readonly touchTargetViolations: number;
    readonly contrastViolations: number;
    readonly touchTargets: readonly A11yRuntimeFinding[];
    readonly contrasts: readonly A11yRuntimeFinding[];
    readonly notes: readonly string[];
}
/** Analyze a layout tree plus screenshot for touch targets and contrast estimates. */
export declare function analyzeA11yRuntime(layout: unknown, screenshotPng: Buffer, options?: A11yRuntimeOptions): A11yRuntimeReport;
