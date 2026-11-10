#!/usr/bin/env node
/**
 * Search the citation/summary-only Huawei design-guide index.
 *
 *   node scripts/search-design-guide.mjs "动效" --limit 5
 *   node scripts/search-design-guide.mjs --rule DW-AES-11
 *   node scripts/search-design-guide.mjs "图标" --json
 */
import { readFile } from 'node:fs/promises';

const args = { query: '', rule: null, limit: 5, json: false };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--rule') { args.rule = argv[index + 1]; index += 1; }
  else if (arg === '--limit') { args.limit = Number(argv[index + 1]); index += 1; }
  else if (arg === '--json') args.json = true;
  else if (!arg.startsWith('-')) args.query = `${args.query} ${arg}`.trim();
}
const index = JSON.parse(await readFile('docs/design-guide/index.json', 'utf8'));
const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
const hits = index.entries.filter((entry) => {
  if (args.rule !== null && !entry.ruleRefs.includes(args.rule)) return false;
  if (words.length === 0) return true;
  const text = `${entry.title} ${entry.section} ${entry.summary} ${entry.outline.join(' ')} ${entry.ruleRefs.join(' ')}`.toLowerCase();
  return words.every((word) => text.includes(word));
}).slice(0, Math.max(1, args.limit));
if (args.json) {
  console.log(JSON.stringify({ count: hits.length, entries: hits }, null, 2));
} else {
  for (const entry of hits) {
    console.log(`${entry.id} · ${entry.title}`);
    console.log(`  ${entry.url}`);
    console.log(`  ${entry.summary}`);
    if (entry.ruleRefs.length > 0) console.log(`  rules: ${entry.ruleRefs.join(' / ')}`);
  }
  if (hits.length === 0) console.log('no matches');
}
