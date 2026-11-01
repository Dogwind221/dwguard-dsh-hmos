/**
 * `dwguard_audit` — the independent delivery audit and its two exits.
 *
 * A passing audit writes the acceptance report; a failing one writes the rework
 * order and puts it on the outbox. There is no third exit: a partially verified
 * pack is a failure.
 *
 * @module dwguard-dsh-hmos/tools/audit
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_audit` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createAuditTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
