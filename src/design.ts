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

import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AestheticArea } from './aesthetic.js';
import { AREA_LABELS, isAestheticArea } from './aesthetic.js';
import type { BaselineEntry } from './baseline.js';
import { baselineDir, extractMetrics, findBaselineEntry, readBaselineIndex, readBoundsJson } from './baseline.js';
import type { Options } from './config.js';
import type { DecodedImage, ImageFeatures } from './image.js';
import { DASHSCOPE_MULTIMODAL_ENDPOINT, createClipClient, createDashScopeTextEmbedder, decodePng, imageFeatures, imageSimilarity, type ClipConfig } from './image.js';
import type { TaskPack } from './model.js';
import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { RULES } from './rules.js';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { appendText, copyFileTo, ensureDir, fileExists, listDir, readTextOrNull, removeFile, sha256File, writeTextAtomic } from './util/fs.js';
import { inline, truncate } from './util/md.js';

/** Version stamped into the manifest/index so a future format change is visible. */
export const DESIGN_ENGINE_VERSION = '0.7.0';

/** The card sections that become retrievable chunks. */
export const DESIGN_SECTIONS = ['tokens', 'rationale', 'dos', 'donts', 'style', 'antiPatterns', 'checklist', 'brand', 'principle', 'context'] as const;

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
  readonly images: ReadonlyArray<{ readonly path: string; readonly sha256?: string; readonly alt?: string }>;
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
  readonly counts: { readonly cards: number; readonly chunks: number };
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
export function designCardKind(card: DesignCard): 'pattern' | 'anti-pattern' | 'brand' | 'principle' {
  if (card.source.kind === 'brand') return 'brand';
  if (card.kind === 'anti-pattern') return 'anti-pattern';
  if (card.kind === 'principle') return 'principle';
  return 'pattern';
}

/** Anti-pattern ids a referenced design card contributes to an audit checklist (0.6.5). */
export function inheritedAntiPatterns(card: DesignCard | undefined): string[] {
  if (card === undefined) return [];
  return [...(card.antiPatterns ?? [])];
}

const NORMALIZE_FILTER = (value: string): string => value.trim().toLowerCase();

function matchesDesignFilters(card: DesignCard, filters: DesignSearchFilters): boolean {
  const kind = filters.kind ?? 'pattern';
  if (designCardKind(card) !== kind) return false;
  if (filters.appType !== undefined) {
    const value = card.dimensions?.appType;
    if (value === undefined || NORMALIZE_FILTER(value) !== NORMALIZE_FILTER(filters.appType)) return false;
  }
  if (filters.platform !== undefined) {
    const value = card.dimensions?.platform;
    if (value === undefined || NORMALIZE_FILTER(value) !== NORMALIZE_FILTER(filters.platform)) return false;
  }
  if (filters.style !== undefined) {
    const wanted = NORMALIZE_FILTER(filters.style);
    const dimension = card.dimensions?.style;
    const ranked = (card.stylePriority ?? []).some((style) => NORMALIZE_FILTER(style) === wanted);
    if ((dimension === undefined || NORMALIZE_FILTER(dimension) !== wanted) && !ranked) return false;
  }
  if (filters.module !== undefined) {
    const wanted = NORMALIZE_FILTER(filters.module);
    if (!(card.moduleTags ?? []).some((tag) => NORMALIZE_FILTER(tag) === wanted)) return false;
  }
  if (filters.tone !== undefined) {
    const wanted = NORMALIZE_FILTER(filters.tone);
    if (!(card.tone ?? []).some((tag) => NORMALIZE_FILTER(tag) === wanted)) return false;
  }
  if (filters.density !== undefined && card.density !== filters.density) return false;
  return true;
}

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
export class DesignLibraryError extends Error {}

const EMPTY_TOKENS: DesignTokens = { palette: [], spacing: [], radius: [], type: [], motion: [] };

const STOP_WORDS = new Set([
  '的',
  '了',
  '和',
  '是',
  '在',
  '有',
  '要',
  '就',
  '都',
  '与',
  '或',
  '把',
  '被',
  '这',
  '那',
  '一个',
  '我们',
  '你',
  '我',
  '他',
  '它',
  'the',
  'a',
  'an',
  'of',
  'to',
  'and',
  'or',
  'in',
  'on',
  'for',
  'with'
]);

const SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
  ['间距', '留白', '边距', 'padding', 'margin', 'gap', 'spacing'],
  ['圆角', 'radius', 'corner'],
  ['字号', '字体', '行高', 'font', 'type'],
  ['配色', '颜色', '主色', '强调色', '品牌色', 'color', 'palette'],
  ['动效', '动画', '时长', '缓动', 'duration', 'easing', 'motion'],
  ['深色', '暗色', '夜间', 'dark'],
  ['图标', 'icon'],
  ['卡片', '列表行', 'card']
];

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hexRgb(value: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbLuminance(rgb: { r: number; g: number; b: number }): number {
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b);
}

/** Derive `colorProfile` from the palette (0.6.8); no palette means no profile. */
export function deriveColorProfile(tokens: DesignTokens): DesignColorProfile | undefined {
  const colors = tokens.palette.map((token) => hexRgb(token.value)).filter((rgb): rgb is { r: number; g: number; b: number } => rgb !== undefined);
  if (colors.length === 0) return undefined;
  const average = colors.reduce(
    (acc, rgb) => ({ r: acc.r + rgb.r / colors.length, g: acc.g + rgb.g / colors.length, b: acc.b + rgb.b / colors.length }),
    { r: 0, g: 0, b: 0 }
  );
  const delta = average.r - average.b;
  const temperature: DesignColorProfile['temperature'] = delta > 12 ? 'warm' : delta < -12 ? 'cool' : 'neutral';
  const luminances = colors.map(rgbLuminance);
  const max = Math.max(...luminances);
  const min = Math.min(...luminances);
  const ratio = (max + 0.05) / (min + 0.05);
  const contrast: DesignColorProfile['contrast'] = ratio >= 7 ? 'high' : ratio >= 3 ? 'medium' : 'low';
  return { temperature, contrast };
}

/** Normalize a `.shared`-relative HTML preview path (0.6.8). */
export function normalizePreviewPath(raw: unknown): string | undefined | null {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().replace(/\\/g, '/');
  if (value.length === 0) return undefined;
  if (!value.toLowerCase().endsWith('.html')) return null;
  if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').includes('..')) return null;
  return value.slice(0, 300);
}

/** Collapse whitespace and lowercase for stable hashing and indexing. */
export function normalizeDesignText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Tokenize English/number spans as words and CJK spans as bigrams.
 * @param text - query or chunk text.
 */
export function tokenizeDesignText(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.toLowerCase().matchAll(/[a-z0-9]+|[\u4e00-\u9fff]+/g);
  for (const match of matches) {
    const span = match[0];
    if (span.length === 0) continue;
    if (/^[a-z0-9]+$/.test(span)) {
      if (!STOP_WORDS.has(span)) tokens.push(span);
      continue;
    }
    if (span.length === 1) {
      if (!STOP_WORDS.has(span)) tokens.push(span);
      continue;
    }
    for (let index = 0; index < span.length - 1; index += 1) {
      const bigram = span.slice(index, index + 2);
      if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

const SYNONYM_VARIANTS: Record<string, readonly string[]> = (() => {
  const map: Record<string, readonly string[]> = {};
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) map[word] = group;
  }
  return map;
})();

/** Expand query tokens with the curated design-vocabulary synonyms. */
export function expandDesignQuery(tokens: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const group = SYNONYM_VARIANTS[token];
    if (group === undefined) continue;
    for (const word of group) for (const part of tokenizeDesignText(word)) expanded.add(part);
  }
  return [...expanded];
}

/** The query's numeric/colour constraints (used for the token boost). */
export function designQueryConstraints(query: string): {
  readonly numbers: ReadonlyArray<{ value: number; unit: string }>;
  readonly colors: readonly string[];
} {
  const numbers: Array<{ value: number; unit: string }> = [];
  for (const match of query.matchAll(/(\d+(?:\.\d+)?)\s*(vp|dp|px|pt|fp|ms|%|deg)?/g)) {
    numbers.push({ value: Number(match[1]), unit: match[2] ?? 'vp' });
  }
  const colors = [...query.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase());
  return { numbers, colors };
}

function numberTokenLabel(token: DesignNumberToken): string {
  return `${token.name === undefined ? '' : `${token.name} `}${token.value}${token.unit}`.trim();
}

function tokensText(tokens: DesignTokens): string {
  const lines: string[] = [];
  for (const token of tokens.palette) lines.push(`配色 ${token.name ?? 'color'} ${token.value}`);
  for (const token of tokens.spacing) lines.push(`间距 ${numberTokenLabel(token)}`);
  for (const token of tokens.radius) lines.push(`圆角 ${numberTokenLabel(token)}`);
  for (const token of tokens.type) lines.push(`字号 ${numberTokenLabel(token)}`);
  for (const token of tokens.motion) lines.push(`动效 ${numberTokenLabel(token)}`);
  return lines.join('\n');
}

/** Build the retrievable chunks for one card, in deterministic section order. */
export function cardChunks(card: DesignCard): DesignChunk[] {
  const brandText =
    card.brand === undefined
      ? ''
      : [
          card.brand.positioning ?? '',
          `目标用户：${card.brand.audience.join('、')}`,
          `业务约束：${card.brand.constraints.join('、')}`,
          `禁用风格：${card.brand.bannedStyles.join('、')}`
        ]
          .filter((line) => line.trim().length > 0)
          .join('\n');
  const principleText = [
    card.principle ?? '',
    card.perceptualEffect ?? '',
    (card.proxies ?? []).join('；'),
    (card.applications ?? []).join('；'),
    (card.misuses ?? []).join('；')
  ]
    .filter((line) => line.trim().length > 0)
    .join('\n');
  const sections: Array<{ section: DesignSection; text: string }> = [
    { section: 'tokens', text: tokensText(card.tokens) },
    { section: 'rationale', text: [card.title, card.rationale ?? card.summary].join('\n') },
    { section: 'dos', text: card.dos.join('\n') },
    { section: 'donts', text: card.donts.join('\n') },
    { section: 'style', text: (card.stylePriority ?? []).join('\n') },
    { section: 'antiPatterns', text: (card.antiPatterns ?? []).join('\n') },
    { section: 'checklist', text: (card.checklist ?? []).join('\n') },
    { section: 'brand', text: brandText },
    { section: 'principle', text: principleText },
    {
      section: 'context',
      text: [...(card.moduleTags ?? []), ...(card.tone ?? []), card.density ?? ''].filter((line) => line.length > 0).join('\n')
    }
  ];
  const chunks: DesignChunk[] = [];
  for (const { section, text } of sections) {
    const normalized = normalizeDesignText(text);
    if (normalized.length === 0) continue;
    // Long sections are split so a single card cannot dominate the index.
    const parts = normalized.length <= 400 ? [normalized] : splitChunks(normalized, 400);
    parts.forEach((part, index) => {
      const suffix = parts.length === 1 ? '' : `-${index + 1}`;
      chunks.push({
        chunkId: `${card.id}#${section}${suffix}`,
        cardId: card.id,
        section,
        text: part,
        sha: sha256Text(`${card.id}|${section}|${part}`)
      });
    });
  }
  return chunks;
}

function splitChunks(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) {
    parts.push(text.slice(start, start + maxLength));
  }
  return parts;
}

/** Flatten every card into chunks, ordered by card id then section order. */
export function buildDesignChunks(manifest: DesignManifest): DesignChunk[] {
  const chunks: DesignChunk[] = [];
  for (const card of [...manifest.cards].sort((left, right) => left.id.localeCompare(right.id))) {
    chunks.push(...cardChunks(card));
  }
  return chunks;
}

/** Build the deterministic BM25 index from chunks. */
export function buildDesignIndex(chunks: readonly DesignChunk[], builtAt: string): DesignIndex {
  const postings = new Map<string, Map<string, number>>();
  let totalLength = 0;
  const chunkMeta: Array<{ chunkId: string; cardId: string; section: DesignSection; len: number }> = [];
  for (const chunk of chunks) {
    const tokens = tokenizeDesignText(chunk.text);
    totalLength += tokens.length;
    chunkMeta.push({ chunkId: chunk.chunkId, cardId: chunk.cardId, section: chunk.section, len: tokens.length });
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, tf] of counts) {
      const bucket = postings.get(term) ?? new Map<string, number>();
      bucket.set(chunk.chunkId, tf);
      postings.set(term, bucket);
    }
  }
  const postingsRecord: Record<string, Array<[string, number]>> = {};
  const df: Record<string, number> = {};
  for (const term of [...postings.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = postings.get(term);
    if (bucket === undefined) continue;
    const entries = [...bucket.entries()].sort((left, right) => left[0].localeCompare(right[0]));
    postingsRecord[term] = entries;
    df[term] = entries.length;
  }
  return {
    schemaVersion: 1,
    engineVersion: DESIGN_ENGINE_VERSION,
    builtAt,
    totalChunks: chunks.length,
    avgLen: chunks.length === 0 ? 0 : Number((totalLength / chunks.length).toFixed(4)),
    chunks: chunkMeta,
    postings: postingsRecord,
    df
  };
}

