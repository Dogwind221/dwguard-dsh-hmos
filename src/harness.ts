/**
 * Cross-session run state and recovery primitives (0.8.0).
 *
 * `dwguard_status` derives the phase from artifacts; this module stores the
 * *journal*: checkpoints, attempts, last error and the next action. It is the
 * piece that lets a new session resume instead of re-reading the whole
 * conversation.
 *
 * @module dwguard-dsh-hmos/harness
 */

import { randomUUID } from 'node:crypto';

import type { SharedPaths } from './paths.js';
import { collectSnapshot, type Snapshot } from './status.js';
import { ensureDir, readTextOrNull, writeTextAtomic } from './util/fs.js';

/** Run status exposed by `dwguard_harness`. */
export type HarnessStatus = 'running' | 'blocked' | 'done';

/** One durable checkpoint. */
export interface HarnessCheckpoint {
  readonly id: string;
  readonly at: string;
  readonly phase: string;
  readonly step: string;
  readonly note?: string;
  readonly evidence: readonly string[];
}

/** Attempt counter for one step. */
export interface HarnessAttempt {
  readonly count: number;
  readonly lastAt: string;
  readonly lastError?: string;
}

/** Fallback level chosen for a failed step. */
export interface HarnessFallback {
  readonly step: string;
  readonly level: number;
  readonly chain: readonly string[];
  readonly at: string;
}

/** Durable run journal (`.shared/harness/run.json`). */
export interface HarnessRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly iteration: number;
  readonly specVersion: number;
  readonly phase: string;
  readonly status: HarnessStatus;
  readonly checkpoints: readonly HarnessCheckpoint[];
  readonly attempts: Readonly<Record<string, HarnessAttempt>>;
  readonly lastError?: { readonly step: string; readonly message: string; readonly at: string };
  readonly fallback?: HarnessFallback;
  readonly nextAction: string;
  readonly updatedAt: string;
}

/** Input for a checkpoint. */
export interface HarnessCheckpointInput {
  readonly phase: string;
  readonly step: string;
  readonly note?: string;
  readonly evidence?: readonly string[];
}

/** Result of resuming a run. */
export interface HarnessResumeResult {
  readonly run: HarnessRun;
  readonly stale: boolean;
  readonly nextAction: string;
}

/** Result of a retry decision. */
export interface HarnessRetryResult {
  readonly run: HarnessRun;
  readonly attempt: HarnessAttempt;
  readonly decision: 'retry' | 'human';
  readonly nextAction: string;
}

export const HARNESS_FALLBACK_CHAIN = ['devecocli', 'deveco-mcp', 'hdc+hvigor'] as const;

function emptyRun(snapshot: Snapshot, now: string): HarnessRun {
  return {
    schemaVersion: 1,
    runId: `run-${randomUUID()}`,
    iteration: snapshot.state.iteration,
    specVersion: snapshot.spec?.specVersion ?? snapshot.state.specVersion,
    phase: snapshot.phase,
    status: 'running',
    checkpoints: [],
    attempts: {},
    nextAction: snapshot.nextAction,
    updatedAt: now
  };
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, limit);
}

function normalizeAttempts(raw: unknown): Record<string, HarnessAttempt> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, HarnessAttempt> = {};
  for (const [step, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record['count'] !== 'number' || !Number.isFinite(record['count'])) continue;
    result[step] = {
      count: Math.max(0, Math.trunc(record['count'])),
      lastAt: typeof record['lastAt'] === 'string' ? record['lastAt'] : new Date(0).toISOString(),
      ...(typeof record['lastError'] === 'string' ? { lastError: record['lastError'] } : {})
    };
  }
  return result;
}

