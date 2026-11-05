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
import { collectSnapshot } from './status.js';
import { ensureDir, readTextOrNull, writeTextAtomic } from './util/fs.js';
export const HARNESS_FALLBACK_CHAIN = ['devecocli', 'deveco-mcp', 'hdc+hvigor'];
function emptyRun(snapshot, now) {
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
function asStringArray(value, limit) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0).slice(0, limit);
}
function normalizeAttempts(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const result = {};
    for (const [step, value] of Object.entries(raw)) {
        if (typeof value !== 'object' || value === null)
            continue;
        const record = value;
        if (typeof record['count'] !== 'number' || !Number.isFinite(record['count']))
            continue;
        result[step] = {
            count: Math.max(0, Math.trunc(record['count'])),
            lastAt: typeof record['lastAt'] === 'string' ? record['lastAt'] : new Date(0).toISOString(),
            ...(typeof record['lastError'] === 'string' ? { lastError: record['lastError'] } : {})
        };
    }
    return result;
}
/** Read and repair the run journal; a missing file yields a fresh in-memory run. */
export async function readHarnessRun(paths, snapshot, now) {
    const raw = await readTextOrNull(paths.harnessRun);
    if (raw === null)
        return emptyRun(snapshot, now);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return emptyRun(snapshot, now);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return emptyRun(snapshot, now);
    const record = parsed;
    const base = emptyRun(snapshot, now);
    const checkpoints = Array.isArray(record['checkpoints'])
        ? record['checkpoints']
            .filter((item) => typeof item === 'object' && item !== null)
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
    const lastError = typeof record['lastError'] === 'object' && record['lastError'] !== null
        ? record['lastError']
        : undefined;
    const fallback = typeof record['fallback'] === 'object' && record['fallback'] !== null
        ? record['fallback']
        : undefined;
    return {
        schemaVersion: 1,
        runId: typeof record['runId'] === 'string' ? record['runId'] : base.runId,
        iteration: typeof record['iteration'] === 'number' ? Math.trunc(record['iteration']) : base.iteration,
        specVersion: typeof record['specVersion'] === 'number' ? Math.trunc(record['specVersion']) : base.specVersion,
        phase: typeof record['phase'] === 'string' ? record['phase'] : base.phase,
        status: record['status'] === 'blocked' || record['status'] === 'done' || record['status'] === 'running'
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
export async function writeHarnessRun(paths, run) {
    await ensureDir(paths.harnessDir);
    await writeTextAtomic(paths.harnessRun, `${JSON.stringify(run, null, 2)}\n`);
}
/** Append a checkpoint and keep the run running. */
export async function checkpointHarness(paths, snapshot, input, now) {
    const run = await readHarnessRun(paths, snapshot, now);
    const checkpoint = {
        id: `cp-${run.checkpoints.length + 1}`,
        at: now,
        phase: input.phase,
        step: input.step,
        ...(input.note === undefined ? {} : { note: input.note }),
        evidence: [...(input.evidence ?? [])].slice(0, 32)
    };
    const next = {
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
export async function resumeHarness(paths, snapshot, now) {
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
export async function retryHarness(paths, snapshot, step, maxRetries, now, error) {
    const run = await readHarnessRun(paths, snapshot, now);
    const previous = run.attempts[step] ?? { count: 0, lastAt: now };
    const attempt = {
        count: previous.count + 1,
        lastAt: now,
        ...(error === undefined ? {} : { lastError: error })
    };
    const decision = attempt.count > Math.max(1, maxRetries) ? 'human' : 'retry';
    const nextAction = decision === 'human'
        ? `\`${step}\` 已尝试 ${attempt.count} 次（上限 ${maxRetries}）：停止自动重试，保留现场转人工。`
        : `\`${step}\` 第 ${attempt.count}/${maxRetries} 次：按 lastError 做最小修复后重跑同一质量门禁。`;
    const next = {
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
export async function failHarness(paths, snapshot, step, message, now) {
    const run = await readHarnessRun(paths, snapshot, now);
    const next = {
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
export async function fallbackHarness(paths, snapshot, step, level, now) {
    const run = await readHarnessRun(paths, snapshot, now);
    const bounded = Math.max(0, Math.min(HARNESS_FALLBACK_CHAIN.length - 1, Math.trunc(level)));
    const next = {
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
export async function closeHarness(paths, snapshot, now) {
    const run = await readHarnessRun(paths, snapshot, now);
    const next = {
        ...run,
        status: 'done',
        nextAction: '本轮 done；用户确认后开新一轮或停止。',
        updatedAt: now
    };
    await writeHarnessRun(paths, next);
    return next;
}
/** Collect a snapshot + run in one call for the tool. */
export async function readHarnessSnapshot(paths, options, now) {
    const snapshot = await collectSnapshot(paths, options, now);
    const run = await readHarnessRun(paths, snapshot, now);
    return { snapshot, run };
}
