// 0.9.0 standalone CLI: doctor / review / bridge / fault bench.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { benchmark, bridge, doctor, review } from '../bin/dwguard.mjs';

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-cli-'));
  dirs.push(dir);
  await mkdir(join(dir, '.shared', 'tasks'), { recursive: true });
  await mkdir(join(dir, '.shared', 'artifacts'), { recursive: true });
  await writeFile(
    join(dir, '.shared', 'tasks', 'spec.json'),
    `${JSON.stringify({ schemaVersion: 1, specVersion: 3, title: 'cli', criteria: [] }, null, 2)}\n`
  );
  return dir;
}

test('doctor reports project/shared/device checks without inventing a device', async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, 'entry'), { recursive: true });
  await mkdir(join(cwd, 'AppScope'), { recursive: true });
  await writeFile(join(cwd, 'build-profile.json5'), '{}\n');
  const report = await doctor(cwd, {});
  assert.equal(report.command, 'doctor');
  assert.ok(report.checks.some((check) => check.id === 'project' && check.status === 'ok'));
  assert.ok(report.checks.some((check) => check.id === 'shared' && check.status === 'ok'));
  assert.ok(report.checks.some((check) => check.id === 'device'));
});

test('review verifies hashes and rejects a corrupted bundle', async () => {
  const cwd = await workspace();
  const artifact = join(cwd, '.shared', 'artifacts', 'audit-1');
  await mkdir(join(artifact, 'evidence'), { recursive: true });
  await writeFile(join(artifact, 'evidence', '000001-abc.png'), 'evidence-bytes');
  await writeFile(join(cwd, '.shared', 'artifacts', 'acceptance-report.md'), '# accepted\n');
  const checks = [{ criterionId: 'F-01', result: 'pass', evidence: '截图', evidenceFiles: ['artifacts/shot.png'] }];
  await writeFile(
    join(cwd, '.shared', 'artifacts', 'audit-1.json'),
    `${JSON.stringify({ schemaVersion: 1, id: 1, specVersion: 3, gate: { pass: true }, checks }, null, 2)}\n`
  );
  const manifest = {
    schemaVersion: 1,
    auditId: 1,
    specVersion: 3,
    generatedAt: new Date().toISOString(),
    files: [
      {
        criterionId: 'F-01',
        path: 'artifacts/shot.png',
        storedAs: 'evidence/000001-abc.png',
        sha256: 'bad-hash',
        bytes: 14
      }
    ],
    checks
  };
  await writeFile(join(artifact, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await review(cwd, {});
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /sha256 mismatch/);
});

test('bridge consumes only new deliveries and queues a review task', async () => {
  const cwd = await workspace();
  const entry = '## [2026-11-09T00:00:00.000Z] deliver · #a-1 · from=deveco to=dsh · re=#d-1 | 交付\n\n构建通过\n';
  await writeFile(join(cwd, '.shared', 'outbox-deveco.md'), `# DevEco → DSH\n\n${entry}`);
  const first = await bridge(cwd, { once: true });
  assert.equal(first.newEntries.length, 1);
  const queue = JSON.parse(await readFile(join(cwd, '.shared', 'harness', 'queue.json'), 'utf8'));
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].step, 'delivery-review');
  const second = await bridge(cwd, { once: true });
  assert.equal(second.newEntries.length, 0);
});

test('fault benchmark records review/doctor/bridge fault cases', async () => {
  const cwd = await workspace();
  const result = await benchmark(cwd, { faults: true });
  assert.equal(result.command, 'bench');
  assert.equal(result.cases.length, 5);
  assert.ok(result.cases.every((item) => item.status === 'pass'), JSON.stringify(result.cases));
});