/** Read and repair the run journal; a missing file yields a fresh in-memory run. */
export async function readHarnessRun(paths: SharedPaths, snapshot: Snapshot, now: string): Promise<HarnessRun> {
  const raw = await readTextOrNull(paths.harnessRun);
  if (raw === null) return emptyRun(snapshot, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRun(snapshot, now);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyRun(snapshot, now);
  const record = parsed as Record<string, unknown>;
  const base = emptyRun(snapshot, now);
  const checkpoints: HarnessCheckpoint[] = Array.isArray(record['checkpoints'])
    ? record['checkpoints']
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item, index) => ({
          id: typeof item['id'] === 'string' ? item['id'] : `cp-${index + 1}`,
          at: typeof item['at'] === 'string' ? item['at'] : now,
          phase: typeof item['phase'] === 'string' ? item['phase'] : snapshot.phase,
          step: typeof item['step'] === 'string' ? item['step'] : 'unknown',
          ...(typeof item['note'] === 'string' ? { note: item['note'] } : {}),
          evidence: asStringArray(item['evidence'], 32)
        }))
        .slice(-50)
    : [];
  const lastError =
    typeof record['lastError'] === 'object' && record['lastError'] !== null
      ? (record['lastError'] as Record<string, unknown>)
      : undefined;
  const fallback =
    typeof record['fallback'] === 'object' && record['fallback'] !== null
      ? (record['fallback'] as Record<string, unknown>)
      : undefined;
  return {
    schemaVersion: 1,
    runId: typeof record['runId'] === 'string' ? record['runId'] : base.runId,
    iteration: typeof record['iteration'] === 'number' ? Math.trunc(record['iteration']) : base.iteration,
    specVersion: typeof record['specVersion'] === 'number' ? Math.trunc(record['specVersion']) : base.specVersion,
    phase: typeof record['phase'] === 'string' ? record['phase'] : base.phase,
    status:
      record['status'] === 'blocked' || record['status'] === 'done' || record['status'] === 'running'
        ? record['status']
        : 'running',
    checkpoints,
    attempts: normalizeAttempts(record['attempts']),
    ...(lastError === undefined
      ? {}
      : {
          lastError: {
            step: typeof lastError['step'] === 'string' ? lastError['step'] : 'unknown',
            message: typeof lastError['message'] === 'string' ? lastError['message'] : '',
            at: typeof lastError['at'] === 'string' ? lastError['at'] : now
          }
        }),
    ...(fallback === undefined
      ? {}
      : {
          fallback: {
            step: typeof fallback['step'] === 'string' ? fallback['step'] : 'unknown',
            level: typeof fallback['level'] === 'number' ? Math.trunc(fallback['level']) : 1,
            chain: asStringArray(fallback['chain'], 8),
            at: typeof fallback['at'] === 'string' ? fallback['at'] : now
          }
        }),
    nextAction: typeof record['nextAction'] === 'string' ? record['nextAction'] : base.nextAction,
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : now
  };
}

/** Persist the run journal. */
export async function writeHarnessRun(paths: SharedPaths, run: HarnessRun): Promise<void> {
  await ensureDir(paths.harnessDir);
  await writeTextAtomic(paths.harnessRun, `${JSON.stringify(run, null, 2)}\n`);
}

/** Append a checkpoint and keep the run running. */
export async function checkpointHarness(
  paths: SharedPaths,
  snapshot: Snapshot,
  input: HarnessCheckpointInput,
  now: string
): Promise<HarnessRun> {
  const run = await readHarnessRun(paths, snapshot, now);
  const checkpoint: HarnessCheckpoint = {
    id: `cp-${run.checkpoints.length + 1}`,
    at: now,
    phase: input.phase,
    step: input.step,
    ...(input.note === undefined ? {} : { note: input.note }),
    evidence: [...(input.evidence ?? [])].slice(0, 32)
  };
  const next: HarnessRun = {
    ...run,
    iteration: snapshot.state.iteration,
    specVersion: snapshot.spec?.specVersion ?? snapshot.state.specVersion,
    phase: input.phase,
    status: 'running',
    checkpoints: [...run.checkpoints, checkpoint].slice(-50),
    nextAction: snapshot.nextAction,
    updatedAt: now
  };
  await writeHarnessRun(paths, next);
  return next;
}

/** Resume from the latest durable checkpoint; reports stale pack/iteration. */
export async function resumeHarness(
  paths: SharedPaths,
  snapshot: Snapshot,
  now: string
): Promise<HarnessResumeResult> {
  const run = await readHarnessRun(paths, snapshot, now);
  const specVersion = snapshot.spec?.specVersion ?? snapshot.state.specVersion;
  const stale = run.specVersion !== specVersion || run.iteration !== snapshot.state.iteration;
  const nextAction = stale
    ? `run 属于 iteration ${run.iteration}/spec v${run.specVersion}，当前是 iteration ${snapshot.state.iteration}/spec v${specVersion}：重新 spec/prereview，不要沿用旧 checkpoint。`
    : run.status === 'done'
      ? '本轮已标记 done；如需继续，开新一轮。'
      : run.status === 'blocked'
        ? 'run 处于 blocked：先处理 lastError/fallback，或转人工。'
        : `从 checkpoint 继续：${run.checkpoints.at(-1)?.step ?? '无 checkpoint'}；当前建议：${snapshot.nextAction}`;
  return { run, stale, nextAction };
}

