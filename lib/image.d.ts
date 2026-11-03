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
/** Optional multimodal (CLIP-style) embedding endpoint (0.6.5). */
export interface ClipConfig {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
}
/** One CLIP embedding response. */
export interface ClipEmbeddings {
    readonly imageEmbeddings: readonly (readonly number[])[];
    readonly textEmbeddings: readonly (readonly number[])[];
}
/**
 * Call a multimodal embedding endpoint with one documented contract:
 * `POST {model, images?: [dataUrl], texts?: [string]}` →
 * `{imageEmbeddings?: number[][], textEmbeddings?: number[][]}`.
 */
export declare function createClipClient(config: ClipConfig): Promise<(request: {
    readonly images?: readonly Buffer[];
    readonly texts?: readonly string[];
}) => Promise<ClipEmbeddings>>;
