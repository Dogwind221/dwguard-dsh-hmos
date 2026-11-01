/**
 * Persisted protocol state (`.shared/state.json`) and artifact numbering.
 *
 * @module dwguard-dsh-hmos/state
 */

import type { SharedState } from './model.js';
import { emptyState } from './model.js';
import type { SharedPaths } from './paths.js';
import { listDir, readTextOrNull, writeTextAtomic } from './util/fs.js';

/**
 * Read the state document, repairing missing or corrupt fields in memory.
 * @param paths - resolved protocol layout.
 * @param now - ISO timestamp used for a repaired document.
 */
export async function readState(paths: SharedPaths, now: string): Promise<SharedState> {
  const raw = await readTextOrNull(paths.stateFile);
  if (raw === null) return emptyState(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState(now);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyState(now);
  const record = parsed as Record<string, unknown>;
  const base = emptyState(now);
  const num = (key: string, fallback: number): number => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
  };
  return {
    schemaVersion: 1,
    iteration: num('iteration', base.iteration),
    specVersion: num('specVersion', base.specVersion),
    prereviews: num('prereviews', base.prereviews),
    dispatches: num('dispatches', base.dispatches),
    audits: num('audits', base.audits),
    roundDispatches: num('roundDispatches', 0),
    roundAudits: num('roundAudits', 0),
    inboxCursor: num('inboxCursor', base.inboxCursor),
    shadowRuns: num('shadowRuns', base.shadowRuns ?? 0),
    ...(typeof record['lastShadowAt'] === 'string' ? { lastShadowAt: record['lastShadowAt'] } : {}),
    ...(typeof record['lastDevecoAt'] === 'string' ? { lastDevecoAt: record['lastDevecoAt'] } : {}),
    confirmations: num('confirmations', base.confirmations ?? 0),
    ...(typeof record['confirmedAt'] === 'string' ? { confirmedAt: record['confirmedAt'] } : {}),
    ...(typeof record['confirmedSpecVersion'] === 'number'
      ? { confirmedSpecVersion: Math.trunc(record['confirmedSpecVersion']) }
      : {}),
    phase: typeof record['phase'] === 'string' ? record['phase'] : base.phase,
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : now
  };
}

/** Persist the state document. */
export async function writeState(paths: SharedPaths, state: SharedState): Promise<void> {
  await writeTextAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Read-modify-write the state document.
 * @param paths - resolved protocol layout.
 * @param now - ISO timestamp for `updatedAt`.
 * @param mutate - receives the current state and returns the next one.
 */
export async function updateState(
  paths: SharedPaths,
  now: string,
  mutate: (state: SharedState) => SharedState
): Promise<SharedState> {
  const current = await readState(paths, now);
  const next = { ...mutate(current), updatedAt: now };
  await writeState(paths, next);
  return next;
}

/**
 * Next free numeric suffix for `<prefix>-<n>` files in a directory.
 * @param dir - directory to scan.
 * @param prefix - file stem before the dash.
 */
export async function nextIndex(dir: string, prefix: string): Promise<number> {
  const entries = await listDir(dir);
  let max = 0;
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.(?:md|json)$`);
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match?.[1] === undefined) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

/** Latest numbered artifact of one kind, as parsed JSON. */
export async function readLatestJson<T>(
  dir: string,
  prefix: string
): Promise<{ index: number; value: T; file: string } | null> {
  const entries = await listDir(dir);
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.json$`);
  const found: Array<{ index: number; file: string }> = [];
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match?.[1] === undefined) continue;
    const index = Number.parseInt(match[1], 10);
    if (Number.isFinite(index)) found.push({ index, file: `${dir}/${entry}` });
  }
  found.sort((a, b) => b.index - a.index);
  const newest = found[0];
  if (newest === undefined) return null;
  const raw = await readTextOrNull(newest.file);
  if (raw === null) return null;
  try {
    return { index: newest.index, value: JSON.parse(raw) as T, file: newest.file };
  } catch {
    return null;
  }
}
