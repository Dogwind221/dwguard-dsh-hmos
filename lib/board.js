/**
 * The panel board: a compact, client-facing projection of one workspace's
 * DwGuard round. Everything here is derived from `.shared/` on every request,
 * so the panel never shows a stale copy of its own.
 *
 * @module dwguard-dsh-hmos/board
 */
import { readHistory } from './history.js';
import { DIMENSIONS, DIMENSION_LABELS } from './model.js';
import { resolvePaths } from './paths.js';
import { readAuditProgress } from './progress.js';
import { criteriaByDimension } from './spec.js';
import { collectSnapshot, phaseLabel } from './status.js';
import { fileExists, listDir } from './util/fs.js';
import { workspaceName } from './workspaces.js';
async function latestRework(paths) {
    const entries = await listDir(paths.tasksDir);
    let max = 0;
    for (const entry of entries) {
        const match = /^rework-(\d+)\.md$/.exec(entry);
        if (match?.[1] === undefined)
            continue;
        const value = Number.parseInt(match[1], 10);
        if (Number.isFinite(value) && value > max)
            max = value;
    }
    return max;
}
/**
 * Build the board for one workspace.
 * @param workspace - absolute workspace path.
 * @param options - resolved plugin options.
 * @param now - ISO timestamp used when repairing state.
 * @returns the board, or `null` when the workspace has no task pack yet.
 */
export async function readBoard(workspace, options, now) {
    const paths = resolvePaths(workspace, options.sharedDir);
    const snapshot = await collectSnapshot(paths, options, now);
    const pack = snapshot.spec;
    if (pack === null)
        return null;
    const grouped = criteriaByDimension(pack);
    const checks = snapshot.audit?.value.checks ?? [];
    const byCriterion = new Map(checks.map((check) => [check.criterionId, check]));
    const latestAudit = snapshot.audit?.value ?? null;
    const latestPrereview = snapshot.prereview?.value ?? null;
    const progress = await readAuditProgress(paths);
    const progressDims = progress !== null && progress.specVersion === pack.specVersion ? progress.dims : {};
    const auditActive = snapshot.phase === 'dispatched' && snapshot.unread.length > 0;
    const dimensions = DIMENSIONS.map((dimension) => {
        const criteria = grouped[dimension];
        const progressEntry = progressDims[dimension];
        let passed = 0;
        let failed = 0;
        let unverified = 0;
        if (latestAudit !== null) {
            for (const criterion of criteria) {
                const check = byCriterion.get(criterion.id);
                if (check === undefined)
                    continue;
                if (check.result === 'pass')
                    passed += 1;
                else if (check.result === 'fail')
                    failed += 1;
                else
                    unverified += 1;
            }
        }
        else if (progressEntry !== undefined) {
            passed = Math.min(progressEntry.passed, criteria.length);
            failed = Math.min(progressEntry.failed, Math.max(0, criteria.length - passed));
        }
        let state;
        if (latestAudit !== null) {
            state = failed > 0 ? 'failed' : criteria.length > 0 && passed === criteria.length ? 'done' : 'pending';
        }
        else if (progressEntry !== undefined) {
            state = progressEntry.state;
        }
        else if (auditActive) {
            state = 'active';
        }
        else {
            state = 'pending';
        }
        return {
            key: dimension,
            label: DIMENSION_LABELS[dimension],
            total: criteria.length,
            must: criteria.filter((criterion) => criterion.weight === 'must').length,
            passed,
            failed,
            unverified,
            missing: Math.max(0, criteria.length - passed - failed - unverified),
            state
        };
    });
    const mustCriteria = pack.criteria.filter((criterion) => criterion.weight === 'must');
    const mustPassed = mustCriteria.filter((criterion) => byCriterion.get(criterion.id)?.result === 'pass').length;
    return {
        workspace,
        name: workspaceName(workspace),
        phase: snapshot.phase,
        phaseLabel: phaseLabel(snapshot.phase),
        title: pack.title,
        specVersion: pack.specVersion,
        iteration: pack.iteration,
        updatedAt: pack.updatedAt,
        criteria: { total: pack.criteria.length, must: mustCriteria.length, mustPassed },
        dimensions,
        prereview: latestPrereview === null
            ? null
            : {
                id: snapshot.prereview?.index ?? 0,
                pass: latestPrereview.gate.pass,
                blockers: latestPrereview.findings.filter((finding) => finding.severity === 'blocker' && (finding.status ?? 'open') === 'open').length
            },
        audit: latestAudit === null
            ? null
            : { id: snapshot.audit?.index ?? 0, pass: latestAudit.gate.pass, errors: latestAudit.gate.errors.length },
        unread: snapshot.unread.length,
        next: snapshot.nextAction,
        nextEn: snapshot.nextActionEn,
        history: await readHistory(paths, 10),
        files: {
            spec: await fileExists(paths.specMd),
            brief: await fileExists(paths.briefMd),
            report: await fileExists(`${paths.artifactsDir}/acceptance-report.md`),
            rework: await latestRework(paths)
        }
    };
}
