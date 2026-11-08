/**
 * Audit evidence bundles.
 *
 * A check can name files (screenshots, layout-tree dumps, log excerpts). This
 * module copies them into `artifacts/audit-<n>/evidence/`, records their SHA-256
 * in a manifest, and refuses paths outside `.shared/` — so a later reviewer can
 * prove which bytes backed which verdict.
 *
 * @module dwguard-dsh-hmos/evidence
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { extname, relative, resolve, isAbsolute } from 'node:path';

import type { Check } from './model.js';
import type { SharedPaths } from './paths.js';
import { ensureDir, fileExists, sha256File, writeTextAtomic } from './util/fs.js';

/** Caps keep a stray 200MB recording out of the audit bundle. */
const DEFAULT_PER_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 100 * 1024 * 1024;

/** One copied evidence file. */
export interface EvidenceFile {
  readonly criterionId: string;
  /** Path as given by the auditor, relative to `.shared/`. */
  readonly path: string;
  /** Location inside the bundle, e.g. `evidence/artifacts__shot.png`. */
  readonly storedAs: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** `artifacts/audit-<n>/manifest.json`. */
export interface EvidenceManifest {
  readonly schemaVersion: 1;
  readonly auditId: number;
  readonly specVersion: number;
  readonly generatedAt: string;
  readonly files: readonly EvidenceFile[];
  readonly checks: ReadonlyArray<{
    readonly criterionId: string;
    readonly result: string;
    readonly evidence: string;
    readonly evidenceFiles: readonly string[];
  }>;
}

/** Raised when an evidence path is missing or escapes the shared directory. */
export class EvidenceError extends Error {}

/** Bundle directory for one audit. */
export function bundleDir(paths: SharedPaths, auditId: number): string {
  return resolve(paths.artifactsDir, `audit-${auditId}`);
}

/** Resolve one evidence path, refusing anything outside `.shared/`. */
export function resolveSharedPath(paths: SharedPaths, file: string): string {
  if (isAbsolute(file)) throw new EvidenceError(`证据文件必须写相对 \`.shared/\` 的路径：${file}`);
  const source = resolve(paths.shared, file);
  const rel = relative(paths.shared, source);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new EvidenceError(`证据文件不能指到 \`.shared/\` 之外：${file}`);
  }
  // Sync realpath for callers that read immediately (aesthetic bounds, etc.).
  try {
    const sharedReal = realpathSync(paths.shared);
    const sourceReal = realpathSync(source);
    const realRel = relative(sharedReal, sourceReal);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new EvidenceError(`证据文件通过符号链接/Junction 指到 \`.shared/\` 之外：${file}`);
    }
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    // Missing files are reported by the caller's existence check.
  }
  return source;
}

/** Reject symlink/junction escapes after resolving the real path. */
async function assertRealInside(paths: SharedPaths, source: string, file: string): Promise<void> {
  const sharedReal = await realpath(paths.shared).catch(() => null);
  const sourceReal = await realpath(source).catch(() => null);
  if (sharedReal === null || sourceReal === null) return;
  const rel = relative(sharedReal, sourceReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new EvidenceError(`证据文件通过符号链接/Junction 指到 \`.shared/\` 之外：${file}`);
  }
}

/**
 * Check every referenced file exists before anything is written.
 * @returns missing paths, in input order.
 */
export async function missingEvidence(paths: SharedPaths, checks: readonly Check[]): Promise<string[]> {
  const missing: string[] = [];
  for (const check of checks) {
    for (const file of check.evidenceFiles ?? []) {
      const source = resolveSharedPath(paths, file);
      if (!(await fileExists(source))) {
        missing.push(file);
        continue;
      }
      await assertRealInside(paths, source, file);
    }
  }
  return missing;
}

/** Safe extension for a stored evidence file; unknown types become `.bin`. */
function safeExtension(file: string): string {
  const ext = extname(file).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
}

/** Write a copy exclusively (`wx`) and verify the bytes we wrote. */
async function copyFileExclusive(source: string, destination: string, expectedSha: string): Promise<number> {
  const data = await readFile(source);
  await writeFile(destination, data, { flag: 'wx' });
  const written = await readFile(destination);
  const sha = createHash('sha256').update(written).digest('hex');
  if (sha !== expectedSha || written.length !== data.length) {
    throw new EvidenceError(`证据复制后校验失败：${destination}`);
  }
  return written.length;
}

/**
 * Copy every referenced file into the bundle and write `manifest.json`.
 * @param paths - resolved protocol layout.
 * @param auditId - audit number (matches `audit-<n>.md`).
 * @param specVersion - pack version under audit.
 * @param checks - normalized checks carrying `evidenceFiles`.
 * @param now - ISO timestamp.
 * @param limits - optional size caps (tests use tiny values).
 */
export async function writeEvidenceBundle(
  paths: SharedPaths,
  auditId: number,
  specVersion: number,
  checks: readonly Check[],
  now: string,
  limits: { perFileBytes?: number; totalBytes?: number } = {}
): Promise<EvidenceManifest> {
  const perFileBytes = limits.perFileBytes ?? DEFAULT_PER_FILE_BYTES;
  const totalBytes = limits.totalBytes ?? DEFAULT_TOTAL_BYTES;
  const dir = bundleDir(paths, auditId);
  const evidenceDir = resolve(dir, 'evidence');
  await ensureDir(evidenceDir);

  const files: EvidenceFile[] = [];
  let copiedBytes = 0;
  for (const check of checks) {
    for (const file of check.evidenceFiles ?? []) {
      const source = resolveSharedPath(paths, file);
      const info = await stat(source).catch(() => null);
      if (info === null) throw new EvidenceError(`证据文件不存在：${file}`);
      await assertRealInside(paths, source, file);
      if (info.size > perFileBytes) {
        throw new EvidenceError(
          `证据文件过大：${file}（${info.size} B，单文件上限 ${perFileBytes} B）。请压缩或改存摘要。`
        );
      }
      if (copiedBytes + info.size > totalBytes) {
        throw new EvidenceError(
          `证据包超过总大小上限（${totalBytes} B）：加上 ${file} 会溢出。请只保留关键证据。`
        );
      }
      const sha256 = await sha256File(source);
      // The original path only lives in the manifest; the stored name is
      // collision-free and content-addressed.
      const storedAs = `evidence/${String(files.length + 1).padStart(6, '0')}-${sha256}${safeExtension(file)}`;
      const destination = resolve(dir, storedAs);
      const bytes = await copyFileExclusive(source, destination, sha256);
      copiedBytes += bytes;
      files.push({
        criterionId: check.criterionId,
        path: file,
        storedAs,
        sha256,
        bytes
      });
    }
  }

  const manifest: EvidenceManifest = {
    schemaVersion: 1,
    auditId,
    specVersion,
    generatedAt: now,
    files,
    checks: checks.map((check) => ({
      criterionId: check.criterionId,
      result: check.result,
      evidence: check.evidence,
      evidenceFiles: [...(check.evidenceFiles ?? [])]
    }))
  };
  await writeTextAtomic(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
