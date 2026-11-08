// 0.8.5 security regressions: pack path traversal and evidence name collisions.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-security-home-'));

import { importDesignPack } from '../lib/design.js';
import { writeEvidenceBundle } from '../lib/evidence.js';
import { resolvePaths } from '../lib/paths.js';
import { parseActualInput } from '../lib/actual.js';
import { resolveDevicePolicy } from '../lib/device.js';
import { withCommandIdempotency } from '../lib/idempotency.js';
import { recordDimension, readAuditProgress } from '../lib/progress.js';
import { resolveOptions } from '../lib/config.js';
import { nextIndex, readState, updateState } from '../lib/state.js';
import { gateDelivery, normalizeChecks } from '../lib/review.js';
import { registerBoardRoute } from '../lib/web.js';
import { rememberWorkspace } from '../lib/workspaces.js';
import { readObservation, recordObservation } from '../lib/observation.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-security-'));
  dirs.push(dir);
  return dir;
}

const now = '2026-11-08T00:00:00.000Z';

test('P0-4: pack name inside pack.json must match the requested directory', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  const root = join(cwd, 'packs');
  const safe = join(root, 'safe');
  await mkdir(safe, { recursive: true });
  await writeFile(
    join(safe, 'pack.json'),
    JSON.stringify({ schemaVersion: 1, name: '..', createdAt: now, engineVersion: 'x', cards: [] }),
    'utf8'
  );
  await assert.rejects(
    () => importDesignPack(paths, root, 'safe', now),
    /不存在或格式不正确/
  );
});

test('P0-4: image path cannot escape the pack directory', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  const root = join(cwd, 'packs');
  const safe = join(root, 'safe');
  await mkdir(join(safe, 'cards'), { recursive: true });
  await writeFile(join(cwd, 'secret.png'), 'outside', 'utf8');
  await writeFile(
    join(safe, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'safe',
      createdAt: now,
      engineVersion: 'x',
      cards: [
        {
          id: 'DSG-0001',
          title: 'escape',
          source: { kind: 'project' },
          tokens: [],
          rationale: 'probe',
          dos: [],
          donts: [],
          style: [],
          antiPatterns: [],
          checklist: [],
          images: [{ path: '../../secret.png' }],
          status: 'active',
          weight: 1,
          createdAt: now,
          updatedAt: now
        }
      ]
    }),
    'utf8'
  );
  await assert.rejects(
    () => importDesignPack(paths, root, 'safe', now),
    /越界/
  );
  await assert.rejects(readFile(join(paths.designManifest), 'utf8'));
});

test('P0-5: evidence names are collision-free and hashes match stored bytes', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await mkdir(join(paths.artifactsDir, 'a'), { recursive: true });
  await writeFile(join(paths.artifactsDir, 'a', 'b.png'), 'first-bytes', 'utf8');
  await writeFile(join(paths.artifactsDir, 'a__b.png'), 'second-bytes', 'utf8');

  const checks = [
    {
      criterionId: 'F-01',
      result: 'pass',
      evidence: '两张不同来源的截图',
      evidenceFiles: ['artifacts/a/b.png', 'artifacts/a__b.png']
    }
  ];
  const manifest = await writeEvidenceBundle(paths, 1, 1, checks, now);
  assert.equal(manifest.files.length, 2);
  assert.notEqual(manifest.files[0].storedAs, manifest.files[1].storedAs);
  for (const entry of manifest.files) {
    const bytes = await readFile(join(paths.artifactsDir, 'audit-1', entry.storedAs));
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
  }
});

const strictPack = {
  schemaVersion: 1,
  title: 'strict',
  requirement: 'must+pass 必须有结构化证据',
  spec: '测试闸门',
  constraints: [],
  criteria: [
    { id: 'F-01', dimension: 'function', statement: '功能', verify: '截图', weight: 'must' },
    { id: 'A-01', dimension: 'aesthetic', statement: '审美', verify: '布局树', weight: 'must' },
    { id: 'P-01', dimension: 'performance', statement: '首帧 ≤ 800ms', verify: 'Profiler', weight: 'must', assertion: { matcher: 'lte', expected: 800, unit: 'ms' } },
    { id: 'X-01', dimension: 'accessibility', statement: '对比度', verify: '截图', weight: 'must' }
  ],
  iteration: 1,
  specVersion: 1,
  createdAt: now,
  updatedAt: now
};

