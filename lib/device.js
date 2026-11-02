/**
 * Device policy: host-memory aware single/matrix mode, screen-family coverage,
 * the device pool and the shared device lock.
 *
 * The rule is deliberately simple and configurable:
 *
 *   host memory <  matrixMinMemoryGb  -> single device
 *   host memory >= matrixMinMemoryGb  -> matrix (per screen family)
 *
 * `deviceMode` can force either mode; `hostMemoryGb` overrides the detected
 * value so CI and tests can reproduce a 16 GB or 32 GB machine.
 *
 * @module dwguard-dsh-hmos/device
 */
import os from 'node:os';
import { DIMENSIONS, SCREEN_FAMILIES, isScreenFamily } from './model.js';
import { readTextOrNull, removeFile, writeTextAtomic } from './util/fs.js';
/** Per-dimension default matrix scope: adaptation dims across families, the rest on the bar phone. */
export const DEFAULT_MATRIX_SCOPE = {
    function: ['phone'],
    performance: ['phone'],
    aesthetic: [...SCREEN_FAMILIES],
    accessibility: [...SCREEN_FAMILIES]
};
function num(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function positiveInt(value, fallback, min) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.trunc(value));
}
function detectedHostMemoryGb() {
    const bytes = os.totalmem();
    return Math.round((bytes / 1024 ** 3) * 10) / 10;
}
function parseFamilies(value) {
    if (!Array.isArray(value))
        return [];
    const families = [];
    for (const item of value) {
        if (isScreenFamily(item) && !families.includes(item))
            families.push(item);
    }
    return families;
}
function parseScope(value, matrix) {
    const raw = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
    const scope = {};
    for (const dimension of DIMENSIONS) {
        const configured = parseFamilies(raw[dimension]).filter((family) => matrix.includes(family));
        scope[dimension] = configured.length > 0 ? configured : DEFAULT_MATRIX_SCOPE[dimension].filter((family) => matrix.includes(family));
        if (scope[dimension].length === 0)
            scope[dimension] = [...matrix];
    }
    return scope;
}
function parsePool(value) {
    if (!Array.isArray(value))
        return [];
    const pool = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            continue;
        const record = item;
        const sn = typeof record['sn'] === 'string' ? record['sn'].trim() : '';
        if (sn.length === 0 || seen.has(sn))
            continue;
        const family = isScreenFamily(record['family'])
            ? record['family']
            : isScreenFamily(record['type'])
                ? record['type']
                : 'phone';
        const apiLevel = typeof record['apiLevel'] === 'number' && Number.isFinite(record['apiLevel'])
            ? record['apiLevel']
            : undefined;
        const kind = record['kind'] === 'real' ? 'real' : 'emulator';
        seen.add(sn);
        pool.push({ sn, family, ...(apiLevel === undefined ? {} : { apiLevel }), kind });
    }
    return pool;
}
/**
 * Resolve the effective device policy from config values plus host memory.
 * @param raw - the device-related config keys (all optional).
 */