/** Read the manifest; a corrupt file is an error, never an empty library. */
export async function readDesignManifest(paths: SharedPaths): Promise<DesignManifest | null> {
  const raw = await readTextOrNull(paths.designManifest);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DesignLibraryError(`manifest.json 解析失败：${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>)['cards'])) {
    throw new DesignLibraryError('manifest.json 结构不对：缺少 cards 数组');
  }
  return parsed as unknown as DesignManifest;
}

/** Read index + chunks for searching; both must exist. */
export async function readDesignIndex(
  paths: SharedPaths
): Promise<{ index: DesignIndex; chunks: readonly DesignChunk[] }> {
  const indexRaw = await readTextOrNull(paths.designIndex);
  const chunksRaw = await readTextOrNull(paths.designChunks);
  if (indexRaw === null || chunksRaw === null) {
    throw new DesignLibraryError('设计库索引不存在；先运行 `dwguard_design` 的 `library init` + `library ingest`。');
  }
  let index: DesignIndex;
  try {
    index = JSON.parse(indexRaw) as DesignIndex;
  } catch (error) {
    throw new DesignLibraryError(`index.json 解析失败：${(error as Error).message}`);
  }
  if (typeof index.totalChunks !== 'number' || typeof index.postings !== 'object' || index.postings === null) {
    throw new DesignLibraryError('index.json 结构不对');
  }
  const chunks: DesignChunk[] = [];
  for (const line of chunksRaw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as DesignChunk).chunkId === 'string') {
        chunks.push(parsed as DesignChunk);
      }
    } catch {
      // A corrupt line is skipped; the index remains the ranking source.
    }
  }
  return { index, chunks };
}

async function writeLibrary(paths: SharedPaths, manifest: DesignManifest): Promise<string[]> {
  const chunks = buildDesignChunks(manifest);
  const index = buildDesignIndex(chunks, manifest.updatedAt);
  const withCounts: DesignManifest = {
    ...manifest,
    engineVersion: DESIGN_ENGINE_VERSION,
    counts: { cards: manifest.cards.length, chunks: chunks.length }
  };
  await ensureDir(paths.designDir);
  await writeTextAtomic(paths.designManifest, `${JSON.stringify(withCounts, null, 2)}\n`);
  await writeTextAtomic(paths.designChunks, `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`);
  await writeTextAtomic(paths.designIndex, `${JSON.stringify(index, null, 2)}\n`);
  return [displayPath(paths, paths.designManifest), displayPath(paths, paths.designChunks), displayPath(paths, paths.designIndex)];
}

/** Persist a manifest and rebuild chunks/index (used by capture-pack, 0.6.8). */
export async function writeDesignLibrary(paths: SharedPaths, manifest: DesignManifest): Promise<string[]> {
  return writeLibrary(paths, manifest);
}

/** Next free id in the card's namespace (`DSG-*`, `AP-*`, `PR-*`). */
export function nextDesignId(
  cards: readonly DesignCard[],
  kind: 'pattern' | 'anti-pattern' | 'principle' = 'pattern'
): string {
  const prefix = kind === 'anti-pattern' ? 'AP' : kind === 'principle' ? 'PR' : 'DSG';
  let max = 0;
  for (const card of cards) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(card.id);
    if (match?.[1] === undefined) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function emptyManifest(now: string): DesignManifest {
  return {
    schemaVersion: 1,
    engineVersion: DESIGN_ENGINE_VERSION,
    updatedAt: now,
    counts: { cards: 0, chunks: 0 },
    cards: []
  };
}

/** Create the library skeleton (idempotent) and the read-only query CLI. */
export async function initDesignLibrary(
  paths: SharedPaths,
  now: string
): Promise<{ manifest: DesignManifest; created: boolean; files: string[] }> {
  await ensureDir(paths.designDir);
  await ensureDir(paths.designRefsDir);
  await ensureDir(paths.designInboxDir);
  const existing = await readDesignManifest(paths);
  const manifest = existing ?? emptyManifest(now);
  const files: string[] = [];
  if (existing === null) {
    files.push(...(await writeLibrary(paths, manifest)));
  }
  await writeTextAtomic(paths.designQueryScript, renderQueryCli());
  files.push(displayPath(paths, paths.designQueryScript));
  return { manifest, created: existing === null, files };
}

/** Cards seeded from the rule catalog's aesthetic rules. */
export function ruleCards(existing: readonly DesignCard[], now: string): DesignCard[] {
  const cards: DesignCard[] = [];
  const added: DesignCard[] = [];
  for (const rule of RULES) {
    if (rule.dimension !== 'aesthetic') continue;
    if (existing.some((card) => card.source.kind === 'rule' && card.source.ref === rule.id)) continue;
    if (added.some((card) => card.source.kind === 'rule' && card.source.ref === rule.id)) continue;
    const id = nextDesignId([...existing, ...added]);
    const card: DesignCard = {
      id,
      title: `${rule.id} · ${rule.title}`,
      summary: rule.verify,
      tags: ['rule', 'aesthetic', ...(rule.citation?.section === undefined ? [] : [rule.citation.section])],
      source: { kind: 'rule', ref: rule.id, license: 'internal' },
      tokens: EMPTY_TOKENS,
      rationale: `${rule.title}：${rule.verify}`,
      dos: [],
      donts: [],
      images: [],
      status: 'active',
      weight: 1,
      createdAt: now,
      updatedAt: now
    };
    added.push(card);
  }
  cards.push(...added);
  return cards;
}

interface InboxMeta {
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly tags?: unknown;
  readonly rationale?: unknown;
  readonly dos?: unknown;
  readonly donts?: unknown;
  readonly tokens?: unknown;
  readonly image?: unknown;
  readonly source?: unknown;
  readonly kind?: unknown;
  readonly stylePriority?: unknown;
  readonly antiPatterns?: unknown;
  readonly checklist?: unknown;
  readonly dimensions?: unknown;
  readonly brand?: unknown;
  readonly principle?: unknown;
  readonly perceptualEffect?: unknown;
  readonly proxies?: unknown;
  readonly applications?: unknown;
  readonly misuses?: unknown;
  readonly moduleTags?: unknown;
  readonly tone?: unknown;
  readonly density?: unknown;
  readonly preview?: unknown;
}

function dimensionsFrom(raw: unknown): DesignDimensions | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? inline(value).slice(0, 40) : undefined;
  };
  const appType = text('appType');
  const platform = text('platform');
  const style = text('style');
  if (appType === undefined && platform === undefined && style === undefined) return undefined;
  return {
    ...(appType === undefined ? {} : { appType }),
    ...(platform === undefined ? {} : { platform }),
    ...(style === undefined ? {} : { style })
  };
}

function brandFrom(raw: unknown): DesignBrand | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const positioning =
    typeof record['positioning'] === 'string' && inline(record['positioning']).length > 0
      ? inline(record['positioning']).slice(0, 240)
      : undefined;
  const audience = stringArray(record['audience'], 12);
  const constraints = stringArray(record['constraints'], 12);
  const bannedStyles = stringArray(record['bannedStyles'], 12);
  if (positioning === undefined && audience.length === 0 && constraints.length === 0 && bannedStyles.length === 0) {
    return undefined;
  }
  return {
    ...(positioning === undefined ? {} : { positioning }),
    audience,
    constraints,
    bannedStyles
  };
}

function stringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string').map((item) => inline(item)).filter((item) => item.length > 0).slice(0, max);
}

function normalizeNumberTokens(raw: unknown, fallbackUnit: string): DesignNumberToken[] {
  if (!Array.isArray(raw)) return [];
  const tokens: DesignNumberToken[] = [];
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      tokens.push({ value: item, unit: fallbackUnit });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const numeric = typeof record['value'] === 'number' ? record['value'] : Number(record['value']);
    if (!Number.isFinite(numeric)) continue;
    const unit = typeof record['unit'] === 'string' && record['unit'].trim().length > 0 ? record['unit'].trim() : fallbackUnit;
    tokens.push({
      ...(typeof record['name'] === 'string' && record['name'].trim().length > 0 ? { name: record['name'].trim() } : {}),
      value: numeric,
      unit
    });
  }
  return tokens;
}

function normalizeColorTokens(raw: unknown): DesignColorToken[] {
  if (!Array.isArray(raw)) return [];
  const tokens: DesignColorToken[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (/^#[0-9A-Fa-f]{6}$/.test(item.trim())) tokens.push({ value: item.trim().toUpperCase() });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record['value'] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(record['value'].trim())) continue;
    tokens.push({
      ...(typeof record['name'] === 'string' && record['name'].trim().length > 0 ? { name: record['name'].trim() } : {}),
      value: record['value'].trim().toUpperCase()
    });
  }
  return tokens;
}

/** Normalize a model/user supplied token object. */
export function normalizeTokens(raw: unknown): DesignTokens {
  if (typeof raw !== 'object' || raw === null) return EMPTY_TOKENS;
  const record = raw as Record<string, unknown>;
  return {
    palette: normalizeColorTokens(record['palette']),
    spacing: normalizeNumberTokens(record['spacing'], 'vp'),
    radius: normalizeNumberTokens(record['radius'], 'vp'),
    type: normalizeNumberTokens(record['type'], 'fp'),
    motion: normalizeNumberTokens(record['motion'], 'ms')
  };
}

function sanitizeInboxFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) return null;
  return name;
}

/** Ingest `inbox/*.meta.json` into cards, copying referenced images into refs/. */
export async function inboxCards(
  paths: SharedPaths,
  existing: readonly DesignCard[],
  now: string
): Promise<{ cards: DesignCard[]; skipped: number; warnings: string[]; files: string[] }> {
  const cards: DesignCard[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  let skipped = 0;
  const names = (await listDir(paths.designInboxDir)).filter((name) => name.endsWith('.meta.json')).sort();
  for (const name of names) {
    const raw = await readTextOrNull(join(paths.designInboxDir, name));
    if (raw === null) continue;
    const ingestKey = sha256Text(normalizeDesignText(raw));
    if (existing.some((card) => card.ingestKey === ingestKey) || cards.some((card) => card.ingestKey === ingestKey)) {
      skipped += 1;
      continue;
    }
    let meta: InboxMeta;
    try {
      meta = JSON.parse(raw) as InboxMeta;
    } catch (error) {
      warnings.push(`${name}: JSON 解析失败（${(error as Error).message}），已跳过`);
      continue;
    }
    const title = typeof meta.title === 'string' ? inline(meta.title) : '';
    const source = typeof meta.source === 'object' && meta.source !== null ? (meta.source as Record<string, unknown>) : {};
    const sourceKind = source['kind'] === undefined ? 'user' : source['kind'];
    const license = typeof source['license'] === 'string' ? source['license'].trim() : '';
    if (
      title.length === 0 ||
      license.length === 0 ||
      (sourceKind !== 'official' && sourceKind !== 'user' && sourceKind !== 'project' && sourceKind !== 'brand')
    ) {
      warnings.push(`${name}: 需要 title、source.license，且 source.kind ∈ official/user/project/brand；已跳过`);
      continue;
    }
    if (meta.kind !== undefined && meta.kind !== 'pattern' && meta.kind !== 'anti-pattern' && meta.kind !== 'principle') {
      warnings.push(`${name}: kind 只能是 pattern / anti-pattern / principle；已跳过`);
      continue;
    }
    const cardKind: 'pattern' | 'anti-pattern' | 'principle' =
      meta.kind === 'anti-pattern' ? 'anti-pattern' : meta.kind === 'principle' ? 'principle' : 'pattern';
    const rationale = typeof meta.rationale === 'string' && inline(meta.rationale).length > 0 ? inline(meta.rationale) : undefined;
    const summary = typeof meta.summary === 'string' ? inline(meta.summary) : '';
    if (cardKind === 'anti-pattern' && rationale === undefined && summary.length === 0) {
      warnings.push(`${name}: anti-pattern 卡片需要 rationale 或 summary 描述禁止项；已跳过`);
      continue;
    }
    const principle = typeof meta.principle === 'string' && inline(meta.principle).length > 0 ? inline(meta.principle) : undefined;
    const perceptualEffect =
      typeof meta.perceptualEffect === 'string' && inline(meta.perceptualEffect).length > 0
        ? inline(meta.perceptualEffect)
        : undefined;
    const proxies = stringArray(meta.proxies, 16);
    const applications = stringArray(meta.applications, 12);
    const misuses = stringArray(meta.misuses, 12);
    const checklist = stringArray(meta.checklist, 16);
    if (cardKind === 'principle') {
      if (principle === undefined && rationale === undefined && summary.length === 0) {
        warnings.push(`${name}: principle 卡片需要 principle 或 rationale/summary 说明原则；已跳过`);
        continue;
      }
      if (proxies.length === 0 && checklist.length === 0) {
        warnings.push(`${name}: principle 卡片至少需要一个 proxies 或 checklist 可测项（否则只是形容词）；已跳过`);
        continue;
      }
    }
    let brand: DesignBrand | undefined;
    if (sourceKind === 'brand') {
      brand = brandFrom(meta.brand);
      if (brand === undefined) {
        warnings.push(`${name}: source.kind=brand 需要 brand.positioning / audience / constraints / bannedStyles 至少一项；已跳过`);
        continue;
      }
    }
    const antiPatterns = stringArray(meta.antiPatterns, 16);
    const validAntiPatterns = antiPatterns.filter((id) => /^AP-\d{4}$/.test(id));
    if (validAntiPatterns.length !== antiPatterns.length) {
      warnings.push(`${name}: 部分 antiPatterns 不是 AP-<四位数字>，已忽略无效 id`);
    }
    const images: Array<{ path: string; sha256: string; alt: string }> = [];
    const imageName = sanitizeInboxFile(meta.image);
    if (meta.image !== undefined && imageName === null) {
      warnings.push(`${name}: image 路径非法（只允许 inbox 内的文件名），已忽略图片`);
    }
    if (imageName !== null) {
      const imagePath = join(paths.designInboxDir, imageName);
      if (!(await fileExists(imagePath))) {
        warnings.push(`${name}: 图片 ${imageName} 不存在，卡片按无图入库`);
      } else {
        const sha = await sha256File(imagePath);
        const ext = extname(imageName).toLowerCase() || '.png';
        const storedAs = `refs/${sha}${ext}`;
        await copyFileTo(imagePath, join(paths.designDir, storedAs));
        images.push({ path: storedAs, sha256: sha, alt: title });
        files.push(displayPath(paths, join(paths.designDir, storedAs)));
      }
    }
    const id = nextDesignId([...existing, ...cards], cardKind);
    const stylePriority = stringArray(meta.stylePriority, 12);
    const dimensions = dimensionsFrom(meta.dimensions);
    const moduleTags = stringArray(meta.moduleTags, 12).map((tag) => tag.toLowerCase());
    const tone = stringArray(meta.tone, 12).map((tag) => tag.toLowerCase());
    const densityRaw = typeof meta.density === 'string' ? meta.density.trim().toLowerCase() : undefined;
    const density: DesignDensity | undefined =
      densityRaw === 'low' || densityRaw === 'medium' || densityRaw === 'high' ? densityRaw : undefined;
    if (densityRaw !== undefined && density === undefined) {
      warnings.push(`${name}: density 只能是 low / medium / high，已忽略`);
    }
    const preview = normalizePreviewPath(meta.preview);
    if (preview === null) {
      warnings.push(`${name}: preview 必须是 .shared 内、以 .html 结尾的相对路径，已忽略`);
    }
    const tokens = normalizeTokens(meta.tokens);
    const colorProfile = deriveColorProfile(tokens);
    cards.push({
      id,
      title,
      summary,
      tags: stringArray(meta.tags, 12),
      source: {
        kind: sourceKind,
        ...(typeof source['ref'] === 'string' && source['ref'].trim().length > 0 ? { ref: source['ref'].trim() } : {}),
        license
      },
      tokens,
      ...(rationale === undefined ? {} : { rationale }),
      dos: stringArray(meta.dos, 12),
      donts: stringArray(meta.donts, 12),
      images,
      status: 'active',
      weight: 1,
      createdAt: now,
      updatedAt: now,
      ingestKey,
      kind: cardKind,
      ...(stylePriority.length === 0 ? {} : { stylePriority }),
      ...(validAntiPatterns.length === 0 ? {} : { antiPatterns: validAntiPatterns }),
      ...(checklist.length === 0 ? {} : { checklist }),
      ...(dimensions === undefined ? {} : { dimensions }),
      ...(brand === undefined ? {} : { brand }),
      ...(principle === undefined ? {} : { principle }),
      ...(perceptualEffect === undefined ? {} : { perceptualEffect }),
      ...(proxies.length === 0 ? {} : { proxies }),
      ...(applications.length === 0 ? {} : { applications }),
      ...(misuses.length === 0 ? {} : { misuses }),
      ...(moduleTags.length === 0 ? {} : { moduleTags }),
      ...(tone.length === 0 ? {} : { tone }),
      ...(density === undefined ? {} : { density }),
      ...(colorProfile === undefined ? {} : { colorProfile }),
      ...(preview === null || preview === undefined ? {} : { preview })
    });
  }
  return { cards, skipped, warnings, files };
}

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
export async function ingestDesignLibrary(
  paths: SharedPaths,
  sources: ReadonlyArray<'rules' | 'inbox'>,
  now: string
): Promise<DesignIngestResult> {
  const manifest = (await readDesignManifest(paths)) ?? emptyManifest(now);
  const added: DesignCard[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  let skipped = 0;
  if (sources.includes('rules')) {
    added.push(...ruleCards([...manifest.cards, ...added], now));
  }
  if (sources.includes('inbox')) {
    const inbox = await inboxCards(paths, [...manifest.cards, ...added], now);
    added.push(...inbox.cards);
    warnings.push(...inbox.warnings);
    files.push(...inbox.files);
    skipped += inbox.skipped;
  }
  if (added.length === 0) {
    return { manifest, added, skipped, warnings, files, changed: false };
  }
  const next: DesignManifest = {
    ...manifest,
    updatedAt: now,
    cards: [...manifest.cards, ...added]
  };
  // A pattern may reference an AP card that is not ingested yet; warn instead of
  // failing the ingest so library setup order stays flexible (0.6.4).
  const knownIds = new Set(next.cards.map((card) => card.id));
  for (const card of added) {
    for (const ref of card.antiPatterns ?? []) {
      if (!knownIds.has(ref)) {
        warnings.push(`卡片 \`${card.id}\` 引用的反模式 \`${ref}\` 不存在；补 ingest 反模式卡后再把它写进 antiPatternRefs。`);
      }
    }
  }
  files.push(...(await writeLibrary(paths, next)));
  const written = await readDesignManifest(paths);
  return { manifest: written ?? next, added, skipped, warnings, files, changed: true };
}

/** Areas a card speaks to (token keys plus tag vocabulary). */
export function cardAreas(card: DesignCard): Set<AestheticArea> {
  const areas = new Set<AestheticArea>();
  if (card.tokens.palette.length > 0) areas.add('palette');
  if (card.tokens.spacing.length > 0) areas.add('spacing');
  if (card.tokens.radius.length > 0) areas.add('radius');
  if (card.tokens.type.length > 0) areas.add('type');
  if (card.tokens.motion.length > 0) areas.add('motion');
  for (const tag of card.tags) {
    for (const [word, group] of Object.entries(SYNONYM_VARIANTS)) {
      if (!tag.toLowerCase().includes(word.toLowerCase())) continue;
      for (const variant of group) {
        const label = Object.entries(AREA_LABELS).find(([, value]) => value === variant)?.[0];
        if (label !== undefined && isAestheticArea(label)) areas.add(label);
      }
    }
  }
  return areas;
}

function cardById(manifest: DesignManifest): Map<string, DesignCard> {
  return new Map(manifest.cards.map((card) => [card.id, card]));
}

function chunkById(chunks: readonly DesignChunk[]): Map<string, DesignChunk> {
  return new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
}

/**
 * Rank cards for a query with BM25 + structured boosts.
 *
 * `hybrid` is accepted by the interface but falls back to lexical in 0.6.2 P0;
 * the result records both so a report can say which ranking actually ran.
 */
export function searchDesignLibrary(
  manifest: DesignManifest,
  index: DesignIndex,
  chunks: readonly DesignChunk[],
  query: string,
  options: {
    readonly topK: number;
    readonly ranker: Options['designRanker'];
    readonly licenseRequired: boolean;
    readonly profileAreas?: ReadonlySet<AestheticArea>;
    /** Retrieval filters (kind defaults to `pattern`). */
    readonly filters?: DesignSearchFilters;
  }
): DesignSearchResult {
  const notes: string[] = [];
  const requestedRanker = options.ranker;
  if (requestedRanker === 'hybrid') {
    notes.push('hybrid 需要 embedding 端点；工具层负责语义重排，未配置或失败时回退 lexical');
  }
  const ranker = 'lexical' as const;
  const queryTokens = expandDesignQuery(tokenizeDesignText(query));
  const constraints = designQueryConstraints(query);
  const cards = cardById(manifest);
  const chunkMap = chunkById(chunks);
  const chunkMeta = new Map(index.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const chunkScores = new Map<string, number>();
  const k1 = 1.2;
  const b = 0.75;
  const avgLen = index.avgLen === 0 ? 1 : index.avgLen;
  for (const token of new Set(queryTokens)) {
    const postings = index.postings[token];
    if (postings === undefined) continue;
    const df = index.df[token] ?? postings.length;
    const idf = Math.log(1 + (index.totalChunks - df + 0.5) / (df + 0.5));
    for (const [chunkId, tf] of postings) {
      const length = chunkMeta.get(chunkId)?.len ?? 0;
      const denominator = tf + k1 * (1 - b + (b * length) / avgLen);
      const contribution = idf * ((tf * (k1 + 1)) / (denominator === 0 ? 1 : denominator));
      chunkScores.set(chunkId, (chunkScores.get(chunkId) ?? 0) + contribution);
    }
  }
  const byCard = new Map<string, { score: number; chunkId: string }>();
  for (const [chunkId, score] of chunkScores) {
    const chunk = chunkMap.get(chunkId);
    if (chunk === undefined) continue;
    const current = byCard.get(chunk.cardId);
    if (current === undefined || score > current.score) byCard.set(chunk.cardId, { score, chunkId });
  }
  const results: DesignSearchHit[] = [];
  for (const card of cards.values()) {
    if (card.status !== 'active') continue;
    if (options.licenseRequired && card.source.license.toLowerCase() === 'unknown') continue;
    if (!matchesDesignFilters(card, options.filters ?? { kind: 'pattern' })) continue;
    const best = byCard.get(card.id);
    const bm25 = best?.score ?? 0;
    if (bm25 === 0 && queryTokens.length > 0) continue;
    let tokenBoost = 0;
    for (const color of constraints.colors) {
      if (card.tokens.palette.some((token) => token.value.toUpperCase() === color)) tokenBoost += 0.5;
    }
    for (const number of constraints.numbers) {
      const all = [...card.tokens.spacing, ...card.tokens.radius, ...card.tokens.type, ...card.tokens.motion];
      if (all.some((token) => token.value === number.value && token.unit === number.unit)) tokenBoost += 0.5;
    }
    const cardTokens = new Set(tokenizeDesignText(card.tags.join(' ')));
    const tagBoost = queryTokens.some((token) => cardTokens.has(token)) ? 0.3 : 0;
    const areas = cardAreas(card);
    const profileBoost = options.profileAreas === undefined ? 0 : [...areas].some((area) => options.profileAreas?.has(area)) ? 0.3 : 0;
    const weight = Math.min(1.5, Math.max(0.5, card.weight));
    const score = Number(((bm25 + tokenBoost + tagBoost + profileBoost) * weight).toFixed(4));
    const chunk = best === undefined ? undefined : chunkMap.get(best.chunkId);
    results.push({
      cardId: card.id,
      title: card.title,
      kind: designCardKind(card),
      score,
      breakdown: {
        bm25: Number(bm25.toFixed(4)),
        tokenBoost: Number(tokenBoost.toFixed(4)),
        tagBoost: Number(tagBoost.toFixed(4)),
        profileBoost: Number(profileBoost.toFixed(4)),
        weight
      },
      snippet: chunk === undefined ? truncate(card.summary, 120) : truncate(chunk.text, 160),
      tokens: card.tokens,
      source: card.source,
      images: card.images
    });
  }
  results.sort((left, right) => (right.score === left.score ? left.cardId.localeCompare(right.cardId) : right.score - left.score));
  return {
    schemaVersion: 1,
    query,
    ranker,
    requestedRanker,
    totalChunks: index.totalChunks,
    notes,
    results: results.slice(0, options.topK)
  };
}

/** Render a design search result as markdown (used by the tool and the CLI). */
export function renderDesignSearchMarkdown(result: DesignSearchResult): string {
  if (result.results.length === 0) {
    return `没有命中「${result.query}」。${result.notes.length === 0 ? '' : `\n\n${result.notes.join('\n')}`}`;
  }
  const rows = result.results.map((hit) => [
    `\`${hit.cardId}\``,
    hit.title,
    hit.kind,
    hit.score.toFixed(2),
    hit.breakdown.bm25.toFixed(2),
    hit.breakdown.tokenBoost.toFixed(2),
    hit.breakdown.profileBoost.toFixed(2),
    hit.source.license,
    hit.snippet
  ]);
  const header = ['ID', '标题', '类型', '总分', 'BM25', 'token', '档案', 'license', '片段'];
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ];
  if (result.notes.length > 0) lines.push('', ...result.notes.map((note) => `> ${note}`));
  return lines.join('\n');
}

/** Render the full card table for `library list`. */
export function renderDesignCardsMarkdown(manifest: DesignManifest): string {
  if (manifest.cards.length === 0) return '（设计库为空；先 `library ingest`）';
  const rows = [...manifest.cards]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((card) => [
      `\`${card.id}\``,
      card.title,
      designCardKind(card),
      [...(card.moduleTags ?? []), ...(card.tone ?? []), card.density ?? ''].filter((item) => item.length > 0).join('/') || '—',
      card.source.kind,
      card.source.license,
      card.status,
      card.weight.toFixed(1),
      String(cardChunks(card).length)
    ]);
  return [
    '| ID | 标题 | kind | 模块/气质/密度 | 来源 | license | 状态 | 权重 | 块数 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}

/** One-line token summary used by spec/audit reports (0.6.2 P2). */
export function designCardTokenSummary(card: DesignCard): string {
  return tokensText(card.tokens).split('\n').join('；');
}

/** Safe ASCII file slug for pack card files (0.7.0). */
export function slugifyDesign(value: string): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return (ascii.length === 0 ? 'card' : ascii).slice(0, 48);
}

/** Convert an internal card into an inbox-compatible meta (portable, no ids/status). */
export function designCardToInboxMeta(card: DesignCard): Record<string, unknown> {
  return {
    kind: card.kind ?? 'pattern',
    title: card.title,
    summary: card.summary,
    tags: card.tags,
    tokens: card.tokens,
    source: card.source,
    dos: card.dos,
    donts: card.donts,
    ...(card.rationale === undefined ? {} : { rationale: card.rationale }),
    ...(card.stylePriority === undefined ? {} : { stylePriority: card.stylePriority }),
    ...(card.antiPatterns === undefined ? {} : { antiPatterns: card.antiPatterns }),
    ...(card.checklist === undefined ? {} : { checklist: card.checklist }),
    ...(card.dimensions === undefined ? {} : { dimensions: card.dimensions }),
    ...(card.brand === undefined ? {} : { brand: card.brand }),
    ...(card.principle === undefined ? {} : { principle: card.principle }),
    ...(card.perceptualEffect === undefined ? {} : { perceptualEffect: card.perceptualEffect }),
    ...(card.proxies === undefined ? {} : { proxies: card.proxies }),
    ...(card.applications === undefined ? {} : { applications: card.applications }),
    ...(card.misuses === undefined ? {} : { misuses: card.misuses }),
    ...(card.moduleTags === undefined ? {} : { moduleTags: card.moduleTags }),
    ...(card.tone === undefined ? {} : { tone: card.tone }),
    ...(card.density === undefined ? {} : { density: card.density })
  };
}

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
export function createHttpEmbedder(config: DesignEmbeddingConfig): DesignEmbedder {
  return async (texts) => {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs));
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` })
        },
        body: JSON.stringify({ model: config.model, input: texts }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data) || body.data.length !== texts.length) {
        throw new Error('embedding 返回条数与输入不一致');
      }
      return body.data.map((row, index) => {
        if (typeof row !== 'object' || row === null) throw new Error(`embedding 第 ${index} 条格式不对`);
        const embedding = (row as Record<string, unknown>)['embedding'];
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error(`embedding 第 ${index} 条没有向量`);
        }
        return embedding.map((value) => {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`embedding 第 ${index} 条含非数值`);
          return value;
        });
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Cosine similarity; zero vectors score 0. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** `embeddings.json` cache so repeated briefs do not re-embed the same text. */
export interface DesignEmbeddingCache {
  schemaVersion: 1;
  model: string;
  vectors: Record<string, readonly number[]>;
}

/** Cache key for one text (model-scoped). */
export function embeddingCacheKey(model: string, text: string): string {
  return sha256Text(`${model}\u0000${text}`);
}

/** Wrap an embedder with the on-disk cache (mutates `cache`). */
export function createCachedEmbedder(
  embed: DesignEmbedder,
  cache: DesignEmbeddingCache,
  model: string
): DesignEmbedder {
  return async (texts) => {
    const keys = texts.map((text) => embeddingCacheKey(model, text));
    const missing: number[] = [];
    keys.forEach((key, index) => {
      if (cache.vectors[key] === undefined) missing.push(index);
    });
    if (missing.length > 0) {
      const vectors = await embed(missing.map((index) => texts[index] ?? ''));
      if (vectors.length !== missing.length) throw new Error('embedding 返回条数与输入不一致');
      missing.forEach((textIndex, vectorIndex) => {
        cache.vectors[keys[textIndex] ?? ''] = vectors[vectorIndex] ?? [];
      });
    }
    return keys.map((key) => [...(cache.vectors[key] ?? [])]);
  };
}

/** Load the embedding cache for a model (empty when missing/mismatched). */
export async function loadDesignEmbeddingCache(
  paths: SharedPaths,
  model: string
): Promise<DesignEmbeddingCache> {
  const raw = await readTextOrNull(paths.designEmbeddings);
  if (raw === null) return { schemaVersion: 1, model, vectors: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<DesignEmbeddingCache>;
    if (parsed.schemaVersion !== 1 || parsed.model !== model || typeof parsed.vectors !== 'object' || parsed.vectors === null) {
      return { schemaVersion: 1, model, vectors: {} };
    }
    return { schemaVersion: 1, model, vectors: parsed.vectors as Record<string, readonly number[]> };
  } catch {
    return { schemaVersion: 1, model, vectors: {} };
  }
}

/** Persist the embedding cache. */
export async function saveDesignEmbeddingCache(
  paths: SharedPaths,
  cache: DesignEmbeddingCache
): Promise<void> {
  await ensureDir(paths.designDir);
  await writeTextAtomic(paths.designEmbeddings, `${JSON.stringify(cache)}\n`);
}

/**
 * Rerank candidates with precomputed cosine vectors (0.6.6; shared by recall).
 *
 * Final score blends normalized lexical score with `(cosine + 1) / 2`; the
 * original `breakdown` is kept so the report still shows why a card was retrieved.
 */
export function rerankDesignHitsWithVectors(
  candidates: readonly DesignSearchHit[],
  queryVector: readonly number[],
  vectors: ReadonlyMap<string, readonly number[]>,
  options: { readonly weight: number; readonly model: string }
): { readonly results: DesignSearchHit[]; readonly notes: string[] } {
  if (candidates.length === 0) return { results: [], notes: [] };
  const maxBase = Math.max(...candidates.map((hit) => hit.score), 1e-9);
  const weight = Math.min(1, Math.max(0, options.weight));
  const reranked = candidates.map((hit) => {
    const semantic = (cosineSimilarity(queryVector, vectors.get(hit.cardId) ?? []) + 1) / 2;
    const lexical = hit.score / maxBase;
    return {
      ...hit,
      score: Number((((1 - weight) * lexical + weight * semantic)).toFixed(4)),
      semanticScore: Number(semantic.toFixed(4)),
      rerankWeight: weight
    };
  });
  reranked.sort((left, right) =>
    right.score === left.score ? left.cardId.localeCompare(right.cardId) : right.score - left.score
  );
  return {
    results: reranked,
    notes: [`hybrid 语义重排：${options.model}，语义权重 ${weight}`]
  };
}

/** Rerank lexical candidates with cosine similarity (0.6.4; embed the candidates itself). */
export async function rerankDesignHits(
  candidates: readonly DesignSearchHit[],
  query: string,
  embed: DesignEmbedder,
  options: { readonly weight: number; readonly model: string }
): Promise<{ readonly results: DesignSearchHit[]; readonly notes: string[] }> {
  if (candidates.length === 0) return { results: [], notes: [] };
  const texts = candidates.map((hit) => `${hit.title}\n${hit.snippet}`);
  const vectors = await embed([query, ...texts]);
  if (vectors.length !== texts.length + 1) throw new Error('embedding 返回条数与输入不一致');
  const byCard = new Map(candidates.map((hit, index) => [hit.cardId, vectors[index + 1] ?? []] as const));
  return rerankDesignHitsWithVectors(candidates, vectors[0] ?? [], byCard, options);
}

/** Text used to embed a whole card for semantic recall (0.6.6). */
export function cardEmbeddingText(card: DesignCard): string {
  return truncate(
    normalizeDesignText(
      [
        card.title,
        card.summary,
        card.rationale ?? '',
        tokensText(card.tokens),
        card.tags.join(' '),
        (card.stylePriority ?? []).join(' '),
        card.donts.join(' ')
      ].join('\n')
    ),
    800
  );
}

function semanticOnlyHit(card: DesignCard): DesignSearchHit {
  return {
    cardId: card.id,
    title: card.title,
    kind: designCardKind(card),
    score: 0,
    breakdown: {
      bm25: 0,
      tokenBoost: 0,
      tagBoost: 0,
      profileBoost: 0,
      weight: Math.min(1.5, Math.max(0.5, card.weight))
    },
    snippet: truncate(card.summary.length === 0 ? (card.rationale ?? '') : card.summary, 160),
    tokens: card.tokens,
    source: card.source,
    images: card.images
  };
}

/**
 * Lexical search, optionally expanded with a semantic candidate pool and
 * reranked (0.6.4/0.6.6).
 *
 * The hybrid path is deliberately confined to the DSH tool: `query.mjs` stays
 * lexical (no endpoint/credentials), and the brief says so.
 */
export async function searchDesignWithRanker(
  paths: SharedPaths,
  options: Options,
  manifest: DesignManifest,
  index: DesignIndex,
  chunks: readonly DesignChunk[],
  query: string,
  topK: number,
  extra: {
    readonly licenseRequired: boolean;
    readonly profileAreas?: ReadonlySet<AestheticArea>;
    readonly filters?: DesignSearchFilters;
  }
): Promise<DesignSearchResult> {
  const hybrid = options.designRanker === 'hybrid';
  const filters = extra.filters ?? { kind: 'pattern' as const };
  const base = searchDesignLibrary(manifest, index, chunks, query, {
    topK: hybrid ? Math.max(topK, 30) : topK,
    ranker: options.designRanker,
    licenseRequired: extra.licenseRequired,
    ...(extra.profileAreas === undefined ? {} : { profileAreas: extra.profileAreas }),
    filters
  });
  if (!hybrid) return base;
  const embeddingEndpoint =
    options.designEmbeddingEndpoint.length > 0
      ? options.designEmbeddingEndpoint
      : options.designEmbeddingProvider === 'dashscope'
        ? DASHSCOPE_MULTIMODAL_ENDPOINT
        : '';
  if (embeddingEndpoint.length === 0) {
    return {
      ...base,
      results: base.results.slice(0, topK),
      notes: [...base.notes, '未配置 designEmbeddingEndpoint，回退 lexical']
    };
  }
  try {
    const cache = await loadDesignEmbeddingCache(paths, options.designEmbeddingModel);
    const apiKey = process.env[options.designEmbeddingApiKeyEnv];
    const embed = createCachedEmbedder(
      options.designEmbeddingProvider === 'dashscope'
        ? await createDashScopeTextEmbedder({
            endpoint: embeddingEndpoint,
            model: options.designEmbeddingModel,
            ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
            timeoutMs: options.designEmbeddingTimeoutMs
          })
        : createHttpEmbedder({
            endpoint: embeddingEndpoint,
            model: options.designEmbeddingModel,
            ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
            timeoutMs: options.designEmbeddingTimeoutMs,
            weight: options.designEmbeddingWeight
          }),
      cache,
      options.designEmbeddingModel
    );
    // Semantic recall: embed every eligible card, take the closest ones, then
    // union with the lexical candidates before the final blend (0.6.6).
    const eligible = manifest.cards.filter((card) => {
      if (card.status !== 'active') return false;
      if (extra.licenseRequired && card.source.license.toLowerCase() === 'unknown') return false;
      return matchesDesignFilters(card, filters);
    });
    const texts = eligible.map(cardEmbeddingText);
    const vectors = await embed([query, ...texts]);
    if (vectors.length !== texts.length + 1) throw new Error('embedding 返回条数与输入不一致');
    const queryVector = vectors[0] ?? [];
    const byCard = new Map<string, readonly number[]>(
      eligible.map((card, index) => [card.id, vectors[index + 1] ?? []] as const)
    );
    const semantic = eligible
      .map((card) => ({
        card,
        score: cosineSimilarity(queryVector, byCard.get(card.id) ?? [])
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 30);
    const union = new Map<string, DesignSearchHit>();
    for (const hit of base.results) union.set(hit.cardId, hit);
    for (const item of semantic) {
      if (!union.has(item.card.id)) union.set(item.card.id, semanticOnlyHit(item.card));
    }
    const reranked = rerankDesignHitsWithVectors([...union.values()], queryVector, byCard, {
      weight: options.designEmbeddingWeight,
      model: options.designEmbeddingModel
    });
    await saveDesignEmbeddingCache(paths, cache);
    return {
      ...base,
      results: reranked.results.slice(0, topK),
      ranker: 'hybrid',
      notes: [
        ...base.notes.filter((note) => !note.startsWith('hybrid 需要 embedding 端点')),
        `hybrid 召回：lexical ${base.results.length} + semantic ${semantic.length}（并集 ${union.size}）`,
        ...reranked.notes,
        'query.mjs 仍为 lexical（CLI 无 embedding 端点）；以本工具排序为准'
      ]
    };
  } catch (error) {
    return {
      ...base,
      results: base.results.slice(0, topK),
      notes: [...base.notes, `语义重排失败（${(error as Error).message}），回退 lexical`]
    };
  }
}

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

interface ImageFeatureCache {
  schemaVersion: 1;
  features: Record<string, ImageFeatures>;
}

async function loadImageFeatureCache(paths: SharedPaths): Promise<ImageFeatureCache> {
  const raw = await readTextOrNull(paths.designImageFeatures);
  if (raw === null) return { schemaVersion: 1, features: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<ImageFeatureCache>;
    if (parsed.schemaVersion !== 1 || typeof parsed.features !== 'object' || parsed.features === null) {
      return { schemaVersion: 1, features: {} };
    }
    return { schemaVersion: 1, features: parsed.features as Record<string, ImageFeatures> };
  } catch {
    return { schemaVersion: 1, features: {} };
  }
}

interface ClipCache {
  schemaVersion: 1;
  model: string;
  vectors: Record<string, readonly number[]>;
}

async function loadClipCache(paths: SharedPaths, model: string): Promise<ClipCache> {
  const raw = await readTextOrNull(paths.designClipEmbeddings);
  if (raw === null) return { schemaVersion: 1, model, vectors: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<ClipCache>;
    if (parsed.schemaVersion !== 1 || parsed.model !== model || typeof parsed.vectors !== 'object' || parsed.vectors === null) {
      return { schemaVersion: 1, model, vectors: {} };
    }
    return { schemaVersion: 1, model, vectors: parsed.vectors as Record<string, readonly number[]> };
  } catch {
    return { schemaVersion: 1, model, vectors: {} };
  }
}

async function saveClipCache(paths: SharedPaths, cache: ClipCache): Promise<void> {
  await ensureDir(paths.designDir);
  await writeTextAtomic(paths.designClipEmbeddings, `${JSON.stringify(cache)}\n`);
}

interface CardImageEntry {
  readonly card: DesignCard;
  readonly image: DesignCard['images'][number];
  readonly file: string;
  readonly sha: string;
}

async function collectCardImages(
  paths: SharedPaths,
  manifest: DesignManifest,
  licenseRequired: boolean
): Promise<CardImageEntry[]> {
  const entries: CardImageEntry[] = [];
  for (const card of manifest.cards) {
    if (card.status !== 'active') continue;
    if (designCardKind(card) === 'anti-pattern') continue;
    if (licenseRequired && card.source.license.toLowerCase() === 'unknown') continue;
    for (const image of card.images) {
      const file = join(paths.designDir, image.path);
      if (!(await fileExists(file))) continue;
      entries.push({ card, image, file, sha: image.sha256 ?? (await sha256File(file)) });
    }
  }
  return entries;
}

/** Embed missing card images in small batches (mutates the cache). */
async function ensureClipVectors(
  entries: readonly CardImageEntry[],
  client: Awaited<ReturnType<typeof createClipClient>>,
  cache: ClipCache
): Promise<{ computed: number; cached: number }> {
  let computed = 0;
  let cached = 0;
  const missing: CardImageEntry[] = [];
  for (const entry of entries) {
    if (cache.vectors[`img:${entry.sha}`] === undefined) missing.push(entry);
    else cached += 1;
  }
  for (let start = 0; start < missing.length; start += 16) {
    const batch = missing.slice(start, start + 16);
    const buffers = await Promise.all(batch.map((entry) => readFile(entry.file)));
    const response = await client({ images: buffers });
    if (response.imageEmbeddings.length !== batch.length) throw new Error('CLIP 图片向量条数不一致');
    batch.forEach((entry, index) => {
      cache.vectors[`img:${entry.sha}`] = response.imageEmbeddings[index] ?? [];
    });
    computed += batch.length;
  }
  return { computed, cached };
}

/**
 * Rank cards by perceptual similarity to a query PNG (0.6.4).
 * With a CLIP config the final score blends pHash and multimodal similarity.
 */
export async function searchDesignByImage(
  paths: SharedPaths,
  manifest: DesignManifest,
  queryPath: string,
  topK: number,
  options: {
    readonly licenseRequired: boolean;
    readonly clip?: { readonly config: ClipConfig; readonly weight: number };
  }
): Promise<DesignImageSearchResult> {
  const queryImage: DecodedImage = decodePng(await readFile(queryPath));
  const query = imageFeatures(queryImage);
  const cache = await loadImageFeatureCache(paths);
  const entries = await collectCardImages(paths, manifest, options.licenseRequired);
  let computed = 0;
  let cached = 0;
  const perCard = new Map<string, DesignImageHit>();

  let clipVectors: { client: Awaited<ReturnType<typeof createClipClient>>; cache: ClipCache; query: readonly number[] } | undefined;
  const clipNotes: string[] = [];
  if (options.clip !== undefined) {
    try {
      const client = await createClipClient(options.clip.config);
      const clipCache = await loadClipCache(paths, options.clip.config.model);
      const stats = await ensureClipVectors(entries, client, clipCache);
      const queryKey = `img:${await sha256File(queryPath)}`;
      let queryVector = clipCache.vectors[queryKey];
      if (queryVector === undefined) {
        const response = await client({ images: [await readFile(queryPath)] });
        queryVector = response.imageEmbeddings[0] ?? [];
        clipCache.vectors[queryKey] = queryVector;
      }
      await saveClipCache(paths, clipCache);
      clipVectors = { client, cache: clipCache, query: queryVector };
      clipNotes.push(
        `多模态（CLIP）：${options.clip.config.model}，语义权重 ${options.clip.weight} · 图片向量 ${stats.computed} 新算 / ${stats.cached} 缓存`
      );
    } catch (error) {
      clipNotes.push(`CLIP 不可用（${(error as Error).message}），回退 pHash + 直方图`);
    }
  }

  for (const entry of entries) {
    let features = cache.features[entry.sha];
    if (features === undefined) {
      features = imageFeatures(decodePng(await readFile(entry.file)));
      cache.features[entry.sha] = features;
      computed += 1;
    } else {
      cached += 1;
    }
    const similarity = imageSimilarity(query, features);
    let score = similarity.score;
    let clipScore: number | undefined;
    if (clipVectors !== undefined) {
      const vector = clipVectors.cache.vectors[`img:${entry.sha}`] ?? [];
      clipScore = (cosineSimilarity(clipVectors.query, vector) + 1) / 2;
      const weight = Math.min(1, Math.max(0, options.clip?.weight ?? 0));
      score = Number(((1 - weight) * similarity.score + weight * clipScore).toFixed(4));
    }
    const current = perCard.get(entry.card.id);
    if (current !== undefined && current.score >= score) continue;
    perCard.set(entry.card.id, {
      cardId: entry.card.id,
      title: entry.card.title,
      score,
      hashDistance: similarity.hashDistance,
      hashSimilarity: similarity.hashSimilarity,
      histogramSimilarity: similarity.histogramSimilarity,
      ...(clipScore === undefined ? {} : { clipScore: Number(clipScore.toFixed(4)) }),
      license: entry.card.source.license,
      imagePath: entry.image.path
    });
  }
  if (computed > 0) {
    await writeTextAtomic(paths.designImageFeatures, `${JSON.stringify(cache)}\n`);
  }
  const results = [...perCard.values()]
    .sort((left, right) => (right.score === left.score ? left.cardId.localeCompare(right.cardId) : right.score - left.score))
    .slice(0, topK);
  return {
    query: { width: queryImage.width, height: queryImage.height, phash: query.phash },
    results,
    notes: [
      `以图搜图：pHash ${query.phash} · 特征 ${computed} 新算 / ${cached} 缓存`,
      ...clipNotes,
      '排序 = pHash/直方图（CLIP 开启时再与语义相似度融合）；query.mjs 不支持以图搜图（仅 DSH 侧）'
    ]
  };
}

/** Text→image search via the CLIP endpoint (0.6.5). */
export async function searchDesignByText(
  paths: SharedPaths,
  manifest: DesignManifest,
  text: string,
  topK: number,
  options: {
    readonly licenseRequired: boolean;
    readonly clip: { readonly config: ClipConfig; readonly weight: number };
  }
): Promise<DesignImageSearchResult> {
  const client = await createClipClient(options.clip.config);
  const cache = await loadClipCache(paths, options.clip.config.model);
  const entries = await collectCardImages(paths, manifest, options.licenseRequired);
  const stats = await ensureClipVectors(entries, client, cache);
  const textKey = `text:${sha256Text(`${options.clip.config.model}\u0000${text}`)}`;
  let textVector = cache.vectors[textKey];
  if (textVector === undefined) {
    const response = await client({ texts: [text] });
    textVector = response.textEmbeddings[0] ?? [];
    cache.vectors[textKey] = textVector;
  }
  await saveClipCache(paths, cache);
  const perCard = new Map<string, DesignImageHit>();
  for (const entry of entries) {
    const vector = cache.vectors[`img:${entry.sha}`] ?? [];
    const clipScore = (cosineSimilarity(textVector, vector) + 1) / 2;
    const current = perCard.get(entry.card.id);
    if (current !== undefined && current.score >= clipScore) continue;
    perCard.set(entry.card.id, {
      cardId: entry.card.id,
      title: entry.card.title,
      score: Number(clipScore.toFixed(4)),
      clipScore: Number(clipScore.toFixed(4)),
      license: entry.card.source.license,
      imagePath: entry.image.path
    });
  }
  const results = [...perCard.values()]
    .sort((left, right) => (right.score === left.score ? left.cardId.localeCompare(right.cardId) : right.score - left.score))
    .slice(0, topK);
  return {
    query: { text },
    results,
    notes: [
      `文本→图片：CLIP ${options.clip.config.model} · 图片向量 ${stats.computed} 新算 / ${stats.cached} 缓存`,
      '只比对卡片图片的语义相似度，不替代词法检索；query.mjs 不支持（仅 DSH 侧）'
    ]
  };
}

/** Render the image/text-search result table. */
export function renderDesignImageSearchMarkdown(result: DesignImageSearchResult): string {
  if (result.results.length === 0) {
    return ['本轮没有与查询相似的卡片。', ...result.notes.map((note) => `> ${note}`)].join('\n');
  }
  const rows = result.results.map((hit) => [
    `\`${hit.cardId}\``,
    hit.title,
    hit.score.toFixed(3),
    hit.hashDistance === undefined ? '—' : hit.hashDistance === 0 ? '0（相同）' : String(hit.hashDistance),
    hit.histogramSimilarity === undefined ? '—' : hit.histogramSimilarity.toFixed(3),
    hit.clipScore === undefined ? '—' : hit.clipScore.toFixed(3),
    hit.license,
    `\`${hit.imagePath}\``
  ]);
  return [
    '| ID | 标题 | 相似度 | pHash 距离 | 直方图 | CLIP | license | 图片 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    ...result.notes.map((note) => `> ${note}`)
  ].join('\n');
}

/** Default global directory for cross-project design packs (0.6.5). */
export function defaultDesignPacksDir(): string {
  return join(homedir(), '.dsh', 'dwguard', 'design-packs');
}

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
  readonly cardFiles?: ReadonlyArray<{ readonly file: string; readonly sourceId: string; readonly role: string }>;
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

const PACK_NAME = /^[a-z0-9][a-z0-9_-]{1,40}$/i;

/** Validate a pack name (safe as a directory name). */
export function isDesignPackName(value: string): boolean {
  return PACK_NAME.test(value);
}

/** Resolve a candidate under a trusted base; reject absolute/`..` escapes. */
function resolveInside(base: string, candidate: string, label: string): string {
  if (isAbsolute(candidate)) throw new DesignLibraryError(`${label} 不能是绝对路径：${candidate}`);
  const target = resolve(base, candidate);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DesignLibraryError(`${label} 越界：${candidate}`);
  }
  return target;
}

/** Resolve a real path and prove it is still inside the trusted base (symlink-safe). */
async function realInside(base: string, target: string, label: string): Promise<string> {
  const baseReal = await realpath(base);
  const targetReal = await realpath(target);
  const rel = relative(baseReal, targetReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DesignLibraryError(`${label} 指向包外（符号链接/Junction）：${target}`);
  }
  return targetReal;
}

/** Only known image extensions become refs; anything else is rejected. */
function safeImageExtension(file: string): string {
  const ext = extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
    throw new DesignLibraryError(`图片扩展名不受支持：${file}`);
  }
  return ext;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

/** List packs in the global directory (invalid packs are skipped). */
export async function listDesignPacks(dir: string): Promise<DesignPackSummary[]> {
  const names = (await listDir(dir)).sort();
  const summaries: DesignPackSummary[] = [];
  for (const name of names) {
    const raw = await readTextOrNull(join(dir, name, 'pack.json'));
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<DesignPack>;
      if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || typeof parsed.name !== 'string' || !Array.isArray(parsed.cards)) continue;
      summaries.push({
        name: parsed.name,
        cards: parsed.cards.length,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
        path: join(dir, name),
        schemaVersion: parsed.schemaVersion,
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
        ...(parsed.module === undefined ? {} : { module: parsed.module }),
        ...(parsed.tone === undefined ? {} : { tone: parsed.tone }),
        ...(parsed.supersedes === undefined ? {} : { supersedes: parsed.supersedes }),
        ...(parsed.supersededBy === undefined ? {} : { supersededBy: parsed.supersededBy }),
        ...(parsed.feedback === undefined ? {} : { feedback: parsed.feedback })
      });
    } catch {
      // A corrupt pack must not break the others.
    }
  }
  return summaries;
}

