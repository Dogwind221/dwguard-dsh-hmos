/**
 * Dispatch: the Goal-mode brief for DevEco Code and the outbox protocol.
 *
 * `outbox-dsh.md` is DSH → DevEco Code; `outbox-deveco.md` is DevEco Code →
 * DSH. Both are append-only, and every entry starts with `## [` so the reader
 * can count entries and resume from a cursor.
 *
 * @module dwguard-dsh-hmos/dispatch
 */
import type { TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
/** Message kinds carried by the outbox protocol. */
export type OutboxKind = 'dispatch' | 'ack' | 'deliver' | 'question' | 'answer' | 'blocked' | 'shadow-risk' | 'rework';
/** Which agent implements a task pack. */
export type ExecutorMode = 'ide' | 'cli';
/**
 * IDE-first routing: an explicit pack/option wins; `auto` only switches to CLI
 * when the task has no visual must-criterion and is clearly batch/regression
 * flavoured.
 * @param pack - frozen task pack.
 * @param options - resolved plugin options (`executor` policy).
 */
export declare function chooseExecutor(pack: TaskPack, options: {
    readonly executor: 'auto' | 'ide' | 'cli';
}): ExecutorMode;
/** Envelope attached to an outbox entry, v2 protocol. */
export interface OutboxMeta {
    readonly kind: OutboxKind;
    /** Unique message id, e.g. `d-3`, `a-1`, `q-2`. */
    readonly id: string;
    readonly from: 'dsh' | 'deveco';
    readonly to: 'dsh' | 'deveco';
    /** Id of the message this one answers, e.g. `d-3`. */
    readonly replyTo?: string;
}
/** One parsed outbox entry. */
export interface OutboxEntry {
    /** Zero-based position in the file. */
    readonly index: number;
    /** Text after `## `, e.g. `[2026-10-30T…] deliver · #d-3 · … | 交付` . */
    readonly header: string;
    /** Entry body without the header line. */
    readonly body: string;
    /** Envelope fields; absent on legacy entries written before protocol v2. */
    readonly kind?: OutboxKind;
    readonly id?: string;
    readonly from?: string;
    readonly to?: string;
    readonly replyTo?: string;
}
/**
 * Parse an outbox file into entries.
 * @param text - raw file content, or `null` when the file does not exist.
 */
export declare function parseOutbox(text: string | null): OutboxEntry[];
/** Render one outbox entry, ready to append. */
export declare function renderOutboxEntry(title: string, body: string, now: string, meta?: OutboxMeta): string;
/** Append an entry to DSH's outbox (DSH → DevEco Code). */
export declare function appendOutboxDsh(paths: SharedPaths, title: string, body: string, now: string, meta?: OutboxMeta): Promise<void>;
/**
 * Dispatches that have no reply (ack/deliver/question) referencing their id.
 * @param sent - entries from `outbox-dsh.md`.
 * @param replies - entries from `outbox-deveco.md`.
 * @param sinceDispatchNumber - only count dispatches with `#d-<n>` at or above
 *   this number (the current round), so old rounds stop nagging.
 */
export declare function unackedDispatches(sent: readonly OutboxEntry[], replies: readonly OutboxEntry[], sinceDispatchNumber?: number): OutboxEntry[];
/**
 * Render the brief the human pastes into DevEco Code's Goal mode.
 * @param pack - the frozen task pack.
 * @param paths - resolved layout (for the file references in the brief).
 * @param briefCounter - the dispatch number used in the delivery-record template.
 */
export declare function renderGoalBrief(pack: TaskPack, paths: SharedPaths, briefCounter: number): string;
/** The DevEco outbox path (kept as a helper so the brief and status agree). */
export declare function outboxFile(paths: SharedPaths): string;
/** A compact dispatch note for DSH's own outbox. */
export declare function renderDispatchEntry(pack: TaskPack, paths: SharedPaths, briefCounter: number, executor?: 'ide' | 'cli'): string;
/**
 * The extra section appended to the brief when `executor: cli`.
 * It pins the command surface and keeps visual evidence on DSH's side.
 */
export declare function renderCliSection(pack: TaskPack): string;
