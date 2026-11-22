/**
 * Performance sampling helpers: percentile/aggregation, hidumper memory parsing
 * and RenderService fps parsing. Parsing is best-effort and every failure keeps
 * the raw text (the tool never invents a number).
 *
 * @module dwguard-dsh-hmos/perf
 */
export interface SampleSummary {
    readonly samples: readonly number[];
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly p95: number;
    readonly unit: string;
}
/** Nearest-rank percentile (p in 0–100). */
export declare function percentile(samples: readonly number[], p: number): number;
/** Aggregate numeric samples with min/max/mean/p95. */
export declare function summarizeSamples(samples: readonly number[], unit: string): SampleSummary;
export interface HidumperMemory {
    /** Best-effort total PSS in kB (max `Pss`/`Total Pss` value found). */
    readonly pssKb?: number;
    readonly rssKb?: number;
    readonly lines: number;
}
/** Parse `hidumper --mem <pid>` output into PSS candidates. */
export declare function parseHidumperMem(text: string): HidumperMemory;
export interface FpsSample {
    readonly fps?: number;
    readonly jank?: number;
    readonly refreshRate?: number;
    readonly count?: number;
}
/** Parse RenderService fps / refresh-rate output. */
export declare function parseFpsOutput(text: string): FpsSample;
