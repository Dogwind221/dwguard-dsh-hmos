#!/usr/bin/env node
/**
 * Fetch official HarmonyOS docs into a local markdown corpus.
 *
 * Huawei's documentation site renders pages with JS, so fetching the HTML gives
 * nothing. The reliable entry points are:
 *   - https://developer.huawei.com/consumer/cn/llms/<topic>.txt  (an index whose
 *     `.md` links return the full markdown source), and
 *   - raw markdown in https://github.com/openharmony/docs.
 *
 * Usage:
 *   node scripts/fetch-official-docs.mjs <outDir> [--index=ux-design] [--match=关键词,关键词] [--limit=60]
 *
 * Writes <outDir>/<index>/<slug>.md plus <outDir>/index.json (source URL, sha256,
 * fetchedAt) so a rule can always cite the exact page and version it came from.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const INDEXES = {
  'ux-design': 'https://developer.huawei.com/consumer/cn/llms/docs-ux-design.txt'
};

const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith('--')) ?? 'official-docs';
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const indexName = option('index', 'ux-design');
const indexUrl = INDEXES[indexName];
if (indexUrl === undefined) {
  console.error(`unknown index "${indexName}", available: ${Object.keys(INDEXES).join(', ')}`);
  process.exit(2);
}
const match = option('match', '')
  .split(',')
  .map((word) => word.trim())
  .filter((word) => word.length > 0);
const directUrls = option('urls', '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.startsWith('http'));
const limit = Number.parseInt(option('limit', '60'), 10);

const response = await fetch(indexUrl);
if (!response.ok) {
  console.error(`index fetch failed: HTTP ${response.status}`);
  process.exit(1);
}
const indexText = await response.text();

const entries = [];
const seen = new Set();
for (const line of indexText.split('\n')) {
  const matchLine = /^- \[(.*?)\]\((https?:\/\/\S+?\.md)\):(.*)$/.exec(line.trim());
  if (matchLine === null) continue;
  const [, title, url, tag] = matchLine;
  if (seen.has(url)) continue;
  seen.add(url);
  entries.push({ title, url, tag });
}

const keywordHit = (entry) =>
  match.length === 0 ||
  match.some((word) => `${entry.title} ${entry.url} ${entry.tag}`.toLowerCase().includes(word.toLowerCase()));

const selected =
  directUrls.length > 0
    ? directUrls.map((url) => ({ title: url.split('/').pop() ?? url, url, tag: '' }))
    : entries.filter(keywordHit).slice(0, Number.isFinite(limit) ? limit : 60);
console.log(`index ${indexName}: ${entries.length} entries, ${selected.length} selected`);

await mkdir(join(outDir, indexName), { recursive: true });
const manifest = [];
for (const entry of selected) {
  const slug = new URL(entry.url).pathname.split('/').pop().replace(/\.md$/, '');
  const file = join(indexName, `${slug}.md`);
  try {
    const page = await fetch(entry.url);
    if (!page.ok) throw new Error(`HTTP ${page.status}`);
    const body = await page.text();
    const content = `<!-- source: ${entry.url} -->\n<!-- fetched: ${new Date().toISOString()} -->\n\n${body}`;
    await writeFile(join(outDir, file), content, 'utf8');
    manifest.push({
      title: entry.title,
      sourceUrl: entry.url,
      file,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body)
    });
    console.log(`  + ${file} (${Buffer.byteLength(body)} bytes)`);
  } catch (error) {
    console.warn(`  ! ${entry.url}: ${error.message}`);
  }
}

// Merge with any index from a previous run so partial fetches stay coherent.
let previousDocs = [];
try {
  const existing = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
  if (Array.isArray(existing.docs)) previousDocs = existing.docs;
} catch {
  /* first run */
}
const merged = new Map(previousDocs.map((doc) => [doc.sourceUrl, doc]));
for (const doc of manifest) merged.set(doc.sourceUrl, doc);
const docs = [...merged.values()].sort((left, right) => left.file.localeCompare(right.file));

await writeFile(
  join(outDir, 'index.json'),
  `${JSON.stringify({ index: indexName, indexUrl, fetchedAt: new Date().toISOString(), docs }, null, 2)}\n`,
  'utf8'
);
console.log(`done: ${manifest.length} fetched, ${docs.length} in index under ${outDir}`);