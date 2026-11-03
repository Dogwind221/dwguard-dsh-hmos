/**
 * `dwguard_design` — the 0.6.2 P0 design-library tool.
 *
 * Three actions only for P0: `library init` / `library ingest` / `library list`,
 * plus `search` and `stats`. The design brief, DevEco request/answer channel and
 * `designRefs` gate are P1/P2 of the 0.6.2 plan.
 *
 * @module dwguard-dsh-hmos/tools/design
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_design` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createDesignTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