/** Export active cards (and their images) into `<dir>/<name>/pack.json`. */
export async function exportDesignPack(
  paths: SharedPaths,
  dir: string,
  manifest: DesignManifest,
  name: string,
  now: string
): Promise<DesignPackExportResult> {
  if (!isDesignPackName(name)) {
    throw new DesignLibraryError('包名只能使用字母、数字、`-`、`_`，长度 2–41，且以字母或数字开头。');
  }
  const active = manifest.cards.filter((card) => card.status === 'active');
  if (active.length === 0) throw new DesignLibraryError('设计库里没有 active 卡片，无法导出。');
  const packDir = join(dir, name);
  const warnings: string[] = [];
  const cards: DesignCard[] = [];
  for (const card of active) {
    const images: DesignCard['images'][number][] = [];
    for (const image of card.images) {
      const source = join(paths.designDir, image.path);
      if (!(await fileExists(source))) {
        warnings.push(`卡片 \`${card.id}\` 的图片 \`${image.path}\` 不存在，已跳过该图`);
        continue;
      }
      const sha = image.sha256 ?? (await sha256File(source));
      const ext = extname(image.path).toLowerCase() || '.png';
      const storedAs = `refs/${sha}${ext}`;
      await copyFileTo(source, join(packDir, storedAs));
      images.push({ ...image, path: storedAs, sha256: sha });
    }
    cards.push({ ...card, images });
  }
  const cardFiles = cards.map((card, index) => ({
    file: `cards/${String(index + 1).padStart(2, '0')}-${slugifyDesign(card.title)}.meta.json`,
    sourceId: card.id,
    role: designCardKind(card)
  }));
  await ensureDir(join(packDir, 'cards'));
  for (const [index, card] of cards.entries()) {
    const entry = cardFiles[index];
    if (entry === undefined) continue;
    await writeTextAtomic(join(packDir, entry.file), `${JSON.stringify(designCardToInboxMeta(card), null, 2)}\n`);
  }
  const pack: DesignPack = {
    schemaVersion: 2,
    name,
    createdAt: now,
    engineVersion: DESIGN_ENGINE_VERSION,
    status: 'draft',
    cards,
    cardFiles
  };
  await ensureDir(packDir);
  await writeTextAtomic(join(packDir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  return { dir: packDir, pack, warnings };
}

function packCardKey(name: string, card: DesignCard): string {
  return sha256Text(
    `pack|${name}|${card.title}|${card.source.kind}|${card.source.ref ?? ''}|${JSON.stringify(card.tokens)}|${card.rationale ?? ''}`
  );
}

/** Read and validate a pack; returns null when missing/invalid. */
export async function readDesignPack(dir: string, name: string): Promise<DesignPack | null> {
  if (!isDesignPackName(name)) throw new DesignLibraryError('包名只能使用字母、数字、`-`、`_`，长度 2–41。');
  const raw = await readTextOrNull(join(dir, name, 'pack.json'));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DesignPack>;
    if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || typeof parsed.name !== 'string' || !Array.isArray(parsed.cards)) return null;
    if (parsed.name !== name || !isDesignPackName(parsed.name)) return null;
    const cards = parsed.cards.filter((card): card is DesignCard => {
      if (typeof card !== 'object' || card === null) return false;
      const record = card as Record<string, unknown>;
      return typeof record['id'] === 'string' && typeof record['title'] === 'string';
    });
    return {
      ...parsed,
      schemaVersion: parsed.schemaVersion,
      name: parsed.name,
      createdAt: parsed.createdAt ?? '',
      engineVersion: parsed.engineVersion ?? '',
      cards
    };
  } catch {
    return null;
  }
}

