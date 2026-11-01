/**
 * `dwguard_shadow` — one shadow-review round during DevEco's execution.
 *
 * Increment ② in the framework is a *parallel, read-only* reviewer: it scans the
 * code and, when available, records the structured UI tree, then reports risks
 * without touching the app. `dwguard_status` nudges when the last round is older
 * than `shadowIntervalMinutes`, which is what makes the review "continuous"
 * without a background process.
 *
 * @module dwguard-dsh-hmos/tools/shadow
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { appendOutboxDsh } from '../dispatch.js';
import { captureHarmonyUiTree } from '../deveco.js';
import { displayPath } from '../paths.js';
import { fail, ok, presentCall, renderResult, RESULT_SCHEMA, type ToolResult } from '../result.js';
import { describeUiTree, runShadow } from '../shadow.js';
import { collectSnapshot } from '../status.js';
import { writeTextAtomic } from '../util/fs.js';
import { nowIso, table } from '../util/md.js';
import { asRecord, optionalBoolean, optionalString } from './args.js';
import { pathsOf } from './common.js';

const TOOL = 'dwguard_shadow';

/**
 * Create the `dwguard_shadow` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createShadowTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult> {
  return defineTool<unknown, ToolResult>({
    name: 'dwguard_shadow',
    description:
      'Run one shadow-review round while DevEco is coding (read-only). Scans the workspace for ArkTS/ArkUI risks, optionally records a structured UI-tree dump (`uiTree`, relative to `.shared/`), writes `artifacts/shadow-<n>.json`, and appends a `shadow-risk` record when must-level hits exist. ' +
      'DevEco 编码期间每 5–10 分钟跑一次；结构性风险立即停线，实现层风险记进返工项。',
    parameters: {
      uiTree: {
        type: 'string',
        description: 'UI 树文件，相对 `.shared/` 的路径（`harmony_ui_tree` 的 JSON 或缩进树文本）。'
      },
      autoUiTree: {
        type: 'boolean',
        description: '未给 `uiTree` 时是否尝试自动调用宿主里的 `harmony_ui_tree`（默认 true，失败静默）。'
      },
      note: { type: 'string', description: '本轮观察说明（可选）。' },
      notify: {
        type: 'boolean',
        description: '有 must 级命中时是否写一条 `shadow-risk` 到 outbox（默认 true）。'
      }
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ToolResult> {
      const args = asRecord(rawArgs, TOOL);
      const paths = await pathsOf(exec, { options, ctx }, TOOL);
      const now = nowIso();
      const snapshot = await collectSnapshot(paths, options, now);
      if (snapshot.phase !== 'dispatched' && snapshot.phase !== 'rework') {
        return fail(`影子审查只在执行期跑；当前阶段「${snapshot.phase}」不适合。`, {
          next: '等 `dwguard_dispatch` 之后（dispatched / rework）再调用。'
        });
      }
      const uiTree = optionalString(args, 'uiTree', TOOL, 400);
      const autoUiTree = optionalBoolean(args, 'autoUiTree', true);
      const note = optionalString(args, 'note', TOOL, 600) ?? '';
      const notify = optionalBoolean(args, 'notify', true);
      // Incremental: only files touched since the last round (with a 5s buffer
      // for filesystem timestamp granularity).
      const lastShadow = snapshot.state.lastShadowAt === undefined ? NaN : Date.parse(snapshot.state.lastShadowAt);
      const sinceMs = Number.isNaN(lastShadow) ? undefined : Math.max(0, lastShadow - 5000);

      // Direct integration: pull the tree from the host's `harmony_ui_tree`
      // when available; a manual `uiTree` path always wins.
      let treePath = uiTree;
      let autoCaptured = false;
      if (treePath === undefined && autoUiTree) {
        const captured = await captureHarmonyUiTree(ctx, exec);
        if (captured !== null) {
          const isJson = (() => {
            try {
              JSON.parse(captured);
              return true;
            } catch {
              return false;
            }
          })();
          const name = `ui-tree-${Date.now()}.${isJson ? 'json' : 'txt'}`;
          await writeTextAtomic(`${paths.artifactsDir}/${name}`, captured);
          treePath = `artifacts/${name}`;
          autoCaptured = true;
        }
      }

      let result;
      try {
        result = await runShadow(paths, snapshot.phase, treePath, note, now, sinceMs);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const { report, file } = result;

      // Only new must-level risks go to the outbox: a coding session runs this
      // every few minutes and the same finding must not be re-sent each time.
      if (notify && report.newRisks.length > 0) {
        const risks = report.newRisks
          .slice(0, 8)
          .map((hit) => `- \`${hit.ruleId}\` ${hit.file}:${hit.line} — ${hit.message}`)
          .join('\n');
        await appendOutboxDsh(
          paths,
          `影子审查 #${report.index} · 新增 ${report.newRisks.length} 条 must 风险`,
          `只读巡检新增 ${report.newRisks.length} 条 must 级风险（此前未报）：\n\n${risks}\n\n记录：\`${displayPath(paths, file)}\``,
          now,
          { kind: 'shadow-risk', id: `s-${report.index}`, from: 'dsh', to: 'deveco' }
        );
      }

      const rows = report.hits.slice(0, 12).map((hit) => [
        `\`${hit.ruleId}\``,
        hit.severity,
        `${hit.file}:${hit.line}`,
        hit.message
      ]);
      const detail = [
        `阶段：${report.phase} · 文件 ${report.files} 个 · must ${report.must} / warn ${report.warn}（新增 ${report.newRisks.length}）`,
        report.uiTree === undefined
          ? autoCaptured
            ? 'UI 树：自动抓取失败，本轮只做静态扫描。'
            : ''
          : `UI 树${autoCaptured ? '（自动抓取）' : ''}：${describeUiTree(report.uiTree, paths)}`,
        '',
        rows.length === 0 ? '本轮没有命中已知规则。' : table(['规则', '级别', '位置', '问题'], rows),
        report.hits.length > rows.length ? `\n（仅列前 ${rows.length} 条，完整见 JSON。）` : ''
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      return ok(
        `影子审查 #${report.index}：must ${report.must} / warn ${report.warn}（新增 ${report.newRisks.length}）`,
        {
          detail,
          files: [displayPath(paths, file)],
          next:
            report.newRisks.length > 0
              ? '把新增 must 级风险反馈给 DevEco（停线或记返工项）；修完再跑一轮。'
              : report.must > 0
                ? '历史 must 级风险还在，但本轮没有新增；确认 DevEco 是否已修复。'
                : '继续观察：DevEco 编码期间每 5–10 分钟跑一次。'
        }
      );
    },
    presentCall(args) {
      return presentCall('Shadow review · 只读巡检', 'read', args);
    }
  });
}
