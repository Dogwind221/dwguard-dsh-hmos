// Workbench actions added in 1.0.2: emulator / app / file / uiassert / trace /
// project / api / compat. The CLI runner is injected, so no device or devecocli
// is required; `project` and `api` are pure read-only paths and use temp fixtures.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-workbench-home-'));

import { resolveOptions } from '../lib/config.js';
import { createDevecoTool } from '../lib/tools/deveco.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-workbench-'));
  dirs.push(dir);
  return dir;
}

async function write(file, content) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

function runnerReturning(result) {
  const calls = [];
  const runner = async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    return typeof result === 'function' ? result(command, args) : result;
  };
  return { runner, calls };
}

function readFailure(result) {
  return result.detail ?? result.summary;
}

async function projectFixture(root) {
  await write(
    join(root, 'build-profile.json5'),
    `{
  // DevEco writes JSON5 with comments and trailing commas.
  "app": {
    "signingConfigs": [{ "name": "default", "material": { "certpath": "x" } }],
    "products": [{ "name": "default", "compileSdkVersion": "6.0.0(20)", "compatibleSdkVersion": "5.0.0(12)" }],
    "buildModeSet": [{ "name": "debug" }, { "name": "release" }],
  },
  "modules": [{ "name": "entry", "srcPath": "./entry" },],
}`
  );
  await write(
    join(root, 'AppScope', 'app.json5'),
    `{ "app": { "bundleName": "com.demo.app", "versionName": "2.3.4", "versionCode": 20304, "vendor": "demo", "label": "$string:app_name" } }`
  );
  await write(
    join(root, 'entry', 'src', 'main', 'module.json5'),
    `{
  "module": {
    "name": "entry",
    "type": "entry",
    "deviceTypes": ["phone", "tablet"],
    "abilities": [{ "name": "EntryAbility" }, { "name": "BackupAbility" }],
    "requestPermissions": [{ "name": "ohos.permission.INTERNET" }],
  }
}`
  );
  await write(
    join(root, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'),
    `{ "src": ["pages/Index", "pages/Detail"] }`
  );
  await write(join(root, 'oh-package.json5'), `{ "dependencies": { "@ohos/router": "1.0.0" } }`);
  await write(join(root, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-signed.hap'), 'HAP');
}

test('project parses a DevEco project (JSON5, modules, pages, artifacts)', async () => {
  const cwd = await workspace();
  await projectFixture(cwd);
  const tool = createDevecoTool(resolveOptions({}));
  const result = await tool.execute({ action: 'project' }, exec(cwd));

  assert.equal(result.ok, true, readFailure(result));
  assert.match(result.detail, /com\.demo\.app/);
  assert.match(result.detail, /2\.3\.4/);
  assert.match(result.detail, /entry/);
  assert.match(result.detail, /EntryAbility/);
  assert.match(result.detail, /6\.0\.0\(20\)/);
  const project = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'project.json'), 'utf8'));
  assert.equal(project.bundleName, 'com.demo.app');
  assert.equal(project.modules.length, 1);
  assert.equal(project.modules[0].pages.length, 2);
  assert.equal(project.modules[0].abilities.length, 2);
  assert.ok(project.artifacts.some((entry) => entry.path.endsWith('.hap')));
});

test('project rejects a path outside the workspace', async () => {
  const cwd = await workspace();
  const tool = createDevecoTool(resolveOptions({}));
  const result = await tool.execute({ action: 'project', path: '../outside' }, exec(cwd));
  assert.equal(result.ok, false);
  assert.match(result.summary, /工作区内/);
});

