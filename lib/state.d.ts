/**
 * Persisted protocol state (`.shared/state.json`) and artifact numbering.
 *
 * @module dwguard-dsh-hmos/state
 */
import type { SharedState } from './model.js';
import type { SharedPaths } from './paths.js';
/**
 * Read the state document, repairing missing or corrupt fields in memory.
 * @param paths - resolved protocol layout.
 * @param now - ISO timestamp used for a repaired document.
 */
export declare function readState(paths: SharedPaths, now: string): Promise<SharedState>;
/** Persist the state document. */
export declare function writeState(paths: SharedPaths, state: SharedState): Promise<void>;
/**
 * Read-modify-write the state document.
 * @param paths - resolved protocol layout.
 * @param now - ISO timestamp for `updatedAt`.
 * @param mutate - receives the current state and returns the next one.
 */
export declare function updateState(paths: SharedPaths, now: string, mutate: (state: SharedState) => SharedState): Promise<SharedState>;
/**
 * Next free numeric suffix for `<prefix>-<n>` files in a directory.
 * The counter is reserved under a lock, so concurrent callers cannot both
 * receive the same audit/deveco id.
 * @param dir - directory to scan.
 * @param prefix - file stem before the dash.
 */
export declare function nextIndex(dir: string, prefix: string): Promise<number>;
/** Latest numbered artifact of one kind, as parsed JSON. */
export declare function readLatestJson<T>(dir: string, prefix: string): Promise<{
    index: number;
    value: T;
    file: string;
} | null>;
