// 0.6.2 P0/P1: design library — ingest, BM25, CLI parity, design brief + outbox.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

// Keep the workspace registry the tools write out of the real DSH home.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-home-'));

import { resolveOptions } from '../lib/config.js';
import {
  createCachedEmbedder,
  readDesignIndex,
  readDesignManifest,
  rerankDesignHits,
  searchDesignLibrary
} from '../lib/design.js';
import { decodePng, imageFeatures, imageSimilarity } from '../lib/image.js';
import { parseOutbox } from '../lib/dispatch.js';
import { resolvePaths } from '../lib/paths.js';
import { createAestheticTool } from '../lib/tools/aesthetic.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createConfirmTool } from '../lib/tools/confirm.js';
import { createDesignTool } from '../lib/tools/design.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';
import { createStatusTool } from '../lib/tools/status.js';

const run = promisify(execFile);
const options = resolveOptions({});
const tool = createDesignTool(options);
const specTool = createSpecTool(options);
const prereviewTool = createPrereviewTool(options);
const dispatchTool = createDispatchTool(options);
const statusTool = createStatusTool(options);
const auditTool = createAuditTool(options);
const aestheticTool = createAestheticTool(options);
const confirmTool = createConfirmTool(options);

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图 F-01.png' },
  {
    id: 'A-01',
    dimension: 'aesthetic',
    statement: '深色模式卡片使用深色背景与 16vp 圆角',
    verify: '布局树 bounds 实测 + 截图 A-01.png'
  },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析截图与毫秒数' },
  {
    id: 'X-01',
    dimension: 'accessibility',
    statement: '打卡按钮文字对比度 ≥ 4.5:1',
    verify: '截图取样计算对比度数值'
  }
];

async function writeSpec(cwd, aestheticExtra = {}) {
  const withExtra = criteria.map((criterion) =>
    criterion.dimension === 'aesthetic' ? { ...criterion, ...aestheticExtra } : criterion
  );
  return specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。深色模式需要可读。',
      constraints: ['compatibleSdkVersion 5.0.0(12)'],
      criteria: withExtra
    },
    exec(cwd)
  );
}

const checks = [
  { criterionId: 'F-01', result: 'pass', evidence: '点击后截图显示连续天数 4' },
  { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 实测深色背景与 16vp 圆角' },
  { criterionId: 'P-01', result: 'pass', evidence: 'Profiler 冷启动 720ms' },
  { criterionId: 'X-01', result: 'pass', evidence: '对比度取样 4.9:1' }
];

async function passPrereview(cwd) {
  return prereviewTool.execute(
    { note: '通读任务包/规格/工作区，覆盖性能、生命周期、并发、API 兼容与四维验收可行性。', findings: [] },
    exec(cwd)
  );
}

async function outboxKinds(cwd) {
  return parseOutbox(await readFile(join(paths(cwd).shared, 'outbox-dsh.md'), 'utf8')).map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    replyTo: entry.replyTo
  }));
}

const boundsV1 = {
  id: 'page',
  children: [
    {
      id: 'card',
      padding: { top: 16, right: 16, bottom: 16, left: 16 },
      radius: 20,
      fontSize: 16,
      backgroundColor: '#FAF8F4'
    }
  ]
};

