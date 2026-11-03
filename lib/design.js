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
import { extname, join } from 'node:path';
import { AREA_LABELS, isAestheticArea } from './aesthetic.js';
import { baselineDir, extractMetrics, findBaselineEntry, readBaselineIndex, readBoundsJson } from './baseline.js';
import { displayPath } from './paths.js';
import { RULES } from './rules.js';
import { appendText, copyFileTo, ensureDir, fileExists, listDir, readTextOrNull, removeFile, sha256File, writeTextAtomic } from './util/fs.js';
import { inline, truncate } from './util/md.js';
/** Version stamped into the manifest/index so a future format change is visible. */
export const DESIGN_ENGINE_VERSION = '0.6.3';
/** The card sections that become retrievable chunks. */
export const DESIGN_SECTIONS = ['tokens', 'rationale', 'dos', 'donts', 'style', 'antiPatterns', 'checklist', 'brand'];
/** The effective kind of a card, matching the `search` filter vocabulary. */
export function designCardKind(card) {
    if (card.source.kind === 'brand')
        return 'brand';
    return card.kind === 'anti-pattern' ? 'anti-pattern' : 'pattern';
}
const NORMALIZE_FILTER = (value) => value.trim().toLowerCase();
function matchesDesignFilters(card, filters) {
    const kind = filters.kind ?? 'pattern';
    if (designCardKind(card) !== kind)
        return false;
    if (filters.appType !== undefined) {
        const value = card.dimensions?.appType;
        if (value === undefined || NORMALIZE_FILTER(value) !== NORMALIZE_FILTER(filters.appType))
            return false;
    }
    if (filters.platform !== undefined) {
        const value = card.dimensions?.platform;
        if (value === undefined || NORMALIZE_FILTER(value) !== NORMALIZE_FILTER(filters.platform))
            return false;
    }
    if (filters.style !== undefined) {
        const wanted = NORMALIZE_FILTER(filters.style);
        const dimension = card.dimensions?.style;
        const ranked = (card.stylePriority ?? []).some((style) => NORMALIZE_FILTER(style) === wanted);
        if ((dimension === undefined || NORMALIZE_FILTER(dimension) !== wanted) && !ranked)
            return false;
    }
    return true;
}
/** Raised when the library on disk cannot be read or is inconsistent. */
export class DesignLibraryError extends Error {
}
const EMPTY_TOKENS = { palette: [], spacing: [], radius: [], type: [], motion: [] };
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
const SYNONYM_GROUPS = [
    ['间距', '留白', '边距', 'padding', 'margin', 'gap', 'spacing'],
    ['圆角', 'radius', 'corner'],
    ['字号', '字体', '行高', 'font', 'type'],
    ['配色', '颜色', '主色', '强调色', '品牌色', 'color', 'palette'],
    ['动效', '动画', '时长', '缓动', 'duration', 'easing', 'motion'],
    ['深色', '暗色', '夜间', 'dark'],
    ['图标', 'icon'],
    ['卡片', '列表行', 'card']
];
function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}
/** Collapse whitespace and lowercase for stable hashing and indexing. */
export function normalizeDesignText(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
/**
 * Tokenize English/number spans as words and CJK spans as bigrams.
 * @param text - query or chunk text.
 */
export function tokenizeDesignText(text) {
    const tokens = [];
    const matches = text.toLowerCase().matchAll(/[a-z0-9]+|[\u4e00-\u9fff]+/g);
    for (const match of matches) {
        const span = match[0];
        if (span.length === 0)
            continue;
        if (/^[a-z0-9]+$/.test(span)) {
            if (!STOP_WORDS.has(span))
                tokens.push(span);
            continue;
        }
        if (span.length === 1) {
            if (!STOP_WORDS.has(span))
                tokens.push(span);
            continue;
        }
        for (let index = 0; index < span.length - 1; index += 1) {
            const bigram = span.slice(index, index + 2);
            if (!STOP_WORDS.has(bigram))
                tokens.push(bigram);
        }
    }
    return tokens;
}
const SYNONYM_VARIANTS = (() => {
    const map = {};
    for (const group of SYNONYM_GROUPS) {
        for (const word of group)
            map[word] = group;
    }
    return map;
})();
/** Expand query tokens with the curated design-vocabulary synonyms. */
export function expandDesignQuery(tokens) {
    const expanded = new Set();
    for (const token of tokens) {
        expanded.add(token);
        const group = SYNONYM_VARIANTS[token];
        if (group === undefined)
            continue;
        for (const word of group)
            for (const part of tokenizeDesignText(word))
                expanded.add(part);
    }
    return [...expanded];
}
/** The query's numeric/colour constraints (used for the token boost). */
export function designQueryConstraints(query) {
    const numbers = [];
    for (const match of query.matchAll(/(\d+(?:\.\d+)?)\s*(vp|dp|px|pt|fp|ms|%|deg)?/g)) {
        numbers.push({ value: Number(match[1]), unit: match[2] ?? 'vp' });
    }
    const colors = [...query.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase());
    return { numbers, colors };
}
function numberTokenLabel(token) {
    return `${token.name === undefined ? '' : `${token.name} `}${token.value}${token.unit}`.trim();
}
function tokensText(tokens) {
    const lines = [];
    for (const token of tokens.palette)
        lines.push(`配色 ${token.name ?? 'color'} ${token.value}`);
    for (const token of tokens.spacing)
        lines.push(`间距 ${numberTokenLabel(token)}`);
    for (const token of tokens.radius)
        lines.push(`圆角 ${numberTokenLabel(token)}`);
    for (const token of tokens.type)
        lines.push(`字号 ${numberTokenLabel(token)}`);
    for (const token of tokens.motion)
        lines.push(`动效 ${numberTokenLabel(token)}`);
    return lines.join('\n');
}
/** Build the retrievable chunks for one card, in deterministic section order. */
export function cardChunks(card) {
    const brandText = card.brand === undefined
        ? ''
        : [
            card.brand.positioning ?? '',
            `目标用户：${card.brand.audience.join('、')}`,
            `业务约束：${card.brand.constraints.join('、')}`,
            `禁用风格：${card.brand.bannedStyles.join('、')}`
        ]
            .filter((line) => line.trim().length > 0)
            .join('\n');
    const sections = [
        { section: 'tokens', text: tokensText(card.tokens) },
        { section: 'rationale', text: [card.title, card.rationale ?? card.summary].join('\n') },
        { section: 'dos', text: card.dos.join('\n') },
        { section: 'donts', text: card.donts.join('\n') },
        { section: 'style', text: (card.stylePriority ?? []).join('\n') },
        { section: 'antiPatterns', text: (card.antiPatterns ?? []).join('\n') },
        { section: 'checklist', text: (card.checklist ?? []).join('\n') },
        { section: 'brand', text: brandText }
    ];
    const chunks = [];
    for (const { section, text } of sections) {
        const normalized = normalizeDesignText(text);
        if (normalized.length === 0)
            continue;
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
function splitChunks(text, maxLength) {
    const parts = [];
    for (let start = 0; start < text.length; start += maxLength) {
        parts.push(text.slice(start, start + maxLength));
    }
    return parts;
}
/** Flatten every card into chunks, ordered by card id then section order. */
export function buildDesignChunks(manifest) {
    const chunks = [];
    for (const card of [...manifest.cards].sort((left, right) => left.id.localeCompare(right.id))) {
        chunks.push(...cardChunks(card));
    }
    return chunks;
}
/** Build the deterministic BM25 index from chunks. */
export function buildDesignIndex(chunks, builtAt) {
    const postings = new Map();
    let totalLength = 0;
    const chunkMeta = [];
    for (const chunk of chunks) {
        const tokens = tokenizeDesignText(chunk.text);
        totalLength += tokens.length;
        chunkMeta.push({ chunkId: chunk.chunkId, cardId: chunk.cardId, section: chunk.section, len: tokens.length });
        const counts = new Map();
        for (const token of tokens)
            counts.set(token, (counts.get(token) ?? 0) + 1);
        for (const [term, tf] of counts) {
            const bucket = postings.get(term) ?? new Map();
            bucket.set(chunk.chunkId, tf);
            postings.set(term, bucket);
        }
    }
    const postingsRecord = {};
    const df = {};
    for (const term of [...postings.keys()].sort((left, right) => left.localeCompare(right))) {
        const bucket = postings.get(term);
        if (bucket === undefined)
            continue;
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
export async function readDesignManifest(paths) {
    const raw = await readTextOrNull(paths.designManifest);
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new DesignLibraryError(`manifest.json 解析失败：${error.message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed['cards'])) {
        throw new DesignLibraryError('manifest.json 结构不对：缺少 cards 数组');
    }
    return parsed;
}
/** Read index + chunks for searching; both must exist. */
export async function readDesignIndex(paths) {
    const indexRaw = await readTextOrNull(paths.designIndex);
    const chunksRaw = await readTextOrNull(paths.designChunks);
    if (indexRaw === null || chunksRaw === null) {
        throw new DesignLibraryError('设计库索引不存在；先运行 `dwguard_design` 的 `library init` + `library ingest`。');
    }
    let index;
    try {
        index = JSON.parse(indexRaw);
    }
    catch (error) {
        throw new DesignLibraryError(`index.json 解析失败：${error.message}`);
    }
    if (typeof index.totalChunks !== 'number' || typeof index.postings !== 'object' || index.postings === null) {
        throw new DesignLibraryError('index.json 结构不对');
    }
    const chunks = [];
    for (const line of chunksRaw.split('\n')) {
        if (line.trim().length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed === 'object' && parsed !== null && typeof parsed.chunkId === 'string') {
                chunks.push(parsed);
            }
        }
        catch {
            // A corrupt line is skipped; the index remains the ranking source.
        }
    }
    return { index, chunks };
}
async function writeLibrary(paths, manifest) {
    const chunks = buildDesignChunks(manifest);
    const index = buildDesignIndex(chunks, manifest.updatedAt);
    const withCounts = {
        ...manifest,
        counts: { cards: manifest.cards.length, chunks: chunks.length }
    };
    await ensureDir(paths.designDir);
    await writeTextAtomic(paths.designManifest, `${JSON.stringify(withCounts, null, 2)}\n`);
    await writeTextAtomic(paths.designChunks, `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`);
    await writeTextAtomic(paths.designIndex, `${JSON.stringify(index, null, 2)}\n`);
    return [displayPath(paths, paths.designManifest), displayPath(paths, paths.designChunks), displayPath(paths, paths.designIndex)];
}
/** Next free id in the card's namespace (`DSG-*` patterns/brands, `AP-*` anti-patterns). */
export function nextDesignId(cards, kind = 'pattern') {
    const prefix = kind === 'anti-pattern' ? 'AP' : 'DSG';
    let max = 0;
    for (const card of cards) {
        const match = new RegExp(`^${prefix}-(\\d+)$`).exec(card.id);
        if (match?.[1] === undefined)
            continue;
        const value = Number.parseInt(match[1], 10);
        if (Number.isFinite(value) && value > max)
            max = value;
    }
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
function emptyManifest(now) {
    return {
        schemaVersion: 1,
        engineVersion: DESIGN_ENGINE_VERSION,
        updatedAt: now,
        counts: { cards: 0, chunks: 0 },
        cards: []
    };
}
/** Create the library skeleton (idempotent) and the read-only query CLI. */
export async function initDesignLibrary(paths, now) {
    await ensureDir(paths.designDir);
    await ensureDir(paths.designRefsDir);
    await ensureDir(paths.designInboxDir);
    const existing = await readDesignManifest(paths);
    const manifest = existing ?? emptyManifest(now);
    const files = [];
    if (existing === null) {
        files.push(...(await writeLibrary(paths, manifest)));
    }
    await writeTextAtomic(paths.designQueryScript, renderQueryCli());
    files.push(displayPath(paths, paths.designQueryScript));
    return { manifest, created: existing === null, files };
}
/** Cards seeded from the rule catalog's aesthetic rules. */
export function ruleCards(existing, now) {
    const cards = [];
    const added = [];
    for (const rule of RULES) {
        if (rule.dimension !== 'aesthetic')
            continue;
        if (existing.some((card) => card.source.kind === 'rule' && card.source.ref === rule.id))
            continue;
        if (added.some((card) => card.source.kind === 'rule' && card.source.ref === rule.id))
            continue;
        const id = nextDesignId([...existing, ...added]);
        const card = {
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
function dimensionsFrom(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const text = (key) => {
        const value = record[key];
        return typeof value === 'string' && value.trim().length > 0 ? inline(value).slice(0, 40) : undefined;
    };
    const appType = text('appType');
    const platform = text('platform');
    const style = text('style');
    if (appType === undefined && platform === undefined && style === undefined)
        return undefined;
    return {
        ...(appType === undefined ? {} : { appType }),
        ...(platform === undefined ? {} : { platform }),
        ...(style === undefined ? {} : { style })
    };
}
function brandFrom(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const positioning = typeof record['positioning'] === 'string' && inline(record['positioning']).length > 0
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
function stringArray(raw, max) {
    if (!Array.isArray(raw))
        return [];
    return raw.filter((item) => typeof item === 'string').map((item) => inline(item)).filter((item) => item.length > 0).slice(0, max);
}
function normalizeNumberTokens(raw, fallbackUnit) {
    if (!Array.isArray(raw))
        return [];
    const tokens = [];
    for (const item of raw) {
        if (typeof item === 'number' && Number.isFinite(item)) {
            tokens.push({ value: item, unit: fallbackUnit });
            continue;
        }
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        const numeric = typeof record['value'] === 'number' ? record['value'] : Number(record['value']);
        if (!Number.isFinite(numeric))
            continue;
        const unit = typeof record['unit'] === 'string' && record['unit'].trim().length > 0 ? record['unit'].trim() : fallbackUnit;
        tokens.push({
            ...(typeof record['name'] === 'string' && record['name'].trim().length > 0 ? { name: record['name'].trim() } : {}),
            value: numeric,
            unit
        });
    }
    return tokens;
}
function normalizeColorTokens(raw) {
    if (!Array.isArray(raw))
        return [];
    const tokens = [];
    for (const item of raw) {
        if (typeof item === 'string') {
            if (/^#[0-9A-Fa-f]{6}$/.test(item.trim()))
                tokens.push({ value: item.trim().toUpperCase() });
            continue;
        }
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        if (typeof record['value'] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(record['value'].trim()))
            continue;
        tokens.push({
            ...(typeof record['name'] === 'string' && record['name'].trim().length > 0 ? { name: record['name'].trim() } : {}),
            value: record['value'].trim().toUpperCase()
        });
    }
    return tokens;
}
/** Normalize a model/user supplied token object. */
export function normalizeTokens(raw) {
    if (typeof raw !== 'object' || raw === null)
        return EMPTY_TOKENS;
    const record = raw;
    return {
        palette: normalizeColorTokens(record['palette']),
        spacing: normalizeNumberTokens(record['spacing'], 'vp'),
        radius: normalizeNumberTokens(record['radius'], 'vp'),
        type: normalizeNumberTokens(record['type'], 'fp'),
        motion: normalizeNumberTokens(record['motion'], 'ms')
    };
}
function sanitizeInboxFile(raw) {
    if (typeof raw !== 'string')
        return null;
    const name = raw.trim();
    if (name.length === 0 || /[\\/:*?"<>|]/.test(name) || name.startsWith('.'))
        return null;
    return name;
}
/** Ingest `inbox/*.meta.json` into cards, copying referenced images into refs/. */
export async function inboxCards(paths, existing, now) {
    const cards = [];
    const warnings = [];
    const files = [];
    let skipped = 0;
    const names = (await listDir(paths.designInboxDir)).filter((name) => name.endsWith('.meta.json')).sort();
    for (const name of names) {
        const raw = await readTextOrNull(join(paths.designInboxDir, name));
        if (raw === null)
            continue;
        const ingestKey = sha256Text(normalizeDesignText(raw));
        if (existing.some((card) => card.ingestKey === ingestKey) || cards.some((card) => card.ingestKey === ingestKey)) {
            skipped += 1;
            continue;
        }
        let meta;
        try {
            meta = JSON.parse(raw);
        }
        catch (error) {
            warnings.push(`${name}: JSON 解析失败（${error.message}），已跳过`);
            continue;
        }
        const title = typeof meta.title === 'string' ? inline(meta.title) : '';
        const source = typeof meta.source === 'object' && meta.source !== null ? meta.source : {};
        const sourceKind = source['kind'] === undefined ? 'user' : source['kind'];
        const license = typeof source['license'] === 'string' ? source['license'].trim() : '';
        if (title.length === 0 ||
            license.length === 0 ||
            (sourceKind !== 'official' && sourceKind !== 'user' && sourceKind !== 'project' && sourceKind !== 'brand')) {
            warnings.push(`${name}: 需要 title、source.license，且 source.kind ∈ official/user/project/brand；已跳过`);
            continue;
        }
        if (meta.kind !== undefined && meta.kind !== 'pattern' && meta.kind !== 'anti-pattern') {
            warnings.push(`${name}: kind 只能是 pattern / anti-pattern；已跳过`);
            continue;
        }
        const cardKind = meta.kind === 'anti-pattern' ? 'anti-pattern' : 'pattern';
        const rationale = typeof meta.rationale === 'string' && inline(meta.rationale).length > 0 ? inline(meta.rationale) : undefined;
        const summary = typeof meta.summary === 'string' ? inline(meta.summary) : '';
        if (cardKind === 'anti-pattern' && rationale === undefined && summary.length === 0) {
            warnings.push(`${name}: anti-pattern 卡片需要 rationale 或 summary 描述禁止项；已跳过`);
            continue;
        }
        let brand;
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
        const images = [];
        const imageName = sanitizeInboxFile(meta.image);
        if (meta.image !== undefined && imageName === null) {
            warnings.push(`${name}: image 路径非法（只允许 inbox 内的文件名），已忽略图片`);
        }
        if (imageName !== null) {
            const imagePath = join(paths.designInboxDir, imageName);
            if (!(await fileExists(imagePath))) {
                warnings.push(`${name}: 图片 ${imageName} 不存在，卡片按无图入库`);
            }
            else {
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
        const checklist = stringArray(meta.checklist, 16);
        const dimensions = dimensionsFrom(meta.dimensions);
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
            tokens: normalizeTokens(meta.tokens),
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
            ...(brand === undefined ? {} : { brand })
        });
    }
    return { cards, skipped, warnings, files };
}
/**
 * Ingest rules and/or inbox cards, then rebuild chunks + index.
 * A no-op ingest (nothing new) does not rewrite a single byte (RAG-A).
 */
export async function ingestDesignLibrary(paths, sources, now) {
    const manifest = (await readDesignManifest(paths)) ?? emptyManifest(now);
    const added = [];
    const warnings = [];
    const files = [];
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
    const next = {
        ...manifest,
        updatedAt: now,
        cards: [...manifest.cards, ...added]
    };
    files.push(...(await writeLibrary(paths, next)));
    const written = await readDesignManifest(paths);
    return { manifest: written ?? next, added, skipped, warnings, files, changed: true };
}
/** Areas a card speaks to (token keys plus tag vocabulary). */
export function cardAreas(card) {
    const areas = new Set();
    if (card.tokens.palette.length > 0)
        areas.add('palette');
    if (card.tokens.spacing.length > 0)
        areas.add('spacing');
    if (card.tokens.radius.length > 0)
        areas.add('radius');
    if (card.tokens.type.length > 0)
        areas.add('type');
    if (card.tokens.motion.length > 0)
        areas.add('motion');
    for (const tag of card.tags) {
        for (const [word, group] of Object.entries(SYNONYM_VARIANTS)) {
            if (!tag.toLowerCase().includes(word.toLowerCase()))
                continue;
            for (const variant of group) {
                const label = Object.entries(AREA_LABELS).find(([, value]) => value === variant)?.[0];
                if (label !== undefined && isAestheticArea(label))
                    areas.add(label);
            }
        }
    }
    return areas;
}
function cardById(manifest) {
    return new Map(manifest.cards.map((card) => [card.id, card]));
}
function chunkById(chunks) {
    return new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
}
/**
 * Rank cards for a query with BM25 + structured boosts.
 *
 * `hybrid` is accepted by the interface but falls back to lexical in 0.6.2 P0;
 * the result records both so a report can say which ranking actually ran.
 */
export function searchDesignLibrary(manifest, index, chunks, query, options) {
    const notes = [];
    const requestedRanker = options.ranker;
    if (requestedRanker === 'hybrid') {
        notes.push('hybrid 排序尚未实现，已回退 lexical（接口预留）');
    }
    const ranker = 'lexical';
    const queryTokens = expandDesignQuery(tokenizeDesignText(query));
    const constraints = designQueryConstraints(query);
    const cards = cardById(manifest);
    const chunkMap = chunkById(chunks);
    const chunkMeta = new Map(index.chunks.map((chunk) => [chunk.chunkId, chunk]));
    const chunkScores = new Map();
    const k1 = 1.2;
    const b = 0.75;
    const avgLen = index.avgLen === 0 ? 1 : index.avgLen;
    for (const token of new Set(queryTokens)) {
        const postings = index.postings[token];
        if (postings === undefined)
            continue;
        const df = index.df[token] ?? postings.length;
        const idf = Math.log(1 + (index.totalChunks - df + 0.5) / (df + 0.5));
        for (const [chunkId, tf] of postings) {
            const length = chunkMeta.get(chunkId)?.len ?? 0;
            const denominator = tf + k1 * (1 - b + (b * length) / avgLen);
            const contribution = idf * ((tf * (k1 + 1)) / (denominator === 0 ? 1 : denominator));
            chunkScores.set(chunkId, (chunkScores.get(chunkId) ?? 0) + contribution);
        }
    }
    const byCard = new Map();
    for (const [chunkId, score] of chunkScores) {
        const chunk = chunkMap.get(chunkId);
        if (chunk === undefined)
            continue;
        const current = byCard.get(chunk.cardId);
        if (current === undefined || score > current.score)
            byCard.set(chunk.cardId, { score, chunkId });
    }
    const results = [];
    for (const card of cards.values()) {
        if (card.status !== 'active')
            continue;
        if (options.licenseRequired && card.source.license.toLowerCase() === 'unknown')
            continue;
        if (!matchesDesignFilters(card, options.filters ?? { kind: 'pattern' }))
            continue;
        const best = byCard.get(card.id);
        const bm25 = best?.score ?? 0;
        if (bm25 === 0 && queryTokens.length > 0)
            continue;
        let tokenBoost = 0;
        for (const color of constraints.colors) {
            if (card.tokens.palette.some((token) => token.value.toUpperCase() === color))
                tokenBoost += 0.5;
        }
        for (const number of constraints.numbers) {
            const all = [...card.tokens.spacing, ...card.tokens.radius, ...card.tokens.type, ...card.tokens.motion];
            if (all.some((token) => token.value === number.value && token.unit === number.unit))
                tokenBoost += 0.5;
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
export function renderDesignSearchMarkdown(result) {
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
    if (result.notes.length > 0)
        lines.push('', ...result.notes.map((note) => `> ${note}`));
    return lines.join('\n');
}
/** Render the full card table for `library list`. */
export function renderDesignCardsMarkdown(manifest) {
    if (manifest.cards.length === 0)
        return '（设计库为空；先 `library ingest`）';
    const rows = [...manifest.cards]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((card) => [
        `\`${card.id}\``,
        card.title,
        designCardKind(card),
        card.source.kind,
        card.source.license,
        card.status,
        card.weight.toFixed(1),
        String(cardChunks(card).length)
    ]);
    return ['| ID | 标题 | kind | 来源 | license | 状态 | 权重 | 块数 |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}
/** One-line token summary used by spec/audit reports (0.6.2 P2). */
export function designCardTokenSummary(card) {
    return tokensText(card.tokens).split('\n').join('；');
}
/** Persist the rework suggestions for the next brief. */
export async function writeDesignReworkQueue(paths, queue) {
    await ensureDir(paths.designDir);
    await writeTextAtomic(paths.designReworkQueue, `${JSON.stringify(queue, null, 2)}\n`);
    return paths.designReworkQueue;
}
/** Read rework suggestions, scoped to the current pack version. */
export async function readDesignReworkQueue(paths, specVersion) {
    const raw = await readTextOrNull(paths.designReworkQueue);
    if (raw === null)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const record = parsed;
        if (record['specVersion'] !== specVersion || !Array.isArray(record['suggestions']))
            return null;
        const suggestions = [];
        for (const item of record['suggestions']) {
            if (typeof item !== 'object' || item === null)
                continue;
            const entry = item;
            if (typeof entry['criterionId'] !== 'string' || typeof entry['query'] !== 'string')
                continue;
            suggestions.push({
                criterionId: entry['criterionId'],
                query: entry['query'],
                refs: Array.isArray(entry['refs'])
                    ? entry['refs'].filter((ref) => typeof ref === 'string')
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
    }
    catch {
        return null;
    }
}
/** Drop rework suggestions once the round passes or a new pack starts. */
export async function clearDesignReworkQueue(paths) {
    await removeFile(paths.designReworkQueue);
}
function buildBriefQuery(pack) {
    const aesthetic = pack.criteria
        .filter((criterion) => criterion.dimension === 'aesthetic')
        .map((criterion) => `${criterion.statement} ${criterion.verify}`)
        .join(' ');
    return truncate(normalizeDesignText(`${pack.title} ${pack.requirement} ${aesthetic}`), 400);
}
function renderCardDetail(card) {
    const lines = [`### \`${card.id}\` · ${card.title}`, ''];
    lines.push(`- 来源：${card.source.kind}${card.source.ref === undefined ? '' : `（${card.source.ref}）`} · license ${card.source.license}`);
    const tokens = tokensText(card.tokens);
    if (tokens.length > 0)
        lines.push(`- tokens：${tokens.split('\n').join('；')}`);
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
        if (dims.length > 0)
            lines.push(`- 维度：${dims.join(' · ')}`);
    }
    if (card.rationale !== undefined)
        lines.push(`- 理由：${truncate(card.rationale, 240)}`);
    if (card.dos.length > 0)
        lines.push(`- Do：${card.dos.join('；')}`);
    if (card.donts.length > 0)
        lines.push(`- Don't：${card.donts.join('；')}`);
    if (card.images.length > 0) {
        lines.push(`- 图片：${card.images.map((image) => `\`${image.path}\``).join('、')}`);
    }
    lines.push('');
    return lines;
}
function renderBrandSection(brands) {
    if (brands.length === 0)
        return [];
    const lines = [
        '## 0. 品牌与业务约束（强制注入）',
        '',
        '> 以下约束优先于审美参考：参考可以取舍，品牌定位/业务约束不可违反。',
        ''
    ];
    for (const brand of brands) {
        lines.push(`### \`${brand.id}\` · ${brand.title}`, '');
        if (brand.brand?.positioning !== undefined)
            lines.push(`- 定位：${brand.brand.positioning}`);
        if ((brand.brand?.audience.length ?? 0) > 0)
            lines.push(`- 目标用户：${brand.brand?.audience.join('、') ?? ''}`);
        if ((brand.brand?.constraints.length ?? 0) > 0)
            lines.push(`- 业务约束：${brand.brand?.constraints.join('、') ?? ''}`);
        if ((brand.brand?.bannedStyles.length ?? 0) > 0)
            lines.push(`- 禁用风格：${brand.brand?.bannedStyles.join('、') ?? ''}`);
        if (brand.brand?.positioning === undefined && (brand.brand?.audience.length ?? 0) === 0 && (brand.brand?.constraints.length ?? 0) === 0) {
            lines.push(`- 参考：${brand.summary}`);
        }
        lines.push('');
    }
    return lines;
}
/** Render `tasks/design-brief.md`. */
export function renderDesignBriefMarkdown(pack, result, cards, brands, now, rework) {
    const lines = [
        `# 设计参考简报 · ${pack.title}`,
        '',
        `> 任务包 v${pack.specVersion} · ${now} · 查询：\`${result.query}\` · 排序 ${result.ranker} · 命中 ${result.results.length} 张`,
        '> **参考是证据不是判据**：DSH 仍然独立取证；参考卡片不能替代设备上的验收证据。',
        '',
        ...renderBrandSection(brands)
    ];
    if (result.notes.length > 0)
        lines.push(...result.notes.map((note) => `> ${note}`), '');
    const reworkLines = rework === undefined || rework.suggestions.length === 0
        ? []
        : [
            '## 0.5 上一轮返工定向参考',
            '',
            '> 这些检索词来自上一轮未通过的审美判据；实现时优先对照。',
            '',
            ...rework.suggestions.map((suggestion) => `- \`${suggestion.criterionId}\`：建议检索 \`${suggestion.query}\`${suggestion.refs.length === 0 ? '' : `；已有参考 ${suggestion.refs.map((ref) => `\`${ref}\``).join('、')}`}`),
            '',
            ...(rework.cards.length === 0
                ? []
                : [
                    '| ID | 标题 | 来源 | license |',
                    '| --- | --- | --- | --- |',
                    ...rework.cards.map((card) => `| \`${card.id}\` | ${card.title} | ${card.source.kind} | ${card.source.license} |`),
                    ''
                ])
        ];
    lines.push(...reworkLines);
    if (result.results.length === 0) {
        lines.push('本轮没有命中的参考卡片：按任务包与审美档案实现，不要自行发明风格。', '');
        return lines.join('\n');
    }
    lines.push('## 1. 参考卡片', '', '| ID | 标题 | 来源 | license | 命中分 |', '| --- | --- | --- | --- | --- |', ...result.results.map((hit) => `| \`${hit.cardId}\` | ${hit.title} | ${hit.source.kind} | ${hit.source.license} | ${hit.score.toFixed(2)} |`), '', '## 2. 卡片详情', '');
    for (const hit of result.results) {
        const card = cards.find((item) => item.id === hit.cardId);
        if (card !== undefined)
            lines.push(...renderCardDetail(card));
    }
    lines.push('## 3. 怎么用', '', '- 实现前先读上面的 tokens 与 Do/Don\'t；需要更多参考就在 IDE 终端运行 `node .shared/design-library/query.mjs "<关键词>" --top 5 --json`。', '- 编码中需要 DSH 再找参考：往 `outbox-deveco.md` 追加 `design-request · #q-N · from=deveco to=dsh · re=#d-N` 记录，等 DSH 回 `inspiration`。', '- 最终判定以 DSH 的设备证据为准；参考不一致时先问用户，不要自行改验收标准。', '');
    return lines.join('\n');
}
/**
 * Generate the design brief for the current pack and write it to disk.
 * Throws {@link DesignLibraryError} when the library is missing.
 */
export async function generateDesignBrief(paths, options, pack, now) {
    const manifest = await readDesignManifest(paths);
    if (manifest === null) {
        throw new DesignLibraryError('设计库尚未初始化；先运行 `dwguard_design` 的 `library init` + `library ingest`。');
    }
    const { index, chunks } = await readDesignIndex(paths);
    const query = buildBriefQuery(pack);
    const result = searchDesignLibrary(manifest, index, chunks, query, {
        topK: options.designBriefCards,
        ranker: options.designRanker,
        licenseRequired: options.designLicenseRequired,
        filters: { kind: 'pattern' }
    });
    const cards = result.results
        .map((hit) => manifest.cards.find((card) => card.id === hit.cardId))
        .filter((card) => card !== undefined);
    const brands = manifest.cards
        .filter((card) => card.source.kind === 'brand' && card.status === 'active')
        .slice(0, options.designBrandCards);
    const queue = await readDesignReworkQueue(paths, pack.specVersion);
    let rework;
    if (queue !== null && queue.suggestions.length > 0) {
        const seen = new Set(result.results.map((hit) => hit.cardId));
        const extraHits = [];
        for (const suggestion of queue.suggestions.slice(0, 3)) {
            const extra = searchDesignLibrary(manifest, index, chunks, suggestion.query, {
                topK: 2,
                ranker: options.designRanker,
                licenseRequired: options.designLicenseRequired,
                filters: { kind: 'pattern' }
            });
            for (const hit of extra.results) {
                if (seen.has(hit.cardId))
                    continue;
                seen.add(hit.cardId);
                extraHits.push(hit);
                if (extraHits.length >= 4)
                    break;
            }
            if (extraHits.length >= 4)
                break;
        }
        const reworkCards = extraHits
            .map((hit) => manifest.cards.find((card) => card.id === hit.cardId))
            .filter((card) => card !== undefined);
        rework = { suggestions: queue.suggestions, hits: extraHits, cards: reworkCards };
    }
    await writeTextAtomic(paths.designBriefMd, renderDesignBriefMarkdown(pack, result, cards, brands, now, rework));
    return {
        file: paths.designBriefMd,
        query,
        hits: result.results,
        brands,
        result,
        ...(rework === undefined ? {} : { rework })
    };
}
/** Feedback verdicts a card can receive (0.6.2 P3). */
export const DESIGN_FEEDBACK_VERDICTS = ['useful', 'off', 'block', 'unblock'];
function clampWeight(weight) {
    return Math.min(1.5, Math.max(0.5, Number(weight.toFixed(2))));
}
/**
 * Apply `useful / off / block / unblock` feedback.
 *
 * Weight moves inside 0.5–1.5 (useful ×1.1, off ×0.8); block hides the card from
 * search but keeps it in the manifest, and every verdict is appended to
 * `feedback.jsonl` (never deleted).
 */
export async function applyDesignFeedback(paths, manifest, entries, now) {
    const applied = [];
    const skipped = [];
    const events = [];
    let changed = false;
    let cards = [...manifest.cards];
    for (const entry of entries) {
        const index = cards.findIndex((card) => card.id === entry.cardId);
        if (index < 0) {
            skipped.push(entry.cardId);
            continue;
        }
        const card = cards[index];
        if (card === undefined)
            continue;
        let weight = card.weight;
        let status = card.status;
        if (entry.verdict === 'useful') {
            weight = clampWeight(weight * 1.1);
            status = 'active';
        }
        else if (entry.verdict === 'off') {
            weight = clampWeight(weight * 0.8);
        }
        else if (entry.verdict === 'block') {
            status = 'blocked';
        }
        else {
            status = 'active';
        }
        const next = { ...card, weight, status, updatedAt: now };
        cards = cards.map((item, itemIndex) => (itemIndex === index ? next : item));
        changed = changed || weight !== card.weight || status !== card.status;
        applied.push({ cardId: card.id, verdict: entry.verdict, weight, status });
        events.push(JSON.stringify({
            at: now,
            cardId: card.id,
            verdict: entry.verdict,
            weight,
            status,
            ...(entry.note === undefined ? {} : { note: entry.note })
        }));
    }
    let nextManifest = { ...manifest, cards, updatedAt: changed ? now : manifest.updatedAt };
    const files = [];
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
const TOKEN_CAPS = 12;
function tokensFromMetrics(metrics) {
    const palette = [];
    const spacing = [];
    const radius = [];
    const type = [];
    const seen = new Set();
    const pushNumber = (target, area, name, value, unit) => {
        if (target.length >= TOKEN_CAPS)
            return;
        const key = `${area}:${name}:${value}${unit}`;
        if (seen.has(key))
            return;
        seen.add(key);
        target.push({ name, value, unit });
    };
    for (const [node, fields] of metrics) {
        for (const [field, value] of fields) {
            if (value.kind === 'color') {
                if (palette.length >= TOKEN_CAPS)
                    continue;
                const key = `palette:${value.value}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                palette.push({ name: `${node}.${field}`, value: value.value });
                continue;
            }
            if (field === 'fontSize') {
                pushNumber(type, 'type', node, value.value, value.unit.length > 0 ? value.unit : 'fp');
            }
            else if (field === 'radius' || field === 'borderRadius' || field === 'cornerRadius') {
                pushNumber(radius, 'radius', node, value.value, value.unit.length > 0 ? value.unit : 'vp');
            }
            else if (field.startsWith('padding') || field.startsWith('margin')) {
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
export async function captureDesignCard(paths, manifest, specVersion, input, now) {
    const index = await readBaselineIndex(paths, specVersion);
    const entry = findBaselineEntry(index, input.page, input.state);
    if (entry === undefined) {
        throw new DesignLibraryError(`任务包 v${specVersion} 里没有 ${input.page}/${input.state} 的视觉基线；先通过审计 + 用户确认后 baseline save。`);
    }
    const ingestKey = sha256Text(`capture|${specVersion}|${entry.page}|${entry.state}|${entry.boundsSha256}`);
    const existing = manifest.cards.find((card) => card.source.kind === 'project' && card.ingestKey === ingestKey);
    if (existing !== undefined) {
        return { manifest, card: existing, changed: false, files: [] };
    }
    const boundsRead = await readBoundsJson(join(baselineDir(paths, specVersion), entry.boundsFile));
    if ('error' in boundsRead)
        throw new DesignLibraryError(`基线布局树不可读：${boundsRead.error}`);
    const tokens = tokensFromMetrics(extractMetrics(boundsRead.value));
    const images = [];
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
    const card = {
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
        ingestKey
    };
    const nextManifest = { ...manifest, updatedAt: now, cards: [...manifest.cards, card] };
    const files = await writeLibrary(paths, nextManifest);
    const written = (await readDesignManifest(paths)) ?? nextManifest;
    return { manifest: written, card, changed: true, files };
}
/** Generate the dependency-free read-only query CLI (same ranking as the tool). */
export function renderQueryCli() {
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
        "    const cardKind = card.source.kind === 'brand' ? 'brand' : (card.kind === 'anti-pattern' ? 'anti-pattern' : 'pattern');",
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
        'if (kind !== "pattern" && kind !== "anti-pattern" && kind !== "brand") { console.error("invalid --kind"); process.exit(2); }',
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
