/**
 * The panel board: a compact, client-facing projection of one workspace's
 * DwGuard round. Everything here is derived from `.shared/` on every request,
 * so the panel never shows a stale copy of its own.
 *
 * @module dwguard-dsh-hmos/board
 */
import type { Options } from './config.js';
import type { HistoryEvent } from './history.js';
import type { Dimension } from './model.js';
/** Visual state of one dimension card. */
export type DimensionState = 'done' | 'active' | 'pending' | 'failed';
/** One acceptance dimension's progress. */
export interface DimensionBoard {
    readonly key: Dimension;
    readonly label: string;
    readonly total: number;
    readonly must: number;
    readonly passed: number;
    readonly failed: number;
    readonly unverified: number;
    readonly missing: number;
    /** Per-dimension card state (four sub-agents land one by one). */
    readonly state: DimensionState;
}
/** The board payload the client renders. */
export interface BoardJson {
    readonly workspace: string;
    readonly name: string;
    readonly phase: string;
    readonly phaseLabel: string;
    readonly title: string;
    readonly specVersion: number;
    readonly iteration: number;
    readonly updatedAt: string;
    readonly criteria: {
        readonly total: number;
        readonly must: number;
        readonly mustPassed: number;
    };
    readonly dimensions: readonly DimensionBoard[];
    readonly prereview: {
        readonly id: number;
        readonly pass: boolean;
        readonly blockers: number;
    } | null;
    readonly audit: {
        readonly id: number;
        readonly pass: boolean;
        readonly errors: number;
    } | null;
    readonly unread: number;
    readonly next: string;
    /** English rendering of `next` for the panel's language toggle. */
    readonly nextEn: string;
    /** Recent round events, newest first. */
    readonly history: readonly HistoryEvent[];
    readonly files: {
        readonly spec: boolean;
        readonly brief: boolean;
        readonly report: boolean;
        readonly rework: number;
    };
}
/** One remembered workspace beside its board (null when it has no task pack yet). */
export interface WorkspaceBoard {
    readonly path: string;
    readonly name: string;
    readonly lastSeen: string;
    readonly board: BoardJson | null;
}
/**
 * Build the board for one workspace.
 * @param workspace - absolute workspace path.
 * @param options - resolved plugin options.
 * @param now - ISO timestamp used when repairing state.
 * @returns the board, or `null` when the workspace has no task pack yet.
 */
export declare function readBoard(workspace: string, options: Options, now: string): Promise<BoardJson | null>;
