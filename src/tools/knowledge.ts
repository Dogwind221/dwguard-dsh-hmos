/**
 * `dwguard_knowledge` — sediment this round's lessons.
 *
 * @module dwguard-dsh-hmos/tools/knowledge
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import type { KnowledgeEntryInput, KnowledgeKind } from '../knowledge.js';
import { appendKnowledge, isKnowledgeKind } from '../knowledge.js';
import {
  getSop,
  knowledgeCounts,
  searchEngineering,
  searchSops,
  type EngineeringEntry,
  type SopEntry
} from '../sop.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nowIso } from '../util/md.js';
import { ArgError, arrayOfRecords, asRecord, optionalEnum, optionalInt, optionalString, requiredString } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_knowledge';
const KINDS: readonly KnowledgeKind[] = ['decision', 'pattern', 'rework', 'preference', 'risk'];
const ACTIONS = ['sediment', 'sops', 'sop', 'engineering'] as const;

function sopDetail(sop: SopEntry): string {
  return [
    `### ${sop.id} · ${sop.title}`,
    '',
    `- 阶段：\`${sop.phase}\``,
    `- 目的：${sop.purpose}`,
    '',
    '**输入**',
    ...sop.inputs.map((item) => `- ${item}`),
    '',
    '**步骤**',
    ...sop.steps.map((item, index) => `${index + 1}. ${item}`),
    '',
    '**门禁**',
    ...sop.gate.map((item) => `- ${item}`),
    '',
    '**证据**',
    ...sop.evidence.map((item) => `- ${item}`),
    '',
    `关联知识：${sop.rules.map((id) => `\`${id}\``).join('、')}`
  ].join('\n');
}

function engineeringDetail(entry: EngineeringEntry): string {
  return [
    `### ${entry.id} · ${entry.title}`,
    '',
    `- topic：\`${entry.topic}\``,
    `- 结论：${entry.statement}`,
    `- 为什么：${entry.why}`,
    `- 怎么检查：${entry.check}`,
    `- 规则：${entry.rules.map((id) => `\`${id}\``).join('、')}`
  ].join('\n');
}

function parseEntries(raw: Record<string, unknown>): KnowledgeEntryInput[] {
  const rows = arrayOfRecords(raw, 'entries', TOOL, 32);
  if (rows.length === 0) throw new ArgError(`${TOOL}: \`entries\` 不能为空。`);
  return rows.map((item, index) => {
    const label = `${TOOL}.entries[${index}]`;
    const kind = requiredString(item, 'kind', label, 20);
    if (!isKnowledgeKind(kind) || !KINDS.includes(kind)) {
      throw new ArgError(`${TOOL}: \`kind\` 只能是 ${KINDS.map((value) => `\`${value}\``).join(' / ')}。`);
    }
    return {
      topic: requiredString(item, 'topic', label, 60),
      kind,
      statement: requiredString(item, 'statement', label, 800),
      evidence: optionalString(item, 'evidence', label, 800)
    };
  });
}

/**
 * Create the `dwguard_knowledge` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createKnowledgeTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_knowledge',
    description:
      'Knowledge/SOP library. `action:"sediment"` (default) appends durable lessons to `.shared/knowledge/<topic>.md`; ' +
      '`action:"sops"` searches the bundled 14 SOPs by query/phase; `action:"sop"` prints one SOP; ' +
      '`action:"engineering"` searches the bundled 32 engineering facts. Lessons dedupe by kind + statement.',
    parameters: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'sediment / sops / sop / engineering（默认 sediment）。'
      },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topic: {
              type: 'string',
              required: true,
              description: '知识主题（文件名词干），如 `arkui-state`、`acceptance-style`。'
            },
            kind: {
              type: 'string',
              required: true,
              enum: [...KINDS],
              description: 'decision / pattern / rework / preference / risk。'
            },
            statement: { type: 'string', required: true, description: '一句话结论（可执行、可复用）。' },
            evidence: { type: 'string', description: '证据：任务包判据 ID、审计编号、截图或日志。' }
          }
        },
        description: 'sediment：一条或多条经验；其他 action 不需要。'
      },
      query: { type: 'string', description: 'sops/engineering：检索词（如 `签名`、`无障碍`）。' },
      sopId: { type: 'string', description: 'sop：SOP id，如 `SOP-06`。' },
      phase: { type: 'string', description: 'sops：按阶段过滤，如 `build` / `accessibility` / `release`。' },
      limit: { type: 'number', description: 'sops/engineering：返回条数（默认 5/8）。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const action = optionalEnum(args, 'action', ACTIONS, TOOL) ?? 'sediment';
      const counts = knowledgeCounts();

      if (action === 'sop') {
        const id = requiredString(args, 'sopId', TOOL, 20);
        const sop = getSop(id);
        if (sop === undefined) {
          return fail(`没有 ${id}；可用：${searchSops('', undefined, 20).map((item) => item.id).join('、')}。`);
        }
        return ok(`${sop.id} · ${sop.title}`, {
          detail: sopDetail(sop),
          next: '把步骤/门禁写进任务包或预审；不要只把 SOP 标题贴进 brief。'
        });
      }

      if (action === 'sops') {
        const query = optionalString(args, 'query', TOOL, 200) ?? '';
        const phase = optionalString(args, 'phase', TOOL, 40);
        const limit = optionalInt(args, 'limit', 5, TOOL, 1, 20);
        const sops = searchSops(query, phase, limit);
        return ok(sops.length === 0 ? '没有匹配的 SOP。' : `命中 ${sops.length} 个 SOP（库内 ${counts.sops} 个）。`, {
          detail:
            sops.length === 0
              ? '换关键词，或先不按 phase 过滤。'
              : sops.map((sop) => `- \`${sop.id}\`（${sop.phase}）${sop.title}：${sop.purpose}`).join('\n'),
          next: '用 `action:"sop"` + `sopId` 取完整步骤/门禁/证据。'
        });
      }

      if (action === 'engineering') {
        const query = optionalString(args, 'query', TOOL, 200) ?? '';
        const limit = optionalInt(args, 'limit', 8, TOOL, 1, 32);
        const entries = searchEngineering(query, limit);
        return ok(entries.length === 0 ? '没有匹配的工程知识。' : `命中 ${entries.length} 条工程知识（库内 ${counts.entries} 条）。`, {
          detail:
            entries.length === 0
              ? '换关键词，如 `签名`、`深色`、`LazyForEach`。'
              : entries.map((entry) => engineeringDetail(entry)).join('\n\n'),
          next: '把关联规则写进判据的 `ruleId`；把检查方法写进 `verify`。'
        });
      }

      const entries = parseEntries(args);
      const now = nowIso();
      await ensureShared(paths);
      const result = await appendKnowledge(paths, entries, now);
      const lines: string[] = [];
      if (result.added.length > 0) {
        lines.push('**新增**', '');
        for (const record of result.added) lines.push(`- \`${record.topic}\`（${record.kind}）：${record.statement}`);
        lines.push('');
      }
      if (result.skipped.length > 0) {
        lines.push('**已存在，跳过**', '');
        for (const record of result.skipped) lines.push(`- \`${record.topic}\`：${record.statement}`);
      }
      const detail = lines.join('\n').trim() || '没有可写入的条目。';
      const files = [
        ...result.files,
        ...(result.added.length > 0 ? [displayPath(paths, paths.knowledgeIndex)] : [])
      ];
      return result.added.length > 0
        ? ok(`已沉淀 ${result.added.length} 条知识（跳过 ${result.skipped.length} 条重复）。`, {
            detail,
            files,
            next: '开始下一轮需求：新需求会开启新的任务包版本。'
          })
        : fail('没有新增：全部条目都在知识库里。', { detail, files: result.files });
    },
    presentCall(args) {
      return presentCall('Knowledge · 沉淀经验', 'edit', args);
    }
  });
}