/** Increment an attempt and decide retry vs human. */
export async function retryHarness(
  paths: SharedPaths,
  snapshot: Snapshot,
  step: string,
  maxRetries: number,
  now: string,
  error?: string
): Promise<HarnessRetryResult> {
  const run = await readHarnessRun(paths, snapshot, now);
  const previous = run.attempts[step] ?? { count: 0, lastAt: now };
  const attempt: HarnessAttempt = {
    count: previous.count + 1,
    lastAt: now,
    ...(error === undefined ? {} : { lastError: error })
  };
  const decision = attempt.count > Math.max(1, maxRetries) ? 'human' : 'retry';
  const nextAction =
    decision === 'human'
      ? `\`${step}\` 已尝试 ${attempt.count} 次（上限 ${maxRetries}）：停止自动重试，保留现场转人工。`
      : `\`${step}\` 第 ${attempt.count}/${maxRetries} 次：按 lastError 做最小修复后重跑同一质量门禁。`;
  const next: HarnessRun = {
    ...run,
    status: decision === 'human' ? 'blocked' : 'running',
    attempts: { ...run.attempts, [step]: attempt },
    ...(error === undefined ? {} : { lastError: { step, message: error, at: now } }),
    nextAction,
    updatedAt: now
  };
  await writeHarnessRun(paths, next);
  return { run: next, attempt, decision, nextAction };
}

/** Record a failure and stop the run. */
export async function failHarness(
  paths: SharedPaths,
  snapshot: Snapshot,
  step: string,
  message: string,
  now: string
): Promise<HarnessRun> {
  const run = await readHarnessRun(paths, snapshot, now);
  const next: HarnessRun = {
    ...run,
    status: 'blocked',
    lastError: { step, message, at: now },
    nextAction: `\`${step}\` 失败：先看证据，再用 fallback 或转人工；不要跳过质量门禁。`,
    updatedAt: now
  };
  await writeHarnessRun(paths, next);
  return next;
}

/** Record the fallback level for a failed step. */
export async function fallbackHarness(
  paths: SharedPaths,
  snapshot: Snapshot,
  step: string,
  level: number,
  now: string
): Promise<HarnessRun> {
  const run = await readHarnessRun(paths, snapshot, now);
  const bounded = Math.max(0, Math.min(HARNESS_FALLBACK_CHAIN.length - 1, Math.trunc(level)));
  const next: HarnessRun = {
    ...run,
    status: 'running',
    fallback: { step, level: bounded, chain: [...HARNESS_FALLBACK_CHAIN], at: now },
    nextAction: `\`${step}\` 使用降级档位 ${bounded + 1}/${HARNESS_FALLBACK_CHAIN.length}：${HARNESS_FALLBACK_CHAIN[bounded]}；每次切换保留失败原因与已完成步骤。`,
    updatedAt: now
  };
  await writeHarnessRun(paths, next);
  return next;
}

/** Mark the run done. */
export async function closeHarness(paths: SharedPaths, snapshot: Snapshot, now: string): Promise<HarnessRun> {
  const run = await readHarnessRun(paths, snapshot, now);
  const next: HarnessRun = {
    ...run,
    status: 'done',
    nextAction: '本轮 done；用户确认后开新一轮或停止。',
    updatedAt: now
  };
  await writeHarnessRun(paths, next);
  return next;
}

/** One durable queue task (0.8.0 scheduler). */
export interface HarnessTask {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: 'queued' | 'leased' | 'done' | 'failed';
  readonly step: string;
  readonly note?: string;
  readonly attempts: number;
  readonly lease?: { readonly owner: string; readonly until: string };
  readonly lastError?: string;
  readonly evidence?: readonly string[];
}

/** Persistent task queue. */
export interface HarnessQueue {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly tasks: readonly HarnessTask[];
}

/** Read the queue; a missing/corrupt file becomes empty. */
export async function readHarnessQueue(paths: SharedPaths, now: string): Promise<HarnessQueue> {
  const raw = await readTextOrNull(paths.harnessQueue);
  if (raw === null) return { schemaVersion: 1, updatedAt: now, tasks: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<HarnessQueue>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) return { schemaVersion: 1, updatedAt: now, tasks: [] };
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
      tasks: parsed.tasks.filter(
        (task): task is HarnessTask =>
          typeof task === 'object' &&
          task !== null &&
          typeof (task as { id?: unknown }).id === 'string' &&
          typeof (task as { step?: unknown }).step === 'string'
      )
    };
  } catch {
    return { schemaVersion: 1, updatedAt: now, tasks: [] };
  }
}

