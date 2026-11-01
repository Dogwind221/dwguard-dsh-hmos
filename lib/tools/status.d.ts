/**
 * `dwguard_status` — where the round stands and what to do next.
 *
 * @module dwguard-dsh-hmos/tools/status
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_status` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createStatusTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