test('api reads a fake SDK declaration and exposes @since/@deprecated', async () => {
  const cwd = await workspace();
  const sdk = await workspace();
  await write(
    join(sdk, 'default', 'openharmony', 'ets', 'api', '@ohos.demo.d.ts'),
    [
      '/**',
      ' * Demo module.',
      ' * @since 12',
      ' * @deprecated since 20',
      ' * @syscap SystemCapability.Demo',
      ' */',
      'declare namespace demo {',
      '  function hello(name: string): void;',
      '}',
      'export default demo;'
    ].join('\n')
  );
  await write(join(sdk, 'default', 'openharmony', 'ets', 'kits', '@kit.Demo.d.ts'), 'export * from "./@ohos.demo";\n');
  await write(
    join(sdk, 'default', 'openharmony', 'ets', 'oh-uni-package.json'),
    JSON.stringify({ apiVersion: '20', platformVersion: '20.0.0', version: '20.0.0.1' })
  );

  const tool = createDevecoTool(resolveOptions({ harmonySdkPath: sdk }));
  const lookup = await tool.execute({ action: 'api', module: '@ohos.demo', name: 'hello' }, exec(cwd));
  assert.equal(lookup.ok, true, readFailure(lookup));
  assert.match(lookup.detail, /@since/);
  assert.match(lookup.detail, /12/);
  assert.match(lookup.detail, /@deprecated/);
  assert.match(lookup.detail, /function hello/);
  const stored = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'api.json'), 'utf8'));
  assert.equal(stored.module, '@ohos.demo');

  const versions = await tool.execute({ action: 'api', op: 'versions' }, exec(cwd));
  assert.equal(versions.ok, true);
  assert.match(versions.summary, /20/);
});

test('emulator lists JSON instances and forwards rotate/volume flags', async () => {
  const cwd = await workspace();
  const list = JSON.stringify([
    { name: 'Mate X7', status: 'stopped', deviceType: 'foldable' },
    { name: 'MatePad Pro 13', status: 'running', deviceType: 'tablet' }
  ]);
  const first = runnerReturning({ code: 0, stdout: list, stderr: '', durationMs: 3 });
  const tool = createDevecoTool(resolveOptions({}), undefined, first.runner);
  const listed = await tool.execute({ action: 'emulator', op: 'list' }, exec(cwd));
  assert.equal(listed.ok, true, readFailure(listed));
  assert.deepEqual(first.calls[0].args, ['emulator', 'list', '--format', 'json']);
  assert.match(listed.summary, /2 个实例/);
  assert.match(listed.summary, /Mate X7/);

  const second = runnerReturning({ code: 0, stdout: '', stderr: '', durationMs: 2 });
  const tool2 = createDevecoTool(resolveOptions({}), undefined, second.runner);
  const rotated = await tool2.execute(
    { action: 'emulator', op: 'rotate', emulator: 'Mate X7', direction: 'left' },
    exec(cwd)
  );
  assert.equal(rotated.ok, true, readFailure(rotated));
  assert.deepEqual(second.calls[0].args, ['emulator', 'rotate', '--target', 'Mate X7', 'left']);
});

test('app lists/logs and installs a HAP with the resolved local path', async () => {
  const cwd = await workspace();
  await write(join(cwd, 'build', 'entry-default-signed.hap'), 'HAP');

  const first = runnerReturning({ code: 0, stdout: '[{"bundleName":"com.demo.app"}]', stderr: '', durationMs: 2 });
  const tool = createDevecoTool(resolveOptions({}), undefined, first.runner);
  const listed = await tool.execute({ action: 'app', op: 'list', device: 'S1' }, exec(cwd));
  assert.equal(listed.ok, true, readFailure(listed));
  assert.deepEqual(first.calls[0].args, ['device', 'app', 'list', '--format', 'json', '--device', 'S1']);

  const second = runnerReturning({ code: 0, stdout: 'install ok', stderr: '', durationMs: 2 });
  const tool2 = createDevecoTool(resolveOptions({}), undefined, second.runner);
  const installed = await tool2.execute(
    { action: 'app', op: 'install', hap: 'build/entry-default-signed.hap', device: 'S1' },
    exec(cwd)
  );
  assert.equal(installed.ok, true, readFailure(installed));
  assert.deepEqual(second.calls[0].args, [
    'device',
    'app',
    'install',
    join(cwd, 'build', 'entry-default-signed.hap'),
    '--device',
    'S1'
  ]);
});

