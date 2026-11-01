/**
 * `dwguard_dispatch` — build the Goal-mode brief and hand the pack over.
 *
 * @module dwguard-dsh-hmos/tools/dispatch
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_dispatch` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createDispatchTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
