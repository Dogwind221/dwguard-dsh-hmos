/**
 * The task pack: build, validate, render, parse.
 *
 * Validation is the product, not a formality — a packed spec that cannot fail
 * cannot be audited. Errors block writing; warnings are printed so the model
 * can tighten the wording before it dispatches.
 *
 * @module dwguard-dsh-hmos/spec
 */
import { findRule } from './rules.js';
import { DIMENSIONS, DIMENSION_EVIDENCE, DIMENSION_LABELS, DIMENSION_PREFIX, isDimension } from './model.js';
import { displayPath } from './paths.js';
import { bullets, inline, table } from './util/md.js';
const VAGUE_STATEMENTS = new Set([
    '好',
    '好看',
    '美观',
    '漂亮',
    '简洁',
    '流畅',
    '友好',
    '大气',
    '高级',
    '一致',
    'good',
    'nice',
    'beautiful',
    'clean',
    'smooth'
]);
const SELF_REPORT_MARKERS = ['自测通过', '自认为', '开发者确认', 'deveco 已确认', '应该没问题', '目测没问题', '编译通过', '看起来正常'];
const EVIDENCE_HINTS = [
    'hdc',
    'uitest',
    'dumpLayout',
    '截图',
    '日志',
    'hilog',
    '对比度',
    '像素',
    'vp',
    'ms',
    '帧',
    '耗时',
    '启动',
    '布局树',
    '声明的证据',
    '命令行'
];
const CRITERION_ID = /^[A-Za-z][A-Za-z0-9]*-\d{2,}$/;
function hasEvidenceHint(verify) {
    const lower = verify.toLowerCase();
    return EVIDENCE_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}
function looksSelfReported(evidence) {
    const lower = evidence.toLowerCase();
    return SELF_REPORT_MARKERS.some((marker) => lower.includes(marker));
}
function criterionIssue(input, index) {
    const issues = [];
    const label = inline(input.id).length > 0 ? inline(input.id) : `#${index + 1}`;
    const statement = inline(input.statement);
    const verify = inline(input.verify);
    if (statement.length < 8) {
        issues.push({
            code: 'E_CRITERION_STATEMENT_SHORT',
            message: `判据 \`${label}\` 的陈述过短（<8 字），无法判断是否达成。`,
            criterionId: label
        });
    }
    else if (VAGUE_STATEMENTS.has(statement.toLowerCase())) {
        issues.push({
            code: 'E_CRITERION_STATEMENT_VAGUE',
            message: `判据 \`${label}\` 只有形容词（「${statement}」），不可证伪；请写成可观察的结果。`,
            criterionId: label
        });
    }
    if (verify.length < 6) {
        issues.push({
            code: 'E_CRITERION_VERIFY_SHORT',
            message: `判据 \`${label}\` 缺少独立验证方式。`,
            criterionId: label
        });
    }
    else if (looksSelfReported(verify)) {
        issues.push({
            code: 'E_CRITERION_VERIFY_SELF_REPORT',
            message: `判据 \`${label}\` 的验证方式依赖执行者自述（「${verify}」）；验收必须由 DSH 独立取证。`,
            criterionId: label
        });
    }
    if (!CRITERION_ID.test(label)) {
        issues.push({
            code: 'E_CRITERION_ID_FORMAT',
            message: `判据 ID \`${label}\` 不符合 \`前缀-两位数字\`（如 \`F-01\`）。`,
            criterionId: label
        });
    }
    const expectedPrefix = DIMENSION_PREFIX[input.dimension];
    if (CRITERION_ID.test(label) && !label.toUpperCase().startsWith(`${expectedPrefix}-`) && !label.toUpperCase().startsWith(expectedPrefix)) {
        issues.push({
            code: 'W_CRITERION_ID_PREFIX',
            message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」维度，建议使用 \`${expectedPrefix}-\` 前缀。`,
            criterionId: label
        });
    }
    if (input.ruleId !== undefined && inline(input.ruleId).length > 0) {
        const rule = findRule(input.ruleId);
        if (rule === undefined) {
            issues.push({
                code: 'E_CRITERION_RULE_UNKNOWN',
                message: `判据 \`${label}\` 引用的规则 \`${inline(input.ruleId)}\` 不存在；可选 ID 见规则目录（DW-* / STATE-002 / AGC-RJ-* 等）。`,
                criterionId: label
            });
        }
        else if (rule.dimension !== input.dimension) {
            issues.push({
                code: 'W_CRITERION_RULE_DIMENSION',
                message: `判据 \`${label}\` 位于「${DIMENSION_LABELS[input.dimension]}」，但规则 \`${rule.id}\` 属于「${DIMENSION_LABELS[rule.dimension]}」。`,
                criterionId: label
            });
        }
    }
    return issues;
}
function criterionWarnings(input, index) {
    const warnings = [];
    const label = inline(input.id).length > 0 ? inline(input.id) : `#${index + 1}`;
    const statement = inline(input.statement);
    const verify = inline(input.verify);
    if (!/\d/.test(statement) && statement.length < 16) {
        warnings.push({
            code: 'W_CRITERION_NO_MEASURE',
            message: `判据 \`${label}\` 没有数值或可计数结果，验收时容易变成主观判断。`,
            criterionId: label
        });
    }
    if (!hasEvidenceHint(verify)) {
        warnings.push({
            code: 'W_CRITERION_NO_EVIDENCE_HINT',
            message: `判据 \`${label}\` 的验证方式没有指明证据类型（截图 / 日志 / 布局树 / 数值），审计员可能无从取证。`,
            criterionId: label
        });
    }
    if (input.ruleId === undefined || inline(input.ruleId).length === 0) {
        warnings.push({
            code: 'W_CRITERION_NO_RULE',
            message: `判据 \`${label}\` 没有引用规则 ID；审计无法把结论追到规则库（可用 \`ruleId\` 指向 \`DW-*\` / \`STATE-002\` / \`AGC-RJ-*\`）。`,
            criterionId: label
        });
    }
    return warnings;
}
/**
 * Validate a pack against the workflow's acceptance contract.
 * @param pack - the built task pack.
 * @param options - resolved plugin options (dimension minimums).
 */
