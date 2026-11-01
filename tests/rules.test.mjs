// Rule catalog: stable IDs, aliases, and enforcement in spec / findings.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-rules-home-'));

import { resolveOptions } from '../lib/config.js';
import { findRule, isKnownRuleId, RULES } from '../lib/rules.js';
import { normalizeFindings } from '../lib/review.js';
import { createSpecTool } from '../lib/tools/spec.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const options = resolveOptions({});
const specTool = createSpecTool(options);

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

test('catalog ids and aliases are unique and resolvable', () => {
  const seen = new Map();
  for (const rule of RULES) {
    assert.match(rule.id, /^DW-[A-Z0-9]+-\d{2}$/, `bad canonical id: ${rule.id}`);
    assert.ok(rule.title.length > 0, `${rule.id} needs a title`);
    assert.ok(rule.verify.length > 0, `${rule.id} needs a verify method`);
    assert.ok(seen.get(rule.id) === undefined, `duplicate id ${rule.id}`);
    seen.set(rule.id, rule);
    for (const alias of rule.aliases ?? []) {
      assert.ok(seen.get(alias) === undefined, `alias ${alias} already used`);
      seen.set(alias, rule);
      assert.equal(findRule(alias)?.id, rule.id, `${alias} should resolve to ${rule.id}`);
    }
  }
  // The IDs the static scanner emits must all live in the catalog.
  for (const scanId of ['STATE-NESTED-01', 'ARKTS-ANY-001', 'ARKTS-IMPORT-KIT', 'ARKTS-V1V2-MIX', 'OHPM-FAKE-001', 'PERF-LIST-FOREACH', 'LIFECYCLE-TIMER', 'A11Y-TEXT-001']) {
    assert.ok(isKnownRuleId(scanId), `scan rule ${scanId} missing from catalog`);
  }
  // AGC rejection IDs that our rubric cites must resolve too.
  for (const agcId of ['AGC-RJ-001', 'AGC-RJ-002', 'AGC-RJ-004', 'AGC-RJ-007', 'AGC-RJ-009', 'AGC-RJ-012', 'AGC-RJ-013', 'AGC-RJ-014', 'AGC-RJ-015', 'AGC-RJ-016', 'AGC-RJ-017', 'AGC-RJ-018']) {
    assert.ok(isKnownRuleId(agcId), `AGC rule ${agcId} missing from catalog`);
  }
  assert.equal(findRule('NOPE-999'), undefined);
});

test('spec rejects an unknown ruleId and renders a known one', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dwguard-rules-'));
  dirs.push(cwd);
  const baseCriteria = [
    { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图 F-01.png', ruleId: 'DW-FN-01' },
    { id: 'A-01', dimension: 'aesthetic', statement: '打卡卡片间距 12vp、圆角 16vp', verify: '布局树 bounds 实测', ruleId: 'DW-AES-01' },
    { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析截图', ruleId: 'DW-PERF-01' },
    { id: 'X-01', dimension: 'accessibility', statement: '打卡按钮触控热区 ≥ 48vp', verify: '布局树 bounds 实测', ruleId: 'DW-A11Y-02' }
  ];

  const bad = await specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria: baseCriteria.map((criterion) => ({ ...criterion, ruleId: 'NOPE-999' }))
    },
    exec(cwd)
  );
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /引用的规则 `NOPE-999` 不存在/);

  const good = await specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria: baseCriteria
    },
    exec(cwd)
  );
  assert.equal(good.ok, true, good.detail);
  const markdown = await readFile(join(cwd, '.shared', 'tasks', 'spec.md'), 'utf8');
  assert.match(markdown, /DW-A11Y-02/);
  assert.match(markdown, /DW-FN-01/);

  // Missing ruleId is only a warning, not a gate.
  const loose = await specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria: baseCriteria.map(({ ruleId, ...rest }) => rest)
    },
    exec(cwd)
  );
  assert.equal(loose.ok, true, loose.detail);
  assert.match(loose.detail, /没有引用规则 ID/);
});

test('citations are well formed and point at official sources', () => {
  const cited = RULES.filter((rule) => rule.citation !== undefined);
  assert.ok(cited.length >= 8, `expected at least 8 cited rules, got ${cited.length}`);
  for (const rule of cited) {
    assert.match(rule.citation.url, /^https:\/\//, `${rule.id} citation url`);
    assert.ok(rule.citation.label.length > 0, `${rule.id} citation label`);
    assert.ok(rule.citation.version !== undefined, `${rule.id} citation version`);
  }
  const state = RULES.find((rule) => rule.id === 'DW-FN-12');
  assert.ok(state?.citation, 'DW-FN-12 must cite the state management doc');
  assert.match(state.citation.url, /arkts-state\.md$/);
  assert.equal(state.aliases?.[0], 'STATE-NESTED-01');
  const touch = RULES.find((rule) => rule.id === 'DW-A11Y-02');
  assert.equal(touch?.citation?.section, '2.1.3.3');
});

test('findings reject unknown rule IDs', () => {
  assert.throws(
    () =>
      normalizeFindings([
        {
          dimension: 'accessibility',
          severity: 'major',
          title: '触控热区不足',
          evidence: '布局树 bounds 32vp',
          ruleId: 'NOPE-999'
        }
      ]),
    /未知规则/
  );
  const ok = normalizeFindings([
    {
      dimension: 'accessibility',
      severity: 'major',
      title: '触控热区不足',
      evidence: '布局树 bounds 32vp',
      ruleId: 'AGC-RJ-013'
    }
  ]);
  assert.equal(ok[0].ruleId, 'AGC-RJ-013');
});
