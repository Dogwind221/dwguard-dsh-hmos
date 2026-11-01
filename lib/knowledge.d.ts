/**
 * Knowledge sedimentation into `.shared/knowledge/`.
 *
 * One markdown file per topic, one delimited record per entry, and a JSON index
 * that makes appends idempotent (the same conclusion recorded twice is skipped).
 *
 * @module dwguard-dsh-hmos/knowledge
 */
import type { SharedPaths } from './paths.js';
/** What kind of lesson an entry records. */
export type KnowledgeKind = 'decision' | 'pattern' | 'rework' | 'preference' | 'risk';
/** Model-supplied knowledge entry. */
export interface KnowledgeEntryInput {
    readonly topic: string;
    readonly kind: KnowledgeKind;
    readonly statement: string;
    readonly evidence?: string;
}
/** One record in the knowledge index. */
export interface KnowledgeRecord {
    readonly topic: string;
    readonly kind: KnowledgeKind;
    readonly hash: string;
    readonly at: string;
    readonly statement: string;
}
/** The knowledge index document. */
export interface KnowledgeIndex {
    readonly schemaVersion: 1;
    readonly entries: readonly KnowledgeRecord[];
}
/** Whether a value is one of the knowledge kinds. */
export declare function isKnowledgeKind(value: unknown): value is KnowledgeKind;
/**
 * Sanitize a topic into a safe file stem.
 * @param raw - model-supplied topic.
 */
export declare function sanitizeTopic(raw: string): string;
/** Read the index, tolerating a missing or corrupt file. */
export declare function readIndex(paths: SharedPaths): Promise<KnowledgeIndex>;
/** Outcome of one knowledge append. */
export interface KnowledgeAppendResult {
    readonly added: KnowledgeRecord[];
    readonly skipped: Array<{
        topic: string;
        statement: string;
    }>;
    readonly files: string[];
}
/**
 * Append knowledge entries, skipping exact repeats.
 * @param paths - resolved protocol layout.
 * @param entries - model-supplied entries.
 * @param now - ISO timestamp for the record and its heading.
 */
export declare function appendKnowledge(paths: SharedPaths, entries: readonly KnowledgeEntryInput[], now: string): Promise<KnowledgeAppendResult>;
