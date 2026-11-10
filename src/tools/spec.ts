/**
 * `dwguard_spec` — freeze (or inspect) the task pack.
 *
 * @module dwguard-dsh-hmos/tools/spec
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { readProfile } from '../aesthetic.js';
import { DesignLibraryError, inheritedAntiPatterns, readDesignManifest } from '../design.js';
import type { CriterionAssertion, EvidenceKind, TaskPack } from '../model.js';
import { ASSERTION_MATCHERS, DIMENSIONS, DIMENSION_LABELS, EVIDENCE_KINDS } from '../model.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { ensureShared } from '../scaffold.js';
import type { CriterionInput, Issue, ValidationResult } from '../spec.js';
import {
  buildTaskPack,
  criteriaByDimension,
  isAntiPatternRefId,
  isDesignRefId,
  isPrincipleRefId,
  normalizeAssertion,
  parseTaskPack,
  renderSpecMarkdown,
  validateTaskPack
} from '../spec.js';
import { readState, updateState } from '../state.js';
import { readTextOrNull, writeTextAtomic } from '../util/fs.js';
import { nowIso, table } from '../util/md.js';
import {
  ArgError,
  arrayOfRecords,
  asRecord,
  optionalEnum,
  optionalString,
  optionalStringArray,
  requiredEnum,
  requiredString
} from './args.js';
import { loadSpec, pathsOf, renderIssues } from './common.js';

const TOOL = 'dwguard_spec';

/** Compact per-dimension summary used in tool output. */
function summaryTable(pack: TaskPack): string {
  const grouped = criteriaByDimension(pack);
  return table(
    ['维度', '条数', 'must'],
    DIMENSIONS.map((dimension) => [
      DIMENSION_LABELS[dimension],
      String(grouped[dimension].length),
      String(grouped[dimension].filter((criterion) => criterion.weight === 'must').length)
    ])
  );
}

function parseCriteria(raw: Record<string, unknown>): CriterionInput[] {
  const rows = arrayOfRecords(raw, 'criteria', TOOL, 64);
  if (rows.length === 0) {
    throw new ArgError(`${TOOL}: \`criteria\` 不能为空；四维验收至少各 1 条。`);
  }
  return rows.map((item, index) => {
    const label = `${TOOL}.criteria[${index}]`;
    const weight = optionalEnum(item, 'weight', ['must', 'should'] as const, label) ?? 'must';
    let assertion: CriterionAssertion | undefined;
    const rawAssertion = item['assertion'];
    if (rawAssertion !== undefined && rawAssertion !== null) {
      const normalized = normalizeAssertion(rawAssertion);
      if (normalized.error !== undefined) throw new ArgError(`${label}.assertion 无效：${normalized.error}`);
      assertion = normalized.assertion;
    }
    const rawRequired = item['requiredEvidence'];
    let requiredEvidence: EvidenceKind[] | undefined;
    if (rawRequired !== undefined && rawRequired !== null) {
      if (!Array.isArray(rawRequired)) throw new ArgError(`${label}.requiredEvidence 必须是数组。`);
      requiredEvidence = [...new Set(rawRequired.map((value): EvidenceKind => {
        if (typeof value !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(value)) {
          throw new ArgError(`${label}.requiredEvidence 含未知类型 \`${String(value)}\`；可选 ${EVIDENCE_KINDS.join(' / ')}。`);
        }
        return value as EvidenceKind;
      }))];
    }
    return {
      id: requiredString(item, 'id', label, 40),
      dimension: requiredEnum(item, 'dimension', DIMENSIONS, label),
      statement: requiredString(item, 'statement', label, 600),
      verify: requiredString(item, 'verify', label, 600),
      weight,
      ruleId: optionalString(item, 'ruleId', label, 60),
      profileRef: optionalString(item, 'profileRef', label, 40),
      designRefs: optionalStringArray(item, 'designRefs', label, 8),
      antiPatternRefs: optionalStringArray(item, 'antiPatternRefs', label, 8),
      principleRefs: optionalStringArray(item, 'principleRefs', label, 8),
      ...(requiredEvidence === undefined ? {} : { requiredEvidence }),
      ...(assertion === undefined ? {} : { assertion })
    };
  });
}

