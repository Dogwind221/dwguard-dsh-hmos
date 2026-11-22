// Zero-click executor (`dwguard_code`): argv construction, binary resolution,
// run/status/stop/list lifecycle, single-job-per-directory and timeout handling.
// The process/timer seam is injected so no test spawns a real `deveco`.
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-code-home-'));

import { resolveOptions } from '../lib/config.js';
import { buildCodeArgs, createCodeTool, resolveCodeBinary } from '../lib/tools/code.js';
import { createDispatchTool } from '../lib/tools/dispatch.js';
import { createPrereviewTool } from '../lib/tools/prereview.js';
import { createSpecTool } from '../lib/tools/spec.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-code-'));
  dirs.push(dir);
  return dir;
}

async function writeSpec(cwd, options) {
  const specTool = createSpecTool(options);
  const result = await specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '单页应用：首页展示连续天数卡片与打卡按钮，点击后写入偏好存储。',
      criteria
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);
}

async function dispatched(cwd, options) {
  await writeSpec(cwd, options);
  const prereviewTool = createPrereviewTool(options);
  const dispatchTool = createDispatchTool(options);
  const preview = await prereviewTool.execute(
    { note: '通读 spec 与首页源码，覆盖四视角与验收可行性', findings: [] },
    exec(cwd)
  );
  assert.equal(preview.ok, true, preview.detail);
  const dispatchedResult = await dispatchTool.execute({}, exec(cwd));
  assert.equal(dispatchedResult.ok, true, dispatchedResult.detail);
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function harness({ options = resolveOptions({}), child = fakeChild() } = {}) {
  const calls = [];
  const kills = [];
  let timerInfo;
  const deps = {
    spawn: (command, args, spawnOptions) => {
      calls.push({ command, args, spawnOptions });
      return child;
    },
    kill: (pid) => kills.push(pid),
    alive: () => true,
    timer: (ms, callback) => {
      timerInfo = { ms, callback };
      return {
        cancel: () => {
          timerInfo = undefined;
        }
      };
    }
  };
  const tool = createCodeTool(options, undefined, deps);
  return { tool, calls, kills, child, timerInfo: () => timerInfo };
}

const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// Persisting meta.json is a fire-and-forget atomic write; poll for it instead of
// assuming one event-loop turn is enough.
async function waitForText(file, pattern, timeoutMs = 3000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      last = await readFile(file, 'utf8');
      if (pattern === undefined || pattern.test(last)) return last;
    } catch {
      /* not written yet */
    }
    await sleep(20);
  }
  throw new Error(`等待超时：${file}（最后读到 ${last.length} 字符）`);
}

async function artifact(cwd, name, pattern) {
  return waitForText(join(cwd, '.shared', 'artifacts', 'code-1', name), pattern);
}

test('config keeps --auto off by default and clamps the timeout', () => {
  const defaults = resolveOptions({});
  assert.equal(defaults.codeAuto, false);
  assert.equal(defaults.codeTimeoutMinutes, 45);
  assert.equal(resolveOptions({ codeAuto: true }).codeAuto, true);
  assert.equal(resolveOptions({ codeTimeoutMinutes: 9999 }).codeTimeoutMinutes, 240);
  assert.equal(resolveOptions({ codeTimeoutMinutes: 0 }).codeTimeoutMinutes, 1);
});

test('buildCodeArgs keeps the prompt last and --auto opt-in', () => {
  assert.deepEqual(buildCodeArgs({ dir: '/tmp/app', prompt: 'go', auto: false }), [
    'run',
    '--dir',
    '/tmp/app',
    '--format',
    'json',
    'go'
  ]);
  assert.deepEqual(
    buildCodeArgs({ dir: 'D:/app', prompt: 'go', auto: true, model: 'deepseek/deepseek-chat', agent: 'build' }),
    ['run', '--dir', 'D:/app', '--format', 'json', '--auto', '--model', 'deepseek/deepseek-chat', '--agent', 'build', 'go']
  );
  assert.deepEqual(buildCodeArgs({ dir: '/tmp/app', prompt: 'go', auto: true, model: '', agent: '' }), [
    'run',
    '--dir',
    '/tmp/app',
    '--format',
    'json',
    '--auto',
    'go'
  ]);
});

test('resolveCodeBinary honors an explicit path and falls back to the CLI name', () => {
  assert.equal(resolveCodeBinary('D:/tools/deveco.cmd'), resolve('D:/tools/deveco.cmd'));
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  delete process.env.APPDATA;
  delete process.env.LOCALAPPDATA;
  try {
    assert.equal(resolveCodeBinary(''), 'deveco');
  } finally {
    if (saved.APPDATA !== undefined) process.env.APPDATA = saved.APPDATA;
    if (saved.LOCALAPPDATA !== undefined) process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
  }
});