async function writeBounds(cwd, relative, value) {
  const file = join(paths(cwd).shared, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Write an 8-bit RGB PNG whose pixels come from `pixel(x, y) -> [r, g, b]`. */
function makePng(width, height, pixel) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = y * stride + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const leftDark = (x) => (x < 16 ? [0, 0, 0] : [255, 255, 255]);
const leftLight = (x) => (x < 16 ? [255, 255, 255] : [0, 0, 0]);
const IMAGE_A = makePng(32, 32, (x) => leftDark(x));
const IMAGE_C = makePng(32, 32, (x) => leftLight(x));
const IMAGE_D = makePng(32, 32, () => [128, 128, 128]);

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

test('P1: brief writes tasks/design-brief.md and appends an inspiration record', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const spec = await writeSpec(cwd);
  assert.equal(spec.ok, true, spec.detail);
  const result = await tool.execute({ action: 'brief', topK: 3 }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  const briefPath = paths(cwd).designBriefMd;
  const brief = await readFile(briefPath, 'utf8');
  assert.match(brief, /设计参考简报/);
  assert.match(brief, /参考是证据不是判据/);
  assert.match(brief, /深色模式卡片|深色空态插画|暖白配色首页/);
  assert.match(brief, /\| ID \| 标题 \| 来源 \| license \| 命中分 \|/);
  const outbox = await outboxKinds(cwd);
  assert.deepEqual(outbox.map((entry) => entry.kind), ['inspiration']);
  assert.match(result.detail, /tasks\/design-brief\.md/);
});

test('P1: a design-request is answered with inspiration re=#q-N, status clears it', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  await writeSpec(cwd);
  await tool.execute({ action: 'brief', topK: 2 }, exec(cwd));
  const devecoOutbox = join(paths(cwd).shared, 'outbox-deveco.md');
  await writeFile(
    devecoOutbox,
    '# DevEco Code → DSH\n\n## [2026-11-03T12:00:00.000Z] design-request · #q-1 · from=deveco to=dsh · re=#d-1 | 需要深色空态参考\n\n- 场景: 深色 空态\n\n',
    'utf8'
  );
  const before = await statusTool.execute({}, exec(cwd));
  assert.match(before.detail, /设计请求：1 条待应答/);
  assert.match(before.next, /design-request|设计请求|brief/);

  const answer = await tool.execute({ action: 'brief', request: 'q-1', topK: 2 }, exec(cwd));
  assert.equal(answer.ok, true, answer.detail);
  const outbox = await outboxKinds(cwd);
  const reply = outbox.filter((entry) => entry.kind === 'inspiration' && entry.replyTo === 'q-1');
  assert.equal(reply.length, 1, 'inspiration 必须回指 q-1');
  const after = await statusTool.execute({}, exec(cwd));
  assert.match(after.detail, /设计请求：0 条待应答/);
});

test('P1: dispatch embeds the design brief and answers with inspiration re=#d-1', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  await writeSpec(cwd);
  const review = await passPrereview(cwd);
  assert.equal(review.ok, true, review.detail);
  const dispatched = await dispatchTool.execute({}, exec(cwd));
  assert.equal(dispatched.ok, true, dispatched.detail);
  assert.match(dispatched.detail, /## 2\.5 设计参考/);
  assert.match(dispatched.detail, /design-brief\.md/);
  const outbox = await outboxKinds(cwd);
  assert.ok(outbox.some((entry) => entry.kind === 'inspiration' && entry.replyTo === 'd-1'));
  const brief = await readFile(paths(cwd).designBriefMd, 'utf8');
  assert.match(brief, /设计参考简报/);
});

test('P1: an empty library does not block dispatch and produces no design section', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  const review = await passPrereview(cwd);
  assert.equal(review.ok, true, review.detail);
  const dispatched = await dispatchTool.execute({}, exec(cwd));
  assert.equal(dispatched.ok, true, dispatched.detail);
  assert.doesNotMatch(dispatched.detail, /## 2\.5 设计参考/);
  const outbox = await outboxKinds(cwd);
  assert.deepEqual(outbox.map((entry) => entry.kind), ['dispatch']);

  const brief = await tool.execute({ action: 'brief' }, exec(cwd));
  assert.equal(brief.ok, false);
  assert.match(brief.next, /library init/);
});

test('P2: spec validates designRefs against the library (unknown/blocked rejected)', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const dark = manifest.cards.find((card) => card.title === '深色模式卡片');
  assert.ok(dark !== undefined);

  const ok = await writeSpec(cwd, { designRefs: [dark.id] });
  assert.equal(ok.ok, true, ok.detail);
  const specJson = JSON.parse(await readFile(paths(cwd).specJson, 'utf8'));
  assert.deepEqual(specJson.criteria.find((criterion) => criterion.id === 'A-01')?.designRefs, [dark.id]);

  const unknown = await writeSpec(cwd, { designRefs: ['DSG-9999'] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /不存在/);

  const raw = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8'));
  raw.cards = raw.cards.map((card) => (card.id === dark.id ? { ...card, status: 'blocked' } : card));
  await writeFile(paths(cwd).designManifest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const blocked = await writeSpec(cwd, { designRefs: [dark.id] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /block/);
});

test('P2: audit accepts designRefs, renders 参考对照 and records design.refs', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const dark = manifest.cards.find((card) => card.title === '深色模式卡片');
  assert.ok(dark !== undefined);
  const spec = await writeSpec(cwd, { designRefs: [dark.id] });
  assert.equal(spec.ok, true, spec.detail);

  const audit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(audit.ok, true, audit.detail);
  const report = await readFile(join(paths(cwd).shared, 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(report, /参考对照/);
  assert.match(report, new RegExp(dark.id));
  assert.match(report, /深色模式卡片/);
  assert.match(report, /圆角|配色/);

  const json = JSON.parse(await readFile(join(paths(cwd).shared, 'artifacts', 'audit-1.json'), 'utf8'));
  assert.equal(json.design.refs.length, 1);
  assert.equal(json.design.refs[0].designRef, dark.id);
  assert.equal(json.design.refs[0].status, 'active');
  assert.match(json.design.refs[0].tokens ?? '', /圆角|配色/);
});

test('P2: audit gate rejects unknown or blocked designRefs', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const dark = manifest.cards.find((card) => card.title === '深色模式卡片');
  assert.ok(dark !== undefined);
  const spec = await writeSpec(cwd, { designRefs: [dark.id] });
  assert.equal(spec.ok, true, spec.detail);

  // Bypass spec validation by editing the frozen pack, as a stale/foreign pack could.
  const specJson = JSON.parse(await readFile(paths(cwd).specJson, 'utf8'));
  specJson.criteria = specJson.criteria.map((criterion) =>
    criterion.id === 'A-01' ? { ...criterion, designRefs: ['DSG-9999'] } : criterion
  );
  await writeFile(paths(cwd).specJson, `${JSON.stringify(specJson, null, 2)}\n`, 'utf8');
  const unknown = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /不存在/);

  // Now block the real card and audit against it.
  const raw = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8'));
  raw.cards = raw.cards.map((card) => (card.id === dark.id ? { ...card, status: 'blocked' } : card));
  await writeFile(paths(cwd).designManifest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  specJson.criteria = specJson.criteria.map((criterion) =>
    criterion.id === 'A-01' ? { ...criterion, designRefs: [dark.id] } : criterion
  );
  await writeFile(paths(cwd).specJson, `${JSON.stringify(specJson, null, 2)}\n`, 'utf8');
  const blocked = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /block/);
});

test('P3: feedback block/unblock/off/useful changes retrieval and weight', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const dark = manifest.cards.find((card) => card.title === '深色模式卡片');
  assert.ok(dark !== undefined);

  const query = '深色模式卡片';
  const before = await tool.execute({ action: 'search', query, topK: 5 }, exec(cwd));
  assert.match(before.detail, new RegExp(dark.id));

  const blocked = await tool.execute(
    { action: 'feedback', entries: [{ cardId: dark.id, verdict: 'block', note: '太花' }] },
    exec(cwd)
  );
  assert.equal(blocked.ok, true, blocked.detail);
  const hidden = await tool.execute({ action: 'search', query, topK: 5 }, exec(cwd));
  assert.doesNotMatch(hidden.detail, new RegExp(dark.id));

  const unblocked = await tool.execute(
    { action: 'feedback', entries: [{ cardId: dark.id, verdict: 'unblock' }] },
    exec(cwd)
  );
  assert.equal(unblocked.ok, true, unblocked.detail);
  const restored = await tool.execute({ action: 'search', query, topK: 5 }, exec(cwd));
  assert.match(restored.detail, new RegExp(dark.id));

  const off = await tool.execute({ action: 'feedback', entries: [{ cardId: dark.id, verdict: 'off' }] }, exec(cwd));
  assert.equal(off.ok, true, off.detail);
  let updated = await readDesignManifest(paths(cwd));
  assert.equal(updated?.cards.find((card) => card.id === dark.id)?.weight, 0.8);

  const useful = await tool.execute(
    { action: 'feedback', entries: [{ cardId: dark.id, verdict: 'useful' }] },
    exec(cwd)
  );
  assert.equal(useful.ok, true, useful.detail);
  updated = await readDesignManifest(paths(cwd));
  assert.equal(updated?.cards.find((card) => card.id === dark.id)?.weight, 0.88);
  const ledger = await readFile(paths(cwd).designFeedback, 'utf8');
  assert.equal(ledger.trim().split('\n').length, 4);
  assert.match(ledger, /block/);
  assert.match(ledger, /unblock/);
});

test('P3: capture requires confirmation + passing audit + baseline, then dedupes', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  await writeSpec(cwd);
  const unconfirmed = await tool.execute({ action: 'capture', page: 'home', state: 'default' }, exec(cwd));
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.summary, /confirmed/);

  const noAudit = await tool.execute(
    { action: 'capture', page: 'home', state: 'default', confirmed: true },
    exec(cwd)
  );
  assert.equal(noAudit.ok, false);
  assert.match(noAudit.summary, /审计/);

  const audit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(audit.ok, true, audit.detail);
  const noConfirmation = await tool.execute(
    { action: 'capture', page: 'home', state: 'default', confirmed: true },
    exec(cwd)
  );
  assert.equal(noConfirmation.ok, false);
  assert.match(noConfirmation.summary, /确认/);

  const confirmed = await confirmTool.execute({ decision: 'accept' }, exec(cwd));
  assert.equal(confirmed.ok, true, confirmed.detail);
  const noBaseline = await tool.execute(
    { action: 'capture', page: 'home', state: 'default', confirmed: true },
    exec(cwd)
  );
  assert.equal(noBaseline.ok, false);
  assert.match(noBaseline.summary, /基线/);

  await writeBounds(cwd, 'artifacts/evidence/bounds-v1.json', boundsV1);
  const saved = await aestheticTool.execute(
    { action: 'baseline', op: 'save', page: 'home', state: 'default', bounds: 'artifacts/evidence/bounds-v1.json' },
    exec(cwd)
  );
  assert.equal(saved.ok, true, saved.detail);

  const captured = await tool.execute(
    { action: 'capture', page: 'home', state: 'default', confirmed: true, title: '项目首页', tags: ['dark'] },
    exec(cwd)
  );
  assert.equal(captured.ok, true, captured.detail);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const projectCard = manifest.cards.find((card) => card.title === '项目首页');
  assert.ok(projectCard !== undefined);
  assert.equal(projectCard.source.kind, 'project');
  assert.equal(projectCard.tokens.radius[0]?.value, 20);
  assert.equal(projectCard.tokens.radius[0]?.unit, 'vp');
  assert.ok(projectCard.tokens.spacing.length >= 1);
  assert.equal(projectCard.tokens.palette[0]?.value, '#FAF8F4');
  assert.ok(projectCard.tokens.type.some((token) => token.value === 16));

  const again = await tool.execute(
    { action: 'capture', page: 'home', state: 'default', confirmed: true },
    exec(cwd)
  );
  assert.equal(again.ok, true, again.detail);
  assert.match(again.summary, /已存在/);
  const after = await readDesignManifest(paths(cwd));
  assert.equal(after?.cards.length, manifest.cards.length);
});

