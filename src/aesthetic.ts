/**
 * Aesthetic preferences: the profile, deterministic extraction, confidence and
 * conflict rules, and the learn → user choice → apply loop.
 *
 * Nothing here writes as a side effect of `learn`: proposals are computed in
 * memory and only an explicit, user-confirmed `apply` touches the profile.
 *
 * @module dwguard-dsh-hmos/aesthetic
 */

import { join } from 'node:path';

import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { appendText, readTextOrNull, writeTextAtomic } from './util/fs.js';
import { inline, table, truncate } from './util/md.js';

/** Preference areas an entry can belong to. */
export const AESTHETIC_AREAS = [
  'palette',
  'spacing',
  'radius',
  'type',
  'density',
  'motion',
  'dark',
  'icon',
  'card'
] as const;

/** One preference area. */
export type AestheticArea = (typeof AESTHETIC_AREAS)[number];

/** Chinese labels used by generated documents. */
export const AREA_LABELS: Record<AestheticArea, string> = {
  palette: '配色',
  spacing: '间距',
  radius: '圆角',
  type: '字号',
  density: '密度',
  motion: '动效',
  dark: '深色',
  icon: '图标',
  card: '卡片'
};

/** Where a preference came from. */
export const AESTHETIC_SOURCE_KINDS = [
  'confirmation',
  'rejection',
  'audit-finding',
  'calibration-miss',
  'project-resources'
] as const;

/** One evidence source kind. */
export type AestheticSourceKind = (typeof AESTHETIC_SOURCE_KINDS)[number];

/** Chinese labels for the source kinds. */
export const SOURCE_LABELS: Record<AestheticSourceKind, string> = {
  confirmation: '用户确认',
  rejection: '用户驳回',
  'audit-finding': '审计发现',
  'calibration-miss': '校准漏检',
  'project-resources': '项目资源'
};

/** Starting confidence per source kind (0.6.1 plan §5 / §1). */
export const SOURCE_BASE_CONFIDENCE: Record<AestheticSourceKind, number> = {
  confirmation: 0.7,
  rejection: 0.4,
  'audit-finding': 0.5,
  'calibration-miss': 0.6,
  'project-resources': 0.6
};

/** A measurable preference value: a number+unit or a colour token. */
export interface AestheticValue {
  readonly number?: number;
  readonly unit?: string;
  readonly color?: string;
}

/** One accepted preference. */
export interface AestheticEntry {
  /** Stable id (`AES-RADIUS-01`). */
  readonly id: string;
  readonly area: AestheticArea;
  /** Human-readable decision, e.g. `卡片圆角 20vp`. */
  readonly decision: string;
  readonly value: AestheticValue;
  /** Where it came from (`confirmation-3`, `learn:rejection#2`, `project-resources`). */
  readonly source: string;
  readonly evidence: readonly string[];
  /** 0–1. */
  readonly confidence: number;
  readonly status: 'active' | 'superseded';
  readonly updatedAt: string;
  /** Set on a superseded entry, pointing at the replacement. */
  readonly supersededBy?: string;
}

/** The whole profile document. */
export interface AestheticProfile {
  readonly schemaVersion: 1;
  readonly entries: readonly AestheticEntry[];
}

/** One append-only history event. */
export interface AestheticHistoryEvent {
  readonly at: string;
  readonly kind: 'proposed' | 'applied' | 'superseded' | 'conflict';
  readonly id?: string;
  readonly area?: AestheticArea;
  readonly value?: string;
  readonly sources?: readonly string[];
  readonly note?: string;
}

/** Whether a value is one of the nine preference areas. */
export function isAestheticArea(value: unknown): value is AestheticArea {
  return typeof value === 'string' && (AESTHETIC_AREAS as readonly string[]).includes(value);
}

/** Whether a value is one of the source kinds. */
export function isAestheticSourceKind(value: unknown): value is AestheticSourceKind {
  return typeof value === 'string' && (AESTHETIC_SOURCE_KINDS as readonly string[]).includes(value);
}

/** A fresh, empty profile. */
export function emptyProfile(): AestheticProfile {
  return { schemaVersion: 1, entries: [] };
}

/** Render a value as `20vp` / `#FF0000`. */
export function valueLabel(value: AestheticValue): string {
  const parts: string[] = [];
  if (value.number !== undefined) parts.push(`${value.number}${value.unit ?? ''}`);
  if (value.color !== undefined) parts.push(value.color.toUpperCase());
  return parts.join(' ').trim();
}

