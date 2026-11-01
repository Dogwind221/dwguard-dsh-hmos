/**
 * Local official-docs corpus search.
 *
 * The corpus is fetched outside the plugin package (Huawei design docs via
 * scripts/fetch-official-docs.mjs plus a sparse clone of openharmony/docs).
 * `dwguard_rules search` uses this module so a sub-agent can look up the
 * official wording without knowing any path.
 *
 * @module dwguard-dsh-hmos/docs
 */
/** One matching line. */
export interface DocHit {
    /** Path relative to the corpus root. */
    readonly file: string;
    readonly line: number;
    readonly snippet: string;
    /** `source:` frontmatter comment, when the page was fetched with one. */
    readonly sourceUrl?: string;
}
/** Search outcome. */
export interface DocSearch {
    readonly root: string;
    readonly files: number;
    readonly matches: number;
    readonly hits: readonly DocHit[];
}
/** Candidate corpus locations, in priority order. */
export declare function docsCandidates(configured: string, workspace: string): string[];
/** First candidate that exists, or `null`. */
export declare function resolveDocsDir(configured: string, workspace: string): string | null;
/**
 * Substring search over the corpus.
 * @param root - corpus directory.
 * @param query - case-insensitive substring.
 * @param limit - max hits returned.
 */
export declare function searchDocs(root: string, query: string, limit?: number): Promise<DocSearch>;