test('file sends/recvs with workspace-contained paths', async () => {
  const cwd = await workspace();
  await write(join(cwd, 'payload.txt'), 'hello');
  const first = runnerReturning({ code: 0, stdout: 'sent', stderr: '', durationMs: 2 });
  const tool = createDevecoTool(resolveOptions({}), undefined, first.runner);

  const sent = await tool.execute(
    { action: 'file', op: 'send', src: 'payload.txt', dst: '/data/local/tmp/payload.txt', device: 'S1' },
    exec(cwd)
  );
  assert.equal(sent.ok, true, readFailure(sent));
  assert.deepEqual(first.calls[0].args, [
    'device',
    'file',
    'send',
    join(cwd, 'payload.txt'),
    '/data/local/tmp/payload.txt',
    '--device',
    'S1'
  ]);

  const second = runnerReturning({ code: 0, stdout: 'recv ok', stderr: '', durationMs: 2 });
  const tool2 = createDevecoTool(resolveOptions({}), undefined, second.runner);
  const received = await tool2.execute(
    { action: 'file', op: 'recv', src: '/data/local/tmp/pull.txt', dst: 'inbox/pull.txt', device: 'S1' },
    exec(cwd)
  );
  assert.equal(received.ok, true, readFailure(received));
  assert.equal(second.calls[0].args[4], join(cwd, 'inbox', 'pull.txt'));
});

test('uiassert passes present/count, fails mismatches, and waits for absence', async () => {
  const cwd = await workspace();
  const matchJson = JSON.stringify([{ type: 'Button', text: '登录', bounds: [0, 0, 100, 60] }]);
  const presentRunner = runnerReturning({ code: 0, stdout: matchJson, stderr: '', durationMs: 5 });
  const tool = createDevecoTool(resolveOptions({}), undefined, presentRunner.runner);
  const present = await tool.execute(
    { action: 'uiassert', selector: 'text=登录', expect: 'present', device: 'S1' },
    exec(cwd)
  );
  assert.equal(present.ok, true, readFailure(present));
  assert.match(present.detail, /matches 1/);
  assert.ok(presentRunner.calls[0].args.includes('ui'));
  const stored = JSON.parse(
    await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'uiassert.json'), 'utf8')
  );
  assert.equal(stored.passed, true);
  assert.equal(stored.actualMatches, 1);

  const countRunner = runnerReturning({ code: 0, stdout: matchJson, stderr: '', durationMs: 5 });
  const tool2 = createDevecoTool(resolveOptions({}), undefined, countRunner.runner);
  const countOk = await tool2.execute(
    { action: 'uiassert', selector: 'text=登录', expect: 'count', count: 1, device: 'S1' },
    exec(cwd)
  );
  assert.equal(countOk.ok, true, readFailure(countOk));
  const countBad = await tool2.execute(
    { action: 'uiassert', selector: 'text=登录', expect: 'count', count: 2, device: 'S1' },
    exec(cwd)
  );
  assert.equal(countBad.ok, false);

  const absentRunner = runnerReturning({ code: 0, stdout: 'disappeared', stderr: '', durationMs: 5 });
  const tool3 = createDevecoTool(resolveOptions({}), undefined, absentRunner.runner);
  const absent = await tool3.execute(
    { action: 'uiassert', selector: 'text=加载中', expect: 'absent', timeoutMs: 500, device: 'S1' },
    exec(cwd)
  );
  assert.equal(absent.ok, true, readFailure(absent));
  assert.deepEqual(absentRunner.calls[0].args, ['ui', 'wait', 'text=加载中', '500', '--disappear', '--device', 'S1']);

  const notFound = runnerReturning({ code: 1, stdout: '', stderr: 'not found', durationMs: 5 });
  const tool4 = createDevecoTool(resolveOptions({}), undefined, notFound.runner);
  const negative = await tool4.execute(
    { action: 'uiassert', selector: 'text=不存在', expect: 'present', device: 'S1' },
    exec(cwd)
  );
  assert.equal(negative.ok, false);
});

