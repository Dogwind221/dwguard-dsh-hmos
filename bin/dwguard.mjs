#!/usr/bin/env node
/**
 * DwGuard-HMOS standalone CLI (0.9.0).
 *
 * Commands:
 *   doctor   environment/project/device readiness
 *   review   independently verify an audit evidence bundle
 *   bridge   ingest DevEco outbox deliveries into the DSH/harness queue
 *   bench    fault-injection baseline + device smoke benchmark
 *   quickstart  scaffold and build a 10-minute HarmonyOS sample project
 *
 * The CLI intentionally uses only Node built-ins and never edits the target
 * app's `entry/` or `AppScope/` source.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const SAFE_ARG = /^[^\r\n&|<>^%!`"]*$/;

function shellArg(value) {
  if (process.platform !== 'win32') return value;
  return /[\s]/.test(value) ? `"${value}"` : value;
}

function parseArgs(argv) {
  const args = { workspace: process.cwd(), json: false, once: false, interval: 2, faults: false, device: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--workspace') { args.workspace = value; index += 1; }
    else if (key === '--json') args.json = true;
    else if (key === '--once') args.once = true;
    else if (key === '--interval') { args.interval = Number(value); index += 1; }
    else if (key === '--faults') args.faults = true;
    else if (key === '--device') args.device = true;
    else if (key === '--require-device') args.requireDevice = true;
    else if (key === '--require-physical') args.requirePhysical = true;
    else if (key === '--audit') { args.audit = Number(value); index += 1; }
    else if (key === '--dir') { args.dir = value; index += 1; }
    else if (key === '--api') { args.api = value; index += 1; }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

function run(command, args, options = {}) {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) throw new Error(`unsafe command argument: ${arg}`);
  }
  const result = spawnSync(command, process.platform === 'win32' ? args.map(shellArg) : args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    shell: process.platform === 'win32',
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  return {
    code: result.status ?? (result.error === undefined ? -1 : -1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? '')
  };
}

async function sha256(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function extractJsonText(text) {
  const first = text.search(/[[{]/);
  if (first < 0) return null;
  const closer = text[first] === '[' ? ']' : '}';
  const last = text.lastIndexOf(closer);
  if (last <= first) return null;
  const candidate = text.slice(first, last + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function workspacePaths(workspace) {
  const root = resolve(workspace);
  const shared = join(root, '.shared');
  return {
    root,
    shared,
    spec: join(shared, 'tasks', 'spec.json'),
    artifacts: join(shared, 'artifacts'),
    outboxDeveco: join(shared, 'outbox-deveco.md'),
    queue: join(shared, 'harness', 'queue.json'),
    bridgeState: join(shared, 'bridge', 'state.json'),
    bridgeEvents: join(shared, 'bridge', 'events.jsonl')
  };
}

async function atomicWrite(file, content) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
}

function activeDevices(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('-'))
    .map((line) => line.split(/\s{2,}/))
    .filter((parts) => parts.length >= 4 && /^(emulator|real)$/i.test(parts[2]))
    .map((parts) => ({ name: parts[0], serial: parts[1], kind: parts[2].toLowerCase(), type: parts[3] }));
}

function add(report, id, status, detail) {
  report.checks.push({ id, status, detail });
  if (status === 'fail') report.ok = false;
  if (status === 'blocked') report.blocked = true;
}

export async function doctor(workspace, options = {}) {
  const report = { command: 'doctor', cliVersion: CLI_VERSION, workspace: resolve(workspace), ok: true, blocked: false, checks: [] };
  const major = Number(process.versions.node.split('.')[0]);
  add(report, 'node', major >= 20 ? 'ok' : 'fail', `node ${process.versions.node}`);
  const projectFile = join(workspace, 'build-profile.json5');
  if (existsSync(projectFile) && existsSync(join(workspace, 'entry')) && existsSync(join(workspace, 'AppScope'))) {
    add(report, 'project', 'ok', 'build-profile.json5 + entry + AppScope');
  } else if (existsSync(projectFile)) {
    add(report, 'project', 'warn', 'has build-profile.json5, but entry/ or AppScope/ is missing');
  } else {
    add(report, 'project', 'warn', 'not a HarmonyOS project root (no build-profile.json5)');
  }
  const paths = workspacePaths(workspace);
  add(report, 'shared', existsSync(paths.shared) ? 'ok' : 'warn', paths.shared);
  try {
    const free = statfsSync(workspace).bavail * statfsSync(workspace).bsize;
    add(report, 'disk', free > 1024 ** 3 ? 'ok' : 'warn', `${(free / 1024 ** 3).toFixed(1)} GiB free`);
  } catch {
    add(report, 'disk', 'warn', 'statfs unavailable');
  }
  const cli = run('devecocli', ['--version']);
  add(report, 'devecocli', cli.code === 0 ? 'ok' : 'fail', (cli.stdout || cli.stderr).trim().split('\n')[0] || 'not found');
  const hdc = run('hdc', ['list', 'targets']);
  add(report, 'hdc', hdc.code === 0 ? 'ok' : 'fail', (hdc.stdout || hdc.stderr).trim().split('\n').slice(0, 2).join(' / ') || 'not found');
  const devices = run('devecocli', ['device', 'list']);
  const deviceText = (devices.stdout || devices.stderr).trim();
  const active = activeDevices(deviceText);
  const emulator = active.some((device) => device.kind === 'emulator');
  const physical = active.some((device) => device.kind === 'real');
  add(report, 'device', active.length > 0 ? 'ok' : (options.requireDevice ? 'blocked' : 'warn'), active.length > 0 ? active.map((device) => `${device.name} (${device.kind})`).join(' / ') : 'no active device');
  if (options.requirePhysical && !physical) add(report, 'physical-device', 'blocked', 'no physical HarmonyOS device detected');
  const lockDir = join(paths.shared, '.device-locks');
  const leases = existsSync(lockDir) ? (await readdir(lockDir)).filter((name) => name.endsWith('.json')).length : 0;
  add(report, 'device-locks', leases === 0 ? 'ok' : 'warn', `${leases} active lease file(s)`);
  return report;
}

function parseOutbox(text) {
  const entries = [];
  let current = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      if (current !== null) entries.push(current);
      current = { header: line.slice(3).trim(), body: [] };
    } else if (current !== null) {
      current.body.push(line);
    }
  }
  if (current !== null) entries.push(current);
  return entries.map((entry, index) => {
    const header = entry.header.replace(/^\[[^\]]*\]\s*/, '');
    const match = /^(dispatch|ack|deliver|question|answer|blocked|shadow-risk|rework|inspiration|design-request)\s+·\s+#([\w.-]+)\s+·\s+from=(dsh|deveco)\s+to=(dsh|deveco)(?:\s+·\s+re=#([\w.-]+))?/i.exec(header);
    return {
      index,
      header: entry.header,
      body: entry.body.join('\n').trim(),
      kind: match?.[1]?.toLowerCase(),
      id: match?.[2],
      from: match?.[3],
      to: match?.[4],
      replyTo: match?.[5]
    };
  });
}

