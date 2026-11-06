#!/usr/bin/env node
/**
 * Persistent DwGuard harness worker (0.8.0).
 *
 * Polls `.shared/harness/queue.json`, claims one task with a lease, runs a
 * caller-supplied command template, then marks the task done/failed. It is
 * intentionally standalone (no DSH process required) so an OS scheduler
 * (Windows Task Scheduler / cron) can resume work without a human opening a
 * new round.
 *
 * Usage:
 *   node scripts/harness-worker.mjs --workspace <project> --command "dsh ... {prompt}" --once
 *
 * Template variables: {taskId}, {step}, {note}.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const args = { interval: 60, lease: 600, once: false, command: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--workspace') { args.workspace = value; i += 1; }
    else if (key === '--command') { args.command = value; i += 1; }
    else if (key === '--interval') { args.interval = Number(value); i += 1; }
    else if (key === '--lease') { args.lease = Number(value); i += 1; }
    else if (key === '--once') { args.once = true; }
    else if (key === '--help' || key === '-h') {
      console.log('Usage: harness-worker.mjs --workspace <project> [--command "<cmd> {taskId} {step} {note}"] [--interval 60] [--lease 600] [--once]');
      process.exit(0);
    }
  }
  if (!args.workspace) {
    console.error('missing --workspace');
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const workspace = resolve(args.workspace);
const queueFile = join(workspace, '.shared', 'harness', 'queue.json');
const owner = `worker-${process.pid}`;

function readQueue() {
  if (!existsSync(queueFile)) return { schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: [] };
  try {
    const parsed = JSON.parse(readFileSync(queueFile, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed : { schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: [] };
  } catch {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: [] };
  }
}

function writeQueue(queue) {
  queue.updatedAt = new Date().toISOString();
  const temp = `${queueFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  renameSync(temp, queueFile);
}

function claim(queue) {
  const now = Date.now();
  for (const task of queue.tasks) {
    if (task.status === 'leased' && task.lease && Date.parse(task.lease.until) <= now) {
      task.status = 'queued';
      task.lease = undefined;
    }
  }
  const task = queue.tasks.find((item) => item.status === 'queued');
  if (!task) {
    writeQueue(queue);
    return null;
  }
  task.status = 'leased';
  task.attempts = (task.attempts ?? 0) + 1;
  task.lease = { owner, until: new Date(now + Math.max(10, args.lease) * 1000).toISOString() };
  task.updatedAt = new Date().toISOString();
  writeQueue(queue);
  return task;
}

function runCommand(task) {
  return new Promise((resolvePromise) => {
    const rendered = args.command
      .replaceAll('{taskId}', task.id)
      .replaceAll('{step}', task.step)
      .replaceAll('{note}', task.note ?? '');
    const child = spawn(rendered, {
      cwd: workspace,
      shell: true,
      stdio: 'inherit',
      windowsHide: true
    });
    child.on('error', () => resolvePromise(1));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

async function loop() {
  for (;;) {
    const queue = readQueue();
    const task = claim(queue);
    if (!task) {
      if (args.once) return 0;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(5, args.interval) * 1000));
      continue;
    }
    console.log(`[harness-worker] claimed ${task.id} (${task.step})`);
    if (!args.command) {
      const current = readQueue();
      const target = current.tasks.find((item) => item.id === task.id);
      if (target) {
        target.status = 'failed';
        target.lastError = 'worker has no --command';
        target.lease = undefined;
        target.updatedAt = new Date().toISOString();
        writeQueue(current);
      }
      console.error('[harness-worker] no --command; task failed');
      if (args.once) return 1;
      continue;
    }
    const code = await runCommand(task);
    const current = readQueue();
    const target = current.tasks.find((item) => item.id === task.id);
    if (target) {
      target.status = code === 0 ? 'done' : 'failed';
      target.lease = undefined;
      target.updatedAt = new Date().toISOString();
      if (code !== 0) target.lastError = `worker command exit ${code}`;
      writeQueue(current);
    }
    console.log(`[harness-worker] ${task.id} ${code === 0 ? 'done' : 'failed'}`);
    if (args.once) return code === 0 ? 0 : 1;
  }
}

loop().then((code) => process.exit(code)).catch((error) => {
  console.error(`[harness-worker] ${error.message}`);
  process.exit(1);
});
