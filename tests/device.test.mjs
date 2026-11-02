// P3: host-memory aware device policy, device lock, and the screen-family matrix.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-home-'));

import { resolveOptions } from '../lib/config.js';
import { acquireDeviceLock, releaseDeviceLock, resolveDevicePolicy } from '../lib/device.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';
import { createStatusTool } from '../lib/tools/status.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const pool = [
  { sn: 'em-phone', family: 'phone', apiLevel: 24, kind: 'emulator' },
  { sn: 'em-wide', family: 'widefold', apiLevel: 24, kind: 'emulator' },
  { sn: 'em-fold', family: 'foldable', apiLevel: 24, kind: 'emulator' },
  { sn: 'em-triple', family: 'triplefold', apiLevel: 24, kind: 'emulator' }
];

function tools(options) {
  return {
    spec: createSpecTool(options),
    prereview: createPrereviewTool(options),
    dispatch: createDispatchTool(options),
    audit: createAuditTool(options),
    status: createStatusTool(options)
  };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-device-'));
  dirs.push(dir);
  return dir;
}

function exec(cwd) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
}

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图' },
  { id: 'A-01', dimension: 'aesthetic', statement: '卡片间距 12vp、圆角 16vp', verify: '布局树 bounds 实测' },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析毫秒数' },
  { id: 'X-01', dimension: 'accessibility', statement: '按钮文字对比度 ≥ 4.5:1', verify: '截图取样计算对比度' }
];

async function ready(cwd, set) {
  await set.spec.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。',
      constraints: ['compatibleSdkVersion 5.0.0(12)'],
      criteria
    },
    exec(cwd)
  );
  await set.prereview.execute(
    { note: '通读 spec 与首页源码，覆盖性能/生命周期/并发/API 兼容与四维可行性', findings: [] },
    exec(cwd)
  );
  await set.dispatch.execute({}, exec(cwd));
}

function check(id, family, sn = `em-${family}`, result = 'pass') {
  return {
    criterionId: id,
    result,
    evidence: `在 ${family} 设备 ${sn} 上取证：操作步骤 + 截图`,
    device: sn,
    family
  };
}

test('P3-A/C/D/E: host memory decides single vs matrix, overrides win, scope and concurrency are computed', () => {
  const single = resolveDevicePolicy({ hostMemoryGb: 16, devicePool: pool });
  assert.equal(single.mode, 'single');
  assert.equal(single.maxConcurrency, 1);
  assert.ok(single.warnings.some((warning) => /单机验证/.test(warning)));

  const matrix = resolveDevicePolicy({ hostMemoryGb: 32, devicePool: pool });
  assert.equal(matrix.mode, 'matrix');
  assert.equal(matrix.maxConcurrency, 2);
  assert.deepEqual(matrix.scope.function, ['phone']);
  assert.deepEqual(matrix.scope.performance, ['phone']);
  assert.equal(matrix.scope.aesthetic.length, 4);
  assert.equal(matrix.scope.accessibility.length, 4);

  const big = resolveDevicePolicy({ hostMemoryGb: 64, devicePool: pool });
  assert.equal(big.maxConcurrency, 4);

  const forceSingle = resolveDevicePolicy({ hostMemoryGb: 64, deviceMode: 'single', devicePool: pool });
  assert.equal(forceSingle.mode, 'single');
  const forceMatrix = resolveDevicePolicy({ hostMemoryGb: 16, deviceMode: 'matrix', devicePool: pool });
  assert.equal(forceMatrix.mode, 'matrix');
  assert.ok(forceMatrix.warnings.some((warning) => /手写覆盖/.test(warning)));
});

