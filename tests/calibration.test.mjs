// Calibration ledger + board history.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-cal-home-'));

import { readBoard } from '../lib/board.js';
import { resolveOptions } from '../lib/config.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createCalibrationTool } from '../lib/tools/calibration.js';
import { createConfirmTool } from '../lib/tools/confirm.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const options = resolveOptions({});
const specTool = createSpecTool(options);
const prereviewTool = createPrereviewTool(options);
const dispatchTool = createDispatchTool(options);
const auditTool = createAuditTool(options);
const confirmTool = createConfirmTool(options);
const calibrationTool = createCalibrationTool(options);

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图 F-01.png', ruleId: 'DW-FN-01' },
  { id: 'A-01', dimension: 'aesthetic', statement: '打卡卡片间距 12vp、圆角 16vp', verify: '布局树 bounds 12vp/16vp', ruleId: 'DW-AES-01' },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析截图', ruleId: 'DW-PERF-01' },
  { id: 'X-01', dimension: 'accessibility', statement: '打卡按钮触控热区 ≥ 48vp', verify: '布局树 bounds 48vp', ruleId: 'DW-A11Y-02' }
];

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-cal-'));
  dirs.push(dir);
  return dir;
}

async function dispatched(cwd) {
  await specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria
    },
    exec(cwd)
  );
  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  await dispatchTool.execute({}, exec(cwd));
}

const passChecks = [
  { criterionId: 'F-01', result: 'pass', evidence: '截图 home.png：连续天数 3→4' },
  { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 12vp/16vp' },
  { criterionId: 'P-01', result: 'pass', evidence: '冷启动 720ms（Profiler 截图）' },
  { criterionId: 'X-01', result: 'pass', evidence: '按钮 bounds 48vp' }
];

test('audit and confirmation append to the ledger; a miss is counted', async () => {
  const cwd = await workspace();
  await dispatched(cwd);
  assert.equal((await auditTool.execute({ checks: passChecks }, exec(cwd))).ok, true);
  assert.equal((await confirmTool.execute({ decision: 'accept' }, exec(cwd))).ok, true);

  const ledger = await readFile(join(cwd, '.shared', 'knowledge', 'calibration.jsonl'), 'utf8');
  const lines = ledger.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.kind === 'audit').length, 1);
  assert.equal(lines.filter((line) => line.kind === 'confirm').length, 1);

  const before = await calibrationTool.execute({ action: 'report' }, exec(cwd));
  assert.equal(before.ok, true, before.detail);
  assert.match(before.summary, /审计 1 次/);
  assert.match(before.detail, /漏检 0 次/);

  const miss = await calibrationTool.execute(
    { action: 'miss', dimension: 'performance', note: '用户反馈冷启动实际 3s' },
    exec(cwd)
  );
  assert.equal(miss.ok, true, miss.detail);

  const afterReport = await calibrationTool.execute({ action: 'report' }, exec(cwd));
  assert.match(afterReport.summary, /漏检 1 次/);
  assert.match(afterReport.detail, /性能：审计 1 次 · 未过 0 次 · 漏检 1 次（漏检率 100%）/);
});

test('a failed audit also lands in the ledger; miss needs a passing audit', async () => {
  const cwd = await workspace();
  await dispatched(cwd);

  const early = await calibrationTool.execute({ action: 'miss', dimension: 'function' }, exec(cwd));
  assert.equal(early.ok, false);

  const failed = await auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '截图 home.png：连续天数 3→4' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 12vp/16vp' },
        { criterionId: 'P-01', result: 'fail', evidence: '冷启动 2.8s（Profiler 截图）' },
        { criterionId: 'X-01', result: 'pass', evidence: '按钮 bounds 48vp' }
      ]
    },
    exec(cwd)
  );
  assert.equal(failed.ok, false);

  const ledger = await readFile(join(cwd, '.shared', 'knowledge', 'calibration.jsonl'), 'utf8');
  const auditLine = ledger
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.kind === 'audit');
  assert.equal(auditLine.pass, false);
  assert.equal(auditLine.dimensions.performance.failed, 1);

  const report = await calibrationTool.execute({ action: 'report' }, exec(cwd));
  assert.match(report.detail, /性能：审计 1 次 · 未过 1 次/);
});

test('board history lists dispatch / audit / confirmation events', async () => {
  const cwd = await workspace();
  await dispatched(cwd);
  assert.equal((await auditTool.execute({ checks: passChecks }, exec(cwd))).ok, true);
  assert.equal((await confirmTool.execute({ decision: 'accept' }, exec(cwd))).ok, true);

  const board = await readBoard(cwd, options, new Date().toISOString());
  assert.ok(board);
  const kinds = new Set(board.history.map((event) => event.kind));
  for (const kind of ['dispatch', 'prereview', 'audit', 'confirm']) {
    assert.ok(kinds.has(kind), `history missing ${kind}: ${[...kinds].join(', ')}`);
  }
  const auditEvent = board.history.find((event) => event.kind === 'audit');
  assert.equal(auditEvent?.ok, true);
  // Newest first.
  const times = board.history.map((event) => Date.parse(event.at));
  assert.deepEqual(times, [...times].sort((left, right) => right - left));
});
