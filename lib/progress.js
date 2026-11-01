/**
 * Per-dimension audit progress.
 *
 * Four independent sub-agents gather evidence for one dimension each. Recording
 * each dimension as it returns lets the panel show four cards landing one by one
 * instead of all at once — the visible difference between "running" and "done".
 *
 * @module dwguard-dsh-hmos/progress
 */
import { DIMENSIONS, isDimension } from './model.js';
import { readTextOrNull, removeFile, writeTextAtomic } from './util/fs.js';
/** Read the progress document, or `null` when absent/unreadable. */
export async function readAuditProgress(paths) {
    const raw = await readTextOrNull(paths.auditProgress);
    if (raw === null)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const record = parsed;
        const dims = {};
        const source = record['dims'];
        if (typeof source === 'object' && source !== null) {
            for (const [key, value] of Object.entries(source)) {
                if (!isDimension(key) || typeof value !== 'object' || value === null)
                    continue;
                const entry = value;
                dims[key] = {
                    state: entry['state'] === 'failed' ? 'failed' : 'done',
                    passed: typeof entry['passed'] === 'number' ? entry['passed'] : 0,
                    failed: typeof entry['failed'] === 'number' ? entry['failed'] : 0,
                    ...(typeof entry['note'] === 'string' ? { note: entry['note'] } : {}),
                    at: typeof entry['at'] === 'string' ? entry['at'] : ''
                };
            }
        }
        return {
            schemaVersion: 1,
            specVersion: typeof record['specVersion'] === 'number' ? record['specVersion'] : 0,
            updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
            dims
        };
    }
    catch {
        return null;
    }
}
/**
 * Record one returned dimension, keeping the others as they were.
 * @param paths - resolved protocol layout.
 * @param specVersion - the pack version this audit runs against.
 * @param dimension - which dimension returned.
 * @param passed - criteria that passed in this dimension.
 * @param failed - criteria that failed in this dimension.
 * @param note - optional one-liner for the card.
 * @param now - ISO timestamp.
 */
export async function recordDimension(paths, specVersion, dimension, passed, failed, note, now) {
    const existing = await readAuditProgress(paths);
    const base = existing !== null && existing.specVersion === specVersion ? existing.dims : {};
    const dims = {
        ...base,
        [dimension]: {
            state: failed > 0 ? 'failed' : 'done',
            passed,
            failed,
            ...(note === undefined ? {} : { note }),
            at: now
        }
    };
    const progress = { schemaVersion: 1, specVersion, updatedAt: now, dims };
    await writeTextAtomic(paths.auditProgress, `${JSON.stringify(progress, null, 2)}\n`);
    return progress;
}
/** Drop the progress document (after the final audit recorded all four). */
export async function clearAuditProgress(paths) {
    await removeFile(paths.auditProgress);
}
/** Dimensions that already returned for this pack version. */
export function returnedDimensions(progress, specVersion) {
    if (progress === null || progress.specVersion !== specVersion)
        return [];
    return DIMENSIONS.filter((dimension) => progress.dims[dimension] !== undefined);
}
