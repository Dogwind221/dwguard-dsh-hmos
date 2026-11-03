// 0.6.2 P0: design library — deterministic ingest, BM25 ranking, CLI parity.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

// Keep the workspace registry the tools write out of the real DSH home.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-home-'));

import { resolveOptions } from '../lib/config.js';
import { readDesignIndex, readDesignManifest, searchDesignLibrary } from '../lib/design.js';
import { resolvePaths } from '../lib/paths.js';
import { createDesignTool } from '../lib/tools/design.js';

const run = promisify(execFile);
const options = resolveOptions({});
const tool = createDesignTool(options);

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-design-'));
  dirs.push(dir);
  return dir;
}

function exec(cwd) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
}

const paths = (cwd) => resolvePaths(cwd, '.shared');

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function writeMeta(cwd, name, meta) {
  const inbox = join(paths(cwd).designDir, 'inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, name), JSON.stringify(meta, null, 2), 'utf8');
}

async function ingest(cwd, sources) {
  return tool.execute({ action: 'library', op: 'ingest', ...(sources === undefined ? {} : { sources }) }, exec(cwd));
}

const targets = [
  {
    name: 't1.meta.json',
    title: '深色模式卡片',
    text: '深色模式卡片：夜间背景 #121212，卡片边界用 1vp 描边代替阴影，卡片圆角 16vp',
    tags: ['深色', '卡片', '夜间'],
    tokens: { palette: [{ name: 'bg', value: '#121212' }], radius: [{ name: 'card', value: 16, unit: 'vp' }] }
  },
  {
    name: 't2.meta.json',
    title: '杂志感留白卡片',
    text: '杂志感 大留白：页面边距 24vp，卡片间距 20vp，行高宽松，标题用大字号',
    tags: ['杂志感', '留白', '排版'],
    tokens: { spacing: [{ name: 'page', value: 24, unit: 'vp' }], radius: [{ name: 'card', value: 20, unit: 'vp' }] }
  },
  {
    name: 't3.meta.json',
    title: '20vp 圆角卡片',
    text: '卡片圆角 20vp，配 8vp 栅格与 16vp 页面边距，边框只用细描边',
    tags: ['圆角', '卡片', '栅格'],
    tokens: { radius: [{ name: 'card', value: 20, unit: 'vp' }], spacing: [{ name: 'grid', value: 8, unit: 'vp' }] }
  },
  {
    name: 't4.meta.json',
    title: '暖白配色首页',
    text: '暖白配色 #FAF8F4 作为页面背景，主色 #FF6600 只用在主操作上',
    tags: ['配色', '暖白', '主色'],
    tokens: { palette: [{ name: 'bg', value: '#FAF8F4' }, { name: 'brand', value: '#FF6600' }] },
    image: 'shot.png'
  },
  {
    name: 't5.meta.json',
    title: '咖啡色胶囊按钮',
    text: '咖啡色主色 #6F4E37 用于胶囊按钮，按钮圆角 24vp',
    tags: ['配色', '按钮', '咖啡'],
    tokens: { palette: [{ name: 'brand', value: '#6F4E37' }], radius: [{ name: 'pill', value: 24, unit: 'vp' }] }
  },
  {
    name: 't6.meta.json',
    title: '深色空态插画',
    text: '深色模式空态：图标用 #8A8A8A，文案居中，上下留白 32vp',
    tags: ['深色', '空态', '图标'],
    tokens: { palette: [{ name: 'icon', value: '#8A8A8A' }], spacing: [{ name: 'empty', value: 32, unit: 'vp' }] }
  },
  {
    name: 't7.meta.json',
    title: '紧凑列表行',
    text: '紧凑列表行间距 12vp、行高 44vp，密度偏紧，适合信息密集的清单',
    tags: ['紧凑', '列表', '间距'],
    tokens: { spacing: [{ name: 'row', value: 12, unit: 'vp' }], type: [{ name: 'row', value: 14, unit: 'fp' }] }
  },
  {
    name: 't8.meta.json',
    title: '缓动入场动效',
    text: '页面入动效 240ms ease-out，卡片逐个浮起，缓动不要弹跳',
    tags: ['动效', '缓动', '入场'],
    tokens: { motion: [{ name: 'enter', value: 240, unit: 'ms' }] }
  }
];

const expectations = [
  ['深色模式卡片', '深色模式卡片'],
  ['杂志感 大留白', '杂志感留白卡片'],
  ['圆角 20vp', '20vp 圆角卡片'],
  ['暖白配色', '暖白配色首页'],
  ['咖啡色主色', '咖啡色胶囊按钮'],
  ['深色 空态', '深色空态插画'],
  ['紧凑列表 间距 12vp', '紧凑列表行'],
  ['动效 240ms 缓动', '缓动入场动效']
];

async function buildFixtureLibrary(cwd) {
  const init = await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  assert.equal(init.ok, true, init.detail);
  for (const target of targets) {
    await writeMeta(cwd, target.name, {
      title: target.title,
      summary: target.text,
      rationale: target.text,
      tags: target.tags,
      tokens: target.tokens,
      ...(target.image === undefined ? {} : { image: target.image }),
      source: { kind: 'user', license: 'internal' }
    });
  }
  // One real (tiny) PNG so the ref copy path is exercised.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await writeFile(join(paths(cwd).designDir, 'inbox', 'shot.png'), png);
  for (let i = 1; i <= 16; i += 1) {
    await writeMeta(cwd, `d${i}.meta.json`, {
      title: `通用设置页卡片 ${i}`,
      summary: `通用设置页卡片 ${i}：包含按钮、表单、列表与说明文字，用于其它场景。`,
      rationale: '通用设置页说明，不针对深色、留白或特定动效。',
      tags: ['通用'],
      source: { kind: 'user', license: 'internal' }
    });
  }
  const result = await ingest(cwd, ['inbox']);
  assert.equal(result.ok, true, result.detail);
  return result;
}

test('library init writes the skeleton and the read-only query CLI', async () => {
  const cwd = await workspace();
  const result = await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  const manifest = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8'));
  assert.equal(manifest.cards.length, 0);
  assert.match(await readFile(paths(cwd).designQueryScript, 'utf8'), /dwguard design-library query CLI/);
  const again = await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  assert.equal(again.ok, true);
  assert.match(again.summary, /已存在/);
});

test('RAG-A: ingesting the same input twice changes no bytes (rules and inbox)', async () => {
  const cwd = await workspace();
  await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  const first = await ingest(cwd, ['rules']);
  assert.equal(first.ok, true, first.detail);
  const manifest = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8'));
  assert.ok(manifest.cards.length >= 20, `审美规则应至少 20 张，实际 ${manifest.cards.length}`);
  const files = [paths(cwd).designManifest, paths(cwd).designChunks, paths(cwd).designIndex];
  const before = await Promise.all(files.map((file) => sha256(file)));
  const second = await ingest(cwd, ['rules']);
  assert.equal(second.ok, true);
  assert.match(second.summary, /新增 0/);
  assert.deepEqual(await Promise.all(files.map((file) => sha256(file))), before);
});

test('RAG-B: 24-card fixture, 8 queries, expected card in top 3 and ranking is stable', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const manifest = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8'));
  assert.equal(manifest.cards.length, 24);
  assert.equal(manifest.cards.find((card) => card.title === '暖白配色首页')?.images.length, 1, '图片应复制进 refs/');

  for (const [query, expected] of expectations) {
    const result = await tool.execute({ action: 'search', query, topK: 3 }, exec(cwd));
    assert.equal(result.ok, true, result.detail);
    const top = result.detail.split('\n').filter((line) => line.startsWith('| `DSG-'));
    assert.ok(top.some((line) => line.includes(expected)), `${query} 的 top3 应包含 ${expected}\n${result.detail}`);
  }

  const query = '深色模式卡片';
  const first = await tool.execute({ action: 'search', query, topK: 5 }, exec(cwd));
  const second = await tool.execute({ action: 'search', query, topK: 5 }, exec(cwd));
  assert.equal(first.detail, second.detail, '同一查询必须得到同一排序');
});

