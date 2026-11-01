/**
 * `dwguard_rules` — query the rule catalog and the local official-docs corpus.
 *
 * Sub-agents should not need to know where the corpus lives or how the catalog
 * is shaped: `list`/`get` answer "which rule covers this?", `search` greps the
 * official Markdown and returns file:line + source URL for a citation.
 *
 * @module dwguard-dsh-hmos/tools/rules
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveDocsDir, searchDocs } from '../docs.js';
import { DIMENSIONS, DIMENSION_LABELS } from '../model.js';
import { findRule, RULES } from '../rules.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { table } from '../util/md.js';
import { asRecord, optionalEnum, optionalInt, optionalString, requiredString } from './args.js';
import { pathsOf } from './common.js';
const TOOL = 'dwguard_rules';
const ACTIONS = ['list', 'get', 'search'];
const SEVERITIES = ['must', 'warn'];
/**
 * Create the `dwguard_rules` tool.
 * @param options - resolved plugin options (carries `docsDir`).
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createRulesTool(options, ctx) {
    return defineTool({
        name: 'dwguard_rules',
        description: 'Query the DwGuard rule catalog and the local official-docs corpus. ' +
            '`list` filters rules by dimension/severity/keyword; `get` resolves an ID or alias (e.g. AGC-RJ-013 → DW-AES-07) and shows its official citation; ' +
            '`search` greps the local HarmonyOS/OpenHarmony markdown corpus and returns file:line + source URL. ' +
            '写判据前用它确认规则 ID，写审计结论前用它核对官方原文。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...ACTIONS],
                description: 'list / get / search。'
            },
            ruleId: { type: 'string', description: '`get`：规则 ID 或别名（如 `DW-A11Y-02`、`AGC-RJ-013`）。' },
            query: { type: 'string', description: '`search` 的关键词；`list` 时也用于过滤 ID/标题。' },
            dimension: {
                type: 'string',
                enum: [...DIMENSIONS],
                description: '`list`：只列某个维度。'
            },
            severity: { type: 'string', enum: [...SEVERITIES], description: '`list`：只列 must 或 warn。' },
            limit: { type: 'integer', description: '返回条数上限（默认 20，最多 100）。' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const action = requiredString(args, 'action', TOOL, 20);
            if (!ACTIONS.includes(action))
                return fail(`未知 action「${action}」，可选 list / get / search。`);
            const limit = optionalInt(args, 'limit', 20, TOOL, 1, 100);
            const query = optionalString(args, 'query', TOOL, 200);
            if (action === 'get') {
                const id = requiredString(args, 'ruleId', TOOL, 60);
                const rule = findRule(id);
                if (rule === undefined) {
                    return fail(`规则目录里没有「${id}」；用 \`dwguard_rules list\` 查看可用 ID。`, {
                        next: '常见前缀：DW-FN / DW-AES / DW-PERF / DW-A11Y，别名如 STATE-NESTED-01、AGC-RJ-013。'
                    });
                }
                const lines = [
                    `# ${rule.id} · ${rule.title}`,
                    '',
                    `- 维度：${DIMENSION_LABELS[rule.dimension]}`,
                    `- 级别：${rule.severity}`,
                    `- 别名：${rule.aliases?.join('、') ?? '—'}`,
                    `- 验证：${rule.verify}`,
                    `- 来源：${rule.source}`,
                    rule.citation === undefined
                        ? '- 官方依据：（DwGuard 自定口径，无官方出处）'
                        : `- 官方依据：${rule.citation.label}\n  - ${rule.citation.url}${rule.citation.section === undefined ? '' : ` · §${rule.citation.section}`}${rule.citation.version === undefined ? '' : ` · ${rule.citation.version}`}`
                ];
                return ok(`${rule.id} · ${rule.title}`, {
                    detail: lines.join('\n'),
                    next: `在任务包判据里写 \`ruleId: '${rule.id}'\`；审计 findings 引用同一 ID。`
                });
            }
            if (action === 'list') {
                const dimension = optionalEnum(args, 'dimension', DIMENSIONS, TOOL);
                const severity = optionalEnum(args, 'severity', SEVERITIES, TOOL);
                const needle = (query ?? '').toLowerCase();
                const rows = RULES.filter((rule) => {
                    if (dimension !== undefined && rule.dimension !== dimension)
                        return false;
                    if (severity !== undefined && rule.severity !== severity)
                        return false;
                    if (needle.length > 0) {
                        const haystack = `${rule.id} ${rule.title} ${rule.source} ${(rule.aliases ?? []).join(' ')}`.toLowerCase();
                        if (!haystack.includes(needle))
                            return false;
                    }
                    return true;
                }).slice(0, limit);
                const detail = table(['ID', '维度', '级别', '标题', '出处'], rows.map((rule) => [
                    `\`${rule.id}\``,
                    DIMENSION_LABELS[rule.dimension],
                    rule.severity,
                    rule.title,
                    rule.citation === undefined ? '自定' : rule.citation.section ?? '官方'
                ]));
                return ok(`规则目录：${rows.length} 条（共 ${RULES.length} 条）`, {
                    detail,
                    next: rows.length === 0 ? '换个关键词，或用 `dwguard_rules get --ruleId <ID>`。' : '用 `dwguard_rules get` 看某条的完整定义与官方引用。'
                });
            }
            // search
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            const root = resolveDocsDir(options.docsDir, paths.workspace);
            if (root === null) {
                return fail('没有找到官方语料目录。', {
                    detail: [
                        '- 先用 `scripts/fetch-official-docs.mjs` 抓华为设计文档；',
                        '- 或 sparse clone `openharmony/docs`；',
                        '- 然后在插件配置里设 `docsDir`，或设环境变量 `DWG_DOCS_DIR`。'
                    ].join('\n'),
                    next: '配好语料目录后再试 `dwguard_rules search`。'
                });
            }
            if (query === undefined || query.trim().length === 0) {
                return fail('`search` 需要一个关键词。', { next: '例如 ` dwguard_rules search --query "点击热区"`。' });
            }
            const result = await searchDocs(root, query.trim(), limit);
            const detail = [
                `语料：\`${root}\`（${result.files} 篇 Markdown）`,
                '',
                result.hits.length === 0
                    ? `没有命中「${query}」。`
                    : table(['位置', '摘录'], result.hits.map((hit) => [`\`${hit.file}:${hit.line}\``, hit.snippet])),
                result.hits.some((hit) => hit.sourceUrl !== undefined)
                    ? `\n首个命中的来源：${result.hits.find((hit) => hit.sourceUrl !== undefined)?.sourceUrl}`
                    : ''
            ]
                .filter((line) => line.length > 0)
                .join('\n');
            return ok(`语料检索「${query}」：${result.matches} 处命中`, {
                detail,
                next: result.hits.length === 0
                    ? '换个更短的关键词（如「热区」「对比度」），或先确认语料是否包含该主题。'
                    : '把命中的官方条款写进判据的 `citation`，审计结论引用同一节号。'
            });
        },
        presentCall(args) {
            return presentCall('DwGuard · 规则与语料', 'read', args);
        }
    });
}