test('trace runs hdc hitrace and stores trace.txt', async () => {
  const cwd = await workspace();
  const run = runnerReturning({ code: 0, stdout: 'gfx-1: fps=60\nview-2: measure=1ms', stderr: '', durationMs: 40 });
  const tool = createDevecoTool(resolveOptions({ hdcPath: 'hdc-test', devicePool: [{ sn: 'S1', family: 'phone' }] }), undefined, run.runner);
  const result = await tool.execute(
    { action: 'trace', duration: 2, categories: 'gfx view', device: 'S1' },
    exec(cwd)
  );
  assert.equal(result.ok, true, readFailure(result));
  assert.equal(run.calls[0].command, 'hdc-test');
  assert.deepEqual(run.calls[0].args, ['-t', 'S1', 'shell', 'hitrace', '-t', '2', '-b', '4096', 'gfx', 'view']);
  const trace = await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'trace.txt'), 'utf8');
  assert.match(trace, /fps=60/);
});

test('trace treats hitrace error text as a failure and suggests categories', async () => {
  const cwd = await workspace();
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        code: 0,
        stdout: 'error: gfx is not support category on this device.\nerror: parsing args failed, exit.',
        stderr: '',
        durationMs: 20
      };
    }
    return {
      code: 0,
      stdout: 'hitrace enter, running_state is SHOW_LIST_CATEGORY\n ability - Ability Manager Service\n graphic - Graphic Module\n',
      stderr: '',
      durationMs: 15
    };
  };
  const tool = createDevecoTool(resolveOptions({ hdcPath: 'hdc-test' }), undefined, runner);
  const result = await tool.execute({ action: 'trace', categories: 'gfx', device: 'S1' }, exec(cwd));
  assert.equal(result.ok, false);
  assert.match(result.summary, /hitrace 报错/);
  assert.match(result.detail, /可用分类/);
  assert.match(result.detail, /graphic/);
});

test('compat forwards explicit or inferred SDK versions and stores JSON', async () => {
  const cwd = await workspace();
  await projectFixture(cwd);
  const payload = JSON.stringify({ changes: [{ name: 'a' }, { name: 'b' }] });
  const explicit = runnerReturning({ code: 0, stdout: payload, stderr: '', durationMs: 2 });
  const tool = createDevecoTool(resolveOptions({}), undefined, explicit.runner);
  const result = await tool.execute(
    { action: 'compat', sourceVersion: '5.0.0(12)', targetVersion: '6.0.0(20)' },
    exec(cwd)
  );
  assert.equal(result.ok, true, readFailure(result));
  assert.deepEqual(explicit.calls[0].args, [
    'check',
    'compat',
    '--format',
    'json',
    '--source-version',
    '5.0.0(12)',
    '--target-version',
    '6.0.0(20)'
  ]);
  assert.match(result.summary, /2 条兼容性变更/);
  assert.ok((await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'compat.json'), 'utf8')).includes('changes'));

  const inferred = runnerReturning({ code: 0, stdout: payload, stderr: '', durationMs: 2 });
  const tool2 = createDevecoTool(resolveOptions({}), undefined, inferred.runner);
  const inferredResult = await tool2.execute({ action: 'compat' }, exec(cwd));
  assert.equal(inferredResult.ok, true, readFailure(inferredResult));
  assert.deepEqual(inferred.calls[0].args, [
    'check',
    'compat',
    '--format',
    'json',
    '--source-version',
    '6.0.0(20)',
    '--target-version',
    '5.0.0(12)'
  ]);
});

test('compat without versions and no project fails with a hint', async () => {
  const cwd = await workspace();
  const tool = createDevecoTool(resolveOptions({}), undefined, async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }));
  const result = await tool.execute({ action: 'compat' }, exec(cwd));
  assert.equal(result.ok, false);
  assert.match(result.summary, /sourceVersion/);
  assert.match(result.next, /versions/);
});

test('log op=crash parses fault reports into crash.json', async () => {
  const cwd = await workspace();
  const crashText = [
    'Generated by HiviewDFX@OpenHarmony',
    'Fault thread info:',
    'pid: 4321',
    'Process name: com.demo.app',
    'Fault time: 2026-11-22 12:00:00',
    'Reason: Signal:SIGSEGV',
    '#00 pc 0000000000001234 /system/lib64/libace.z.so',
    '#01 pc 0000000000005678 /system/lib64/libutils.z.so'
  ].join('\n');
  const run = runnerReturning({ code: 0, stdout: crashText, stderr: '', durationMs: 25 });
  const tool = createDevecoTool(resolveOptions({}), undefined, run.runner);
  const result = await tool.execute({ action: 'log', op: 'crash', device: 'S1' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  assert.deepEqual(run.calls[0].args, ['log', '--crash', '--device', 'S1']);
  const crash = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'crash.json'), 'utf8'));
  assert.equal(crash.reports.length, 1);
  assert.equal(crash.reports[0].pid, 4321);
  assert.match(crash.reports[0].topFrame, /libace/);
  assert.match(result.summary, /crash：1 条记录/);
});