test('RAG-C: inbox image paths cannot escape, and search writes nothing', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const before = await Promise.all(
    [paths(cwd).designManifest, paths(cwd).designChunks, paths(cwd).designIndex].map((file) => sha256(file))
  );
  await writeMeta(cwd, 'evil.meta.json', {
    title: '路径穿越卡片',
    summary: '尝试用 ../ 把图片写到设计库外',
    tags: ['测试'],
    image: '../escape.png',
    source: { kind: 'user', license: 'internal' }
  });
  const result = await ingest(cwd, ['inbox']);
  assert.match(result.detail, /image 路径非法/);
  assert.equal(
    await readFile(join(cwd, '.shared', 'escape.png')).then(() => 'exists').catch(() => 'missing'),
    'missing',
    '不能把文件写到 .shared 外'
  );
  const card = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8')).cards.find(
    (item) => item.title === '路径穿越卡片'
  );
  assert.equal(card?.images.length, 0);
  assert.ok(card !== undefined, '合法 meta 仍应入库（只是丢弃非法图片）');

  const afterIngest = await Promise.all(
    [paths(cwd).designManifest, paths(cwd).designChunks, paths(cwd).designIndex].map((file) => sha256(file))
  );
  assert.notDeepEqual(afterIngest, before, '新增卡片后索引应更新');
  const search = await tool.execute({ action: 'search', query: '深色 卡片', topK: 3 }, exec(cwd));
  assert.equal(search.ok, true);
  const afterSearch = await Promise.all(
    [paths(cwd).designManifest, paths(cwd).designChunks, paths(cwd).designIndex].map((file) => sha256(file))
  );
  assert.deepEqual(afterSearch, afterIngest, 'search 必须只读');
});

