/**
 * `dwguard_harness` — cross-session run journal (0.8.0).
 *
 * This is the recovery interface: checkpoint the current phase, resume in a new
 * session, count attempts, record failures and choose a fallback. It does not
 * replace `dwguard_status` (which derives the phase from artifacts); it stores
 * the history that status alone cannot reconstruct.
 *
 * @module dwguard-dsh-hmos/tools/harness
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_harness` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createHarnessTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
