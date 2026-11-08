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
import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { DIMENSIONS, SCREEN_FAMILIES, isScreenFamily } from './model.js';
import { ensureDir, readTextOrNull, removeFile, writeTextAtomic } from './util/fs.js';
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
/** Per-device lock directory. */
export function deviceLocksDir(paths) {
    return join(paths.shared, '.device-locks');
}
/** Lock file for one serial (hashed to a safe filename). */
export function deviceLockFile(paths, sn) {
    const key = createHash('sha256').update(sn).digest('hex').slice(0, 32);
    return join(deviceLocksDir(paths), `${key}.json`);
}
function parseLease(raw, sn) {
    try {
        const value = JSON.parse(raw);
        if (value.sn !== sn ||
            typeof value.token !== 'string' ||
            typeof value.jobId !== 'string' ||
            typeof value.acquiredAt !== 'string' ||
            typeof value.heartbeatAt !== 'string' ||
            typeof value.expiresAt !== 'string') {
            return null;
        }
        return {
            sn: value.sn,
            token: value.token,
            jobId: value.jobId,
            acquiredAt: value.acquiredAt,
            heartbeatAt: value.heartbeatAt,
            expiresAt: value.expiresAt
        };
    }
    catch {
        return null;
    }
}
/** Read one device's lease, or the first lease when `sn` is omitted. */
export async function readDeviceLock(paths, sn) {
    if (sn !== undefined) {
        const raw = await readTextOrNull(deviceLockFile(paths, sn));
        return raw === null ? null : parseLease(raw, sn);
    }
    const names = await readdir(deviceLocksDir(paths)).catch(() => []);
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
        const raw = await readTextOrNull(join(deviceLocksDir(paths), name)).catch(() => null);
        if (raw === null)
            continue;
        try {
            const sn = JSON.parse(raw).sn;
            if (typeof sn !== 'string')
                continue;
            const parsed = parseLease(raw, sn);
            if (parsed !== null)
                return parsed;
        }
        catch {
            /* skip corrupt lease */
        }
    }
    return null;
}
/** All current leases (for status/reporting). */
export async function readDeviceLocks(paths) {
    const names = await readdir(deviceLocksDir(paths)).catch(() => []);
    const leases = [];
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
        const raw = await readTextOrNull(join(deviceLocksDir(paths), name)).catch(() => null);
        if (raw === null)
            continue;
        try {
            const sn = JSON.parse(raw).sn;
            if (typeof sn !== 'string')
                continue;
            const lease = parseLease(raw, sn);
            if (lease !== null)
                leases.push(lease);
        }
        catch {
            /* skip corrupt lease */
        }
    }
    return leases;
}
async function createExclusive(file, lease) {
    await ensureDir(dirname(file));
    try {
        await writeFile(file, `${JSON.stringify(lease, null, 2)}\n`, { flag: 'wx' });
        return true;
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return false;
        throw error;
    }
}
function leaseFor(sn, token, jobId, ttlMs) {
    const now = new Date().toISOString();
    return {
        sn,
        token,
        jobId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + Math.max(10_000, ttlMs)).toISOString()
    };
}
/**
 * Acquire a per-device lease. Acquisition is `wx`-exclusive; a token is
 * returned and is required to release/renew. Different devices use different
 * files and therefore do not serialise against each other.
 */
export async function acquireDeviceLock(paths, sn, holder, timeoutMs, options = {}) {
    const pollMs = options.pollMs ?? 150;
    const started = Date.now();
    const token = options.token ?? randomUUID();
    const jobId = options.jobId ?? holder;
    const ttlMs = options.leaseTtlMs ?? Math.max(timeoutMs, 60_000);
    let staleStolen = false;
    for (;;) {
        const current = await readDeviceLock(paths, sn);
        if (current === null) {
            const info = await stat(deviceLockFile(paths, sn)).catch(() => null);
            if (info !== null) {
                // A crash may leave an unparsable lease; reclaim it after a short grace.
                if (Date.now() - info.mtimeMs > 5_000) {
                    await removeFile(deviceLockFile(paths, sn));
                    continue;
                }
                if (Date.now() - started >= timeoutMs) {
                    return { ok: false, reason: `设备 ${sn} 的租约文件不可读，等待超时。` };
                }
                await new Promise((resolve) => setTimeout(resolve, pollMs));
                continue;
            }
            const lease = leaseFor(sn, token, jobId, ttlMs);
            if (await createExclusive(deviceLockFile(paths, sn), lease)) {
                return { ok: true, token, waitedMs: Date.now() - started, staleStolen };
            }
            continue;
        }
        if (current.token === token) {
            await renewDeviceLease(paths, sn, token, ttlMs);
            return { ok: true, token, waitedMs: Date.now() - started, staleStolen };
        }
        if (Date.parse(current.expiresAt) <= Date.now()) {
            const again = await readDeviceLock(paths, sn);
            if (again?.token === current.token) {
                await removeFile(deviceLockFile(paths, sn));
                staleStolen = true;
                continue;
            }
        }
        if (Date.now() - started >= timeoutMs) {
            return {
                ok: false,
                reason: `设备 ${current.sn} 被 ${current.jobId} 占用（${current.acquiredAt}），等待 ${Math.round((Date.now() - started) / 1000)}s 超时`
            };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}
/** Renew a lease only when the caller still owns its token. */
export async function renewDeviceLease(paths, sn, token, ttlMs) {
    const current = await readDeviceLock(paths, sn);
    if (current === null || current.token !== token)
        return false;
    const next = {
        ...current,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + Math.max(10_000, ttlMs)).toISOString()
    };
    await writeTextAtomic(deviceLockFile(paths, sn), `${JSON.stringify(next, null, 2)}\n`);
    return true;
}
/** Release only when the caller still owns the token. */
export async function releaseDeviceLock(paths, sn, token) {
    const current = await readDeviceLock(paths, sn);
    if (current === null || current.token !== token)
        return false;
    await removeFile(deviceLockFile(paths, sn));
    return true;
}
