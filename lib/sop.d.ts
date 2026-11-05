/**
 * Bundled engineering knowledge + SOP library (0.8.0).
 *
 * The data lives next to `lib/` in the package (`knowledge/*.json`); it is
 * read-only and searched deterministically. The tool layer only formats it.
 *
 * @module dwguard-dsh-hmos/sop
 */
/** A reusable engineering fact. */
export interface EngineeringEntry {
    readonly id: string;
    readonly topic: string;
    readonly title: string;
    readonly statement: string;
    readonly why: string;
    readonly check: string;
    readonly rules: readonly string[];
}
/** An executable SOP. */
export interface SopEntry {
    readonly id: string;
    readonly title: string;
    readonly phase: string;
    readonly purpose: string;
    readonly inputs: readonly string[];
    readonly steps: readonly string[];
    readonly gate: readonly string[];
    readonly evidence: readonly string[];
    readonly rules: readonly string[];
}
export interface KnowledgeLibrary {
    readonly entries: readonly EngineeringEntry[];
    readonly sops: readonly SopEntry[];
}
/** Load the bundled library once. */
export declare function loadKnowledgeLibrary(): KnowledgeLibrary;
/** Search SOPs by free text and/or phase. */
export declare function searchSops(query: string, phase?: string, limit?: number): SopEntry[];
/** Look up one SOP by id. */
export declare function getSop(id: string): SopEntry | undefined;
/** Search engineer facts. */
export declare function searchEngineering(query: string, limit?: number): EngineeringEntry[];
/** Counts for `stats`/doctor output. */
export declare function knowledgeCounts(): {
    entries: number;
    sops: number;
};
