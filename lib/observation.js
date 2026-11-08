/**
 * Collector observations (0.8.5).
 *
 * A device collector writes one observation file per evidence capture. An audit
 * can reference it via `actual.observationRef`; the gate then checks that the
 * observation exists, belongs to the declared device, and (when present) was
 * captured for the current spec version.
 *
 * @module dwguard-dsh-hmos/observation
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ensureDir, readTextOrNull, sha256File, writeTextAtomic } from './util/fs.js';
const OBSERVATION_ID = /^obs-[a-zA-Z0-9_-]{6,80}$/;
/** Directory for collector observations. */
export function observationDir(paths) {
    return resolve(paths.shared, 'observations');
}
/** One observation file; ids are validated as safe filenames. */
export function observationFile(paths, id) {
    if (!OBSERVATION_ID.test(id))
        throw new Error(`observationRef 非法：${id}`);
    return resolve(observationDir(paths), `${id}.json`);
}
/** Record a collector observation; returns its id. */
export async function recordObservation(paths, input, now) {
    const files = [];
    for (const file of input.files) {
        files.push({ path: file, sha256: await sha256File(file) });
    }
    const digest = createHash('sha256')
        .update(`${input.action}|${input.device ?? ''}|${now}|${files.map((file) => `${file.path}:${file.sha256}`).join('|')}`)
        .digest('hex')
        .slice(0, 12);
    const id = `obs-${digest}`;
    const observation = {
        schemaVersion: 1,
        id,
        at: now,
        ...(input.device === undefined ? {} : { device: input.device }),
        action: input.action,
        ...(input.specVersion === undefined ? {} : { specVersion: input.specVersion }),
        files
    };
    await ensureDir(observationDir(paths));
    await writeTextAtomic(observationFile(paths, id), `${JSON.stringify(observation, null, 2)}\n`);
    return id;
}
/** Read an observation; null when missing/corrupt. */
export async function readObservation(paths, id) {
    let file;
    try {
        file = observationFile(paths, id);
    }
    catch {
        return null;
    }
    const raw = await readTextOrNull(file);
    if (raw === null)
        return null;
    try {
        const value = JSON.parse(raw);
        if (value.schemaVersion !== 1 || value.id !== id || typeof value.action !== 'string' || !Array.isArray(value.files)) {
            return null;
        }
        return {
            schemaVersion: 1,
            id: value.id,
            at: typeof value.at === 'string' ? value.at : '',
            ...(typeof value.device === 'string' ? { device: value.device } : {}),
            action: value.action,
            ...(typeof value.specVersion === 'number' ? { specVersion: value.specVersion } : {}),
            files: value.files.filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.path === 'string' && typeof entry.sha256 === 'string')
        };
    }
    catch {
        return null;
    }
}
