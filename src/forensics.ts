/**
 * Offline forensics for `devecocli log`: crash reports (jscrash / cppcrash /
 * appfreeze) and structured hilog summaries. Pure parsing: nothing is executed.
 *
 * @module dwguard-dsh-hmos/forensics
 */

export type CrashType = 'jscrash' | 'cppcrash' | 'appfreeze' | 'unknown';

/** One parsed crash / freeze report. */
export interface CrashReport {
  readonly type: CrashType;
  readonly pid?: number;
  readonly process?: string;
  readonly bundle?: string;
  readonly faultTime?: string;
  readonly reason?: string;
  readonly signal?: string;
  readonly topFrame?: string;
  readonly frames: readonly string[];
  readonly summary: string;
}

/** One hilog line (or JSON record) after normalization. */
export interface HilogEntry {
  readonly time?: string;
  readonly pid?: number;
  readonly tid?: number;
  readonly level?: string;
  readonly tag?: string;
  readonly message: string;
  readonly raw: string;
}

/** Folded message pattern with its repeat count. */
export interface FoldedMessage {
  readonly pattern: string;
  readonly count: number;
  readonly sample: string;
  readonly levels: readonly string[];
}

/** Structured summary of a hilog capture. */
export interface HilogSummary {
  readonly total: number;
  readonly parsed: number;
  readonly unparsed: number;
  readonly levels: Readonly<Record<string, number>>;
  readonly pids: ReadonlyArray<{ pid: number; count: number }>;
  readonly tags: ReadonlyArray<{ tag: string; count: number }>;
  readonly folded: readonly FoldedMessage[];
  readonly errors: readonly FoldedMessage[];
  readonly firstTimestamp?: string;
  readonly lastTimestamp?: string;
  readonly regex?: string;
  readonly pidFilter?: number;
  readonly matched?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

const FRAME_PATTERNS: readonly RegExp[] = [
  /^\s*#\d{1,3}\s+\S/, // native: #00 pc 0000000000...
  /^\s*#\d{1,3}\s+/, // generic numbered frame
  /^\s*at\s+\S/, // JS: at foo (file:1:2)
  /^\s*\[\d{1,3}\]\s+\S/ // bracketed frame
];

function collectFrames(block: string): string[] {
  const frames: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (FRAME_PATTERNS.some((pattern) => pattern.test(line))) {
      frames.push(trimmed.slice(0, 400));
      if (frames.length >= 32) break;
    }
  }
  return frames;
}

function crashTypeOf(block: string): CrashType {
  const lower = block.toLowerCase();
  if (/jscrash|js crash|javascript crash|jscrash/.test(lower)) return 'jscrash';
  if (/cppcrash|cpp crash|c\+\+ crash/.test(lower)) return 'cppcrash';
  if (/appfreeze|app freeze|freeze/.test(lower)) return 'appfreeze';
  return 'unknown';
}

function reportFromText(block: string): CrashReport | null {
  const trimmed = block.trim();
  if (trimmed.length === 0) return null;
  const frames = collectFrames(trimmed);
  const pidMatch = /(?:^|\n)\s*(?:pid|process id)[:\s]+(\d+)/i.exec(trimmed);
  const processMatch = /(?:^|\n)\s*process(?: name)?[:\s]+([^\n]+)/i.exec(trimmed);
  const bundleMatch = /(?:^|\n)\s*bundle(?: name)?[:\s]+([^\n]+)/i.exec(trimmed);
  const faultMatch = /(?:^|\n)\s*fault time[:\s]+([^\n]+)/i.exec(trimmed);
  const reasonMatch = /(?:^|\n)\s*reason[:\s]+([^\n]+)/i.exec(trimmed);
  const signalMatch = /(?:^|\n)\s*(?:signal|signal name)[:\s]+([^\n]+)/i.exec(trimmed);
  const timestampMatch = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(trimmed);
  const firstLine = trimmed.split('\n').find((line) => line.trim().length > 0) ?? '';
  const type = crashTypeOf(trimmed);
  // Only emit a report when the block looks like fault output, not a random log tail.
  const looksLikeCrash =
    type !== 'unknown' ||
    frames.length > 0 ||
    /fault time|reason:|signal|exception|abort|stack/i.test(trimmed);
  if (!looksLikeCrash) return null;
  return {
    type,
    ...(pidMatch === null ? {} : { pid: Number(pidMatch[1]) }),
    ...(processMatch === null ? {} : { process: (processMatch[1] ?? '').trim().slice(0, 200) }),
    ...(bundleMatch === null ? {} : { bundle: (bundleMatch[1] ?? '').trim().slice(0, 200) }),
    ...(faultMatch !== null
      ? { faultTime: (faultMatch[1] ?? '').trim().slice(0, 120) }
      : timestampMatch === null
        ? {}
        : { faultTime: timestampMatch[1] ?? '' }),
    ...(reasonMatch === null ? {} : { reason: (reasonMatch[1] ?? '').trim().slice(0, 300) }),
    ...(signalMatch === null ? {} : { signal: (signalMatch[1] ?? '').trim().slice(0, 120) }),
    ...(frames[0] === undefined ? {} : { topFrame: frames[0] }),
    frames,
    summary: firstLine.trim().slice(0, 240)
  };
}

