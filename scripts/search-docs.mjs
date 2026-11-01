#!/usr/bin/env node
/**
 * Search the local official-doc corpus.
 *
 * The corpus is fetched by scripts/fetch-official-docs.mjs (Huawei design docs)
 * and a sparse clone of openharmony/docs. Keep it outside the plugin package;
 * point DWG_DOCS_DIR at it.
 *
 * Usage:
 *   node scripts/search-docs.mjs "点击热区"
 *   node scripts/search-docs.mjs "LazyForEach" --limit=5
 *   node scripts/search-docs.mjs --list
 *   node scripts/search-docs.mjs "深色" --path=~/harmony-docs
 *
 * Prints `file:line: snippet`, plus the source URL when the doc has frontmatter.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const query = args.find((arg) => !arg.startsWith('--'));
const listMode = args.includes('--list');
const limit = Number.parseInt(option('limit', '20'), 10) || 20;

const candidates = [
  option('path', ''),
  process.env.DWG_DOCS_DIR ?? '',
  join(homedir(), 'harmony-docs'),
  join(process.cwd(), 'harmony-docs')
].filter((hit) => hit.length > 0);
const root = candidates.find((dir) => existsSync(dir));
if (root === undefined) {
  console.error('找不到语料目录。先运行 scripts/fetch-official-docs.mjs，或设置 DWG_DOCS_DIR。');
  process.exit(2);
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(...(await walk(path)));
    } else if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
      files.push(path);
    }
  }
  return files;
}

const files = await walk(root);

if (listMode) {
  console.log(`${files.length} markdown files under ${root}\n`);
  for (const file of files.slice(0, 80)) {
    console.log(relative(root, file));
  }
  if (files.length > 80) console.log(`… and ${files.length - 80} more`);
  process.exit(0);
}

if (query === undefined) {
  console.error('用法：node scripts/search-docs.mjs "<关键词>" [--limit=20] [--path=…] [--list]');
  process.exit(2);
}

const needle = query.toLowerCase();
let shown = 0;
let total = 0;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const source = /<!-- source: (\S+) -->/.exec(text)?.[1];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.toLowerCase().includes(needle)) continue;
    total += 1;
    if (shown >= limit) continue;
    const snippet = line.trim().slice(0, 180);
    console.log(`${relative(root, file)}:${index + 1}: ${snippet}`);
    if (source !== undefined && shown === 0) console.log(`    source: ${source}`);
    shown += 1;
  }
}

console.log(`\n${shown} shown / ${total} matches in ${files.length} files (${root})`);