function strictChecks(extra = []) {
  return [
    { criterionId: 'F-01', result: 'pass', evidence: '功能截图', evidenceFiles: ['artifacts/f.png'] },
    { criterionId: 'A-01', result: 'pass', evidence: '布局树快照', evidenceFiles: ['artifacts/a.json'] },
    { criterionId: 'P-01', result: 'pass', evidence: 'Profiler 测量', evidenceFiles: ['artifacts/p.json'], actual: { value: 720, unit: 'ms' } },
    { criterionId: 'X-01', result: 'pass', evidence: '对比度截图', evidenceFiles: ['artifacts/x.png'] },
    ...extra
  ];
}

test('P0-1: strict mode rejects text-only must+pass and self-reported evidence', () => {
  const textOnly = normalizeChecks(
    ['F-01', 'A-01', 'P-01', 'X-01'].map((id) => ({
      criterionId: id,
      result: 'pass',
      evidence: `artifacts/${id}.png 已看`,
      actual: id === 'P-01' ? { value: 720, unit: 'ms' } : undefined
    }))
  );
  const textGate = gateDelivery(strictPack, textOnly, [], undefined, undefined, undefined, true);
  assert.equal(textGate.pass, false);
  assert.match(textGate.errors.join('\n'), /结构化证据/);

  const selfReported = strictChecks().map((check) => ({ ...check, evidence: '执行者自测通过，截图见附件' }));
  const selfGate = gateDelivery(strictPack, normalizeChecks(selfReported), [], undefined, undefined, undefined, true);
  assert.equal(selfGate.pass, false);
  assert.match(selfGate.errors.join('\n'), /自述/);
});

test('P0-1: structured actual enforces unit and sample aggregation', () => {
  const good = gateDelivery(strictPack, normalizeChecks(strictChecks()), [], undefined, undefined, undefined, true);
  assert.equal(good.pass, true, good.errors.join('\n'));

  const wrongUnit = strictChecks().map((check) =>
    check.criterionId === 'P-01' ? { ...check, actual: { value: 0.72, unit: 's' } } : check
  );
  const unitGate = gateDelivery(strictPack, normalizeChecks(wrongUnit), [], undefined, undefined, undefined, true);
  assert.equal(unitGate.pass, false);
  assert.match(unitGate.errors.join('\n'), /单位/);

  assert.throws(() => parseActualInput({ value: 1, samples: [1, 2, 3] }), /aggregation/);
  assert.equal(parseActualInput({ value: 1, samples: [1, 2, 3], aggregation: 'p95', unit: 'ms' }).actual, '3ms');
});

test('P0-1: matrix device must belong to the pool and match its family', () => {
  const policy = resolveDevicePolicy({
    hostMemoryGb: 32,
    devicePool: [{ sn: 'em-phone', family: 'phone', apiLevel: 24, kind: 'emulator' }]
  });
  const checks = normalizeChecks(
    ['F-01', 'A-01', 'P-01', 'X-01'].map((id) => ({
      criterionId: id,
      result: 'pass',
      evidence: '截图',
      evidenceFiles: ['artifacts/x.png'],
      device: 'unknown-device',
      family: 'phone',
      ...(id === 'P-01' ? { actual: { value: 720, unit: 'ms' } } : {})
    }))
  );
  const gate = gateDelivery(strictPack, checks, [], policy, undefined, undefined, true);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /不在 devicePool/);
  assert.match(gate.errors.join('\n'), /observationRef/);
});

test('P0-2: state updates are serialised and revisions increase once per write', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await updateState(paths, now, (state) => ({ ...state, audits: 0 }));
  await Promise.all(
    Array.from({ length: 12 }, () =>
      updateState(paths, now, (state) => ({ ...state, audits: state.audits + 1 }))
    )
  );
  const state = await readState(paths, now);
  assert.equal(state.audits, 12);
  assert.equal(state.revision, 13);
});

test('P0-2: index reservation never hands the same audit/deveco id to two callers', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await mkdir(paths.artifactsDir, { recursive: true });
  const ids = await Promise.all(Array.from({ length: 20 }, () => nextIndex(paths.artifactsDir, 'audit')));
  assert.equal(new Set(ids).size, 20);
  assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
});

test('P0-2: four dimension writes do not lose each other', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await Promise.all([
    recordDimension(paths, 7, 'function', 1, 0, 'f', now),
    recordDimension(paths, 7, 'aesthetic', 1, 0, 'a', now),
    recordDimension(paths, 7, 'performance', 0, 1, 'p', now),
    recordDimension(paths, 7, 'accessibility', 1, 0, 'x', now)
  ]);
  const progress = await readAuditProgress(paths);
  assert.equal(progress?.specVersion, 7);
  assert.deepEqual(Object.keys(progress?.dims ?? {}).sort(), ['accessibility', 'aesthetic', 'function', 'performance']);
  assert.equal(progress?.dims.performance?.state, 'failed');
});

