// CLI executor mode + devecocli evidence adapter.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-deveco-home-'));

import { resolveOptions } from '../lib/config.js';
import { chooseExecutor } from '../lib/dispatch.js';
import { createDevecoTool } from '../lib/tools/deveco.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';
import { createStatusTool } from '../lib/tools/status.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const criteria = [
  { id: 'F-01', dimension: 'function', statement: '点击打卡后连续天数从 3 变成 4', verify: '操作步骤 + 截图 F-01.png', ruleId: 'DW-FN-01' },
  { id: 'A-01', dimension: 'aesthetic', statement: '打卡卡片间距 12vp、圆角 16vp', verify: '布局树 bounds 12vp/16vp', ruleId: 'DW-AES-01' },
  { id: 'P-01', dimension: 'performance', statement: '冷启动到首帧 ≤ 800ms', verify: 'Profiler 启动分析截图', ruleId: 'DW-PERF-01' },
  { id: 'X-01', dimension: 'accessibility', statement: '打卡按钮触控热区 ≥ 48vp', verify: '布局树 bounds 48vp', ruleId: 'DW-A11Y-02' }
];

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-deveco-'));
  dirs.push(dir);
  return dir;
}

async function dispatched(cwd, options) {
  const specTool = createSpecTool(options);
  const prereviewTool = createPrereviewTool(options);
  const dispatchTool = createDispatchTool(options);
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
  return dispatchTool.execute({}, exec(cwd));
}

test('executor=cli writes a CLI brief with the devecocli contract', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ executor: 'cli' });
  const result = await dispatched(cwd, options);
  assert.equal(result.ok, true, result.detail);
  const brief = await readFile(join(cwd, '.shared', 'tasks', 'cli-brief.md'), 'utf8');
  assert.match(brief, /CLI 执行模式/);
  assert.match(brief, /devecocli build/);
  assert.match(brief, /devecocli run/);
  assert.match(brief, /DSH 自己/);
  assert.match(brief, /视觉证据|截图、UI 树/);
  assert.match(result.next, /CLI Agent/);
  // The IDE brief stays available for reference.
  const goal = await readFile(join(cwd, '.shared', 'tasks', 'goal-brief.md'), 'utf8');
  assert.match(goal, /DevEco Code · Goal 模式任务简报/);
});

test('deveco env records command, exit code and output; failures stay failures', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  const okRun = async (command, args) => {
    assert.match(command, /devecocli/);
    assert.deepEqual(args, ['--version']);
    return { code: 0, stdout: 'devecocli 1.3.10\n', stderr: '', durationMs: 12 };
  };
  const tool = createDevecoTool(options, undefined, okRun);
  const result = await tool.execute({ action: 'env' }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  assert.match(result.summary, /exit 0/);
  const record = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'result.json'), 'utf8'));
  assert.equal(record.action, 'env');
  assert.equal(record.exitCode, 0);
  assert.match(record.stdout, /devecocli 1\.3\.10/);

  const failRun = async () => ({ code: 2, stdout: '', stderr: 'device offline', durationMs: 5 });
  const failing = createDevecoTool(options, undefined, failRun);
  const failed = await failing.execute({ action: 'device' }, exec(cwd));
  assert.equal(failed.ok, false);
  assert.match(failed.summary, /exit 2/);
});

test('deveco reports a missing binary instead of pretending success', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  const missing = createDevecoTool(options, undefined, async () => {
    throw new Error('spawn devecocli ENOENT');
  });
  const result = await missing.execute({ action: 'build' }, exec(cwd));
  assert.equal(result.ok, false);
  assert.match(result.summary, /找不到 devecocli/);
  assert.match(result.next, /Command Line Tool/);
});

test('deveco rejects unsafe ui args and path-like apply values', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  const tool = createDevecoTool(options, undefined, async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }));
  const injected = await tool.execute({ action: 'ui', args: 'tree; rm -rf /' }, exec(cwd));
  assert.equal(injected.ok, false);
  const escaped = await tool.execute({ action: 'run', apply: '../outside.txt' }, exec(cwd));
  assert.equal(escaped.ok, false);
});

