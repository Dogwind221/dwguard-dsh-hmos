/**
 * Visual baselines: snapshot a measured layout into `artifacts/visual-baseline/`
 * and compare a later dump against it.
 *
 * The comparison is deliberately numeric, not pixel-based: spacing/radius allow
 * ±2vp, font size has zero tolerance, colours are compared exactly. Screenshots
 * are stored for human review, never auto-verdicted.
 *
 * @module dwguard-dsh-hmos/baseline
 */
import { basename, join } from 'node:path';
import { displayPath } from './paths.js';
import { copyFileTo, ensureDir, listDir, readTextOrNull, sha256File, writeTextAtomic } from './util/fs.js';
import { table } from './util/md.js';
const METRIC_FIELDS = [
    'fontSize',
    'radius',
    'borderRadius',
    'cornerRadius',
    'padding',
    'margin',
    'backgroundColor',
    'color',
    'fontColor'
];
const EDGE_FIELDS = new Set(['padding', 'margin']);
/** Values that are compared exactly instead of with the vp tolerance. */
const EXACT_FIELDS = new Set(['fontSize', 'backgroundColor', 'color', 'fontColor']);
/** Directory holding one task-pack version's baselines. */
export function baselineDir(paths, specVersion) {
    return join(paths.visualBaselineDir, String(specVersion));
}
function indexFile(paths, specVersion) {
    return join(baselineDir(paths, specVersion), 'index.json');
}
/** Read one version's index, tolerating a missing or corrupt file. */
export async function readBaselineIndex(paths, specVersion) {
    const raw = await readTextOrNull(indexFile(paths, specVersion));
    if (raw === null)
        return { schemaVersion: 1, specVersion, entries: [] };
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return { schemaVersion: 1, specVersion, entries: [] };
        const entries = parsed['entries'];
        if (!Array.isArray(entries))
            return { schemaVersion: 1, specVersion, entries: [] };
        const valid = [];
        for (const item of entries) {
            if (typeof item !== 'object' || item === null)
                continue;
            const record = item;
            if (typeof record['page'] !== 'string' || typeof record['boundsFile'] !== 'string')
                continue;
            valid.push({
                page: record['page'],
                state: typeof record['state'] === 'string' ? record['state'] : 'default',
                boundsFile: record['boundsFile'],
                ...(typeof record['screenshotFile'] === 'string' ? { screenshotFile: record['screenshotFile'] } : {}),
                boundsSha256: typeof record['boundsSha256'] === 'string' ? record['boundsSha256'] : '',
                ...(typeof record['screenshotSha256'] === 'string' ? { screenshotSha256: record['screenshotSha256'] } : {}),
                savedAt: typeof record['savedAt'] === 'string' ? record['savedAt'] : '',
                auditId: typeof record['auditId'] === 'number' ? record['auditId'] : 0,
                confirmationId: typeof record['confirmationId'] === 'number' ? record['confirmationId'] : 0
            });
        }
        return { schemaVersion: 1, specVersion, entries: valid };
    }
    catch {
        return { schemaVersion: 1, specVersion, entries: [] };
    }
}
/** Write one version's index. */
export async function writeBaselineIndex(paths, specVersion, index) {
    await ensureDir(baselineDir(paths, specVersion));
    await writeTextAtomic(indexFile(paths, specVersion), `${JSON.stringify(index, null, 2)}\n`);
}
/** Find the saved entry for a page/state pair. */
export function findBaselineEntry(index, page, state) {
    return index.entries.find((entry) => entry.page === page && entry.state === state);
}
/** Sanitize a page/state name into a file stem. */
export function sanitizeBaselineKey(raw, fallback) {
    const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 48) : fallback;
}
/** Parse a measured number with an optional unit. */
function parseMetricNumber(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw))
        return { value: raw, unit: '' };
    if (typeof raw === 'string') {
        const match = /^(-?\d+(?:\.\d+)?)\s*(vp|dp|px|pt|%)?$/.exec(raw.trim());
        if (match !== null && match[1] !== undefined)
            return { value: Number(match[1]), unit: match[2] ?? '' };
    }
    return null;
}
function parseMetricColor(raw) {
    if (typeof raw !== 'string')
        return null;
    const match = /^#([0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)$/.exec(raw.trim());
    if (match === null || match[1] === undefined)
        return null;
    return `#${match[1].toUpperCase()}`;
}
function flattenEdges(field, raw, out) {
    const direct = parseMetricNumber(raw);
    if (direct !== null) {
        out.set(field, { kind: 'number', ...direct });
        return;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return;
    for (const edge of ['top', 'right', 'bottom', 'left']) {
        const parsed = parseMetricNumber(raw[edge]);
        if (parsed !== null)
            out.set(`${field}.${edge}`, { kind: 'number', ...parsed });
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Walk a layout-tree dump and collect the measurable fields per node.
 *
 * Nodes are keyed by their `id` when present (the stable name in a layout dump)
 * and by their path otherwise. Field names stay stable so a later dump compares
 * like for like.
 */
export function extractMetrics(root) {
    const out = new Map();
    const seen = new Map();
    const walk = (node, path) => {
        if (Array.isArray(node)) {
            node.forEach((child, index) => walk(child, `${path}/${index}`));
            return;
        }
        if (!isRecord(node))
            return;
        const id = typeof node['id'] === 'string' && node['id'].trim().length > 0 ? node['id'].trim() : undefined;
        let nodeKey = id ?? path;
        if (seen.has(nodeKey)) {
            const count = (seen.get(nodeKey) ?? 1) + 1;
            seen.set(nodeKey, count);
            nodeKey = `${nodeKey}#${count}`;
        }
        else {
            seen.set(nodeKey, 1);
        }
        const fields = new Map();
        for (const field of METRIC_FIELDS) {
            const raw = node[field];
            if (raw === undefined || raw === null)
                continue;
            if (EDGE_FIELDS.has(field)) {
                flattenEdges(field, raw, fields);
            }
            else if (field === 'backgroundColor' || field === 'color' || field === 'fontColor') {
                const color = parseMetricColor(raw);
                if (color !== null)
                    fields.set(field, { kind: 'color', value: color });
            }
            else {
                const parsed = parseMetricNumber(raw);
                if (parsed !== null)
                    fields.set(field, { kind: 'number', ...parsed });
            }
        }
        if (fields.size > 0)
            out.set(nodeKey, fields);
        if (Array.isArray(node['children']))
            walk(node['children'], `${nodeKey}/children`);
    };
    walk(root, 'root');
    return out;
}
/** Render one metric for display (missing → `—`). */
export function metricLabel(metric) {
    if (metric === undefined)
        return '—';
    return metric.kind === 'number' ? `${metric.value}${metric.unit}` : metric.value;
}
/**
 * Compare two measured trees.
 * @param baseline - metrics captured when the baseline was saved.
 * @param current - metrics from the current layout dump.
 * @param meta - identity/timestamps for the persisted result.
 */
export function compareMetrics(baseline, current, meta) {
    const toleranceVp = meta.toleranceVp ?? 2;
    const rows = [];
    const missingNodes = [];
    for (const [nodeKey, fields] of baseline) {
        const currentNode = current.get(nodeKey);
        if (currentNode === undefined) {
            missingNodes.push(nodeKey);
            for (const [field, value] of fields) {
                rows.push({
                    node: nodeKey,
                    field,
                    baseline: metricLabel(value),
                    current: '—',
                    delta: '—',
                    verdict: 'fail',
                    reason: '当前布局树里找不到该节点'
                });
            }
            continue;
        }
        for (const [field, baselineValue] of fields) {
            const currentValue = currentNode.get(field);
            const tolerance = EXACT_FIELDS.has(field) ? 0 : toleranceVp;
            if (currentValue === undefined) {
                rows.push({
                    node: nodeKey,
                    field,
                    baseline: metricLabel(baselineValue),
                    current: '—',
                    delta: '—',
                    verdict: 'fail',
                    reason: '当前布局树里缺少该字段'
                });
                continue;
            }
            if (baselineValue.kind === 'color' || currentValue.kind === 'color') {
                const same = baselineValue.kind === 'color' && currentValue.kind === 'color' && baselineValue.value === currentValue.value;
                rows.push({
                    node: nodeKey,
                    field,
                    baseline: metricLabel(baselineValue),
                    current: metricLabel(currentValue),
                    delta: same ? '0' : '—',
                    verdict: same ? 'pass' : 'fail',
                    ...(same ? {} : { reason: '颜色必须完全一致' })
                });
                continue;
            }
            const delta = currentValue.value - baselineValue.value;
            const within = Math.abs(delta) <= tolerance;
            rows.push({
                node: nodeKey,
                field,
                baseline: metricLabel(baselineValue),
                current: metricLabel(currentValue),
                delta: `${delta > 0 ? '+' : ''}${delta}${baselineValue.unit || currentValue.unit}`,
                verdict: within ? 'pass' : 'fail',
                ...(within ? {} : { reason: `超出容差 ±${tolerance}${baselineValue.unit || currentValue.unit}` })
            });
        }
    }
    let addedNodes = 0;
    for (const key of current.keys())
        if (!baseline.has(key))
            addedNodes += 1;
    rows.sort((left, right) => (left.node === right.node ? left.field.localeCompare(right.field) : left.node.localeCompare(right.node)));
    const pass = rows.every((row) => row.verdict === 'pass') && missingNodes.length === 0;
    return {
        schemaVersion: 1,
        at: meta.at,
        specVersion: meta.specVersion,
        page: meta.page,
        state: meta.state,
        toleranceVp,
        pass,
        rows,
        missingNodes,
        addedNodes,
        boundsSha256: meta.boundsSha256 ?? '',
        baselineBoundsSha256: meta.baselineBoundsSha256 ?? ''
    };
}
/** Persist the latest comparison so audit reports can render it. */
export async function writeCompareResult(paths, result) {
    await ensureDir(paths.aestheticDir);
    await writeTextAtomic(paths.aestheticCompare, `${JSON.stringify(result, null, 2)}\n`);
    return paths.aestheticCompare;
}
/** Read the latest comparison (or `null` when none exists for this pack version). */
export async function readCompareResult(paths, specVersion) {
    const raw = await readTextOrNull(paths.aestheticCompare);
    if (raw === null)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed) || parsed['specVersion'] !== specVersion)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/** Read a bounds JSON file as parsed data. */
export async function readBoundsJson(file) {
    const raw = await readTextOrNull(file);
    if (raw === null)
        return { error: `找不到布局树文件：${file}` };
    try {
        return { value: JSON.parse(raw) };
    }
    catch (error) {
        return { error: `布局树不是合法 JSON：${error.message}` };
    }
}
/** Copy a bounds/screenshot pair into the baseline directory and record hashes. */
export async function saveBaselineFiles(paths, specVersion, input) {
    const dir = baselineDir(paths, specVersion);
    await ensureDir(dir);
    const key = `${sanitizeBaselineKey(input.page, 'page')}.${sanitizeBaselineKey(input.state, 'default')}`;
    const boundsFile = `${key}.bounds.json`;
    await copyFileTo(input.boundsSource, join(dir, boundsFile));
    const boundsSha256 = await sha256File(join(dir, boundsFile));
    let screenshotFile;
    let screenshotSha256;
    if (input.screenshotSource !== undefined) {
        screenshotFile = `${key}.png`;
        await copyFileTo(input.screenshotSource, join(dir, screenshotFile));
        screenshotSha256 = await sha256File(join(dir, screenshotFile));
    }
    return {
        page: input.page,
        state: input.state,
        boundsFile,
        ...(screenshotFile === undefined ? {} : { screenshotFile }),
        boundsSha256,
        ...(screenshotSha256 === undefined ? {} : { screenshotSha256 }),
        savedAt: input.now,
        auditId: input.auditId,
        confirmationId: input.confirmationId
    };
}
/** Render the compare result as a markdown section. */
export function renderCompareMarkdown(result, headingLevel = '##') {
    const failed = result.rows.filter((row) => row.verdict === 'fail');
    const lines = [
        `${headingLevel} 审美基线差异`,
        '',
        `> ${result.page} · ${result.state} · 任务包 v${result.specVersion} · ${result.pass ? '**通过**' : '**未通过**'} · 容差 ±${result.toleranceVp}vp（字号/颜色 0 容差）`,
        ''
    ];
    if (result.rows.length === 0) {
        lines.push('（没有可比对的测量字段）');
        return lines.join('\n');
    }
    lines.push(table(['节点', '字段', '基线', '当前', '差值', '结论'], result.rows.map((row) => [
        row.node,
        row.field,
        row.baseline,
        row.current,
        row.delta,
        row.verdict === 'pass' ? '✓' : `✗ ${row.reason ?? ''}`
    ])));
    if (failed.length > 0)
        lines.push('', `未通过 ${failed.length} 项；其余节点数：缺失 ${result.missingNodes.length}，新增 ${result.addedNodes}。`);
    return lines.join('\n');
}
/** List all baseline versions present on disk. */
export async function listBaselineVersions(paths) {
    const entries = await listDir(paths.visualBaselineDir);
    const versions = [];
    for (const entry of entries) {
        const value = Number.parseInt(entry, 10);
        if (Number.isFinite(value))
            versions.push(value);
    }
    return versions.sort((left, right) => left - right);
}
/** Display path for one baseline entry's bounds file. */
export function baselineDisplayPath(paths, specVersion, entry) {
    return displayPath(paths, join(baselineDir(paths, specVersion), entry.boundsFile));
}
/** Basename of a source file, used for error messages. */
export function sourceName(file) {
    return basename(file);
}
