/** Decoded true-colour image. */
export interface DecodedImage {
    readonly width: number;
    readonly height: number;
    /** RGBA, 4 bytes per pixel. */
    readonly rgba: Buffer;
}
/** Perceptual features used for "search by image". */
export interface ImageFeatures {
    /** 16-hex-char DCT pHash. */
    readonly phash: string;
    /** 64 normalized bins (4 per RGB channel). */
    readonly histogram: readonly number[];
}
/** Similarity between two feature sets. */
export interface ImageSimilarity {
    readonly score: number;
    readonly hashDistance: number;
    readonly hashSimilarity: number;
    readonly histogramSimilarity: number;
}
/**
 * Decode an 8-bit non-interlaced PNG into RGBA.
 * @param buffer - raw PNG bytes.
 */
export declare function decodePng(buffer: Buffer): DecodedImage;
/** Compute DCT pHash + RGB histogram. */
export declare function imageFeatures(image: DecodedImage): ImageFeatures;
/** Hamming distance between two 16-hex pHashes (0–64). */
export declare function hashDistance(left: string, right: string): number;
/** Score two feature sets: 60% pHash similarity + 40% histogram intersection. */
export declare function imageSimilarity(left: ImageFeatures, right: ImageFeatures): ImageSimilarity;
/** Optional multimodal (CLIP-style) embedding endpoint (0.6.5/0.6.6). */
export interface ClipConfig {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    /** `custom` = our documented {images,texts} contract; `dashscope` = native contents API. */
    readonly provider?: 'custom' | 'dashscope';
    /** Optional embedding model version; part of the cache identity. */
    readonly modelVersion?: string;
}
/** Cache identity for a multimodal endpoint. */
export declare function clipIdentity(config: ClipConfig): string;
/** DashScope native multimodal embedding endpoint (not supported by compatible mode). */
export declare const DASHSCOPE_MULTIMODAL_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
/** Text-only embedder backed by DashScope's native multimodal endpoint (0.6.6). */
export declare function createDashScopeTextEmbedder(config: {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
}): Promise<(texts: readonly string[]) => Promise<number[][]>>;
/** One CLIP embedding response. */
export interface ClipEmbeddings {
    readonly imageEmbeddings: readonly (readonly number[])[];
    readonly textEmbeddings: readonly (readonly number[])[];
}
/**
 * Call a multimodal embedding endpoint.
 *
 * `dashscope` follows the native multimodal-embedding API:
 * `POST {model, input:{contents:[{text}|{image}]}}` → `{output:{embeddings:[{index,embedding}]}}`.
 * `custom` follows `POST {model, images?: [dataUrl], texts?: [string]}` →
 * `{imageEmbeddings?: number[][], textEmbeddings?: number[][]}`.
 */
export declare function createClipClient(config: ClipConfig): Promise<(request: {
    readonly images?: readonly Buffer[];
    readonly texts?: readonly string[];
}) => Promise<ClipEmbeddings>>;
