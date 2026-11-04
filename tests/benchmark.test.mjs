// 0.6.7: validate the award benchmark file (data-only; no library needed).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const FILE = join(process.cwd(), 'benchmarks', 'awards-2026.json');
const RECOMMEND_FILE = join(process.cwd(), 'benchmarks', 'recommend-2026.json');

test('awards-2026 benchmark has 20 valid queries', async () => {
  const parsed = JSON.parse(await readFile(FILE, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.name, 'awards-2026');
  assert.ok(Array.isArray(parsed.queries));
  assert.equal(parsed.queries.length, 20);
  const ids = new Set();
  const kinds = new Set(['pattern', 'anti-pattern', 'principle', 'brand']);
  for (const query of parsed.queries) {
    assert.match(query.id, /^Q-\d{2}$/);
    assert.equal(ids.has(query.id), false, `重复的查询 id：${query.id}`);
    ids.add(query.id);
    assert.ok(kinds.has(query.kind), `未知 kind：${query.kind}`);
    assert.ok(typeof query.query === 'string' && query.query.trim().length >= 2);
    assert.ok(Array.isArray(query.expectTags) && query.expectTags.length > 0);
  }
});

test('recommend-2026 benchmark has 6 valid pack queries', async () => {
  const parsed = JSON.parse(await readFile(RECOMMEND_FILE, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(Array.isArray(parsed.queries));
  assert.equal(parsed.queries.length, 6);
  const ids = new Set();
  for (const query of parsed.queries) {
    assert.match(query.id, /^RP-\d{2}$/);
    assert.equal(ids.has(query.id), false, `重复的查询 id：${query.id}`);
    ids.add(query.id);
    assert.ok(typeof query.requirement === 'string' && query.requirement.length >= 10);
    assert.ok(typeof query.expectPack === 'string' && query.expectPack.length > 0);
    assert.ok(['low', 'medium', 'high'].includes(query.density));
  }
});