/** Human-readable label including the area, e.g. `圆角 20vp`. */
export function areaValueLabel(area: AestheticArea, value: AestheticValue): string {
  return `${AREA_LABELS[area]} ${valueLabel(value)}`;
}

/** Normalize user-supplied value fields for an area. */
export function normalizeValue(
  area: AestheticArea,
  raw: { number?: unknown; unit?: unknown; color?: unknown }
): { value?: AestheticValue; error?: string } {
  const hasNumber = raw.number !== undefined && raw.number !== null && raw.number !== '';
  const hasColor = typeof raw.color === 'string' && raw.color.trim().length > 0;
  if (hasNumber && hasColor) return { error: '取值只能是数值或颜色之一，不能同时给。' };
  if (hasColor) {
    const color = String(raw.color).trim();
    if (!/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(color)) return { error: `颜色 \`${color}\` 必须是 #RRGGBB。` };
    return { value: { color: color.toUpperCase().slice(0, 7) } };
  }
  if (!hasNumber) return { error: '缺少取值：给 `number`（可配 `unit`）或 `color`。' };
  const numeric = typeof raw.number === 'number' ? raw.number : Number(String(raw.number).trim());
  if (!Number.isFinite(numeric) || numeric < 0) return { error: '`number` 必须是非负数值。' };
  const rawUnit = typeof raw.unit === 'string' ? raw.unit.trim() : '';
  const unit = rawUnit.length > 0 ? rawUnit : area === 'motion' ? 'ms' : 'vp';
  if (!/^(vp|dp|px|pt|ms|%|deg)$/.test(unit)) return { error: `单位 \`${unit}\` 不支持（vp / dp / px / pt / ms / % / deg）。` };
  return { value: { number: numeric, unit } };
}

/** Round a confidence to two decimals and clamp it into 0–1. */
export function clampConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/** Apply one evidence delta: confirm +0.1, reject −0.2, repeat +0.05. */
export function adjustConfidence(current: number, kind: 'confirm' | 'reject' | 'repeat'): number {
  const delta = kind === 'confirm' ? 0.1 : kind === 'reject' ? -0.2 : 0.05;
  return clampConfidence(current + delta);
}

const AREA_KEYWORDS: ReadonlyArray<{ area: AestheticArea; words: readonly string[] }> = [
  { area: 'spacing', words: ['间距', '留白', '边距', '内边距', '外边距', 'padding', 'margin', 'gap', 'spacing'] },
  { area: 'radius', words: ['圆角', 'radius', 'corner'] },
  { area: 'type', words: ['字号', '字重', '行高', '字体', 'font', 'type', '文字大小'] },
  { area: 'density', words: ['密度', '紧凑', '宽松', 'density'] },
  { area: 'motion', words: ['动效', '动画', '时长', '缓动', 'duration', 'easing', 'ms'] },
  { area: 'dark', words: ['深色', '暗色', '夜间', 'dark'] },
  { area: 'icon', words: ['图标', 'icon'] },
  { area: 'card', words: ['卡片', '列表行', 'card'] },
  { area: 'palette', words: ['配色', '颜色', '主色', '强调色', '品牌色', '背景色', '前景色', 'color', 'palette'] }
];

/** Detect which preference areas a sentence mentions (deterministic order). */
export function detectAestheticAreas(text: string): AestheticArea[] {
  const lower = text.toLowerCase();
  const hits: Array<{ area: AestheticArea; index: number }> = [];
  for (const { area, words } of AREA_KEYWORDS) {
    for (const word of words) {
      const index = lower.indexOf(word.toLowerCase());
      if (index >= 0) {
        hits.push({ area, index });
        break;
      }
    }
  }
  hits.sort((left, right) => left.index - right.index);
  const ordered: AestheticArea[] = [];
  for (const hit of hits) if (!ordered.includes(hit.area)) ordered.push(hit.area);
  return ordered;
}

/** One extracted preference fact. */
export interface AestheticFact {
  readonly area: AestheticArea;
  readonly value: AestheticValue;
  readonly decision: string;
}

const CLAUSE_SPLIT = /[，。；;！？!?\n]+/;
const HEX_COLOR = /#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?/g;
const NUMERIC = /(\d+(?:\.\d+)?)\s*(vp|dp|px|pt|ms|%|deg)?/g;

