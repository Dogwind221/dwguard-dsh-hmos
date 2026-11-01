/**
 * Shared plumbing for the six tools: workspace resolution, spec loading, and
 * issue rendering.
 *
 * dsh 0.2 resolves the session's working directory through the
 * `workingDirectory` service (a session can change directory); older builds
 * only carry it in the session header. Both are tried, service first.
 *
 * @module dwguard-dsh-hmos/tools/common
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import type { TaskPack } from '../model.js';
import type { SharedPaths } from '../paths.js';
import type { ValidationResult } from '../spec.js';
/** What every tool needs besides its arguments. */
export interface ToolDeps {
    readonly options: Options;
    readonly ctx?: PluginContext | undefined;
}
/** Resolve the protocol layout for the calling session. */
export declare function pathsOf(exec: ToolRunContext, deps: ToolDeps, tool: string): Promise<SharedPaths>;
/** A loaded pack plus its validation, or `null` fields when there is no pack. */
export interface LoadedSpec {
    readonly pack: TaskPack | null;
    readonly validation: ValidationResult | null;
}
/** Read and validate `tasks/spec.json`. */
export declare function loadSpec(paths: SharedPaths, options: Options): Promise<LoadedSpec>;
/** Load a pack, throwing when it is absent or invalid. */
export declare function requireSpec(paths: SharedPaths, options: Options, tool: string): Promise<TaskPack>;
/** Render validation issues as a markdown bullet list. */
export declare function renderIssues(validation: ValidationResult): string;
