/**
 * `dwguard_design` — the 0.6.2 P0 design-library tool.
 *
 * Three actions only for P0: `library init` / `library ingest` / `library list`,
 * plus `search` and `stats`. The design brief, DevEco request/answer channel and
 * `designRefs` gate are P1/P2 of the 0.6.2 plan.
 *
 * @module dwguard-dsh-hmos/tools/design
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AREA_LABELS, readProfile } from '../aesthetic.js';
import { DesignLibraryError, DESIGN_ENGINE_VERSION, ingestDesignLibrary, initDesignLibrary, readDesignIndex, readDesignManifest, renderDesignCardsMarkdown, renderDesignSearchMarkdown, searchDesignLibrary } from '../design.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalInt, optionalStringArray, requiredEnum, requiredString } from './args.js';
import { pathsOf } from './common.js';
const TOOL = 'dwguard_design';
const ACTIONS = ['library', 'search', 'stats'];
const LIBRARY_OPS = ['init', 'ingest', 'list'];
const INGEST_SOURCES = ['rules', 'inbox'];
function statsDetail(manifest) {
    const cards = manifest.cards;
    const active = cards.filter((card) => card.status === 'active');
    const licenses = new Map();
    for (const card of cards)
        licenses.set(card.source.license, (licenses.get(card.source.license) ?? 0) + 1);
    const areas = new Map();
    for (const card of active) {
        for (const [area, tokens] of Object.entries(card.tokens)) {
            if (Array.isArray(tokens) && tokens.length > 0)
                areas.set(area, (areas.get(area) ?? 0) + 1);
        }
    }
    return [
        `- 卡片：${cards.length}（active ${active.length} / blocked ${cards.length - active.length}）`,
        `- 块：${manifest.counts.chunks}`,
        `- 引擎：${manifest.engineVersion}`,
        `- 更新时间：${manifest.updatedAt}`,
        '',
        '**来源/许可**',
        '',
        ...[...licenses.entries()].sort().map(([license, count]) => `- ${license}：${count}`),
        '',
        '**覆盖领域**',
        '',
        areas.size === 0
            ? '（无结构化 tokens）'
            : [...areas.entries()]
                .sort()
                .map(([area, count]) => `- ${AREA_LABELS[area] ?? area}：${count}`)
                .join('\n')
    ].join('\n');
}
/**
 * Create the `dwguard_design` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createDesignTool(options, ctx) {
    return defineTool({
        name: TOOL,
        description: 'Design reference library (0.6.2 P0): `library init` writes `.shared/design-library/` plus a dependency-free read-only `query.mjs`, `library ingest` seeds cards from the aesthetic rule catalog and `inbox/*.meta.json` (with images copied into `refs/`), `library list` prints the cards, `search` runs deterministic BM25 + structured boosts (lexical only; `hybrid` is reserved and falls back with a note), `stats` summarizes coverage. ' +
            'No network, no model calls, no extra dependencies; the same input always produces the same index and ranking. 参考是证据不是判据。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...ACTIONS],
                description: 'library / search / stats。'
            },
            op: {
                type: 'string',
                enum: [...LIBRARY_OPS],
                description: 'library 的子操作：init / ingest / list。'
            },
            sources: {
                type: 'array',
                items: { type: 'string', enum: [...INGEST_SOURCES] },
                description: 'ingest 的来源：`rules`（审美规则目录）与/或 `inbox`（用户投递的 meta + 图片），默认两者。'
            },
            query: { type: 'string', description: 'search 的查询词，如「深色 卡片 间距」。' },
            topK: { type: 'number', description: 'search 返回条数（默认取插件配置 designTopK，1–50）。' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            await ensureShared(paths);
            const action = requiredEnum(args, 'action', ACTIONS, TOOL);
            const now = nowIso();
            try {
                if (action === 'library') {
                    const op = requiredEnum(args, 'op', LIBRARY_OPS, TOOL);
                    if (op === 'init') {
                        const result = await initDesignLibrary(paths, now);
                        return ok(result.created
                            ? `设计库已初始化：卡片 ${result.manifest.cards.length} 张，并生成只读 query.mjs。`
                            : `设计库已存在（卡片 ${result.manifest.cards.length} 张）；已刷新只读 query.mjs。`, {
                            detail: [
                                `- 目录：\`${displayPath(paths, paths.designDir)}/\``,
                                `- 引擎：${DESIGN_ENGINE_VERSION}`,
                                `- DevEco 查询：\`node ${displayPath(paths, paths.designQueryScript)} "圆角 间距" --top 5 --json\``
                            ].join('\n'),
                            files: result.files,
                            next: '运行 `dwguard_design`（action: library, op: ingest）从规则库/inbox 摄取卡片。'
                        });
                    }
                    if (op === 'ingest') {
                        const sources = args['sources'] === undefined
                            ? [...INGEST_SOURCES]
                            : optionalStringArray(args, 'sources', TOOL, INGEST_SOURCES.length);
                        const allowed = sources.filter((source) => INGEST_SOURCES.includes(source));
                        if (allowed.length === 0)
                            return fail('`sources` 至少要包含 `rules` 或 `inbox`。');
                        const result = await ingestDesignLibrary(paths, allowed, now);
                        const addedRows = result.added.map((card) => [
                            `\`${card.id}\``,
                            card.title,
                            card.source.kind,
                            card.source.license,
                            String(card.images.length)
                        ]);
                        const detail = [
                            result.changed ? `新增 ${result.added.length} 张卡片（跳过重复 ${result.skipped}）。` : `没有新增卡片（跳过重复 ${result.skipped}）。`,
                            '',
                            result.changed
                                ? ['| ID | 标题 | 来源 | license | 图 |', '| --- | --- | --- | --- | --- |', ...addedRows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
                                : '',
                            ...(result.warnings.length === 0 ? [] : ['', '**警告**', '', ...result.warnings.map((warning) => `- ${warning}`)]),
                            '',
                            `- 当前：卡片 ${result.manifest.cards.length} 张 / 块 ${result.manifest.counts.chunks}`,
                            result.manifest.counts.chunks > options.designMaxChunks
                                ? `- ⚠️ 块数超过 designMaxChunks=${options.designMaxChunks}，检索仍可运行，但建议清理或拆分库。`
                                : ''
                        ]
                            .filter((line) => line.length > 0)
                            .join('\n');
                        return ok(`设计库摄取完成：新增 ${result.added.length} 张（共 ${result.manifest.cards.length} 张）。`, {
                            detail,
                            files: result.files,
                            next: '用 `search` 验证检索，或把 `inbox/` 里的 meta 补齐后重新 ingest。'
                        });
                    }
                    const manifest = await readDesignManifest(paths);
                    if (manifest === null)
                        return fail('还没有设计库。', { next: '先运行 `library init`。' });
                    return ok(`设计库共 ${manifest.cards.length} 张卡片、${manifest.counts.chunks} 个块。`, {
                        detail: renderDesignCardsMarkdown(manifest),
                        files: [displayPath(paths, paths.designManifest)],
                        next: '`search` 验证排序；DevEco 可直接运行生成的 `query.mjs` 查同一个索引。'
                    });
                }
                if (action === 'stats') {
                    const manifest = await readDesignManifest(paths);
                    if (manifest === null)
                        return fail('还没有设计库。', { next: '先运行 `library init` + `library ingest`。' });
                    return ok(`设计库：${manifest.cards.length} 张卡片 / ${manifest.counts.chunks} 个块（${manifest.engineVersion}）。`, {
                        detail: statsDetail(manifest)
                    });
                }
                // action === 'search'
                const query = requiredString(args, 'query', TOOL, 200);
                const topK = optionalInt(args, 'topK', options.designTopK, TOOL, 1, 50);
                const manifest = await readDesignManifest(paths);
                if (manifest === null)
                    return fail('还没有设计库。', { next: '先运行 `library init` + `library ingest`。' });
                const { index, chunks } = await readDesignIndex(paths);
                const profile = await readProfile(paths);
                const profileAreas = new Set(profile.entries.filter((entry) => entry.status === 'active').map((entry) => entry.area));
                const result = searchDesignLibrary(manifest, index, chunks, query, {
                    topK,
                    ranker: options.designRanker,
                    licenseRequired: options.designLicenseRequired,
                    ...(profileAreas.size === 0 ? {} : { profileAreas })
                });
                return ok(result.results.length === 0
                    ? `没有命中「${query}」。`
                    : `「${query}」命中 ${result.results.length} 张卡（库内 ${result.totalChunks} 个块，${result.ranker} 排序）。`, {
                    detail: renderDesignSearchMarkdown(result),
                    next: 'P1 会把命中的卡片写进 `tasks/design-brief.md` 并下发给 DevEco；当前可直接把 refId 交给用户挑选。'
                });
            }
            catch (error) {
                if (error instanceof DesignLibraryError) {
                    return fail(`设计库不可用：${error.message}`, {
                        next: '修好 `.shared/design-library/` 或重新 `library init` / `ingest`；坏索引可安全重建。'
                    });
                }
                throw error;
            }
        },
        presentCall(args) {
            return presentCall('Design · 审美参考库', 'other', args);
        }
    });
}