/** Read the local pack registry (0.7.0); null when it does not exist yet. */
export async function readDesignPackRegistry(paths: SharedPaths): Promise<DesignPackRegistry | null> {
  const raw = await readTextOrNull(paths.designPacksIndex);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DesignPackRegistry>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.packs)) return null;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      packs: parsed.packs.filter(
        (entry): entry is DesignPackRegistryEntry =>
          typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
      )
    };
  } catch {
    return null;
  }
}

/** Persist the local pack registry. */
export async function writeDesignPackRegistry(paths: SharedPaths, registry: DesignPackRegistry): Promise<string> {
  await ensureDir(paths.designPacksLocalDir);
  await writeTextAtomic(paths.designPacksIndex, `${JSON.stringify(registry, null, 2)}\n`);
  return paths.designPacksIndex;
}

/** Rebuild the registry from local pack directories, preserving feedback/supersede state. */
export async function rebuildDesignPackRegistry(paths: SharedPaths, now: string): Promise<DesignPackRegistry> {
  const previous = await readDesignPackRegistry(paths);
  const previousByName = new Map((previous?.packs ?? []).map((entry) => [entry.name, entry]));
  const entries: DesignPackRegistryEntry[] = [];
  for (const name of (await listDir(paths.designPacksLocalDir)).sort()) {
    const pack = await readDesignPack(paths.designPacksLocalDir, name);
    if (pack === null) continue;
    const prior = previousByName.get(pack.name);
    const status = prior?.status ?? pack.status ?? 'draft';
    const supersededBy = pack.supersededBy ?? prior?.supersededBy;
    const feedback = prior?.feedback ?? pack.feedback;
    entries.push({
      name: pack.name,
      status,
      createdAt: pack.createdAt,
      ...(pack.specVersion === undefined ? {} : { specVersion: pack.specVersion }),
      ...(pack.module === undefined ? {} : { module: pack.module }),
      ...(pack.appType === undefined ? {} : { appType: pack.appType }),
      ...(pack.platform === undefined ? {} : { platform: pack.platform }),
      ...(pack.tone === undefined ? {} : { tone: pack.tone }),
      ...(pack.density === undefined ? {} : { density: pack.density }),
      ...(pack.preview === undefined ? {} : { preview: pack.preview }),
      cardIds: pack.cardFiles?.map((entry) => entry.sourceId) ?? pack.cards.map((card) => card.id),
      ...(pack.evidence === undefined ? {} : { evidence: pack.evidence }),
      ...(pack.supersedes === undefined ? {} : { supersedes: pack.supersedes }),
      ...(supersededBy === undefined ? {} : { supersededBy }),
      ...(feedback === undefined ? {} : { feedback })
    });
  }
  const registry: DesignPackRegistry = { schemaVersion: 1, updatedAt: now, packs: entries };
  await writeDesignPackRegistry(paths, registry);
  return registry;
}

