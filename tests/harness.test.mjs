// 0.8.0: cross-session harness journal, resume, retry budget and fallback.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-harness-home-'));

const run = promisify(execFile);

import { resolveOptions } from '../lib/config.js';
import { createHarnessTool } from '../lib/tools/harness.js';
import { createSpecTool } from '../lib/tools/spec.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function exec(cwd) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-harness-'));
  dirs.push(dir);
  return dir;
}

async function seed(cwd, options) {
  const specTool = createSpecTool(options);
  const result = await specTool.execute(
    {
      action: 'write',
      title: 'Harness 测试',
      requirement: '验证跨会话 checkpoint、resume、retry 与 fallback。',
      spec: '写一个最小任务包，执行 checkpoint 后换实例 resume。',
      criteria: [
        { id: 'F-01', dimension: 'function', statement: 'checkpoint 后新实例能 resume', verify: '两个 tool 实例读取同一 cp-1' },
        { id: 'A-01', dimension: 'aesthetic', statement: '界面留白 24vp', verify: '布局树 bounds 24vp' },
        { id: 'P-01', dimension: 'performance', statement: '首帧 ≤ 800ms', verify: 'Profiler 首帧数值' },
        { id: 'X-01', dimension: 'accessibility', statement: '触控 ≥ 48vp', verify: '布局树触控 bounds 48vp' }
      ]
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);
}

test('0.8.0 HR: checkpoint survives a new tool instance and resume reports the same point', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ harnessMaxRetries: 2 });
  await seed(cwd, options);
  const first = createHarnessTool(options);
  const checkpoint = await first.execute(
    { action: 'checkpoint', step: 'pipeline', note: 'build 已完成', evidence: ['artifacts/deveco-1/pipeline.json'] },
    exec(cwd)
  );
  assert.equal(checkpoint.ok, true, checkpoint.detail);
  const file = join(cwd, '.shared', 'harness', 'run.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.checkpoints.length, 1);
  assert.equal(saved.checkpoints[0].step, 'pipeline');
  assert.deepEqual(saved.checkpoints[0].evidence, ['artifacts/deveco-1/pipeline.json']);

  const second = createHarnessTool(options);
  const resumed = await second.execute({ action: 'resume' }, exec(cwd));
  assert.equal(resumed.ok, true, resumed.detail);
  assert.match(resumed.detail, /cp-1/);
  assert.match(resumed.detail, /pipeline/);
  assert.match(resumed.detail, /stale：false/);
  assert.match(resumed.next, /checkpoint|继续|当前建议/);
});

test('0.8.0 HR: retry turns into human at the configured budget and fallback records the level', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ harnessMaxRetries: 2 });
  await seed(cwd, options);
  const tool = createHarnessTool(options);
  const first = await tool.execute({ action: 'retry', step: 'pipeline', error: 'device offline' }, exec(cwd));
  assert.equal(first.ok, true);
  assert.match(first.summary, /1\/2/);
  const second = await tool.execute({ action: 'retry', step: 'pipeline', error: 'device offline' }, exec(cwd));
  assert.match(second.summary, /2\/2/);
  const third = await tool.execute({ action: 'retry', step: 'pipeline', error: 'device offline' }, exec(cwd));
  assert.match(third.summary, /超过重试上限|转人工/);
  assert.match(third.next, /人工|上限/);

  const fallback = await tool.execute({ action: 'fallback', step: 'pipeline', level: 2 }, exec(cwd));
  assert.equal(fallback.ok, true, fallback.detail);
  const run = JSON.parse(await readFile(join(cwd, '.shared', 'harness', 'run.json'), 'utf8'));
  assert.equal(run.status, 'running');
  assert.equal(run.fallback.level, 1);
  assert.deepEqual(run.fallback.chain, ['devecocli', 'deveco-mcp', 'hdc+hvigor']);
  assert.match(fallback.next, /deveco-mcp/);

  const failed = await tool.execute({ action: 'fail', step: 'audit', error: 'missing evidence' }, exec(cwd));
  assert.equal(failed.ok, true, failed.detail);
  const blocked = JSON.parse(await readFile(join(cwd, '.shared', 'harness', 'run.json'), 'utf8'));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.lastError.step, 'audit');
});

