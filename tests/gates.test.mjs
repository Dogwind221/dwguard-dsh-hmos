// Gate-level tests: the rules that decide whether a round may advance.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gateDelivery, gatePrereview, normalizeChecks, normalizeFindings, summarizeCoverage } from '../lib/review.js';

const options = {
  sharedDir: '.shared',
  promptSection: true,
  installSkills: true,
  minCriteriaPerDimension: 1,
  requireRebuttalOnBlocker: true,
  requirePrereviewBeforeDispatch: true,
  devecoBriefPath: '',
  knowledgeMaxEntriesPerTopic: 200
};

const pack = {
  schemaVersion: 1,
  title: '训练打卡',
  requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
  spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。',
  constraints: ['compatibleSdkVersion 5.0.0(12)'],
  criteria: [
    { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图', weight: 'must' },
    { id: 'A-01', dimension: 'aesthetic', statement: '打卡卡片间距 12vp，圆角 16vp', verify: '截图 + 布局树实测', weight: 'must' },
    { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析截图', weight: 'must' },
    { id: 'X-01', dimension: 'accessibility', statement: '打卡按钮文字对比度 ≥ 4.5:1', verify: '截图取样并计算对比度', weight: 'must' }
  ],
  iteration: 1,
  specVersion: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z'
};

const goodFinding = (overrides = {}) => ({
  id: 'R-01',
  dimension: 'architecture',
  severity: 'blocker',
  title: '连续天数在跨天时不会重置',
  evidence: 'index.ets:88 用 Date.now() 缓存了当天日期，跨天后未刷新',
  suggestion: '在 aboutToAppear 里比较日期并重置',
  rebuttal: '尝试反驳：系统时间变化不频繁，但用户跨天使用是常态，无法反驳',
  ...overrides
});

test('pre-review blocks a blocker without a rebuttal', () => {
  const findings = normalizeFindings([goodFinding({ rebuttal: undefined })]);
  const gate = gatePrereview(findings, '通读 spec 与首页源码', options);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /反驳/);
});

test('pre-review keeps an open blocker closed even after a rebuttal', () => {
  const findings = normalizeFindings([goodFinding()]);
  const gate = gatePrereview(findings, '通读 spec 与首页源码', options);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /未关闭的阻断项/);
});

test('pre-review passes once the blocker is recorded as fixed', () => {
  const findings = normalizeFindings([goodFinding({ status: 'fixed' })]);
  const gate = gatePrereview(findings, '已在任务包 v2 加入跨天重置判据', options);
  assert.equal(gate.pass, true, gate.errors.join('\n'));
});

test('pre-review requires a scope note when there are no findings', () => {
  const gate = gatePrereview([], '', options);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /审阅范围/);

  const ok = gatePrereview([], '通读了 build-profile 与首页，覆盖四视角', options);
  assert.equal(ok.pass, true, ok.errors.join('\n'));
});

test('delivery fails while a must criterion is unchecked', () => {
  const checks = normalizeChecks([
    { criterionId: 'F-01', result: 'pass', evidence: '点打卡后 3→4，截图 F-01.png' }
  ]);
  const gate = gateDelivery(pack, checks, []);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /没有检查记录|维度没有任何已取证/);
});

test('delivery fails on open major findings', () => {
  const checks = normalizeChecks(
    pack.criteria.map((criterion) => ({
      criterionId: criterion.id,
      result: 'pass',
      evidence: '命令行输出与截图见 artifacts 目录'
    }))
  );
  const findings = normalizeFindings([
    {
      id: 'R-02',
      dimension: 'accessibility',
      severity: 'major',
      title: '次要文字对比度不足',
      evidence: '#8A8A8A on #FFFFFF = 3.1:1'
    }
  ]);
  const gate = gateDelivery(pack, checks, findings);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /仍未关闭/);
});

test('delivery passes when every must criterion has evidence', () => {
  const checks = normalizeChecks(
    pack.criteria.map((criterion) => ({
      criterionId: criterion.id,
      result: 'pass',
      evidence: `artifacts/${criterion.id}.png 与布局树片段`,
      evidenceFiles: [`artifacts/${criterion.id}.png`]
    }))
  );
  const gate = gateDelivery(pack, checks, []);
  assert.equal(gate.pass, true, gate.errors.join('\n'));
  const coverage = summarizeCoverage(pack, checks);
  assert.equal(coverage.total, 4);
  assert.equal(coverage.passed, 4);
  assert.deepEqual(coverage.missing, []);
});

test('an unverified must criterion cannot pass', () => {
  const checks = normalizeChecks(
    pack.criteria.map((criterion) => ({
      criterionId: criterion.id,
      result: criterion.id === 'X-01' ? 'unverified' : 'pass',
      evidence: '截图见 artifacts'
    }))
  );
  const gate = gateDelivery(pack, checks, []);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /未验证/);
});
