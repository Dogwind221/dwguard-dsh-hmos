/**
 * Shadow review (increment ②): a read-only pass over the code and, when the
 * device tool is available, the structured UI tree — while DevEco is coding.
 *
 * Each run is recorded as `artifacts/shadow-<n>.json` and stamped into
 * `state.json`, so `dwguard_status` can nudge when the last pass is stale.
 *
 * @module dwguard-dsh-hmos/shadow
 */
import { resolve, relative, isAbsolute } from 'node:path';
import { scanWorkspace } from './scan.js';
import { displayPath } from './paths.js';
import { ensureShared } from './scaffold.js';
import { nextIndex, updateState } from './state.js';
import { fileExists, readTextOrNull, sha256File, writeTextAtomic } from './util/fs.js';
/** Stable identity of one risk across rounds. */
function riskKey(hit) {
    return `${hit.ruleId}|${hit.file}|${hit.line}`;
}
async function readPreviousReport(paths, index) {
    if (index <= 1)
        return null;
    const raw = await readTextOrNull(`${paths.artifactsDir}/shadow-${index - 1}.json`);
    if (raw === null)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function summariseTree(value, base = 0) {
    if (Array.isArray(value)) {
        let nodes = 0;
        let depth = base;
        for (const item of value) {
            const summary = summariseTree(item, base);
            nodes += summary.nodes;
            depth = Math.max(depth, summary.depth);
        }
        return { nodes, depth };
    }
    if (typeof value !== 'object' || value === null)
        return { nodes: 1, depth: base };
    let nodes = 1;
    let depth = base;
    const record = value;
    const children = record['children'] ?? record['nodes'];
    if (Array.isArray(children)) {
        for (const child of children) {
            const summary = summariseTree(child, base + 1);
            nodes += summary.nodes;
            depth = Math.max(depth, summary.depth);
        }
    }
    return { nodes, depth };
}
/**
 * Read a UI-tree dump (JSON from `harmony_ui_tree` or a text tree) and describe it.
 * @param paths - resolved protocol layout.
 * @param file - path relative to `.shared/`.
 */
export async function summariseUiTree(paths, file) {
    if (isAbsolute(file))
        throw new Error('UI 树路径必须写相对 `.shared/` 的路径。');
    const full = resolve(paths.shared, file);
    const rel = relative(paths.shared, full);
    if (rel.startsWith('..') || isAbsolute(rel))
        throw new Error('UI 树必须位于 `.shared/` 内。');
    if (!(await fileExists(full)))
        throw new Error(`UI 树文件不存在：${file}`);
    const raw = await readTextOrNull(full);
    const bytes = raw === null ? 0 : Buffer.byteLength(raw);
    const sha256 = await sha256File(full);
    let nodes;
    let depth;
    if (raw !== null && file.endsWith('.json')) {
        try {
            const parsed = JSON.parse(raw);
            const summary = summariseTree(parsed);
            nodes = summary.nodes;
            depth = summary.depth;
        }
        catch {
            /* keep it as an opaque file */
        }
    }
    return {
        file,
        sha256,
        bytes,
        ...(nodes === undefined ? {} : { nodes }),
        ...(depth === undefined ? {} : { depth })
    };
}
/**
 * Run one shadow review and persist it.
 * @param paths - resolved protocol layout.
 * @param phase - current phase (`dispatched` / `rework`).
 * @param uiTree - optional UI-tree file relative to `.shared/`.
 * @param note - optional one-liner for the record.
 * @param now - ISO timestamp.
 * @param sinceMs - only re-scan files modified at/after this epoch (incremental).
 */
export async function runShadow(paths, phase, uiTree, note, now, sinceMs) {
    await ensureShared(paths);
    const index = await nextIndex(paths.artifactsDir, 'shadow');
    const scan = await scanWorkspace(paths.workspace, true, now, { sinceMs });
    const previous = await readPreviousReport(paths, index);
    const previousRisks = new Set((previous?.hits ?? []).filter((hit) => hit.severity === 'must').map(riskKey));
    const newRisks = scan.hits.filter((hit) => hit.severity === 'must' && !previousRisks.has(riskKey(hit)));
    const visual = uiTree === undefined ? undefined : await summariseUiTree(paths, uiTree);
    const report = {
        schemaVersion: 1,
        index,
        scannedAt: now,
        phase,
        files: scan.files,
        must: scan.counts.must,
        warn: scan.counts.warn,
        hits: scan.hits,
        note,
        newRisks,
        ...(visual === undefined ? {} : { uiTree: visual })
    };
    const file = `${paths.artifactsDir}/shadow-${index}.json`;
    await writeTextAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
    await updateState(paths, now, (current) => ({
        ...current,
        shadowRuns: (current.shadowRuns ?? 0) + 1,
        lastShadowAt: now
    }));
    return { report, file };
}
/** Shorthand used in tool output. */
export function describeUiTree(summary, paths) {
    const parts = [`\`${displayPath(paths, resolve(paths.shared, summary.file))}\``, `${summary.bytes} B`, `sha256 ${summary.sha256.slice(0, 12)}…`];
    if (summary.nodes !== undefined)
        parts.push(`${summary.nodes} 个节点`, `深度 ${summary.depth ?? 0}`);
    return parts.join(' · ');
}
