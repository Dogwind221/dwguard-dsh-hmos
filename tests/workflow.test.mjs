// End-to-end workflow test: the tools against a throwaway workspace.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Keep the workspace registry the tools write out of the real DSH home.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-home-'));

import { resolveOptions } from '../lib/config.js';
import { readBoard } from '../lib/board.js';
import { writeEvidenceBundle } from '../lib/evidence.js';
import { resolvePaths } from '../lib/paths.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createAuditDimensionTool } from '../lib/tools/auditDimension.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createKnowledgeTool } from '../lib/tools/knowledge.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';
import { createStatusTool } from '../lib/tools/status.js';

const options = resolveOptions({ strictEvidence: false });
const specTool = createSpecTool(options);
const prereviewTool = createPrereviewTool(options);
const dispatchTool = createDispatchTool(options);
const auditTool = createAuditTool(options);
const auditDimensionTool = createAuditDimensionTool(options);
const knowledgeTool = createKnowledgeTool(options);
const statusTool = createStatusTool(options);

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-'));
  dirs.push(dir);
  return dir;
}

function exec(cwd) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    agent: { session: { header: { cwd } } }
  };
}

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图 F-01.png' },
  { id: 'A-01', dimension: 'aesthetic', statement: '打卡卡片间距 12vp、圆角 16vp', verify: '截图 + 布局树 bounds 实测' },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析截图与毫秒数' },
  { id: 'X-01', dimension: 'accessibility', statement: '打卡按钮文字对比度 ≥ 4.5:1', verify: '截图取样计算对比度数值' }
];

async function writeSpec(cwd) {
  return specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。',
      constraints: ['compatibleSdkVersion 5.0.0(12)', '不改 AppScope'],
      criteria
    },
    exec(cwd)
  );
}

test('spec write scaffolds the protocol and freezes the pack', async () => {
  const cwd = await workspace();
  const result = await writeSpec(cwd);
  assert.equal(result.ok, true, result.detail);
  const spec = JSON.parse(await readFile(join(cwd, '.shared', 'tasks', 'spec.json'), 'utf8'));
  assert.equal(spec.criteria.length, 4);
  assert.equal(spec.specVersion, 1);
  const readme = await readFile(join(cwd, '.shared', 'README.md'), 'utf8');
  assert.match(readme, /DSH ↔ DevEco Code/);
});

test('spec write rejects a vague criterion and writes nothing', async () => {
  const cwd = await workspace();
  const result = await specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。',
      criteria: [
        { id: 'F-01', dimension: 'function', statement: '打卡功能正常', verify: '自测通过' },
        { id: 'A-01', dimension: 'aesthetic', statement: '界面美观', verify: '看起来舒服' }
      ]
    },
    exec(cwd)
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /不可证伪|过短|验证方式/);
  await assert.rejects(readFile(join(cwd, '.shared', 'tasks', 'spec.json'), 'utf8'));
});

test('dispatch is refused until the pre-review passes', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  const blocked = await dispatchTool.execute({}, exec(cwd));
  assert.equal(blocked.ok, false);
  assert.match(blocked.next, /prereview/);

  const review = await prereviewTool.execute(
    {
      note: '通读 spec 与首页源码，覆盖性能/生命周期/并发/API 兼容',
      findings: [
        {
          dimension: 'architecture',
          severity: 'major',
          title: '跨天后连续天数不会重置',
          evidence: 'index.ets:88 缓存了当天日期，跨天后未刷新',
          suggestion: '在 aboutToAppear 里比较日期并重置',
          rebuttal: '尝试反驳：跨天使用是常态，无法反驳'
        }
      ]
    },
    exec(cwd)
  );
  assert.equal(review.ok, true, review.detail);

  const dispatched = await dispatchTool.execute({}, exec(cwd));
  assert.equal(dispatched.ok, true, dispatched.detail);
  const brief = await readFile(join(cwd, '.shared', 'tasks', 'goal-brief.md'), 'utf8');
  assert.match(brief, /DevEco Code · Goal 模式任务简报/);
  assert.match(brief, /\| 判据 \| 维度 \| 权重 \|/);
  const outbox = await readFile(join(cwd, '.shared', 'outbox-dsh.md'), 'utf8');
  assert.match(outbox, /dispatch #1/);
});