export function resolveDevicePolicy(raw) {
    const warnings = [];
    const configuredHost = num(raw.hostMemoryGb, 0);
    const hostMemoryGb = configuredHost > 0 ? configuredHost : detectedHostMemoryGb();
    const memorySource = configuredHost > 0 ? 'override' : 'detected';
    const matrixMinMemoryGb = num(raw.matrixMinMemoryGb, 32);
    const configuredMode = raw.deviceMode === 'single' || raw.deviceMode === 'matrix' || raw.deviceMode === 'auto' ? raw.deviceMode : 'auto';
    const mode = configuredMode === 'single'
        ? 'single'
        : configuredMode === 'matrix'
            ? 'matrix'
            : hostMemoryGb >= matrixMinMemoryGb
                ? 'matrix'
                : 'single';
    if (configuredMode === 'auto' && mode === 'single') {
        warnings.push(`主机内存 ${hostMemoryGb}GB < ${matrixMinMemoryGb}GB：按单机验证执行，deviceMatrix 不生效（16GB 机器不做多机矩阵）。`);
    }
    if (configuredMode === 'matrix' && hostMemoryGb < matrixMinMemoryGb) {
        warnings.push(`deviceMode=matrix 是手写覆盖，但主机内存 ${hostMemoryGb}GB < ${matrixMinMemoryGb}GB；请确认内存预算。`);
    }
    const parsedMatrix = parseFamilies(raw.deviceMatrix);
    const matrix = parsedMatrix.length > 0 ? parsedMatrix : [...SCREEN_FAMILIES];
    const scope = parseScope(raw.matrixScope, matrix);
    const pool = parsePool(raw.devicePool);
    const lockTimeoutMs = positiveInt(raw.deviceLockTimeoutMs, 600_000, 1_000);
    if (mode === 'matrix' && pool.length === 0) {
        warnings.push('matrix 模式但 devicePool 为空：闸门会要求屏幕族覆盖，请先配置设备池。');
    }
    const poolFamilies = new Set(pool.map((entry) => entry.family));
    const missing = matrix.filter((family) => !poolFamilies.has(family));
    if (mode === 'matrix' && missing.length > 0) {
        warnings.push(`设备池缺少屏幕族：${missing.join(' / ')}；矩阵覆盖闸门会拒绝（除非 allowMissingMatrixFamilies=true）。`);
    }
    const configuredConcurrency = num(raw.maxConcurrency, 0);
    // Auto budget: 32GB -> 2, 64GB -> 4, 16GB -> 1 (reserve 8GB, ~12GB per extra device).
    const memoryBudget = Math.max(1, Math.min(4, Math.floor((hostMemoryGb - 8) / 12)));
    const maxConcurrency = mode === 'single'
        ? 1
        : configuredConcurrency > 0
            ? Math.min(4, Math.max(1, Math.trunc(configuredConcurrency)))
            : Math.min(4, Math.max(1, pool.length || 1), memoryBudget);
    if (mode === 'matrix' && configuredConcurrency > memoryBudget) {
        warnings.push(`maxConcurrency=${configuredConcurrency} 超出内存预算 ${memoryBudget}；实际并发取 ${maxConcurrency}。`);
    }
    return {
        hostMemoryGb,
        memorySource,
        matrixMinMemoryGb,
        configuredMode,
        mode,
        matrix,
        scope,
        allowMissing: raw.allowMissingMatrixFamilies === true,
        pool,
        maxConcurrency,
        lockTimeoutMs,
        warnings
    };
}
/** Screen families the matrix requires for one dimension (matrix mode only). */
export function matrixFamilies(policy, dimension) {
    if (policy.mode !== 'matrix')
        return [];
    return policy.scope[dimension];
}
/** Required families that are missing from the configured pool, per dimension. */
export function coverageGaps(policy) {
    if (policy.mode !== 'matrix')
        return [];
    const poolFamilies = new Set(policy.pool.map((entry) => entry.family));
    const gaps = [];
    for (const dimension of DIMENSIONS) {
        for (const family of matrixFamilies(policy, dimension)) {
            if (!poolFamilies.has(family))
                gaps.push({ dimension, family });
        }
    }
    return gaps;
}
/** The default device for an action: bar phone first, then the pool order. */
export function defaultDevice(policy) {
    return policy.pool.find((entry) => entry.family === 'phone') ?? policy.pool[0];
}
/** Unique devices referenced by checks (for `audit.json` / reports). */
export function collectDeviceEvidence(checks) {
    const seen = new Set();
    const devices = [];
    for (const check of checks) {
        if (check.device === undefined || check.family === undefined)
            continue;
        const key = `${check.device}::${check.family}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        devices.push({ sn: check.device, family: check.family });
    }
    return devices;
}
/** Path of the shared device lock. */
export function deviceLockFile(paths) {
    return `${paths.shared}/.device-lock.json`;
}
/** Read the current device lock, if any. */
export async function readDeviceLock(paths) {
    const raw = await readTextOrNull(deviceLockFile(paths));
    if (raw === null)
        return null;
    try {
        const value = JSON.parse(raw);
        if (typeof value.sn !== 'string' || typeof value.holder !== 'string' || typeof value.acquiredAt !== 'string')
            return null;
        return { sn: value.sn, holder: value.holder, acquiredAt: value.acquiredAt };
    }
    catch {
        return null;
    }
}
/**
 * Acquire the shared device lock, waiting up to `timeoutMs`.
 *
 * A lock older than `staleAfterMs` (defaults to `timeoutMs`) is considered
 * stale and is stolen (the caller gets `staleStolen: true` so it can warn).
 * Waiting polls every `pollMs`.
 */
export async function acquireDeviceLock(paths, sn, holder, timeoutMs, options = {}) {
    const pollMs = options.pollMs ?? 150;
    const staleAfterMs = options.staleAfterMs ?? timeoutMs;
    const started = Date.now();
    for (;;) {
        const current = await readDeviceLock(paths);
        if (current === null || (current.sn === sn && current.holder === holder)) {
            await writeTextAtomic(deviceLockFile(paths), `${JSON.stringify({ sn, holder, acquiredAt: options.now ?? new Date().toISOString() }, null, 2)}\n`);
            return { ok: true, waitedMs: Date.now() - started, staleStolen: false };
        }
        const acquired = Date.parse(current.acquiredAt);
        if (Number.isFinite(acquired) && Date.now() - acquired > staleAfterMs) {
            await writeTextAtomic(deviceLockFile(paths), `${JSON.stringify({ sn, holder, acquiredAt: options.now ?? new Date().toISOString() }, null, 2)}\n`);
            return { ok: true, waitedMs: Date.now() - started, staleStolen: true };
        }
        if (Date.now() - started >= timeoutMs) {
            return {
                ok: false,
                reason: `设备 ${current.sn} 被 ${current.holder} 占用（${current.acquiredAt}），等待 ${Math.round((Date.now() - started) / 1000)}s 超时`
            };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}
/** Release the lock when it belongs to `sn`. */
export async function releaseDeviceLock(paths, sn) {
    const current = await readDeviceLock(paths);
    if (current === null || current.sn !== sn)
        return false;
    await removeFile(deviceLockFile(paths));
    return true;
}
