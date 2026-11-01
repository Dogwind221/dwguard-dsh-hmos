/**
 * `dwguard_shadow` — one shadow-review round during DevEco's execution.
 *
 * Increment ② in the framework is a *parallel, read-only* reviewer: it scans the
 * code and, when available, records the structured UI tree, then reports risks
 * without touching the app. `dwguard_status` nudges when the last round is older
 * than `shadowIntervalMinutes`, which is what makes the review "continuous"
 * without a background process.
 *
 * @module dwguard-dsh-hmos/tools/shadow
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_shadow` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createShadowTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
