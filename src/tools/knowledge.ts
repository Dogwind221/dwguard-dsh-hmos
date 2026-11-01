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
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { ensureShared } from '../scaffold.js';
import { nowIso } from '../util/md.js';
import { ArgError, arrayOfRecords, asRecord, optionalString, requiredString } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_knowledge';
const KINDS: readonly KnowledgeKind[] = ['decision', 'pattern', 'rework', 'preference', 'risk'];

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
      'Append durable lessons to `.shared/knowledge/<topic>.md`: decisions, reusable patterns, rework lessons, user preferences, risks. ' +
      'Exact repeats are skipped (the index dedupes by kind + statement). 用于验收通过后沉淀，或在返工中记录模式。',
    parameters: {
      entries: {
        type: 'array',
        required: true,
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
        }
      }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
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