// ── 0.6.3 A/B/C/F ───────────────────────────────────────────────────────────

async function buildStructuredFixture(cwd) {
  const init = await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  assert.equal(init.ok, true, init.detail);
  await writeMeta(cwd, 'a-anti.meta.json', {
    title: '紫粉渐变',
    kind: 'anti-pattern',
    summary: '禁止大面积紫粉渐变，廉价且与严肃业务冲突',
    rationale: '紫粉渐变在金融/工具类界面里显得廉价，禁止使用。',
    tags: ['渐变', '反模式'],
    source: { kind: 'user', license: 'internal' }
  });
  await writeMeta(cwd, 'b-brand.meta.json', {
    title: '古茗品牌',
    summary: '年轻化茶饮品牌',
    source: { kind: 'brand', license: 'internal' },
    brand: {
      positioning: '年轻化茶饮，强调新鲜与日常陪伴',
      audience: ['18-25 学生与白领'],
      constraints: ['会员中心必须突出积分与优惠券', '首屏只放一个主操作'],
      bannedStyles: ['紫粉渐变', '无意义粒子动画']
    }
  });
  await writeMeta(cwd, 'c-finance.meta.json', {
    title: '金融后台数据看板',
    summary: '侧边导航 + 卡片式数据看板，高对比度与极简主义',
    rationale: '金融后台 严肃 高对比度 侧边导航 卡片式数据看板 极简主义',
    tags: ['金融后台', '数据看板'],
    stylePriority: ['极简主义', '玻璃拟态'],
    antiPatterns: ['AP-0001'],
    checklist: ['主色不超过两种', '关键数字必须有大字号层级'],
    dimensions: { appType: '金融后台', platform: 'harmonyos', style: '极简主义' },
    tokens: { palette: [{ name: 'primary', value: '#1E3A5F' }], radius: [{ name: 'card', value: 8, unit: 'vp' }] },
    source: { kind: 'user', license: 'internal' }
  });
  await writeMeta(cwd, 'd-fitness.meta.json', {
    title: '运动数据卡片',
    summary: '高能量运动数据卡片，强调动效与渐变',
    rationale: '运动 健身 高能量 渐变 动效 数据卡片',
    tags: ['运动', '数据卡片'],
    dimensions: { appType: '运动', platform: 'harmonyos', style: '高对比' },
    source: { kind: 'user', license: 'internal' }
  });
  const ingested = await ingest(cwd, ['inbox']);
  assert.equal(ingested.ok, true, ingested.detail);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const byTitle = new Map(manifest.cards.map((card) => [card.title, card]));
  return { manifest, byTitle };
}

