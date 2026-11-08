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
import type { DeviceEntry, Dimension, ScreenFamily } from './model.js';
import type { SharedPaths } from './paths.js';
/** Per-dimension default matrix scope: adaptation dims across families, the rest on the bar phone. */
export declare const DEFAULT_MATRIX_SCOPE: Readonly<Record<Dimension, readonly ScreenFamily[]>>;
/** Configured (or detected) device settings. */
export interface DeviceConfig {
    readonly hostMemoryGb: number;
    readonly memorySource: 'detected' | 'override';
    readonly matrixMinMemoryGb: number;
    readonly configuredMode: 'auto' | 'single' | 'matrix';
    readonly mode: 'single' | 'matrix';
    readonly matrix: readonly ScreenFamily[];
    readonly scope: Readonly<Record<Dimension, readonly ScreenFamily[]>>;
    readonly allowMissing: boolean;
    readonly pool: readonly DeviceEntry[];
    readonly maxConcurrency: number;
    readonly lockTimeoutMs: number;
    readonly warnings: readonly string[];
}
/** One lock record in `.device-locks/<id>.json` (0.8.5 per-device lease). */
export interface DeviceLock {
    readonly sn: string;
    readonly token: string;
    readonly jobId: string;
    readonly acquiredAt: string;
    readonly heartbeatAt: string;
    readonly expiresAt: string;
}
/**
 * Resolve the effective device policy from config values plus host memory.
 * @param raw - the device-related config keys (all optional).
 */
export declare function resolveDevicePolicy(raw: {
    readonly hostMemoryGb?: unknown;
    readonly deviceMode?: unknown;
    readonly matrixMinMemoryGb?: unknown;
    readonly deviceMatrix?: unknown;
    readonly matrixScope?: unknown;
    readonly allowMissingMatrixFamilies?: unknown;
    readonly devicePool?: unknown;
    readonly maxConcurrency?: unknown;
    readonly deviceLockTimeoutMs?: unknown;
}): DeviceConfig;
/** Screen families the matrix requires for one dimension (matrix mode only). */
export declare function matrixFamilies(policy: DeviceConfig, dimension: Dimension): readonly ScreenFamily[];
/** Required families that are missing from the configured pool, per dimension. */
export declare function coverageGaps(policy: DeviceConfig): Array<{
    dimension: Dimension;
    family: ScreenFamily;
}>;
/** The default device for an action: bar phone first, then the pool order. */
export declare function defaultDevice(policy: DeviceConfig): DeviceEntry | undefined;
/** Unique devices referenced by checks (for `audit.json` / reports). */
export declare function collectDeviceEvidence(checks: ReadonlyArray<{
    readonly device?: string;
    readonly family?: ScreenFamily;
}>): Array<{
    sn: string;
    family: ScreenFamily;
    apiLevel?: number;
    kind?: 'emulator' | 'real';
}>;
/** Per-device lock directory. */
export declare function deviceLocksDir(paths: SharedPaths): string;
/** Lock file for one serial (hashed to a safe filename). */
export declare function deviceLockFile(paths: SharedPaths, sn: string): string;
/** Read one device's lease, or the first lease when `sn` is omitted. */
export declare function readDeviceLock(paths: SharedPaths, sn?: string): Promise<DeviceLock | null>;
/** All current leases (for status/reporting). */
export declare function readDeviceLocks(paths: SharedPaths): Promise<DeviceLock[]>;
/** Acquire outcome: success (with token) or timeout. */
export type DeviceLockResult = {
    readonly ok: true;
    readonly token: string;
    readonly waitedMs: number;
    readonly staleStolen: boolean;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * Acquire a per-device lease. Acquisition is `wx`-exclusive; a token is
 * returned and is required to release/renew. Different devices use different
 * files and therefore do not serialise against each other.
 */
export declare function acquireDeviceLock(paths: SharedPaths, sn: string, holder: string, timeoutMs: number, options?: {
    readonly now?: string;
    readonly pollMs?: number;
    readonly staleAfterMs?: number;
    readonly leaseTtlMs?: number;
    readonly token?: string;
    readonly jobId?: string;
}): Promise<DeviceLockResult>;
/** Renew a lease only when the caller still owns its token. */
export declare function renewDeviceLease(paths: SharedPaths, sn: string, token: string, ttlMs: number): Promise<boolean>;
/** Release only when the caller still owns the token. */
export declare function releaseDeviceLock(paths: SharedPaths, sn: string, token: string): Promise<boolean>;
