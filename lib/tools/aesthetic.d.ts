/**
 * `dwguard_aesthetic` — the 0.6.1 aesthetic learning tool.
 *
 * Four actions, one gate: `learn` proposes, the user chooses, `apply` writes.
 * `baseline` only saves after a passing audit and a user confirmation; `compare`
 * turns a layout dump into numeric diffs, never pixel guesses.
 *
 * @module dwguard-dsh-hmos/tools/aesthetic
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import type { AestheticProfile } from '../aesthetic.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_aesthetic` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createAestheticTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
export type { AestheticProfile };
