/**
 * The `.shared/` protocol layout, resolved once per tool call.
 *
 * @module dwguard-dsh-hmos/paths
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Every path the workflow touches inside one workspace. */
export interface SharedPaths {
  /** Agent session working directory. */
  readonly workspace: string;
  /** `<workspace>/.shared` (or the configured directory). */
  readonly shared: string;
  readonly tasksDir: string;
  readonly artifactsDir: string;
  readonly knowledgeDir: string;
  readonly outboxDsh: string;
  readonly outboxDeveco: string;
  readonly stateFile: string;
  readonly specJson: string;
  readonly specMd: string;
  readonly briefMd: string;
  /** Brief for a CLI executor (`executor: cli`). */
  readonly cliBriefMd: string;
  readonly questionMd: string;
  readonly knowledgeIndex: string;
  /** Per-dimension audit progress, written as each audit sub-agent returns. */
  readonly auditProgress: string;
  /** Append-only gate calibration ledger (`knowledge/calibration.jsonl`). */
  readonly calibration: string;
  /** Aesthetic preference profile (`knowledge/aesthetic-profile.md`, table + JSON fence). */
  readonly aestheticProfileMd: string;
  /** Append-only aesthetic history (`knowledge/aesthetic-history.jsonl`). */
  readonly aestheticHistory: string;
  /** Visual baselines, one directory per task-pack version. */
  readonly visualBaselineDir: string;
  /** Latest baseline comparison (`artifacts/aesthetic/compare-latest.json`). */
  readonly aestheticCompare: string;
  /** Aesthetic artifacts directory (`artifacts/aesthetic`). */
  readonly aestheticDir: string;
}

/**
 * Resolve the protocol layout for a workspace.
 * @param workspace - the agent session's cwd.
 * @param sharedDir - configured directory, relative (to the workspace) or absolute.
 */
export function resolvePaths(workspace: string, sharedDir: string): SharedPaths {
  const shared = isAbsolute(sharedDir) ? resolve(sharedDir) : resolve(workspace, sharedDir);
  return {
    workspace,
    shared,
    tasksDir: resolve(shared, 'tasks'),
    artifactsDir: resolve(shared, 'artifacts'),
    knowledgeDir: resolve(shared, 'knowledge'),
    outboxDsh: resolve(shared, 'outbox-dsh.md'),
    outboxDeveco: resolve(shared, 'outbox-deveco.md'),
    stateFile: resolve(shared, 'state.json'),
    specJson: resolve(shared, 'tasks', 'spec.json'),
    specMd: resolve(shared, 'tasks', 'spec.md'),
    briefMd: resolve(shared, 'tasks', 'goal-brief.md'),
    cliBriefMd: resolve(shared, 'tasks', 'cli-brief.md'),
    questionMd: resolve(shared, 'tasks', 'question.md'),
    knowledgeIndex: resolve(shared, 'knowledge', 'index.json'),
    auditProgress: resolve(shared, 'artifacts', 'audit-progress.json'),
    calibration: resolve(shared, 'knowledge', 'calibration.jsonl'),
    aestheticProfileMd: resolve(shared, 'knowledge', 'aesthetic-profile.md'),
    aestheticHistory: resolve(shared, 'knowledge', 'aesthetic-history.jsonl'),
    visualBaselineDir: resolve(shared, 'artifacts', 'visual-baseline'),
    aestheticCompare: resolve(shared, 'artifacts', 'aesthetic', 'compare-latest.json'),
    aestheticDir: resolve(shared, 'artifacts', 'aesthetic')
  };
}

/**
 * Render a path for model-facing output: workspace-relative POSIX when inside
 * the workspace, absolute otherwise.
 */
export function displayPath(paths: SharedPaths, file: string): string {
  const rel = relative(paths.workspace, file);
  if (rel.length === 0) return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return file;
  return rel.split(sep).join('/');
}