test('log op=hilog folds repeated errors and honors regex', async () => {
  const cwd = await workspace();
  const lines = [
    '11-22 12:00:00.000  4321  4321 E A00000/com.demo: Failed to load resource',
    '11-22 12:00:00.100  4321  4322 W A00000/com.demo: retry 3',
    '11-22 12:00:01.200  5555  5555 E A00000/other: Failed to load resource'
  ].join('\n');
  const run = runnerReturning({ code: 0, stdout: lines, stderr: '', durationMs: 10 });
  const tool = createDevecoTool(resolveOptions({}), undefined, run.runner);
  const result = await tool.execute({ action: 'log', op: 'hilog', regex: 'Failed', device: 'S1' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  assert.deepEqual(run.calls[0].args, ['log', '--device', 'S1']);
  const summary = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'hilog-summary.json'), 'utf8'));
  assert.equal(summary.total, 3);
  assert.equal(summary.matched, 2);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].count, 2);
  assert.match(result.summary, /hilog：3 行/);
});

test('uiassert fingerprint captures, matches, and rejects a changed layout', async () => {
  const cwd = await workspace();
  const layout = JSON.stringify({
    id: 'root',
    type: 'Column',
    children: [
      { id: 'title', type: 'Text', text: '设置', bounds: [0, 0, 100, 50] },
      { id: 'ok', type: 'Button', text: 'OK', bounds: [0, 60, 100, 50] }
    ]
  });
  const run = runnerReturning({ code: 0, stdout: layout, stderr: '', durationMs: 5 });
  const tool = createDevecoTool(resolveOptions({}), undefined, run.runner);
  const captured = await tool.execute({ action: 'uiassert', expect: 'fingerprint', device: 'S1' }, exec(cwd));
  assert.equal(captured.ok, true, readFailure(captured));
  assert.match(captured.summary, /指纹：fp-/);
  assert.deepEqual(run.calls[0].args, ['ui', 'layout', '--format', 'json', '--mode', 'full', '--device', 'S1']);
  const record = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'uiassert.json'), 'utf8'));
  assert.match(record.fingerprint, /^fp-[0-9a-f]{16}$/);

  const matched = await tool.execute(
    { action: 'uiassert', expect: 'fingerprint', fingerprint: record.fingerprint, device: 'S1' },
    exec(cwd)
  );
  assert.equal(matched.ok, true, readFailure(matched));

  const changed = await tool.execute(
    { action: 'uiassert', expect: 'fingerprint', fingerprint: 'fp-0000000000000000', device: 'S1' },
    exec(cwd)
  );
  assert.equal(changed.ok, false);
});

test('uiassert device=all runs the assertion on every pooled device', async () => {
  const cwd = await workspace();
  const matchJson = JSON.stringify([{ type: 'Button', text: '登录', bounds: [0, 0, 100, 60] }]);
  const run = runnerReturning({ code: 0, stdout: matchJson, stderr: '', durationMs: 5 });
  const options = resolveOptions({
    devicePool: [
      { sn: 'S1', family: 'phone' },
      { sn: 'S2', family: 'tablet' }
    ]
  });
  const tool = createDevecoTool(options, undefined, run.runner);
  const result = await tool.execute({ action: 'uiassert', selector: 'text=登录', expect: 'present', device: 'all' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  assert.match(result.summary, /2\/2 台通过/);
  assert.equal(run.calls.length, 2);
  assert.ok(run.calls[0].args.includes('S1'));
  assert.ok(run.calls[1].args.includes('S2'));
  const matrix = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'uiassert-matrix.json'), 'utf8'));
  assert.equal(matrix.results.length, 2);
  assert.equal(matrix.passed, true);
});

