/**
 * Best-effort bridge to the `dsh-deveco` UI-tree tool.
 *
 * DSH's tool registry is not a public plugin SDK, so this module duck-types the
 * registry: if the host exposes an execution surface (`execute` or `get(name)`),
 * `dwguard_shadow` can pull a structured UI tree without the agent having to
 * export a file by hand. Any mismatch simply returns `null` and the manual
 * `uiTree` path keeps working.
 *
 * @module dwguard-dsh-hmos/deveco
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { PluginContext } from './context.js';
/**
 * Try to call `harmony_ui_tree` through whatever registry surface exists.
 * @param ctx - plugin context (optional service lookup).
 * @param exec - the current tool run context (forwarded to the nested call).
 * @returns the tree text/JSON, or `null` when the tool is unavailable.
 */
export declare function captureHarmonyUiTree(ctx: PluginContext | undefined, exec: ToolRunContext): Promise<string | null>;
