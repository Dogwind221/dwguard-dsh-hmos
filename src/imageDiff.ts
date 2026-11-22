/**
 * Screenshot regression: decode baseline/current PNGs, compute perceptual
 * (pHash) and pixel metrics, and optionally render a diff image.
 *
 * Zero dependencies: uses the PNG decoder/features in `image.ts` and a minimal
 * RGBA PNG encoder below. Metrics are evidence; thresholds decide `pass`.
 *
 * @module dwguard-dsh-hmos/imageDiff
 */

import { deflateSync, crc32 } from 'node:zlib';

import { decodePng, hashDistance, imageFeatures, imageSimilarity, type DecodedImage } from './image.js';

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
  readonly baselineDimensions: { readonly width: number; readonly height: number };
  readonly currentDimensions: { readonly width: number; readonly height: number };
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

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Encode RGBA pixels as a non-interlaced 8-bit PNG (filter 0). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error('PNG 编码参数不合法');
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Decode both screenshots and compute perceptual + pixel diff metrics. */
export function diffImages(
  baselinePng: Buffer,
  currentPng: Buffer,
  options: { pixelThreshold?: number; passRatio?: number; regionGrid?: number } = {}
): { result: ImageDiffResult; diffPng: Buffer | null; baseline: DecodedImage; current: DecodedImage } {
  const baseline = decodePng(baselinePng);
  const current = decodePng(currentPng);
  const pixelThreshold = Math.max(1, Math.min(options.pixelThreshold ?? 12, 255));
  const passRatio = Math.max(0, Math.min(options.passRatio ?? 0.005, 1));
  const regionGrid = Math.max(2, Math.min(options.regionGrid ?? 4, 12));
  const baselineHash = imageFeatures(baseline).phash;
  const currentHash = imageFeatures(current).phash;
  const phashDistance = hashDistance(baselineHash, currentHash);
  const similarity = imageSimilarity(imageFeatures(baseline), imageFeatures(current)).score;
  const dimensionMismatch = baseline.width !== current.width || baseline.height !== current.height;

  let changedPixels = 0;
  let totalPixels = 0;
  let meanAbsDiff = 0;
  let maxAbsDiff = 0;
  const regions: DiffRegion[] = [];
  let diffPng: Buffer | null = null;

  if (!dimensionMismatch) {
    const width = baseline.width;
    const height = baseline.height;
    const diff = Buffer.alloc(width * height * 4);
    const cells = Array.from({ length: regionGrid * regionGrid }, () => ({ changed: 0, total: 0 }));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const bl = luminance(baseline.rgba[index] ?? 0, baseline.rgba[index + 1] ?? 0, baseline.rgba[index + 2] ?? 0);
        const cl = luminance(current.rgba[index] ?? 0, current.rgba[index + 1] ?? 0, current.rgba[index + 2] ?? 0);
        const delta = Math.abs(bl - cl);
        totalPixels += 1;
        meanAbsDiff += delta;
        if (delta > maxAbsDiff) maxAbsDiff = delta;
        const cellX = Math.min(regionGrid - 1, Math.floor((x / width) * regionGrid));
        const cellY = Math.min(regionGrid - 1, Math.floor((y / height) * regionGrid));
        const cell = cells[cellY * regionGrid + cellX];
        if (cell !== undefined) cell.total += 1;
        if (delta > pixelThreshold) {
          changedPixels += 1;
          if (cell !== undefined) cell.changed += 1;
          diff[index] = 255;
          diff[index + 1] = 0;
          diff[index + 2] = 0;
          diff[index + 3] = 200;
        } else {
          diff[index] = 0;
          diff[index + 1] = 0;
          diff[index + 2] = 0;
          diff[index + 3] = 0;
        }
      }
    }
    meanAbsDiff = totalPixels === 0 ? 0 : Math.round((meanAbsDiff / totalPixels) * 100) / 100;
    for (let row = 0; row < regionGrid; row += 1) {
      for (let column = 0; column < regionGrid; column += 1) {
        const cell = cells[row * regionGrid + column];
        if (cell === undefined || cell.total === 0) continue;
        const ratio = cell.changed / cell.total;
        if (ratio > passRatio) {
          regions.push({
            x: Math.floor((column * width) / regionGrid),
            y: Math.floor((row * height) / regionGrid),
            width: Math.ceil(width / regionGrid),
            height: Math.ceil(height / regionGrid),
            changedRatio: Math.round(ratio * 10000) / 10000
          });
        }
      }
    }
    regions.sort((left, right) => right.changedRatio - left.changedRatio);
    diffPng = encodePng(width, height, diff);
  }

  const changedRatio = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  const pass = !dimensionMismatch && changedRatio <= passRatio && phashDistance <= 12;
  return {
    result: {
      width: baseline.width,
      height: baseline.height,
      baselineDimensions: { width: baseline.width, height: baseline.height },
      currentDimensions: { width: current.width, height: current.height },
      dimensionMismatch,
      phashDistance,
      similarity: Math.round(similarity * 10000) / 10000,
      changedPixels,
      totalPixels,
      changedRatio: Math.round(changedRatio * 10000) / 10000,
      meanAbsDiff,
      maxAbsDiff,
      pixelThreshold,
      passRatio,
      pass,
      regions: regions.slice(0, 8),
      notes: [
        '像素统计在亮度通道上计算；pHash 跨尺寸仍可比较，像素指标要求宽高一致。',
        '差异图只高亮变化像素；阈值与容差按任务包判据设定，不由本工具单独下结论。'
      ]
    },
    diffPng,
    baseline,
    current
  };
}
