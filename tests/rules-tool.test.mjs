// dwguard_rules: catalog queries and local-corpus search behind one tool.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Keep the workspace registry out of the real DSH home: the tool stamps every
// workspace it touches, and test temp dirs must not appear in the panel.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-rules-tool-home-'));

import { resolveOptions } from '../lib/config.js';
import { createRulesTool } from '../lib/tools/rules.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-rules-tool-'));
  dirs.push(dir);
  return dir;
}

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

test('list and get resolve catalog entries and aliases', async () => {
  const tool = createRulesTool(resolveOptions({}));

  const list = await tool.execute({ action: 'list', dimension: 'accessibility' }, exec('C:/tmp'));
  assert.equal(list.ok, true);
  assert.match(list.detail, /DW-A11Y-02/);
  assert.match(list.detail, /触控目标/);

  const byAlias = await tool.execute({ action: 'get', ruleId: 'AGC-RJ-013' }, exec('C:/tmp'));
  assert.equal(byAlias.ok, true);
  assert.match(byAlias.detail, /DW-AES-07/);
  assert.match(byAlias.detail, /折叠屏/);
  assert.match(byAlias.detail, /官方依据/);

  const missing = await tool.execute({ action: 'get', ruleId: 'NOPE-999' }, exec('C:/tmp'));
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /没有/);
});

test('search greps the configured corpus and returns source URLs', async () => {
  const cwd = await workspace();
  const docs = join(cwd, 'docs');
  await mkdir(join(docs, 'ux'), { recursive: true });
  await writeFile(
    join(docs, 'ux', 'general.md'),
    '<!-- source: https://developer.huawei.com/example/general.md -->\n\n点击热区至少为 48vp×48vp（推荐）。\n'
  );

  const tool = createRulesTool(resolveOptions({ docsDir: docs }));
  const hit = await tool.execute({ action: 'search', query: '48vp' }, exec(cwd));
  assert.equal(hit.ok, true, hit.detail);
  assert.match(hit.detail, /ux\/general\.md:3/);
  assert.match(hit.detail, /developer\.huawei\.com\/example/);

  const none = await tool.execute({ action: 'search', query: '不存在的词' }, exec(cwd));
  assert.equal(none.ok, true);
  assert.match(none.summary, /0 处命中/);
});

test('search without a keyword or corpus fails with a hint', async () => {
  const tool = createRulesTool(resolveOptions({ docsDir: 'Z:\\definitely-missing-docs' }));
  const noQuery = await tool.execute({ action: 'search' }, exec('C:/tmp'));
  assert.equal(noQuery.ok, false);
  // Either "no corpus" or "no keyword" is acceptable depending on machine layout.
  assert.match(noQuery.summary, /语料目录|关键词/);
});
