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
import { applyDesignFeedback, captureDesignCard, DesignLibraryError, DESIGN_ENGINE_VERSION, DESIGN_FEEDBACK_VERDICTS, generateDesignBrief, ingestDesignLibrary, initDesignLibrary, readDesignIndex, readDesignManifest, renderDesignCardsMarkdown, renderDesignSearchMarkdown, searchDesignLibrary } from '../design.js';
import { appendOutboxDsh, parseOutbox } from '../dispatch.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { readLatestJson } from '../state.js';
import { readTextOrNull } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { arrayOfRecords, asRecord, optionalBoolean, optionalInt, optionalString, optionalStringArray, requiredEnum, requiredString } from './args.js';
import { pathsOf, requireSpec } from './common.js';
const TOOL = 'dwguard_design';
const ACTIONS = ['library', 'search', 'brief', 'feedback', 'capture', 'stats'];
const LIBRARY_OPS = ['init', 'ingest', 'list'];
const INGEST_SOURCES = ['rules', 'inbox'];
/** Next `i-<n>` id from what is already in outbox-dsh.md. */
async function nextInspirationId(paths) {
    const entries = parseOutbox(await readTextOrNull(paths.outboxDsh));
    let max = 0;
    for (const entry of entries) {
        const match = /^i-(\d+)$/.exec(entry.id ?? '');
        if (match?.[1] === undefined)
            continue;
        const value = Number.parseInt(match[1], 10);
        if (Number.isFinite(value) && value > max)
            max = value;
    }
    return `i-${max + 1}`;
}
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
        description: 'Design reference library (0.6.2): `library init` writes `.shared/design-library/` plus a dependency-free read-only `query.mjs`, `library ingest` seeds cards from the aesthetic rule catalog and `inbox/*.meta.json` (images copied into `refs/`), `library list` prints the cards, `search` runs deterministic BM25 + structured boosts, `brief` writes `tasks/design-brief.md` for DevEco and appends an `inspiration` outbox record (answer a DevEco `design-request` with `request: "q-1"`), `feedback` applies useful/off/block/unblock verdicts, `capture` turns a passing baseline into a project card (needs `confirmed: true`), `stats` summarizes coverage. ' +
            'No network, no model calls, no extra dependencies; the same input always produces the same index and ranking. 参考是证据不是判据。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...ACTIONS],
                description: 'library / search / brief / feedback / capture / stats。'
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
            topK: { type: 'number', description: 'search/brief 返回条数（search 默认 designTopK，brief 默认 designBriefCards，1–50）。' },
            request: {
                type: 'string',
                description: 'brief 的应答对象：DevEco 写下的 `design-request` id（如 `q-1`）；省略则回指最近一次 dispatch。'
            },
            entries: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        cardId: { type: 'string', required: true, description: '卡片 ID，如 `DSG-0007`。' },
                        verdict: {
                            type: 'string',
                            required: true,
                            enum: [...DESIGN_FEEDBACK_VERDICTS],
                            description: 'useful / off / block / unblock。'
                        },
                        note: { type: 'string', description: '用户原话或理由（可选）。' }
                    }
                },
                description: 'feedback：一条或多条卡片反馈。'
            },
            page: { type: 'string', description: 'capture：页面名（对应视觉基线）。' },
            state: { type: 'string', description: 'capture：状态名（默认 default）。' },
            title: { type: 'string', description: 'capture：项目卡标题（默认 `项目模式 · page/state`）。' },
            tags: { type: 'array', items: { type: 'string' }, description: 'capture：附加标签。' },
            confirmed: { type: 'boolean', description: 'capture 必须带 `confirmed: true`（用户确认过的新设计）。' },
            note: { type: 'string', description: 'capture：备注/理由（写入 rationale）。' }
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
                if (action === 'brief') {
                    const pack = await requireSpec(paths, options, TOOL);
                    const topK = optionalInt(args, 'topK', options.designBriefCards, TOOL, 1, 50);
                    const request = optionalString(args, 'request', TOOL, 40)?.replace(/^#/, '');
                    const brief = await generateDesignBrief(paths, { ...options, designBriefCards: topK }, pack, now);
                    const outboxEntries = parseOutbox(await readTextOrNull(paths.outboxDsh));
                    const latestDispatch = [...outboxEntries].reverse().find((entry) => entry.kind === 'dispatch');
                    const target = request ?? latestDispatch?.id;
                    const inspirationId = await nextInspirationId(paths);
                    await appendOutboxDsh(paths, target === undefined
                        ? `第 ${pack.iteration} 轮设计参考`
                        : `第 ${pack.iteration} 轮设计参考（应答 #${target}）`, [
                        `- 查询：\`${brief.query}\``,
                        `- 简报：\`${displayPath(paths, brief.file)}\``,
                        `- 卡片：${brief.hits.length === 0 ? '（无命中）' : brief.hits.map((hit) => `\`${hit.cardId}\` ${hit.title}`).join('、')}`,
                        '- 参考是证据不是判据；实现前先读简报，需要更多参考可在 IDE 终端运行 `.shared/design-library/query.mjs`。'
                    ].join('\n'), now, {
                        kind: 'inspiration',
                        id: inspirationId,
                        from: 'dsh',
                        to: 'deveco',
                        ...(target === undefined ? {} : { replyTo: target })
                    });
                    const cardRows = brief.hits.map((hit) => [
                        `\`${hit.cardId}\``,
                        hit.title,
                        hit.source.kind,
                        hit.source.license,
                        hit.score.toFixed(2)
                    ]);
                    return ok(`已生成设计参考简报：命中 ${brief.hits.length} 张卡，写入 \`${displayPath(paths, brief.file)}\`。`, {
                        detail: [
                            `- 查询：\`${brief.query}\``,
                            `- 简报：\`${displayPath(paths, brief.file)}\``,
                            `- 排序：${brief.result.ranker}${brief.result.notes.length === 0 ? '' : `（${brief.result.notes.join('；')}）`}`,
                            target === undefined ? '- 回执对象：无（还没有 dispatch）' : `- 回执对象：#${target}`,
                            `- outbox：\`inspiration · #${inspirationId}\``,
                            '',
                            brief.hits.length === 0
                                ? '（没有命中卡片；仍写出简报供 DevEco 参考「无参考」状态）'
                                : ['| ID | 标题 | 来源 | license | 分数 |', '| --- | --- | --- | --- | --- |', ...cardRows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
                        ].join('\n'),
                        files: [displayPath(paths, brief.file), displayPath(paths, paths.outboxDsh)],
                        next: '把 `tasks/design-brief.md` 交给 DevEco（dispatch 也会自动生成并引用）；它可以用 query.mjs 自服务，或写 `design-request` 让你补参考。'
                    });
                }
                if (action === 'feedback') {
                    const rows = arrayOfRecords(args, 'entries', TOOL, 64);
                    if (rows.length === 0)
                        return fail('`feedback` 需要 `entries`（cardId + verdict）。');
                    const entries = rows.map((row, index) => {
                        const label = `${TOOL}.entries[${index}]`;
                        const note = optionalString(row, 'note', label, 200);
                        return {
                            cardId: requiredString(row, 'cardId', label, 40),
                            verdict: requiredEnum(row, 'verdict', DESIGN_FEEDBACK_VERDICTS, label),
                            ...(note === undefined ? {} : { note })
                        };
                    });
                    const manifest = await readDesignManifest(paths);
                    if (manifest === null)
                        return fail('还没有设计库。', { next: '先运行 `library init` + `library ingest`。' });
                    const result = await applyDesignFeedback(paths, manifest, entries, now);
                    const appliedRows = result.applied.map((item) => [
                        `\`${item.cardId}\``,
                        item.verdict,
                        item.weight.toFixed(2),
                        item.status
                    ]);
                    return ok(`已记录 ${result.applied.length} 条设计反馈${result.changed ? '（已重建索引）' : ''}${result.skipped.length === 0 ? '' : `；${result.skipped.length} 条卡片不存在已跳过`}。`, {
                        detail: [
                            appliedRows.length === 0
                                ? '（没有可应用的反馈）'
                                : ['| 卡片 | 反馈 | 权重 | 状态 |', '| --- | --- | --- | --- |', ...appliedRows.map((row) => `| ${row.join(' | ')} |`)].join('\n'),
                            result.skipped.length === 0 ? '' : `\n不存在的卡片：${result.skipped.map((id) => `\`${id}\``).join('、')}`
                        ]
                            .filter((line) => line.length > 0)
                            .join('\n'),
                        files: result.files,
                        next: 'block 的卡片不会再出现在检索/简报中；权重变化会作用在下一轮排序。'
                    });
                }
                if (action === 'capture') {
                    const pack = await requireSpec(paths, options, TOOL);
                    if (!optionalBoolean(args, 'confirmed', false)) {
                        return fail('`capture` 需要用户确认（`confirmed: true`）。', {
                            detail: 'capture 会把「通过审计 + 用户确认」的设计存成项目卡，属于新的验收依据；必须先让用户看过本轮结果。',
                            next: '用户确认后带 `confirmed: true` 重试。'
                        });
                    }
                    const page = requiredString(args, 'page', TOOL, 80);
                    const state = optionalString(args, 'state', TOOL, 80) ?? 'default';
                    const audit = await readLatestJson(paths.artifactsDir, 'audit');
                    if (audit === null || audit.value.gate?.pass !== true) {
                        return fail('还没有通过的审计，不能 capture。', { next: '先跑一次通过的 `dwguard_audit`。' });
                    }
                    if (audit.value.specVersion !== pack.specVersion) {
                        return fail(`最近一次审计属于任务包 v${audit.value.specVersion ?? '?'}，与当前 v${pack.specVersion} 不一致；先审计当前版本。`);
                    }
                    const confirmation = await readLatestJson(paths.artifactsDir, 'confirmation');
                    if (confirmation === null || confirmation.value.specVersion !== pack.specVersion) {
                        return fail('缺少本轮用户确认（`artifacts/confirmation-<n>.json`），不能 capture。', {
                            next: '先用 `dwguard_confirm` 记录用户决定。'
                        });
                    }
                    const manifest = await readDesignManifest(paths);
                    if (manifest === null)
                        return fail('还没有设计库。', { next: '先运行 `library init` + `library ingest`。' });
                    const title = optionalString(args, 'title', TOOL, 120);
                    const note = optionalString(args, 'note', TOOL, 300);
                    const result = await captureDesignCard(paths, manifest, pack.specVersion, {
                        page,
                        state,
                        tags: optionalStringArray(args, 'tags', TOOL, 8),
                        ...(title === undefined ? {} : { title }),
                        ...(note === undefined ? {} : { note })
                    }, now);
                    return ok(result.changed
                        ? `已捕获项目卡 \`${result.card.id}\`（${page}/${state}），下次检索可直接命中。`
                        : `\`${result.card.id}\` 已存在（同一基线重复 capture 不会新增）。`, {
                        detail: [
                            `- 卡片：\`${result.card.id}\` · ${result.card.title}`,
                            `- tokens：配色 ${result.card.tokens.palette.length} / 间距 ${result.card.tokens.spacing.length} / 圆角 ${result.card.tokens.radius.length} / 字号 ${result.card.tokens.type.length}`,
                            `- 来源：${result.card.source.kind}（${result.card.source.ref ?? '—'}）· license ${result.card.source.license}`,
                            result.card.images.length === 0 ? '- 截图：未附' : `- 截图：\`${result.card.images[0]?.path ?? ''}\``
                        ].join('\n'),
                        files: [displayPath(paths, paths.designManifest), ...result.files],
                        next: '下一轮 `brief`/`search` 会命中这张项目卡；用户不满意可用 `feedback off/block` 调整。'
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