test('api op=scan reports deprecated SDK API call sites', async () => {
  const cwd = await workspace();
  const sdk = await workspace();
  await write(join(cwd, 'build-profile.json5'), `{ "modules": [{ "name": "entry", "srcPath": "./entry" }] }`);
  await write(
    join(cwd, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'),
    `import { foo } from '@ohos.demo';\n\nexport function page(): void {\n  foo();\n}\n`
  );
  await write(
    join(sdk, 'default', 'openharmony', 'ets', 'api', '@ohos.demo.d.ts'),
    `/**\n * @since 10\n * @deprecated since 20 use bar()\n */\ndeclare function foo(): void;\nexport default foo;\n`
  );
  const tool = createDevecoTool(resolveOptions({ harmonySdkPath: sdk }));
  const result = await tool.execute({ action: 'api', op: 'scan' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  assert.match(result.summary, /1 处废弃 API 引用/);
  const scan = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'api-scan.json'), 'utf8'));
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0].symbol, 'foo');
  assert.equal(scan.findings[0].line, 4);
});


const TRACE_SAMPLE = [
  '# tracer: nop',
  '# entries-in-buffer/entries-written: 4/4',
  '           <...>-1527    (-------) [003] ....   676.523053: tracing_mark_write: B|1527|H:Native async work queueWithQos|I39',
  '           <...>-1527    (-------) [003] ....   676.523134: tracing_mark_write: E|1527|I39',
  '           <...>-1691    (-------) [002] ....   676.530000: tracing_mark_write: B|1691|H:SomeWork|I62',
  '           <...>-1691    (-------) [002] ....   676.530500: tracing_mark_write: E|1691|I62'
].join('\n');

test('trace summarizes paired slices (top functions / slowest / span)', async () => {
  const cwd = await workspace();
  const run = runnerReturning({ code: 0, stdout: TRACE_SAMPLE, stderr: '', durationMs: 30 });
  const tool = createDevecoTool(resolveOptions({ hdcPath: 'hdc-test' }), undefined, run.runner);
  const result = await tool.execute({ action: 'trace', duration: 2, device: 'S1' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  const summary = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'trace-summary.json'), 'utf8'));
  assert.equal(summary.events, 4);
  assert.equal(summary.beginEvents, 2);
  assert.equal(summary.endEvents, 2);
  assert.equal(summary.functions, 2);
  assert.equal(summary.topFunctions.length, 2);
  assert.ok(summary.topFunctions.some((entry) => /Native async work/.test(entry.name)));
  assert.ok(summary.slowest.length === 2);
  assert.ok(summary.spanMs > 0);
  assert.match(result.summary, /事件/);
});

test('trace device=all writes per-device traces and a matrix', async () => {
  const cwd = await workspace();
  const run = runnerReturning({ code: 0, stdout: TRACE_SAMPLE, stderr: '', durationMs: 20 });
  const options = resolveOptions({
    hdcPath: 'hdc-test',
    devicePool: [
      { sn: 'S1', family: 'phone' },
      { sn: 'S2', family: 'tablet' }
    ]
  });
  const tool = createDevecoTool(options, undefined, run.runner);
  const result = await tool.execute({ action: 'trace', duration: 2, device: 'all' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  assert.equal(run.calls.length, 2);
  assert.ok(run.calls[0].args.includes('S1'));
  assert.ok(run.calls[1].args.includes('S2'));
  const matrix = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'trace-matrix.json'), 'utf8'));
  assert.equal(matrix.rows.length, 2);
  assert.match(result.summary, /2 台/);
});

