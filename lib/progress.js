/**
 * Per-dimension audit progress.
 *
 * Four independent sub-agents gather evidence for one dimension each. Recording
 * each dimension as it returns lets the panel show four cards landing one by one
 * instead of all at once — the visible difference between "running" and "done".
 *
 * @module dwguard-dsh-hmos/progress
 */
import { rm } from 'node:fs/promises';
import { DIMENSIONS, isDimension } from './model.js';
import { ensureDir, listDir, readTextOrNull, removeFile, writeTextAtomic } from './util/fs.js';
/** Read the progress document, or `null` when absent/unreadable. */
export async function readAuditProgress(paths) {
    const versions = (await listDir(paths.auditProgressDir))
        .map((name) => ({ name, version: Number.parseInt(name, 10) }))
        .filter((item) => Number.isFinite(item.version))
        .sort((left, right) => right.version - left.version);
    for (const entry of versions) {
        const dims = {};
        let updatedAt = '';
        for (const dimension of DIMENSIONS) {
            const raw = await readTextOrNull(`${paths.auditProgressDir}/${entry.name}/${dimension}.json`);
            if (raw === null)
                continue;
            try {
                const value = JSON.parse(raw);
                if (typeof value !== 'object' || value === null)
                    continue;
                dims[dimension] = {
                    state: value.state === 'failed' ? 'failed' : 'done',
                    passed: typeof value.passed === 'number' ? value.passed : 0,
                    failed: typeof value.failed === 'number' ? value.failed : 0,
                    ...(typeof value.note === 'string' ? { note: value.note } : {}),
                    at: typeof value.at === 'string' ? value.at : ''
                };
                if (typeof value.at === 'string' && value.at > updatedAt)
                    updatedAt = value.at;
            }
            catch {
                /* skip corrupt dimension file */
            }
        }
        if (Object.keys(dims).length > 0) {
            return { schemaVersion: 1, specVersion: entry.version, updatedAt, dims };
        }
    }
    // Legacy single-file progress (read-only compatibility).
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
    // One file per dimension: four sub-agents never read-merge-write a shared doc.
    const dir = `${paths.auditProgressDir}/${specVersion}`;
    await ensureDir(dir);
    const entry = {
        state: failed > 0 ? 'failed' : 'done',
        passed,
        failed,
        ...(note === undefined ? {} : { note }),
        at: now
    };
    await writeTextAtomic(`${dir}/${dimension}.json`, `${JSON.stringify(entry, null, 2)}\n`);
    return (await readAuditProgress(paths)) ?? {
        schemaVersion: 1,
        specVersion,
        updatedAt: now,
        dims: { [dimension]: entry }
    };
}
/** Drop one version's progress directory (after the final audit recorded all four). */
export async function clearAuditProgress(paths, specVersion) {
    if (specVersion === undefined) {
        await removeFile(paths.auditProgress);
        return;
    }
    const target = `${paths.auditProgressDir}/${specVersion}`;
    await rm(target, { recursive: true, force: true });
    await removeFile(paths.auditProgress);
}
/** Dimensions that already returned for this pack version. */
export function returnedDimensions(progress, specVersion) {
    if (progress === null || progress.specVersion !== specVersion)
        return [];
    return DIMENSIONS.filter((dimension) => progress.dims[dimension] !== undefined);
}
