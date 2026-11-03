/**
 * `dwguard_aesthetic` — the 0.6.1 aesthetic learning tool.
 *
 * Four actions, one gate: `learn` proposes, the user chooses, `apply` writes.
 * `baseline` only saves after a passing audit and a user confirmation; `compare`
 * turns a layout dump into numeric diffs, never pixel guesses.
 *
 * @module dwguard-dsh-hmos/tools/aesthetic
 */
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AESTHETIC_AREAS, AESTHETIC_SOURCE_KINDS, AREA_LABELS, appendAestheticHistory, applyAestheticProposals, factsFromSources, findProfileEntry, learnAesthetics, nextAestheticId, normalizeValue, readProfile, readProjectAestheticFacts, renderConflicts, renderProposals, valueLabel, writeProfile } from '../aesthetic.js';
import { isAestheticId } from '../aesthetic.js';
import { baselineDir, baselineDisplayPath, compareMetrics, extractMetrics, findBaselineEntry, listBaselineVersions, readBaselineIndex, readBoundsJson, renderCompareMarkdown, saveBaselineFiles, writeBaselineIndex, writeCompareResult } from '../baseline.js';
import { resolveSharedPath } from '../evidence.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { readLatestJson } from '../state.js';
import { fileExists, sha256File } from '../util/fs.js';
import { nowIso, table } from '../util/md.js';
import { ArgError, arrayOfRecords, asRecord, optionalBoolean, optionalString, optionalStringArray, requiredEnum, requiredString } from './args.js';
import { pathsOf, requireSpec } from './common.js';
const TOOL = 'dwguard_aesthetic';
const ACTIONS = ['profile', 'baseline', 'compare', 'learn'];
const PROFILE_OPS = ['list', 'get', 'write', 'remove'];
const BASELINE_OPS = ['save', 'list'];
function confidenceArg(args) {
    const value = args['confidence'];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new ArgError(`${TOOL}: \`confidence\` 必须是 0–1 的数字（写档案必须带来源与置信度）。`);
    }
    return value;
}
function entryRow(entry) {
    return [
        `\`${entry.id}\``,
        AREA_LABELS[entry.area] ?? entry.area,
        entry.decision,
        valueLabel(entry.value),
        entry.confidence.toFixed(2),
        entry.source,
        entry.status,
        entry.updatedAt
    ];
}
function profileDetail(profile) {
    if (profile.entries.length === 0)
        return '（档案为空；可用 `learn` 冷启动或 `profile write` 写入）';
    return table(['ID', '领域', '决策', '取值', '置信度', '来源', '状态', '更新时间'], profile.entries.map((entry) => entryRow(entry)));
}
async function runProfile(deps) {
    const { args, paths, now } = deps;
    const op = requiredEnum(args, 'op', PROFILE_OPS, TOOL);
    const profile = await readProfile(paths);
    if (op === 'list') {
        return ok(`审美档案共 ${profile.entries.length} 条（active ${profile.entries.filter((entry) => entry.status === 'active').length}）。`, {
            detail: profileDetail(profile),
            files: [displayPath(paths, paths.aestheticProfileMd)],
            next: profile.entries.length === 0 ? '用 `learn`（`coldStart: true`）从项目资源里播种。' : '在任务包里用 `profileRef` 引用这些档案。'
        });
    }
    if (op === 'get') {
        const id = requiredString(args, 'id', TOOL, 40);
        const entry = findProfileEntry(profile, id);
        if (entry === undefined)
            return fail(`审美档案里没有 \`${id}\`。`, { detail: profileDetail(profile) });
        return ok(`审美档案 \`${id}\`：${entry.decision}（${valueLabel(entry.value)}，置信度 ${entry.confidence.toFixed(2)}）。`, {
            detail: profileDetail({ schemaVersion: 1, entries: [entry] }),
            files: [displayPath(paths, paths.aestheticProfileMd)]
        });
    }
    if (op === 'write') {
        const area = requiredEnum(args, 'area', AESTHETIC_AREAS, TOOL);
        const decision = requiredString(args, 'decision', TOOL, 120);
        // AEST-K: a preference without a source never enters the profile.
        const source = requiredString(args, 'source', TOOL, 120);
        const confidence = confidenceArg(args);
        const evidence = optionalStringArray(args, 'evidence', TOOL, 8);
        const normalized = normalizeValue(area, { number: args['number'], unit: args['unit'], color: args['color'] });
        if (normalized.value === undefined) {
            return fail(`取值无效：${normalized.error ?? '缺少 number 或 color'}`, { next: '给 `number`（可配 `unit`）或 `color`。' });
        }
        const value = normalized.value;
        const requestedId = optionalString(args, 'id', TOOL, 40);
        if (requestedId !== undefined && !isAestheticId(requestedId)) {
            return fail(`\`id\` 格式不对：${requestedId}（应为 \`AES-<领域>-<两位数字>\`）。`);
        }
        if (requestedId !== undefined && findProfileEntry(profile, requestedId) !== undefined) {
            return fail(`\`${requestedId}\` 已存在；改档案请用 \`remove\` 或让 \`learn\` 产生冲突裁决。`);
        }
        const id = requestedId ?? nextAestheticId(area, profile.entries);
        const activeInArea = profile.entries.filter((entry) => entry.status === 'active' && entry.area === area);
        const sameValue = activeInArea.find((entry) => valueLabel(entry.value) === valueLabel(value));
        if (sameValue !== undefined) {
            return fail(`「${AREA_LABELS[area]}」已有相同取值 \`${valueLabel(value)}\`（\`${sameValue.id}\`）。`, {
                detail: '重复证据应走 `learn`（置信度 +0.05），而不是重复写一条。',
                next: '用 `learn` 记录这次重复证据。'
            });
        }
        const superseded = activeInArea.map((entry) => ({
            ...entry,
            status: 'superseded',
            supersededBy: id,
            updatedAt: now
        }));
        const nextEntries = profile.entries.map((entry) => superseded.find((item) => item.id === entry.id) ?? entry);
        const entry = {
            id,
            area,
            decision,
            value,
            source,
            evidence,
            confidence,
            status: 'active',
            updatedAt: now
        };
        const nextProfile = { schemaVersion: 1, entries: [...nextEntries, entry] };
        await writeProfile(paths, nextProfile);
        const history = await appendAestheticHistory(paths, [
            ...superseded.map((old) => ({
                at: now,
                kind: 'superseded',
                id: old.id,
                area: old.area,
                value: valueLabel(old.value),
                sources: [old.source],
                note: `被 ${id} 取代（手动写入）`
            })),
            {
                at: now,
                kind: 'applied',
                id,
                area,
                value: valueLabel(value),
                sources: [source],
                note: '手动写入'
            }
        ]);
        return ok(`已写入审美偏好 \`${id}\`：${AREA_LABELS[area]} ${valueLabel(value)}（置信度 ${confidence.toFixed(2)}）。`, {
            detail: [
                profileDetail({ schemaVersion: 1, entries: [entry] }),
                '',
                superseded.length > 0
                    ? `原「${AREA_LABELS[area]}」条目已被取代：${superseded.map((old) => `\`${old.id}\``).join('、')}（历史可追溯）。`
                    : ''
            ]
                .filter((line) => line.length > 0)
                .join('\n'),
            files: [displayPath(paths, paths.aestheticProfileMd), ...(history === null ? [] : [displayPath(paths, history)])],
            next: '在任务包的审美判据里用 `profileRef` 引用它；审计会校验引用并写进报告。'
        });
    }
    // op === 'remove'
    const id = requiredString(args, 'id', TOOL, 40);
    const entry = findProfileEntry(profile, id);
    if (entry === undefined)
        return fail(`审美档案里没有 \`${id}\`。`);
    if (entry.status === 'superseded')
        return fail(`\`${id}\` 已是 superseded，不需要再移除。`);
    const retired = { ...entry, status: 'superseded', updatedAt: now };
    await writeProfile(paths, {
        schemaVersion: 1,
        entries: profile.entries.map((item) => (item.id === id ? retired : item))
    });
    const history = await appendAestheticHistory(paths, [
        {
            at: now,
            kind: 'superseded',
            id,
            area: entry.area,
            value: valueLabel(entry.value),
            sources: [entry.source],
            note: '手动标记 superseded（不删除）'
        }
    ]);
    return ok(`\`${id}\` 已标记 superseded（历史保留，可追溯）。`, {
        files: [displayPath(paths, paths.aestheticProfileMd), ...(history === null ? [] : [displayPath(paths, history)])]
    });
}
async function runBaseline(deps) {
    const { args, paths, now, options } = deps;
    const op = requiredEnum(args, 'op', BASELINE_OPS, TOOL);
    const pack = await requireSpec(paths, options, TOOL);
    if (op === 'list') {
        const versions = await listBaselineVersions(paths);
        if (versions.length === 0)
            return fail('还没有任何视觉基线。', { next: '先用 `baseline save` 保存（需通过审计 + 用户确认）。' });
        const rows = [];
        for (const version of versions) {
            const index = await readBaselineIndex(paths, version);
            for (const entry of index.entries) {
                rows.push([
                    `v${version}`,
                    entry.page,
                    entry.state,
                    entry.savedAt,
                    entry.boundsSha256.slice(0, 12),
                    entry.screenshotFile ?? '—',
                    `#${entry.auditId}`
                ]);
            }
        }
        return ok(`共有 ${rows.length} 份视觉基线（任务包版本 ${versions.map((version) => `v${version}`).join(' / ')}）。`, {
            detail: rows.length === 0
                ? '（目录存在但没有基线条目）'
                : table(['任务包', '页面', '状态', '保存时间', 'bounds sha256', '截图', '审计'], rows)
        });
    }
    // op === 'save' — gated on a passing audit and a user confirmation.
    const page = requiredString(args, 'page', TOOL, 80);
    const state = optionalString(args, 'state', TOOL, 80) ?? 'default';
    const boundsRel = requiredString(args, 'bounds', TOOL, 300);
    const screenshotRel = optionalString(args, 'screenshot', TOOL, 300);
    let boundsSource;
    let screenshotSource;
    try {
        boundsSource = resolveSharedPath(paths, boundsRel);
        screenshotSource = screenshotRel === undefined ? undefined : resolveSharedPath(paths, screenshotRel);
    }
    catch (error) {
        return fail(`基线文件路径非法：${error.message}`);
    }
    if (!(await fileExists(boundsSource)))
        return fail(`布局树文件不存在：${boundsRel}`);
    if (screenshotSource !== undefined && !(await fileExists(screenshotSource))) {
        return fail(`截图文件不存在：${screenshotRel ?? ''}`);
    }
    const audit = await readLatestJson(paths.artifactsDir, 'audit');
    if (audit === null || audit.value.gate?.pass !== true) {
        return fail('还没有通过的审计，不能保存视觉基线（AEST-F）。', {
            next: '先跑一次通过的 `dwguard_audit`，再保存基线。'
        });
    }
    if (audit.value.specVersion !== pack.specVersion) {
        return fail(`最近一次审计属于任务包 v${audit.value.specVersion ?? '?'}，与当前 v${pack.specVersion} 不一致；基线必须和当前任务包版本对齐。`);
    }
    const confirmation = await readLatestJson(paths.artifactsDir, 'confirmation');
    if (confirmation === null || confirmation.value.specVersion !== pack.specVersion) {
        return fail('缺少本轮用户确认（`artifacts/confirmation-<n>.json`），不能保存视觉基线（AEST-F）。', {
            next: '先用 `dwguard_confirm` 记录用户决定，再保存基线。'
        });
    }
    const entry = await saveBaselineFiles(paths, pack.specVersion, {
        page,
        state,
        boundsSource,
        ...(screenshotSource === undefined ? {} : { screenshotSource }),
        auditId: audit.index,
        confirmationId: confirmation.index,
        now
    });
    const index = await readBaselineIndex(paths, pack.specVersion);
    await writeBaselineIndex(paths, pack.specVersion, {
        schemaVersion: 1,
        specVersion: pack.specVersion,
        entries: [...index.entries.filter((item) => !(item.page === page && item.state === state)), entry]
    });
    return ok(`已保存视觉基线：${page}/${state}（任务包 v${pack.specVersion}，审计 #${audit.index}，确认 #${confirmation.index}）。`, {
        detail: [
            `- bounds：\`${baselineDisplayPath(paths, pack.specVersion, entry)}\``,
            `- sha256：\`${entry.boundsSha256}\``,
            entry.screenshotFile === undefined ? '- 截图：未附' : `- 截图：\`${entry.screenshotFile}\``
        ].join('\n'),
        files: [baselineDisplayPath(paths, pack.specVersion, entry)],
        next: '下一轮修改后用 `compare` 对照基线；差异会进入审计与验收报告。'
    });
}
async function runCompare(deps) {
    const { args, paths, now, options } = deps;
    const pack = await requireSpec(paths, options, TOOL);
    const page = requiredString(args, 'page', TOOL, 80);
    const state = optionalString(args, 'state', TOOL, 80) ?? 'default';
    const boundsRel = requiredString(args, 'bounds', TOOL, 300);
    let currentFile;
    try {
        currentFile = resolveSharedPath(paths, boundsRel);
    }
    catch (error) {
        return fail(`当前布局树路径非法：${error.message}`);
    }
    const index = await readBaselineIndex(paths, pack.specVersion);
    const baseline = findBaselineEntry(index, page, state);
    if (baseline === undefined) {
        return fail(`任务包 v${pack.specVersion} 里没有 ${page}/${state} 的视觉基线。`, {
            next: '先用 `baseline save` 保存基线（需通过审计 + 用户确认）。'
        });
    }
    const baselineRead = await readBoundsJson(join(baselineDir(paths, pack.specVersion), baseline.boundsFile));
    if ('error' in baselineRead)
        return fail(`基线布局树不可读：${baselineRead.error}`);
    const currentRead = await readBoundsJson(currentFile);
    if ('error' in currentRead)
        return fail(currentRead.error);
    const result = compareMetrics(extractMetrics(baselineRead.value), extractMetrics(currentRead.value), {
        at: now,
        specVersion: pack.specVersion,
        page,
        state,
        boundsSha256: await sha256File(currentFile),
        baselineBoundsSha256: baseline.boundsSha256
    });
    await writeCompareResult(paths, result);
    const failed = result.rows.filter((row) => row.verdict === 'fail');
    const detail = renderCompareMarkdown(result);
    if (result.pass) {
        return ok(`审美基线一致：${page}/${state}（${result.rows.length} 项测量全部在容差内）。`, {
            detail,
            files: [displayPath(paths, paths.aestheticCompare)],
            next: '把 compare 结果（或实测值）作为审美判据的 `actual`；验收报告会自动带上基线差异。'
        });
    }
    return fail(`审美基线出现 ${failed.length} 项差异：${page}/${state}。`, {
        detail,
        files: [displayPath(paths, paths.aestheticCompare)],
        next: '确认差异是回归还是用户要求的新设计：回归就修代码；新设计需重跑审计并用 `baseline save` 重建基线。'
    });
}
async function runLearn(deps) {
    const { args, paths, now } = deps;
    const sourceRows = args['sources'] === undefined ? [] : arrayOfRecords(args, 'sources', TOOL, 16);
    const sources = sourceRows.map((row, index) => {
        const label = `${TOOL}.sources[${index}]`;
        const kind = requiredEnum(row, 'kind', AESTHETIC_SOURCE_KINDS, label);
        return {
            kind,
            text: requiredString(row, 'text', label, 2000),
            ...(optionalString(row, 'evidence', label, 120) === undefined
                ? {}
                : { evidence: optionalString(row, 'evidence', label, 120) })
        };
    });
    const coldStart = optionalBoolean(args, 'coldStart', sources.length === 0);
    const apply = optionalBoolean(args, 'apply', false);
    const confirmed = optionalBoolean(args, 'confirmed', false);
    const choice = optionalString(args, 'choice', TOOL, 120);
    const facts = [];
    const sourcesByKey = new Map();
    const startConfidence = new Map();
    const fromText = factsFromSources(sources);
    for (const fact of fromText.facts)
        facts.push(fact);
    for (const [key, value] of fromText.sourcesByKey)
        sourcesByKey.set(key, [...(sourcesByKey.get(key) ?? []), ...value]);
    for (const [label, value] of fromText.startConfidence)
        startConfidence.set(label, value);
    const resourceFiles = [];
    if (coldStart) {
        const resources = await readProjectAestheticFacts(paths.workspace);
        resourceFiles.push(...resources.files.map((file) => displayPath(paths, file)));
        for (const fact of resources.facts) {
            const key = `${fact.area}:${valueLabel(fact.value)}`;
            if (!facts.some((item) => `${item.area}:${valueLabel(item.value)}` === key))
                facts.push(fact);
            const list = sourcesByKey.get(key) ?? [];
            if (!list.includes('project-resources'))
                list.push('project-resources');
            sourcesByKey.set(key, list);
            startConfidence.set('project-resources', 0.6);
        }
    }
    if (facts.length === 0) {
        return fail('没有识别到可记录的审美数值。', {
            detail: '`learn` 只从文本里抽取数字/颜色 + 领域关键词（间距/圆角/字号/配色/动效/深色/图标/卡片），或用 `coldStart: true` 读取项目 `resources/base/element/color.json`、`float.json`。',
            next: '给一段包含具体数值的用户原话（如「卡片圆角 20，间距保持 12」），或冷启动。'
        });
    }
    const profile = await readProfile(paths);
    const result = learnAesthetics(profile, facts, sourcesByKey, startConfidence);
    const proposalBlock = [
        '**提议**',
        '',
        renderProposals(result.proposals),
        '',
        '**冲突（需要用户裁决）**',
        '',
        renderConflicts(result.conflicts)
    ].join('\n');
    if (!apply) {
        return ok(`已生成 ${result.proposals.length} 条提议、${result.conflicts.length} 个冲突；档案未写入。`, {
            detail: [
                proposalBlock,
                '',
                '> `learn` 默认只提议不落盘（AEST-B）。用户确认后带 `apply: true` 与 `confirmed: true` 再调用；有冲突时用 `choice` 指定保留的值或 ID。'
            ].join('\n'),
            files: [displayPath(paths, paths.aestheticProfileMd)],
            next: '把提议与冲突交给用户裁决，再 `apply`。'
        });
    }
    if (!confirmed) {
        return fail('`apply` 需要用户确认：先让用户看过提议，再带 `confirmed: true` 调用。', {
            detail: proposalBlock,
            next: '确认后重试：`{ action: "learn", apply: true, confirmed: true, choice: "<值或ID>" }`。'
        });
    }
    const outcome = applyAestheticProposals(profile, result, { choice, now });
    if (outcome.unresolved.length > 0) {
        return fail(`有 ${outcome.unresolved.length} 个冲突未裁决，档案未写入（AEST-E）。`, {
            detail: [renderConflicts(outcome.unresolved), '', '用 `choice` 指定保留的值（如 `20vp`）或档案 ID（如 `AES-RADIUS-01`）。'].join('\n'),
            next: '把冲突交给用户，拿到选择后重试 apply。'
        });
    }
    await writeProfile(paths, outcome.profile);
    const history = await appendAestheticHistory(paths, outcome.events);
    return ok(`审美档案已更新：新增/更新 ${outcome.applied.length} 条，取代 ${outcome.superseded.length} 条。`, {
        detail: [
            outcome.applied.length === 0
                ? '（没有实际写入）'
                : table(['ID', '领域', '决策', '取值', '置信度', '来源', '状态'], outcome.applied.map((entry) => [
                    `\`${entry.id}\``,
                    AREA_LABELS[entry.area],
                    entry.decision,
                    valueLabel(entry.value),
                    entry.confidence.toFixed(2),
                    entry.source,
                    entry.status
                ])),
            outcome.superseded.length === 0 ? '' : `\n已被取代：${outcome.superseded.map((entry) => `\`${entry.id}\``).join('、')}（历史可追溯）。`
        ]
            .filter((line) => line.trim().length > 0)
            .join('\n'),
        files: [displayPath(paths, paths.aestheticProfileMd), ...(history === null ? [] : [displayPath(paths, history)])],
        next: '任务包审美判据可用 `profileRef` 引用这些档案；审计会校验引用并渲染档案值。'
    });
}
/**
 * Create the `dwguard_aesthetic` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createAestheticTool(options, ctx) {
    return defineTool({
        name: TOOL,
        description: 'Aesthetic learning v1 (0.6.1): `profile` (list/get/write/remove), `baseline` (save/list visual baselines), `compare` (numeric layout diff against the baseline) and `learn` (propose preferences from confirmed user wording or project resources). ' +
            '`learn` never writes unless `apply: true` and `confirmed: true`; a conflict needs `choice`. `baseline save` is refused without a passing audit + user confirmation. ' +
            '审美判断有档案、有基线、可解释可撤销；不用模型猜没说过的话。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...ACTIONS],
                description: 'profile / baseline / compare / learn。'
            },
            op: {
                type: 'string',
                enum: [...PROFILE_OPS, ...BASELINE_OPS],
                description: '子操作：profile 用 list/get/write/remove；baseline 用 save/list。'
            },
            id: { type: 'string', description: '档案 ID（如 `AES-RADIUS-01`），`profile get/remove` 与可选 `write` 用。' },
            area: {
                type: 'string',
                enum: [...AESTHETIC_AREAS],
                description: '偏好领域：palette / spacing / radius / type / density / motion / dark / icon / card。'
            },
            decision: { type: 'string', description: '人类可读的决策，如「卡片圆角 20vp」。' },
            number: { type: 'number', description: '数值取值（与 `unit` 搭配）。' },
            unit: { type: 'string', description: '单位：vp / dp / px / pt / ms / % / deg（不填按领域默认）。' },
            color: { type: 'string', description: '颜色取值 #RRGGBB（与 number 二选一）。' },
            source: { type: 'string', description: '来源（必填，如 `confirmation-3`、`design-review`）；没有来源的写入会被拒绝（AEST-K）。' },
            confidence: { type: 'number', description: '置信度 0–1（写档案必填）。' },
            evidence: { type: 'array', items: { type: 'string' }, description: '证据：截图、审计编号、确认记录。' },
            page: { type: 'string', description: '页面名（baseline/compare 用，如 `home`）。' },
            state: { type: 'string', description: '状态名（baseline/compare 用，默认 `default`）。' },
            bounds: {
                type: 'string',
                description: '布局树 JSON，相对 `.shared/` 的路径；baseline save 存基线、compare 用当前值。'
            },
            screenshot: { type: 'string', description: '截图，相对 `.shared/` 的路径（可选，baseline save 用，供人工复核）。' },
            sources: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        kind: {
                            type: 'string',
                            required: true,
                            enum: [...AESTHETIC_SOURCE_KINDS],
                            description: 'confirmation / rejection / audit-finding / calibration-miss / project-resources。'
                        },
                        text: { type: 'string', required: true, description: '用户原话或审计结论原文。' },
                        evidence: { type: 'string', description: '可选证据标签（确认编号、审计编号）。' }
                    }
                },
                description: '本轮学习输入（learn 用）。'
            },
            coldStart: { type: 'boolean', description: '从项目 `resources/base/element/color.json` / `float.json` 播种。' },
            apply: { type: 'boolean', description: 'true = 写入档案（默认只提议）。' },
            confirmed: { type: 'boolean', description: '用户已确认提议；apply 必须为 true。' },
            choice: { type: 'string', description: '冲突裁决：保留的值（如 `20vp`）或档案 ID。' }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            await ensureShared(paths);
            const action = requiredEnum(args, 'action', ACTIONS, TOOL);
            const now = nowIso();
            const deps = { options, paths, args, now };
            if (action === 'profile')
                return runProfile(deps);
            if (action === 'baseline')
                return runBaseline(deps);
            if (action === 'compare')
                return runCompare(deps);
            return runLearn(deps);
        },
        presentCall(args) {
            return presentCall('Aesthetic · 审美学习', 'other', args);
        }
    });
}
