// P0: machine-checkable criteria — `assertion` in the spec, `actual` in the audit.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Keep the workspace registry the tools write out of the real DSH home.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-home-'));

import { resolveOptions } from '../lib/config.js';
import { evaluateAssertion } from '../lib/review.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';

const options = resolveOptions({});
const specTool = createSpecTool(options);
const prereviewTool = createPrereviewTool(options);
const dispatchTool = createDispatchTool(options);
const auditTool = createAuditTool(options);

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-assert-'));
  dirs.push(dir);
  return dir;
}

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

const criteria = [
  {
    id: 'F-01',
    dimension: 'function',
    statement: '点击打卡后连续天数从 3 变成 4',
    verify: '操作步骤 + 截图',
    assertion: { matcher: 'equals', expected: '4' }
  },
  {
    id: 'A-01',
    dimension: 'aesthetic',
    statement: '打卡卡片间距 12vp、圆角 16vp',
    verify: '布局树 bounds 实测',
    assertion: { matcher: 'range', min: 8, max: 16, unit: 'vp' }
  },
  {
    id: 'P-01',
    dimension: 'performance',
    statement: '冷启动到首帧 ≤ 800ms',
    verify: 'Profiler 启动分析毫秒数',
    assertion: { matcher: 'lte', expected: 800, unit: 'ms' }
  },
  {
    id: 'X-01',
    dimension: 'accessibility',
    statement: '打卡按钮文字对比度 ≥ 4.5:1',
    verify: '截图取样计算对比度数值',
    assertion: { matcher: 'gte', expected: 4.5, unit: 'ratio' }
  }
];

async function writeSpec(cwd, overrides = {}) {
  return specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。',
      constraints: ['compatibleSdkVersion 5.0.0(12)', '不改 AppScope'],
      criteria,
      ...overrides
    },
    exec(cwd)
  );
}

async function ready(cwd) {
  await writeSpec(cwd);
  await prereviewTool.execute(
    { note: '通读 spec 与首页源码，覆盖性能/生命周期/并发/API 兼容与四维可行性', findings: [] },
    exec(cwd)
  );
  await dispatchTool.execute({}, exec(cwd));
}

const goodChecks = [
  { criterionId: 'F-01', result: 'pass', evidence: '点打卡后 3→4，截图 artifacts/F-01.png', actual: '4' },
  { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 实测 12vp', actual: '12vp' },
  { criterionId: 'P-01', result: 'pass', evidence: 'Profiler 3 次启动 700/720/760ms', actual: '720ms' },
  { criterionId: 'X-01', result: 'pass', evidence: '截图取样计算对比度 4.9:1', actual: '4.9:1' }
];

test('spec freezes machine-checkable assertions and keeps them through validate', async () => {
  const cwd = await workspace();
  const result = await writeSpec(cwd);
  assert.equal(result.ok, true, result.detail);

  const spec = JSON.parse(await readFile(join(cwd, '.shared', 'tasks', 'spec.json'), 'utf8'));
  const p01 = spec.criteria.find((criterion) => criterion.id === 'P-01');
  assert.equal(p01.assertion.matcher, 'lte');
  assert.equal(p01.assertion.expected, 800);
  assert.equal(p01.assertion.unit, 'ms');

  const markdown = await readFile(join(cwd, '.shared', 'tasks', 'spec.md'), 'utf8');
  assert.match(markdown, /断言/);
  assert.ok(markdown.includes('range 8–16 vp'), markdown.slice(0, 400));
  assert.match(markdown, /必须给出 `actual` 实测值/);

  const revalidated = await specTool.execute({ action: 'validate' }, exec(cwd));
  assert.equal(revalidated.ok, true, revalidated.detail);
});

test('spec refuses an invalid assertion before freezing the pack', async () => {
  const cwd = await workspace();
  const invalidRange = JSON.parse(JSON.stringify(criteria));
  invalidRange[1].assertion = { matcher: 'range' };
  const rejected = await writeSpec(cwd, { criteria: invalidRange });
  assert.equal(rejected.ok, false);
  assert.match(rejected.summary, /未写入/);
  assert.match(rejected.summary, /assertion/);
  await assert.rejects(readFile(join(cwd, '.shared', 'tasks', 'spec.json'), 'utf8'));

  const invalidRegex = JSON.parse(JSON.stringify(criteria));
  invalidRegex[0].assertion = { matcher: 'regex', expected: '(' };
  const regexRejected = await writeSpec(cwd, { criteria: invalidRegex });
  assert.equal(regexRejected.ok, false);
  assert.match(regexRejected.summary, /正则/);
});

test('audit recomputes assertions, stores verdicts and passes consistent checks', async () => {
  const cwd = await workspace();
  await ready(cwd);

  const result = await auditTool.execute({ note: '模拟器 API 24，浅色模式', checks: goodChecks }, exec(cwd));
  assert.equal(result.ok, true, result.detail);

  const report = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'audit-1.json'), 'utf8'));
  const p01 = report.checks.find((check) => check.criterionId === 'P-01');
  assert.equal(p01.assertionVerdict, 'pass');
  assert.equal(p01.actual, '720ms');

  const auditMarkdown = await readFile(join(cwd, '.shared', 'artifacts', 'audit-1.md'), 'utf8');
  assert.match(auditMarkdown, /断言判定/);
  assert.match(auditMarkdown, /实测值/);

  const acceptance = await readFile(join(cwd, '.shared', 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(acceptance, /实测值/);
  assert.match(acceptance, /720ms/);
});

