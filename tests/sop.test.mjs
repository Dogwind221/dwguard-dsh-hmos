// 0.8.0: bundled 14 SOPs + 32 engineering facts are searchable via dwguard_knowledge.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-sop-home-'));

import { resolveOptions } from '../lib/config.js';
import { knowledgeCounts, loadKnowledgeLibrary } from '../lib/sop.js';
import { createKnowledgeTool } from '../lib/tools/knowledge.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function exec(cwd) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-sop-'));
  dirs.push(dir);
  return dir;
}

test('0.8.0 KN: bundled library has 32 engineering facts and 14 SOPs', () => {
  const counts = knowledgeCounts();
  assert.equal(counts.entries, 32);
  assert.equal(counts.sops, 14);
  const library = loadKnowledgeLibrary();
  assert.equal(new Set(library.entries.map((entry) => entry.id)).size, 32);
  assert.equal(new Set(library.sops.map((sop) => sop.id)).size, 14);
  for (const sop of library.sops) {
    assert.ok(sop.steps.length >= 3, `${sop.id} 至少 3 个步骤`);
    assert.ok(sop.gate.length >= 1, `${sop.id} 至少 1 个门禁`);
    assert.ok(sop.evidence.length >= 1, `${sop.id} 至少 1 个证据`);
  }
});

test('0.8.0 KN: sops/sop/engineering actions return actionable content', async () => {
  const cwd = await workspace();
  const tool = createKnowledgeTool(resolveOptions({}));
  const listed = await tool.execute({ action: 'sops', limit: 14 }, exec(cwd));
  assert.equal(listed.ok, true, listed.detail);
  assert.match(listed.summary, /14 个/);
  assert.match(listed.detail, /SOP-06/);
  assert.match(listed.detail, /构建与签名/);

  const one = await tool.execute({ action: 'sop', sopId: 'SOP-06' }, exec(cwd));
  assert.equal(one.ok, true, one.detail);
  assert.match(one.detail, /signature generate/);
  assert.match(one.detail, /构建/);
  assert.match(one.detail, /门禁/);

  const search = await tool.execute({ action: 'engineering', query: '签名' }, exec(cwd));
  assert.equal(search.ok, true, search.detail);
  assert.match(search.detail, /ENG-05/);
  assert.match(search.detail, /检查/);

  const missing = await tool.execute({ action: 'sop', sopId: 'SOP-99' }, exec(cwd));
  assert.equal(missing.ok, false);
});

test('0.8.0 KN: default sediment still works alongside the library actions', async () => {
  const cwd = await workspace();
  const tool = createKnowledgeTool(resolveOptions({}));
  const result = await tool.execute(
    {
      entries: [{ topic: 'harness', kind: 'pattern', statement: '跨会话先 resume 再重跑', evidence: 'test' }]
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);
  assert.match(result.summary, /沉淀 1 条/);
});