test('a failing audit writes a rework order, a passing audit writes the report', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  await dispatchTool.execute({}, exec(cwd));

  const failing = await auditTool.execute(
    {
      note: '模拟器 API 12，浅色模式',
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '点打卡后 3→4，截图 artifacts/F-01.png' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 显示间距 12vp' },
        { criterionId: 'P-01', result: 'fail', evidence: 'Profiler 冷启动 1240ms > 800ms' },
        { criterionId: 'X-01', result: 'pass', evidence: '对比度 4.9:1' }
      ]
    },
    exec(cwd)
  );
  assert.equal(failing.ok, false);
  const rework = await readFile(join(cwd, '.shared', 'tasks', 'rework-1.md'), 'utf8');
  assert.match(rework, /返工单 · 审计 #1 未通过/);
  assert.match(rework, /P-01/);

  const passing = await auditTool.execute(
    {
      note: '返工后复测，3 次冷启动取中位数 720ms',
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '点打卡后 3→4，截图 artifacts/F-01b.png' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 显示间距 12vp' },
        { criterionId: 'P-01', result: 'pass', evidence: '3 次冷启动 700/720/760ms，中位数 720ms' },
        { criterionId: 'X-01', result: 'pass', evidence: '对比度 4.9:1' }
      ]
    },
    exec(cwd)
  );
  assert.equal(passing.ok, true, passing.detail);
  const report = await readFile(join(cwd, '.shared', 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(report, /结论：\*\*通过\*\*/);

  const status = await statusTool.execute({ markInboxRead: true }, exec(cwd));
  assert.equal(status.ok, true);
  assert.match(status.summary, /验收通过/);
});

test('knowledge appends once and skips exact repeats', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  const first = await knowledgeTool.execute(
    {
      entries: [
        { topic: 'ArkUI State', kind: 'rework', statement: '列表页空态总是漏掉，加入任务包模板', evidence: 'F-02 / audit-3' }
      ]
    },
    exec(cwd)
  );
  assert.equal(first.ok, true, first.detail);
  const second = await knowledgeTool.execute(
    {
      entries: [
        { topic: 'arkui-state', kind: 'rework', statement: '列表页空态总是漏掉，加入任务包模板', evidence: 'F-02 / audit-3' }
      ]
    },
    exec(cwd)
  );
  assert.equal(second.ok, false);
  const body = await readFile(join(cwd, '.shared', 'knowledge', 'arkui-state.md'), 'utf8');
  assert.equal(body.match(/## \[返工教训\]/g)?.length, 1);
});

test('status derives phases from artifacts', async () => {
  const cwd = await workspace();
  const empty = await statusTool.execute({}, exec(cwd));
  assert.match(empty.summary, /待写任务包/);

  await writeSpec(cwd);
  const afterSpec = await statusTool.execute({}, exec(cwd));
  assert.match(afterSpec.summary, /待派发前预审/);

  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  const ready = await statusTool.execute({}, exec(cwd));
  assert.match(ready.summary, /预审通过，待派发/);
});

test('audit dimensions land one by one and clear after the final audit', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  await dispatchTool.execute({}, exec(cwd));

  const empty = await readBoard(cwd, options, new Date().toISOString());
  assert.deepEqual(
    empty.dimensions.map((dimension) => dimension.state),
    ['pending', 'pending', 'pending', 'pending']
  );

  const first = await auditDimensionTool.execute(
    { dimension: 'function', passed: 1, failed: 0, note: '主路径走通' },
    exec(cwd)
  );
  assert.equal(first.ok, true, first.detail);
  assert.match(first.summary, /1\/4/);

  const afterOne = await readBoard(cwd, options, new Date().toISOString());
  const functionDim = afterOne.dimensions.find((dimension) => dimension.key === 'function');
  const performanceDim = afterOne.dimensions.find((dimension) => dimension.key === 'performance');
  assert.equal(functionDim?.state, 'done');
  assert.equal(functionDim?.passed, 1);
  assert.equal(performanceDim?.state, 'pending');

  for (const [dimension, passed, failed] of [
    ['aesthetic', 1, 0],
    ['performance', 0, 1],
    ['accessibility', 1, 0]
  ]) {
    await auditDimensionTool.execute({ dimension, passed, failed }, exec(cwd));
  }
  const all = await readBoard(cwd, options, new Date().toISOString());
  assert.equal(all.dimensions.find((dimension) => dimension.key === 'performance')?.state, 'failed');
  assert.equal(all.dimensions.find((dimension) => dimension.key === 'accessibility')?.state, 'done');

  const audit = await auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '截图 artifacts/F-01.png' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 12vp' },
        { criterionId: 'P-01', result: 'pass', evidence: '3 次冷启动 700/720/760ms' },
        { criterionId: 'X-01', result: 'pass', evidence: '对比度 4.9:1' }
      ]
    },
    exec(cwd)
  );
  assert.equal(audit.ok, true, audit.detail);
  // The final audit consumes the progress document: the next round starts clean.
  await assert.rejects(readFile(join(cwd, '.shared', 'artifacts', 'audit-progress.json'), 'utf8'));
});

