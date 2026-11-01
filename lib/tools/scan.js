/**
 * `dwguard_scan` — independent ArkTS/ArkUI static checks for the audit.
 *
 * Runs over the workspace (read-only), writes `artifacts/scan-<n>.json`, and
 * returns rule-ID findings with file:line evidence. The audit skill folds
 * `must` hits into the delivery findings, so "I read the code" stops being the
 * only code evidence.
 *
 * @module dwguard-dsh-hmos/tools/scan
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { displayPath } from '../paths.js';
import { ok, presentCall, renderResult, RESULT_SCHEMA } from '../result.js';
import { resolveScanRoot, scanWorkspace } from '../scan.js';
import { ensureShared } from '../scaffold.js';
import { nextIndex } from '../state.js';
import { writeTextAtomic } from '../util/fs.js';
import { nowIso, table } from '../util/md.js';
import { asRecord, optionalBoolean, optionalString } from './args.js';
import { pathsOf } from './common.js';
const TOOL = 'dwguard_scan';
/**
 * Create the `dwguard_scan` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export function createScanTool(options, ctx) {
    return defineTool({
        name: 'dwguard_scan',
        description: 'Run independent ArkTS/ArkUI static checks over the workspace (read-only): @State array mutation, any, old @ohos.* imports, V1/V2 mixing, fake OHPM packages, ForEach vs LazyForEach, timer leaks, missing accessibility text. ' +
            'Writes `artifacts/scan-<n>.json` and returns rule-ID hits with file:line. 审计前先跑它，must 级命中要进 `dwguard_audit` 的 findings。',
        parameters: {
            path: {
                type: 'string',
                description: '相对工作区的扫描路径（默认整个工作区）。'
            },
            includeWarnings: {
                type: 'boolean',
                description: '是否包含 warn 级结果（默认 true）。'
            }
        },
        output: { schema: RESULT_SCHEMA, render: renderResult },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, TOOL);
            const requested = optionalString(args, 'path', TOOL, 400);
            const includeWarnings = optionalBoolean(args, 'includeWarnings', true);
            const paths = await pathsOf(exec, { options, ctx }, TOOL);
            const root = resolveScanRoot(paths.workspace, requested);
            const now = nowIso();
            const report = await scanWorkspace(root, includeWarnings, now);
            await ensureShared(paths);
            const index = await nextIndex(paths.artifactsDir, 'scan');
            await writeTextAtomic(`${paths.artifactsDir}/scan-${index}.json`, `${JSON.stringify(report, null, 2)}\n`);
            const top = report.hits.slice(0, 24).map((entry) => [
                `\`${entry.ruleId}\``,
                entry.severity === 'must' ? 'must' : 'warn',
                `${entry.file}:${entry.line}`,
                entry.message
            ]);
            const detail = [
                `扫描 ${report.files} 个文件（\`${displayPath(paths, root)}\`）：must ${report.counts.must} · warn ${report.counts.warn}。`,
                '',
                report.hits.length === 0 ? '未命中已知规则。' : table(['规则', '级别', '位置', '问题'], top),
                report.hits.length > top.length ? `\n（仅列前 ${top.length} 条，完整结果见 JSON。）` : '',
                '',
                report.hits.some((entry) => entry.severity === 'must')
                    ? '**must 级命中不能直接进审计通过**：先修，或写进 `dwguard_audit` 的 findings 并说明为什么可接受。'
                    : '没有 must 级命中；warn 级按需处理。'
            ]
                .filter((line) => line.length > 0)
                .join('\n');
            return ok(`静态扫描：${report.files} 个文件，must ${report.counts.must} / warn ${report.counts.warn}。`, {
                detail,
                files: [displayPath(paths, `${paths.artifactsDir}/scan-${index}.json`)],
                next: report.counts.must > 0
                    ? '把 must 级命中写成审计 findings（带规则 ID 与 file:line），或让 DevEco 修完再扫一次。'
                    : '继续按 `hmos-audit-playbook` 取证：截图 / 布局树 / 日志 / 数值。'
            });
        },
        presentCall(args) {
            return presentCall('Static scan · ArkTS', 'other', args);
        }
    });
}
