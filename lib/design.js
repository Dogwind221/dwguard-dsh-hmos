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
import { displayPath } from './paths.js';
import { RULES } from './rules.js';
import { copyFileTo, ensureDir, fileExists, listDir, readTextOrNull, sha256File, writeTextAtomic } from './util/fs.js';
import { inline, truncate } from './util/md.js';
/** Version stamped into the manifest/index so a future format change is visible. */
export const DESIGN_ENGINE_VERSION = '0.6.2-p0';
/** The four card sections that become retrievable chunks. */
export const DESIGN_SECTIONS = ['tokens', 'rationale', 'dos', 'donts'];
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
    const sections = [
        { section: 'tokens', text: tokensText(card.tokens) },
        { section: 'rationale', text: card.rationale ?? card.summary },
        { section: 'dos', text: card.dos.join('\n') },
        { section: 'donts', text: card.donts.join('\n') }
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
/** Next free `DSG-nnnn` id. */
export function nextDesignId(cards) {
    let max = 0;
    for (const card of cards) {
        const match = /^DSG-(\d+)$/.exec(card.id);
        if (match?.[1] === undefined)
            continue;
        const value = Number.parseInt(match[1], 10);
        if (Number.isFinite(value) && value > max)
            max = value;
    }
    return `DSG-${String(max + 1).padStart(4, '0')}`;
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
        const kind = source['kind'] === undefined ? 'user' : source['kind'];
        const license = typeof source['license'] === 'string' ? source['license'].trim() : '';
        if (title.length === 0 || license.length === 0 || (kind !== 'official' && kind !== 'user' && kind !== 'project')) {
            warnings.push(`${name}: 需要 title、source.license，且 source.kind ∈ official/user/project；已跳过`);
            continue;
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
        const id = nextDesignId([...existing, ...cards]);
        cards.push({
            id,
            title,
            summary: typeof meta.summary === 'string' ? inline(meta.summary) : '',
            tags: stringArray(meta.tags, 12),
            source: {
                kind,
                ...(typeof source['ref'] === 'string' && source['ref'].trim().length > 0 ? { ref: source['ref'].trim() } : {}),
                license
            },
            tokens: normalizeTokens(meta.tokens),
            ...(typeof meta.rationale === 'string' && inline(meta.rationale).length > 0 ? { rationale: inline(meta.rationale) } : {}),
            dos: stringArray(meta.dos, 12),
            donts: stringArray(meta.donts, 12),
            images,
            status: 'active',
            weight: 1,
            createdAt: now,
            updatedAt: now,
            ingestKey
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
        hit.score.toFixed(2),
        hit.breakdown.bm25.toFixed(2),
        hit.breakdown.tokenBoost.toFixed(2),
        hit.breakdown.profileBoost.toFixed(2),
        hit.source.license,
        hit.snippet
    ]);
    const header = ['ID', '标题', '总分', 'BM25', 'token', '档案', 'license', '片段'];
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
        card.source.kind,
        card.source.license,
        card.status,
        card.weight.toFixed(1),
        String(cardChunks(card).length)
    ]);
    return ['| ID | 标题 | 来源 | license | 状态 | 权重 | 块数 |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
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
        'function search(query, topK, licenseRequired) {',
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
        'const words = [];',
        'for (let i = 0; i < args.length; i += 1) {',
        '  if (args[i] === "--top") { top = Number(args[i + 1]); i += 1; continue; }',
        '  if (args[i] === "--json") { flags.add("json"); continue; }',
        '  if (args[i] === "--markdown") { flags.add("markdown"); continue; }',
        '  if (args[i] === "--include-unknown-license") { flags.add("all-licenses"); continue; }',
        '  words.push(args[i]);',
        '}',
        'const query = words.join(" ").trim();',
        'if (query.length === 0) { console.error("usage: node query.mjs \\"<query>\\" [--top N] [--json]"); process.exit(2); }',
        'if (!Number.isFinite(top) || top < 1) { console.error("invalid --top"); process.exit(2); }',
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
        'const results = search(query, top, licenseRequired);',
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
