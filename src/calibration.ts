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

import type { Check, Dimension, TaskPack } from './model.js';
import { DIMENSIONS, DIMENSION_LABELS } from './model.js';
import type { SharedPaths } from './paths.js';
import { appendText, readTextOrNull } from './util/fs.js';

/** One ledger line. */
export interface CalibrationRecord {
  readonly kind: 'audit' | 'confirm' | 'miss';
  readonly at: string;
  readonly specVersion: number;
  readonly round?: number;
  readonly auditId?: number;
  readonly pass?: boolean;
  readonly decision?: 'accept' | 'new_round';
  readonly dimension?: Dimension;
  readonly note?: string;
  /** Per-dimension verdict snapshot taken at audit time. */
  readonly dimensions?: Readonly<Record<string, { passed: number; failed: number; missing: number }>>;
}

/** Per-dimension calibration row. */
export interface CalibrationRow {
  readonly dimension: Dimension;
  readonly audits: number;
  readonly failedAudits: number;
  readonly misses: number;
  /** `misses / audits`, or `null` when there were no audits yet. */
  readonly missRate: number | null;
}

/** Build per-dimension verdicts from a pack + its checks. */
export function dimensionVerdicts(
  pack: TaskPack,
  checks: readonly Check[]
): Record<string, { passed: number; failed: number; missing: number }> {
  const byCriterion = new Map(checks.map((check) => [check.criterionId, check]));
  const result: Record<string, { passed: number; failed: number; missing: number }> = {};
  for (const dimension of DIMENSIONS) {
    let passed = 0;
    let failed = 0;
    let missing = 0;
    for (const criterion of pack.criteria) {
      if (criterion.dimension !== dimension) continue;
      const check = byCriterion.get(criterion.id);
      if (check === undefined) missing += 1;
      else if (check.result === 'pass') passed += 1;
      else if (check.result === 'fail') failed += 1;
      else missing += 1;
    }
    result[dimension] = { passed, failed, missing };
  }
  return result;
}

/** Append one line, creating the ledger. */
export async function appendCalibration(paths: SharedPaths, record: CalibrationRecord): Promise<void> {
  await appendText(paths.calibration, `${JSON.stringify(record)}\n`);
}

/** Read the ledger, tolerating blank/corrupt lines. */
export async function readCalibration(paths: SharedPaths): Promise<CalibrationRecord[]> {
  const raw = await readTextOrNull(paths.calibration);
  if (raw === null) return [];
  const records: CalibrationRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { kind?: unknown }).kind === 'string') {
        records.push(parsed as CalibrationRecord);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return records;
}

/** Aggregate the ledger into one row per dimension. */
export function summariseCalibration(records: readonly CalibrationRecord[]): CalibrationRow[] {
  const audits: Record<string, number> = {};
  const failed: Record<string, number> = {};
  const misses: Record<string, number> = {};
  for (const dimension of DIMENSIONS) {
    audits[dimension] = 0;
    failed[dimension] = 0;
    misses[dimension] = 0;
  }
  for (const record of records) {
    if (record.kind === 'audit' && record.pass === false && record.dimensions !== undefined) {
      for (const dimension of DIMENSIONS) {
        const entry = record.dimensions[dimension];
        if (entry !== undefined && (entry.failed > 0 || entry.missing > 0)) failed[dimension] = (failed[dimension] ?? 0) + 1;
      }
    }
    if (record.kind === 'audit' && record.dimensions !== undefined) {
      for (const dimension of DIMENSIONS) {
        const entry = record.dimensions[dimension];
        if (entry !== undefined && entry.passed + entry.failed > 0) audits[dimension] = (audits[dimension] ?? 0) + 1;
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
export function describeRow(row: CalibrationRow): string {
  const rate = row.missRate === null ? '—' : `${Math.round(row.missRate * 100)}%`;
  return `${DIMENSION_LABELS[row.dimension]}：审计 ${row.audits} 次 · 未过 ${row.failedAudits} 次 · 漏检 ${row.misses} 次（漏检率 ${rate}）`;
}