/**
 * Validate `designRefs` against the local design library (0.6.2 P2).
 * A missing/blocked card is a spec-time error; a corrupt library downgrades to
 * a warning so the user can still freeze a pack offline.
 */
async function designRefIssues(
  paths: Awaited<ReturnType<typeof pathsOf>>,
  pack: TaskPack,
  options: Options
): Promise<{
  errors: Issue[];
  warnings: Issue[];
  inherited: Map<string, readonly { ref: string; from: string }[]>;
}> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let manifest: Awaited<ReturnType<typeof readDesignManifest>>;  try {
    manifest = await readDesignManifest(paths);
  } catch (error) {
    if (!(error instanceof DesignLibraryError)) throw error;
    if (
      pack.criteria.some(
        (criterion) =>
          (criterion.designRefs?.length ?? 0) > 0 ||
          (criterion.antiPatternRefs?.length ?? 0) > 0 ||
          (criterion.principleRefs?.length ?? 0) > 0
      )
    ) {
      warnings.push({
        code: 'W_DESIGN_LIBRARY_UNREADABLE',
        message: `设计库不可读（${error.message}），本轮无法校验 designRefs / antiPatternRefs / principleRefs；修好库后重跑 \`dwguard_spec\` 复检。`
      });
    }
    return { errors, warnings, inherited: new Map() };
  }
  if (manifest === null) {
    for (const criterion of pack.criteria) {
      if ((criterion.designRefs?.length ?? 0) > 0) {
        errors.push({
          code: 'E_DESIGN_LIBRARY_MISSING',
          message: `判据 \`${criterion.id}\` 引用了设计参考，但设计库还没初始化；先 \`dwguard_design\` 的 \`library init\` + \`library ingest\`。`,
          criterionId: criterion.id
        });
      }
      if ((criterion.antiPatternRefs?.length ?? 0) > 0) {
        errors.push({
          code: 'E_ANTIPATTERN_LIBRARY_MISSING',
          message: `判据 \`${criterion.id}\` 引用了反模式，但设计库还没初始化；先 \`dwguard_design\` 的 \`library init\` + \`library ingest\`。`,
          criterionId: criterion.id
        });
      }
      if ((criterion.principleRefs?.length ?? 0) > 0) {
        errors.push({
          code: 'E_PRINCIPLE_LIBRARY_MISSING',
          message: `判据 \`${criterion.id}\` 引用了设计原则，但设计库还没初始化；先 \`dwguard_design\` 的 \`library init\` + \`library ingest\`。`,
          criterionId: criterion.id
        });
      }
    }
    return { errors, warnings, inherited: new Map() };
  }
  const cards = new Map(manifest.cards.map((card) => [card.id, card]));
  const inherited = new Map<string, Array<{ ref: string; from: string }>>();
  for (const criterion of pack.criteria) {
    for (const ref of criterion.designRefs ?? []) {
      if (!isDesignRefId(ref)) continue; // format error already reported
      const card = cards.get(ref);
      if (card === undefined) {
        errors.push({
          code: 'E_DESIGN_REF_UNKNOWN',
          message: `判据 \`${criterion.id}\` 引用的设计参考 \`${ref}\` 不存在；先 ingest 该卡片或换一个 ref。`,
          criterionId: criterion.id
        });
      } else if (card.status !== 'active') {
        errors.push({
          code: 'E_DESIGN_REF_BLOCKED',
          message: `判据 \`${criterion.id}\` 引用的设计参考 \`${ref}\` 已被 block，不能作为验收依据。`,
          criterionId: criterion.id
        });
      } else if (options.designLicenseRequired && card.source.license.toLowerCase() === 'unknown') {
        warnings.push({
          code: 'W_DESIGN_REF_LICENSE',
          message: `判据 \`${criterion.id}\` 引用的设计参考 \`${ref}\` license 未知；报告里会标注来源风险。`,
          criterionId: criterion.id
        });
      }
    }
    for (const ref of criterion.antiPatternRefs ?? []) {
      if (!isAntiPatternRefId(ref)) continue; // format error already reported
      const card = cards.get(ref);
      if (card === undefined) {
        errors.push({
          code: 'E_ANTIPATTERN_REF_UNKNOWN',
          message: `判据 \`${criterion.id}\` 引用的反模式 \`${ref}\` 不存在；先在 \`library inbox\` 里 ingest 该反模式卡。`,
          criterionId: criterion.id
        });
      } else if (card.status !== 'active') {
        errors.push({
          code: 'E_ANTIPATTERN_REF_BLOCKED',
          message: `判据 \`${criterion.id}\` 引用的反模式 \`${ref}\` 已被 block，不能作为验收依据。`,
          criterionId: criterion.id
        });
      }
    }
    for (const ref of criterion.principleRefs ?? []) {
      if (!isPrincipleRefId(ref)) continue; // format error already reported
      const card = cards.get(ref);
      if (card === undefined) {
        errors.push({
          code: 'E_PRINCIPLE_REF_UNKNOWN',
          message: `判据 \`${criterion.id}\` 引用的设计原则 \`${ref}\` 不存在；先在 \`library inbox\` 里 ingest 原则卡。`,
          criterionId: criterion.id
        });
      } else if (card.status !== 'active') {
        errors.push({
          code: 'E_PRINCIPLE_REF_BLOCKED',
          message: `判据 \`${criterion.id}\` 引用的设计原则 \`${ref}\` 已被 block，不能作为验收依据。`,
          criterionId: criterion.id
        });
      } else if (!isPrincipleRefId(card.id)) {
        errors.push({
          code: 'E_PRINCIPLE_REF_KIND',
          message: `判据 \`${criterion.id}\` 引用的 \`${ref}\` 不是原则卡；原则引用只能指向 kind=principle 的卡片。`,
          criterionId: criterion.id
        });
      }
    }
    // 0.6.5: a referenced design card inherits its own antiPatterns.
    const explicit = new Set(criterion.antiPatternRefs ?? []);
    const inheritedRefs: Array<{ ref: string; from: string }> = [];
    for (const designRef of criterion.designRefs ?? []) {
      const card = cards.get(designRef);
      for (const ref of inheritedAntiPatterns(card)) {
        if (explicit.has(ref)) continue;
        inheritedRefs.push({ ref, from: designRef });
        const anti = cards.get(ref);
        if (anti === undefined) {
          errors.push({
            code: 'E_ANTIPATTERN_INHERITED_UNKNOWN',
            message: `判据 \`${criterion.id}\` 引用的设计参考 \`${designRef}\` 带有反模式 \`${ref}\`，但该反模式卡不存在；先 ingest 它。`,
            criterionId: criterion.id
          });
        } else if (anti.status !== 'active') {
          errors.push({
            code: 'E_ANTIPATTERN_INHERITED_BLOCKED',
            message: `判据 \`${criterion.id}\` 引用的设计参考 \`${designRef}\` 继承的反模式 \`${ref}\` 已被 block，不能作为验收依据。`,
            criterionId: criterion.id
          });
        }
      }
    }
    if (inheritedRefs.length > 0) inherited.set(criterion.id, inheritedRefs);
    if (
      manifest.cards.length > 0 &&
      criterion.dimension === 'aesthetic' &&
      criterion.weight === 'must' &&
      (criterion.designRefs?.length ?? 0) === 0
    ) {
      warnings.push({
        code: 'W_AEST_NO_DESIGN_REF',
        message: `审美 must 判据 \`${criterion.id}\` 没有引用设计参考；库里有 ${manifest.cards.length} 张卡，可用 \`designRefs\` 让审计有可对照的参考。`,
        criterionId: criterion.id
      });
    }
  }
  return { errors, warnings, inherited };
}