test('RAG-E: generated query.mjs matches the tool ranking for 5 queries', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const p = paths(cwd);
  const manifest = await readDesignManifest(p);
  assert.ok(manifest !== null);
  const { index, chunks } = await readDesignIndex(p);
  const script = p.designQueryScript;
  for (const query of ['深色模式卡片', '杂志感 大留白', '圆角 20vp', '咖啡色主色', '动效 240ms 缓动']) {
    const lib = searchDesignLibrary(manifest, index, chunks, query, {
      topK: 5,
      ranker: 'lexical',
      licenseRequired: true
    });
    const output = await run(process.execPath, [script, query, '--top', '5', '--json'], { cwd });
    const cli = JSON.parse(output.stdout);
    assert.equal(cli.results.length, lib.results.length, `${query}: 条数一致`);
    assert.deepEqual(
      cli.results.map((hit) => [hit.cardId, hit.score]),
      lib.results.map((hit) => [hit.cardId, hit.score]),
      `${query}: id 与分数必须一致`
    );
  }
});

test('query.mjs is usable standalone, rejects empty queries, and can include unknown licenses', async () => {
  const cwd = await workspace();
  await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  await writeMeta(cwd, 'u.meta.json', {
    title: '未知许可卡片',
    summary: '许可未知的参考，默认不应出现在结果里',
    tags: ['未知'],
    source: { kind: 'user', license: 'unknown' }
  });
  const ingested = await ingest(cwd, ['inbox']);
  assert.equal(ingested.ok, true, ingested.detail);
  const script = paths(cwd).designQueryScript;
  const filtered = await run(process.execPath, [script, '未知许可', '--json'], { cwd });
  assert.deepEqual(JSON.parse(filtered.stdout).results, []);
  const included = await run(process.execPath, [script, '未知许可', '--json', '--include-unknown-license'], { cwd });
  assert.equal(JSON.parse(included.stdout).results.length, 1);
  await assert.rejects(run(process.execPath, [script], { cwd }), (error) => error.code === 2);
});

test('hybrid is reserved: the interface accepts it and falls back with an explicit note', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const hybrid = createDesignTool(resolveOptions({ designRanker: 'hybrid' }));
  const result = await hybrid.execute({ action: 'search', query: '深色 卡片', topK: 3 }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /回退 lexical/);
});

test('library list / stats report cards, chunks, licenses and coverage', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const list = await tool.execute({ action: 'library', op: 'list' }, exec(cwd));
  assert.equal(list.ok, true);
  assert.match(list.detail, /暖白配色首页/);
  const stats = await tool.execute({ action: 'stats' }, exec(cwd));
  assert.equal(stats.ok, true);
  assert.match(stats.detail, /卡片：24/);
  assert.match(stats.detail, /internal/);
});

test('search on a missing library fails with an actionable next step', async () => {
  const cwd = await workspace();
  const result = await tool.execute({ action: 'search', query: '圆角' }, exec(cwd));
  assert.equal(result.ok, false);
  assert.match(result.next, /library init/);
});