test('P3-F/H: the device lock serialises access and steals stale locks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-lock-'));
  dirs.push(dir);
  const paths = { shared: dir };

  const first = await acquireDeviceLock(paths, 'em-phone', 'audit-a', 5000, { staleAfterMs: 60_000 });
  assert.equal(first.ok, true);
  // A second job must wait (P3-H: no concurrent use of one device).
  const started = Date.now();
  const secondPromise = acquireDeviceLock(paths, 'em-phone', 'audit-b', 5000, { staleAfterMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await acquireDeviceLock(paths, 'em-phone', 'audit-c', 100, { staleAfterMs: 60_000 })).ok, false);
  await releaseDeviceLock(paths, 'em-phone');
  const second = await secondPromise;
  assert.equal(second.ok, true);
  assert.ok(Date.now() - started >= 100, 'second acquire should have waited');
  await releaseDeviceLock(paths, 'em-phone');

  // An old lock is considered stale and can be stolen (P3-F timeout handling).
  await writeFile(
    join(dir, '.device-lock.json'),
    `${JSON.stringify({ sn: 'em-wide', holder: 'stuck', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
  );
  const stale = await acquireDeviceLock(paths, 'em-phone', 'audit-d', 1000, { staleAfterMs: 1000 });
  assert.equal(stale.ok, true);
  assert.equal(stale.staleStolen, true);
  await releaseDeviceLock(paths, 'em-phone');
});

test('P3-B/P3-G: matrix audit refuses missing screen families, then passes with full coverage', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ hostMemoryGb: 32, devicePool: pool });
  const set = tools(options);
  await ready(cwd, set);

  const oneFamily = [check('F-01', 'phone'), check('A-01', 'phone'), check('P-01', 'phone'), check('X-01', 'phone')];
  const first = await set.audit.execute({ note: '只在直板机取证', checks: oneFamily }, exec(cwd));
  assert.equal(first.ok, false);
  const rework = await readFile(join(cwd, '.shared', 'tasks', 'rework-1.md'), 'utf8');
  assert.match(rework, /缺少屏幕族/);
  assert.match(rework, /宽折叠|widefold/);

  const report = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'audit-1.json'), 'utf8'));
  assert.equal(report.devices.length, 1);

  const full = [
    check('F-01', 'phone'),
    check('A-01', 'phone'),
    check('A-01', 'widefold', 'em-wide'),
    check('A-01', 'foldable', 'em-fold'),
    check('A-01', 'triplefold', 'em-triple'),
    check('P-01', 'phone'),
    check('X-01', 'phone'),
    check('X-01', 'widefold', 'em-wide'),
    check('X-01', 'foldable', 'em-fold'),
    check('X-01', 'triplefold', 'em-triple')
  ];
  const second = await set.audit.execute({ note: '四族矩阵取证', checks: full }, exec(cwd));
  assert.equal(second.ok, true, second.detail);

  const audit = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'audit-2.json'), 'utf8'));
  assert.equal(audit.devices.length, 4);
  assert.match(await readFile(join(cwd, '.shared', 'artifacts', 'acceptance-report.md'), 'utf8'), /屏幕族矩阵/);

  const status = await set.status.execute({}, exec(cwd));
  assert.match(status.detail, /设备：矩阵/);
});

test('P3-A: 16GB host forces single-device audit and needs no family fields', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ hostMemoryGb: 16, devicePool: pool });
  const set = tools(options);
  await ready(cwd, set);
  const result = await set.audit.execute(
    {
      note: '16GB 单机验证',
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: '点打卡后 3→4，截图' },
        { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 实测 12vp' },
        { criterionId: 'P-01', result: 'pass', evidence: '720ms' },
        { criterionId: 'X-01', result: 'pass', evidence: '4.9:1' }
      ]
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);
  const acceptance = await readFile(join(cwd, '.shared', 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(acceptance, /单机验证/);
});

test('P3-B waivers: allowMissingMatrixFamilies downgrades missing families to warnings', async () => {
  const cwd = await workspace();
  const options = resolveOptions({
    hostMemoryGb: 32,
    devicePool: pool.filter((entry) => entry.family === 'phone'),
    allowMissingMatrixFamilies: true
  });
  const set = tools(options);
  await ready(cwd, set);
  const result = await set.audit.execute(
    {
      note: '只有直板机，显式豁免',
      checks: [check('F-01', 'phone'), check('A-01', 'phone'), check('P-01', 'phone'), check('X-01', 'phone')]
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);
  const auditMd = await readFile(join(cwd, '.shared', 'artifacts', 'audit-1.md'), 'utf8');
  assert.match(auditMd, /降级为警告/);
});

test('matrix mode requires device/family on every check', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ hostMemoryGb: 32, devicePool: pool });
  const set = tools(options);
  await ready(cwd, set);
  const result = await set.audit.execute(
    {
      note: '缺设备字段',
      checks: ['F-01', 'A-01', 'P-01', 'X-01'].map((id) => ({
        criterionId: id,
        result: 'pass',
        evidence: '截图 + 日志，证据足够'
      }))
    },
    exec(cwd)
  );
  assert.equal(result.ok, false);
  const rework = await readFile(join(cwd, '.shared', 'tasks', 'rework-1.md'), 'utf8');
  assert.match(rework, /缺少 `device` \/ `family`/);
});
