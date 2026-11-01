/**
 * Local official-docs corpus search.
 *
 * The corpus is fetched outside the plugin package (Huawei design docs via
 * scripts/fetch-official-docs.mjs plus a sparse clone of openharmony/docs).
 * `dwguard_rules search` uses this module so a sub-agent can look up the
 * official wording without knowing any path.
 *
 * @module dwguard-dsh-hmos/docs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';

/** One matching line. */
export interface DocHit {
  /** Path relative to the corpus root. */
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  /** `source:` frontmatter comment, when the page was fetched with one. */
  readonly sourceUrl?: string;
}

/** Search outcome. */
export interface DocSearch {
  readonly root: string;
  readonly files: number;
  readonly matches: number;
  readonly hits: readonly DocHit[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILES = 4000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Candidate corpus locations, in priority order. */
export function docsCandidates(configured: string, workspace: string): string[] {
  const candidates: string[] = [];
  if (configured.length > 0) {
    candidates.push(isAbsolute(configured) ? configured : resolve(workspace, configured));
  }
  const env = process.env['DWG_DOCS_DIR'];
  if (typeof env === 'string' && env.trim().length > 0) candidates.push(env.trim());
  candidates.push(join(homedir(), 'harmony-docs'));
  candidates.push(join(workspace, 'harmony-docs'));
  return candidates;
}

/** First candidate that exists, or `null`. */
export function resolveDocsDir(configured: string, workspace: string): string | null {
  return docsCandidates(configured, workspace).find((dir) => existsSync(dir)) ?? null;
}

async function walk(dir: string, files: string[]): Promise<void> {
  if (files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const info = await stat(path);
      if (info.size > MAX_BYTES) continue;
    } catch {
      continue;
    }
    files.push(path);
  }
}

/**
 * Substring search over the corpus.
 * @param root - corpus directory.
 * @param query - case-insensitive substring.
 * @param limit - max hits returned.
 */
export async function searchDocs(root: string, query: string, limit = 20): Promise<DocSearch> {
  const files: string[] = [];
  await walk(root, files);
  const needle = query.toLowerCase();
  const hits: DocHit[] = [];
  let matches = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const sourceUrl = /<!-- source: (\S+) -->/.exec(text)?.[1];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!line.toLowerCase().includes(needle)) continue;
      matches += 1;
      if (hits.length >= limit) continue;
      hits.push({
        file: relative(root, file).replace(/\\/g, '/'),
        line: index + 1,
        snippet: line.trim().slice(0, 200),
        ...(sourceUrl === undefined ? {} : { sourceUrl })
      });
    }
  }
  return { root, files: files.length, matches, hits };
}
