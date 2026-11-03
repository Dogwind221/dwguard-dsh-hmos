/**
 * Design reference library (0.6.2 P0): cards → chunks → a deterministic BM25
 * index, plus the dependency-free `query.mjs` that lets DevEco read the same
 * index DSH uses.
 *
 * No model calls, no network, no extra dependencies: the same input must always
 * produce the same cards, the same index bytes and the same ranking.
 *
 * @module dwguard-dsh-hmos/design
 */
import type { AestheticArea } from './aesthetic.js';
import type { Options } from './config.js';
import type { TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
/** Version stamped into the manifest/index so a future format change is visible. */
export declare const DESIGN_ENGINE_VERSION = "0.6.3";
/** The card sections that become retrievable chunks. */
export declare const DESIGN_SECTIONS: readonly ["tokens", "rationale", "dos", "donts", "style", "antiPatterns", "checklist", "brand"];
/** One retrievable section of a card. */
export type DesignSection = (typeof DESIGN_SECTIONS)[number];
/** A numeric token (spacing/radius/type/motion). */
export interface DesignNumberToken {
    readonly name?: string;
    readonly value: number;
    readonly unit: string;
}
/** A colour token. */
export interface DesignColorToken {
    readonly name?: string;
    readonly value: string;
}
/** Structured design tokens extracted from a card. */
export interface DesignTokens {
    readonly palette: readonly DesignColorToken[];
    readonly spacing: readonly DesignNumberToken[];
    readonly radius: readonly DesignNumberToken[];
    readonly type: readonly DesignNumberToken[];
    readonly motion: readonly DesignNumberToken[];
}
/** Where a card came from and under which license. */
export interface DesignSource {
    readonly kind: 'rule' | 'official' | 'user' | 'project' | 'brand';
    readonly ref?: string;
    readonly license: string;
}
/** Retrieval dimensions used by `search` filters (0.6.3 A). */
export interface DesignDimensions {
    readonly appType?: string;
    readonly platform?: string;
    readonly style?: string;
}
/** Brand / business payload carried by `source.kind: brand` cards (0.6.3 B). */
export interface DesignBrand {
    readonly positioning?: string;
    readonly audience: readonly string[];
    readonly constraints: readonly string[];
    readonly bannedStyles: readonly string[];
}
/** One design reference card. */
export interface DesignCard {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly tags: readonly string[];
    readonly source: DesignSource;
    readonly tokens: DesignTokens;
    readonly rationale?: string;
    readonly dos: readonly string[];
    readonly donts: readonly string[];
    readonly images: ReadonlyArray<{
        readonly path: string;
        readonly sha256?: string;
        readonly alt?: string;
    }>;
    readonly status: 'active' | 'blocked';
    readonly weight: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** sha256 of the inbox metadata this card was ingested from (idempotency). */
    readonly ingestKey?: string;
    /** `pattern` (default) or `anti-pattern`; anti-pattern ids use the AP-* namespace. */
    readonly kind?: 'pattern' | 'anti-pattern';
    /** Optional ranked style preferences, e.g. `["极简主义", "玻璃拟态"]`. */
    readonly stylePriority?: readonly string[];
    /** Anti-pattern ids this pattern must avoid (`AP-0001`, …). */
    readonly antiPatterns?: readonly string[];
    /** Pre-delivery checklist items an auditor should verify. */
    readonly checklist?: readonly string[];
    /** App-type / platform / style indexes used by retrieval filters. */
    readonly dimensions?: DesignDimensions;
    /** Brand payload when `source.kind === 'brand'`. */
    readonly brand?: DesignBrand;
}
/** `manifest.json`. */
export interface DesignManifest {
    readonly schemaVersion: 1;
    readonly engineVersion: string;
    readonly updatedAt: string;
    readonly counts: {
        readonly cards: number;
        readonly chunks: number;
    };
    readonly cards: readonly DesignCard[];
}
/** One chunk line in `chunks.jsonl`. */
export interface DesignChunk {
    readonly chunkId: string;
    readonly cardId: string;
    readonly section: DesignSection;
    readonly text: string;
    readonly sha: string;
}
/** `index.json` — deterministic, rebuildable cache over the chunks. */
export interface DesignIndex {
    readonly schemaVersion: 1;
    readonly engineVersion: string;
    readonly builtAt: string;
    readonly totalChunks: number;
    readonly avgLen: number;
    readonly chunks: ReadonlyArray<{
        readonly chunkId: string;
        readonly cardId: string;
        readonly section: DesignSection;
        readonly len: number;
    }>;
    readonly postings: Readonly<Record<string, ReadonlyArray<readonly [string, number]>>>;
    readonly df: Readonly<Record<string, number>>;
}
/** One ranked result. */
export interface DesignSearchHit {
    readonly cardId: string;
    readonly title: string;
    readonly kind: 'pattern' | 'anti-pattern' | 'brand';
    readonly score: number;
    readonly breakdown: {
        readonly bm25: number;
        readonly tokenBoost: number;
        readonly tagBoost: number;
        readonly profileBoost: number;
        readonly weight: number;
    };
    readonly snippet: string;
    readonly tokens: DesignTokens;
    readonly source: DesignSource;
    readonly images: DesignCard['images'];
}
/** Retrieval filters applied before ranking (0.6.3 A/B). */
export interface DesignSearchFilters {
    readonly appType?: string;
    readonly platform?: string;
    readonly style?: string;
    /** `pattern` (default) excludes anti-pattern and brand cards. */
    readonly kind?: 'pattern' | 'anti-pattern' | 'brand';
}
/** The effective kind of a card, matching the `search` filter vocabulary. */
export declare function designCardKind(card: DesignCard): 'pattern' | 'anti-pattern' | 'brand';
/** `search` output; the generated CLI prints the same shape. */
export interface DesignSearchResult {
    readonly schemaVersion: 1;
    readonly query: string;
    readonly ranker: 'lexical' | 'hybrid';
    readonly requestedRanker: 'lexical' | 'hybrid';
    readonly totalChunks: number;
    readonly notes: readonly string[];
    readonly results: readonly DesignSearchHit[];
}
/** Raised when the library on disk cannot be read or is inconsistent. */
export declare class DesignLibraryError extends Error {
}
/** Collapse whitespace and lowercase for stable hashing and indexing. */
export declare function normalizeDesignText(text: string): string;
/**
 * Tokenize English/number spans as words and CJK spans as bigrams.
 * @param text - query or chunk text.
 */
export declare function tokenizeDesignText(text: string): string[];
/** Expand query tokens with the curated design-vocabulary synonyms. */
export declare function expandDesignQuery(tokens: readonly string[]): string[];
/** The query's numeric/colour constraints (used for the token boost). */
export declare function designQueryConstraints(query: string): {
    readonly numbers: ReadonlyArray<{
        value: number;
        unit: string;
    }>;
    readonly colors: readonly string[];
};
/** Build the retrievable chunks for one card, in deterministic section order. */
export declare function cardChunks(card: DesignCard): DesignChunk[];
/** Flatten every card into chunks, ordered by card id then section order. */
export declare function buildDesignChunks(manifest: DesignManifest): DesignChunk[];
/** Build the deterministic BM25 index from chunks. */
export declare function buildDesignIndex(chunks: readonly DesignChunk[], builtAt: string): DesignIndex;
/** Read the manifest; a corrupt file is an error, never an empty library. */
export declare function readDesignManifest(paths: SharedPaths): Promise<DesignManifest | null>;
/** Read index + chunks for searching; both must exist. */
export declare function readDesignIndex(paths: SharedPaths): Promise<{
    index: DesignIndex;
    chunks: readonly DesignChunk[];
}>;
/** Next free id in the card's namespace (`DSG-*` patterns/brands, `AP-*` anti-patterns). */
export declare function nextDesignId(cards: readonly DesignCard[], kind?: 'pattern' | 'anti-pattern'): string;
/** Create the library skeleton (idempotent) and the read-only query CLI. */
export declare function initDesignLibrary(paths: SharedPaths, now: string): Promise<{
    manifest: DesignManifest;
    created: boolean;
    files: string[];
}>;
/** Cards seeded from the rule catalog's aesthetic rules. */
export declare function ruleCards(existing: readonly DesignCard[], now: string): DesignCard[];
/** Normalize a model/user supplied token object. */
export declare function normalizeTokens(raw: unknown): DesignTokens;
/** Ingest `inbox/*.meta.json` into cards, copying referenced images into refs/. */
export declare function inboxCards(paths: SharedPaths, existing: readonly DesignCard[], now: string): Promise<{
    cards: DesignCard[];
    skipped: number;
    warnings: string[];
    files: string[];
}>;
/** Result of `ingestDesignLibrary`. */
export interface DesignIngestResult {
    readonly manifest: DesignManifest;
    readonly added: readonly DesignCard[];
    readonly skipped: number;
    readonly warnings: readonly string[];
    readonly files: string[];
    readonly changed: boolean;
}
/**
 * Ingest rules and/or inbox cards, then rebuild chunks + index.
 * A no-op ingest (nothing new) does not rewrite a single byte (RAG-A).
 */
export declare function ingestDesignLibrary(paths: SharedPaths, sources: ReadonlyArray<'rules' | 'inbox'>, now: string): Promise<DesignIngestResult>;
/** Areas a card speaks to (token keys plus tag vocabulary). */
export declare function cardAreas(card: DesignCard): Set<AestheticArea>;
/**
 * Rank cards for a query with BM25 + structured boosts.
 *
 * `hybrid` is accepted by the interface but falls back to lexical in 0.6.2 P0;
 * the result records both so a report can say which ranking actually ran.
 */
export declare function searchDesignLibrary(manifest: DesignManifest, index: DesignIndex, chunks: readonly DesignChunk[], query: string, options: {
    readonly topK: number;
    readonly ranker: Options['designRanker'];
    readonly licenseRequired: boolean;
    readonly profileAreas?: ReadonlySet<AestheticArea>;
    /** Retrieval filters (kind defaults to `pattern`). */
    readonly filters?: DesignSearchFilters;
}): DesignSearchResult;
/** Render a design search result as markdown (used by the tool and the CLI). */
export declare function renderDesignSearchMarkdown(result: DesignSearchResult): string;
/** Render the full card table for `library list`. */
export declare function renderDesignCardsMarkdown(manifest: DesignManifest): string;
/** One-line token summary used by spec/audit reports (0.6.2 P2). */
export declare function designCardTokenSummary(card: DesignCard): string;
/** One targeted suggestion for a failed aesthetic criterion (0.6.3 F). */
export interface DesignReworkSuggestion {
    readonly criterionId: string;
    /** The query the next brief should reuse. */
    readonly query: string;
    /** Design cards already referenced by the criterion. */
    readonly refs: readonly string[];
    readonly reason?: string;
}
/** Persisted between a failed audit and the next design brief. */
export interface DesignReworkQueue {
    readonly schemaVersion: 1;
    readonly specVersion: number;
    readonly auditId: number;
    readonly createdAt: string;
    readonly suggestions: readonly DesignReworkSuggestion[];
}
/** Persist the rework suggestions for the next brief. */
export declare function writeDesignReworkQueue(paths: SharedPaths, queue: DesignReworkQueue): Promise<string>;
/** Read rework suggestions, scoped to the current pack version. */
export declare function readDesignReworkQueue(paths: SharedPaths, specVersion: number): Promise<DesignReworkQueue | null>;
/** Drop rework suggestions once the round passes or a new pack starts. */
export declare function clearDesignReworkQueue(paths: SharedPaths): Promise<void>;
/** Result of generating a design brief. */
export interface DesignBriefResult {
    readonly file: string;
    readonly query: string;
    readonly hits: readonly DesignSearchHit[];
    readonly brands: readonly DesignCard[];
    readonly result: DesignSearchResult;
    /** Targeted retrieval driven by the previous failed aesthetic audit. */
    readonly rework?: {
        readonly suggestions: readonly DesignReworkSuggestion[];
        readonly hits: readonly DesignSearchHit[];
        readonly cards: readonly DesignCard[];
    };
}
/** Render `tasks/design-brief.md`. */
export declare function renderDesignBriefMarkdown(pack: TaskPack, result: DesignSearchResult, cards: readonly DesignCard[], brands: readonly DesignCard[], now: string, rework?: {
    readonly suggestions: readonly DesignReworkSuggestion[];
    readonly cards: readonly DesignCard[];
}): string;
/**
 * Generate the design brief for the current pack and write it to disk.
 * Throws {@link DesignLibraryError} when the library is missing.
 */
export declare function generateDesignBrief(paths: SharedPaths, options: Options, pack: TaskPack, now: string): Promise<DesignBriefResult>;
/** Feedback verdicts a card can receive (0.6.2 P3). */
export declare const DESIGN_FEEDBACK_VERDICTS: readonly ["useful", "off", "block", "unblock"];
/** One feedback verdict. */
export type DesignFeedbackVerdict = (typeof DESIGN_FEEDBACK_VERDICTS)[number];
/** One feedback entry supplied by the user. */
export interface DesignFeedbackInput {
    readonly cardId: string;
    readonly verdict: DesignFeedbackVerdict;
    readonly note?: string;
}
/** Outcome of applying feedback. */
export interface DesignFeedbackResult {
    readonly manifest: DesignManifest;
    readonly applied: ReadonlyArray<{
        cardId: string;
        verdict: DesignFeedbackVerdict;
        weight: number;
        status: 'active' | 'blocked';
    }>;
    readonly skipped: readonly string[];
    readonly files: string[];
    readonly changed: boolean;
}
/**
 * Apply `useful / off / block / unblock` feedback.
 *
 * Weight moves inside 0.5–1.5 (useful ×1.1, off ×0.8); block hides the card from
 * search but keeps it in the manifest, and every verdict is appended to
 * `feedback.jsonl` (never deleted).
 */
export declare function applyDesignFeedback(paths: SharedPaths, manifest: DesignManifest, entries: readonly DesignFeedbackInput[], now: string): Promise<DesignFeedbackResult>;
/** One captured project card request (0.6.2 P3). */
export interface CaptureDesignInput {
    readonly page: string;
    readonly state: string;
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly note?: string;
}
/** Outcome of `captureDesignCard`. */
export interface CaptureDesignResult {
    readonly manifest: DesignManifest;
    readonly card: DesignCard;
    readonly changed: boolean;
    readonly files: string[];
}
/**
 * Capture a passing baseline as a `project` card.
 *
 * The caller (tool) is responsible for the prerequisites: a passing audit for
 * the current pack version, a user confirmation, and the baseline entry itself.
 */
export declare function captureDesignCard(paths: SharedPaths, manifest: DesignManifest, specVersion: number, input: CaptureDesignInput, now: string): Promise<CaptureDesignResult>;
/** Generate the dependency-free read-only query CLI (same ranking as the tool). */
export declare function renderQueryCli(): string;
