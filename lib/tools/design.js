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
import { join, relative, resolve, sep } from 'node:path';
import { AREA_LABELS, readProfile } from '../aesthetic.js';
import { DASHSCOPE_MULTIMODAL_ENDPOINT } from '../image.js';
import { applyDesignFeedback, captureDesignCard, defaultDesignPacksDir, DesignLibraryError, DESIGN_ENGINE_VERSION, DESIGN_FEEDBACK_VERDICTS, designCardKind, exportDesignPack, generateDesignBrief, importDesignPack, ingestDesignLibrary, initDesignLibrary, listDesignPacks, migrateDesignPack, readDesignIndex, readDesignManifest, readDesignPackRegistry, rebuildDesignPackRegistry, renderDesignCardsMarkdown, renderDesignSearchMarkdown, renderDesignImageSearchMarkdown, searchDesignByImage, searchDesignByText, searchDesignWithRanker } from '../design.js';
import { appendOutboxDsh, parseOutbox } from '../dispatch.js';
import { displayPath } from '../paths.js';
import { applyPackFeedback, captureDesignPack, evaluateRecommendBenchmark, recommendDesign } from '../recommend.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { readLatestJson, readState, updateState } from '../state.js';
import { readTextOrNull, fileExists, sha256File } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { arrayOfRecords, asRecord, optionalBoolean, optionalEnum, optionalInt, optionalString, optionalStringArray, requiredEnum, requiredString } from './args.js';
import { pathsOf, requireSpec } from './common.js';
const TOOL = 'dwguard_design';
const ACTIONS = ['library', 'search', 'brief', 'recommend', 'capture-pack', 'pack-feedback', 'benchmark', 'feedback', 'capture', 'pack', 'stats'];
const PACK_OPS = ['list', 'export', 'import', 'migrate', 'registry'];
const LIBRARY_OPS = ['init', 'ingest', 'list'];
const INGEST_SOURCES = ['rules', 'inbox'];
/** Optional CLIP/multimodal endpoint from config (0.6.5/0.6.6). */
function clipConfig(options) {
    const endpoint = options.designClipEndpoint.length > 0
        ? options.designClipEndpoint
        : options.designClipProvider === 'dashscope'
            ? DASHSCOPE_MULTIMODAL_ENDPOINT
            : '';
    if (endpoint.length === 0)
        return undefined;
    const apiKey = process.env[options.designClipApiKeyEnv];
    return {
        endpoint,
        model: options.designClipModel,
        provider: options.designClipProvider,
        ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
        timeoutMs: options.designClipTimeoutMs
    };
}
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
/** Refuse a design search once the round's retrieval budget is exhausted (0.6.3 C). */
async function searchBudgetGuard(paths, options, now) {
    const state = await readState(paths, now);
    const used = state.roundDesignSearches ?? 0;
    if (used >= options.maxDesignSearches) {
        return fail(`设计检索预算已用尽（本轮 ${used}/${options.maxDesignSearches}）。`, {
            detail: '同一轮继续检索通常不会带来新信息；先用已有简报/参考实现，或与用户确认后调整 maxDesignSearches 并开新轮。',
            next: '停线：把已有检索结果写进 `tasks/design-brief.md`，或调整配置后重新 `dwguard_spec` 开新轮。'
        });
    }
    return null;
}
/** Count one design search against the round and lifetime budgets. */
async function consumeSearchBudget(paths, now) {
    await updateState(paths, now, (current) => ({
        ...current,
        designSearches: (current.designSearches ?? 0) + 1,
        roundDesignSearches: (current.roundDesignSearches ?? 0) + 1
    }));
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
        `- 类型：pattern ${cards.filter((card) => designCardKind(card) === 'pattern').length} / anti-pattern ${cards.filter((card) => designCardKind(card) === 'anti-pattern').length} / principle ${cards.filter((card) => designCardKind(card) === 'principle').length} / brand ${cards.filter((card) => designCardKind(card) === 'brand').length}`,
        `- 块：${manifest.counts.chunks}`,
        `- 引擎：${manifest.engineVersion}`,
        `- 元数据覆盖：module ${active.filter((card) => (card.moduleTags ?? []).length > 0).length}/${active.length} · tone ${active.filter((card) => (card.tone ?? []).length > 0).length}/${active.length} · density ${active.filter((card) => card.density !== undefined).length}/${active.length} · preview ${active.filter((card) => card.preview !== undefined).length}/${active.length}`,
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
        description: 'Design reference library (0.6.2–0.7.0): `library init` writes `.shared/design-library/` plus a dependency-free read-only `query.mjs`, `library ingest` seeds cards from the aesthetic rule catalog and `inbox/*.meta.json` (images copied into `refs/`, metadata incl. moduleTags/tone/density, derived colorProfile and an HTML preview path), `library list` prints the cards, `search` runs deterministic BM25 + structured boosts, optional hybrid semantic recall (openai/dashscope embeddings), search-by-image (`image`) and multimodal text→image (`imageText`); `brief` writes `tasks/design-brief.md` with brand constraints, principle cards (direction) and pattern cards (implementation), `recommend` writes 3 diverse design options (`tasks/design-options.md` + recommendations.json), `capture-pack` freezes the user-confirmed choice — after the four-dimension audit passes and `dwguard_confirm` records the decision — into `.shared/design-packs/<name>/` (v2, inbox-compatible cards + pack evidence) and adds a paradigm card; `pack` supports registry/export/import/migrate (v1→v2), `pack-feedback` adjusts pack ranking, `benchmark` measures top-3 pack hit rate, `feedback` applies card verdicts, `capture` turns a passing baseline into a project card (needs `confirmed: true`), `stats` summarizes coverage. ' +
            'No network, no model calls, no extra dependencies; the same input always produces the same index and ranking. 参考是证据不是判据。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...ACTIONS],
                description: 'library / search / brief / recommend / capture-pack / pack-feedback / benchmark / feedback / capture / pack / stats。'
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
            query: { type: 'string', description: 'search 的查询词，如「深色 卡片 间距」；与 image 二选一。' },
            image: {
                type: 'string',
                description: 'search 的以图搜图：`.shared/` 内的 PNG 路径（0.6.4，DSH 侧 pHash + 颜色直方图，可融合 CLIP）。'
            },
            imageText: {
                type: 'string',
                description: 'search 的文本→图片：需要配置 `designClipEndpoint`（0.6.5，按 CLIP 语义找最像的卡片图片）。'
            },
            topK: { type: 'number', description: 'search/brief 返回条数（search 默认 designTopK，brief 默认 designBriefCards，1–50）。' },
            appType: { type: 'string', description: 'search 过滤：App 类型（如 `金融后台`），命中 dimensions.appType。' },
            platform: { type: 'string', description: 'search 过滤：平台（如 `harmonyos`），命中 dimensions.platform。' },
            style: { type: 'string', description: 'search 过滤：风格（命中 dimensions.style 或 stylePriority）。' },
            module: { type: 'string', description: 'search/recommend：模块标签，如 `member-center` / `dashboard`（0.6.8）。' },
            tone: { type: 'string', description: 'search/recommend：气质标签，如 `calm` / `energetic` / `luxury`（0.6.8）。' },
            density: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'search/recommend：信息密度（0.6.8）。'
            },
            brandColors: {
                type: 'array',
                items: { type: 'string' },
                description: 'recommend：品牌色（#RRGGBB，1–8 个）；用于温度匹配与“需替换为品牌色”的代价提示。'
            },
            requirement: {
                type: 'string',
                description: 'recommend：需求原文；省略时使用任务包里的 requirement。'
            },
            choice: { type: 'string', description: 'capture-pack：要冻结的候选 id（opt-1/opt-2/opt-3）。' },
            name: { type: 'string', description: 'capture-pack：设计包名（字母/数字/`-`/`_`，2–41 字符）。' },
            preview: { type: 'string', description: 'capture-pack：可选的 `.shared` 内 HTML 参考路径；省略则用卡片自带 preview。' },
            kind: {
                type: 'string',
                enum: ['pattern', 'anti-pattern', 'brand', 'principle'],
                description: 'search 过滤：默认 pattern；anti-pattern 查禁止项，brand 查品牌卡，principle 查抽象原则。'
            },
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
            confirmed: { type: 'boolean', description: 'capture / capture-pack / pack import 必须带 `confirmed: true`。' },
            packOp: {
                type: 'string',
                enum: [...PACK_OPS],
                description: 'pack 的子操作：list / export / import / migrate / registry（0.7.0）。'
            },
            packName: { type: 'string', description: 'pack 的包名（字母/数字/`-`/`_`）；list/registry 不需要。' },
            supersedes: { type: 'string', description: 'capture-pack：要取代的旧范式包名（0.7.0）。' },
            suite: {
                type: 'string',
                description: 'benchmark：相对 `.shared` 的推荐基准 JSON 路径（默认 `design-library/benchmarks/recommend.json`）。'
            },
            note: { type: 'string', description: 'capture / pack-feedback：备注/理由（写入 rationale 或反馈日志）。' },
            verdict: {
                type: 'string',
                enum: ['useful', 'off'],
                description: 'pack-feedback：包级反馈 useful / off（0.7.0）。'
            }
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
                    const budget = await searchBudgetGuard(paths, options, now);
                    if (budget !== null)
                        return budget;
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
                    await consumeSearchBudget(paths, now);
                    return ok(`已生成设计参考简报：命中 ${brief.hits.length} 张卡，写入 \`${displayPath(paths, brief.file)}\`。`, {
                        detail: [
                            `- 查询：\`${brief.query}\``,
                            `- 简报：\`${displayPath(paths, brief.file)}\``,
                            `- 品牌卡：${brief.brands.length} 张（强制注入）`,
                            `- 原则卡：${brief.principles.length} 张（方向）`,
                            ...(brief.rework === undefined
                                ? []
                                : [`- 返工定向：${brief.rework.suggestions.length} 条建议、${brief.rework.hits.length} 张补充卡片`]),
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
                if (action === 'recommend') {
                    const pack = await requireSpec(paths, options, TOOL);
                    const budget = await searchBudgetGuard(paths, options, now);
                    if (budget !== null)
                        return budget;
                    const requirement = optionalString(args, 'requirement', TOOL, 600) ?? pack.requirement;
                    const module = optionalString(args, 'module', TOOL, 40);
                    const tone = optionalString(args, 'tone', TOOL, 40);
                    const density = optionalEnum(args, 'density', ['low', 'medium', 'high'], TOOL);
                    const appType = optionalString(args, 'appType', TOOL, 40);
                    const platform = optionalString(args, 'platform', TOOL, 40);
                    const brandColors = optionalStringArray(args, 'brandColors', TOOL, 8);
                    const topK = optionalInt(args, 'topK', 3, TOOL, 1, 3);
                    const result = await recommendDesign(paths, options, pack.specVersion, {
                        requirement,
                        ...(module === undefined ? {} : { module }),
                        ...(tone === undefined ? {} : { tone }),
                        ...(density === undefined ? {} : { density }),
                        ...(appType === undefined ? {} : { appType }),
                        ...(platform === undefined ? {} : { platform }),
                        ...(brandColors === undefined ? {} : { brandColors }),
                        topK
                    }, now);
                    await consumeSearchBudget(paths, now);
                    const optionsRows = result.recommendation.options.map((option) => [
                        `\`${option.id}\``,
                        option.title,
                        option.score.toFixed(2),
                        option.patternIds.map((id) => `\`${id}\``).join(' '),
                        option.preview === undefined ? '—' : `\`${option.preview}\``
                    ]);
                    if (result.recommendation.options.length === 0) {
                        return fail('没有可推荐的 pattern 卡片。', {
                            next: '先 `library ingest` 加入带 tokens/dimensions 的卡片，再重试 recommend。'
                        });
                    }
                    return ok(`已生成 ${result.recommendation.options.length} 套设计候选，写入 \`${displayPath(paths, result.file)}\`。`, {
                        detail: [
                            `- 需求：${requirement}`,
                            module === undefined ? '' : `- 模块：\`${module}\``,
                            brandColors === undefined || brandColors.length === 0 ? '' : `- 品牌色：${brandColors.join(' / ')}`,
                            '',
                            ['| 选项 | 方向 | 评分 | 卡片 | 预览 |', '| --- | --- | --- | --- | --- |', ...optionsRows.map((row) => `| ${row.join(' | ')} |`)].join('\n'),
                            '',
                            `- 机器可读：\`${displayPath(paths, paths.designRecommendations)}\``,
                            '- 推荐不承诺唯一最佳；请让用户选一套，再带 `capture-pack choice:"opt-1" name:"..." confirmed:true` 冻结。'
                        ]
                            .filter((line) => line.length > 0)
                            .join('\n'),
                        files: [displayPath(paths, result.file), displayPath(paths, paths.designRecommendations)],
                        next: '把候选表交给用户选；选定后用 `capture-pack` 冻结为设计包，再生成 brief/spec。'
                    });
                }
                if (action === 'capture-pack') {
                    const pack = await requireSpec(paths, options, TOOL);
                    if (!optionalBoolean(args, 'confirmed', false)) {
                        return fail('`capture-pack` 需要用户确认（`confirmed: true`）。', {
                            detail: '冻结范式包会写入项目卡并影响后续 recommend；必须先让用户看过审计结果并确认。',
                            next: '用户确认后带 `confirmed: true` 重试。'
                        });
                    }
                    const audit = await readLatestJson(paths.artifactsDir, 'audit');
                    if (audit === null || audit.value.gate?.pass !== true) {
                        return fail('还没有通过的四维审计，不能冻结范式包。', {
                            next: '先跑一次通过的 `dwguard_audit`（功能/审美/性能/无障碍齐全）。'
                        });
                    }
                    if (audit.value.specVersion !== pack.specVersion) {
                        return fail(`最近一次审计属于任务包 v${audit.value.specVersion ?? '?'}，与当前 v${pack.specVersion} 不一致；先审计当前版本。`);
                    }
                    const confirmation = await readLatestJson(paths.artifactsDir, 'confirmation');
                    if (confirmation === null || confirmation.value.specVersion !== pack.specVersion) {
                        return fail('缺少本轮用户确认（`artifacts/confirmation-<n>.json`），不能冻结范式包。', {
                            next: '先用 `dwguard_confirm` 记录用户决定。'
                        });
                    }
                    const choice = requiredString(args, 'choice', TOOL, 20);
                    const name = requiredString(args, 'name', TOOL, 60);
                    const preview = optionalString(args, 'preview', TOOL, 300);
                    const supersedes = optionalString(args, 'supersedes', TOOL, 60);
                    const auditFile = audit.file.replace(/\//g, sep);
                    const confirmationFile = confirmation.file.replace(/\//g, sep);
                    const auditSha256 = await sha256File(auditFile);
                    const confirmationSha256 = await sha256File(confirmationFile);
                    const auditRelative = relative(paths.shared, auditFile).split(sep).join('/');
                    const confirmationRelative = relative(paths.shared, confirmationFile).split(sep).join('/');
                    const result = await captureDesignPack(paths, pack.specVersion, {
                        choice,
                        name,
                        ...(preview === undefined ? {} : { preview }),
                        ...(supersedes === undefined ? {} : { supersedes }),
                        evidence: {
                            auditReport: auditRelative,
                            auditSha256,
                            auditPass: true,
                            confirmation: confirmationRelative,
                            confirmationSha256,
                            userDecision: confirmation.value.decision ?? 'unknown'
                        }
                    }, now);
                    return ok(`已冻结范式包 \`${name}\`（范式卡 \`${result.cardId}\`）。`, {
                        detail: [
                            `- 目录：\`${displayPath(paths, result.dir)}/\``,
                            `- README：\`${result.readme}\``,
                            result.preview === undefined ? '- 预览：—' : `- 预览：\`${result.preview}\`（仅视觉参考，不复制代码）`,
                            `- 学习卡：\`${result.cardId}\`（下次 recommend 可命中）`,
                            `- 审计：\`${auditRelative}\`（sha256 ${auditSha256.slice(0, 12)}…）`,
                            `- 确认：\`${confirmationRelative}\`（${confirmation.value.decision ?? 'unknown'}）`,
                            '- 包内：README.md + cards/*.meta.json（inbox 兼容） + pack.json + 可选 preview/index.html'
                        ].join('\n'),
                        files: result.files,
                        next: '用 `brief`/`dispatch` 把这个范式包带进任务；新项目仍需重新跑四维审计。'
                    });
                }
                if (action === 'pack-feedback') {
                    const packName = requiredString(args, 'packName', TOOL, 60);
                    const verdict = requiredEnum(args, 'verdict', ['useful', 'off'], TOOL);
                    const note = optionalString(args, 'note', TOOL, 300);
                    try {
                        const result = await applyPackFeedback(paths, packName, verdict, note, now);
                        return ok(`已记录范式包 \`${packName}\` 的包级反馈：${verdict}（score ${result.entry.feedback?.score ?? 0}）。`, {
                            detail: [
                                `- useful：${result.entry.feedback?.useful ?? 0} / off：${result.entry.feedback?.off ?? 0}`,
                                `- 排序分：${result.entry.feedback?.score ?? 0}`,
                                result.cardId === undefined ? '- 学习卡：—' : `- 学习卡：\`${result.cardId}\`（权重已同步）`,
                                '- 反馈只调包排序/学习卡权重，不改写 pack 的审计证据。'
                            ].join('\n'),
                            files: result.files,
                            next: '再跑一次 `recommend` 观察范式包排序变化。'
                        });
                    }
                    catch (error) {
                        return fail(`包级反馈失败：${error.message}`, {
                            next: '先 `pack registry` 确认包名。'
                        });
                    }
                }
                if (action === 'benchmark') {
                    const pack = await requireSpec(paths, options, TOOL);
                    const budget = await searchBudgetGuard(paths, options, now);
                    if (budget !== null)
                        return budget;
                    const suiteArg = optionalString(args, 'suite', TOOL, 300) ?? 'design-library/benchmarks/recommend.json';
                    const resolved = resolve(paths.shared, suiteArg);
                    if (resolved !== paths.shared && !resolved.startsWith(`${paths.shared}${sep}`)) {
                        return fail('`suite` 必须是 `.shared/` 内的路径。');
                    }
                    const raw = await readTextOrNull(resolved);
                    if (raw === null)
                        return fail(`推荐基准不存在：\`${suiteArg}\`。`, {
                            next: '把基准 JSON 放到 `.shared/design-library/benchmarks/recommend.json`，或在 `benchmarks/` 里复制模板。'
                        });
                    let suite;
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
                            throw new Error('schemaVersion 必须是 1，且 queries 不能为空。');
                        }
                        suite = parsed;
                    }
                    catch (error) {
                        return fail(`基准 JSON 无效：${error.message}`);
                    }
                    const result = await evaluateRecommendBenchmark(paths, options, pack.specVersion, suite, now);
                    await consumeSearchBudget(paths, now);
                    return ok(`推荐基准：${result.hits}/${result.total} 命中 top-3（${(result.hitRate * 100).toFixed(1)}%）。`, {
                        detail: [
                            `- 报告：\`${displayPath(paths, result.file)}\``,
                            '',
                            ['| 查询 | 期望 | 命中 | 名次 | 实际候选 |', '| --- | --- | --- | --- | --- |', ...result.rows.map((row) => `| ${row.id} | ${row.expected} | ${row.hit ? '✅' : '❌'} | ${row.rank ?? '—'} | ${row.actual.map((item) => `\`${item}\``).join('、')} |`)].join('\n')
                        ].join('\n'),
                        files: [displayPath(paths, result.file)],
                        next: result.hitRate < 1 ? '看 miss 行：补范式包元数据、调 feedback，或增加基准查询。' : '基准全中；继续用真实模块做回归。'
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
                if (action === 'pack') {
                    const packOp = requiredEnum(args, 'packOp', PACK_OPS, TOOL);
                    const dir = options.designPacksDir.length > 0 ? resolve(options.designPacksDir) : defaultDesignPacksDir();
                    if (packOp === 'registry') {
                        const registry = (await readDesignPackRegistry(paths)) ?? (await rebuildDesignPackRegistry(paths, now));
                        return ok(`本地范式包注册表：${registry.packs.length} 个。`, {
                            detail: registry.packs.length === 0
                                ? `还没有本地范式包；用 \`capture-pack\` 在审计 + 用户确认后冻结。`
                                : [
                                    '| 包名 | 状态 | 模块 | 气质/密度 | 取代 | 反馈 |',
                                    '| --- | --- | --- | --- | --- | --- |',
                                    ...registry.packs.map((entry) => `| ${entry.name} | ${entry.status} | ${entry.module ?? '—'} | ${entry.tone ?? '—'} / ${entry.density ?? '—'} | ${entry.supersedes ?? '—'}${entry.supersededBy === undefined ? '' : ` → ${entry.supersededBy}`} | ${entry.feedback === undefined ? '—' : `+${entry.feedback.useful}/-${entry.feedback.off}`} |`)
                                ].join('\n'),
                            files: [displayPath(paths, paths.designPacksIndex)],
                            next: '用 `pack-feedback` 调包排序，或 `capture-pack supersedes:"..."` 取代旧包。'
                        });
                    }
                    if (packOp === 'list') {
                        const packs = await listDesignPacks(dir);
                        return ok(packs.length === 0 ? `设计包目录为空：\`${dir}\`` : `共 ${packs.length} 个设计包。`, {
                            detail: packs.length === 0
                                ? `目录：\`${dir}\`\n用 \`pack export\` 把当前库的 active 卡片（含图片）存成包。`
                                : [
                                    '| 包名 | 卡片数 | 状态 | 模块 | 创建时间 | 目录 |',
                                    '| --- | --- | --- | --- | --- | --- |',
                                    ...packs.map((pack) => `| ${pack.name} | ${pack.cards} | ${pack.status ?? '—'} | ${pack.module ?? '—'} | ${pack.createdAt || '—'} | \`${pack.path}\` |`)
                                ].join('\n'),
                            next: '本地范式包看 `pack registry`；跨项目用 `pack import`（需要 `confirmed: true`）。'
                        });
                    }
                    const packName = requiredString(args, 'packName', TOOL, 60);
                    if (packOp === 'migrate') {
                        try {
                            const migrated = await migrateDesignPack(paths.designPacksLocalDir, packName);
                            await rebuildDesignPackRegistry(paths, now);
                            return ok(`已迁移设计包 \`${packName}\` 到 schemaVersion 2（${migrated.status ?? 'draft'}）。`, {
                                detail: [
                                    `- 目录：\`${displayPath(paths, join(paths.designPacksLocalDir, packName))}\``,
                                    `- 卡片：${migrated.cards.length}（已写 inbox 兼容 cards/*.meta.json）`,
                                    `- 状态：${migrated.status ?? 'draft'}；缺审计/确认的包不会被标为 paradigm`
                                ].join('\n'),
                                files: [displayPath(paths, paths.designPacksLocalDir)],
                                next: '用 `pack registry` 查看迁移结果。'
                            });
                        }
                        catch (error) {
                            return fail(`迁移失败：${error.message}`, {
                                next: '确认包在 `.shared/design-packs/<name>/` 下，且 `pack.json` 可读。'
                            });
                        }
                    }
                    if (packOp === 'export') {
                        const manifest = await readDesignManifest(paths);
                        if (manifest === null)
                            return fail('还没有设计库。', { next: '先运行 `library init` + `library ingest`。' });
                        try {
                            const result = await exportDesignPack(paths, dir, manifest, packName, now);
                            return ok(`已导出设计包 \`${packName}\`（${result.pack.cards.length} 张卡）。`, {
                                detail: [
                                    `- 目录：\`${result.dir}\``,
                                    `- 卡片：${result.pack.cards.length}（只导出 active，图片随包复制到 \`refs/\`）`,
                                    ...(result.warnings.length === 0 ? [] : [`- 警告：${result.warnings.join('；')}`])
                                ].join('\n'),
                                files: [displayPath(paths, paths.designManifest)],
                                next: '其他项目用 `pack import`（`confirmed: true`）导入；导入会重新分配 id 并按语义去重。'
                            });
                        }
                        catch (error) {
                            return fail(`导出设计包失败：${error.message}`, {
                                next: '检查包名（字母/数字/-/_，2–41 位）和设计库是否为空。'
                            });
                        }
                    }
                    if (!optionalBoolean(args, 'confirmed', false)) {
                        return fail('`pack import` 会向当前设计库追加卡片，需要 `confirmed: true`。', {
                            next: '先 `pack list` / 查看包内容，确认后再导入。'
                        });
                    }
                    try {
                        const result = await importDesignPack(paths, dir, packName, now);
                        return ok(result.imported.length === 0
                            ? `设计包 \`${packName}\` 的卡片都已存在，跳过 ${result.skipped} 张。`
                            : `已从 \`${packName}\` 导入 ${result.imported.length} 张卡片，跳过 ${result.skipped} 张重复卡。`, {
                            detail: [
                                `- 导入：${result.imported.map((card) => `\`${card.id}\` ${card.title}`).join('；') || '（无）'}`,
                                result.skipped === 0 ? '- 去重：无重复' : `- 去重：${result.skipped} 张已存在`,
                                '- 语义：新 id、保留 kind/品牌/tokens/来源；导入后重建索引。'
                            ].join('\n'),
                            files: result.files,
                            next: '用 `library list` 确认卡片；必要时 `feedback` 调整权重。'
                        });
                    }
                    catch (error) {
                        return fail(`导入设计包失败：${error.message}`, {
                            next: '检查包名与 `pack.json`；损坏的包不会修改当前设计库。'
                        });
                    }
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
                const searchBudget = await searchBudgetGuard(paths, options, now);
                if (searchBudget !== null)
                    return searchBudget;
                const queryArg = optionalString(args, 'query', TOOL, 200);
                const imageArg = optionalString(args, 'image', TOOL, 300);
                const imageText = optionalString(args, 'imageText', TOOL, 200);
                if (queryArg === undefined && imageArg === undefined && imageText === undefined) {
                    return fail('`search` 需要 `query`、`image`（.shared 内 PNG）或 `imageText`（CLIP 文本→图）之一。');
                }
                const topK = optionalInt(args, 'topK', options.designTopK, TOOL, 1, 50);
                const manifest = await readDesignManifest(paths);
                if (manifest === null)
                    return fail('还没有设计库。', { next: '先运行 `library init` + `library ingest`。' });
                const clip = clipConfig(options);
                if (imageText !== undefined) {
                    if (clip === undefined) {
                        return fail('`imageText` 需要配置 `designClipEndpoint`（CLIP/多模态端点）。', {
                            next: '配置端点后重试；纯词法检索用 `query`，以图搜图用 `image`。'
                        });
                    }
                    let textResult;
                    try {
                        textResult = await searchDesignByText(paths, manifest, imageText, topK, {
                            licenseRequired: options.designLicenseRequired,
                            clip: { config: clip, weight: options.designClipWeight }
                        });
                    }
                    catch (error) {
                        return fail(`文本→图片检索失败：${error.message}`, {
                            next: '检查 CLIP 端点/模型；该调用不写库，失败不会影响现有卡片。'
                        });
                    }
                    await consumeSearchBudget(paths, now);
                    return ok(textResult.results.length === 0
                        ? `没有与「${imageText}」语义相近的卡片图片。`
                        : `「${imageText}」命中 ${textResult.results.length} 张卡的图片（CLIP ${options.designClipModel}）。`, {
                        detail: renderDesignImageSearchMarkdown(textResult),
                        next: 'CLIP 只比较图片语义，不替代词法检索；把最像的 refId 交给用户确认。'
                    });
                }
                if (imageArg !== undefined) {
                    const sharedRoot = paths.shared;
                    const resolved = resolve(sharedRoot, imageArg);
                    if (resolved !== sharedRoot && !resolved.startsWith(`${sharedRoot}${sep}`)) {
                        return fail('`image` 必须是 `.shared/` 内的路径。', { next: '把查询图放到 `.shared/` 下再重试。' });
                    }
                    if (!(await fileExists(resolved)))
                        return fail(`查询图不存在：\`${imageArg}\`。`);
                    let imageResult;
                    try {
                        imageResult = await searchDesignByImage(paths, manifest, resolved, topK, {
                            licenseRequired: options.designLicenseRequired,
                            ...(clip === undefined ? {} : { clip: { config: clip, weight: options.designClipWeight } })
                        });
                    }
                    catch (error) {
                        return fail(`以图搜图失败：${error.message}`, {
                            next: '换一张 8 位非隔行 PNG；损坏/不支持格式的图片不会被计费，也不会改库。'
                        });
                    }
                    await consumeSearchBudget(paths, now);
                    return ok(imageResult.results.length === 0
                        ? '以图搜图没有命中相似卡片。'
                        : `以图搜图命中 ${imageResult.results.length} 张卡（pHash ${imageResult.query.phash}）。`, {
                        detail: renderDesignImageSearchMarkdown(imageResult),
                        next: '把最相似的 refId 交给用户挑选；pHash 只做形状/明暗相似，颜色以直方图为准。'
                    });
                }
                const query = queryArg ?? '';
                const appType = optionalString(args, 'appType', TOOL, 40);
                const platform = optionalString(args, 'platform', TOOL, 40);
                const style = optionalString(args, 'style', TOOL, 40);
                const moduleFilter = optionalString(args, 'module', TOOL, 40);
                const toneFilter = optionalString(args, 'tone', TOOL, 40);
                const densityFilter = optionalEnum(args, 'density', ['low', 'medium', 'high'], TOOL);
                const kind = optionalEnum(args, 'kind', ['pattern', 'anti-pattern', 'brand', 'principle'], TOOL);
                const { index, chunks } = await readDesignIndex(paths);
                const profile = await readProfile(paths);
                const profileAreas = new Set(profile.entries.filter((entry) => entry.status === 'active').map((entry) => entry.area));
                const result = await searchDesignWithRanker(paths, options, manifest, index, chunks, query, topK, {
                    licenseRequired: options.designLicenseRequired,
                    ...(profileAreas.size === 0 ? {} : { profileAreas }),
                    filters: {
                        kind: kind ?? 'pattern',
                        ...(appType === undefined ? {} : { appType }),
                        ...(platform === undefined ? {} : { platform }),
                        ...(style === undefined ? {} : { style }),
                        ...(moduleFilter === undefined ? {} : { module: moduleFilter }),
                        ...(toneFilter === undefined ? {} : { tone: toneFilter }),
                        ...(densityFilter === undefined ? {} : { density: densityFilter })
                    }
                });
                await consumeSearchBudget(paths, now);
                return ok(result.results.length === 0
                    ? `没有命中「${query}」（kind=${kind ?? 'pattern'}）。`
                    : `「${query}」命中 ${result.results.length} 张卡（kind=${kind ?? 'pattern'}，库内 ${result.totalChunks} 个块，${result.ranker} 排序）。`, {
                    detail: renderDesignSearchMarkdown(result),
                    next: '用 `brief` 把命中结果写进 `tasks/design-brief.md` 并下发给 DevEco；或把 refId 交给用户挑选。'
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
