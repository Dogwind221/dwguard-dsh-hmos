/**
 * Cross-session run state and recovery primitives (0.8.0).
 *
 * `dwguard_status` derives the phase from artifacts; this module stores the
 * *journal*: checkpoints, attempts, last error and the next action. It is the
 * piece that lets a new session resume instead of re-reading the whole
 * conversation.
 *
 * @module dwguard-dsh-hmos/harness
 */
import type { SharedPaths } from './paths.js';
import { collectSnapshot, type Snapshot } from './status.js';
/** Run status exposed by `dwguard_harness`. */
export type HarnessStatus = 'running' | 'blocked' | 'done';
/** One durable checkpoint. */
export interface HarnessCheckpoint {
    readonly id: string;
    readonly at: string;
    readonly phase: string;
    readonly step: string;
    readonly note?: string;
    readonly evidence: readonly string[];
}
/** Attempt counter for one step. */
export interface HarnessAttempt {
    readonly count: number;
    readonly lastAt: string;
    readonly lastError?: string;
}
/** Fallback level chosen for a failed step. */
export interface HarnessFallback {
    readonly step: string;
    readonly level: number;
    readonly chain: readonly string[];
    readonly at: string;
}
/** Durable run journal (`.shared/harness/run.json`). */
export interface HarnessRun {
    readonly schemaVersion: 1;
    readonly runId: string;
    readonly iteration: number;
    readonly specVersion: number;
    readonly phase: string;
    readonly status: HarnessStatus;
    readonly checkpoints: readonly HarnessCheckpoint[];
    readonly attempts: Readonly<Record<string, HarnessAttempt>>;
    readonly lastError?: {
        readonly step: string;
        readonly message: string;
        readonly at: string;
    };
    readonly fallback?: HarnessFallback;
    readonly nextAction: string;
    readonly updatedAt: string;
}
/** Input for a checkpoint. */
export interface HarnessCheckpointInput {
    readonly phase: string;
    readonly step: string;
    readonly note?: string;
    readonly evidence?: readonly string[];
}
/** Result of resuming a run. */
export interface HarnessResumeResult {
    readonly run: HarnessRun;
    readonly stale: boolean;
    readonly nextAction: string;
}
/** Result of a retry decision. */
export interface HarnessRetryResult {
    readonly run: HarnessRun;
    readonly attempt: HarnessAttempt;
    readonly decision: 'retry' | 'human';
    readonly nextAction: string;
}
export declare const HARNESS_FALLBACK_CHAIN: readonly ["devecocli", "deveco-mcp", "hdc+hvigor"];
/** Read and repair the run journal; a missing file yields a fresh in-memory run. */
export declare function readHarnessRun(paths: SharedPaths, snapshot: Snapshot, now: string): Promise<HarnessRun>;
/** Persist the run journal. */
export declare function writeHarnessRun(paths: SharedPaths, run: HarnessRun): Promise<void>;
/** Append a checkpoint and keep the run running. */
export declare function checkpointHarness(paths: SharedPaths, snapshot: Snapshot, input: HarnessCheckpointInput, now: string): Promise<HarnessRun>;
/** Resume from the latest durable checkpoint; reports stale pack/iteration. */
export declare function resumeHarness(paths: SharedPaths, snapshot: Snapshot, now: string): Promise<HarnessResumeResult>;
/** Increment an attempt and decide retry vs human. */
export declare function retryHarness(paths: SharedPaths, snapshot: Snapshot, step: string, maxRetries: number, now: string, error?: string): Promise<HarnessRetryResult>;
/** Record a failure and stop the run. */
export declare function failHarness(paths: SharedPaths, snapshot: Snapshot, step: string, message: string, now: string): Promise<HarnessRun>;
/** Record the fallback level for a failed step. */
export declare function fallbackHarness(paths: SharedPaths, snapshot: Snapshot, step: string, level: number, now: string): Promise<HarnessRun>;
/** Mark the run done. */
export declare function closeHarness(paths: SharedPaths, snapshot: Snapshot, now: string): Promise<HarnessRun>;
/** One durable queue task (0.8.0 scheduler). */
export interface HarnessTask {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly status: 'queued' | 'leased' | 'done' | 'failed';
    readonly step: string;
    readonly note?: string;
    readonly attempts: number;
    readonly lease?: {
        readonly owner: string;
        readonly until: string;
    };
    readonly lastError?: string;
    readonly evidence?: readonly string[];
}
/** Persistent task queue. */
export interface HarnessQueue {
    readonly schemaVersion: 1;
    readonly updatedAt: string;
    readonly tasks: readonly HarnessTask[];
}
/** Read the queue; a missing/corrupt file becomes empty. */
export declare function readHarnessQueue(paths: SharedPaths, now: string): Promise<HarnessQueue>;
/** Persist the queue. */
export declare function writeHarnessQueue(paths: SharedPaths, queue: HarnessQueue): Promise<void>;
/** Add a queued task. */
export declare function enqueueHarnessTask(paths: SharedPaths, now: string, input: {
    readonly step: string;
    readonly note?: string;
}): Promise<HarnessQueue>;
/** Claim the next queued task, reclaiming expired leases. */
export declare function claimHarnessTask(paths: SharedPaths, now: string, owner: string, leaseSeconds: number): Promise<{
    queue: HarnessQueue;
    task: HarnessTask | null;
}>;
/** Mark a task done. */
export declare function completeHarnessTask(paths: SharedPaths, now: string, id: string, evidence?: readonly string[]): Promise<HarnessQueue>;
/** Mark a task failed. */
export declare function failHarnessTask(paths: SharedPaths, now: string, id: string, error: string): Promise<HarnessQueue>;
/** Collect a snapshot + run in one call for the tool. */
export declare function readHarnessSnapshot(paths: SharedPaths, options: Parameters<typeof collectSnapshot>[1], now: string): Promise<{
    snapshot: Snapshot;
    run: HarnessRun;
}>;
