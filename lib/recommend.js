/**
 * 0.6.8: recommend design directions and freeze the user's accepted choice
 * into a local design pack (`README.md` + cards + `pack.json` + preview).
 *
 * The recommendation is deliberately explainable: hard filters, metadata
 * matches and a small weighted score; it never claims a single "best" design.
 *
 * @module dwguard-dsh-hmos/recommend
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DESIGN_ENGINE_VERSION, deriveColorProfile, designCardKind, nextDesignId, normalizePreviewPath, readDesignIndex, readDesignManifest, searchDesignWithRanker, writeDesignLibrary } from './design.js';
import { displayPath } from './paths.js';
import { ensureDir, readTextOrNull, writeTextAtomic } from './util/fs.js';
const PACK_NAME = /^[a-z0-9][a-z0-9_-]{1,40}$/i;
const HEX = /^#[0-9a-f]{6}$/i;
function normalizeTag(value) {
    if (value === undefined)
        return undefined;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length === 0 ? undefined : trimmed;
}
function includesTag(values, wanted) {
    if (wanted === undefined || values === undefined)
        return false;
    return values.some((value) => value.trim().toLowerCase() === wanted);
}
function brandTemperature(colors) {
    const rgb = colors
        .filter((color) => HEX.test(color))
        .map((color) => ({
        r: Number.parseInt(color.slice(1, 3), 16),
        g: Number.parseInt(color.slice(3, 5), 16),
        b: Number.parseInt(color.slice(5, 7), 16)
    }));
    if (rgb.length === 0)
        return undefined;
    const delta = rgb.reduce((sum, item) => sum + item.r - item.b, 0) / rgb.length;
    return delta > 12 ? 'warm' : delta < -12 ? 'cool' : 'neutral';
}
function tokenSummary(card) {
    const parts = [];
    if (card.tokens.palette.length > 0)
        parts.push(`配色 ${card.tokens.palette.map((token) => token.value).join(' / ')}`);
    if (card.tokens.spacing.length > 0) {
        parts.push(`间距 ${card.tokens.spacing.map((token) => `${token.value}${token.unit}`).join(' / ')}`);
    }
    if (card.tokens.radius.length > 0) {
        parts.push(`圆角 ${card.tokens.radius.map((token) => `${token.value}${token.unit}`).join(' / ')}`);
    }
    if (card.tokens.type.length > 0) {
        parts.push(`字号 ${card.tokens.type.map((token) => `${token.value}${token.unit}`).join(' / ')}`);
    }
    if (card.tokens.motion.length > 0) {
        parts.push(`动效 ${card.tokens.motion.map((token) => `${token.value}${token.unit}`).join(' / ')}`);
    }
    return parts.length === 0 ? '（无 tokens）' : parts.join('；');
}
function cardMap(manifest) {
    return new Map(manifest.cards.map((card) => [card.id, card]));
}
function scoreCard(card, baseScore, maxBase, input, brandTemp) {
    const module = normalizeTag(input.module);
    const tone = normalizeTag(input.tone);
    let score = (baseScore / maxBase) * 0.55;
    if (includesTag(card.moduleTags, module))
        score += 0.4;
    if (input.appType !== undefined && card.dimensions?.appType !== undefined && card.dimensions.appType.trim().toLowerCase() === input.appType.trim().toLowerCase()) {
        score += 0.2;
    }
    if (input.platform !== undefined && card.dimensions?.platform !== undefined && card.dimensions.platform.trim().toLowerCase() === input.platform.trim().toLowerCase()) {
        score += 0.12;
    }
    if (includesTag(card.tone, tone))
        score += 0.18;
    if (input.density !== undefined && card.density === input.density)
        score += 0.12;
    if (brandTemp !== undefined && card.colorProfile?.temperature === brandTemp)
        score += 0.08;
    if (card.packRef !== undefined)
        score += 0.1;
    return Number(Math.min(1, score * Math.min(1.5, Math.max(0.5, card.weight))).toFixed(4));
}
function pickDiverse(ranked, limit) {
    const picked = [];
    const signatures = new Set();
    const signature = (card) => card.packRef !== undefined
        ? `pack:${card.packRef}`
        : (card.stylePriority?.[0] ?? card.tone?.[0] ?? card.dimensions?.style ?? 'default').trim().toLowerCase();
    for (const item of ranked) {
        if (picked.length >= limit)
            break;
        const key = signature(item.card);
        if (signatures.has(key))
            continue;
        signatures.add(key);
        picked.push(item);
    }
    for (const item of ranked) {
        if (picked.length >= limit)
            break;
        if (picked.some((entry) => entry.card.id === item.card.id))
            continue;
        picked.push(item);
    }
    return picked;
}
function renderOptionsMarkdown(recommendation, cards) {
    const lines = [
        `# 设计候选 · ${recommendation.requirement}`,
        '',
        `> ${recommendation.createdAt} · 任务包 v${recommendation.specVersion} · 共 ${recommendation.options.length} 套`,
        recommendation.module === undefined ? '' : `> 适用模块：\`${recommendation.module}\``,
        recommendation.brandColors.length === 0 ? '' : `> 品牌色：${recommendation.brandColors.join(' / ')}`,
        '',
        '> 选一套后运行：`dwguard_design capture-pack choice:"opt-1" name:"<pack-name>" confirmed:true`',
        ''
    ];
    for (const option of recommendation.options) {
        const anchor = cards.get(option.patternIds[0] ?? '');
        lines.push(`## ${option.id} · ${option.title}`, '', `- 评分：${option.score.toFixed(2)}`, `- 锚点卡片：${option.patternIds.map((id) => `\`${id}\``).join('、')}`, option.principleIds.length === 0 ? '- 原则：—' : `- 原则：${option.principleIds.map((id) => `\`${id}\``).join('、')}`, option.antiPatternIds.length === 0 ? '- 禁止项：—' : `- 禁止项：${option.antiPatternIds.map((id) => `\`${id}\``).join('、')}`, `- tokens：${anchor === undefined ? '—' : tokenSummary(anchor)}`, option.preview === undefined ? '- 预览：—' : `- 预览：\`${option.preview}\`（仅视觉参考，不复制代码）`, option.packRef === undefined ? '- 范式包：—' : `- 范式包：\`${option.packRef}\`（已审计 + 用户确认）`, option.componentIds === undefined ? '' : `- 卡组：${option.componentIds.map((id) => `\`${id}\``).join('、')}`, '', '**为什么：**', ...option.why.map((item) => `- ${item}`), '', '**代价 / 注意：**', ...option.cost.map((item) => `- ${item}`), '');
    }
    return `${lines.join('\n')}\n`;
}
/** Recommend up to 3 diverse directions from the library (0.6.8). */
export async function recommendDesign(paths, options, specVersion, input, now) {
    const manifest = await readDesignManifest(paths);
    if (manifest === null)
        throw new Error('设计库尚未初始化；先运行 `library init` + `library ingest`。');
    const { index, chunks } = await readDesignIndex(paths);
    const module = normalizeTag(input.module);
    const tone = normalizeTag(input.tone);
    const brandColors = (input.brandColors ?? []).map((color) => color.trim().toUpperCase()).filter((color) => HEX.test(color));
    const brandTemp = brandTemperature(brandColors);
    const query = [input.requirement, module, input.appType, tone, ...brandColors].filter((part) => part !== undefined && part.length > 0).join(' ');
    const base = await searchDesignWithRanker(paths, options, manifest, index, chunks, query, 30, {
        licenseRequired: options.designLicenseRequired,
        filters: { kind: 'pattern' }
    });
    const cards = cardMap(manifest);
    const maxBase = Math.max(...base.results.map((hit) => hit.score), 1e-9);
    const ranked = new Map();
    for (const hit of base.results) {
        const card = cards.get(hit.cardId);
        if (card === undefined || designCardKind(card) !== 'pattern' || card.status !== 'active')
            continue;
        ranked.set(card.id, { card, score: scoreCard(card, hit.score, maxBase, input, brandTemp) });
    }
    // Metadata-only candidates: a module/tone match should not depend on BM25.
    for (const card of manifest.cards) {
        if (designCardKind(card) !== 'pattern' || card.status !== 'active')
            continue;
        if (ranked.has(card.id))
            continue;
        const moduleMatch = includesTag(card.moduleTags, module);
        const toneMatch = includesTag(card.tone, tone);
        if (!moduleMatch && !toneMatch)
            continue;
        ranked.set(card.id, { card, score: scoreCard(card, 0, maxBase, input, brandTemp) });
    }
    // Always offer up to `topK` directions: fill with remaining active patterns
    // as clearly-labelled low-match alternatives instead of silently returning 1.
    for (const card of manifest.cards) {
        if (designCardKind(card) !== 'pattern' || card.status !== 'active')
            continue;
        if (ranked.has(card.id))
            continue;
        ranked.set(card.id, { card, score: 0 });
    }
    const sorted = [...ranked.values()].sort((left, right) => right.score - left.score);
    const packComponentIds = new Set(sorted
        .filter((item) => item.card.packRef !== undefined)
        .flatMap((item) => item.card.componentIds ?? []));
    const withoutPackDuplicates = sorted.filter((item) => item.card.packRef !== undefined || !packComponentIds.has(item.card.id));
    const topK = Math.min(3, Math.max(1, input.topK ?? 3));
    const picked = pickDiverse(withoutPackDuplicates.length >= topK ? withoutPackDuplicates : sorted, topK);
    // Principles are shared direction cards; pick the closest ones once.
    const principleResult = await searchDesignWithRanker(paths, options, manifest, index, chunks, query, 3, {
        licenseRequired: options.designLicenseRequired,
        filters: { kind: 'principle' }
    });
    const principleIds = principleResult.results
        .map((hit) => cards.get(hit.cardId))
        .filter((card) => card !== undefined)
        .map((card) => card.id);
    const recommendations = picked.map((item, index) => {
        const card = item.card;
        const why = [];
        if (item.score > 0)
            why.push(`检索/融合评分 ${item.score.toFixed(2)}`);
        if (includesTag(card.moduleTags, module))
            why.push(`模块匹配：${module}`);
        if (input.appType !== undefined && card.dimensions?.appType !== undefined && card.dimensions.appType.trim().toLowerCase() === input.appType.trim().toLowerCase()) {
            why.push(`App 类型匹配：${input.appType}`);
        }
        if (input.platform !== undefined && card.dimensions?.platform !== undefined && card.dimensions.platform.trim().toLowerCase() === input.platform.trim().toLowerCase()) {
            why.push(`平台匹配：${input.platform}`);
        }
        if (includesTag(card.tone, tone))
            why.push(`气质匹配：${tone}`);
        if (input.density !== undefined && card.density === input.density)
            why.push(`密度匹配：${input.density}`);
        if (brandTemp !== undefined && card.colorProfile?.temperature === brandTemp)
            why.push(`品牌色温度匹配：${brandTemp}`);
        if (card.packRef !== undefined)
            why.push(`源自范式包 ${card.packRef}（已通过四维审计 + 用户确认）`);
        if (card.componentIds !== undefined && card.componentIds.length > 0) {
            why.push(`卡组：${card.componentIds.map((id) => `\`${id}\``).join('、')}`);
        }
        if (card.stylePriority !== undefined && card.stylePriority.length > 0)
            why.push(`风格：${card.stylePriority.join(' > ')}`);
        if (why.length === 0)
            why.push('与当前模块/语义匹配较弱，作为对照方向');
        const optionModule = includesTag(card.moduleTags, module) ? module : card.moduleTags?.[0];
        const optionTone = includesTag(card.tone, tone) ? tone : card.tone?.[0];
        const optionAppType = card.dimensions?.appType;
        const optionPlatform = card.dimensions?.platform;
        const optionDensity = card.density;
        const cost = [];
        if (card.antiPatterns !== undefined && card.antiPatterns.length > 0) {
            cost.push(`同时避开 ${card.antiPatterns.map((id) => `\`${id}\``).join('、')}`);
        }
        if (card.donts.length > 0)
            cost.push(`实现时避免：${card.donts.join('；')}`);
        if (card.preview === undefined)
            cost.push('没有 preview，需要截图/说明确认');
        if (brandColors.length > 0)
            cost.push('色值需替换为品牌色，并在 HarmonyOS 真机重测对比度');
        if (card.packRef !== undefined)
            cost.push('范式包是来源证据，新项目仍需重新跑四维审计');
        if (item.score === 0)
            cost.push('与当前模块/语义匹配较弱，仅作对照方向');
        const antiPatternIds = card.antiPatterns ?? [];
        return {
            id: `opt-${index + 1}`,
            title: card.title,
            patternIds: [card.id],
            principleIds,
            antiPatternIds,
            score: item.score,
            why,
            cost,
            ...(card.preview === undefined ? {} : { preview: card.preview }),
            ...(optionModule === undefined ? {} : { module: optionModule }),
            ...(optionAppType === undefined ? {} : { appType: optionAppType }),
            ...(optionPlatform === undefined ? {} : { platform: optionPlatform }),
            ...(optionTone === undefined ? {} : { tone: optionTone }),
            ...(optionDensity === undefined ? {} : { density: optionDensity }),
            ...(card.packRef === undefined ? {} : { packRef: card.packRef }),
            ...(card.componentIds === undefined ? {} : { componentIds: card.componentIds })
        };
    });
    const recommendation = {
        schemaVersion: 1,
        createdAt: now,
        specVersion,
        requirement: input.requirement,
        ...(module === undefined ? {} : { module }),
        ...(input.appType === undefined ? {} : { appType: input.appType }),
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(tone === undefined ? {} : { tone }),
        ...(input.density === undefined ? {} : { density: input.density }),
        brandColors,
        options: recommendations
    };
    await ensureDir(join(paths.shared, 'tasks'));
    await writeTextAtomic(paths.designOptionsMd, renderOptionsMarkdown(recommendation, cards));
    await writeTextAtomic(paths.designRecommendations, `${JSON.stringify(recommendation, null, 2)}\n`);
    return { file: paths.designOptionsMd, recommendation };
}
function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
function renderPackReadme(name, recommendation, option, cards, cardFiles, preview, evidence, now) {
    const anchor = cards.find((card) => card.id === option.patternIds[0]);
    const lines = [
        `# 设计包 · ${name}`,
        '',
        `> 由 recommend 的 \`${option.id}\` 冻结 · ${now}`,
        '',
        `- 需求：${recommendation.requirement}`,
        (option.module ?? recommendation.module) === undefined ? '' : `- 适用模块：${option.module ?? recommendation.module}`,
        option.appType === undefined ? '' : `- App 类型：${option.appType}`,
        option.platform === undefined ? '' : `- 平台：${option.platform}`,
        option.tone === undefined ? '' : `- 气质：${option.tone}`,
        option.density === undefined ? '' : `- 密度：${option.density}`,
        preview === undefined ? '- 预览：—' : `- 预览：\`${preview}\`（仅视觉参考，不复制代码）`,
        `- 审计：\`${evidence.auditReport}\`（sha256 ${evidence.auditSha256}）`,
        `- 确认：\`${evidence.confirmation}\`（sha256 ${evidence.confirmationSha256} · ${evidence.userDecision}）`,
        `- 卡片：${cards.map((card) => `\`${card.id}\` ${card.title}`).join('；')}`,
        '',
        '## 卡组',
        '',
        '| 文件 | 原卡片 | 角色 | 标题 |',
        '| --- | --- | --- | --- |',
        ...cardFiles.map((entry) => {
            const card = cards.find((item) => item.id === entry.sourceId);
            return `| \`${entry.file}\` | \`${entry.sourceId}\` | ${entry.role} | ${card?.title ?? '—'} |`;
        }),
        '',
        '## 为什么',
        '',
        ...option.why.map((item) => `- ${item}`),
        '',
        '## 代价 / 注意',
        '',
        ...option.cost.map((item) => `- ${item}`),
        '',
        '## 验收提示',
        '',
        '- 四维判据以任务包为准；本包只提供设计方向与对照。',
        '- 预览 HTML 只是视觉参考，不是生产代码；实现必须用 ArkUI。',
        '- 色值替换为品牌色后，在 HarmonyOS 真机上重测对比度、触控与减少动态。',
        ''
    ];
    if (anchor !== undefined) {
        lines.push('## 锚点卡片 tokens', '', tokenSummary(anchor), '');
    }
    return `${lines.join('\n')}\n`;
}
function slugify(value) {
    const ascii = value
        .normalize('NFKD')
        .replace(/[^\w-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return (ascii.length === 0 ? 'card' : ascii).slice(0, 48);
}
function roleOf(cardId, option) {
    if (option.patternIds[0] === cardId)
        return 'anchor';
    if (option.patternIds.includes(cardId))
        return 'support';
    if (option.principleIds.includes(cardId))
        return 'principle';
    return 'anti-pattern';
}
/** Convert an internal card into an inbox-compatible meta (portable, no ids/status). */
export function cardToInboxMeta(card) {
    return {
        kind: card.kind ?? 'pattern',
        title: card.title,
        summary: card.summary,
        tags: card.tags,
        tokens: card.tokens,
        source: card.source,
        dos: card.dos,
        donts: card.donts,
        ...(card.rationale === undefined ? {} : { rationale: card.rationale }),
        ...(card.stylePriority === undefined ? {} : { stylePriority: card.stylePriority }),
        ...(card.antiPatterns === undefined ? {} : { antiPatterns: card.antiPatterns }),
        ...(card.checklist === undefined ? {} : { checklist: card.checklist }),
        ...(card.dimensions === undefined ? {} : { dimensions: card.dimensions }),
        ...(card.brand === undefined ? {} : { brand: card.brand }),
        ...(card.principle === undefined ? {} : { principle: card.principle }),
        ...(card.perceptualEffect === undefined ? {} : { perceptualEffect: card.perceptualEffect }),
        ...(card.proxies === undefined ? {} : { proxies: card.proxies }),
        ...(card.applications === undefined ? {} : { applications: card.applications }),
        ...(card.misuses === undefined ? {} : { misuses: card.misuses }),
        ...(card.moduleTags === undefined ? {} : { moduleTags: card.moduleTags }),
        ...(card.tone === undefined ? {} : { tone: card.tone }),
        ...(card.density === undefined ? {} : { density: card.density })
    };
}
/** Freeze the selected recommendation into a local design pack (0.6.8). */
export async function captureDesignPack(paths, specVersion, input, now) {
    if (!PACK_NAME.test(input.name)) {
        throw new Error('包名只能使用字母、数字、`-`、`_`，长度 2–41，且以字母或数字开头。');
    }
    const raw = await readTextOrNull(paths.designRecommendations);
    if (raw === null)
        throw new Error('还没有 recommend 结果；先运行 `dwguard_design recommend`。');
    let recommendation;
    try {
        recommendation = JSON.parse(raw);
    }
    catch {
        throw new Error('recommendations.json 解析失败；重新运行 recommend。');
    }
    if (recommendation.specVersion !== specVersion) {
        throw new Error(`recommend 结果属于任务包 v${recommendation.specVersion}，当前是 v${specVersion}；重新 recommend。`);
    }
    const option = recommendation.options.find((item) => item.id === input.choice);
    if (option === undefined) {
        throw new Error(`没有找到候选 \`${input.choice}\`；可用：${recommendation.options.map((item) => item.id).join('、')}。`);
    }
    const manifest = await readDesignManifest(paths);
    if (manifest === null)
        throw new Error('设计库尚未初始化。');
    const cards = cardMap(manifest);
    const ids = [...new Set([...option.patternIds, ...option.principleIds, ...option.antiPatternIds])];
    const selected = ids.map((id) => cards.get(id)).filter((card) => card !== undefined);
    if (selected.length === 0)
        throw new Error('候选卡片都不存在；重新 recommend 或重建设计库。');
    const packDir = join(paths.designPacksLocalDir, input.name);
    if (existsSync(packDir))
        throw new Error(`设计包 \`${input.name}\` 已存在；换一个版本化包名。`);
    let previewRelative;
    const requestedPreview = input.preview ?? option.preview;
    if (requestedPreview !== undefined) {
        const normalized = normalizePreviewPath(requestedPreview);
        if (normalized === null || normalized === undefined)
            throw new Error('preview 必须是 .shared 内的 .html 相对路径。');
        const source = resolve(paths.shared, normalized);
        if (source !== paths.shared && !source.startsWith(`${paths.shared}${sep}`))
            throw new Error('preview 越界。');
        if (!existsSync(source))
            throw new Error(`preview 不存在：${normalized}`);
        previewRelative = `design-packs/${input.name}/preview/index.html`;
        const target = join(packDir, 'preview', 'index.html');
        await ensureDir(join(packDir, 'preview'));
        await copyFile(source, target);
    }
    await ensureDir(join(packDir, 'cards'));
    const files = [];
    const cardFiles = selected.map((card, index) => ({
        file: `cards/${String(index + 1).padStart(2, '0')}-${slugify(card.title)}.meta.json`,
        sourceId: card.id,
        role: roleOf(card.id, option)
    }));
    for (const [index, card] of selected.entries()) {
        const entry = cardFiles[index];
        if (entry === undefined)
            continue;
        const file = join(packDir, entry.file);
        await writeTextAtomic(file, `${JSON.stringify(cardToInboxMeta(card), null, 2)}\n`);
        files.push(displayPath(paths, file));
    }
    const pack = {
        schemaVersion: 1,
        name: input.name,
        createdAt: now,
        engineVersion: DESIGN_ENGINE_VERSION,
        cards: selected,
        status: 'paradigm',
        specVersion,
        requirement: recommendation.requirement,
        ...(option.module === undefined ? {} : { module: option.module }),
        ...(option.appType === undefined ? {} : { appType: option.appType }),
        ...(option.platform === undefined ? {} : { platform: option.platform }),
        ...(option.tone === undefined ? {} : { tone: option.tone }),
        ...(option.density === undefined ? {} : { density: option.density }),
        brandColors: recommendation.brandColors,
        ...(previewRelative === undefined ? {} : { preview: previewRelative }),
        why: option.why,
        cost: option.cost,
        cardFiles,
        evidence: input.evidence
    };
    await writeTextAtomic(join(packDir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
    files.push(displayPath(paths, join(packDir, 'pack.json')));
    const readme = join(packDir, 'README.md');
    await writeTextAtomic(readme, renderPackReadme(input.name, recommendation, option, selected, cardFiles, previewRelative, input.evidence, now));
    files.push(displayPath(paths, readme));
    const anchor = selected.find((card) => option.patternIds.includes(card.id)) ?? selected[0];
    if (anchor === undefined)
        throw new Error('候选里没有锚点卡片。');
    const projectCard = {
        id: nextDesignId(manifest.cards, 'pattern'),
        title: `范式包 · ${input.name}`,
        summary: recommendation.requirement,
        tags: [...new Set([...anchor.tags, 'project', 'captured', 'paradigm'])].slice(0, 12),
        source: { kind: 'project', ref: `design-pack:${input.name}`, license: 'internal' },
        tokens: anchor.tokens,
        rationale: option.why.join('；'),
        dos: anchor.dos,
        donts: anchor.donts,
        images: [],
        status: 'active',
        weight: 1.2,
        createdAt: now,
        updatedAt: now,
        ingestKey: sha256(`pack|${input.name}|${anchor.id}|${recommendation.requirement}`),
        kind: 'pattern',
        ...(anchor.stylePriority === undefined ? {} : { stylePriority: anchor.stylePriority }),
        ...(option.antiPatternIds.length === 0 ? {} : { antiPatterns: option.antiPatternIds }),
        ...(anchor.checklist === undefined ? {} : { checklist: anchor.checklist }),
        ...(anchor.dimensions === undefined ? {} : { dimensions: anchor.dimensions }),
        ...(option.module === undefined
            ? anchor.moduleTags === undefined ? {} : { moduleTags: anchor.moduleTags }
            : { moduleTags: [option.module] }),
        ...(option.tone === undefined ? (anchor.tone === undefined ? {} : { tone: anchor.tone }) : { tone: [option.tone] }),
        ...(option.density === undefined ? (anchor.density === undefined ? {} : { density: anchor.density }) : { density: option.density }),
        ...(deriveColorProfile(anchor.tokens) === undefined ? {} : { colorProfile: deriveColorProfile(anchor.tokens) }),
        ...(previewRelative === undefined ? {} : { preview: previewRelative }),
        packRef: input.name,
        componentIds: selected.map((card) => card.id)
    };
    const nextManifest = {
        ...manifest,
        updatedAt: now,
        cards: [...manifest.cards, projectCard]
    };
    files.push(...(await writeDesignLibrary(paths, nextManifest)));
    return {
        dir: packDir,
        readme: displayPath(paths, readme),
        cardId: projectCard.id,
        ...(previewRelative === undefined ? {} : { preview: previewRelative }),
        files
    };
}
