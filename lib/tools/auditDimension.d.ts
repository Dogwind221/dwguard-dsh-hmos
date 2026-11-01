/**
 * `dwguard_audit_dimension` — record one audit dimension as its sub-agent returns.
 *
 * The four dimensions are audited in parallel by four sub-agents; this tool is
 * the point where a finished one becomes visible, so the panel can light the
 * cards up one by one instead of all at once.
 *
 * @module dwguard-dsh-hmos/tools/audit-dimension
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the per-dimension audit progress tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createAuditDimensionTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