test('audit evidence files are bundled with sha256, and a missing one aborts the audit', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  await dispatchTool.execute({}, exec(cwd));

  const evidence = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
  await writeFile(join(cwd, '.shared', 'artifacts', 'home.png'), evidence);

  const result = await auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '截图 home.png：连续天数 3→4', evidenceFiles: ['artifacts/home.png'] },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 12vp', evidenceFiles: ['artifacts/home.png'] },
        { criterionId: 'P-01', result: 'pass', evidence: '3 次冷启动 700/720/760ms' },
        { criterionId: 'X-01', result: 'pass', evidence: '对比度 4.9:1' }
      ]
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);

  const manifest = JSON.parse(
    await readFile(join(cwd, '.shared', 'artifacts', 'audit-1', 'manifest.json'), 'utf8')
  );
  const expected = createHash('sha256').update(evidence).digest('hex');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].sha256, expected);
  assert.equal(manifest.files[0].path, 'artifacts/home.png');
  assert.match(manifest.files[0].storedAs, /^evidence\//);

  const markdown = await readFile(join(cwd, '.shared', 'artifacts', 'audit-1.md'), 'utf8');
  assert.match(markdown, /证据包/);
  assert.match(markdown, /artifacts\/home\.png/);

  // A missing file aborts before anything is recorded.
  const missing = await auditTool.execute(
    { checks: [{ criterionId: 'F-01', result: 'pass', evidence: 'x', evidenceFiles: ['artifacts/nope.png'] }] },
    exec(cwd)
  );
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /证据文件不存在/);
  await assert.rejects(readFile(join(cwd, '.shared', 'artifacts', 'audit-2.md'), 'utf8'));

  // Paths escaping `.shared/` are rejected outright.
  const escape = await auditTool.execute(
    { checks: [{ criterionId: 'F-01', result: 'pass', evidence: 'x', evidenceFiles: ['../outside.png'] }] },
    exec(cwd)
  );
  assert.equal(escape.ok, false);
  assert.match(escape.summary, /证据路径非法/);

  // Oversized evidence is rejected before anything is copied.
  const paths = resolvePaths(cwd, '.shared');
  const checks = [
    { criterionId: 'F-01', result: 'pass', evidence: 'x', evidenceFiles: ['artifacts/home.png'] }
  ];
  await assert.rejects(
    writeEvidenceBundle(paths, 99, 1, checks, new Date().toISOString(), { perFileBytes: 4 }),
    /证据文件过大/
  );
  await assert.rejects(
    writeEvidenceBundle(paths, 99, 1, checks, new Date().toISOString(), { totalBytes: 4 }),
    /超过总大小上限/
  );
});

test('dispatch writes a v2 envelope and status tracks the unacked dispatch', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  const dispatched = await dispatchTool.execute({}, exec(cwd));
  assert.equal(dispatched.ok, true, dispatched.detail);

  const sent = await readFile(join(cwd, '.shared', 'outbox-dsh.md'), 'utf8');
  assert.match(sent, /## \[[^\]]+\] dispatch · #d-1 · from=dsh to=deveco \|/);

  const before = await statusTool.execute({}, exec(cwd));
  assert.match(before.detail, /未回执派发：1 条（#d-1）/);
  assert.match(before.detail, /还没有回执/);

  await appendFile(
    join(cwd, '.shared', 'outbox-deveco.md'),
    '## [2026-10-31T10:00:00+08:00] deliver · #a-1 · from=deveco to=dsh · re=#d-1 | 第 1 轮交付\n\n- 状态: 完成\n\n'
  );
  const after = await statusTool.execute({}, exec(cwd));
  assert.match(after.detail, /未回执派发：0 条/);
  assert.match(after.detail, /#a-1/);
});