test('run streams JSON events, then status reports completion and meta.json lands', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await dispatched(cwd, options);
  const h = harness({ options });

  const started = await h.tool.execute({ action: 'run' }, exec(cwd));
  assert.equal(started.ok, true, started.detail);
  assert.equal(h.calls.length, 1);
  const argv = h.calls[0].args;
  assert.ok(argv.includes('run'));
  assert.ok(argv.includes('--format'));
  assert.equal(argv.includes('--auto'), false, '默认不应传 --auto');
  assert.match(argv[argv.length - 1], /goal-brief\.md/);

  h.child.stdout.emit('data', Buffer.from('{"sessionID":"s-1","part":{"type":"text","text":"hello"}}\n'));
  await tick();
  const running = await h.tool.execute({ action: 'status' }, exec(cwd));
  assert.match(running.summary, /running/);
  assert.match(running.detail, /s-1/);
  assert.match(running.detail, /hello/);

  h.child.emit('close', 0);
  await tick();
  const finished = await h.tool.execute({ action: 'status' }, exec(cwd));
  assert.match(finished.summary, /completed/);

  const meta = JSON.parse(await artifact(cwd, 'meta.json', /"status": "completed"/));
  assert.equal(meta.status, 'completed');
  assert.equal(meta.exitCode, 0);
  assert.equal(meta.sessionID, 's-1');
  assert.equal(meta.eventCount, 1);
  const events = await artifact(cwd, 'events.jsonl', /"sessionID":"s-1"/);
  assert.match(events, /"sessionID":"s-1"/);
});

test('codeAuto from config turns --auto on and the timeout follows codeTimeoutMinutes', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ codeAuto: true, codeTimeoutMinutes: 5, codeModel: 'deepseek/deepseek-chat' });
  await dispatched(cwd, options);
  const h = harness({ options });

  const started = await h.tool.execute({ action: 'run' }, exec(cwd));
  assert.equal(started.ok, true, started.detail);
  const argv = h.calls[0].args;
  assert.ok(argv.includes('--auto'));
  assert.ok(argv.includes('--model'));
  const timerInfo = h.timerInfo();
  assert.equal(timerInfo.ms, 5 * 60_000);

  h.child.emit('close', 0);
  await tick();
});

test('run refuses a second job in the same project directory', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await dispatched(cwd, options);
  const h = harness({ options });

  const first = await h.tool.execute({ action: 'run' }, exec(cwd));
  assert.equal(first.ok, true, first.detail);
  const second = await h.tool.execute({ action: 'run' }, exec(cwd));
  assert.equal(second.ok, false);
  assert.match(second.summary, /已有运行中的 job/);

  h.child.emit('close', 0);
  await tick();
});

test('stop requests a tree kill and close marks the job stopped', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await dispatched(cwd, options);
  const h = harness({ options });

  assert.equal((await h.tool.execute({ action: 'run' }, exec(cwd))).ok, true);
  const stopped = await h.tool.execute({ action: 'stop', id: 'code-1' }, exec(cwd));
  assert.equal(stopped.ok, true, stopped.detail);
  assert.deepEqual(h.kills, [4242]);

  const stopping = await h.tool.execute({ action: 'status', id: 'code-1' }, exec(cwd));
  assert.match(stopping.summary, /stopping/);

  h.child.emit('close', null);
  await tick();
  const stoppedStatus = await h.tool.execute({ action: 'status', id: 'code-1' }, exec(cwd));
  assert.match(stoppedStatus.summary, /stopped/);
});

test('timeout kills the job and is not overwritten by the later close event', async () => {
  const cwd = await workspace();
  const options = resolveOptions({ codeTimeoutMinutes: 3 });
  await dispatched(cwd, options);
  const h = harness({ options });

  assert.equal((await h.tool.execute({ action: 'run' }, exec(cwd))).ok, true);
  const timerInfo = h.timerInfo();
  assert.equal(timerInfo.ms, 3 * 60_000);
  timerInfo.callback();
  await tick();
  assert.deepEqual(h.kills, [4242]);

  const timedOut = await h.tool.execute({ action: 'status' }, exec(cwd));
  assert.match(timedOut.summary, /timeout/);
  h.child.emit('close', null);
  await tick();
  const afterClose = await h.tool.execute({ action: 'status' }, exec(cwd));
  assert.match(afterClose.summary, /timeout/);
});

test('list reports the job and failed jobs still record their exit code', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await dispatched(cwd, options);
  const h = harness({ options });

  assert.equal((await h.tool.execute({ action: 'run' }, exec(cwd))).ok, true);
  const listed = await h.tool.execute({ action: 'list' }, exec(cwd));
  assert.equal(listed.ok, true);
  assert.match(listed.detail, /code-1/);
  assert.match(listed.detail, /running/);

  h.child.emit('close', 2);
  await tick();
  const meta = JSON.parse(await artifact(cwd, 'meta.json', /"status": "failed"/));
  assert.equal(meta.status, 'failed');
  assert.equal(meta.exitCode, 2);
});

test('run refuses without a Goal brief, without a project dir, or with a missing explicit binary', async () => {
  const cwd = await workspace();
  const options = resolveOptions({});
  await writeSpec(cwd, options);
  const h = harness({ options });
  const noBrief = await h.tool.execute({ action: 'run' }, exec(cwd));
  assert.equal(noBrief.ok, false);
  assert.match(noBrief.summary, /Goal 简报/);

  await dispatched(cwd, options);
  const h2 = harness({ options });
  const noDir = await h2.tool.execute({ action: 'run', dir: 'not-a-real-dir' }, exec(cwd));
  assert.equal(noDir.ok, false);
  assert.match(noDir.summary, /工程目录不存在/);

  const missingBinary = harness({ options: resolveOptions({ devecoCodePath: join(cwd, 'nope', 'deveco.cmd') }) });
  const noBinary = await missingBinary.tool.execute({ action: 'run' }, exec(cwd));
  assert.equal(noBinary.ok, false);
  assert.match(noBinary.summary, /devecoCodePath 不存在/);
});
