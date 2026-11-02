/**
 * Plugin configuration and its defensive normalization.
 *
 * The loader validates this schema before `apply` runs, but `apply` also
 * accepts an empty object (a row with no `config:`), so every field is
 * re-defaulted here instead of trusting the argument.
 *
 * @module dwguard-dsh-hmos/config
 */
import type { DeviceConfig } from './device.js';
/** Loader-facing schema of the `dsh` row's `config` block. */
export declare const Config: any;
/** Fully resolved options used by every tool. */
export interface Options {
    readonly sharedDir: string;
    readonly promptSection: boolean;
    readonly installSkills: boolean;
    readonly minCriteriaPerDimension: number;
    readonly requireRebuttalOnBlocker: boolean;
    readonly requirePrereviewBeforeDispatch: boolean;
    readonly knowledgeMaxEntriesPerTopic: number;
    /** Local official-docs corpus; empty means auto-detect. */
    readonly docsDir: string;
    /** Shadow-review nudge interval in minutes. */
    readonly shadowIntervalMinutes: number;
    /** Minutes without a delivery before the round is reported as stalled. */
    readonly stallMinutes: number;
    /** Executor policy: `auto` = IDE-first; `ide` / `cli` force one. */
    readonly executor: 'auto' | 'ide' | 'cli';
    /** `devecocli` binary; empty means resolve from PATH. */
    readonly devecocliPath: string;
    /** Effective device policy (host memory, mode, matrix scope, pool, lock timeout). */
    readonly device: DeviceConfig;
}
/**
 * Normalize whatever the loader passed into complete options.
 * @param raw - the row's config value (possibly `undefined`).
 * @returns options with every default applied.
 */
export declare function resolveOptions(raw: unknown): Options;