test('0.6.4 AP-A: anti-pattern refs are gated at spec and audit, and rendered in reports', async () => {
  const cwd = await workspace();
  const { byTitle } = await buildStructuredFixture(cwd);
  const anti = byTitle.get('紫粉渐变');
  assert.ok(anti !== undefined);
  const spec = await writeSpec(cwd, { antiPatternRefs: [anti.id] });
  assert.equal(spec.ok, true, spec.detail);
  const specJson = JSON.parse(await readFile(paths(cwd).specJson, 'utf8'));
  assert.deepEqual(specJson.criteria.find((criterion) => criterion.id === 'A-01')?.antiPatternRefs, [anti.id]);

  const unknown = await writeSpec(cwd, { antiPatternRefs: ['AP-9999'] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /不存在/);

  const audit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(audit.ok, true, audit.detail);
  const report = await readFile(join(paths(cwd).shared, 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(report, /反模式对照/);
  assert.match(report, new RegExp(anti.id));
  assert.match(report, /紫粉渐变/);
  const json = JSON.parse(await readFile(join(paths(cwd).shared, 'artifacts', 'audit-1.json'), 'utf8'));
  assert.equal(json.design.antiPatterns.length, 1);
  assert.equal(json.design.antiPatterns[0].antiPatternRef, anti.id);
  assert.equal(json.design.antiPatterns[0].status, 'active');

  const specJson2 = JSON.parse(await readFile(paths(cwd).specJson, 'utf8'));
  specJson2.criteria = specJson2.criteria.map((criterion) =>
    criterion.id === 'A-01' ? { ...criterion, antiPatternRefs: ['AP-9999'] } : criterion
  );
  await writeFile(paths(cwd).specJson, `${JSON.stringify(specJson2, null, 2)}\n`, 'utf8');
  const unknownAudit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(unknownAudit.ok, false);
  assert.match(unknownAudit.detail, /不存在/);

  const raw = JSON.parse(await readFile(paths(cwd).designManifest, 'utf8'));
  raw.cards = raw.cards.map((card) => (card.id === anti.id ? { ...card, status: 'blocked' } : card));
  await writeFile(paths(cwd).designManifest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  specJson2.criteria = specJson2.criteria.map((criterion) =>
    criterion.id === 'A-01' ? { ...criterion, antiPatternRefs: [anti.id] } : criterion
  );
  await writeFile(paths(cwd).specJson, `${JSON.stringify(specJson2, null, 2)}\n`, 'utf8');
  const blockedAudit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(blockedAudit.ok, false);
  assert.match(blockedAudit.detail, /block/);
});

test('0.6.4 T-1: aesthetic templates export, merge-import and replace-import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-templates-'));
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const templateTool = createAestheticTool(resolveOptions({ aestheticTemplatesDir: dir }));
  const source = await workspace();
  const writeA = await templateTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'radius',
      decision: '卡片圆角 20vp',
      source: 'confirmation',
      confidence: 0.8,
      number: 20,
      unit: 'vp',
      confirmed: true
    },
    exec(source)
  );
  assert.equal(writeA.ok, true, writeA.detail);
  const writeSpacing = await templateTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'spacing',
      decision: '页面间距 12vp',
      source: 'confirmation',
      confidence: 0.8,
      number: 12,
      unit: 'vp',
      confirmed: true
    },
    exec(source)
  );
  assert.equal(writeSpacing.ok, true, writeSpacing.detail);
  const exported = await templateTool.execute(
    { action: 'template', op: 'export', name: 'dark-saas' },
    exec(source)
  );
  assert.equal(exported.ok, true, exported.detail);
  assert.ok(exported.detail.includes('dark-saas'));

  const listed = await templateTool.execute({ action: 'template', op: 'list' }, exec(source));
  assert.equal(listed.ok, true, listed.detail);
  assert.match(listed.detail, /dark-saas/);
  const got = await templateTool.execute({ action: 'template', op: 'get', name: 'dark-saas' }, exec(source));
  assert.equal(got.ok, true, got.detail);
  assert.match(got.detail, /20vp/);

  const target = await workspace();
  const writeLocal = await templateTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'radius',
      decision: '卡片圆角 16vp',
      source: 'confirmation',
      confidence: 0.8,
      number: 16,
      unit: 'vp',
      confirmed: true
    },
    exec(target)
  );
  assert.equal(writeLocal.ok, true, writeLocal.detail);
  const unconfirmed = await templateTool.execute(
    { action: 'template', op: 'import', name: 'dark-saas' },
    exec(target)
  );
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.summary, /confirmed/);

  const merged = await templateTool.execute(
    { action: 'template', op: 'import', name: 'dark-saas', confirmed: true },
    exec(target)
  );
  assert.equal(merged.ok, true, merged.detail);
  assert.match(merged.detail, /被替代/);
  const profile = await readFile(paths(target).aestheticProfileMd, 'utf8');
  assert.match(profile, /20vp/);
  assert.match(profile, /superseded/);

  const replaced = await templateTool.execute(
    { action: 'template', op: 'import', name: 'dark-saas', confirmed: true, strategy: 'replace' },
    exec(target)
  );
  assert.equal(replaced.ok, true, replaced.detail);
  const replacedProfile = await readFile(paths(target).aestheticProfileMd, 'utf8');
  assert.match(replacedProfile, /12vp/);

  const badName = await templateTool.execute(
    { action: 'template', op: 'export', name: '../bad' },
    exec(source)
  );
  assert.equal(badName.ok, false);
});