test('executor routing is IDE-first; CLI only when the task has no visual must and is batch-flavoured', () => {
  const base = {
    requirement: '页面开发',
    spec: '实现首页',
    constraints: [],
    criteria: [
      { id: 'A-01', dimension: 'aesthetic', statement: '间距 12vp', verify: '布局树', weight: 'must' }
    ]
  };
  assert.equal(chooseExecutor({ ...base, executor: undefined }, { executor: 'auto' }), 'ide');
  assert.equal(
    chooseExecutor(
      { ...base, criteria: [{ id: 'A-01', dimension: 'aesthetic', statement: '间距 12vp', verify: '布局树', weight: 'should' }], constraints: ['批量回归任务'] },
      { executor: 'auto' }
    ),
    'cli'
  );
  assert.equal(chooseExecutor({ ...base, executor: 'cli' }, { executor: 'ide' }), 'cli');
  assert.equal(chooseExecutor({ ...base, executor: undefined }, { executor: 'ide' }), 'ide');
});

test('deveco attach reuses an existing log without rebuilding', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await writeFile(join(cwd, 'build.log'), 'BUILD SUCCESSFUL in 42s\n');
  const tool = createDevecoTool(options);
  const result = await tool.execute({ action: 'attach', file: 'build.log' }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  const stored = await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'attached-build.log'), 'utf8');
  assert.match(stored, /BUILD SUCCESSFUL/);
  const record = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'result.json'), 'utf8'));
  assert.equal(record.action, 'attach');
});

test('background jobs start, list and stop without blocking', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  const started = [];
  const tool = createDevecoTool(
    options,
    undefined,
    async () => {
      throw new Error('sync runner must not run');
    },
    {
      start: (_command, args, _cwd, logFile) => {
        started.push({ args, logFile });
        return 4242;
      },
      alive: (pid) => pid === 4242,
      stop: (pid) => pid === 4242
    }
  );
  const result = await tool.execute({ action: 'build', background: true }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(started[0].args, ['build']);
  const jobs = await tool.execute({ action: 'jobs' }, exec(cwd));
  assert.match(jobs.detail, /running/);
  const stopped = await tool.execute({ action: 'stop', job: '1' }, exec(cwd));
  assert.equal(stopped.ok, true, stopped.detail);
});

test('device evidence actions use the real devecocli subcommands', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  const seen = [];
  const tool = createDevecoTool(options, undefined, async (_command, args) => {
    seen.push(args);
    if (args[0] === 'ui' && args[1] === 'layout') {
      return { code: 0, stdout: '{"nodes":[{"type":"Button"}]}', stderr: '', durationMs: 3 };
    }
    return { code: 0, stdout: '', stderr: '', durationMs: 3 };
  });
  const shot = await tool.execute({ action: 'screenshot' }, exec(cwd));
  assert.equal(shot.ok, true, shot.detail);
  assert.equal(seen[0][0], 'ui');
  assert.equal(seen[0][1], 'screenshot');
  assert.ok(seen[0].includes('--path'));

  const layout = await tool.execute({ action: 'layout' }, exec(cwd));
  assert.equal(layout.ok, true, layout.detail);
  assert.deepEqual(seen[1].slice(0, 4), ['ui', 'layout', '--format', 'json']);
  const tree = await readFile(join(cwd, '.shared', 'artifacts', 'deveco-2', 'layout.json'), 'utf8');
  assert.match(tree, /Button/);

  const verify = await tool.execute(
    { action: 'verify', plan: '点击打卡，期望天数 +1', bundle: 'com.example.demo' },
    exec(cwd)
  );
  assert.equal(verify.ok, true, verify.detail);
  assert.equal(seen[2][0], 'verify');
  assert.ok(seen[2].includes('--test-plan'));
  assert.ok(seen[2].includes('--bundle-name'));
});

test('status watchdog flags a dispatch that has been waiting too long', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ stallMinutes: 1 });
  assert.equal((await dispatched(cwd, options)).ok, true);
  const outboxPath = join(cwd, '.shared', 'outbox-dsh.md');
  const text = await readFile(outboxPath, 'utf8');
  await writeFile(outboxPath, text.replace(/\[[^\]]+\]/, '[2020-01-01T00:00:00.000Z]'));
  const status = await createStatusTool(options).execute({}, exec(cwd));
  assert.match(status.next, /仍无回执\/交付/);
});

