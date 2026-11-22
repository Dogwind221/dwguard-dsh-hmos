/**
 * Screenshot regression: decode baseline/current PNGs, compute perceptual
 * (pHash) and pixel metrics, and optionally render a diff image.
 *
 * Zero dependencies: uses the PNG decoder/features in `image.ts` and a minimal
 * RGBA PNG encoder below. Metrics are evidence; thresholds decide `pass`.
 *
 * @module dwguard-dsh-hmos/imageDiff
 */
import { type DecodedImage } from './image.js';
export interface DiffRegion {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly changedRatio: number;
}
export interface ImageDiffResult {
    readonly width: number;
    readonly height: number;
    readonly baselineDimensions: {
        readonly width: number;
        readonly height: number;
    };
    readonly currentDimensions: {
        readonly width: number;
        readonly height: number;
    };
    readonly dimensionMismatch: boolean;
    readonly phashDistance: number;
    readonly similarity: number;
    readonly changedPixels: number;
    readonly totalPixels: number;
    readonly changedRatio: number;
    readonly meanAbsDiff: number;
    readonly maxAbsDiff: number;
    readonly pixelThreshold: number;
    readonly passRatio: number;
    readonly pass: boolean;
    readonly regions: readonly DiffRegion[];
    readonly notes: readonly string[];
}
/** Encode RGBA pixels as a non-interlaced 8-bit PNG (filter 0). */
export declare function encodePng(width: number, height: number, rgba: Buffer): Buffer;
/** Decode both screenshots and compute perceptual + pixel diff metrics. */
export declare function diffImages(baselinePng: Buffer, currentPng: Buffer, options?: {
    pixelThreshold?: number;
    passRatio?: number;
    regionGrid?: number;
}): {
    result: ImageDiffResult;
    diffPng: Buffer | null;
    baseline: DecodedImage;
    current: DecodedImage;
};