test('app device=all runs read-only queries on every pooled device', async () => {
  const cwd = await workspace();
  const run = runnerReturning({ code: 0, stdout: '[{"bundleName":"com.demo.app"}]', stderr: '', durationMs: 5 });
  const options = resolveOptions({
    devicePool: [
      { sn: 'S1', family: 'phone' },
      { sn: 'S2', family: 'tablet' }
    ]
  });
  const tool = createDevecoTool(options, undefined, run.runner);
  const result = await tool.execute({ action: 'app', op: 'list', device: 'all' }, exec(cwd));
  assert.equal(result.ok, true, readFailure(result));
  assert.equal(run.calls.length, 2);
  assert.deepEqual(run.calls[0].args, ['device', 'app', 'list', '--format', 'json', '--device', 'S1']);
  assert.deepEqual(run.calls[1].args, ['device', 'app', 'list', '--format', 'json', '--device', 'S2']);
  const matrix = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'app-matrix.json'), 'utf8'));
  assert.equal(matrix.passed, true);
  assert.equal(matrix.rows.length, 2);
});

test('db runs a read-only sqlite query and rejects writes', async () => {
  const cwd = await workspace();
  const run = runnerReturning({ code: 0, stdout: 'id|name\n1|demo', stderr: '', durationMs: 5 });
  const tool = createDevecoTool(resolveOptions({}), undefined, run.runner);
  const result = await tool.execute(
    { action: 'db', db: '/data/app/el2/100/database/demo.db', sql: 'SELECT id, name FROM user', device: 'S1' },
    exec(cwd)
  );
  assert.equal(result.ok, true, readFailure(result));
  assert.deepEqual(run.calls[0].args, [
    'device',
    'sqlite3',
    '/data/app/el2/100/database/demo.db',
    'SELECT id, name FROM user',
    '--device',
    'S1'
  ]);
  const stored = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'db-query.json'), 'utf8'));
  assert.equal(stored.sql, 'SELECT id, name FROM user');
  assert.equal(stored.outputLines, 2);

  const bad = await tool.execute(
    { action: 'db', db: '/data/app/demo.db', sql: 'DELETE FROM user', device: 'S1' },
    exec(cwd)
  );
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /只读/);
});

test('emulator state injection maps to structured flags', async () => {
  const cwd = await workspace();
  const run = runnerReturning({ code: 0, stdout: 'ok', stderr: '', durationMs: 1 });
  const tool = createDevecoTool(resolveOptions({}), undefined, run.runner);

  await tool.execute({ action: 'emulator', op: 'fold', emulator: 'S1', foldState: 'half-open' }, exec(cwd));
  assert.deepEqual(run.calls[0].args, ['emulator', 'fold', '--target', 'S1', 'half-open']);

  await tool.execute(
    { action: 'emulator', op: 'battery', emulator: 'S1', batteryLevel: 80, batteryStatus: 'charging' },
    exec(cwd)
  );
  assert.deepEqual(run.calls[1].args, ['emulator', 'battery', '--target', 'S1', '--level', '80', '--status', 'charging']);

  await tool.execute(
    { action: 'emulator', op: 'geolocation', emulator: 'S1', latitude: 31.2, longitude: 121.5 },
    exec(cwd)
  );
  assert.deepEqual(run.calls[2].args, [
    'emulator',
    'geolocation',
    '--target',
    'S1',
    '--latitude',
    '31.2',
    '--longitude',
    '121.5'
  ]);

  await tool.execute(
    { action: 'emulator', op: 'sensor', emulator: 'S1', sensor: 'steps=42,light-intensity=500' },
    exec(cwd)
  );
  assert.deepEqual(run.calls[3].args, [
    'emulator',
    'sensor',
    '--target',
    'S1',
    '--steps',
    '42',
    '--light-intensity',
    '500'
  ]);
});

test('hilog follow runs as a background job and keeps filters', async () => {
  const cwd = await workspace();
  const starts = [];
  const background = {
    start: async (command, args, _cwd, _logFile) => {
      starts.push({ command, args: [...args] });
      return 4242;
    },
    alive: () => true
  };
  const tool = createDevecoTool(resolveOptions({}), undefined, async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }), background);
  const result = await tool.execute(
    { action: 'log', op: 'hilog', follow: true, keyword: 'Fail', device: 'S1' },
    exec(cwd)
  );
  assert.equal(result.ok, true, readFailure(result));
  assert.equal(starts.length, 1);
  assert.ok(starts[0].args.includes('--follow'));
  assert.ok(starts[0].args.includes('--keyword'));
  assert.ok(starts[0].args.includes('Fail'));
  assert.match(result.summary, /后台/);
});