/**
 * Extract measurable aesthetic facts from free text.
 *
 * Deterministic by design: clause split, area keywords, then numbers/colours in
 * the clause. No model call, no guessing about unstated preferences.
 */
export function extractAestheticFacts(text: string): AestheticFact[] {
  const facts: AestheticFact[] = [];
  const seen = new Set<string>();
  for (const rawClause of text.split(CLAUSE_SPLIT)) {
    const clause = rawClause.trim();
    if (clause.length === 0) continue;
    const areas = detectAestheticAreas(clause);
    const decisionBase = truncate(clause, 60);
    const hexRanges: Array<[number, number]> = [];
    for (const match of clause.matchAll(HEX_COLOR)) {
      const start = match.index;
      const color = match[0];
      hexRanges.push([start, start + color.length]);
      const key = `palette:${color.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        area: 'palette',
        value: { color: color.toUpperCase().slice(0, 7) },
        decision: truncate(`${decisionBase}（${color.toUpperCase()}）`, 80)
      });
    }
    if (areas.length === 0) continue;
    for (const match of clause.matchAll(NUMERIC)) {
      const index = match.index;
      if (hexRanges.some(([start, end]) => index >= start && index < end)) continue;
      const numeric = Number(match[1]);
      if (!Number.isFinite(numeric)) continue;
      const unit = match[2];
      // Pick the closest area keyword at or before the number; fall back to the
      // first area when the number precedes every keyword ("20vp 圆角").
      const lower = clause.toLowerCase();
      let best: { area: AestheticArea; index: number } | undefined;
      for (const { area, words } of AREA_KEYWORDS) {
        for (const word of words) {
          const at = lower.indexOf(word.toLowerCase());
          if (at < 0) continue;
          if (best === undefined || at > best.index) best = { area, index: at };
        }
      }
      const area = areas.length === 1 ? areas[0] : best === undefined ? areas[0] : best.area;
      if (area === undefined) continue;
      const value: AestheticValue = { number: numeric, unit: unit ?? (area === 'motion' ? 'ms' : 'vp') };
      const key = `${area}:${valueLabel(value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({ area, value, decision: truncate(decisionBase, 80) });
    }
  }
  return facts;
}

/** A model-supplied learn source. */
export interface LearnSource {
  readonly kind: AestheticSourceKind;
  readonly text: string;
  readonly evidence?: string;
}

/** One proposal produced by `learn` (never written until `apply`). */
export interface AestheticProposal {
  readonly id: string;
  readonly area: AestheticArea;
  readonly decision: string;
  readonly value: AestheticValue;
  readonly confidence: number;
  readonly reason: string;
  readonly sources: readonly string[];
  /** Existing active entry the proposal would reinforce (repeat evidence). */
  readonly mergeId?: string;
}

/** One candidate in a conflict. */
export interface AestheticConflictCandidate {
  readonly value: string;
  readonly decision: string;
  readonly sources: readonly string[];
  /** Existing entry id, absent for the newly proposed value. */
  readonly id?: string;
}

/** Two values for the same area: the user has to pick one. */
export interface AestheticConflict {
  readonly area: AestheticArea;
  readonly candidates: readonly AestheticConflictCandidate[];
  readonly question: string;
}

/** Output of `learnAesthetics` — nothing has been written. */
export interface AestheticLearnResult {
  readonly proposals: readonly AestheticProposal[];
  readonly conflicts: readonly AestheticConflict[];
}

/** Whether a string is a well-formed aesthetic id (`AES-RADIUS-01`). */
export function isAestheticId(value: string): boolean {
  return /^AES-[A-Z]+-\d{2,}$/.test(value);
}

/** Next free id for an area, seeded by the highest existing suffix. */
export function nextAestheticId(area: AestheticArea, entries: readonly AestheticEntry[]): string {
  const prefix = `AES-${area.toUpperCase()}-`;
  let max = 0;
  for (const entry of entries) {
    if (!entry.id.startsWith(prefix)) continue;
    const suffix = Number.parseInt(entry.id.slice(prefix.length), 10);
    if (Number.isFinite(suffix) && suffix > max) max = suffix;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

function activeEntries(profile: AestheticProfile, area?: AestheticArea): AestheticEntry[] {
  return profile.entries.filter(
    (entry) => entry.status === 'active' && (area === undefined || entry.area === area)
  );
}

/**
 * Compute proposals/conflicts for the current round. Pure: the profile is read,
 * never written.
 */
export function learnAesthetics(
  profile: AestheticProfile,
  facts: readonly AestheticFact[],
  sourcesByKey: ReadonlyMap<string, readonly string[]>,
  startConfidence: ReadonlyMap<string, number>
): AestheticLearnResult {
  const proposals: AestheticProposal[] = [];
  const conflicts: AestheticConflict[] = [];
  const planned: AestheticEntry[] = [];
  for (const fact of facts) {
    const key = `${fact.area}:${valueLabel(fact.value)}`;
    const sources = sourcesByKey.get(key) ?? [];
    const active = activeEntries(profile, fact.area);
    const same = active.find((entry) => valueLabel(entry.value) === valueLabel(fact.value));
    if (same !== undefined) {
      proposals.push({
        id: same.id,
        area: fact.area,
        decision: same.decision,
        value: same.value,
        confidence: adjustConfidence(same.confidence, 'repeat'),
        reason: '与现有偏好一致（重复证据 +0.05）',
        sources,
        mergeId: same.id
      });
      continue;
    }
    const others = active;
    if (others.length > 0) {
      const candidates: AestheticConflictCandidate[] = [
        ...others.map((entry) => ({
          value: valueLabel(entry.value),
          decision: entry.decision,
          sources: [entry.source],
          id: entry.id
        })),
        { value: valueLabel(fact.value), decision: fact.decision, sources }
      ];
      conflicts.push({
        area: fact.area,
        candidates,
        question: `「${AREA_LABELS[fact.area]}」已有 ${others
          .map((entry) => valueLabel(entry.value))
          .join(' / ')}，本轮提出 ${valueLabel(fact.value)}；保留哪个？`
      });
      continue;
    }
    const base = Math.max(0, ...(sources.map((source) => startConfidence.get(source) ?? 0)));
    const repeats = Math.max(0, sources.length - 1);
    const id = nextAestheticId(fact.area, [...profile.entries, ...planned]);
    const proposal: AestheticProposal = {
      id,
      area: fact.area,
      decision: fact.decision,
      value: fact.value,
      confidence: clampConfidence(base + repeats * 0.05),
      reason: '新偏好（来源置信度基数 + 重复证据）',
      sources
    };
    proposals.push(proposal);
    planned.push({
      id,
      area: fact.area,
      decision: fact.decision,
      value: fact.value,
      source: sources[0] ?? 'learn',
      evidence: [],
      confidence: proposal.confidence,
      status: 'active',
      updatedAt: ''
    });
  }
  return { proposals, conflicts };
}

/** Build the per-fact source labels and base confidences from learn sources. */
export function factsFromSources(sources: readonly LearnSource[]): {
  facts: AestheticFact[];
  sourcesByKey: Map<string, string[]>;
  startConfidence: Map<string, number>;
} {
  const facts: AestheticFact[] = [];
  const sourcesByKey = new Map<string, string[]>();
  const startConfidence = new Map<string, number>();
  const seen = new Map<string, AestheticFact>();
  for (const source of sources) {
    for (const fact of extractAestheticFacts(source.text)) {
      const key = `${fact.area}:${valueLabel(fact.value)}`;
      if (!seen.has(key)) {
        seen.set(key, fact);
        facts.push(fact);
      }
      const label = `learn:${source.kind}${source.evidence === undefined ? '' : `#${source.evidence}`}`;
      const list = sourcesByKey.get(key) ?? [];
      if (!list.includes(label)) list.push(label);
      sourcesByKey.set(key, list);
      startConfidence.set(label, SOURCE_BASE_CONFIDENCE[source.kind]);
    }
  }
  return { facts, sourcesByKey, startConfidence };
}

/** Parse the HarmonyOS `resources/base/element/*.json` seeds. */
export interface ProjectResourceResult {
  readonly facts: AestheticFact[];
  readonly files: string[];
}

interface ResourceItem {
  readonly name?: string;
  readonly value?: string;
}

function readResourceItems(raw: string | null, kind: 'color' | 'float'): ResourceItem[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const list = (parsed as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) return [];
    const items: ResourceItem[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      items.push({
        ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
        ...(typeof record['value'] === 'string' ? { value: record['value'] } : {})
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Cold-start seeds from the project's own resource files.
 * @param workspace - session working directory.
 */
export async function readProjectAestheticFacts(workspace: string): Promise<ProjectResourceResult> {
  const facts: AestheticFact[] = [];
  const files: string[] = [];
  const elementDir = join(workspace, 'resources', 'base', 'element');
  const colorFile = join(elementDir, 'color.json');
  const floatFile = join(elementDir, 'float.json');
  const colors = readResourceItems(await readTextOrNull(colorFile), 'color');
  if (colors.length > 0) files.push(colorFile);
  for (const item of colors) {
    const name = item.name ?? 'color';
    const value = item.value ?? '';
    const match = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.exec(value.trim());
    if (match === null) continue;
    facts.push({
      area: 'palette',
      value: { color: value.toUpperCase().slice(0, 7) },
      decision: `配色 ${name} = ${value.toUpperCase()}`
    });
  }
  const floats = readResourceItems(await readTextOrNull(floatFile), 'float');
  if (floats.length > 0) files.push(floatFile);
  for (const item of floats) {
    const name = item.name ?? 'float';
    const lower = name.toLowerCase();
    const area: AestheticArea | undefined = /space|padding|margin|gap|gutter|offset/.test(lower)
      ? 'spacing'
      : /radius|corner/.test(lower)
        ? 'radius'
        : /font|text|line/.test(lower)
          ? 'type'
          : undefined;
    if (area === undefined) continue;
    const value = item.value ?? '';
    const match = /^(\d+(?:\.\d+)?)\s*(vp|dp|px|pt)?$/.exec(value.trim());
    if (match === null) continue;
    facts.push({
      area,
      value: { number: Number(match[1]), unit: match[2] ?? 'vp' },
      decision: `${AREA_LABELS[area]} ${name} = ${value.trim()}`
    });
  }
  return { facts, files };
}

/** Result of applying proposals to the profile. */
export interface AestheticApplyOutcome {
  readonly profile: AestheticProfile;
  readonly applied: readonly AestheticEntry[];
  readonly superseded: readonly AestheticEntry[];
  readonly events: readonly AestheticHistoryEvent[];
  readonly unresolved: readonly AestheticConflict[];
}

/**
 * Apply proposals and conflict choices to a profile in memory.
 *
 * Unresolved conflicts are returned instead of guessed: the tool refuses the
 * write and asks the user to pass `choice`.
 */
export function applyAestheticProposals(
  profile: AestheticProfile,
  result: AestheticLearnResult,
  options: { readonly choice?: string; readonly now: string }
): AestheticApplyOutcome {
  const events: AestheticHistoryEvent[] = [];
  const applied: AestheticEntry[] = [];
  const superseded: AestheticEntry[] = [];
  const unresolved: AestheticConflict[] = [];
  let entries = [...profile.entries];

  const upsert = (entry: AestheticEntry): void => {
    entries = entries.map((item) => (item.id === entry.id ? entry : item));
  };

  for (const conflict of result.conflicts) {
    const choice = options.choice?.trim();
    if (choice === undefined || choice.length === 0) {
      unresolved.push(conflict);
      continue;
    }
    const chosen = conflict.candidates.find(
      (candidate) => candidate.value === choice || candidate.id === choice || candidate.decision === choice
    );
    if (chosen === undefined) {
      unresolved.push(conflict);
      continue;
    }
    if (chosen.id !== undefined) {
      const existing = entries.find((entry) => entry.id === chosen.id);
      if (existing !== undefined) {
        const updated: AestheticEntry = {
          ...existing,
          confidence: adjustConfidence(existing.confidence, 'confirm'),
          updatedAt: options.now
        };
        upsert(updated);
        events.push({
          at: options.now,
          kind: 'applied',
          id: updated.id,
          area: updated.area,
          value: valueLabel(updated.value),
          sources: [updated.source],
          note: '用户选择保留既有值（确认 +0.1）'
        });
        applied.push(updated);
      }
      continue;
    }
    const current = entries.filter((entry) => entry.status === 'active' && entry.area === conflict.area);
    const id = nextAestheticId(conflict.area, entries);
    const nextEntry: AestheticEntry = {
      id,
      area: conflict.area,
      decision: chosen.decision,
      value: parseValueFromLabel(chosen.value) ?? { number: 0, unit: 'vp' },
      source: chosen.sources[0] ?? 'learn',
      evidence: chosen.sources,
      confidence: 0.7,
      status: 'active',
      updatedAt: options.now
    };
    for (const old of current) {
      const retired: AestheticEntry = { ...old, status: 'superseded', supersededBy: id, updatedAt: options.now };
      upsert(retired);
      superseded.push(retired);
      events.push({
        at: options.now,
        kind: 'superseded',
        id: old.id,
        area: old.area,
        value: valueLabel(old.value),
        sources: [old.source],
        note: `被 ${id} 取代（用户选择新值 ${chosen.value}）`
      });
    }
    entries.push(nextEntry);
    applied.push(nextEntry);
    events.push({
      at: options.now,
      kind: 'conflict',
      id,
      area: nextEntry.area,
      value: valueLabel(nextEntry.value),
      sources: chosen.sources,
      note: `冲突已裁决：${conflict.question}`
    });
    events.push({
      at: options.now,
      kind: 'applied',
      id,
      area: nextEntry.area,
      value: valueLabel(nextEntry.value),
      sources: chosen.sources
    });
  }

  for (const proposal of result.proposals) {
    if (proposal.mergeId !== undefined) {
      const existing = entries.find((entry) => entry.id === proposal.mergeId);
      if (existing === undefined) continue;
      const updated: AestheticEntry = {
        ...existing,
        confidence: adjustConfidence(existing.confidence, 'repeat'),
        evidence: [...new Set([...existing.evidence, ...proposal.sources])],
        updatedAt: options.now
      };
      upsert(updated);
      applied.push(updated);
      events.push({
        at: options.now,
        kind: 'applied',
        id: updated.id,
        area: updated.area,
        value: valueLabel(updated.value),
        sources: proposal.sources,
        note: '重复证据 +0.05'
      });
      continue;
    }
    const entry: AestheticEntry = {
      id: proposal.id,
      area: proposal.area,
      decision: proposal.decision,
      value: proposal.value,
      source: proposal.sources[0] ?? 'learn',
      evidence: proposal.sources,
      confidence: proposal.confidence,
      status: 'active',
      updatedAt: options.now
    };
    entries.push(entry);
    applied.push(entry);
    events.push({
      at: options.now,
      kind: 'applied',
      id: entry.id,
      area: entry.area,
      value: valueLabel(entry.value),
      sources: proposal.sources
    });
  }

  return {
    profile: { schemaVersion: 1, entries },
    applied,
    superseded,
    events,
    unresolved
  };
}

function parseValueFromLabel(label: string): AestheticValue | undefined {
  const color = /^#([0-9A-Fa-f]{6})/.exec(label.trim());
  if (color !== null) return { color: `#${color[1]?.toUpperCase() ?? ''}`.slice(0, 7) };
  const numeric = /^(-?\d+(?:\.\d+)?)\s*(vp|dp|px|pt|ms|%|deg)?$/.exec(label.trim());
  if (numeric === null) return undefined;
  const unit = numeric[2] ?? 'vp';
  return { number: Number(numeric[1]), unit };
}

/** Render the profile markdown (table + machine-readable JSON fence). */
export function renderProfileMarkdown(profile: AestheticProfile): string {
  const rows = profile.entries.map((entry) => [
    `\`${entry.id}\``,
    AREA_LABELS[entry.area],
    entry.decision,
    valueLabel(entry.value),
    entry.confidence.toFixed(2),
    entry.source,
    entry.status,
    entry.updatedAt
  ]);
  return [
    '# 审美档案',
    '',
    '> 由 `dwguard_aesthetic` 维护：只记录有来源的偏好；被取代的条目标 `superseded`，不删除。',
    '> 机器可读的 JSON 在同一文件的末尾（marker 下方），不要手改表与 JSON 的对应关系。',
    '',
    table(['ID', '领域', '决策', '取值', '置信度', '来源', '状态', '更新时间'], rows),
    '',
    '<!-- aesthetic-profile:json -->',
    '',
    '```json',
    JSON.stringify(profile, null, 2),
    '```',
    ''
  ].join('\n');
}

/** Read the profile, tolerating a missing or corrupt document. */
export async function readProfile(paths: SharedPaths): Promise<AestheticProfile> {
  const raw = await readTextOrNull(paths.aestheticProfileMd);
  if (raw === null) return emptyProfile();
  const marker = raw.indexOf('<!-- aesthetic-profile:json -->');
  if (marker < 0) return emptyProfile();
  const fence = /```json\s*([\s\S]*?)```/.exec(raw.slice(marker));
  if (fence === null || fence[1] === undefined) return emptyProfile();
  try {
    const parsed: unknown = JSON.parse(fence[1]);
    if (typeof parsed !== 'object' || parsed === null) return emptyProfile();
    const entries = (parsed as Record<string, unknown>)['entries'];
    if (!Array.isArray(entries)) return emptyProfile();
    const valid: AestheticEntry[] = [];
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record['id'] !== 'string' ||
        !isAestheticArea(record['area']) ||
        typeof record['decision'] !== 'string' ||
        typeof record['source'] !== 'string' ||
        typeof record['confidence'] !== 'number' ||
        typeof record['value'] !== 'object' ||
        record['value'] === null
      ) {
        continue;
      }
      const valueRecord = record['value'] as Record<string, unknown>;
      const value: AestheticValue = {
        ...(typeof valueRecord['number'] === 'number' ? { number: valueRecord['number'] } : {}),
        ...(typeof valueRecord['unit'] === 'string' ? { unit: valueRecord['unit'] } : {}),
        ...(typeof valueRecord['color'] === 'string' ? { color: valueRecord['color'] } : {})
      };
      valid.push({
        id: record['id'],
        area: record['area'],
        decision: record['decision'],
        value,
        source: record['source'],
        evidence: Array.isArray(record['evidence'])
          ? (record['evidence'] as unknown[]).filter((item2): item2 is string => typeof item2 === 'string')
          : [],
        confidence: record['confidence'],
        status: record['status'] === 'superseded' ? 'superseded' : 'active',
        updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
        ...(typeof record['supersededBy'] === 'string' ? { supersededBy: record['supersededBy'] } : {})
      });
    }
    return { schemaVersion: 1, entries: valid };
  } catch {
    return emptyProfile();
  }
}

/** Write the profile markdown. */
export async function writeProfile(paths: SharedPaths, profile: AestheticProfile): Promise<void> {
  await writeTextAtomic(paths.aestheticProfileMd, renderProfileMarkdown(profile));
}

/** Append history events to `knowledge/aesthetic-history.jsonl`. */
export async function appendAestheticHistory(
  paths: SharedPaths,
  events: readonly AestheticHistoryEvent[]
): Promise<string | null> {
  if (events.length === 0) return null;
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  await appendText(paths.aestheticHistory, body);
  return paths.aestheticHistory;
}

/** Find an entry by id (active or superseded). */
export function findProfileEntry(profile: AestheticProfile, id: string): AestheticEntry | undefined {
  return profile.entries.find((entry) => entry.id === id);
}

/** Active entry ids, used by the audit gate to validate `profileRef`. */
export function activeProfileIds(profile: AestheticProfile): Set<string> {
  return new Set(profile.entries.filter((entry) => entry.status === 'active').map((entry) => entry.id));
}

/** Render proposals as a markdown table. */
export function renderProposals(proposals: readonly AestheticProposal[]): string {
  if (proposals.length === 0) return '（没有新的偏好提议）';
  return table(
    ['ID', '领域', '决策', '取值', '置信度', '来源', '说明'],
    proposals.map((proposal) => [
      `\`${proposal.id}\``,
      AREA_LABELS[proposal.area],
      proposal.decision,
      valueLabel(proposal.value),
      proposal.confidence.toFixed(2),
      proposal.sources.join('<br>') || '—',
      proposal.reason
    ])
  );
}

/** Render conflicts as a list of questions with candidates. */
export function renderConflicts(conflicts: readonly AestheticConflict[]): string {
  if (conflicts.length === 0) return '（没有冲突）';
  return conflicts
    .map(
      (conflict) =>
        `- **${AREA_LABELS[conflict.area]}**：${conflict.question}\n` +
        conflict.candidates
          .map(
            (candidate) =>
              `  - \`${candidate.value}\`（${candidate.decision}）${candidate.id === undefined ? ' · 本轮提议' : ` · ${candidate.id}`}`
          )
          .join('\n')
    )
    .join('\n');
}

/** Files the profile/history live in, as display paths. */
export function profileFiles(paths: SharedPaths): string[] {
  return [displayPath(paths, paths.aestheticProfileMd)];
}

/** Normalize a source label into something short enough for a table cell. */
export function sourceLabel(source: string): string {
  const learned = /^learn:([a-z-]+)(?:#(.+))?$/.exec(source);
  if (learned !== null && learned[1] !== undefined && isAestheticSourceKind(learned[1])) {
    const label = SOURCE_LABELS[learned[1]];
    return learned[2] === undefined ? label : `${label}（${inline(learned[2])}）`;
  }
  return inline(source);
}