test('0.6.4 I-1: PNG decode + pHash/histogram features are deterministic', async () => {
  const decoded = decodePng(IMAGE_A);
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 32);
  const first = imageFeatures(decoded);
  const second = imageFeatures(decodePng(IMAGE_A));
  const inverted = imageFeatures(decodePng(IMAGE_C));
  assert.deepEqual(first, second);
  assert.match(first.phash, /^[0-9a-f]{16}$/);
  assert.equal(first.histogram.length, 64);
  const same = imageSimilarity(first, second);
  assert.equal(same.score, 1);
  assert.equal(same.hashDistance, 0);
  const different = imageSimilarity(first, inverted);
  assert.ok(different.score < 0.8, `反色图不应与同图同分，实测 ${different.score}`);
  const solid = imageFeatures(decodePng(IMAGE_D));
  const solidScore = imageSimilarity(first, solid);
  assert.ok(solidScore.score < 0.5, `纯灰图与黑白分割图应明显不同，实测 ${solidScore.score}`);
  const corrupt = Buffer.from(IMAGE_A);
  corrupt[40] ^= 0xff;
  assert.throws(() => decodePng(corrupt), /CRC|PNG/);
});

test('0.6.4 I-2: search by image ranks the matching card and caches features', async () => {
  const cwd = await workspace();
  await tool.execute({ action: 'library', op: 'init' }, exec(cwd));
  const inbox = join(paths(cwd).shared, 'design-library', 'inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'a.png'), IMAGE_A);
  await writeFile(join(inbox, 'c.png'), IMAGE_C);
  await writeMeta(cwd, 'a.meta.json', {
    title: '左暗右亮',
    summary: '黑白分割 A',
    image: 'a.png',
    source: { kind: 'user', license: 'internal' }
  });
  await writeMeta(cwd, 'c.meta.json', {
    title: '左亮右暗',
    summary: '黑白分割 C',
    image: 'c.png',
    source: { kind: 'user', license: 'internal' }
  });
  await ingest(cwd, ['inbox']);
  const manifest = await readDesignManifest(paths(cwd));
  assert.ok(manifest !== null);
  const byTitle = new Map(manifest.cards.map((card) => [card.title, card]));
  const match = byTitle.get('左暗右亮');
  const opposite = byTitle.get('左亮右暗');
  assert.ok(match !== undefined && opposite !== undefined);

  const queryFile = join(paths(cwd).shared, 'artifacts', 'query.png');
  await mkdir(dirname(queryFile), { recursive: true });
  await writeFile(queryFile, IMAGE_A);
  const found = await tool.execute({ action: 'search', image: 'artifacts/query.png', topK: 3 }, exec(cwd));
  assert.equal(found.ok, true, found.detail);
  assert.match(found.detail, /以图搜图/);
  const rows = found.detail.split('\n').filter((line) => line.startsWith('| `'));
  assert.ok(rows.length >= 2);
  assert.ok(rows[0].includes(match.id), `第一行应为匹配卡，实际：${rows[0]}`);
  assert.ok(rows.findIndex((line) => line.includes(opposite.id)) > 0);
  const cache = JSON.parse(await readFile(paths(cwd).designImageFeatures, 'utf8'));
  assert.equal(cache.schemaVersion, 1);
  assert.ok(Object.keys(cache.features).length >= 2);

  const again = await tool.execute({ action: 'search', image: 'artifacts/query.png', topK: 3 }, exec(cwd));
  assert.equal(again.ok, true, again.detail);
  assert.ok(again.detail.includes(match.id));

  const garbage = join(paths(cwd).shared, 'artifacts', 'bad.png');
  await writeFile(garbage, 'not a png');
  const bad = await tool.execute({ action: 'search', image: 'artifacts/bad.png' }, exec(cwd));
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /PNG|解码/);

  const escape = await tool.execute({ action: 'search', image: '../outside.png' }, exec(cwd));
  assert.equal(escape.ok, false);
  assert.match(escape.summary, /shared/);
});

