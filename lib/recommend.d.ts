import type { Options } from './config.js';
import type { DesignCard, DesignDensity } from './design.js';
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
/** Convert an internal card into an inbox-compatible meta (portable, no ids/status). */
export declare function cardToInboxMeta(card: DesignCard): Record<string, unknown>;
/** Freeze the selected recommendation into a local design pack (0.6.8). */
export declare function captureDesignPack(paths: SharedPaths, specVersion: number, input: CapturePackInput, now: string): Promise<CapturePackResult>;
