/**
 * Round history for the board: what happened, in order.
 *
 * Reads the artifact filenames + their small JSON payloads (audit, prereview,
 * confirmation, shadow) and the dispatch/rework records in `outbox-dsh.md`.
 *
 * @module dwguard-dsh-hmos/history
 */
import type { SharedPaths } from './paths.js';
/** One timeline entry. */
export interface HistoryEvent {
    readonly at: string;
    readonly kind: 'dispatch' | 'rework' | 'audit' | 'prereview' | 'confirm' | 'shadow';
    readonly label: string;
    /** English label for the panel's language toggle. */
    readonly labelEn: string;
    /** Gate/audit outcome, when the event has one. */
    readonly ok?: boolean;
}
/**
 * Recent events, newest first.
 * @param paths - resolved protocol layout.
 * @param limit - max events returned.
 */
export declare function readHistory(paths: SharedPaths, limit?: number): Promise<HistoryEvent[]>;