/** Migrate a v1 pack to v2 (draft unless it already has evidence). */
export async function migrateDesignPack(dir: string, name: string): Promise<DesignPack> {
  const existing = await readDesignPack(dir, name);
  if (existing === null) throw new DesignLibraryError(`设计包 \`${name}\` 不存在或格式不正确。`);
  if (existing.schemaVersion === 2) return existing;
  const packDir = join(dir, name);
  const cardFiles = existing.cards.map((card, index) => ({
    file: `cards/${String(index + 1).padStart(2, '0')}-${slugifyDesign(card.title)}.meta.json`,
    sourceId: card.id,
    role: designCardKind(card)
  }));
  await ensureDir(join(packDir, 'cards'));
  for (const [index, card] of existing.cards.entries()) {
    const entry = cardFiles[index];
    if (entry === undefined) continue;
    await writeTextAtomic(join(packDir, entry.file), `${JSON.stringify(designCardToInboxMeta(card), null, 2)}\n`);
  }
  const migrated: DesignPack = {
    ...existing,
    schemaVersion: 2,
    status: existing.evidence === undefined ? 'draft' : 'paradigm',
    engineVersion: existing.engineVersion.length === 0 ? DESIGN_ENGINE_VERSION : existing.engineVersion,
    cards: existing.cards,
    cardFiles
  };
  await writeTextAtomic(join(packDir, 'pack.json'), `${JSON.stringify(migrated, null, 2)}\n`);
  return migrated;
}