test('P0-4: preview path cannot escape the pack directory', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  const root = join(cwd, 'packs');
  const safe = join(root, 'safe');
  await mkdir(safe, { recursive: true });
  await writeFile(join(cwd, 'outside.html'), '<html></html>', 'utf8');
  await writeFile(
    join(safe, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'safe',
      createdAt: now,
      engineVersion: 'x',
      preview: '../../outside.html',
      cards: []
    }),
    'utf8'
  );
  await assert.rejects(() => importDesignPack(paths, root, 'safe', now), /越界/);
});

test('P0-1: collector observationRef is structured and readable', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await mkdir(paths.artifactsDir, { recursive: true });
  const shot = join(paths.artifactsDir, 'shot.png');
  await writeFile(shot, 'png-bytes', 'utf8');
  const id = await recordObservation(paths, { action: 'screenshot', device: 'SN-1', specVersion: 3, files: [shot] }, now);
  assert.match(id, /^obs-[a-f0-9]{12}$/);
  const observation = await readObservation(paths, id);
  assert.equal(observation?.device, 'SN-1');
  assert.equal(observation?.specVersion, 3);
  assert.equal(observation?.files[0].path, shot);
});

test('P0-6: board route is loopback/token gated and only accepts registered workspaces', async () => {
  const cwd = await workspace();
  const other = await workspace();
  await rememberWorkspace(cwd, now);
  let handler;
  const ctx = {
    get: () => ({
      register: (route) => {
        handler = route.handler;
        return () => {};
      }
    }),
    effect: () => {},
    logger: {}
  };
  registerBoardRoute(ctx, resolveOptions({ boardToken: '' }));
  assert.equal(typeof handler, 'function');

  const call = async (url, headers = {}, options = {}) => {
    const response = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body ?? '';
      }
    };
    await handler(
      { method: 'GET', url, headers: { host: '127.0.0.1:56100', ...headers } },
      response
    );
    return { status: response.status, body: response.body ? JSON.parse(response.body) : null, ...options };
  };

  assert.equal((await call('/dwguard/board', { host: undefined })).status, 400);
  assert.equal((await call('/dwguard/board', { host: 'evil.example' })).status, 403);
  const ok = await call('/dwguard/board');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.workspaces[0].path, undefined, 'absolute workspace path must not be returned');
  assert.equal(typeof ok.body.workspaces[0].id, 'string');
  assert.equal(ok.body.active, ok.body.workspaces[0].id);
  assert.equal((await call(`/dwguard/board?workspace=${ok.body.workspaces[0].id}`)).status, 200);
  assert.equal((await call('/dwguard/board?workspace=not-registered')).status, 403);
  assert.equal((await call(`/dwguard/board?cwd=${encodeURIComponent(other)}`)).status, 403);
  assert.equal((await call('/dwguard/board', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/dwguard/board', { 'sec-fetch-site': 'cross-site' })).status, 403);

  const tokenCtx = {
    get: () => ({
      register: (route) => {
        handler = route.handler;
        return () => {};
      }
    }),
    effect: () => {},
    logger: {}
  };
  registerBoardRoute(tokenCtx, resolveOptions({ boardToken: 'secret' }));
  assert.equal((await call('/dwguard/board', { host: '10.0.0.5:56100' })).status, 403);
  assert.equal((await call('/dwguard/board', { host: '10.0.0.5:56100', 'x-dwguard-token': 'secret' })).status, 200);
});

test('P0-2: commandId replays the first result instead of repeating side effects', async () => {
  const cwd = await workspace();
  let calls = 0;
  const tool = {
    name: 'probe',
    description: 'probe',
    parameters: {},
    output: { schema: { type: 'object' }, render: (value) => String(value) },
    async execute() {
      calls += 1;
      return { ok: true, summary: `call-${calls}`, detail: '', files: [], next: '' };
    }
  };
  const wrapped = withCommandIdempotency(tool, resolveOptions({ strictEvidence: false }), undefined);
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
  const first = await wrapped.execute({ commandId: 'once' }, exec);
  const second = await wrapped.execute({ commandId: 'once' }, exec);
  assert.equal(calls, 1);
  assert.equal(first.summary, 'call-1');
  assert.equal(second.summary, 'call-1');
});
