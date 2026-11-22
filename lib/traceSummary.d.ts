/**
 * Summarize a raw `hitrace` capture (ftrace text) into deterministic slice
 * statistics: event counts, function/path hotspots, paired slice durations and
 * process distribution. This is evidence, not a verdict: it does not compute
 * fps/jank, and it never turns a trace into a pass/fail.
 *
 * @module dwguard-dsh-hmos/traceSummary
 */
export interface TraceFunctionStat {
    readonly name: string;
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
    readonly avgMs: number;
}
export interface TraceSlowSlice {
    readonly name: string;
    readonly pid: number;
    readonly ms: number;
}
export interface TraceSummary {
    readonly lines: number;
    readonly bytes: number;
    readonly entries: number;
    readonly written: number;
    readonly events: number;
    readonly beginEvents: number;
    readonly endEvents: number;
    readonly functions: number;
    readonly spanMs?: number;
    readonly firstTimestamp?: string;
    readonly lastTimestamp?: string;
    readonly topFunctions: readonly TraceFunctionStat[];
    readonly slowest: readonly TraceSlowSlice[];
    readonly topPids: ReadonlyArray<{
        pid: number;
        count: number;
    }>;
    readonly notes: readonly string[];
}
/** Parse one hitrace text capture into summary statistics. */
export declare function summarizeTrace(raw: string): TraceSummary;