test('audit refuses a pass that contradicts the assertion', async () => {
  const cwd = await workspace();
  await ready(cwd);

  const contradicting = goodChecks.map((check) =>
    check.criterionId === 'P-01' ? { ...check, actual: '1240ms' } : check
  );
  const result = await auditTool.execute({ note: '复测冷启动', checks: contradicting }, exec(cwd));
  assert.equal(result.ok, false);
  assert.match(result.summary, /未通过/);

  const rework = await readFile(join(cwd, '.shared', 'tasks', 'rework-1.md'), 'utf8');
  assert.match(rework, /断言判定不通过/);
  assert.match(rework, /1240/);
  await assert.rejects(readFile(join(cwd, '.shared', 'artifacts', 'acceptance-report.md'), 'utf8'));
});

test('audit refuses a pass without the required actual value', async () => {
  const cwd = await workspace();
  await ready(cwd);

  const missingActual = goodChecks.map((check) => {
    if (check.criterionId !== 'A-01') return check;
    const { actual, ...rest } = check;
    return rest;
  });
  const result = await auditTool.execute({ note: '漏登记实测值', checks: missingActual }, exec(cwd));
  assert.equal(result.ok, false);

  const rework = await readFile(join(cwd, '.shared', 'tasks', 'rework-1.md'), 'utf8');
  assert.match(rework, /actual/);
});

test('evaluateAssertion implements every matcher', () => {
  const pass = (assertion, actual) => evaluateAssertion(assertion, actual).verdict === 'pass';
  assert.equal(pass({ matcher: 'equals', expected: '4' }, '4'), true);
  assert.equal(pass({ matcher: 'equals', expected: 4 }, '4 天'), true);
  assert.equal(pass({ matcher: 'equals', expected: '4' }, '3'), false);
  assert.equal(pass({ matcher: 'contains', expected: '连续' }, '连续天数 4'), true);
  assert.equal(pass({ matcher: 'contains', expected: '连续' }, '天数 4'), false);
  assert.equal(pass({ matcher: 'regex', expected: '^\\d+\\.\\d+:1$' }, '4.9:1'), true);
  assert.equal(pass({ matcher: 'regex', expected: '^\\d+:1$' }, 'abc'), false);
  assert.equal(pass({ matcher: 'range', min: 8, max: 16 }, '12vp'), true);
  assert.equal(pass({ matcher: 'range', min: 8, max: 16 }, '20vp'), false);
  assert.equal(pass({ matcher: 'range', min: 8 }, 'no number'), false);
  assert.equal(pass({ matcher: 'gte', expected: 4.5 }, '4.9:1'), true);
  assert.equal(pass({ matcher: 'gte', expected: 4.5 }, '3.9:1'), false);
  assert.equal(pass({ matcher: 'lte', expected: 800 }, '720ms'), true);
  assert.equal(pass({ matcher: 'lte', expected: 800 }, '1240ms'), false);
  assert.equal(pass({ matcher: 'oneOf', expected: ['浅色', '深色'] }, '深色'), true);
  assert.equal(pass({ matcher: 'oneOf', expected: ['浅色', '深色'] }, '高对比'), false);
  assert.equal(pass({ matcher: 'present' }, 'hello'), true);
  assert.equal(pass({ matcher: 'present' }, '   '), false);
});
