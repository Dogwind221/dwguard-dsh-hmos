/**
 * Which workspaces the DwGuard tools have touched.
 *
 * The panel needs a workspace list before any session in it is open, so every
 * tool call stamps its workspace into a small registry under the DSH home. The
 * 10-minute throttle keeps the file write off the hot path.
 *
 * @module dwguard-dsh-hmos/workspaces
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readTextOrNull, writeTextAtomic } from './util/fs.js';
const MAX_WORKSPACES = 20;
const REFRESH_AFTER_MS = 10 * 60 * 1000;
function dshHome() {
    const configured = process.env['DSH_HOME'];
    if (typeof configured === 'string' && configured.trim().length > 0)
        return configured.trim();
    return join(homedir(), '.dsh');
}
/** Registry file path (`<dshHome>/dwguard/workspaces.json`). */
export function registryFile() {
    return join(dshHome(), 'dwguard', 'workspaces.json');
}
/** Display name of a workspace directory. */
export function workspaceName(path) {
    const name = basename(path);
    return name.length > 0 ? name : path;
}
/** Remembered workspaces, newest first. */
export async function listWorkspaces() {
    const raw = await readTextOrNull(registryFile());
    if (raw === null)
        return [];
    try {
        const parsed = JSON.parse(raw);
        const entries = parsed.workspaces;
        if (!Array.isArray(entries))
            return [];
        const records = [];
        for (const entry of entries) {
            if (typeof entry !== 'object' || entry === null)
                continue;
            const record = entry;
            if (typeof record['path'] !== 'string' || typeof record['lastSeen'] !== 'string')
                continue;
            // A deleted workspace (temp test dir, moved project) must not linger in the
            // panel's selector — the board would then open onto a dead path.
            if (!existsSync(record['path']))
                continue;
            records.push({ path: record['path'], lastSeen: record['lastSeen'] });
        }
        return records;
    }
    catch {
        return [];
    }
}
/**
 * Record that a workspace is in use, at most once per throttle window.
 * @param workspace - absolute workspace path.
 * @param now - ISO timestamp.
 */
export async function rememberWorkspace(workspace, now) {
    const records = await listWorkspaces();
    const existing = records.find((record) => record.path === workspace);
    if (existing !== undefined) {
        const seen = Date.parse(existing.lastSeen);
        if (Number.isFinite(seen) && Date.now() - seen < REFRESH_AFTER_MS)
            return;
    }
    const next = [{ path: workspace, lastSeen: now }, ...records.filter((record) => record.path !== workspace)]
        .slice(0, MAX_WORKSPACES);
    await writeTextAtomic(registryFile(), `${JSON.stringify({ schemaVersion: 1, workspaces: next }, null, 2)}\n`);
}
