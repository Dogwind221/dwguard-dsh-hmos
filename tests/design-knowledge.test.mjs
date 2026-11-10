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
    for (const forbidden of ['content', 'body', 'markdown', 'images', 'assets']) {
      assert.equal(Object.hasOwn(entry, forbidden), false, `${entry.id} must not store ${forbidden}`);
    }
  }
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
