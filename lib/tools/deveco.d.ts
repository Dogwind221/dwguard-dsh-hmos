/**
 * `dwguard_deveco` — read-only-ish evidence adapter for DevEco CLI.
 *
 * Runs a fixed set of `devecocli` subcommands (build / run / log / lint / device
 * / ui) from the workspace, captures stdout/stderr + exit code into
 * `artifacts/deveco-<n>/`, and reports the exact command. DSH uses the output as
 * evidence; the executor's own claims are still not trusted.
 *
 * @module dwguard-dsh-hmos/tools/deveco
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/** Result of one child-process run. */
export interface DevecoRun {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
}
export type DevecoRunner = (command: string, args: readonly string[], cwd: string) => Promise<DevecoRun>;
/**
 * Create the DevEco CLI adapter tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context.
 * @param runner - injectable runner (tests pass a fake).
 */
export declare function createDevecoTool(options: Options, ctx?: PluginContext, runner?: DevecoRunner): ToolDefinition<unknown, ToolResult>;