/** Import a pack into the local library (new ids, deduped by semantic key). */
export async function importDesignPack(
  paths: SharedPaths,
  dir: string,
  name: string,
  now: string
): Promise<DesignPackImportResult> {
  const pack = await readDesignPack(dir, name);
  if (pack === null) throw new DesignLibraryError(`设计包 \`${name}\` 不存在或格式不正确。`);
  const packDir = join(dir, name);
  const manifest = (await readDesignManifest(paths)) ?? emptyManifest(now);
  const knownKeys = new Set(manifest.cards.map((card) => card.ingestKey).filter((key): key is string => key !== undefined));
  const cards: DesignCard[] = [...manifest.cards];
  const imported: DesignCard[] = [];
  const files: string[] = [];
  let skipped = 0;
  let localPreview: string | undefined;
  let previewPlan: { source: string; target: string } | undefined;

  // Validate every source/target before copying or writing anything.
  if (pack.preview !== undefined) {
    let previewRelative = pack.preview.replace(/\\/g, '/');
    const prefix = `design-packs/${name}/`;
    if (previewRelative.startsWith(prefix)) previewRelative = previewRelative.slice(prefix.length);
    if (previewRelative.endsWith('.html')) {
      const source = resolveInside(packDir, previewRelative, '设计包 preview');
      if (await fileExists(source)) {
        await realInside(packDir, source, '设计包 preview');
        const target = resolveInside(
          paths.designPacksLocalDir,
          join(name, 'preview', 'index.html'),
          '预览目标'
        );
        previewPlan = { source, target };
        localPreview = `design-packs/${name}/preview/index.html`;
      }
    }
  }

  const imagePlans = new Map<number, Array<{ source: string; target: string; storedAs: string; sha256: string; alt?: string }>>();
  for (const [index, sourceCard] of pack.cards.entries()) {
    const key = packCardKey(name, sourceCard);
    if (knownKeys.has(key)) {
      skipped += 1;
      continue;
    }
    knownKeys.add(key);
    const plans: Array<{ source: string; target: string; storedAs: string; sha256: string; alt?: string }> = [];
    for (const image of sourceCard.images) {
      if (typeof image.path !== 'string' || image.path.trim().length === 0) {
        throw new DesignLibraryError('设计包图片缺少 path。');
      }
      const source = resolveInside(packDir, image.path, '设计包图片');
      if (!(await fileExists(source))) continue;
      await realInside(packDir, source, '设计包图片');
      const actualSha = await sha256File(source);
      if (image.sha256 !== undefined) {
        if (!isSha256(image.sha256)) throw new DesignLibraryError(`设计包图片 sha256 非法：${image.sha256}`);
        if (image.sha256.toLowerCase() !== actualSha) {
          throw new DesignLibraryError(`设计包图片 sha256 不匹配：${image.path}`);
        }
      }
      const ext = safeImageExtension(image.path);
      const storedAs = `refs/${actualSha}${ext}`;
      const target = resolveInside(paths.designDir, storedAs, '图片目标');
      plans.push({ source, target, storedAs, sha256: actualSha, ...(image.alt === undefined ? {} : { alt: image.alt }) });
    }
    imagePlans.set(index, plans);

    const sourcePreview = sourceCard.preview;
    let safeSourcePreview: string | undefined;
    if (localPreview === undefined && sourcePreview !== undefined) {
      const candidate = sourcePreview.replace(/\\/g, '/');
      const source = resolveInside(paths.shared, candidate, '卡片 preview');
      if (await fileExists(source)) {
        await realInside(paths.shared, source, '卡片 preview');
        safeSourcePreview = candidate;
      }
    }

    const kind =
      sourceCard.kind === 'anti-pattern' ? 'anti-pattern' : sourceCard.kind === 'principle' ? 'principle' : 'pattern';
    const id = nextDesignId(cards, kind);
    const { preview: _ignoredPreview, ...rest } = sourceCard;
    const images: DesignCard['images'][number][] = plans.map((plan) => ({
      path: plan.storedAs,
      sha256: plan.sha256,
      ...(plan.alt === undefined ? {} : { alt: plan.alt })
    }));
    const card: DesignCard = {
      ...rest,
      id,
      images,
      status: 'active',
      updatedAt: now,
      ingestKey: key,
      ...(localPreview === undefined && safeSourcePreview === undefined ? {} : { preview: localPreview ?? safeSourcePreview })
    };
    cards.push(card);
    imported.push(card);
  }

  if (imported.length === 0) {
    return { manifest, imported, skipped, files, changed: false };
  }

  // Everything is validated; now perform the side effects.
  if (previewPlan !== undefined) {
    await ensureDir(dirname(previewPlan.target));
    await copyFileTo(previewPlan.source, previewPlan.target);
    files.push(displayPath(paths, previewPlan.target));
  }
  for (const plans of imagePlans.values()) {
    for (const plan of plans) {
      await ensureDir(dirname(plan.target));
      await copyFileTo(plan.source, plan.target);
      files.push(displayPath(paths, plan.target));
    }
  }
  const next: DesignManifest = { ...manifest, updatedAt: now, cards };
  files.push(...(await writeLibrary(paths, next)));
  return { manifest: (await readDesignManifest(paths)) ?? next, imported, skipped, files, changed: true };
}
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
export async function writeDesignReworkQueue(
  paths: SharedPaths,
  queue: DesignReworkQueue
): Promise<string> {
  await ensureDir(paths.designDir);
  await writeTextAtomic(paths.designReworkQueue, `${JSON.stringify(queue, null, 2)}\n`);
  return paths.designReworkQueue;
}

/** Read rework suggestions, scoped to the current pack version. */
export async function readDesignReworkQueue(
  paths: SharedPaths,
  specVersion: number
): Promise<DesignReworkQueue | null> {
  const raw = await readTextOrNull(paths.designReworkQueue);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record['specVersion'] !== specVersion || !Array.isArray(record['suggestions'])) return null;
    const suggestions: DesignReworkSuggestion[] = [];
    for (const item of record['suggestions']) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry['criterionId'] !== 'string' || typeof entry['query'] !== 'string') continue;
      suggestions.push({
        criterionId: entry['criterionId'],
        query: entry['query'],
        refs: Array.isArray(entry['refs'])
          ? (entry['refs'] as unknown[]).filter((ref): ref is string => typeof ref === 'string')
          : [],
        ...(typeof entry['reason'] === 'string' ? { reason: entry['reason'] } : {})
      });
    }
    return {
      schemaVersion: 1,
      specVersion,
      auditId: typeof record['auditId'] === 'number' ? record['auditId'] : 0,
      createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
      suggestions
    };
  } catch {
    return null;
  }
}

/** Drop rework suggestions once the round passes or a new pack starts. */
export async function clearDesignReworkQueue(paths: SharedPaths): Promise<void> {
  await removeFile(paths.designReworkQueue);
}

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

function buildBriefQuery(pack: TaskPack): string {
  const aesthetic = pack.criteria
    .filter((criterion) => criterion.dimension === 'aesthetic')
    .map((criterion) => `${criterion.statement} ${criterion.verify}`)
    .join(' ');
  return truncate(normalizeDesignText(`${pack.title} ${pack.requirement} ${aesthetic}`), 400);
}

