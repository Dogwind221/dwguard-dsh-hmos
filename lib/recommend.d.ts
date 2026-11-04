import type { Options } from './config.js';
import type { DesignDensity } from './design.js';
import { type DesignPackRegistryEntry } from './design.js';
import type { SharedPaths } from './paths.js';
/** Input for `dwguard_design recommend` (0.6.8). */
export interface DesignRecommendInput {
    readonly requirement: string;
    readonly module?: string;
    readonly appType?: string;
    readonly platform?: string;
    readonly tone?: string;
    readonly density?: DesignDensity;
    readonly brandColors?: readonly string[];
    readonly topK?: number;
    /** Recommendation benchmark uses false to avoid overwriting tasks/design-options.md. */
    readonly persist?: boolean;
}
/** One recommended direction. */
export interface DesignRecommendOption {
    readonly id: string;
    readonly title: string;
    readonly patternIds: readonly string[];
    readonly principleIds: readonly string[];
    readonly antiPatternIds: readonly string[];
    readonly score: number;
    readonly why: readonly string[];
    readonly cost: readonly string[];
    readonly preview?: string;
    readonly module?: string;
    readonly appType?: string;
    readonly platform?: string;
    readonly tone?: string;
    readonly density?: DesignDensity;
    /** Present when this option represents an accepted paradigm pack (0.6.8 learning). */
    readonly packRef?: string;
    readonly componentIds?: readonly string[];
}
/** Persisted recommendations consumed by `capture-pack`. */
export interface DesignRecommendation {
    readonly schemaVersion: 1;
    readonly createdAt: string;
    readonly specVersion: number;
    readonly requirement: string;
    readonly module?: string;
    readonly appType?: string;
    readonly platform?: string;
    readonly tone?: string;
    readonly density?: DesignDensity;
    readonly brandColors: readonly string[];
    readonly options: readonly DesignRecommendOption[];
}
/** Result of `recommendDesign`. */
export interface DesignRecommendResult {
    readonly file: string;
    readonly recommendation: DesignRecommendation;
}
/** Input for `captureDesignPack`. */
export interface CapturePackInput {
    readonly choice: string;
    readonly name: string;
    readonly preview?: string;
    readonly supersedes?: string;
    /** Latest passed audit + user confirmation hashes (0.6.8 learning gate). */
    readonly evidence: CapturePackEvidence;
}
/** Evidence that a paradigm pack passed the four-dimension gate. */
export interface CapturePackEvidence {
    readonly auditReport: string;
    readonly auditSha256: string;
    readonly auditPass: true;
    readonly confirmation: string;
    readonly confirmationSha256: string;
    readonly userDecision: string;
}
/** Result of `captureDesignPack`. */
export interface CapturePackResult {
    readonly dir: string;
    readonly readme: string;
    readonly cardId: string;
    readonly preview?: string;
    readonly files: string[];
}
/** Recommend up to 3 diverse directions from the library (0.6.8). */
export declare function recommendDesign(paths: SharedPaths, options: Options, specVersion: number, input: DesignRecommendInput, now: string): Promise<DesignRecommendResult>;
/** Result of pack-level feedback. */
export interface PackFeedbackResult {
    readonly entry: DesignPackRegistryEntry;
    readonly cardId?: string;
    readonly files: string[];
}
/** Apply useful/off to a pack: registry score + learned card weight (bounded). */
export declare function applyPackFeedback(paths: SharedPaths, packName: string, verdict: 'useful' | 'off', note: string | undefined, now: string): Promise<PackFeedbackResult>;
/** One recommendation benchmark query (0.7.0). */
export interface RecommendBenchmarkQuery extends Omit<DesignRecommendInput, 'persist' | 'topK'> {
    readonly id: string;
    readonly expectPack?: string;
    readonly expectCard?: string;
}
/** Recommendation benchmark suite (0.7.0). */
export interface RecommendBenchmarkSuite {
    readonly schemaVersion: 1;
    readonly queries: readonly RecommendBenchmarkQuery[];
}
/** Per-query benchmark row. */
export interface RecommendBenchmarkRow {
    readonly id: string;
    readonly expected: string;
    readonly hit: boolean;
    readonly rank?: number;
    readonly actual: readonly string[];
}
/** Result of evaluating a recommendation benchmark. */
export interface RecommendBenchmarkResult {
    readonly file: string;
    readonly total: number;
    readonly hits: number;
    readonly hitRate: number;
    readonly rows: readonly RecommendBenchmarkRow[];
}
/** Evaluate top-3 pack/card hit rate against a recommendation suite (0.7.0). */
export declare function evaluateRecommendBenchmark(paths: SharedPaths, options: Options, specVersion: number, suite: RecommendBenchmarkSuite, now: string): Promise<RecommendBenchmarkResult>;
/** Freeze the selected recommendation into a local design pack (0.6.8). */
export declare function captureDesignPack(paths: SharedPaths, specVersion: number, input: CapturePackInput, now: string): Promise<CapturePackResult>;
