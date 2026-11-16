// P1 concurrency stress: the local locks must not lose updates or hand out
// the same id / queue task twice.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-stress-home-'));
import { resolvePaths } from '../lib/paths.js';
import { nextIndex, readState, updateState } from '../lib/state.js';
import { claimHarnessTask, enqueueHarnessTask } from '../lib/harness.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const now = '2026-11-16T00:00:00.000Z';

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-stress-'));
  dirs.push(dir);
  return dir;
}

test('64 concurrent state updates keep every increment and one revision each', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await updateState(paths, now, (state) => ({ ...state, audits: 0 }));
  await Promise.all(
    Array.from({ length: 64 }, () =>
      updateState(paths, now, (state) => ({ ...state, audits: state.audits + 1 }))
    )
  );
  const state = await readState(paths, now);
  assert.equal(state.audits, 64);
  assert.equal(state.revision, 65);
});

test('64 concurrent index reservations are unique and contiguous', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  await mkdir(paths.artifactsDir, { recursive: true });
  const ids = await Promise.all(Array.from({ length: 64 }, () => nextIndex(paths.artifactsDir, 'audit')));
  assert.equal(new Set(ids).size, 64);
  assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index + 1));
});

test('24 concurrent queue claims never return the same task', async () => {
  const cwd = await workspace();
  const paths = resolvePaths(cwd, '.shared');
  for (let index = 0; index < 24; index += 1) {
    await enqueueHarnessTask(paths, now, { step: 'delivery-review', note: `task-${index}` });
  }
  const claims = await Promise.all(
    Array.from({ length: 24 }, () => claimHarnessTask(paths, now, 'stress', 300))
  );
  const tasks = claims.map((claim) => claim.task).filter(Boolean);
  assert.equal(tasks.length, 24);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 24);
});
