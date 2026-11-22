/**
 * Runtime accessibility checks on a live layout tree + screenshot:
 * touch-target sizes from bounds and contrast estimates sampled from text regions.
 *
 * The contrast estimate is approximate (text region luminance range vs. WCAG
 * ratio), not a glyph/background sampling of the actual font colour. Findings are
 * facts for the acceptance criterion, never a verdict.
 *
 * @module dwguard-dsh-hmos/a11yRuntime
 */

import { decodePng } from './image.js';

export interface A11yRuntimeOptions {
  readonly minTouchSize?: number;
  readonly minContrast?: number;
  readonly maxItems?: number;
}

export interface A11yRuntimeFinding {
  readonly kind: 'touch-target' | 'contrast';
  readonly node: string;
  readonly bounds: readonly [number, number, number, number];
  readonly measured: number;
  readonly threshold: number;
  readonly detail: string;
}

export interface A11yRuntimeReport {
  readonly nodes: number;
  readonly clickable: number;
  readonly textNodes: number;
  readonly touchTargetViolations: number;
  readonly contrastViolations: number;
  readonly touchTargets: readonly A11yRuntimeFinding[];
  readonly contrasts: readonly A11yRuntimeFinding[];
  readonly notes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundsOf(node: Record<string, unknown>): [number, number, number, number] | null {
  const raw = node['bounds'];
  if (Array.isArray(raw) && raw.length >= 4) {
    const values = raw.slice(0, 4).map((value) => Number(value));
    if (values.every((value) => Number.isFinite(value))) {
      return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
    }
  }
  if (isRecord(raw)) {
    const left = Number(raw['left'] ?? 0);
    const top = Number(raw['top'] ?? 0);
    const width = Number(raw['width'] ?? (Number(raw['right'] ?? 0) - left));
    const height = Number(raw['height'] ?? (Number(raw['bottom'] ?? 0) - top));
    if ([left, top, width, height].every((value) => Number.isFinite(value))) return [left, top, width, height];
  }
  return null;
}

function luminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(left: number, right: number): number {
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  return (high + 0.05) / (low + 0.05);
}

interface RegionStats {
  readonly min: number;
  readonly max: number;
}

function regionLuminance(
  image: { width: number; height: number; rgba: Buffer },
  bounds: readonly [number, number, number, number]
): RegionStats | null {
  const [x, y, width, height] = bounds;
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(image.width, Math.ceil(x + width));
  const bottom = Math.min(image.height, Math.ceil(y + height));
  if (right <= left || bottom <= top) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  const step = Math.max(1, Math.floor(Math.min(right - left, bottom - top) / 64));
  for (let row = top; row < bottom; row += step) {
    for (let column = left; column < right; column += step) {
      const index = (row * image.width + column) * 4;
      const value = luminance(image.rgba[index] ?? 0, image.rgba[index + 1] ?? 0, image.rgba[index + 2] ?? 0);
      if (value < min) min = value;
      if (value > max) max = value;
      count += 1;
    }
  }
  return count === 0 ? null : { min, max };
}

/** Analyze a layout tree plus screenshot for touch targets and contrast estimates. */
export function analyzeA11yRuntime(
  layout: unknown,
  screenshotPng: Buffer,
  options: A11yRuntimeOptions = {}
): A11yRuntimeReport {
  const minTouchSize = Math.max(1, options.minTouchSize ?? 44);
  const minContrast = Math.max(1, options.minContrast ?? 4.5);
  const maxItems = Math.max(1, options.maxItems ?? 50);
  const image = decodePng(screenshotPng);
  const touchTargets: A11yRuntimeFinding[] = [];
  const contrasts: A11yRuntimeFinding[] = [];
  let nodes = 0;
  let clickable = 0;
  let textNodes = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isRecord(node)) return;
    nodes += 1;
    const bounds = boundsOf(node);
    const label =
      (typeof node['id'] === 'string' && node['id']) ||
      (typeof node['text'] === 'string' && node['text'].slice(0, 40)) ||
      (typeof node['type'] === 'string' && node['type']) ||
      `node-${nodes}`;
    const text = typeof node['text'] === 'string' ? node['text'] : '';
    const isClickable = node['clickable'] === true;
    if (text.length > 0) {
      textNodes += 1;
      if (bounds !== null) {
        const stats = regionLuminance(image, bounds);
        if (stats !== null) {
          const ratio = contrastRatio(stats.max, stats.min);
          if (ratio < minContrast && contrasts.length < maxItems) {
            contrasts.push({
              kind: 'contrast',
              node: label,
              bounds,
              measured: Math.round(ratio * 100) / 100,
              threshold: minContrast,
              detail: `文本区域亮度对比度约 ${String(Math.round(ratio * 100) / 100)}:1（阈值 ${String(minContrast)}）`
            });
          }
        }
      }
    }
    if (isClickable) {
      clickable += 1;
      if (bounds !== null && (bounds[2] < minTouchSize || bounds[3] < minTouchSize) && touchTargets.length < maxItems) {
        touchTargets.push({
          kind: 'touch-target',
          node: label,
          bounds,
          measured: Math.min(bounds[2], bounds[3]),
          threshold: minTouchSize,
          detail: `触控目标 ${String(bounds[2])}×${String(bounds[3])}，小于 ${String(minTouchSize)}`
        });
      }
    }
    if (Array.isArray(node['children'])) walk(node['children']);
  };
  walk(layout);

  return {
    nodes,
    clickable,
    textNodes,
    touchTargetViolations: touchTargets.length,
    contrastViolations: contrasts.length,
    touchTargets,
    contrasts,
    notes: [
      'bounds 单位与布局树一致（通常为 px）；阈值按任务包判据设置，插件不自行判定通过/不通过。',
      '对比度为文本区域亮度范围估算，不是字体颜色/背景色的精确采样；WRGB 采样结果用于发现风险点。'
    ]
  };
}
