/**
 * The `.shared/` protocol layout, resolved once per tool call.
 *
 * @module dwguard-dsh-hmos/paths
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
/**
 * Resolve the protocol layout for a workspace.
 * @param workspace - the agent session's cwd.
 * @param sharedDir - configured directory, relative (to the workspace) or absolute.
 */
export function resolvePaths(workspace, sharedDir) {
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
export function displayPath(paths, file) {
    const rel = relative(paths.workspace, file);
    if (rel.length === 0)
        return '.';
    if (rel.startsWith('..') || isAbsolute(rel))
        return file;
    return rel.split(sep).join('/');
}
