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
import { type ClipConfig } from './image.js';
import type { TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
/** Version stamped into the manifest/index so a future format change is visible. */
export declare const DESIGN_ENGINE_VERSION = "0.7.0";
/** The card sections that become retrievable chunks. */
export declare const DESIGN_SECTIONS: readonly ["tokens", "rationale", "dos", "donts", "style", "antiPatterns", "checklist", "brand", "principle", "context"];
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
/** Layout density a card is designed for (0.6.8). */
export type DesignDensity = 'low' | 'medium' | 'high';
/** Colour character derived from `tokens.palette` (0.6.8; not hand-written). */
export interface DesignColorProfile {
    readonly temperature: 'warm' | 'cool' | 'neutral';
    readonly contrast: 'low' | 'medium' | 'high';
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
    /** `pattern` (default), `anti-pattern`, or `principle`; anti-pattern ids use AP-*, principles PR-*. */
    readonly kind?: 'pattern' | 'anti-pattern' | 'principle';
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
    /** Principle statement (`kind: principle`), e.g. `留白是注意力预算`. */
    readonly principle?: string;
    /** Perceptual effect the principle is meant to produce. */
    readonly perceptualEffect?: string;
    /** Measurable proxies that make the principle testable. */
    readonly proxies?: readonly string[];
    /** UI contexts where the principle applies. */
    readonly applications?: readonly string[];
    /** Common misuses of the principle (anti-patterns in prose). */
    readonly misuses?: readonly string[];
    /** Use-case tags such as `member-center` / `dashboard` / `onboarding` (0.6.8). */
    readonly moduleTags?: readonly string[];
    /** Mood tags such as `calm` / `energetic` / `luxury` (0.6.8). */
    readonly tone?: readonly string[];
    /** Information density the card is intended for (0.6.8). */
    readonly density?: DesignDensity;
    /** Derived from the palette; never hand-written (0.6.8). */
    readonly colorProfile?: DesignColorProfile;
    /** Relative `.shared` path to an HTML visual reference (0.6.8); not production code. */
    readonly preview?: string;
    /** Name of the accepted paradigm pack this project card represents (0.6.8 learning). */
    readonly packRef?: string;
    /** Source card ids that make up the paradigm pack (0.6.8 learning). */
    readonly componentIds?: readonly string[];
    /** Set when a newer paradigm pack supersedes this one (0.7.0). */
    readonly supersededBy?: string;
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
    readonly kind: 'pattern' | 'anti-pattern' | 'brand' | 'principle';
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
    /** Cosine-based semantic score when hybrid rerank ran (0.6.4). */
    readonly semanticScore?: number;
    /** Weight used for the semantic blend (0.6.4). */
    readonly rerankWeight?: number;
}
/** Retrieval filters applied before ranking (0.6.3 A/B, 0.6.7 principle). */
export interface DesignSearchFilters {
    readonly appType?: string;
    readonly platform?: string;
    readonly style?: string;
    /** `pattern` (default) excludes anti-pattern, brand and principle cards. */
    readonly kind?: 'pattern' | 'anti-pattern' | 'brand' | 'principle';
    /** Match any `moduleTags` entry (0.6.8). */
    readonly module?: string;
    /** Match any `tone` entry (0.6.8). */
    readonly tone?: string;
    /** Exact density match (0.6.8). */
    readonly density?: DesignDensity;
}
/** The effective kind of a card, matching the `search` filter vocabulary. */
export declare function designCardKind(card: DesignCard): 'pattern' | 'anti-pattern' | 'brand' | 'principle';
/** Anti-pattern ids a referenced design card contributes to an audit checklist (0.6.5). */
export declare function inheritedAntiPatterns(card: DesignCard | undefined): string[];
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
/** Derive `colorProfile` from the palette (0.6.8); no palette means no profile. */
export declare function deriveColorProfile(tokens: DesignTokens): DesignColorProfile | undefined;
/** Normalize a `.shared`-relative HTML preview path (0.6.8). */
export declare function normalizePreviewPath(raw: unknown): string | undefined | null;
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
/** Persist a manifest and rebuild chunks/index (used by capture-pack, 0.6.8). */
export declare function writeDesignLibrary(paths: SharedPaths, manifest: DesignManifest): Promise<string[]>;
/** Next free id in the card's namespace (`DSG-*`, `AP-*`, `PR-*`). */
export declare function nextDesignId(cards: readonly DesignCard[], kind?: 'pattern' | 'anti-pattern' | 'principle'): string;
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
/** Safe ASCII file slug for pack card files (0.7.0). */
export declare function slugifyDesign(value: string): string;
/** Convert an internal card into an inbox-compatible meta (portable, no ids/status). */
export declare function designCardToInboxMeta(card: DesignCard): Record<string, unknown>;
/** Embedding endpoint settings for hybrid rerank (0.6.4). */
export interface DesignEmbeddingConfig {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly weight: number;
}
/** A batch embedding function (tests inject a stub). */
export type DesignEmbedder = (texts: readonly string[]) => Promise<number[][]>;
/** Create an OpenAI-compatible `/embeddings` client. */
export declare function createHttpEmbedder(config: DesignEmbeddingConfig): DesignEmbedder;
/** Cosine similarity; zero vectors score 0. */
export declare function cosineSimilarity(left: readonly number[], right: readonly number[]): number;
/** `embeddings.json` cache so repeated briefs do not re-embed the same text. */
export interface DesignEmbeddingCache {
    schemaVersion: 1;
    model: string;
    vectors: Record<string, readonly number[]>;
}
/** Cache key for one text (model-scoped). */
export declare function embeddingCacheKey(model: string, text: string): string;
/** Wrap an embedder with the on-disk cache (mutates `cache`). */
export declare function createCachedEmbedder(embed: DesignEmbedder, cache: DesignEmbeddingCache, model: string): DesignEmbedder;
/** Load the embedding cache for a model (empty when missing/mismatched). */
export declare function loadDesignEmbeddingCache(paths: SharedPaths, model: string): Promise<DesignEmbeddingCache>;
/** Persist the embedding cache. */
export declare function saveDesignEmbeddingCache(paths: SharedPaths, cache: DesignEmbeddingCache): Promise<void>;
/**
 * Rerank candidates with precomputed cosine vectors (0.6.6; shared by recall).
 *
 * Final score blends normalized lexical score with `(cosine + 1) / 2`; the
 * original `breakdown` is kept so the report still shows why a card was retrieved.
 */
export declare function rerankDesignHitsWithVectors(candidates: readonly DesignSearchHit[], queryVector: readonly number[], vectors: ReadonlyMap<string, readonly number[]>, options: {
    readonly weight: number;
    readonly model: string;
}): {
    readonly results: DesignSearchHit[];
    readonly notes: string[];
};
/** Rerank lexical candidates with cosine similarity (0.6.4; embed the candidates itself). */
export declare function rerankDesignHits(candidates: readonly DesignSearchHit[], query: string, embed: DesignEmbedder, options: {
    readonly weight: number;
    readonly model: string;
}): Promise<{
    readonly results: DesignSearchHit[];
    readonly notes: string[];
}>;
/** Text used to embed a whole card for semantic recall (0.6.6). */
export declare function cardEmbeddingText(card: DesignCard): string;
/**
 * Lexical search, optionally expanded with a semantic candidate pool and
 * reranked (0.6.4/0.6.6).
 *
 * The hybrid path is deliberately confined to the DSH tool: `query.mjs` stays
 * lexical (no endpoint/credentials), and the brief says so.
 */
export declare function searchDesignWithRanker(paths: SharedPaths, options: Options, manifest: DesignManifest, index: DesignIndex, chunks: readonly DesignChunk[], query: string, topK: number, extra: {
    readonly licenseRequired: boolean;
    readonly profileAreas?: ReadonlySet<AestheticArea>;
    readonly filters?: DesignSearchFilters;
}): Promise<DesignSearchResult>;
/** One card matching a query image/text (0.6.4/0.6.5). */
export interface DesignImageHit {
    readonly cardId: string;
    readonly title: string;
    readonly score: number;
    /** pHash component (undefined for text→image). */
    readonly hashDistance?: number;
    readonly hashSimilarity?: number;
    readonly histogramSimilarity?: number;
    /** CLIP cosine normalized to 0–1 (undefined when CLIP is off). */
    readonly clipScore?: number;
    readonly license: string;
    readonly imagePath: string;
}
/** Result of `search` with an `image` or `imageText` argument. */
export interface DesignImageSearchResult {
    readonly query: {
        readonly width?: number;
        readonly height?: number;
        readonly phash?: string;
        readonly text?: string;
    };
    readonly results: readonly DesignImageHit[];
    readonly notes: readonly string[];
}
/**
 * Rank cards by perceptual similarity to a query PNG (0.6.4).
 * With a CLIP config the final score blends pHash and multimodal similarity.
 */
export declare function searchDesignByImage(paths: SharedPaths, manifest: DesignManifest, queryPath: string, topK: number, options: {
    readonly licenseRequired: boolean;
    readonly clip?: {
        readonly config: ClipConfig;
        readonly weight: number;
    };
}): Promise<DesignImageSearchResult>;
/** Text→image search via the CLIP endpoint (0.6.5). */
export declare function searchDesignByText(paths: SharedPaths, manifest: DesignManifest, text: string, topK: number, options: {
    readonly licenseRequired: boolean;
    readonly clip: {
        readonly config: ClipConfig;
        readonly weight: number;
    };
}): Promise<DesignImageSearchResult>;
/** Render the image/text-search result table. */
export declare function renderDesignImageSearchMarkdown(result: DesignImageSearchResult): string;
/** Default global directory for cross-project design packs (0.6.5). */
export declare function defaultDesignPacksDir(): string;
/** Audit + confirmation evidence attached to a paradigm pack. */
export interface DesignPackEvidence {
    readonly auditReport: string;
    readonly auditSha256: string;
    readonly auditPass: boolean;
    readonly confirmation: string;
    readonly confirmationSha256: string;
    readonly userDecision: string;
}
/** Pack-level feedback (0.7.0). */
export interface DesignPackFeedback {
    readonly useful: number;
    readonly off: number;
    /** Bounded score added to recommendation ranking (useful +, off −). */
    readonly score: number;
}
/** One exported design pack. */
export interface DesignPack {
    readonly schemaVersion: 1 | 2;
    readonly name: string;
    readonly createdAt: string;
    readonly engineVersion: string;
    readonly cards: readonly DesignCard[];
    /** Paradigm metadata (0.6.8 learning; optional for older packs). */
    readonly status?: 'draft' | 'paradigm' | 'superseded';
    readonly specVersion?: number;
    readonly requirement?: string;
    readonly module?: string;
    readonly appType?: string;
    readonly platform?: string;
    readonly tone?: string;
    readonly density?: DesignDensity;
    readonly brandColors?: readonly string[];
    readonly preview?: string;
    readonly why?: readonly string[];
    readonly cost?: readonly string[];
    readonly cardFiles?: ReadonlyArray<{
        readonly file: string;
        readonly sourceId: string;
        readonly role: string;
    }>;
    readonly evidence?: DesignPackEvidence;
    readonly supersedes?: string;
    readonly supersededBy?: string;
    readonly feedback?: DesignPackFeedback;
}
/** Local pack registry entry (`.shared/design-packs/index.json`, 0.7.0). */
export interface DesignPackRegistryEntry {
    readonly name: string;
    readonly status: 'draft' | 'paradigm' | 'superseded';
    readonly createdAt: string;
    readonly specVersion?: number;
    readonly module?: string;
    readonly appType?: string;
    readonly platform?: string;
    readonly tone?: string;
    readonly density?: DesignDensity;
    readonly preview?: string;
    readonly cardIds: readonly string[];
    readonly evidence?: DesignPackEvidence;
    readonly supersedes?: string;
    readonly supersededBy?: string;
    readonly feedback?: DesignPackFeedback;
}
/** Independent local pack registry. */
export interface DesignPackRegistry {
    readonly schemaVersion: 1;
    readonly updatedAt: string;
    readonly packs: readonly DesignPackRegistryEntry[];
}
/** One row of `pack list`. */
export interface DesignPackSummary {
    readonly name: string;
    readonly cards: number;
    readonly createdAt: string;
    readonly path: string;
    readonly schemaVersion?: 1 | 2;
    readonly status?: 'draft' | 'paradigm' | 'superseded';
    readonly module?: string;
    readonly tone?: string;
    readonly supersedes?: string;
    readonly supersededBy?: string;
    readonly feedback?: DesignPackFeedback;
}
/** Result of `pack export`. */
export interface DesignPackExportResult {
    readonly dir: string;
    readonly pack: DesignPack;
    readonly warnings: readonly string[];
}
/** Result of `pack import`. */
export interface DesignPackImportResult {
    readonly manifest: DesignManifest;
    readonly imported: readonly DesignCard[];
    readonly skipped: number;
    readonly files: string[];
    readonly changed: boolean;
}
/** Validate a pack name (safe as a directory name). */
export declare function isDesignPackName(value: string): boolean;
/** List packs in the global directory (invalid packs are skipped). */
export declare function listDesignPacks(dir: string): Promise<DesignPackSummary[]>;
/** Export active cards (and their images) into `<dir>/<name>/pack.json`. */
export declare function exportDesignPack(paths: SharedPaths, dir: string, manifest: DesignManifest, name: string, now: string): Promise<DesignPackExportResult>;
/** Read and validate a pack; returns null when missing/invalid. */
export declare function readDesignPack(dir: string, name: string): Promise<DesignPack | null>;
/** Read the local pack registry (0.7.0); null when it does not exist yet. */
export declare function readDesignPackRegistry(paths: SharedPaths): Promise<DesignPackRegistry | null>;
/** Persist the local pack registry. */
export declare function writeDesignPackRegistry(paths: SharedPaths, registry: DesignPackRegistry): Promise<string>;
/** Rebuild the registry from local pack directories, preserving feedback/supersede state. */
export declare function rebuildDesignPackRegistry(paths: SharedPaths, now: string): Promise<DesignPackRegistry>;
/** Migrate a v1 pack to v2 (draft unless it already has evidence). */
export declare function migrateDesignPack(dir: string, name: string): Promise<DesignPack>;
/** Import a pack into the local library (new ids, deduped by semantic key). */
export declare function importDesignPack(paths: SharedPaths, dir: string, name: string, now: string): Promise<DesignPackImportResult>;
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
    /** Principle cards that set the direction (0.6.7). */
    readonly principles: readonly DesignCard[];
    readonly result: DesignSearchResult;
    /** Targeted retrieval driven by the previous failed aesthetic audit. */
    readonly rework?: {
        readonly suggestions: readonly DesignReworkSuggestion[];
        readonly hits: readonly DesignSearchHit[];
        readonly cards: readonly DesignCard[];
    };
}
/** Render `tasks/design-brief.md`. */
export declare function renderDesignBriefMarkdown(pack: TaskPack, result: DesignSearchResult, cards: readonly DesignCard[], brands: readonly DesignCard[], principles: readonly DesignCard[], now: string, rework?: {
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