export function validateTaskPack(pack, options) {
    const errors = [];
    const warnings = [];
    if (inline(pack.title).length < 2) {
        errors.push({ code: 'E_TITLE', message: '任务标题至少需要 2 个字。' });
    }
    if (inline(pack.requirement).length < 20) {
        errors.push({
            code: 'E_REQUIREMENT',
            message: '需求描述少于 20 字；先把用户原话与目标补齐，再冻结任务包。'
        });
    }
    if (inline(pack.spec).length < 20) {
        errors.push({
            code: 'E_SPEC',
            message: '实现规格少于 20 字；至少写清页面/组件结构、状态流向与关键交互。'
        });
    }
    if (pack.constraints.length === 0) {
        warnings.push({
            code: 'W_CONSTRAINTS',
            message: '没有写约束（API 版本、目录、不可改动文件、性能预算）；缺少约束会导致返工时范围失控。'
        });
    }
    if (pack.criteria.length === 0) {
        errors.push({ code: 'E_NO_CRITERIA', message: '没有任何验收标准。' });
        return { errors, warnings };
    }
    const counts = new Map();
    for (const dimension of DIMENSIONS)
        counts.set(dimension, 0);
    const seen = new Set();
    pack.criteria.forEach((criterion, index) => {
        const key = inline(criterion.id);
        if (key.length === 0) {
            errors.push({ code: 'E_CRITERION_ID_EMPTY', message: `第 ${index + 1} 条判据没有 ID。` });
        }
        else if (seen.has(key)) {
            errors.push({ code: 'E_CRITERION_ID_DUPLICATE', message: `判据 ID \`${key}\` 重复。`, criterionId: key });
        }
        else {
            seen.add(key);
        }
        counts.set(criterion.dimension, (counts.get(criterion.dimension) ?? 0) + 1);
        const input = criterion;
        for (const issue of criterionIssue(input, index)) {
            if (issue.code.startsWith('E_'))
                errors.push(issue);
            else
                warnings.push(issue);
        }
        for (const warning of criterionWarnings(input, index))
            warnings.push(warning);
    });
    for (const dimension of DIMENSIONS) {
        const count = counts.get(dimension) ?? 0;
        if (count < options.minCriteriaPerDimension) {
            errors.push({
                code: 'E_DIMENSION_EMPTY',
                message: `「${DIMENSION_LABELS[dimension]}」维度只有 ${count} 条验收标准，至少要 ${options.minCriteriaPerDimension} 条。验收必须四维齐全，缺一维就不算验收。`
            });
        }
    }
    const mustCount = pack.criteria.filter((criterion) => criterion.weight === 'must').length;
    if (mustCount === 0) {
        errors.push({ code: 'E_NO_MUST', message: '所有判据都是 should；至少要有 1 条 must 作为验收闸门。' });
    }
    if (pack.iteration < 1)
        errors.push({ code: 'E_ITERATION', message: '迭代号必须 ≥ 1。' });
    return { errors, warnings };
}
/**
 * Normalize model input into a canonical pack. Trims text, dedupes constraints,
 * assigns `must` as the default weight, and fills counters from the caller.
 * @param input - model-supplied fields.
 * @param meta - iteration, spec version and timestamps owned by the workflow.
 */
