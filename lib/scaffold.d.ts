/**
 * First-use scaffolding of `.shared/`.
 *
 * @module dwguard-dsh-hmos/scaffold
 */
import type { SharedPaths } from './paths.js';
/**
 * Create the protocol tree and the baseline files when missing.
 * @param paths - resolved protocol layout.
 * @returns the workspace-relative files created or confirmed.
 */
export declare function ensureShared(paths: SharedPaths): Promise<string[]>;
