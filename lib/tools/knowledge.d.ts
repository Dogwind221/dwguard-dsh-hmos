/**
 * `dwguard_knowledge` — sediment this round's lessons.
 *
 * @module dwguard-dsh-hmos/tools/knowledge
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_knowledge` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createKnowledgeTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