/**
 * Create the `dwguard_spec` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createSpecTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_spec',
    description:
      'Freeze or inspect the DwGuard task pack: requirement + implementation spec + four-dimension acceptance criteria (function / aesthetic / performance / accessibility). ' +
      'action=write validates the criteria, scaffolds `.shared/`, and writes `tasks/spec.md` + `tasks/spec.json`; action=validate re-checks a stored pack; action=read prints it. ' +
      '写入前会拒绝不可证伪、缺独立验证方式、缺维度的判据。Use this before any HarmonyOS work is dispatched.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['write', 'read', 'validate'],
        description: 'write: 写入并校验任务包；validate: 复检已存任务包；read: 只读查看。'
      },
      title: { type: 'string', description: '任务标题（2–80 字）。write 时必填。' },
      requirement: { type: 'string', description: '用户需求原话 + 目标（write 时必填，至少 20 字）。' },
      spec: {
        type: 'string',
        description: '实现规格：页面/组件结构、状态流向、关键交互、数据来源（write 时必填，至少 20 字）。'
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: '约束：API 版本、目录、不可改动文件、性能预算等。'
      },
      executor: {
        type: 'string',
        enum: ['auto', 'ide', 'cli'],
        description:
          '执行器：`auto`（默认，IDE 优先，CLI 只在无视觉 must 判据或约束含回归/批量/CI 时介入）| `ide` | `cli`。'
      },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '如 `F-01`、`A-02`、`P-01`、`X-03`。' },
            dimension: {
              type: 'string',
              required: true,
              enum: [...DIMENSIONS],
              description: 'function = 功能，aesthetic = 审美，performance = 性能，accessibility = 无障碍。'
            },
            statement: { type: 'string', required: true, description: '可证伪的判据陈述。' },
            verify: { type: 'string', required: true, description: '独立验证方式（命令 / 截图 / 测量）。' },
            ruleId: {
              type: 'string',
              description:
                '引用的规则 ID：`DW-FN-01`…`DW-A11Y-07`，或别名 `STATE-002` / `AGC-RJ-013` 等。目录见 skill `hmos-acceptance-rubric`。'
            },
            profileRef: {
              type: 'string',
              description:
                '审美档案 ID（0.6.1，如 `AES-RADIUS-01`）：只有审美判据应带；审计会校验档案存在且 active，并把档案值渲染进报告。'
            },
            designRefs: {
              type: 'array',
              items: { type: 'string' },
              description:
                '设计参考卡 ID（0.6.2，如 `DSG-0007`）：只有审美判据应带；写入时校验卡片存在且 active，审计报告会渲染「参考对照」。'
            },
            antiPatternRefs: {
              type: 'array',
              items: { type: 'string' },
              description:
                '反模式卡 ID（0.6.4，如 `AP-0001`）：只有审美判据应带；写入/审计时校验反模式存在且 active，报告渲染「反模式对照」。'
            },
            principleRefs: {
              type: 'array',
              items: { type: 'string' },
              description:
                '设计原则卡 ID（0.6.7，如 `PR-0001`）：只做方向/对照，不直接当硬判据；写入/审计校验原则存在且 active，报告渲染「原则对照」。'
            },
            requiredEvidence: {
              type: 'array',
              items: { type: 'string', enum: [...EVIDENCE_KINDS] },
              description:
                '可选（0.9.6）：这条判据必须有的证据类型。审计时 checks[].evidenceRefs 必须覆盖这些类型；缺失则 pass 降级为 unverified。旧任务包不填则不启用。'
            },
            weight: {
              type: 'string',
              enum: ['must', 'should'],
              description: 'must 是验收闸门，should 是加分项（默认 must）。'
            },
            assertion: {
              type: 'object',
              additionalProperties: false,
              description:
                '可执行断言（可选）：给出后 `dwguard_audit` 会按 matcher 自动复核 checks[].actual，断言不通过却标 pass 的审计会被拒绝。',
              properties: {
                matcher: {
                  type: 'string',
                  required: true,
                  enum: [...ASSERTION_MATCHERS],
                  description:
                    'equals / contains / regex / range / gte / lte / oneOf / present。数值类必须用结构化 actual：{ value, unit?, samples?, aggregation? }；性能断言给 samples + max/p95/mean，不再从自由文本提取数字。'
                },
                expected: {
                  oneOf: [{ type: 'string' }, { type: 'number' }],
                  description:
                    '期望值（equals/contains/regex/gte/lte）；oneOf 用 JSON 数组字符串，如 ["浅色","深色"]；range/present 不需要。'
                },
                min: { type: 'number', description: 'range 的下界（含）。' },
                max: { type: 'number', description: 'range 的上界（含）。' },
                unit: { type: 'string', description: '实测值单位（ms / vp / ratio…），只用于文档展示。' },
                source: { type: 'string', description: '实测值从哪里取，如 `ui layout bounds` / `hdc shell dumpsys`。' }
              }
            }
          }
        },
        description: '验收标准列表；write 时必填，四维至少各 1 条。'
      }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const action = requiredEnum(args, 'action', ['write', 'read', 'validate'] as const, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const now = nowIso();

      if (action === 'write') {
        const title = requiredString(args, 'title', TOOL, 120);
        const requirement = requiredString(args, 'requirement', TOOL, 8000);
        const spec = requiredString(args, 'spec', TOOL, 12000);
        const constraints = optionalStringArray(args, 'constraints', TOOL, 40);
        const executor = optionalEnum(args, 'executor', ['auto', 'ide', 'cli'] as const, TOOL) ?? 'auto';

        const state = await readState(paths, now);
        const existing = parseTaskPack(await readTextOrNull(paths.specJson));
        const specVersion = state.specVersion + 1;
        let criteria: CriterionInput[];
        try {
          criteria = parseCriteria(args);
        } catch (error) {
          if (error instanceof ArgError) {
            return fail(`任务包 v${specVersion} 未写入：${error.message}`, {
              next: '修正 criteria（含 assertion）后重新调用 `dwguard_spec`（action: write）。'
            });
          }
          throw error;
        }
        const pack = buildTaskPack(
          { title, requirement, spec, constraints, criteria, executor },
          {
            iteration: state.iteration,
            specVersion,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
          }
        );
        const profile = await readProfile(paths);
        const validation = validateTaskPack(pack, options, profile);
        const design = await designRefIssues(paths, pack, options);
        const merged: ValidationResult = {
          errors: [...validation.errors, ...design.errors],
          warnings: [...validation.warnings, ...design.warnings]
        };
        if (merged.errors.length > 0) {
          return fail(`任务包 v${specVersion} 未写入：${merged.errors.length} 个缺口必须先补。`, {
            detail: renderIssues(merged),
            next: '按上面的缺口修正后，再次调用 `dwguard_spec`（action: write）。'
          });
        }

        const created = await ensureShared(paths);
        await writeTextAtomic(paths.specJson, `${JSON.stringify(pack, null, 2)}\n`);
        await writeTextAtomic(paths.specMd, renderSpecMarkdown(pack, paths, design.inherited));
        await updateState(paths, now, (current) => ({
          ...current,
          specVersion,
          roundDispatches: 0,
          roundAudits: 0,
          roundDesignSearches: 0,
          phase: 'spec'
        }));

        const must = pack.criteria.filter((criterion) => criterion.weight === 'must').length;
        return ok(`任务包 v${specVersion} 已冻结：${pack.criteria.length} 条判据（must ${must}）。`, {
          detail: [
            summaryTable(pack),
            '',
            validation.warnings.length > 0 ? renderIssues({ errors: [], warnings: merged.warnings }) : '没有提醒。'
          ].join('\n'),
          files: [displayPath(paths, paths.specMd), displayPath(paths, paths.specJson), ...created],
          next: '用 `dwguard_prereview` 做派发前对抗预审（性能 / 生命周期 / 并发 / API 兼容 + 四维可行性）。'
        });
      }

      const { pack, validation } = await loadSpec(paths, options);
      if (pack === null) {
        return fail('还没有任务包。', {
          next: '调用 `dwguard_spec`（action: write）写入需求、规格与四维验收标准。'
        });
      }
      if (validation === null) {
        return fail('任务包无法解析。', { next: '重新写入任务包。' });
      }
      const issues = renderIssues(validation);
      const detail = [summaryTable(pack), issues.length > 0 ? `\n${issues}` : ''].join('\n').trim();
      const files = [displayPath(paths, paths.specMd)];
      if (action === 'validate' && validation.errors.length > 0) {
        return fail(`任务包 v${pack.specVersion} 校验未通过：${validation.errors.length} 个错误。`, {
          detail,
          files,
          next: '修正缺口后重新 `dwguard_spec`（action: write）。'
        });
      }
      return ok(
        action === 'validate'
          ? `任务包 v${pack.specVersion} 校验通过（${validation.warnings.length} 条提醒）。`
          : `任务包 v${pack.specVersion}：${pack.criteria.length} 条判据。`,
        {
          detail,
          files,
          next:
            validation.errors.length === 0
              ? '用 `dwguard_prereview` 做派发前预审，然后 `dwguard_dispatch`。'
              : '修正缺口后重新 `dwguard_spec`（action: write）。'
        }
      );
    },
    presentCall(args) {
      const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
      const action = typeof record['action'] === 'string' ? record['action'] : 'write';
      return presentCall(`Task pack · ${action}`, action === 'read' ? 'read' : 'edit', args);
    }
  });
}
