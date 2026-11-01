/**
 * Knowledge sedimentation into `.shared/knowledge/`.
 *
 * One markdown file per topic, one delimited record per entry, and a JSON index
 * that makes appends idempotent (the same conclusion recorded twice is skipped).
 *
 * @module dwguard-dsh-hmos/knowledge
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { appendText, readTextOrNull, writeTextAtomic } from './util/fs.js';
import { inline, truncate } from './util/md.js';

/** What kind of lesson an entry records. */
export type KnowledgeKind = 'decision' | 'pattern' | 'rework' | 'preference' | 'risk';

/** Model-supplied knowledge entry. */
export interface KnowledgeEntryInput {
  readonly topic: string;
  readonly kind: KnowledgeKind;
  readonly statement: string;
  readonly evidence?: string;
}

/** One record in the knowledge index. */
export interface KnowledgeRecord {
  readonly topic: string;
  readonly kind: KnowledgeKind;
  readonly hash: string;
  readonly at: string;
  readonly statement: string;
}

/** The knowledge index document. */
export interface KnowledgeIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly KnowledgeRecord[];
}

const KIND_LABELS: Record<KnowledgeKind, string> = {
  decision: '决策',
  pattern: '模式',
  rework: '返工教训',
  preference: '用户偏好',
  risk: '风险'
};

const KINDS = new Set<KnowledgeKind>(['decision', 'pattern', 'rework', 'preference', 'risk']);

/** Whether a value is one of the knowledge kinds. */
export function isKnowledgeKind(value: unknown): value is KnowledgeKind {
  return typeof value === 'string' && KINDS.has(value as KnowledgeKind);
}

/**
 * Sanitize a topic into a safe file stem.
 * @param raw - model-supplied topic.
 */
export function sanitizeTopic(raw: string): string {
  const cleaned = inline(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (cleaned.length === 0) return 'general';
  return truncate(cleaned, 48).replace(/\.$/, '');
}

function digest(kind: KnowledgeKind, statement: string): string {
  return createHash('sha256').update(`${kind}|${statement.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** Read the index, tolerating a missing or corrupt file. */
export async function readIndex(paths: SharedPaths): Promise<KnowledgeIndex> {
  const raw = await readTextOrNull(paths.knowledgeIndex);
  if (raw === null) return { schemaVersion: 1, entries: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { schemaVersion: 1, entries: [] };
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return { schemaVersion: 1, entries: [] };
    const records: KnowledgeRecord[] = [];
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record['topic'] !== 'string' ||
        typeof record['hash'] !== 'string' ||
        typeof record['statement'] !== 'string' ||
        !isKnowledgeKind(record['kind'])
      ) {
        continue;
      }
      records.push({
        topic: record['topic'],
        kind: record['kind'],
        hash: record['hash'],
        at: typeof record['at'] === 'string' ? record['at'] : '',
        statement: record['statement']
      });
    }
    return { schemaVersion: 1, entries: records };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

/** Outcome of one knowledge append. */
export interface KnowledgeAppendResult {
  readonly added: KnowledgeRecord[];
  readonly skipped: Array<{ topic: string; statement: string }>;
  readonly files: string[];
}

/**
 * Append knowledge entries, skipping exact repeats.
 * @param paths - resolved protocol layout.
 * @param entries - model-supplied entries.
 * @param now - ISO timestamp for the record and its heading.
 */
export async function appendKnowledge(
  paths: SharedPaths,
  entries: readonly KnowledgeEntryInput[],
  now: string
): Promise<KnowledgeAppendResult> {
  const index = await readIndex(paths);
  const known = new Set(index.entries.map((entry) => entry.hash));
  const records: KnowledgeRecord[] = [];
  const skipped: Array<{ topic: string; statement: string }> = [];
  const files = new Set<string>();

  for (const entry of entries) {
    const statement = inline(entry.statement);
    const hash = digest(entry.kind, statement);
    if (known.has(hash)) {
      skipped.push({ topic: sanitizeTopic(entry.topic), statement });
      continue;
    }
    const topic = sanitizeTopic(entry.topic);
    const record: KnowledgeRecord = {
      topic,
      kind: entry.kind,
      hash,
      at: now,
      statement: truncate(statement, 200)
    };
    known.add(hash);
    records.push(record);
    const file = join(paths.knowledgeDir, `${topic}.md`);
    files.add(file);
    const existing = await readTextOrNull(file);
    const head = existing === null ? `# 知识库 · ${topic}\n\n> 由 \`dwguard_knowledge\` 追加：结论 + 证据 + 时间。\n\n` : '';
    const evidence =
      entry.evidence !== undefined && inline(entry.evidence).length > 0 ? inline(entry.evidence) : '（未记录）';
    const block = [
      `## [${KIND_LABELS[entry.kind]}] ${now}`,
      '',
      `**结论**：${statement}`,
      '',
      `**证据**：${evidence}`,
      ''
    ].join('\n');
    await appendText(file, `${head}${block}\n`);
  }

  if (records.length > 0) {
    await writeTextAtomic(
      paths.knowledgeIndex,
      `${JSON.stringify({ schemaVersion: 1, entries: [...index.entries, ...records] }, null, 2)}\n`
    );
  }

  return {
    added: records,
    skipped,
    files: [...files].map((file) => displayPath(paths, file))
  };
}