/** Persist the queue. */
export async function writeHarnessQueue(paths: SharedPaths, queue: HarnessQueue): Promise<void> {
  await ensureDir(paths.harnessDir);
  await writeTextAtomic(paths.harnessQueue, `${JSON.stringify(queue, null, 2)}\n`);
}

/** Add a queued task. */
export async function enqueueHarnessTask(
  paths: SharedPaths,
  now: string,
  input: { readonly step: string; readonly note?: string }
): Promise<HarnessQueue> {
  const queue = await readHarnessQueue(paths, now);
  const nextNumber =
    queue.tasks.reduce((max, task) => {
      const match = /^task-(\d+)$/.exec(task.id);
      return match?.[1] === undefined ? max : Math.max(max, Number.parseInt(match[1], 10));
    }, 0) + 1;
  const task: HarnessTask = {
    id: `task-${String(nextNumber).padStart(4, '0')}`,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    step: input.step,
    ...(input.note === undefined ? {} : { note: input.note }),
    attempts: 0
  };
  const next: HarnessQueue = { schemaVersion: 1, updatedAt: now, tasks: [...queue.tasks, task].slice(-100) };
  await writeHarnessQueue(paths, next);
  return next;
}

/** Claim the next queued task, reclaiming expired leases. */
export async function claimHarnessTask(
  paths: SharedPaths,
  now: string,
  owner: string,
  leaseSeconds: number
): Promise<{ queue: HarnessQueue; task: HarnessTask | null }> {
  const queue = await readHarnessQueue(paths, now);
  const nowMs = Date.parse(now);
  const tasks = queue.tasks.map((task) => {
    if (task.status === 'leased' && task.lease !== undefined && Date.parse(task.lease.until) <= nowMs) {
      return { ...task, status: 'queued' as const, updatedAt: now, lease: undefined };
    }
    return task;
  });
  const index = tasks.findIndex((task) => task.status === 'queued');
  if (index < 0) {
    const next = { ...queue, updatedAt: now, tasks };
    await writeHarnessQueue(paths, next);
    return { queue: next, task: null };
  }
  const current = tasks[index];
  if (current === undefined) return { queue, task: null };
  const leased: HarnessTask = {
    ...current,
    status: 'leased',
    updatedAt: now,
    attempts: current.attempts + 1,
    lease: { owner, until: new Date(nowMs + Math.max(10, leaseSeconds) * 1000).toISOString() }
  };
  const nextTasks = [...tasks];
  nextTasks[index] = leased;
  const next = { ...queue, updatedAt: now, tasks: nextTasks };
  await writeHarnessQueue(paths, next);
  return { queue: next, task: leased };
}

/** Mark a task done. */
export async function completeHarnessTask(
  paths: SharedPaths,
  now: string,
  id: string,
  evidence?: readonly string[]
): Promise<HarnessQueue> {
  const queue = await readHarnessQueue(paths, now);
  const next: HarnessQueue = {
    ...queue,
    updatedAt: now,
    tasks: queue.tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            status: 'done',
            updatedAt: now,
            lease: undefined,
            ...(evidence === undefined ? {} : { evidence: [...evidence].slice(0, 32) })
          }
        : task
    )
  };
  await writeHarnessQueue(paths, next);
  return next;
}

/** Mark a task failed. */
export async function failHarnessTask(
  paths: SharedPaths,
  now: string,
  id: string,
  error: string
): Promise<HarnessQueue> {
  const queue = await readHarnessQueue(paths, now);
  const next: HarnessQueue = {
    ...queue,
    updatedAt: now,
    tasks: queue.tasks.map((task) =>
      task.id === id ? { ...task, status: 'failed', updatedAt: now, lease: undefined, lastError: error } : task
    )
  };
  await writeHarnessQueue(paths, next);
  return next;
}

/** Collect a snapshot + run in one call for the tool. */
export async function readHarnessSnapshot(
  paths: SharedPaths,
  options: Parameters<typeof collectSnapshot>[1],
  now: string
): Promise<{ snapshot: Snapshot; run: HarnessRun }> {
  const snapshot = await collectSnapshot(paths, options, now);
  const run = await readHarnessRun(paths, snapshot, now);
  return { snapshot, run };
}
