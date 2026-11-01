/**
 * `dwguard_confirm` — record the user's decision on an acceptance report.
 *
 * The framework's last diamond is "用户确认完成，还是提新要求？". Without a record
 * that is only chat text; this tool writes `artifacts/confirmation-<n>.json`,
 * stamps the user decision into `state.json`, and (for `new_round`) bumps the
 * iteration so the next `dwguard_spec` starts the next round.
 *
 * @module dwguard-dsh-hmos/tools/confirm
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_confirm` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createConfirmTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
