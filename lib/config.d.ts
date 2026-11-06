/**
 * Plugin configuration and its defensive normalization.
 *
 * The loader validates this schema before `apply` runs, but `apply` also
 * accepts an empty object (a row with no `config:`), so every field is
 * re-defaulted here instead of trusting the argument.
 *
 * @module dwguard-dsh-hmos/config
 */
import type { DeviceConfig } from './device.js';
/** Loader-facing schema of the `dsh` row's `config` block. */
export declare const Config: any;
/** Fully resolved options used by every tool. */
export interface Options {
    readonly sharedDir: string;
    readonly promptSection: boolean;
    readonly installSkills: boolean;
    readonly minCriteriaPerDimension: number;
    readonly requireRebuttalOnBlocker: boolean;
    readonly requirePrereviewBeforeDispatch: boolean;
    readonly knowledgeMaxEntriesPerTopic: number;
    /** Local official-docs corpus; empty means auto-detect. */
    readonly docsDir: string;
    /** Shadow-review nudge interval in minutes. */
    readonly shadowIntervalMinutes: number;
    /** Minutes without a delivery before the round is reported as stalled. */
    readonly stallMinutes: number;
    /** Executor policy: `auto` = IDE-first; `ide` / `cli` force one. */
    readonly executor: 'auto' | 'ide' | 'cli';
    /** `devecocli` binary; empty means resolve from PATH. */
    readonly devecocliPath: string;
    /** Effective device policy (host memory, mode, matrix scope, pool, lock timeout). */
    readonly device: DeviceConfig;
    /** Design RAG (0.6.2) settings. */
    readonly designTopK: number;
    readonly designMaxChunks: number;
    readonly designRanker: 'lexical' | 'hybrid';
    /** Cards included in `tasks/design-brief.md`. */
    readonly designBriefCards: number;
    /** Brand cards force-injected into every brief. */
    readonly designBrandCards: number;
    /** Principle cards injected into every brief. */
    readonly designPrincipleCards: number;
    /** Audit rounds allowed per round (hard stop). */
    readonly maxAuditRounds: number;
    /** Design searches allowed per round (hard stop). */
    readonly maxDesignSearches: number;
    /** Max attempts for one harness step before a human decision (0.8.0). */
    readonly harnessMaxRetries: number;
    /** MCP fallback command (empty = skip MCP tier). */
    readonly devecoMcpCommand: string;
    /** hdc binary for the hdc+hvigor fallback tier. */
    readonly hdcPath: string;
    /** hvigor binary for the hdc+hvigor fallback tier. */
    readonly hvigorPath: string;
    /** OpenAI-compatible embedding endpoint (empty = lexical only). */
    readonly designEmbeddingEndpoint: string;
    readonly designEmbeddingProvider: 'openai' | 'dashscope';
    readonly designEmbeddingModel: string;
    readonly designEmbeddingApiKeyEnv: string;
    readonly designEmbeddingTimeoutMs: number;
    readonly designEmbeddingWeight: number;
    /** Global directory for cross-project aesthetic templates (empty = default). */
    readonly aestheticTemplatesDir: string;
    /** Global directory for design card packs (empty = default). */
    readonly designPacksDir: string;
    readonly designClipEndpoint: string;
    readonly designClipModel: string;
    readonly designClipProvider: 'custom' | 'dashscope';
    readonly designClipApiKeyEnv: string;
    readonly designClipTimeoutMs: number;
    readonly designClipWeight: number;
    readonly designLicenseRequired: boolean;
}
/**
 * Normalize whatever the loader passed into complete options.
 * @param raw - the row's config value (possibly `undefined`).
 * @returns options with every default applied.
 */
export declare function resolveOptions(raw: unknown): Options;
