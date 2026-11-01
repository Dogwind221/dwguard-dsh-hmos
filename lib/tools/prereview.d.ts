/**
 * `dwguard_prereview` — the adversarial pre-dispatch review record.
 *
 * @module dwguard-dsh-hmos/tools/prereview
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_prereview` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createPrereviewTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