export async function review(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const report = { command: 'review', workspace: paths.root, ok: true, auditId: null, errors: [], checks: [] };
  let files;
  try {
    files = await readdir(paths.artifacts);
  } catch {
    report.ok = false;
    report.errors.push('.shared/artifacts does not exist');
    return report;
  }
  const ids = files
    .map((name) => /^audit-(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  const id = Number.isInteger(options.audit) ? options.audit : ids[0];
  if (id === undefined) {
    report.ok = false;
    report.errors.push('no audit-<n>.json found');
    return report;
  }
  report.auditId = id;
  const auditFile = join(paths.artifacts, `audit-${id}.json`);
  const bundle = join(paths.artifacts, `audit-${id}`);
  const manifestFile = join(bundle, 'manifest.json');
  let audit;
  let manifest;
  try {
    audit = JSON.parse(await readFile(auditFile, 'utf8'));
  } catch {
    report.ok = false;
    report.errors.push(`cannot read audit-${id}.json`);
    return report;
  }
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch {
    report.ok = false;
    report.errors.push(`cannot read audit-${id}/manifest.json`);
    return report;
  }
  if (manifest.auditId !== id) report.errors.push(`manifest auditId ${manifest.auditId} !== ${id}`);
  if (audit.specVersion !== manifest.specVersion) report.errors.push(`audit specVersion ${audit.specVersion} !== manifest ${manifest.specVersion}`);
  if (existsSync(paths.spec)) {
    try {
      const spec = JSON.parse(await readFile(paths.spec, 'utf8'));
      if (spec.specVersion !== audit.specVersion) report.errors.push(`current spec v${spec.specVersion} !== audit v${audit.specVersion}`);
    } catch {
      report.errors.push('cannot read tasks/spec.json');
    }
  }
  const manifestChecks = JSON.stringify(manifest.checks ?? []);
  const auditChecks = JSON.stringify((audit.checks ?? []).map((check) => ({
    criterionId: check.criterionId,
    result: check.result,
    evidence: check.evidence,
    evidenceFiles: check.evidenceFiles ?? []
  })));
  if (manifestChecks !== auditChecks) report.errors.push('manifest.checks does not match audit.checks');
  const seen = new Set();
  for (const entry of manifest.files ?? []) {
    const stored = String(entry.storedAs ?? '');
    if (!stored.startsWith('evidence/') || stored.includes('..')) {
      report.errors.push(`unsafe storedAs: ${stored}`);
      continue;
    }
    const destination = resolve(bundle, stored);
    if (!inside(bundle, destination)) {
      report.errors.push(`storedAs escapes bundle: ${stored}`);
      continue;
    }
    if (seen.has(destination)) report.errors.push(`duplicate storedAs: ${stored}`);
    seen.add(destination);
    const info = await stat(destination).catch(() => null);
    if (info === null) {
      report.errors.push(`missing evidence file: ${stored}`);
      continue;
    }
    if (info.size !== entry.bytes) report.errors.push(`byte mismatch: ${stored} (${info.size} != ${entry.bytes})`);
    const hash = await sha256(destination);
    if (hash !== entry.sha256) report.errors.push(`sha256 mismatch: ${stored}`);
    const source = resolve(paths.shared, String(entry.path ?? ''));
    if (!inside(paths.shared, source)) report.errors.push(`manifest source escapes .shared: ${entry.path}`);
  }
  const pass = audit.gate?.pass === true;
  if (pass && !existsSync(join(paths.artifacts, 'acceptance-report.md'))) report.errors.push('gate passed but acceptance-report.md is missing');
  if (!pass && existsSync(join(paths.artifacts, 'acceptance-report.md'))) report.errors.push('gate failed but a stale acceptance-report.md still exists');
  if (!pass && !existsSync(join(paths.shared, 'tasks', `rework-${id}.md`))) report.errors.push('gate failed but rework order is missing');
  report.ok = report.errors.length === 0;
  return report;
}

function queueId(seed) {
  return `bridge-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

async function enqueueBridgeTasks(paths, events) {
  let queue = { schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: [] };
  try {
    const parsed = JSON.parse(await readFile(paths.queue, 'utf8'));
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.tasks)) queue = parsed;
  } catch {
    /* missing queue */
  }
  const known = new Set(queue.tasks.map((task) => task.id));
  for (const event of events) {
    const id = queueId(`${event.id ?? ''}\u0000${event.header}`);
    if (known.has(id)) continue;
    known.add(id);
    queue.tasks.push({
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      step: 'delivery-review',
      note: `${event.kind ?? 'entry'} ${event.id ?? ''} re=${event.replyTo ?? '-'}`,
      attempts: 0
    });
  }
  await atomicWrite(paths.queue, `${JSON.stringify(queue, null, 2)}\n`);
  return queue.tasks.length;
}

export async function checker(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const report = {
    command: 'checker',
    workspace: paths.root,
    ok: true,
    auditId: null,
    notes: [],
    coverage: { required: 0, satisfied: 0, missing: [] }
  };
  let spec;
  let audit;
  try {
    spec = JSON.parse(await readFile(paths.spec, 'utf8'));
    const files = await readdir(paths.artifacts);
    const ids = files
      .map((name) => /^audit-(\d+)\.json$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => b - a);
    const id = Number.isInteger(options.audit) ? options.audit : ids[0];
    if (id === undefined) throw new Error('no audit-<n>.json found');
    report.auditId = id;
    audit = JSON.parse(await readFile(join(paths.artifacts, `audit-${id}.json`), 'utf8'));
  } catch (error) {
    report.ok = false;
    report.notes.push({ severity: 'warn', message: error instanceof Error ? error.message : String(error) });
    return report;
  }
  const checks = Array.isArray(audit.checks) ? audit.checks : [];
  for (const criterion of spec.criteria ?? []) {
    const required = Array.isArray(criterion.requiredEvidence) ? criterion.requiredEvidence : [];
    if (required.length === 0) continue;
    const own = checks.filter((check) => check.criterionId === criterion.id);
    const supplied = new Set(own.flatMap((check) => (check.evidenceRefs ?? []).map((ref) => ref.kind)));
    for (const kind of required) {
      report.coverage.required += 1;
      if (supplied.has(kind)) {
        report.coverage.satisfied += 1;
      } else {
        report.coverage.missing.push({ criterionId: criterion.id, kind });
        report.notes.push({
          severity: 'warn',
          criterionId: criterion.id,
          message: `缺少 requiredEvidence: ${kind}`
        });
      }
    }
    for (const check of own) {
      for (const ref of check.evidenceRefs ?? []) {
        if (!(check.evidenceFiles ?? []).includes(ref.path)) {
          report.notes.push({
            severity: 'warn',
            criterionId: criterion.id,
            message: `evidenceRefs 路径 ${ref.path} 未列入 evidenceFiles，不会进入证据包`
          });
        }
      }
    }
  }
  return report;
}

export async function bridge(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const report = { command: 'bridge', workspace: paths.root, newEntries: [], processed: 0, ok: true };
  let text = '';
  try {
    text = await readFile(paths.outboxDeveco, 'utf8');
  } catch {
    return report;
  }
  const entries = parseOutbox(text);
  let state = { schemaVersion: 1, processed: 0 };
  try {
    const parsed = JSON.parse(await readFile(paths.bridgeState, 'utf8'));
    if (parsed?.schemaVersion === 1 && Number.isInteger(parsed.processed)) state = parsed;
  } catch {
    /* fresh */
  }
  if (state.processed > entries.length) state.processed = 0;
  const fresh = entries.slice(state.processed);
  report.processed = entries.length;
  if (fresh.length > 0) {
    const events = fresh.map((entry) => ({
      at: new Date().toISOString(),
      kind: entry.kind,
      id: entry.id,
      from: entry.from,
      to: entry.to,
      replyTo: entry.replyTo,
      header: entry.header,
      body: entry.body
    }));
    report.newEntries = events;
    await mkdir(dirname(paths.bridgeEvents), { recursive: true });
    await writeFile(paths.bridgeEvents, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { flag: 'a' });
    await enqueueBridgeTasks(paths, events);
    state = { schemaVersion: 1, processed: entries.length, updatedAt: new Date().toISOString() };
    await atomicWrite(paths.bridgeState, `${JSON.stringify(state, null, 2)}\n`);
  }
  return report;
}

async function faultBench(workspace) {
  const cases = [];
  const temp = join(workspace, '.shared', 'bench', `fault-${Date.now()}`);
  await mkdir(temp, { recursive: true });
  const runCase = async (name, work) => {
    const started = Date.now();
    try {
      await work();
      cases.push({ name, status: 'pass', durationMs: Date.now() - started });
    } catch (error) {
      cases.push({ name, status: 'fail', durationMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  await runCase('review rejects missing audit', async () => {
    const result = await review(join(temp, 'empty'), {});
    if (result.ok) throw new Error('review accepted missing audit');
  });
  await runCase('review rejects tampered evidence hash', async () => {
    const tampered = join(temp, 'tampered');
    const artifact = join(tampered, '.shared', 'artifacts', 'audit-1');
    await mkdir(join(artifact, 'evidence'), { recursive: true });
    await mkdir(join(tampered, '.shared', 'tasks'), { recursive: true });
    await writeFile(join(tampered, '.shared', 'tasks', 'spec.json'), '{"schemaVersion":1,"specVersion":1}\n');
    await writeFile(join(tampered, '.shared', 'artifacts', 'acceptance-report.md'), '# ok\n');
    await writeFile(join(artifact, 'evidence', '000001-x.png'), 'x');
    await writeFile(
      join(tampered, '.shared', 'artifacts', 'audit-1.json'),
      JSON.stringify({ id: 1, specVersion: 1, gate: { pass: true }, checks: [] })
    );
    await writeFile(
      join(artifact, 'manifest.json'),
      JSON.stringify({
        auditId: 1,
        specVersion: 1,
        files: [{ criterionId: 'F-01', path: 'artifacts/a.png', storedAs: 'evidence/000001-x.png', sha256: 'bad', bytes: 1 }],
        checks: []
      })
    );
    const result = await review(tampered, {});
    if (result.ok) throw new Error('review accepted a bad hash');
  });
  await runCase('doctor flags missing project', async () => {
    const result = await doctor(temp, {});
    if (!result.checks.some((check) => check.status === 'warn' || check.status === 'fail')) throw new Error('doctor did not flag missing project');
  });
  await runCase('bridge tolerates missing outbox', async () => {
    const result = await bridge(temp, {});
    if (!result.ok) throw new Error('bridge failed');
  });
  await runCase('bridge is idempotent for one delivery', async () => {
    const idem = join(temp, 'bridge-idem');
    await mkdir(join(idem, '.shared'), { recursive: true });
    await writeFile(join(idem, '.shared', 'outbox-deveco.md'), '## [t] deliver · #a-1 · from=deveco to=dsh · re=#d-1 | 交付\n');
    const first = await bridge(idem, {});
    const second = await bridge(idem, {});
    if (first.newEntries.length !== 1 || second.newEntries.length !== 0) throw new Error('bridge cursor is not idempotent');
  });
  const summary = join(workspace, '.shared', 'bench', `faults-${Date.now()}.json`);
  await atomicWrite(summary, `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`);
  return cases;
}

async function deviceBench(workspace, options) {
  const result = { command: 'bench-device', workspace, ok: false, blocked: false, checks: [], output: '' };
  const devices = run('devecocli', ['device', 'list']);
  const text = (devices.stdout || devices.stderr).trim();
  const active = activeDevices(text);
  if (active.length === 0) {
    result.blocked = true;
    result.checks.push({ id: 'device', status: 'blocked', detail: 'no active HarmonyOS device' });
    return result;
  }
  const emulator = active.some((device) => device.kind === 'emulator');
  const physical = active.some((device) => device.kind === 'real');
  if (options.requirePhysical && !physical) {
    result.blocked = true;
    result.checks.push({ id: 'physical-device', status: 'blocked', detail: emulator ? 'only an emulator is active' : 'no physical device' });
    return result;
  }
  result.checks.push({ id: 'device', status: 'ok', detail: active.map((device) => `${device.name} (${device.kind})`).join(' / ') });
  const serial = active[0].serial;
  const env = run('devecocli', ['--version']);
  result.checks.push({ id: 'env', status: env.code === 0 ? 'ok' : 'fail', detail: (env.stdout || env.stderr).slice(0, 300) });
  if (existsSync(join(workspace, 'build-profile.json5'))) {
    const build = run('devecocli', ['build'], { cwd: workspace, timeout: 300_000 });
    result.checks.push({ id: 'build', status: build.code === 0 ? 'ok' : 'fail', detail: (build.stdout || build.stderr).slice(-600) });
  } else {
    result.checks.push({ id: 'build', status: 'warn', detail: 'no build-profile.json5; skipped build' });
  }
  if (serial !== undefined) {
    const dir = join(workspace, 'artifacts', 'bench', `device-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const shot = join(dir, 'shot.png');
    const screenshot = run('devecocli', ['ui', 'screenshot', '--path', shot, '--device', serial], { timeout: 120_000 });
    const header = await readFile(shot).then((data) => data.subarray(0, 8)).catch(() => null);
    const validImage = header !== null && (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
    result.checks.push({
      id: 'screenshot',
      status: screenshot.code === 0 && validImage ? 'ok' : 'fail',
      detail: validImage ? shot : `exit ${screenshot.code}; ${(screenshot.stderr || '').slice(0, 200)}`
    });
    const layout = run('devecocli', ['ui', 'layout', '--format', 'json', '--mode', 'full', '--device', serial], { timeout: 120_000 });
    let layoutOk = false;
    if (layout.code === 0) {
      const json = extractJsonText(layout.stdout);
      if (json !== null) {
        await atomicWrite(join(dir, 'layout.json'), `${json}\n`);
        layoutOk = true;
      }
    }
    result.checks.push({ id: 'layout', status: layoutOk ? 'ok' : 'fail', detail: layoutOk ? join(dir, 'layout.json') : `exit ${layout.code}` });
    result.output = join(dir, 'result.json');
  } else {
    result.checks.push({ id: 'screenshot', status: 'warn', detail: 'could not parse device serial' });
    result.output = join(workspace, 'artifacts', 'bench', `device-${Date.now()}.json`);
  }
  result.ok = result.checks.every((check) => check.status !== 'fail' && check.status !== 'blocked');
  await atomicWrite(result.output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function benchmark(workspace, options = {}) {
  const report = { command: 'bench', workspace, cases: [], device: null, ok: true, blocked: false };
  if (options.faults) {
    report.cases = await faultBench(workspace);
    if (report.cases.some((item) => item.status === 'fail')) report.ok = false;
  }
  if (options.device) {
    report.device = await deviceBench(workspace, options);
    if (report.device.blocked) {
      report.ok = false;
      report.blocked = true;
    } else if (!report.device.ok) report.ok = false;
  }
  return report;
}

export async function quickstart(options = {}) {
  const target = resolve(options.dir ?? join(process.cwd(), 'dwguard-quickstart'));
  if (existsSync(target)) throw new Error(`target already exists: ${target}`);
  if (options.api !== undefined && !/^\d+$/.test(String(options.api))) throw new Error('--api must be numeric');
  const args = ['create', '--project-path', target, '--app-name', 'DwGuardQuickstart', '--bundle-name', 'com.example.dwguardquickstart', '--device-types', 'phone'];
  if (options.api !== undefined) args.push('--api-level', String(options.api));
  const create = run('devecocli', args, { timeout: 120_000 });
  if (create.code !== 0) throw new Error(`devecocli create failed: ${create.stderr || create.stdout}`);
  const build = run('devecocli', ['build'], { cwd: target, timeout: 300_000 });
  return {
    command: 'quickstart',
    project: target,
    created: true,
    build: { ok: build.code === 0, detail: (build.stdout || build.stderr).slice(-800) },
    next: [
      `打开 DSH，把会话工作目录切到 ${target}`,
      '描述需求并让 DSH 调用 dwguard_spec / dwguard_prereview / dwguard_dispatch',
      '用 dwguard_deveco 或 devecocli 完成 build/sign/run/screenshot/layout',
      '用独立复核 CLI: node bin/dwguard.mjs review --workspace ' + target
    ]
  };
}

function print(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (report.checks !== undefined) {
    for (const check of report.checks) console.log(`[${check.status}] ${check.id}: ${check.detail}`);
  }
  if (report.errors !== undefined) {
    for (const error of report.errors) console.log(`[error] ${error}`);
  }
  if (report.cases !== undefined) {
    for (const item of report.cases) console.log(`[${item.status}] ${item.name} (${item.durationMs}ms)`);
  }
  if (report.device !== null && report.device !== undefined) {
    for (const check of report.device.checks ?? []) console.log(`[${check.status}] device.${check.id}: ${check.detail}`);
  }
  if (report.newEntries !== undefined) console.log(`new entries: ${report.newEntries.length}`);
  if (report.project !== undefined) {
    console.log(`project: ${report.project}`);
    console.log(`build: ${report.build?.ok ? 'ok' : 'failed'}`);
    for (const line of report.next ?? []) console.log(`- ${line}`);
  }
  if (report.notes !== undefined) {
    for (const note of report.notes) console.log(`[${note.severity}]${note.criterionId ? ` ${note.criterionId}` : ''}: ${note.message}`);
    if (report.coverage !== undefined) console.log(`evidence coverage: ${report.coverage.satisfied}/${report.coverage.required}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.help ? 'help' : process.argv[2];
  if (command === undefined || command === 'help') {
    console.log('Usage: dwguard <doctor|review|checker|bridge|bench|quickstart> [options]');
    return;
  }
  let report;
  if (command === 'doctor') report = await doctor(args.workspace, args);
  else if (command === 'review') report = await review(args.workspace, args);
  else if (command === 'checker') report = await checker(args.workspace, args);
  else if (command === 'bridge') {
    report = await bridge(args.workspace, args);
    if (!args.once) {
      while (true) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(1, args.interval) * 1000));
        const next = await bridge(args.workspace, args);
        if (next.newEntries.length > 0) print(next, args.json);
      }
    }
  } else if (command === 'bench') report = await benchmark(args.workspace, args);
  else if (command === 'quickstart') report = await quickstart(args);
  else throw new Error(`unknown command: ${command}`);
  print(report, args.json);
  if (report.ok === false) process.exitCode = report.blocked ? 2 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
