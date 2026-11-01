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
import type { PluginContext, WorkingDirectoryService } from '../context.js';
import type { TaskPack } from '../model.js';
import type { SharedPaths } from '../paths.js';
import { resolvePaths } from '../paths.js';
import type { ValidationResult } from '../spec.js';
import { parseTaskPack, validateTaskPack } from '../spec.js';
import { readTextOrNull } from '../util/fs.js';
import { rememberWorkspace } from '../workspaces.js';
import { ArgError } from './args.js';

/** What every tool needs besides its arguments. */
export interface ToolDeps {
  readonly options: Options;
  readonly ctx?: PluginContext | undefined;
}

async function resolveWorkspace(exec: ToolRunContext, deps: ToolDeps, tool: string): Promise<string> {
  const service = deps.ctx?.get?.('workingDirectory') as WorkingDirectoryService | undefined;
  if (service !== undefined && exec.agent !== undefined) {
    try {
      const cwd = await service.ensure(exec.agent, exec.signal);
      if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd;
    } catch {
      // Fall through to the header value: a broken service must not hide the session's own cwd.
    }
  }
  const legacy = exec.agent?.session.header.cwd;
  if (typeof legacy === 'string' && legacy.trim().length > 0) return legacy;
  throw new ArgError(`${tool}: 需要在带工作区的 Agent 会话里运行（拿不到会话目录）。`);
}

/** Resolve the protocol layout for the calling session. */
export async function pathsOf(exec: ToolRunContext, deps: ToolDeps, tool: string): Promise<SharedPaths> {
  const workspace = await resolveWorkspace(exec, deps, tool);
  // Stamp the workspace so the DshHoms panel can list it before a session is open.
  await rememberWorkspace(workspace, new Date().toISOString()).catch(() => undefined);
  return resolvePaths(workspace, deps.options.sharedDir);
}

/** A loaded pack plus its validation, or `null` fields when there is no pack. */
export interface LoadedSpec {
  readonly pack: TaskPack | null;
  readonly validation: ValidationResult | null;
}

/** Read and validate `tasks/spec.json`. */
export async function loadSpec(paths: SharedPaths, options: Options): Promise<LoadedSpec> {
  const raw = await readTextOrNull(paths.specJson);
  const pack = parseTaskPack(raw);
  if (pack === null) return { pack: null, validation: null };
  return { pack, validation: validateTaskPack(pack, options) };
}

/** Load a pack, throwing when it is absent or invalid. */
export async function requireSpec(paths: SharedPaths, options: Options, tool: string): Promise<TaskPack> {
  const { pack, validation } = await loadSpec(paths, options);
  if (pack === null) {
    throw new ArgError(`${tool}: 还没有任务包。先用 \`dwguard_spec\`（action: write）写入。`);
  }
  if (validation !== null && validation.errors.length > 0) {
    throw new ArgError(
      `${tool}: 任务包不合法，先修这些问题：\n${validation.errors.map((issue) => `- ${issue.message}`).join('\n')}`
    );
  }
  return pack;
}

/** Render validation issues as a markdown bullet list. */
export function renderIssues(validation: ValidationResult): string {
  const lines: string[] = [];
  if (validation.errors.length > 0) {
    lines.push('**必须修复**', '', ...validation.errors.map((issue) => `- ${issue.message}`), '');
  }
  if (validation.warnings.length > 0) {
    lines.push('**建议改进**', '', ...validation.warnings.map((issue) => `- ${issue.message}`), '');
  }
  return lines.join('\n').trim();
}
