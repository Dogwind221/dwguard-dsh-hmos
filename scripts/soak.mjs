#!/usr/bin/env node
/**
 * Repeatable soak runner (0.8.7).
 *
 * Runs the whole test suite N times with an isolated DSH_HOME per round and
 * writes a machine-readable summary. It is intentionally sequential so a
 * flaky/failing round is attributable to the same code under test.
 *
 * Usage: node scripts/soak.mjs [--rounds 100] [--files tests/*.test.mjs]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_CAPTURE = 2 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const args = { rounds: 100, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--rounds') {
      args.rounds = Number(value);
      index += 1;
    } else if (key === '--files') {
      args.files = value.split(',').map((item) => resolve(ROOT, item.trim())).filter(Boolean);
      index += 1;
    } else if (key === '--help' || key === '-h') {
      console.log('Usage: node scripts/soak.mjs [--rounds 100] [--files tests/a.test.mjs,tests/b.test.mjs]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(args.rounds) || args.rounds < 1 || args.rounds > 1000) {
    console.error('--rounds must be an integer 1..1000');
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const testFiles = args.files.length > 0
  ? args.files
  : (await readdir(join(ROOT, 'tests')))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => join(ROOT, 'tests', name));

const outDir = join(ROOT, 'artifacts', 'soak');
await mkdir(outDir, { recursive: true });
const summaryPath = join(outDir, 'summary.json');
const startedAt = new Date().toISOString();
const summary = {
  schemaVersion: 1,
  command: `${process.execPath} --test <${testFiles.length} files>`,
  startedAt,
  finishedAt: '',
  rounds: args.rounds,
  passed: 0,
  failed: 0,
  failures: []
};

async function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('close', resolvePromise);
      killer.on('error', resolvePromise);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function runRound(round, dshHome) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', ...testFiles], {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      void killTree(child.pid);
      finish('timeout');
    }, TIMEOUT_MS);
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ reason, code: child.exitCode, stdout, stderr, durationMs: Date.now() - started });
    };
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CAPTURE) {
        void killTree(child.pid);
        finish('output-overflow');
        return target;
      }
      return target + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.on('error', (error) => {
      stderr += `\n[spawn] ${error.message}`;
      finish('spawn-error');
    });
    child.on('close', (code) => {
      finish(code === 0 ? 'ok' : 'test-failed');
    });
  });
}

for (let round = 1; round <= args.rounds; round += 1) {
  const dshHome = await mkdtemp(join(tmpdir(), 'dwguard-soak-home-'));
  const result = await runRound(round, dshHome);
  await rm(dshHome, { recursive: true, force: true });
  const passed = result.reason === 'ok';
  if (passed) summary.passed += 1;
  else summary.failed += 1;
  const passMatch = /ℹ pass (\d+)/.exec(result.stdout);
  const failMatch = /ℹ fail (\d+)/.exec(result.stdout);
  const record = {
    round,
    status: result.reason,
    exitCode: result.code,
    durationMs: result.durationMs,
    testsPassed: passMatch === null ? null : Number(passMatch[1]),
    testsFailed: failMatch === null ? null : Number(failMatch[1])
  };
  if (!passed) {
    record.log = `artifacts/soak/round-${String(round).padStart(3, '0')}.log`;
    await writeFile(
      join(ROOT, record.log),
      `${result.stdout}\n[stderr]\n${result.stderr}\n`,
      'utf8'
    );
    summary.failures.push(record);
  }
  summary.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  const status = passed ? 'PASS' : 'FAIL';
  console.log(
    `round ${String(round).padStart(3, '0')}/${args.rounds} ${status} ` +
      `${result.durationMs}ms tests=${record.testsPassed ?? '?'}/${record.testsFailed ?? '?'}`
  );
}

console.log(`soak summary: ${summaryPath}`);
if (summary.failed > 0) process.exit(1);
