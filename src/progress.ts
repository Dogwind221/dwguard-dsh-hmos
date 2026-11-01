/**
 * Per-dimension audit progress.
 *
 * Four independent sub-agents gather evidence for one dimension each. Recording
 * each dimension as it returns lets the panel show four cards landing one by one
 * instead of all at once — the visible difference between "running" and "done".
 *
 * @module dwguard-dsh-hmos/progress
 */

import type { Dimension } from './model.js';
import { DIMENSIONS, isDimension } from './model.js';
import type { SharedPaths } from './paths.js';
import { readTextOrNull, removeFile, writeTextAtomic } from './util/fs.js';

/** One dimension's returned result. */
export interface DimensionProgress {
  /** `failed` wins over `done` when any criterion in the dimension failed. */
  readonly state: 'done' | 'failed';
  readonly passed: number;
  readonly failed: number;
  readonly note?: string;
  readonly at: string;
}

/** The progress document. */
export interface AuditProgress {
  readonly schemaVersion: 1;
  readonly specVersion: number;
  readonly updatedAt: string;
  readonly dims: Readonly<Partial<Record<Dimension, DimensionProgress>>>;
}

/** Read the progress document, or `null` when absent/unreadable. */
export async function readAuditProgress(paths: SharedPaths): Promise<AuditProgress | null> {
  const raw = await readTextOrNull(paths.auditProgress);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const dims: Partial<Record<Dimension, DimensionProgress>> = {};
    const source = record['dims'];
    if (typeof source === 'object' && source !== null) {
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (!isDimension(key) || typeof value !== 'object' || value === null) continue;
        const entry = value as Record<string, unknown>;
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
  } catch {
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
export async function recordDimension(
  paths: SharedPaths,
  specVersion: number,
  dimension: Dimension,
  passed: number,
  failed: number,
  note: string | undefined,
  now: string
): Promise<AuditProgress> {
  const existing = await readAuditProgress(paths);
  const base = existing !== null && existing.specVersion === specVersion ? existing.dims : {};
  const dims: Partial<Record<Dimension, DimensionProgress>> = {
    ...base,
    [dimension]: {
      state: failed > 0 ? 'failed' : 'done',
      passed,
      failed,
      ...(note === undefined ? {} : { note }),
      at: now
    }
  };
  const progress: AuditProgress = { schemaVersion: 1, specVersion, updatedAt: now, dims };
  await writeTextAtomic(paths.auditProgress, `${JSON.stringify(progress, null, 2)}\n`);
  return progress;
}

/** Drop the progress document (after the final audit recorded all four). */
export async function clearAuditProgress(paths: SharedPaths): Promise<void> {
  await removeFile(paths.auditProgress);
}

/** Dimensions that already returned for this pack version. */
export function returnedDimensions(progress: AuditProgress | null, specVersion: number): Dimension[] {
  if (progress === null || progress.specVersion !== specVersion) return [];
  return DIMENSIONS.filter((dimension) => progress.dims[dimension] !== undefined);
}
