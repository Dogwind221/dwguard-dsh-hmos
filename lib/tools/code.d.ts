/**
 * `dwguard_code` — zero-click executor: hand the frozen Goal brief to the
 * DevEco Code CLI (`deveco run`) in the background, stream its JSON events into
 * `artifacts/code-<n>/`, and manage the job (run / status / stop / list).
 *
 * The executor produces evidence only. Acceptance still comes from
 * `dwguard_audit`: an agent's own report is never a `pass`.
 *
 * @module dwguard-dsh-hmos/tools/code
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/** Lifecycle of one background DevEco Code run. */
export type CodeJobStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'timeout' | 'stopped';
/** One background job, as kept in memory and mirrored to `meta.json`. */
export interface CodeJob {
    readonly id: string;
    readonly dir: string;
    readonly logPath: string;
    readonly metaPath: string;
    readonly startedAt: string;
    readonly pid: number;
    readonly command: string;
    status: CodeJobStatus;
    exitCode?: number;
    endedAt?: string;
    sessionID?: string;
    lastText?: string;
    lastError?: string;
    /** Number of JSON event lines seen so far. */
    eventCount: number;
}
/** The slice of a child process this tool observes (injectable in tests). */
export interface CodeChild {
    readonly pid?: number | undefined;
    readonly stdout?: {
        on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    } | null | undefined;
    readonly stderr?: {
        on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    } | null | undefined;
    on(event: 'close', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
}
/** A cancellable timer (injectable so a test never waits a real minute). */
export interface CodeTimer {
    cancel(): void;
}
/** Test seam for process and time control. */
export interface CodeDeps {
    readonly spawn?: (command: string, args: readonly string[], options: {
        cwd: string;
        shell: boolean;
        windowsHide: boolean;
        env: NodeJS.ProcessEnv;
    }) => CodeChild;
    readonly kill?: (pid: number) => void;
    readonly alive?: (pid: number) => boolean;
    readonly timer?: (ms: number, callback: () => void) => CodeTimer;
}
/** One parsed JSON line from `deveco run --format json`. */
export interface CodeEvent {
    readonly sessionID?: string;
    readonly text?: string;
    readonly error?: string;
}
/**
 * Resolve the `deveco` binary: explicit path first, then npm-global shims, then
 * the bare name for PATH resolution by the shell.
 */
export declare function resolveCodeBinary(configured: string): string;
/** Build the `deveco run` argv; the prompt goes last so long briefs stay a file reference. */
export declare function buildCodeArgs(input: {
    readonly dir: string;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly agent?: string | undefined;
    readonly auto: boolean;
}): string[];
/** Parse one JSON event line; unparseable or unrelated lines are ignored. */
export declare function parseCodeEvent(line: string): CodeEvent | undefined;
/**
 * Create the zero-click executor tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (optional; tests omit it).
 * @param deps - injectable spawn/kill/timer seam for tests.
 */
export declare function createCodeTool(options: Options, ctx?: PluginContext, deps?: CodeDeps): ToolDefinition<unknown, ToolResult>;
