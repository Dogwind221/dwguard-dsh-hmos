/**
 * Gate calibration ledger.
 *
 * Every audit, every confirmation and every later "this passed but the user
 * found a bug" report is appended to `knowledge/calibration.jsonl`. The report
 * then shows, per dimension, how often the gate was right — the thing a rule
 * corpus alone can never tell you.
 *
 * @module dwguard-dsh-hmos/calibration
 */
import { DIMENSIONS, DIMENSION_LABELS } from './model.js';
import { appendText, readTextOrNull } from './util/fs.js';
/** Build per-dimension verdicts from a pack + its checks. */
export function dimensionVerdicts(pack, checks) {
    const byCriterion = new Map(checks.map((check) => [check.criterionId, check]));
    const result = {};
    for (const dimension of DIMENSIONS) {
        let passed = 0;
        let failed = 0;
        let missing = 0;
        for (const criterion of pack.criteria) {
            if (criterion.dimension !== dimension)
                continue;
            const check = byCriterion.get(criterion.id);
            if (check === undefined)
                missing += 1;
            else if (check.result === 'pass')
                passed += 1;
            else if (check.result === 'fail')
                failed += 1;
            else
                missing += 1;
        }
        result[dimension] = { passed, failed, missing };
    }
    return result;
}
/** Append one line, creating the ledger. */
export async function appendCalibration(paths, record) {
    await appendText(paths.calibration, `${JSON.stringify(record)}\n`);
}
/** Read the ledger, tolerating blank/corrupt lines. */
export async function readCalibration(paths) {
    const raw = await readTextOrNull(paths.calibration);
    if (raw === null)
        return [];
    const records = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null && typeof parsed.kind === 'string') {
                records.push(parsed);
            }
        }
        catch {
            /* skip corrupt line */
        }
    }
    return records;
}
/** Aggregate the ledger into one row per dimension. */
export function summariseCalibration(records) {
    const audits = {};
    const failed = {};
    const misses = {};
    for (const dimension of DIMENSIONS) {
        audits[dimension] = 0;
        failed[dimension] = 0;
        misses[dimension] = 0;
    }
    for (const record of records) {
        if (record.kind === 'audit' && record.pass === false && record.dimensions !== undefined) {
            for (const dimension of DIMENSIONS) {
                const entry = record.dimensions[dimension];
                if (entry !== undefined && (entry.failed > 0 || entry.missing > 0))
                    failed[dimension] = (failed[dimension] ?? 0) + 1;
            }
        }
        if (record.kind === 'audit' && record.dimensions !== undefined) {
            for (const dimension of DIMENSIONS) {
                const entry = record.dimensions[dimension];
                if (entry !== undefined && entry.passed + entry.failed > 0)
                    audits[dimension] = (audits[dimension] ?? 0) + 1;
            }
        }
        if (record.kind === 'miss' && record.dimension !== undefined) {
            misses[record.dimension] = (misses[record.dimension] ?? 0) + 1;
        }
    }
    return DIMENSIONS.map((dimension) => ({
        dimension,
        audits: audits[dimension] ?? 0,
        failedAudits: failed[dimension] ?? 0,
        misses: misses[dimension] ?? 0,
        missRate: (audits[dimension] ?? 0) === 0 ? null : (misses[dimension] ?? 0) / (audits[dimension] ?? 1)
    }));
}
/** One-line human summary of a row. */
export function describeRow(row) {
    const rate = row.missRate === null ? '—' : `${Math.round(row.missRate * 100)}%`;
    return `${DIMENSION_LABELS[row.dimension]}：审计 ${row.audits} 次 · 未过 ${row.failedAudits} 次 · 漏检 ${row.misses} 次（漏检率 ${rate}）`;
}
