/**
 * DwGuard-Dsh-Hmos — the DSH half of a HarmonyOS dual-agent workflow.
 *
 * One host row registers fourteen tools, three skills and one team-policy prompt
 * section. The tools are the stage gates; the skills carry the methodology; the
 * section states the one rule that matters: DSH orchestrates and audits, it
 * does not write the app.
 *
 * @module dwguard-dsh-hmos
 */
import type { PluginContext } from './context.js';
/** Cordis plugin name. */
export declare const name = "dwguard-hmos";
/**
 * Only the tool registry is mandatory. The skill registry and the prompt
 * registry are resolved optionally through `ctx.get`, so the plugin still loads
 * in a composition that mounts neither.
 */
export declare const inject: string[];
export { Config } from './config.js';
/**
 * Register the DwGuard capabilities.
 * @param ctx - plugin context carrying the tool registry (and optionally skills / systemPrompt).
 * @param config - the row's `config` block, already defaulted by the loader.
 */
export declare function apply(ctx: PluginContext, config?: unknown): void;
