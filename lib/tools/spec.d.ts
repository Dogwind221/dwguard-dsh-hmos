/**
 * `dwguard_spec` — freeze (or inspect) the task pack.
 *
 * @module dwguard-dsh-hmos/tools/spec
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_spec` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createSpecTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