test('0.6.4 H-1: hybrid rerank blends semantic similarity and keeps lexical breakdown', async () => {
  const base = [
    {
      cardId: 'DSG-0001',
      title: '运动渐变',
      kind: 'pattern',
      score: 3,
      breakdown: { bm25: 3, tokenBoost: 0, tagBoost: 0, profileBoost: 0, weight: 1 },
      snippet: '运动 渐变 高能量',
      tokens: { palette: [], spacing: [], radius: [], type: [], motion: [] },
      source: { kind: 'user', license: 'internal' },
      images: []
    },
    {
      cardId: 'DSG-0002',
      title: '深色卡片',
      kind: 'pattern',
      score: 2.5,
      breakdown: { bm25: 2.5, tokenBoost: 0, tagBoost: 0, profileBoost: 0, weight: 1 },
      snippet: '深色 背景 圆角',
      tokens: { palette: [], spacing: [], radius: [], type: [], motion: [] },
      source: { kind: 'user', license: 'internal' },
      images: []
    }
  ];
  const embed = async (texts) => texts.map((text) => (text.includes('深色') ? [1, 0, 0] : [0, 1, 0]));
  const out = await rerankDesignHits(base, '深色 背景', embed, { weight: 0.6, model: 'stub' });
  assert.equal(out.results[0].cardId, 'DSG-0002', '语义更近的卡片应排到 first');
  assert.ok((out.results[0].semanticScore ?? 0) > (out.results[1].semanticScore ?? 0));
  assert.equal(out.results[0].rerankWeight, 0.6);
  assert.equal(out.results[0].breakdown.bm25, 2.5, '原始 BM25 分解保留');
  assert.match(out.notes[0], /hybrid 语义重排/);
});

test('0.6.4 H-2: embedding cache avoids duplicate calls', async () => {
  let calls = 0;
  const embed = async (texts) => {
    calls += 1;
    return texts.map((text) => [text.length, 1]);
  };
  const cache = { schemaVersion: 1, model: 'stub', vectors: {} };
  const cached = createCachedEmbedder(embed, cache, 'stub');
  const first = await cached(['深色', '卡片']);
  const second = await cached(['深色', '间距']);
  assert.equal(calls, 2);
  assert.deepEqual(first[0], second[0], '同一文本复用缓存向量');
  assert.equal(Object.keys(cache.vectors).length, 3);
});

