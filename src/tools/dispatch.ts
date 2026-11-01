/**
 * `dwguard_dispatch` — build the Goal-mode brief and hand the pack over.
 *
 * @module dwguard-dsh-hmos/tools/dispatch
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { appendOutboxDsh, renderDispatchEntry, renderGoalBrief } from '../dispatch.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import type { PrereviewReport } from '../review.js';
import { ensureShared } from '../scaffold.js';
import { readLatestJson, readState, updateState } from '../state.js';
import { writeTextAtomic } from '../util/fs.js';
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
      const brief = renderGoalBrief(pack, paths, counter);
      await ensureShared(paths);
      await writeTextAtomic(paths.briefMd, brief);
      await appendOutboxDsh(
        paths,
        `dispatch #${counter} · 第 ${pack.iteration} 轮 · 任务包 v${pack.specVersion}`,
        `${renderDispatchEntry(pack, paths, counter)}${note === undefined ? '' : `\n\n备注：${note}`}`,
        now,
        { kind: 'dispatch', id: `d-${counter}`, from: 'dsh', to: 'deveco' }
      );
      await updateState(paths, now, (current) => ({
        ...current,
        dispatches: current.dispatches + 1,
        roundDispatches: (current.roundDispatches ?? 0) + 1,
        phase: 'dispatched'
      }));

      return ok(`已派发第 ${counter} 次：任务包 v${pack.specVersion}，${pack.criteria.length} 条判据。`, {
        detail: brief,
        files: [displayPath(paths, paths.briefMd), displayPath(paths, paths.outboxDsh)],
        next: '把上面简报粘进 DevEco Code 的 Goal 模式；交付后运行 `dwguard_status` 看 outbox 新记录，再 `dwguard_audit` 独立取证。'
      });
    },
    presentCall(args) {
      return presentCall('Dispatch · 生成 Goal 简报', 'edit', args);
    }
  });
}