export function buildTaskPack(input, meta) {
    const criteria = input.criteria.map((criterion) => ({
        id: inline(criterion.id),
        dimension: criterion.dimension,
        statement: inline(criterion.statement),
        verify: inline(criterion.verify),
        weight: criterion.weight ?? 'must',
        ...(criterion.ruleId === undefined || inline(criterion.ruleId).length === 0
            ? {}
            : { ruleId: inline(criterion.ruleId) })
    }));
    const constraints = dedupe((input.constraints ?? []).map((item) => inline(item)).filter((item) => item.length > 0));
    return {
        schemaVersion: 1,
        ...(input.executor === undefined || input.executor === 'auto' ? {} : { executor: input.executor }),
        title: inline(input.title),
        requirement: input.requirement.trim(),
        spec: input.spec.trim(),
        constraints,
        criteria,
        iteration: meta.iteration,
        specVersion: meta.specVersion,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt
    };
}
function dedupe(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const key = item.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}
/** Parse a stored `spec.json`, returning `null` when it is absent or unreadable. */
export function parseTaskPack(raw) {
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return null;
    const record = parsed;
    if (typeof record['title'] !== 'string' || !Array.isArray(record['criteria']))
        return null;
    const criteria = [];
    for (const item of record['criteria']) {
        if (typeof item !== 'object' || item === null)
            return null;
        const entry = item;
        if (typeof entry['id'] !== 'string' || typeof entry['statement'] !== 'string' || typeof entry['verify'] !== 'string') {
            return null;
        }
        if (!isDimension(entry['dimension']))
            return null;
        const weight = entry['weight'] === 'should' ? 'should' : 'must';
        criteria.push({
            id: entry['id'],
            dimension: entry['dimension'],
            statement: entry['statement'],
            verify: entry['verify'],
            weight
        });
    }
    const strings = (key) => Array.isArray(record[key]) ? record[key].filter((v) => typeof v === 'string') : [];
    return {
        schemaVersion: 1,
        ...(record['executor'] === 'ide' || record['executor'] === 'cli' ? { executor: record['executor'] } : {}),
        title: record['title'],
        requirement: typeof record['requirement'] === 'string' ? record['requirement'] : '',
        spec: typeof record['spec'] === 'string' ? record['spec'] : '',
        constraints: strings('constraints'),
        criteria,
        iteration: typeof record['iteration'] === 'number' ? record['iteration'] : 1,
        specVersion: typeof record['specVersion'] === 'number' ? record['specVersion'] : 1,
        createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
        updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : ''
    };
}
/** Group criteria by dimension, keeping pack order. */
export function criteriaByDimension(pack) {
    const grouped = {
        function: [],
        aesthetic: [],
        performance: [],
        accessibility: []
    };
    for (const criterion of pack.criteria)
        grouped[criterion.dimension].push(criterion);
    return grouped;
}
/** Dimensions with no criterion at all. */
export function missingDimensions(pack) {
    const grouped = criteriaByDimension(pack);
    return DIMENSIONS.filter((dimension) => grouped[dimension].length === 0);
}
/** Render the human-readable `tasks/spec.md`. */
export function renderSpecMarkdown(pack, paths) {
    const grouped = criteriaByDimension(pack);
    const criteriaRows = [];
    for (const dimension of DIMENSIONS) {
        for (const criterion of grouped[dimension]) {
            criteriaRows.push([
                `\`${criterion.id}\``,
                DIMENSION_LABELS[dimension],
                criterion.weight,
                criterion.ruleId === undefined ? '—' : `\`${criterion.ruleId}\``,
                criterion.statement,
                criterion.verify
            ]);
        }
    }
    const coverage = DIMENSIONS.map((dimension) => [
        DIMENSION_LABELS[dimension],
        String(grouped[dimension].length),
        DIMENSION_EVIDENCE[dimension]
    ]);
    const must = pack.criteria.filter((criterion) => criterion.weight === 'must').length;
    const should = pack.criteria.length - must;
    return [
        `# 任务包 · ${pack.title}`,
        '',
        `> 迭代 v${pack.iteration} · 任务包 v${pack.specVersion} · 更新于 ${pack.updatedAt}`,
        `> 生成者：\`dwguard_spec\` · 共享目录：\`${displayPath(paths, paths.shared)}/\``,
        '> DevEco Code 不得修改本文件的验收标准；需要变更时向 DSH 提问。',
        '',
        '## 1. 用户需求',
        '',
        pack.requirement.trim(),
        '',
        '## 2. 实现规格',
        '',
        pack.spec.trim(),
        '',
        '## 3. 验收标准',
        '',
        `共 ${pack.criteria.length} 条（must ${must} / should ${should}）。验收由 DSH 独立取证，不采信执行者自述。`,
        '',
        table(['ID', '维度', '权重', '规则', '判据（可证伪）', '独立验证方式'], criteriaRows),
        '',
        '### 维度覆盖',
        '',
        table(['维度', '条数', '必须提供的证据'], coverage),
        '',
        '## 4. 约束',
        '',
        bullets(pack.constraints),
        '',
        '## 5. 交付与取证约定',
        '',
        '- 执行者只在 `outbox-deveco.md` 追加交付记录，不修改任务包。',
        '- 每条 must 判据都必须能被第三方用命令/截图复现；「编译通过」不是功能验收。',
        '- 需求模糊时写入 `tasks/question.md` 并暂停相关实现，不要用猜测填满验收标准。',
        ''
    ].join('\n');
}