test('0.6.4 H-3: hybrid endpoint reranks via HTTP and caches vectors', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const input = JSON.parse(body).input;
      requests.push(input.length);
      const data = input.map((text) => ({
        embedding: [text.includes('深色') ? 1 : 0, text.includes('圆角') ? 1 : 0, 1]
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const cwd = await workspace();
    await buildFixtureLibrary(cwd);
    const hybrid = createDesignTool(
      resolveOptions({
        designRanker: 'hybrid',
        designEmbeddingEndpoint: `http://127.0.0.1:${port}/v1/embeddings`,
        designEmbeddingModel: 'stub',
        designEmbeddingTimeoutMs: 3000,
        designEmbeddingWeight: 0.5
      })
    );
    const first = await hybrid.execute({ action: 'search', query: '深色 卡片', topK: 3 }, exec(cwd));
    assert.equal(first.ok, true, first.detail);
    assert.match(first.detail, /hybrid/);
    assert.match(first.detail, /语义权重 0\.5/);
    const cache = JSON.parse(await readFile(paths(cwd).designEmbeddings, 'utf8'));
    assert.equal(cache.model, 'stub');
    assert.ok(Object.keys(cache.vectors).length >= 3);
    const before = requests.length;
    const second = await hybrid.execute({ action: 'search', query: '深色 卡片', topK: 3 }, exec(cwd));
    assert.equal(second.ok, true, second.detail);
    assert.equal(requests.length, before, '第二次检索应全部命中缓存');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('0.6.4 H-4: missing or unreachable embedding endpoint falls back to lexical', async () => {
  const cwd = await workspace();
  await buildFixtureLibrary(cwd);
  const noEndpoint = createDesignTool(resolveOptions({ designRanker: 'hybrid' }));
  const first = await noEndpoint.execute({ action: 'search', query: '深色 卡片', topK: 3 }, exec(cwd));
  assert.equal(first.ok, true, first.detail);
  assert.match(first.detail, /未配置 designEmbeddingEndpoint|回退 lexical/);

  const unreachable = createDesignTool(
    resolveOptions({
      designRanker: 'hybrid',
      designEmbeddingEndpoint: 'http://127.0.0.1:1/v1/embeddings',
      designEmbeddingTimeoutMs: 1000
    })
  );
  const second = await unreachable.execute({ action: 'search', query: '深色 卡片', topK: 3 }, exec(cwd));
  assert.equal(second.ok, true, second.detail);
  assert.match(second.detail, /回退 lexical/);
  assert.match(second.detail, /DSG-/);
});

test('0.6.3 A: structured card fields round-trip and retrieval filters work', async () => {
  const cwd = await workspace();
  const { byTitle } = await buildStructuredFixture(cwd);
  const finance = byTitle.get('金融后台数据看板');
  const anti = byTitle.get('紫粉渐变');
  const brand = byTitle.get('古茗品牌');
  assert.ok(finance !== undefined && anti !== undefined && brand !== undefined);
  assert.deepEqual(finance.stylePriority, ['极简主义', '玻璃拟态']);
  assert.deepEqual(finance.antiPatterns, ['AP-0001']);
  assert.deepEqual(finance.checklist, ['主色不超过两种', '关键数字必须有大字号层级']);
  assert.equal(finance.dimensions?.appType, '金融后台');
  assert.match(anti.id, /^AP-0001$/);
  assert.equal(anti.kind, 'anti-pattern');
  assert.equal(brand.brand?.positioning, '年轻化茶饮，强调新鲜与日常陪伴');

  const filtered = await tool.execute(
    { action: 'search', query: '数据看板 极简主义', topK: 5, appType: '金融后台' },
    exec(cwd)
  );
  assert.equal(filtered.ok, true, filtered.detail);
  const topIds = filtered.detail.split('\n').filter((line) => line.startsWith('| `'));
  assert.ok(topIds.some((line) => line.includes(finance.id)));
  assert.ok(topIds.every((line) => !line.includes(byTitle.get('运动数据卡片')?.id)));

  const byStyle = await tool.execute({ action: 'search', query: '卡片', topK: 5, style: '极简主义' }, exec(cwd));
  assert.ok(byStyle.detail.includes(finance.id));
  assert.ok(!byStyle.detail.includes(byTitle.get('运动数据卡片')?.id));

  const antiSearch = await tool.execute(
    { action: 'search', query: '紫粉渐变', topK: 5, kind: 'anti-pattern' },
    exec(cwd)
  );
  assert.ok(antiSearch.detail.includes(anti.id));
  assert.ok(!antiSearch.detail.includes(finance.id), 'anti-pattern 检索不应该混入 pattern');

  const brandDefault = await tool.execute({ action: 'search', query: '古茗', topK: 5 }, exec(cwd));
  assert.ok(!brandDefault.detail.includes(brand.id), '品牌卡默认不进 pattern 检索');
  const brandSearch = await tool.execute({ action: 'search', query: '古茗', topK: 5, kind: 'brand' }, exec(cwd));
  assert.ok(brandSearch.detail.includes(brand.id));

  // CLI must apply the same filters.
  const script = paths(cwd).designQueryScript;
  const output = await run(
    process.execPath,
    [script, '数据看板 极简主义', '--app-type', '金融后台', '--top', '5', '--json'],
    { cwd }
  );
  const cli = JSON.parse(output.stdout);
  assert.deepEqual(cli.results.map((hit) => hit.cardId), [finance.id]);
});

test('0.6.3 B: brand cards are validated and force-injected into the brief', async () => {
  const cwd = await workspace();
  const { byTitle } = await buildStructuredFixture(cwd);
  const brand = byTitle.get('古茗品牌');
  assert.ok(brand !== undefined);
  await writeSpec(cwd);
  const brief = await tool.execute({ action: 'brief' }, exec(cwd));
  assert.equal(brief.ok, true, brief.detail);
  const markdown = await readFile(paths(cwd).designBriefMd, 'utf8');
  assert.match(markdown, /品牌与业务约束（强制注入）/);
  assert.match(markdown, /年轻化茶饮/);
  assert.match(markdown, /会员中心必须突出积分与优惠券/);
  assert.match(markdown, /禁用风格：紫粉渐变、无意义粒子动画/);

  // A brand card without any brand payload is rejected at ingest.
  const invalid = await workspace();
  await tool.execute({ action: 'library', op: 'init' }, exec(invalid));
  await writeMeta(invalid, 'bad-brand.meta.json', {
    title: '空品牌卡',
    source: { kind: 'brand', license: 'internal' },
    brand: {}
  });
  const result = await ingest(invalid, ['inbox']);
  assert.match(result.detail, /brand\.positioning|已跳过/);
  const manifest = await readDesignManifest(paths(invalid));
  assert.equal(manifest?.cards.length, 0);
});

test('0.6.3 C: per-round design-search budget stops and resets on a new spec', async () => {
  const cwd = await workspace();
  const limited = createDesignTool(resolveOptions({ maxDesignSearches: 2 }));
  const limitedSpec = createSpecTool(resolveOptions({ maxDesignSearches: 2 }));
  await limited.execute({ action: 'library', op: 'init' }, exec(cwd));
  await writeMeta(cwd, 'c.meta.json', {
    title: '圆角卡片',
    summary: '圆角 16vp 卡片',
    rationale: '卡片 圆角 间距',
    source: { kind: 'user', license: 'internal' }
  });
  await limited.execute({ action: 'library', op: 'ingest' }, exec(cwd));
  const first = await limited.execute({ action: 'search', query: '卡片' }, exec(cwd));
  const second = await limited.execute({ action: 'search', query: '圆角' }, exec(cwd));
  assert.equal(first.ok, true, first.detail);
  assert.equal(second.ok, true, second.detail);
  const blocked = await limited.execute({ action: 'search', query: '间距' }, exec(cwd));
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /预算|上限/);
  const state = JSON.parse(await readFile(join(paths(cwd).shared, 'state.json'), 'utf8'));
  assert.equal(state.roundDesignSearches, 2);

  const spec = await limitedSpec.execute(
    {
      action: 'write',
      title: '预算测试',
      requirement: '用户需要看到首页卡片列表、圆角与间距的具体数值。',
      spec: '首页展示卡片列表；卡片圆角 16vp，页面间距 12vp，遵循任务包里的验收标准。',
      criteria
    },
    exec(cwd)
  );
  assert.equal(spec.ok, true, spec.detail);
  const resetState = JSON.parse(await readFile(join(paths(cwd).shared, 'state.json'), 'utf8'));
  assert.equal(resetState.roundDesignSearches, 0);
  const afterReset = await limited.execute({ action: 'search', query: '卡片' }, exec(cwd));
  assert.equal(afterReset.ok, true, afterReset.detail);
});

test('0.6.3 C: per-round audit budget hard-stops and status exposes it', async () => {
  const cwd = await workspace();
  const opts = resolveOptions({ maxAuditRounds: 1 });
  const limitedAudit = createAuditTool(opts);
  const limitedSpec = createSpecTool(opts);
  await writeSpec(cwd);
  const failing = checks.map((check) =>
    check.criterionId === 'A-01' ? { ...check, result: 'fail', evidence: '实测 20vp，与参考 16vp 不一致' } : check
  );
  const first = await limitedAudit.execute({ checks: failing }, exec(cwd));
  assert.equal(first.ok, false, first.detail);
  assert.match(first.detail, /返工单/);
  const second = await limitedAudit.execute({ checks: failing }, exec(cwd));
  assert.equal(second.ok, false);
  assert.match(second.summary, /上限|用尽/);

  const status = await createStatusTool(opts).execute({}, exec(cwd));
  assert.match(status.detail, /本轮预算：审计 1\/1/);
  assert.match(status.next, /上限|maxAuditRounds/);
});

test('0.6.3 F: failed aesthetic audit feeds the next brief, passing clears it', async () => {
  const cwd = await workspace();
  const { byTitle } = await buildStructuredFixture(cwd);
  const finance = byTitle.get('金融后台数据看板');
  assert.ok(finance !== undefined);
  const spec = await writeSpec(cwd, { designRefs: [finance.id] });
  assert.equal(spec.ok, true, spec.detail);

  const failing = checks.map((check) =>
    check.criterionId === 'A-01' ? { ...check, result: 'fail', evidence: '实测 20vp，与参考 8vp 不一致' } : check
  );
  const audit = await auditTool.execute({ checks: failing }, exec(cwd));
  assert.equal(audit.ok, false, audit.detail);
  const rework = await readFile(join(paths(cwd).shared, 'tasks', 'rework-1.md'), 'utf8');
  assert.match(rework, /设计参考建议（0\.6\.3）/);
  assert.match(rework, /建议检索/);
  assert.match(rework, new RegExp(finance.id));
  const queue = JSON.parse(await readFile(paths(cwd).designReworkQueue, 'utf8'));
  assert.equal(queue.suggestions[0].criterionId, 'A-01');
  assert.match(queue.suggestions[0].query, /深色模式卡片/);

  const brief = await tool.execute({ action: 'brief' }, exec(cwd));
  assert.equal(brief.ok, true, brief.detail);
  assert.match(brief.detail, /返工定向/);
  const markdown = await readFile(paths(cwd).designBriefMd, 'utf8');
  assert.match(markdown, /上一轮返工定向参考/);
  assert.match(markdown, /建议检索/);

  const passing = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(passing.ok, true, passing.detail);
  await assert.rejects(readFile(paths(cwd).designReworkQueue, 'utf8'));
});
