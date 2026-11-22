/**
 * Offline forensics for `devecocli log`: crash reports (jscrash / cppcrash /
 * appfreeze) and structured hilog summaries. Pure parsing: nothing is executed.
 *
 * @module dwguard-dsh-hmos/forensics
 */
export type CrashType = 'jscrash' | 'cppcrash' | 'appfreeze' | 'unknown';
/** One parsed crash / freeze report. */
export interface CrashReport {
    readonly type: CrashType;
    readonly pid?: number;
    readonly process?: string;
    readonly bundle?: string;
    readonly faultTime?: string;
    readonly reason?: string;
    readonly signal?: string;
    readonly topFrame?: string;
    readonly frames: readonly string[];
    readonly summary: string;
}
/** One hilog line (or JSON record) after normalization. */
export interface HilogEntry {
    readonly time?: string;
    readonly pid?: number;
    readonly tid?: number;
    readonly level?: string;
    readonly tag?: string;
    readonly message: string;
    readonly raw: string;
}
/** Folded message pattern with its repeat count. */
export interface FoldedMessage {
    readonly pattern: string;
    readonly count: number;
    readonly sample: string;
    readonly levels: readonly string[];
}
/** Structured summary of a hilog capture. */
export interface HilogSummary {
    readonly total: number;
    readonly parsed: number;
    readonly unparsed: number;
    readonly levels: Readonly<Record<string, number>>;
    readonly pids: ReadonlyArray<{
        pid: number;
        count: number;
    }>;
    readonly tags: ReadonlyArray<{
        tag: string;
        count: number;
    }>;
    readonly folded: readonly FoldedMessage[];
    readonly errors: readonly FoldedMessage[];
    readonly firstTimestamp?: string;
    readonly lastTimestamp?: string;
    readonly regex?: string;
    readonly pidFilter?: number;
    readonly matched?: number;
}
/** Parse crash output (devecocli JSON or a faultlog / hilog excerpt). */
export declare function parseCrashLog(raw: string): CrashReport[];
/** Normalize one message for folding (numbers/hex/ids become placeholders). */
export declare function foldPattern(message: string): string;
/** Parse hilog output (JSON array or plain hilog lines) into a summary. */
export declare function parseHilog(raw: string, options?: {
    regex?: string;
    pid?: number;
    maxLines?: number;
}): HilogSummary;
