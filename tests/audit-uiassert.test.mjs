// Audit-side automatic re-check of uiassert evidence (1.0.3): an audit must not
// accept a uiassert.json whose `passed` is false, and must accept a passed one.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-audit-ui-'));

import { resolveOptions } from '../lib/config.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createSpecTool } from '../lib/tools/spec.js';

const options = resolveOptions({ strictEvidence: false });
const specTool = createSpecTool(options);
const auditTool = createAuditTool(options);
const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击按钮后出现成功提示', verify: 'uiassert text=成功 present' },
  { id: 'A-01', dimension: 'aesthetic', statement: '卡片间距 12vp、圆角 16vp', verify: '截图 + 布局树' },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 截图与毫秒数' },
  { id: 'X-01', dimension: 'accessibility', statement: '按钮文字对比度 ≥ 4.5:1', verify: '截图取样计算' }
];

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-audit-ui-ws-'));
  dirs.push(dir);
  return dir;
}

async function writeSpec(cwd) {
  return specTool.execute(
    {
      action: 'write',
      title: '登录成功提示',
      requirement: '用户点击登录后，页面出现成功提示，并保持卡片间距。',
      spec: '登录页点击按钮后显示成功提示；布局参数不变。',
      constraints: ['compatibleSdkVersion 5.0.0(12)'],
      criteria
    },
    exec(cwd)
  );
}

const uiAssertFile = '.shared/artifacts/deveco-1/uiassert.json';

test('audit rejects a uiassert evidence file with passed=false', async () => {
  const cwd = await workspace();
  const spec = await writeSpec(cwd);
  assert.equal(spec.ok, true, spec.detail ?? spec.summary);
  await mkdir(join(cwd, '.shared', 'artifacts', 'deveco-1'), { recursive: true });
  await writeFile(
    join(cwd, uiAssertFile),
    `${JSON.stringify({ schemaVersion: 1, selector: 'text=成功', expect: 'present', passed: false }, null, 2)}\n`,
    'utf8'
  );
  const result = await auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: 'uiassert 未通过', evidenceFiles: ['artifacts/deveco-1/uiassert.json'] }
      ]
    },
    exec(cwd)
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /uiassert 证据校验失败/);
});

test('audit accepts a passed uiassert evidence file (no uiassert-specific rejection)', async () => {
  const cwd = await workspace();
  const spec = await writeSpec(cwd);
  assert.equal(spec.ok, true, spec.detail ?? spec.summary);
  await mkdir(join(cwd, '.shared', 'artifacts', 'deveco-1'), { recursive: true });
  await writeFile(
    join(cwd, uiAssertFile),
    `${JSON.stringify({ schemaVersion: 1, selector: 'text=成功', expect: 'present', passed: true }, null, 2)}\n`,
    'utf8'
  );
  const result = await auditTool.execute(
    {
      checks: [
        { criterionId: 'F-01', result: 'pass', evidence: 'uiassert 通过', evidenceFiles: ['artifacts/deveco-1/uiassert.json'] }
      ]
    },
    exec(cwd)
  );
  assert.doesNotMatch(result.summary, /uiassert 证据校验失败/);
});
