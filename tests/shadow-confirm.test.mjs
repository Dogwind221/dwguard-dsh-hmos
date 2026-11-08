// Shadow review (increment ②) and user confirmation as recorded state.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-shadow-home-'));

import { resolveOptions } from '../lib/config.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createConfirmTool } from '../lib/tools/confirm.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createShadowTool } from '../lib/tools/shadow.js';
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
const shadowTool = createShadowTool(options);
const auditTool = createAuditTool(options);
const confirmTool = createConfirmTool(options);
const statusTool = createStatusTool(options);

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-shadow-'));
  dirs.push(dir);
  return dir;
}

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图', ruleId: 'DW-FN-01' },
  { id: 'A-01', dimension: 'aesthetic', statement: '打卡卡片间距 12vp、圆角 16vp', verify: '布局树 bounds 实测', ruleId: 'DW-AES-01' },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析', ruleId: 'DW-PERF-01' },
  { id: 'X-01', dimension: 'accessibility', statement: '打卡按钮触控热区 ≥ 48vp', verify: '布局树 bounds 实测', ruleId: 'DW-A11Y-02' }
];

async function writeSpec(cwd) {
  return specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria
    },
    exec(cwd)
  );
}

async function dispatched(cwd) {
  await writeSpec(cwd);
  await prereviewTool.execute({ note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] }, exec(cwd));
  await dispatchTool.execute({}, exec(cwd));
}

test('shadow review scans code, records a UI tree, and writes back a risk', async () => {
  const cwd = await workspace();
  await dispatched(cwd);
  await writeFile(
    join(cwd, 'entry.ets'),
    [
      '@State user: User = new User()',
      'label: any = "x"',
      'rename() { this.user.profile.name = "x" }'
    ].join('\n')
  );

  const first = await shadowTool.execute({}, exec(cwd));
  assert.equal(first.ok, true, first.detail);
  assert.match(first.summary, /must [1-9]/);
  assert.match(first.summary, /新增 2/);
  const shadow1 = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'shadow-1.json'), 'utf8'));
  assert.ok(shadow1.hits.some((hit) => hit.ruleId === 'STATE-NESTED-01'));
  assert.ok(shadow1.hits.some((hit) => hit.ruleId === 'ARKTS-ANY-001'));

  let sent = await readFile(join(cwd, '.shared', 'outbox-dsh.md'), 'utf8');
  assert.match(sent, /shadow-risk · #s-1 · from=dsh to=deveco/);
  assert.equal(sent.match(/shadow-risk/g)?.length, 1);

  await writeFile(
    join(cwd, '.shared', 'artifacts', 'ui-tree.json'),
    JSON.stringify({ component: 'Column', children: [{ component: 'Button' }, { component: 'Text' }] })
  );
  const second = await shadowTool.execute({ uiTree: 'artifacts/ui-tree.json' }, exec(cwd));
  assert.equal(second.ok, true, second.detail);
  assert.match(second.detail, /UI 树/);
  assert.match(second.detail, /个节点/);
  // Same findings: nothing new, so no second outbox record.
  assert.match(second.summary, /新增 0/);
  const shadow2 = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'shadow-2.json'), 'utf8'));
  assert.equal(shadow2.uiTree.nodes, 3);
  assert.equal(shadow2.uiTree.depth, 1);
  sent = await readFile(join(cwd, '.shared', 'outbox-dsh.md'), 'utf8');
  assert.equal(sent.match(/shadow-risk/g)?.length, 1);

  // A new file brings one new must-level risk → exactly one more record.
  await writeFile(join(cwd, 'second.ets'), 'const x: any = 1\n');
  const third = await shadowTool.execute({}, exec(cwd));
  assert.equal(third.ok, true, third.detail);
  assert.match(third.summary, /新增 1/);
  sent = await readFile(join(cwd, '.shared', 'outbox-dsh.md'), 'utf8');
  assert.equal(sent.match(/shadow-risk/g)?.length, 2);
  assert.match(sent, /shadow-risk · #s-3 · from=dsh to=deveco/);

  const status = await statusTool.execute({}, exec(cwd));
  assert.match(status.detail, /影子审查：3 次/);
  assert.match(status.detail, /影子审查已 \d+ 分钟未跑|影子审查/);
});

test('confirmation requires a passing audit, then records the decision', async () => {
  const cwd = await workspace();
  await dispatched(cwd);

  const tooEarly = await confirmTool.execute({ decision: 'accept' }, exec(cwd));
  assert.equal(tooEarly.ok, false);

  const audit = await auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '截图 + 点击后 4 天' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 12vp/16vp' },
        { criterionId: 'P-01', result: 'pass', evidence: '冷启动 720ms' },
        { criterionId: 'X-01', result: 'pass', evidence: 'bounds 48vp' }
      ]
    },
    exec(cwd)
  );
  assert.equal(audit.ok, true, audit.detail);

  const accepted = await confirmTool.execute({ decision: 'accept', note: '用户：可以了' }, exec(cwd));
  assert.equal(accepted.ok, true, accepted.detail);
  const record = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'confirmation-1.json'), 'utf8'));
  assert.equal(record.decision, 'accept');

  const status = await statusTool.execute({}, exec(cwd));
  assert.match(status.summary, /用户已确认/);
  assert.match(status.detail, /用户确认：1 次/);

  const nextRound = await confirmTool.execute({ decision: 'new_round' }, exec(cwd));
  assert.equal(nextRound.ok, true, nextRound.detail);
  assert.match(nextRound.summary, /迭代号 → 2/);

  const after = await statusTool.execute({}, exec(cwd));
  assert.match(after.summary, /待写任务包/);
});

test('shadow review auto-captures the UI tree when the host exposes harmony_ui_tree', async () => {
  const cwd = await workspace();
  await dispatched(cwd);

  const fakeContext = {
    tools: { register() {} },
    effect: (body) => body(),
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        execute: async (toolName) =>
          toolName === 'harmony_ui_tree'
            ? { detail: '{"component":"Root","children":[{"component":"Child"}]}' }
            : null
      };
    }
  };
  const autoShadow = createShadowTool(options, fakeContext);
  const result = await autoShadow.execute({}, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /自动抓取/);
  const report = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'shadow-1.json'), 'utf8'));
  assert.equal(report.uiTree.nodes, 2);
  assert.equal(report.uiTree.depth, 1);

  // autoUiTree=false must not call the host tool.
  const manual = createShadowTool(options, { ...fakeContext, get: () => undefined });
  const skipped = await manual.execute({ autoUiTree: false }, exec(cwd));
  assert.equal(skipped.ok, true, skipped.detail);
  assert.doesNotMatch(skipped.detail, /自动抓取/);
});
