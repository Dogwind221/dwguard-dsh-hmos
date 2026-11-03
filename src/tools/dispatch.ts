/**
 * `dwguard_dispatch` — build the Goal-mode brief and hand the pack over.
 *
 * @module dwguard-dsh-hmos/tools/dispatch
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { DesignLibraryError, generateDesignBrief, readDesignManifest } from '../design.js';
import { appendOutboxDsh, chooseExecutor, parseOutbox, renderCliSection, renderDispatchEntry, renderGoalBrief } from '../dispatch.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import type { PrereviewReport } from '../review.js';
import { ensureShared } from '../scaffold.js';
import { readLatestJson, readState, updateState } from '../state.js';
import { readTextOrNull, writeTextAtomic } from '../util/fs.js';
import { nowIso } from '../util/md.js';
import { asRecord, optionalString } from './args.js';
import { pathsOf, requireSpec } from './common.js';

const TOOL = 'dwguard_dispatch';

/**
 * Create the `dwguard_dispatch` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createDispatchTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_dispatch',
    description:
      'Generate the DevEco Code Goal-mode brief from the frozen task pack, write `tasks/goal-brief.md`, and append a dispatch record to `outbox-dsh.md`. ' +
      'Refuses to run when the pack is invalid or the pre-review has not passed (unless that gate is disabled in config). ' +
      '返回的 detail 就是可以直接粘贴给 DevEco Code 的简报全文。',
    parameters: {
      note: { type: 'string', description: '本轮派发备注（可选）：给执行者的额外上下文。' }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const note = optionalString(args, 'note', TOOL, 2000);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const pack = await requireSpec(paths, options, TOOL);
      const now = nowIso();

      if (options.requirePrereviewBeforeDispatch) {
        const latest = await readLatestJson<PrereviewReport>(paths.artifactsDir, 'prereview');
        if (latest === null || latest.value.specVersion !== pack.specVersion) {
          return fail(`任务包 v${pack.specVersion} 还没有预审记录，不能派发。`, {
            next: '先用 `dwguard_prereview` 对当前任务包做对抗审查（性能 / 生命周期 / 并发 / API 兼容 + 四维可行性）。'
          });
        }
        if (!latest.value.gate.pass) {
          return fail(`最近一次预审 #${latest.index} 未通过，不能派发。`, {
            detail: latest.value.gate.errors.map((error) => `- ${error}`).join('\n'),
            next: '修订任务包后重跑 `dwguard_prereview`。'
          });
        }
      }

      const state = await readState(paths, now);
      const counter = state.dispatches + 1;
      const executor = chooseExecutor(pack, options);
      const cli = executor === 'cli';

      // 0.6.2 P1: attach a design brief when the library has cards. A broken
      // library must not block the dispatch; the brief then says so explicitly.
      let design: { file: string; cards: Array<{ id: string; title: string; license: string }>; empty?: boolean; error?: string } | undefined;
      let designGenerated = false;
      try {
        const manifest = await readDesignManifest(paths);
        if (manifest !== null && manifest.cards.length > 0) {
          const brief = await generateDesignBrief(paths, options, pack, now);
          designGenerated = true;
          design = {
            file: displayPath(paths, brief.file),
            cards: brief.hits.map((hit) => ({ id: hit.cardId, title: hit.title, license: hit.source.license })),
            empty: brief.hits.length === 0
          };
        }
      } catch (error) {
        if (!(error instanceof DesignLibraryError)) throw error;
        design = { file: '', cards: [], error: error.message };
      }

      const goalBrief = renderGoalBrief(pack, paths, counter, design);
      const brief = cli ? `${goalBrief}\n\n${renderCliSection(pack)}` : goalBrief;
      await ensureShared(paths);
      await writeTextAtomic(paths.briefMd, goalBrief);
      if (cli) await writeTextAtomic(paths.cliBriefMd, brief);
      await appendOutboxDsh(
        paths,
        `dispatch #${counter} · 第 ${pack.iteration} 轮 · 任务包 v${pack.specVersion}`,
        `${renderDispatchEntry(pack, paths, counter, executor)}${note === undefined ? '' : `\n\n备注：${note}`}`,
        now,
        { kind: 'dispatch', id: `d-${counter}`, from: 'dsh', to: 'deveco' }
      );
      if (designGenerated) {
        const sent = parseOutbox(await readTextOrNull(paths.outboxDsh));
        let max = 0;
        for (const entry of sent) {
          const match = /^i-(\d+)$/.exec(entry.id ?? '');
          if (match?.[1] === undefined) continue;
          const value = Number.parseInt(match[1], 10);
          if (Number.isFinite(value) && value > max) max = value;
        }
        await appendOutboxDsh(
          paths,
          `dispatch #${counter} · 设计参考（0.6.2）`,
          [
            `- 简报：\`${displayPath(paths, paths.designBriefMd)}\``,
            `- 卡片：${design === undefined || design.cards.length === 0 ? '（无命中）' : design.cards.map((card) => `\`${card.id}\` ${card.title}`).join('、')}`,
            '- 参考是证据不是判据；实现前先读简报。'
          ].join('\n'),
          now,
          { kind: 'inspiration', id: `i-${max + 1}`, from: 'dsh', to: 'deveco', replyTo: `d-${counter}` }
        );
      }
      await updateState(paths, now, (current) => ({
        ...current,
        dispatches: current.dispatches + 1,
        roundDispatches: (current.roundDispatches ?? 0) + 1,
        phase: 'dispatched'
      }));

      return ok(`已派发第 ${counter} 次：任务包 v${pack.specVersion}，${pack.criteria.length} 条判据。`, {
        detail: brief,
        files: [
          ...(cli
            ? [displayPath(paths, paths.cliBriefMd)]
            : [displayPath(paths, paths.briefMd)]),
          ...(designGenerated ? [displayPath(paths, paths.designBriefMd)] : []),
          displayPath(paths, paths.outboxDsh)
        ],
        next: cli
          ? '把上面简报交给 CLI Agent（它用 `devecocli` 构建/运行）；交付后 `dwguard_status` 看 outbox，再 `dwguard_audit` 独立取证（截图/UI 树由 DSH 自己取）。'
          : '把上面简报粘进 DevEco Code 的 Goal 模式；交付后运行 `dwguard_status` 看 outbox 新记录，再 `dwguard_audit` 独立取证。'
      });
    },
    presentCall(args) {
      return presentCall('Dispatch · 生成 Goal 简报', 'edit', args);
    }
  });
}
