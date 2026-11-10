// 0.9.4 design knowledge must stay citation/summary-only and measurable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const guide = JSON.parse(readFileSync(new URL('docs/design-guide/index.json', root), 'utf8'));
const resources = JSON.parse(readFileSync(new URL('docs/design-resources/index.json', root), 'utf8'));
const foundations = JSON.parse(readFileSync(new URL('docs/design-foundations.json', root), 'utf8'));
const rubric = readFileSync(new URL('skills/hmos-acceptance-rubric.md', root), 'utf8');
const ruleCatalog = readFileSync(new URL('src/rules.ts', root), 'utf8');
const ruleIds = new Set([...`${rubric}\n${ruleCatalog}`.matchAll(/DW-(?:AES|A11Y|FN|PERF|AGC)-\d+/g)].map((match) => match[0]));
const guideIds = new Set(guide.entries.map((entry) => entry.id));

test('design-guide index is citation/summary only', () => {
  assert.equal(guide.schemaVersion, 1);
  assert.match(guide.source, /docs-ux-design\.txt$/);
  assert.match(guide.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(guide.count > 100);
  assert.equal(guide.entries.length, guide.count);
  for (const entry of guide.entries) {
    assert.match(entry.id, /^HW-UX-\d{3}$/);
    assert.match(entry.url, /^https:\/\/developer\.huawei\.com\/consumer\/cn\/.+\..+$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.fetchedAt.length >= 20);
    assert.ok(entry.summary.length > 0);
    assert.equal(entry.contentStored, false);
    assert.ok(Array.isArray(entry.sections));
    for (const section of entry.sections) {
      assert.match(section.id, new RegExp(`^${entry.id}-S\\d{2,3}$`));
      assert.equal(section.hwUxId, entry.id);
      assert.ok(section.level >= 2);
      assert.equal(section.headingPath.at(-1), section.title);
      assert.ok(section.summary.length > 0);
      assert.match(section.anchor, /^#/);
      assert.ok(section.anchorUrl.startsWith(entry.url.replace(/\.md$/, '') + '#'));
      assert.equal(section.anchorKind, 'heading-fragment');
      assert.equal(section.contentStored, false);
      assert.ok(['direct', 'descendant', 'unbound'].includes(section.mappingStatus));
      for (const rule of section.ruleRefs) assert.ok(ruleIds.has(rule), `${section.id} has unknown rule ${rule}`);
      for (const forbidden of ['content', 'body', 'markdown', 'images', 'assets']) {
        assert.equal(Object.hasOwn(section, forbidden), false, `${section.id} must not store ${forbidden}`);
      }
    }
    for (const forbidden of ['content', 'body', 'markdown', 'images', 'assets']) {
      assert.equal(Object.hasOwn(entry, forbidden), false, `${entry.id} must not store ${forbidden}`);
    }
  }
});

test('convenient-life has all 25 subsection headings and rule mappings', () => {
  const target = guide.entries.find((entry) => entry.url.includes('convenient-life-0000001957252465'));
  assert.ok(target, 'target document missing');
  assert.equal(target.id, 'HW-UX-031');
  assert.equal(target.sections.length, 25);
  const titles = target.sections.map((section) => section.title);
  for (const expected of [
    '首页的自适应布局', '美食页面', '搜索列表', '店铺页', '详情页', '选规格',
    '电影', '选电影', '电影简介', '选影院', '实况窗', '推荐', '短视频',
    '视频详情看评论', '查看更多辅助信息', '视频悬停', '直播间', '笔记详情',
    '图文笔记', '图文浏览效果', '个人主页', '关注动态',
    '范式一：单列卡片变分栏+宫格/瀑布流布局',
    '范式二：单列卡片变宫格/瀑布流布局',
    '范式三：单列卡片变宽'
  ]) {
    assert.ok(titles.includes(expected), `missing subsection: ${expected}`);
  }
  assert.equal(new Set(titles).size, 25);
  assert.ok(target.sections.every((section) => section.ruleRefs.length > 0), 'target sections must all map to a rule');
});

test('design-resource cards are link-only and declare license/scope', () => {
  assert.equal(resources.schemaVersion, 1);
  assert.ok(resources.cards.length >= 6);
  for (const card of resources.cards) {
    assert.match(card.id, /^DR-HW-\d{3}$/);
    assert.match(card.url, /^https:\/\/developer\.huawei\.com\/consumer\/cn\//);
    assert.ok(card.license.length > 0);
    assert.ok(card.scope.length > 0);
    assert.ok(card.usage.length > 0);
    assert.ok(card.notFor.length > 0);
    for (const forbidden of ['file', 'path', 'binary', 'image']) {
      assert.equal(Object.hasOwn(card, forbidden), false, `${card.id} must not bundle ${forbidden}`);
    }
    for (const ref of card.guideRefs) assert.ok(guideIds.has(ref), `${card.id} has unknown guide ref ${ref}`);
  }
});

test('design-foundations items bind to measurable DW rules and guide refs', () => {
  assert.equal(foundations.schemaVersion, 1);
  const sections = new Set(foundations.sections.map((section) => section.id));
  for (const id of ['principles', 'layout', 'color', 'typography', 'icon', 'motion', 'accessibility']) {
    assert.ok(sections.has(id), `missing section ${id}`);
  }
  let itemCount = 0;
  for (const section of foundations.sections) {
    for (const item of section.items) {
      itemCount += 1;
      assert.ok(item.measure.length >= 8, `${item.id} needs a measurable claim`);
      assert.ok(item.verify.length >= 8, `${item.id} needs a verification method`);
      assert.ok(item.ruleRefs.length > 0, `${item.id} needs at least one rule`);
      for (const rule of item.ruleRefs) assert.ok(ruleIds.has(rule), `${item.id} has unknown rule ${rule}`);
      for (const ref of item.guideRefs) assert.ok(guideIds.has(ref), `${item.id} has unknown guide ref ${ref}`);
    }
  }
  assert.ok(itemCount >= 20);
});

test('rendered design-foundations markdown contains every foundation id', () => {
  const markdown = readFileSync(new URL('docs/design-foundations.md', root), 'utf8');
  for (const section of foundations.sections) {
    for (const item of section.items) assert.match(markdown, new RegExp(item.id));
  }
});
