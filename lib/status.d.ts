/**
 * Status: re-derive the workflow phase from the artifacts on disk, show the
 * unread delivery records, and name the one next action.
 *
 * @module dwguard-dsh-hmos/status
 */
import type { Options } from './config.js';
import type { OutboxEntry } from './dispatch.js';
import type { SharedState, TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
import type { AuditReport, PrereviewReport } from './review.js';
import type { ValidationResult } from './spec.js';
/** The workflow phase derived from artifacts. */
export type Phase = 'intake' | 'spec-invalid' | 'prereview' | 'ready' | 'dispatched' | 'rework' | 'accepted' | 'confirmed';
/** Everything `dwguard_status` needs, collected once. */
export interface Snapshot {
    readonly paths: SharedPaths;
    readonly options: Options;
    readonly state: SharedState;
    readonly spec: TaskPack | null;
    readonly validation: ValidationResult | null;
    readonly prereview: {
        readonly index: number;
        readonly value: PrereviewReport;
    } | null;
    readonly audit: {
        readonly index: number;
        readonly value: AuditReport;
    } | null;
    /** Latest report from an older pack version, kept for "not applicable" display. */
    readonly stalePrereview: number | null;
    readonly staleAudit: number | null;
    readonly outboxEntries: readonly OutboxEntry[];
    readonly outboxSent: readonly OutboxEntry[];
    readonly unacked: readonly OutboxEntry[];
    readonly unread: readonly OutboxEntry[];
    readonly question: string | null;
    readonly phase: Phase;
    readonly nextAction: string;
    /** English rendering of `nextAction` for the panel's language toggle. */
    readonly nextActionEn: string;
}
/**
 * Collect the current status.
 * @param paths - resolved protocol layout.
 * @param options - resolved options.
 * @param now - ISO timestamp for state repair.
 */
export declare function collectSnapshot(paths: SharedPaths, options: Options, now: string): Promise<Snapshot>;
/** Chinese label of a phase. */
export declare function phaseLabel(phase: Phase): string;
/** Render the status document. */
export declare function renderStatusMarkdown(snapshot: Snapshot): string;
