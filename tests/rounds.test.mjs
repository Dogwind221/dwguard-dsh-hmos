// Round isolation: a new task-pack version must not inherit the previous
// round's pre-review or audit.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-rounds-home-'));

import { readBoard } from '../lib/board.js';
import { resolveOptions } from '../lib/config.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createConfirmTool } from '../lib/tools/confirm.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';
import { createStatusTool } from '../lib/tools/status.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const options = resolveOptions({ strictEvidence: false });
const specTool = createSpecTool(options);
const prereviewTool = createPrereviewTool(options);
const dispatchTool = createDispatchTool(options);
const auditTool = createAuditTool(options);
const confirmTool = createConfirmTool(options);
const statusTool = createStatusTool(options);

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

async function writeSpec(cwd, title) {
  return specTool.execute(
    {
      action: 'write',
      title,
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria
    },
    exec(cwd)
  );
}

async function auditPass(cwd) {
  return auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '截图 home.png：连续天数 3→4' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 12vp/16vp' },
        { criterionId: 'P-01', result: 'pass', evidence: '冷启动 720ms（Profiler 截图）' },
        { criterionId: 'X-01', result: 'pass', evidence: '按钮 bounds 48vp' }
      ]
    },
    exec(cwd)
  );
}

test('a new pack version starts with no pre-review and no audit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dwguard-rounds-'));
  dirs.push(cwd);

  // Round 1: full pass.
  assert.equal((await writeSpec(cwd, '训练打卡')).ok, true);
  assert.equal((await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd))).ok, true);
  assert.equal((await dispatchTool.execute({}, exec(cwd))).ok, true);
  assert.equal((await auditPass(cwd)).ok, true);
  const afterV1 = await statusTool.execute({}, exec(cwd));
  assert.match(afterV1.summary, /验收通过/);

  // User confirms and starts round 2.
  assert.equal((await confirmTool.execute({ decision: 'new_round' }, exec(cwd))).ok, true);
  assert.equal((await writeSpec(cwd, '训练打卡 v2')).ok, true);

  // v1's pre-review/audit must not count for v2.
  const afterV2 = await statusTool.execute({}, exec(cwd));
  assert.match(afterV2.summary, /待派发前预审/);
  assert.match(afterV2.detail, /上一轮 #1 不适用/);
  assert.match(afterV2.detail, /本轮）· 共 1 次/);
  // Round 1's un-acked dispatch must not nag in round 2.
  assert.match(afterV2.detail, /未回执派发：0 条/);

  // Board must agree.
  const board = await readBoard(cwd, options, new Date().toISOString());
  assert.equal(board?.phase, 'prereview');
  assert.equal(board?.prereview, null);
  assert.equal(board?.audit, null);

  // Dispatch is refused until v2 gets its own pre-review.
  const blocked = await dispatchTool.execute({}, exec(cwd));
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /还没有预审记录/);

  // v2 pre-review → ready; dispatch → dispatched; audit → accepted (not confirmed).
  assert.equal((await prereviewTool.execute({ note: '通读 v2 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd))).ok, true);
  assert.match((await statusTool.execute({}, exec(cwd))).summary, /预审通过，待派发/);
  assert.equal((await dispatchTool.execute({}, exec(cwd))).ok, true);
  const dispatchedV2 = await statusTool.execute({}, exec(cwd));
  assert.match(dispatchedV2.summary, /已派发，待交付/);
  // Only the current round's dispatch (#d-2) counts as unacked.
  assert.match(dispatchedV2.detail, /未回执派发：1 条（#d-2）/);
  assert.equal((await auditPass(cwd)).ok, true);
  const acceptedV2 = await statusTool.execute({}, exec(cwd));
  assert.match(acceptedV2.summary, /验收通过，待用户确认/);
  assert.equal((await confirmTool.execute({ decision: 'accept' }, exec(cwd))).ok, true);
  assert.match((await statusTool.execute({}, exec(cwd))).summary, /用户已确认/);
});