function reportsFromJson(value: unknown): CrashReport[] {
  const reports: CrashReport[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    const stackRaw = node['stack'] ?? node['frames'] ?? node['backtrace'] ?? node['stacktrace'];
    const looksCrash =
      stackRaw !== undefined ||
      text(node['crashType']) !== undefined ||
      text(node['crash_type']) !== undefined ||
      text(node['exception']) !== undefined ||
      text(node['faultTime']) !== undefined;
    if (looksCrash && reports.length < 10) {
      const stackLines = Array.isArray(stackRaw)
        ? stackRaw.filter((line): line is string => typeof line === 'string')
        : typeof stackRaw === 'string'
          ? stackRaw.split('\n')
          : [];
      const frames = stackLines.map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 32);
      const typeText = `${text(node['crashType']) ?? text(node['crash_type']) ?? text(node['type']) ?? ''} ${
        text(node['exception']) ?? ''
      }`.toLowerCase();
      const type: CrashType = /jscrash|js crash|javascript/.test(typeText)
        ? 'jscrash'
        : /cppcrash|cpp crash|c\+\+/.test(typeText)
          ? 'cppcrash'
          : /freeze/.test(typeText)
            ? 'appfreeze'
            : 'unknown';
      reports.push({
        type,
        ...(numberOf(node['pid']) === undefined ? {} : { pid: numberOf(node['pid']) }),
        ...(text(node['process']) === undefined ? {} : { process: text(node['process']) }),
        ...(text(node['bundle']) === undefined ? {} : { bundle: text(node['bundle']) }),
        ...(text(node['faultTime']) === undefined ? {} : { faultTime: text(node['faultTime']) }),
        ...(text(node['reason']) === undefined ? {} : { reason: text(node['reason']) }),
        ...(text(node['signal']) === undefined ? {} : { signal: text(node['signal']) }),
        ...(frames[0] === undefined ? {} : { topFrame: frames[0] }),
        frames,
        summary: text(node['summary']) ?? text(node['reason']) ?? frames[0] ?? type
      });
    }
    for (const key of ['data', 'crash', 'crashes', 'records', 'items', 'result', 'events']) {
      if (node[key] !== undefined) walk(node[key]);
    }
  };
  walk(value);
  return reports;
}

/** Parse crash output (devecocli JSON or a faultlog / hilog excerpt). */
export function parseCrashLog(raw: string): CrashReport[] {
  const trimmed = raw.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length === 0 || trimmed.length > 8 * 1024 * 1024) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const fromJson = reportsFromJson(parsed);
      if (fromJson.length > 0) return fromJson;
    } catch {
      /* fall through to text parsing */
    }
  }
  const blocks = trimmed.split(/\n{2,}(?=(?:Generated by HiviewDFX|Fault thread info:|Process name:|Cpp Crash|JS Crash|AppFreeze|\d{4}-\d{2}-\d{2}))/i);
  const reports: CrashReport[] = [];
  for (const block of blocks) {
    const report = reportFromText(block);
    if (report !== null) reports.push(report);
    if (reports.length >= 10) break;
  }
  return reports;
}

const HILOG_LINE =
  /^\s*(?:(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})|(\d{4}-\d{2}-\d{2}[T ][\d:.]+))\s+(\d+)\s+(\d+)\s+([DIWEFA])\s+([^:]+):\s?(.*)$/;

