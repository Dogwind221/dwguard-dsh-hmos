/**
 * First-use scaffolding of `.shared/`.
 *
 * @module dwguard-dsh-hmos/scaffold
 */

import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { ensureDir, fileExists, writeTextAtomic } from './util/fs.js';

const PROTOCOL_README = `# .shared · DSH ↔ DevEco Code 协作协议

本目录由 **DwGuard-Dsh-Hmos** 维护。两个 Agent 只通过这里的文件协作，不共享上下文。

## 所有权

| 路径 | 谁写 | 说明 |
| --- | --- | --- |
| \`tasks/spec.md\` / \`tasks/spec.json\` | DSH | 冻结的任务包，执行者只读 |
| \`tasks/goal-brief.md\` | DSH | 粘贴给 DevEco Code Goal 模式的简报 |
| \`tasks/design-brief.md\` | DSH | 设计参考简报（0.6.2；dispatch 自动引用） |
| \`tasks/rework-<n>.md\` | DSH | 审计未通过时的返工单 |
| \`tasks/question.md\` | DevEco Code | 需求确实模糊时的提问，DSH 回答后删除或追加答复 |
| \`artifacts/prereview-<n>.md\` | DSH | 派发前对抗预审记录 |
| \`artifacts/audit-<n>.md\` | DSH | 外部审计记录（含独立证据） |
| \`artifacts/acceptance-report.md\` | DSH | 通过后的验收报告 |
| \`design-library/\` | DSH | 设计参考库（卡片 / 索引 / 只读 query.mjs；DevEco 可读） |
| \`outbox-dsh.md\` | DSH | DSH → DevEco Code 的消息 |
| \`outbox-deveco.md\` | DevEco Code | DevEco Code → DSH 的交付记录 |
| \`knowledge/<topic>.md\` | DSH | 沉淀的决策 / 模式 / 返工教训 / 偏好 / 风险 |
| \`state.json\` | DSH | 计数器与游标，不要手改 |

## 记录格式（两个 outbox 通用，协议 v2）

每条记录以 \`## [ISO 时间] <kind> · #<id> · from=<dsh|deveco> to=<dsh|deveco> · re=#<id>? | 标题\`
开头，正文用项目符号；只追加，不改写历史。\`kind\` 取
\`dispatch | ack | deliver | question | answer | blocked | shadow-risk | rework | inspiration | design-request\`。

\`\`\`markdown
## [2026-10-30T12:00:00.000Z] deliver · #a-1 · from=deveco to=dsh · re=#d-1 | 第 1 轮交付
- 状态: 完成
- 变更文件: entry/src/main/ets/pages/Index.ets
- 构建: hvigorw assembleHap → BUILD SUCCESSFUL
- 自验: F-01 <证据>；A-01 <截图路径>
- 未解决: 无
\`\`\`

回执：收到 \`dispatch #d-N\` 后先回一条 \`ack · #a-N · re=#d-N\`（或直接回 \`deliver\`，带 \`re=#d-N\`）。
没有 \`re=\` 的记录不算回执，\`dwguard_status\` 会把它列进「未回执派发」。

## 阶段

\`intake → spec → prereview → ready → dispatched → audit → rework / accepted\`

阶段由 DSH 的 \`dwguard_status\` 根据目录里的产物推导，不靠口头声明。
`;

/**
 * Create the protocol tree and the baseline files when missing.
 * @param paths - resolved protocol layout.
 * @returns the workspace-relative files created or confirmed.
 */
export async function ensureShared(paths: SharedPaths): Promise<string[]> {
  await ensureDir(paths.tasksDir);
  await ensureDir(paths.artifactsDir);
  await ensureDir(paths.knowledgeDir);
  const touched: string[] = [
    displayPath(paths, paths.tasksDir),
    displayPath(paths, paths.artifactsDir),
    displayPath(paths, paths.knowledgeDir)
  ];
  const press = async (file: string, content: string): Promise<void> => {
    if (await fileExists(file)) return;
    await writeTextAtomic(file, content);
    touched.push(displayPath(paths, file));
  };
  await press(paths.outboxDsh, '# DSH → DevEco Code\n\n');
  await press(paths.outboxDeveco, '# DevEco Code → DSH\n\n');
  await press(`${paths.shared}/README.md`, PROTOCOL_README);
  return touched;
}