test('0.8.0 HR: persistent queue claim/lease/expiry/complete works across instances', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await seed(cwd, options);
  const first = createHarnessTool(options);
  await first.execute({ action: 'enqueue', step: 'pipeline', note: 'resume build' }, exec(cwd));
  await first.execute({ action: 'enqueue', step: 'audit', note: 'run four-dim audit' }, exec(cwd));
  const listed = await first.execute({ action: 'queue' }, exec(cwd));
  assert.equal(listed.ok, true, listed.detail);
  assert.match(listed.summary, /queued 2/);
  assert.match(listed.detail, /task-0001/);

  const second = createHarnessTool(options);
  const claimed = await second.execute({ action: 'claim', owner: 'worker-a', leaseSeconds: 30 }, exec(cwd));
  assert.equal(claimed.ok, true, claimed.detail);
  assert.match(claimed.summary, /task-0001/);
  const queueFile = join(cwd, '.shared', 'harness', 'queue.json');
  let queue = JSON.parse(await readFile(queueFile, 'utf8'));
  assert.equal(queue.tasks[0].status, 'leased');
  assert.equal(queue.tasks[0].attempts, 1);
  assert.equal(queue.tasks[0].lease.owner, 'worker-a');

  // Force the lease to expire, then a different worker can reclaim it.
  queue.tasks[0].lease.until = '2020-01-01T00:00:00.000Z';
  await writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  const third = createHarnessTool(options);
  const reclaimed = await third.execute({ action: 'claim', owner: 'worker-b', leaseSeconds: 30 }, exec(cwd));
  assert.match(reclaimed.summary, /task-0001/);
  queue = JSON.parse(await readFile(queueFile, 'utf8'));
  assert.equal(queue.tasks[0].attempts, 2);
  assert.equal(queue.tasks[0].lease.owner, 'worker-b');

  const done = await third.execute({ action: 'complete', taskId: 'task-0001', evidence: ['artifacts/a.png'] }, exec(cwd));
  assert.equal(done.ok, true, done.detail);
  queue = JSON.parse(await readFile(queueFile, 'utf8'));
  assert.equal(queue.tasks[0].status, 'done');
  assert.deepEqual(queue.tasks[0].evidence, ['artifacts/a.png']);

  const next = await third.execute({ action: 'claim', owner: 'worker-b', leaseSeconds: 30 }, exec(cwd));
  assert.match(next.summary, /task-0002/);
  const failed = await third.execute({ action: 'task-fail', taskId: 'task-0002', error: 'evidence missing' }, exec(cwd));
  assert.match(failed.summary, /failed/);
  queue = JSON.parse(await readFile(queueFile, 'utf8'));
  assert.equal(queue.tasks[1].status, 'failed');
  assert.equal(queue.tasks[1].lastError, 'evidence missing');
});

test('0.8.0 HR: standalone worker claims a queued task and marks it done', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await seed(cwd, options);
  const tool = createHarnessTool(options);
  await tool.execute({ action: 'enqueue', step: 'pipeline', note: 'worker smoke' }, exec(cwd));
  const worker = join(process.cwd(), 'scripts', 'harness-worker.mjs');
  const result = await run(process.execPath, [
    worker,
    '--workspace',
    cwd,
    '--command',
    'node --version',
    '--once'
  ]);
  assert.match(result.stdout, /claimed task-0001/);
  const queue = JSON.parse(await readFile(join(cwd, '.shared', 'harness', 'queue.json'), 'utf8'));
  assert.equal(queue.tasks[0].status, 'done');
  assert.equal(queue.tasks[0].attempts, 1);
});

test('0.8.0 HR: stale run after spec version change refuses to resume blindly', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await seed(cwd, options);
  const tool = createHarnessTool(options);
  await tool.execute({ action: 'checkpoint', step: 'pipeline' }, exec(cwd));
  // Simulate a newer task pack in another session: the persisted run points at
  // spec v1, while the current spec is v999.
  const runPath = join(cwd, '.shared', 'harness', 'run.json');
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  run.specVersion = 999;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  const resumed = await tool.execute({ action: 'resume' }, exec(cwd));
  assert.equal(resumed.ok, true, resumed.detail);
  assert.match(resumed.summary, /stale/);
  assert.match(resumed.next, /重新 spec|不要沿用/);
});