function renderCardDetail(card: DesignCard): string[] {
  const lines = [`### \`${card.id}\` · ${card.title}`, ''];
  lines.push(`- 来源：${card.source.kind}${card.source.ref === undefined ? '' : `（${card.source.ref}）`} · license ${card.source.license}`);
  const tokens = tokensText(card.tokens);
  if (tokens.length > 0) lines.push(`- tokens：${tokens.split('\n').join('；')}`);
  if (card.stylePriority !== undefined && card.stylePriority.length > 0) {
    lines.push(`- 样式优先级：${card.stylePriority.join(' > ')}`);
  }
  if (card.antiPatterns !== undefined && card.antiPatterns.length > 0) {
    lines.push(`- 禁止项：${card.antiPatterns.map((id) => `\`${id}\``).join('、')}`);
  }
  if (card.checklist !== undefined && card.checklist.length > 0) {
    lines.push(`- 交付前检查：${card.checklist.join('；')}`);
  }
  if (card.dimensions !== undefined) {
    const dims = [
      card.dimensions.appType === undefined ? '' : `appType=${card.dimensions.appType}`,
      card.dimensions.platform === undefined ? '' : `platform=${card.dimensions.platform}`,
      card.dimensions.style === undefined ? '' : `style=${card.dimensions.style}`
    ].filter((item) => item.length > 0);
    if (dims.length > 0) lines.push(`- 维度：${dims.join(' · ')}`);
  }
  if (card.moduleTags !== undefined && card.moduleTags.length > 0) lines.push(`- 模块：${card.moduleTags.join('、')}`);
  if (card.tone !== undefined && card.tone.length > 0) lines.push(`- 气质：${card.tone.join('、')}`);
  if (card.density !== undefined) lines.push(`- 密度：${card.density}`);
  if (card.colorProfile !== undefined) {
    lines.push(`- 色彩特征：${card.colorProfile.temperature} / ${card.colorProfile.contrast} contrast`);
  }
  if (card.preview !== undefined) {
    lines.push(`- 预览（仅视觉参考，不复制代码）：\`${card.preview}\``);
  }
  if (card.principle !== undefined) lines.push(`- 原则：${truncate(card.principle, 240)}`);
  if (card.perceptualEffect !== undefined) lines.push(`- 感知效果：${card.perceptualEffect}`);
  if (card.proxies !== undefined && card.proxies.length > 0) lines.push(`- 可测代理：${card.proxies.join('；')}`);
  if (card.applications !== undefined && card.applications.length > 0) lines.push(`- 适用：${card.applications.join('；')}`);
  if (card.misuses !== undefined && card.misuses.length > 0) lines.push(`- 误用：${card.misuses.join('；')}`);
  if (card.rationale !== undefined) lines.push(`- 理由：${truncate(card.rationale, 240)}`);
  if (card.dos.length > 0) lines.push(`- Do：${card.dos.join('；')}`);
  if (card.donts.length > 0) lines.push(`- Don't：${card.donts.join('；')}`);
  if (card.images.length > 0) {
    lines.push(`- 图片：${card.images.map((image) => `\`${image.path}\``).join('、')}`);
  }
  lines.push('');
  return lines;
}

function renderBrandSection(brands: readonly DesignCard[]): string[] {
  if (brands.length === 0) return [];
  const lines = [
    '## 0. 品牌与业务约束（强制注入）',
    '',
    '> 以下约束优先于审美参考：参考可以取舍，品牌定位/业务约束不可违反。',
    ''
  ];
  for (const brand of brands) {
    lines.push(`### \`${brand.id}\` · ${brand.title}`, '');
    if (brand.brand?.positioning !== undefined) lines.push(`- 定位：${brand.brand.positioning}`);
    if ((brand.brand?.audience.length ?? 0) > 0) lines.push(`- 目标用户：${brand.brand?.audience.join('、') ?? ''}`);
    if ((brand.brand?.constraints.length ?? 0) > 0) lines.push(`- 业务约束：${brand.brand?.constraints.join('、') ?? ''}`);
    if ((brand.brand?.bannedStyles.length ?? 0) > 0) lines.push(`- 禁用风格：${brand.brand?.bannedStyles.join('、') ?? ''}`);
    if (brand.brand?.positioning === undefined && (brand.brand?.audience.length ?? 0) === 0 && (brand.brand?.constraints.length ?? 0) === 0) {
      lines.push(`- 参考：${brand.summary}`);
    }
    lines.push('');
  }
  return lines;
}

function renderPrincipleSection(principles: readonly DesignCard[]): string[] {
  if (principles.length === 0) return [];
  const lines = [
    '## 0.2 设计原则（方向）',
    '',
    '> 原则负责“往哪走”，具体布局/token 仍以参考卡片与任务包为准；原则不能直接当验收判据。',
    ''
  ];
  for (const principle of principles) {
    lines.push(`### \`${principle.id}\` · ${principle.title}`, '');
    if (principle.principle !== undefined) lines.push(`- 原则：${truncate(principle.principle, 240)}`);
    if (principle.perceptualEffect !== undefined) lines.push(`- 感知效果：${principle.perceptualEffect}`);
    if ((principle.proxies?.length ?? 0) > 0) lines.push(`- 可测代理：${principle.proxies?.join('；') ?? ''}`);
    if ((principle.applications?.length ?? 0) > 0) lines.push(`- 适用：${principle.applications?.join('；') ?? ''}`);
    if ((principle.misuses?.length ?? 0) > 0) lines.push(`- 误用：${principle.misuses?.join('；') ?? ''}`);
    if ((principle.checklist?.length ?? 0) > 0) lines.push(`- 检查项：${principle.checklist?.join('；') ?? ''}`);
    lines.push('');
  }
  return lines;
}

/** Render `tasks/design-brief.md`. */
export function renderDesignBriefMarkdown(
  pack: TaskPack,
  result: DesignSearchResult,
  cards: readonly DesignCard[],
  brands: readonly DesignCard[],
  principles: readonly DesignCard[],
  now: string,
  rework?: { readonly suggestions: readonly DesignReworkSuggestion[]; readonly cards: readonly DesignCard[] }
): string {
  const lines = [
    `# 设计参考简报 · ${pack.title}`,
    '',
    `> 任务包 v${pack.specVersion} · ${now} · 查询：\`${result.query}\` · 排序 ${result.ranker} · 命中 ${result.results.length} 张`,
    '> **参考是证据不是判据**：DSH 仍然独立取证；参考卡片不能替代设备上的验收证据。',
    '',
    ...renderBrandSection(brands),
    ...renderPrincipleSection(principles)
  ];
  if (result.notes.length > 0) lines.push(...result.notes.map((note) => `> ${note}`), '');
  const reworkLines =
    rework === undefined || rework.suggestions.length === 0
      ? []
      : [
          '## 0.5 上一轮返工定向参考',
          '',
          '> 这些检索词来自上一轮未通过的审美判据；实现时优先对照。',
          '',
          ...rework.suggestions.map(
            (suggestion) =>
              `- \`${suggestion.criterionId}\`：建议检索 \`${suggestion.query}\`${suggestion.refs.length === 0 ? '' : `；已有参考 ${suggestion.refs.map((ref) => `\`${ref}\``).join('、')}`}`
          ),
          '',
          ...(rework.cards.length === 0
            ? []
            : [
                '| ID | 标题 | 来源 | license |',
                '| --- | --- | --- | --- |',
                ...rework.cards.map(
                  (card) => `| \`${card.id}\` | ${card.title} | ${card.source.kind} | ${card.source.license} |`
                ),
                ''
              ])
        ];
  lines.push(...reworkLines);
  if (result.results.length === 0) {
    lines.push('本轮没有命中的参考卡片：按任务包与审美档案实现，不要自行发明风格。', '');
    return lines.join('\n');
  }
  lines.push(
    '## 1. 参考卡片',
    '',
    '| ID | 标题 | 来源 | license | 命中分 |',
    '| --- | --- | --- | --- | --- |',
    ...result.results.map(
      (hit) => `| \`${hit.cardId}\` | ${hit.title} | ${hit.source.kind} | ${hit.source.license} | ${hit.score.toFixed(2)} |`
    ),
    '',
    '## 2. 卡片详情',
    ''
  );
  for (const hit of result.results) {
    const card = cards.find((item) => item.id === hit.cardId);
    if (card !== undefined) lines.push(...renderCardDetail(card));
  }
  lines.push(
    '## 3. 怎么用',
    '',
    '- 实现前先读上面的 tokens 与 Do/Don\'t；需要更多参考就在 IDE 终端运行 `node .shared/design-library/query.mjs "<关键词>" --top 5 --json`。',
    '- 编码中需要 DSH 再找参考：往 `outbox-deveco.md` 追加 `design-request · #q-N · from=deveco to=dsh · re=#d-N` 记录，等 DSH 回 `inspiration`。',
    '- 最终判定以 DSH 的设备证据为准；参考不一致时先问用户，不要自行改验收标准。',
    ''
  );
  return lines.join('\n');
}

/**
 * Generate the design brief for the current pack and write it to disk.
 * Throws {@link DesignLibraryError} when the library is missing.
 */
export async function generateDesignBrief(
  paths: SharedPaths,
  options: Options,
  pack: TaskPack,
  now: string
): Promise<DesignBriefResult> {
  const manifest = await readDesignManifest(paths);
  if (manifest === null) {
    throw new DesignLibraryError('设计库尚未初始化；先运行 `dwguard_design` 的 `library init` + `library ingest`。');
  }
  const { index, chunks } = await readDesignIndex(paths);
  const query = buildBriefQuery(pack);
  const result = await searchDesignWithRanker(paths, options, manifest, index, chunks, query, options.designBriefCards, {
    licenseRequired: options.designLicenseRequired,
    filters: { kind: 'pattern' }
  });
  const cards = result.results
    .map((hit) => manifest.cards.find((card) => card.id === hit.cardId))
    .filter((card): card is DesignCard => card !== undefined);
  const brands = manifest.cards
    .filter((card) => card.source.kind === 'brand' && card.status === 'active')
    .slice(0, options.designBrandCards);
  const principleResult = await searchDesignWithRanker(
    paths,
    options,
    manifest,
    index,
    chunks,
    query,
    options.designPrincipleCards,
    { licenseRequired: options.designLicenseRequired, filters: { kind: 'principle' } }
  );
  const principles = principleResult.results
    .map((hit) => manifest.cards.find((card) => card.id === hit.cardId))
    .filter((card): card is DesignCard => card !== undefined);
  const queue = await readDesignReworkQueue(paths, pack.specVersion);
  let rework: DesignBriefResult['rework'];
  if (queue !== null && queue.suggestions.length > 0) {
    const seen = new Set(result.results.map((hit) => hit.cardId));
    const extraHits: DesignSearchHit[] = [];
    for (const suggestion of queue.suggestions.slice(0, 3)) {
      const extra = await searchDesignWithRanker(paths, options, manifest, index, chunks, suggestion.query, 2, {
        licenseRequired: options.designLicenseRequired,
        filters: { kind: 'pattern' }
      });
      for (const hit of extra.results) {
        if (seen.has(hit.cardId)) continue;
        seen.add(hit.cardId);
        extraHits.push(hit);
        if (extraHits.length >= 4) break;
      }
      if (extraHits.length >= 4) break;
    }
    const reworkCards = extraHits
      .map((hit) => manifest.cards.find((card) => card.id === hit.cardId))
      .filter((card): card is DesignCard => card !== undefined);
    rework = { suggestions: queue.suggestions, hits: extraHits, cards: reworkCards };
  }
  await writeTextAtomic(paths.designBriefMd, renderDesignBriefMarkdown(pack, result, cards, brands, principles, now, rework));
  return {
    file: paths.designBriefMd,
    query,
    hits: result.results,
    brands,
    principles,
    result,
    ...(rework === undefined ? {} : { rework })
  };
}

/** Feedback verdicts a card can receive (0.6.2 P3). */
export const DESIGN_FEEDBACK_VERDICTS = ['useful', 'off', 'block', 'unblock'] as const;

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

function clampWeight(weight: number): number {
  return Math.min(1.5, Math.max(0.5, Number(weight.toFixed(2))));
}

/**
 * Apply `useful / off / block / unblock` feedback.
 *
 * Weight moves inside 0.5–1.5 (useful ×1.1, off ×0.8); block hides the card from
 * search but keeps it in the manifest, and every verdict is appended to
 * `feedback.jsonl` (never deleted).
 */
export async function applyDesignFeedback(
  paths: SharedPaths,
  manifest: DesignManifest,
  entries: readonly DesignFeedbackInput[],
  now: string
): Promise<DesignFeedbackResult> {
  const applied: DesignFeedbackResult['applied'][number][] = [];
  const skipped: string[] = [];
  const events: string[] = [];
  let changed = false;
  let cards: DesignCard[] = [...manifest.cards];
  for (const entry of entries) {
    const index = cards.findIndex((card) => card.id === entry.cardId);
    if (index < 0) {
      skipped.push(entry.cardId);
      continue;
    }
    const card = cards[index];
    if (card === undefined) continue;
    let weight = card.weight;
    let status = card.status;
    if (entry.verdict === 'useful') {
      weight = clampWeight(weight * 1.1);
      status = 'active';
    } else if (entry.verdict === 'off') {
      weight = clampWeight(weight * 0.8);
    } else if (entry.verdict === 'block') {
      status = 'blocked';
    } else {
      status = 'active';
    }
    const next: DesignCard = { ...card, weight, status, updatedAt: now };
    cards = cards.map((item, itemIndex) => (itemIndex === index ? next : item));
    changed = changed || weight !== card.weight || status !== card.status;
    applied.push({ cardId: card.id, verdict: entry.verdict, weight, status });
    events.push(
      JSON.stringify({
        at: now,
        cardId: card.id,
        verdict: entry.verdict,
        weight,
        status,
        ...(entry.note === undefined ? {} : { note: entry.note })
      })
    );
  }
  let nextManifest: DesignManifest = { ...manifest, cards, updatedAt: changed ? now : manifest.updatedAt };
  const files: string[] = [];
  if (changed) {
    files.push(...(await writeLibrary(paths, nextManifest)));
    nextManifest = (await readDesignManifest(paths)) ?? nextManifest;
  }
  if (events.length > 0) {
    await appendText(paths.designFeedback, `${events.join('\n')}\n`);
    files.push(displayPath(paths, paths.designFeedback));
  }
  return { manifest: nextManifest, applied, skipped, files, changed };
}

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

const TOKEN_CAPS = 12;

function tokensFromMetrics(metrics: ReturnType<typeof extractMetrics>): DesignTokens {
  const palette: DesignColorToken[] = [];
  const spacing: DesignNumberToken[] = [];
  const radius: DesignNumberToken[] = [];
  const type: DesignNumberToken[] = [];
  const seen = new Set<string>();
  const pushNumber = (target: DesignNumberToken[], area: string, name: string, value: number, unit: string): void => {
    if (target.length >= TOKEN_CAPS) return;
    const key = `${area}:${name}:${value}${unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    target.push({ name, value, unit });
  };
  for (const [node, fields] of metrics) {
    for (const [field, value] of fields) {
      if (value.kind === 'color') {
        if (palette.length >= TOKEN_CAPS) continue;
        const key = `palette:${value.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        palette.push({ name: `${node}.${field}`, value: value.value });
        continue;
      }
      if (field === 'fontSize') {
        pushNumber(type, 'type', node, value.value, value.unit.length > 0 ? value.unit : 'fp');
      } else if (field === 'radius' || field === 'borderRadius' || field === 'cornerRadius') {
        pushNumber(radius, 'radius', node, value.value, value.unit.length > 0 ? value.unit : 'vp');
      } else if (field.startsWith('padding') || field.startsWith('margin')) {
        pushNumber(spacing, 'spacing', `${node}.${field}`, value.value, value.unit.length > 0 ? value.unit : 'vp');
      }
    }
  }
  return { palette, spacing, radius, type, motion: [] };
}