function entriesFromJson(value: unknown): HilogEntry[] {
  const entries: HilogEntry[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    const message = text(node['msg']) ?? text(node['message']) ?? text(node['content']) ?? text(node['text']);
    if (message !== undefined) {
      entries.push({
        ...(text(node['time']) === undefined ? {} : { time: text(node['time']) }),
        ...(numberOf(node['pid']) === undefined ? {} : { pid: numberOf(node['pid']) }),
        ...(numberOf(node['tid']) === undefined ? {} : { tid: numberOf(node['tid']) }),
        ...(text(node['level']) === undefined ? {} : { level: text(node['level'])?.toUpperCase() }),
        ...(text(node['tag']) === undefined ? {} : { tag: text(node['tag']) }),
        message,
        raw: JSON.stringify(node)
      });
      return;
    }
    for (const key of ['data', 'logs', 'items', 'records', 'result']) {
      if (node[key] !== undefined) walk(node[key]);
    }
  };
  walk(value);
  return entries;
}

/** Normalize one message for folding (numbers/hex/ids become placeholders). */
export function foldPattern(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Parse hilog output (JSON array or plain hilog lines) into a summary. */
export function parseHilog(
  raw: string,
  options: { regex?: string; pid?: number; maxLines?: number } = {}
): HilogSummary {
  const maxLines = Math.max(1, Math.min(options.maxLines ?? 5000, 20000));
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let entries: HilogEntry[] = [];
  const trimmed = normalized.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      entries = entriesFromJson(JSON.parse(trimmed) as unknown);
    } catch {
      entries = [];
    }
  }
  if (entries.length === 0) {
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const match = HILOG_LINE.exec(line);
      if (match === null) continue;
      entries.push({
        time: match[1] ?? match[2] ?? '',
        pid: Number(match[3]),
        tid: Number(match[4]),
        level: (match[5] ?? '').toUpperCase(),
        tag: (match[6] ?? '').trim(),
        message: (match[7] ?? '').trim(),
        raw: line
      });
      if (entries.length >= maxLines) break;
    }
  }
  let regex: RegExp | undefined;
  if (options.regex !== undefined && options.regex.trim().length > 0) {
    try {
      regex = new RegExp(options.regex, 'i');
    } catch {
      regex = undefined;
    }
  }
  const selected = entries.filter((entry) => {
    if (options.pid !== undefined && entry.pid !== options.pid) return false;
    if (regex !== undefined && !regex.test(entry.message)) return false;
    return true;
  });
  const levels: Record<string, number> = {};
  const pids = new Map<number, number>();
  const tags = new Map<string, number>();
  const folded = new Map<string, { count: number; sample: string; levels: Set<string> }>();
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  for (const entry of selected) {
    const level = entry.level ?? '?';
    levels[level] = (levels[level] ?? 0) + 1;
    if (entry.pid !== undefined) pids.set(entry.pid, (pids.get(entry.pid) ?? 0) + 1);
    if (entry.tag !== undefined) tags.set(entry.tag, (tags.get(entry.tag) ?? 0) + 1);
    if (entry.time !== undefined && entry.time.length > 0) {
      if (firstTimestamp === undefined) firstTimestamp = entry.time;
      lastTimestamp = entry.time;
    }
    const pattern = foldPattern(entry.message);
    if (pattern.length === 0) continue;
    const existing = folded.get(pattern);
    if (existing === undefined) {
      folded.set(pattern, { count: 1, sample: entry.message.slice(0, 300), levels: new Set([level]) });
    } else {
      existing.count += 1;
      existing.levels.add(level);
      if (existing.sample.length === 0) existing.sample = entry.message.slice(0, 300);
    }
  }
  const foldedList: FoldedMessage[] = [...folded.entries()]
    .map(([pattern, value]) => ({
      pattern,
      count: value.count,
      sample: value.sample,
      levels: [...value.levels].sort()
    }))
    .sort((left, right) => right.count - left.count || left.pattern.localeCompare(right.pattern))
    .slice(0, 30);
  const errors = foldedList
    .filter(
      (entry) =>
        entry.levels.some((level) => level === 'E' || level === 'F') ||
        /error|exception|fail|crash|fatal|abort/i.test(entry.sample)
    )
    .slice(0, 15);
  return {
    total: entries.length,
    parsed: entries.length,
    unparsed: Math.max(0, lines.filter((line) => line.trim().length > 0).length - entries.length),
    levels,
    pids: [...pids.entries()]
      .map(([pid, count]) => ({ pid, count }))
      .sort((left, right) => right.count - left.count || left.pid - right.pid)
      .slice(0, 10),
    tags: [...tags.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
      .slice(0, 10),
    folded: foldedList,
    errors,
    ...(firstTimestamp === undefined ? {} : { firstTimestamp }),
    ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
    ...(options.regex === undefined || options.regex.trim().length === 0 ? {} : { regex: options.regex }),
    ...(options.pid === undefined ? {} : { pidFilter: options.pid }),
    ...(regex === undefined ? {} : { matched: selected.length })
  };
}
