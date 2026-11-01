/**
 * `dwguard_scan` — independent ArkTS/ArkUI static checks for the audit.
 *
 * Runs over the workspace (read-only), writes `artifacts/scan-<n>.json`, and
 * returns rule-ID findings with file:line evidence. The audit skill folds
 * `must` hits into the delivery findings, so "I read the code" stops being the
 * only code evidence.
 *
 * @module dwguard-dsh-hmos/tools/scan
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_scan` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createScanTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