/**
 * Capture a passing baseline as a `project` card.
 *
 * The caller (tool) is responsible for the prerequisites: a passing audit for
 * the current pack version, a user confirmation, and the baseline entry itself.
 */
export async function captureDesignCard(
  paths: SharedPaths,
  manifest: DesignManifest,
  specVersion: number,
  input: CaptureDesignInput,
  now: string
): Promise<CaptureDesignResult> {
  const index = await readBaselineIndex(paths, specVersion);
  const entry: BaselineEntry | undefined = findBaselineEntry(index, input.page, input.state);
  if (entry === undefined) {
    throw new DesignLibraryError(
      `任务包 v${specVersion} 里没有 ${input.page}/${input.state} 的视觉基线；先通过审计 + 用户确认后 baseline save。`
    );
  }
  const ingestKey = sha256Text(`capture|${specVersion}|${entry.page}|${entry.state}|${entry.boundsSha256}`);
  const existing = manifest.cards.find((card) => card.source.kind === 'project' && card.ingestKey === ingestKey);
  if (existing !== undefined) {
    return { manifest, card: existing, changed: false, files: [] };
  }
  const boundsRead = await readBoundsJson(join(baselineDir(paths, specVersion), entry.boundsFile));
  if ('error' in boundsRead) throw new DesignLibraryError(`基线布局树不可读：${boundsRead.error}`);
  const tokens = tokensFromMetrics(extractMetrics(boundsRead.value));
  const images: Array<{ path: string; sha256: string; alt: string }> = [];
  if (entry.screenshotFile !== undefined) {
    const source = join(baselineDir(paths, specVersion), entry.screenshotFile);
    if (await fileExists(source)) {
      const sha = await sha256File(source);
      const ext = extname(entry.screenshotFile).toLowerCase() || '.png';
      const storedAs = `refs/${sha}${ext}`;
      await copyFileTo(source, join(paths.designDir, storedAs));
      images.push({ path: storedAs, sha256: sha, alt: `${input.page}/${input.state}` });
    }
  }
  const title = input.title ?? `项目模式 · ${input.page}/${input.state}`;
  const card: DesignCard = {
    id: nextDesignId(manifest.cards),
    title,
    summary: `从任务包 v${specVersion} 的视觉基线捕获（${input.page}/${input.state}）；通过审计 + 用户确认。`,
    tags: ['project', input.page, input.state, ...(input.tags ?? [])].slice(0, 12),
    source: { kind: 'project', ref: `baseline:${specVersion}:${input.page}/${input.state}`, license: 'internal' },
    tokens,
    rationale: input.note ?? '通过审计与用户确认后的项目模式，可作为后续轮次的参考。',
    dos: [],
    donts: [],
    images,
    status: 'active',
    weight: 1,
    createdAt: now,
    updatedAt: now,
    ingestKey,
    ...(deriveColorProfile(tokens) === undefined ? {} : { colorProfile: deriveColorProfile(tokens) })
  };
  const nextManifest: DesignManifest = { ...manifest, updatedAt: now, cards: [...manifest.cards, card] };
  const files = await writeLibrary(paths, nextManifest);
  const written = (await readDesignManifest(paths)) ?? nextManifest;
  return { manifest: written, card, changed: true, files };
}

/** Generate the dependency-free read-only query CLI (same ranking as the tool). */
export function renderQueryCli(): string {
  return [
    '#!/usr/bin/env node',
    '/**',
    ' * dwguard design-library query CLI (generated by dwguard_design).',
    ' * Read-only, dependency-free: reads manifest.json / index.json / chunks.jsonl',
    ' * from this directory and prints the same ranking the DSH tool computes.',
    ' *',
    ' * Usage:',
    ' *   node query.mjs "深色 卡片 间距" [--top 5] [--json] [--markdown] [--include-unknown-license]',
    ' */',
    "import { readFile } from 'node:fs/promises';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const DIR = dirname(fileURLToPath(import.meta.url));',
    'const STOP = new Set(' + JSON.stringify([...STOP_WORDS]) + ');',
    'const GROUPS = ' + JSON.stringify(SYNONYM_GROUPS) + ';',
    'const VARIANTS = {};',
    'for (const group of GROUPS) for (const word of group) VARIANTS[word] = group;',
    '',
    'function tokenize(text) {',
    '  const tokens = [];',
    '  const matches = text.toLowerCase().matchAll(/[a-z0-9]+|[\\u4e00-\\u9fff]+/g);',
    '  for (const match of matches) {',
    '    const span = match[0];',
    '    if (span.length === 0) continue;',
    '    if (/^[a-z0-9]+$/.test(span)) { if (!STOP.has(span)) tokens.push(span); continue; }',
    '    if (span.length === 1) { if (!STOP.has(span)) tokens.push(span); continue; }',
    '    for (let i = 0; i < span.length - 1; i += 1) {',
    '      const bigram = span.slice(i, i + 2);',
    '      if (!STOP.has(bigram)) tokens.push(bigram);',
    '    }',
    '  }',
    '  return tokens;',
    '}',
    '',
    'function expand(tokens) {',
    '  const out = new Set();',
    '  for (const token of tokens) {',
    '    out.add(token);',
    '    const group = VARIANTS[token];',
    '    if (group === undefined) continue;',
    '    for (const word of group) for (const part of tokenize(word)) out.add(part);',
    '  }',
    '  return [...out];',
    '}',
    '',
    'function constraints(query) {',
    '  const numbers = [];',
    "  for (const match of query.matchAll(/(\\d+(?:\\.\\d+)?)\\s*(vp|dp|px|pt|fp|ms|%|deg)?/g)) numbers.push({ value: Number(match[1]), unit: match[2] ?? 'vp' });",
    '  const colors = [...query.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase());',
    '  return { numbers, colors };',
    '}',
    '',
    'function search(query, topK, licenseRequired, filters) {',
    '  const qTokens = expand(tokenize(query));',
    '  const q = constraints(query);',
    '  const chunkScores = new Map();',
    '  const chunkMeta = new Map(index.chunks.map((chunk) => [chunk.chunkId, chunk]));',
    '  const avg = index.avgLen === 0 ? 1 : index.avgLen;',
    '  for (const token of new Set(qTokens)) {',
    '    const postings = index.postings[token];',
    '    if (postings === undefined) continue;',
    '    const df = index.df[token] ?? postings.length;',
    '    const idf = Math.log(1 + (index.totalChunks - df + 0.5) / (df + 0.5));',
    '    for (const [chunkId, tf] of postings) {',
    '      const length = chunkMeta.get(chunkId)?.len ?? 0;',
    '      const denominator = tf + 1.2 * (1 - 0.75 + (0.75 * length) / avg);',
    '      chunkScores.set(chunkId, (chunkScores.get(chunkId) ?? 0) + idf * ((tf * (1.2 + 1)) / denominator));',
    '    }',
    '  }',
    '  const byCard = new Map();',
    '  const chunkOwner = new Map();',
    '  for (const chunk of chunks) chunkOwner.set(chunk.chunkId, chunk);',
    '  for (const [chunkId, score] of chunkScores) {',
    '    const chunk = chunkOwner.get(chunkId);',
    '    if (chunk === undefined) continue;',
    '    const current = byCard.get(chunk.cardId);',
    '    if (current === undefined || score > current.score) byCard.set(chunk.cardId, { score, chunkId });',
    '  }',
    '  const cardById = new Map(manifest.cards.map((card) => [card.id, card]));',
    '  const results = [];',
    '  for (const card of manifest.cards) {',
    "    if (card.status !== 'active') continue;",
    "    if (licenseRequired && card.source.license.toLowerCase() === 'unknown') continue;",
    "    const cardKind = card.source.kind === 'brand' ? 'brand' : (card.kind === 'anti-pattern' ? 'anti-pattern' : (card.kind === 'principle' ? 'principle' : 'pattern'));",
    '    if (cardKind !== filters.kind) continue;',
    '    if (filters.appType !== undefined) {',
    '      const value = card.dimensions && card.dimensions.appType;',
    '      if (value === undefined || String(value).trim().toLowerCase() !== String(filters.appType).trim().toLowerCase()) continue;',
    '    }',
    '    if (filters.platform !== undefined) {',
    '      const value = card.dimensions && card.dimensions.platform;',
    '      if (value === undefined || String(value).trim().toLowerCase() !== String(filters.platform).trim().toLowerCase()) continue;',
    '    }',
    '    if (filters.style !== undefined) {',
    '      const wanted = String(filters.style).trim().toLowerCase();',
    '      const dimension = card.dimensions && card.dimensions.style;',
    '      const ranked = (card.stylePriority || []).some((style) => String(style).trim().toLowerCase() === wanted);',
    '      if ((dimension === undefined || String(dimension).trim().toLowerCase() !== wanted) && !ranked) continue;',
    '    }',
    '    const best = byCard.get(card.id);',
    '    const bm25 = best === undefined ? 0 : best.score;',
    '    if (bm25 === 0 && qTokens.length > 0) continue;',
    '    let tokenBoost = 0;',
    '    for (const color of q.colors) if ((card.tokens.palette || []).some((token) => token.value.toUpperCase() === color)) tokenBoost += 0.5;',
    '    for (const number of q.numbers) {',
    '      const all = [].concat(card.tokens.spacing || [], card.tokens.radius || [], card.tokens.type || [], card.tokens.motion || []);',
    '      if (all.some((token) => token.value === number.value && token.unit === number.unit)) tokenBoost += 0.5;',
    '    }',
    '    const tagTokens = new Set(tokenize((card.tags || []).join(" ")));',
    '    const tagBoost = qTokens.some((token) => tagTokens.has(token)) ? 0.3 : 0;',
    '    const weight = Math.min(1.5, Math.max(0.5, card.weight));',
    '    const chunk = best === undefined ? undefined : chunkOwner.get(best.chunkId);',
    '    results.push({',
    '      cardId: card.id,',
    '      title: card.title,',
    '      kind: cardKind,',
    '      score: Number(((bm25 + tokenBoost + tagBoost) * weight).toFixed(4)),',
    '      breakdown: { bm25: Number(bm25.toFixed(4)), tokenBoost: Number(tokenBoost.toFixed(4)), tagBoost: Number(tagBoost.toFixed(4)), profileBoost: 0, weight },',
    '      snippet: (chunk === undefined ? (card.summary || "") : chunk.text).slice(0, 160),',
    '      tokens: card.tokens,',
    '      source: card.source,',
    '      images: card.images || []',
    '    });',
    '  }',
    '  results.sort((left, right) => (right.score === left.score ? left.cardId.localeCompare(right.cardId) : right.score - left.score));',
    '  return results.slice(0, topK);',
    '}',
    '',
    'const args = process.argv.slice(2);',
    'const flags = new Set();',
    'let top = 5;',
    'let kind = "pattern";',
    'let appType; let platform; let style;',
    'const words = [];',
    'for (let i = 0; i < args.length; i += 1) {',
    '  if (args[i] === "--top") { top = Number(args[i + 1]); i += 1; continue; }',
    '  if (args[i] === "--kind") { kind = args[i + 1]; i += 1; continue; }',
    '  if (args[i] === "--app-type") { appType = args[i + 1]; i += 1; continue; }',
    '  if (args[i] === "--platform") { platform = args[i + 1]; i += 1; continue; }',
    '  if (args[i] === "--style") { style = args[i + 1]; i += 1; continue; }',
    '  if (args[i] === "--json") { flags.add("json"); continue; }',
    '  if (args[i] === "--markdown") { flags.add("markdown"); continue; }',
    '  if (args[i] === "--include-unknown-license") { flags.add("all-licenses"); continue; }',
    '  words.push(args[i]);',
    '}',
    'const query = words.join(" ").trim();',
    'if (query.length === 0) { console.error("usage: node query.mjs \\"<query>\\" [--top N] [--kind pattern|anti-pattern|brand] [--app-type X] [--platform X] [--style X] [--json]"); process.exit(2); }',
    'if (!Number.isFinite(top) || top < 1) { console.error("invalid --top"); process.exit(2); }',
    'if (kind !== "pattern" && kind !== "anti-pattern" && kind !== "brand" && kind !== "principle") { console.error("invalid --kind"); process.exit(2); }',
    'let manifest; let index; let chunks;',
    'try {',
    '  manifest = JSON.parse(await readFile(join(DIR, "manifest.json"), "utf8"));',
    '  index = JSON.parse(await readFile(join(DIR, "index.json"), "utf8"));',
    '  chunks = (await readFile(join(DIR, "chunks.jsonl"), "utf8")).split("\\n").filter(Boolean).map((line) => JSON.parse(line));',
    '} catch (error) {',
    '  console.error("design library not ready: " + (error && error.message ? error.message : String(error)));',
    '  process.exit(2);',
    '}',
    'const licenseRequired = !flags.has("all-licenses");',
    'const results = search(query, top, licenseRequired, { kind, appType, platform, style });',
    'const output = { schemaVersion: 1, query, ranker: "lexical", requestedRanker: "lexical", totalChunks: index.totalChunks, notes: [], results };',
    'if (flags.has("json")) {',
    '  console.log(JSON.stringify(output, null, 2));',
    '} else {',
    '  if (results.length === 0) console.log("no results for: " + query);',
    '  else {',
    '    console.log("query: " + query + "  (top " + results.length + "/" + index.totalChunks + " chunks)");',
    '    for (const hit of results) console.log("- " + hit.cardId + "  " + hit.score.toFixed(2) + "  " + hit.title + "  [" + hit.source.license + "]");',
    '  }',
    '  console.log("");',
    '}'
  ].join('\n') + '\n';
}
