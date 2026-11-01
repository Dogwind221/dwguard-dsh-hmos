/**
 * Dispatch: the Goal-mode brief for DevEco Code and the outbox protocol.
 *
 * `outbox-dsh.md` is DSH → DevEco Code; `outbox-deveco.md` is DevEco Code →
 * DSH. Both are append-only, and every entry starts with `## [` so the reader
 * can count entries and resume from a cursor.
 *
 * @module dwguard-dsh-hmos/dispatch
 */

import type { TaskPack } from './model.js';
import { DIMENSIONS, DIMENSION_EVIDENCE, DIMENSION_LABELS } from './model.js';
import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import { appendText, readTextOrNull } from './util/fs.js';
import { bullets, table } from './util/md.js';
import { criteriaByDimension } from './spec.js';

/** Message kinds carried by the outbox protocol. */
export type OutboxKind =
  | 'dispatch'
  | 'ack'
  | 'deliver'
  | 'question'
  | 'answer'
  | 'blocked'
  | 'shadow-risk'
  | 'rework';

/** Envelope attached to an outbox entry, v2 protocol. */
export interface OutboxMeta {
  readonly kind: OutboxKind;
  /** Unique message id, e.g. `d-3`, `a-1`, `q-2`. */
  readonly id: string;
  readonly from: 'dsh' | 'deveco';
  readonly to: 'dsh' | 'deveco';
  /** Id of the message this one answers, e.g. `d-3`. */
  readonly replyTo?: string;
}

/** One parsed outbox entry. */
export interface OutboxEntry {
  /** Zero-based position in the file. */
  readonly index: number;
  /** Text after `## `, e.g. `[2026-10-30T…] deliver · #d-3 · … | 交付` . */
  readonly header: string;
  /** Entry body without the header line. */
  readonly body: string;
  /** Envelope fields; absent on legacy entries written before protocol v2. */
  readonly kind?: OutboxKind;
  readonly id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly replyTo?: string;
}

const ENVELOPE = /^(dispatch|ack|deliver|question|answer|blocked|shadow-risk|rework)\s+·\s+#([\w.-]+)\s+·\s+from=(dsh|deveco)\s+to=(dsh|deveco)(?:\s+·\s+re=#([\w.-]+))?(?:\s*\|\s*(.*))?$/i;

/**
 * Parse an outbox file into entries.
 * @param text - raw file content, or `null` when the file does not exist.
 */
export function parseOutbox(text: string | null): OutboxEntry[] {
  if (text === null) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entries: Array<{ header: string; body: string[] }> = [];
  let current: { header: string; body: string[] } | null = null;
  let preamble: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current !== null) entries.push(current);
      current = { header: line.slice(3).trim(), body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
    else preamble.push(line);
  }
  if (current !== null) entries.push(current);
  if (entries.length === 0) {
    // A fresh outbox holds only its `# ...` title: nothing has been delivered.
    // Deliveries are `## ` records, so heading lines never count as content.
    const rest = preamble
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .trim();
    if (rest.length === 0) return [];
    return [{ index: 0, header: '（未使用标准标题的整段内容）', body: rest }];
  }
  return entries.map((entry, index) => {
    const body = entry.body.join('\n').trim();
    // The header is `[ISO] <envelope> | <title>`; the timestamp is not part of
    // the envelope, so strip it before matching.
    const match = ENVELOPE.exec(entry.header.replace(/^\[[^\]]*\]\s*/, ''));
    if (match === null) return { index, header: entry.header, body };
    const [, kind, id, from, to, replyTo] = match;
    return {
      index,
      header: entry.header,
      body,
      kind: kind?.toLowerCase() as OutboxKind,
      id,
      from,
      to,
      ...(replyTo === undefined ? {} : { replyTo })
    };
  });
}

/** Render one outbox entry, ready to append. */
export function renderOutboxEntry(title: string, body: string, now: string, meta?: OutboxMeta): string {
  const head =
    meta === undefined
      ? title
      : `${meta.kind} · #${meta.id} · from=${meta.from} to=${meta.to}` +
        `${meta.replyTo === undefined ? '' : ` · re=#${meta.replyTo}`} | ${title}`;
  return `## [${now}] ${head}\n\n${body.trim()}\n\n`;
}

/** Append an entry to DSH's outbox (DSH → DevEco Code). */
export async function appendOutboxDsh(
  paths: SharedPaths,
  title: string,
  body: string,
  now: string,
  meta?: OutboxMeta
): Promise<void> {
  const existing = await readTextOrNull(paths.outboxDsh);
  const prefix = existing === null ? '# DSH → DevEco Code\n\n' : '';
  await appendText(paths.outboxDsh, `${prefix}${renderOutboxEntry(title, body, now, meta)}`);
}

/**
 * Dispatches that have no reply (ack/deliver/question) referencing their id.
 * @param sent - entries from `outbox-dsh.md`.
 * @param replies - entries from `outbox-deveco.md`.
 * @param sinceDispatchNumber - only count dispatches with `#d-<n>` at or above
 *   this number (the current round), so old rounds stop nagging.
 */
export function unackedDispatches(
  sent: readonly OutboxEntry[],
  replies: readonly OutboxEntry[],
  sinceDispatchNumber = 0
): OutboxEntry[] {
  const answered = new Set(replies.map((entry) => entry.replyTo).filter((id): id is string => id !== undefined));
  return sent.filter((entry) => {
    if (entry.kind !== 'dispatch' || entry.id === undefined) return false;
    if (answered.has(entry.id)) return false;
    const match = /^d-(\d+)$/.exec(entry.id);
    const number = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
    return number >= sinceDispatchNumber;
  });
}

/** Dimension rows shared by the brief and the spec document. */
function criteriaTable(pack: TaskPack): string {
  const grouped = criteriaByDimension(pack);
  const rows: string[][] = [];
  for (const dimension of DIMENSIONS) {
    for (const criterion of grouped[dimension]) {
      rows.push([
        `\`${criterion.id}\``,
        DIMENSION_LABELS[dimension],
        criterion.weight,
        criterion.statement,
        criterion.verify
      ]);
    }
  }
  return table(['判据', '维度', '权重', '判据原文', '验证方式'], rows);
}

/**
 * Render the brief the human pastes into DevEco Code's Goal mode.
 * @param pack - the frozen task pack.
 * @param paths - resolved layout (for the file references in the brief).
 * @param briefCounter - the dispatch number used in the delivery-record template.
 */
export function renderGoalBrief(pack: TaskPack, paths: SharedPaths, briefCounter: number): string {
  const grouped = criteriaByDimension(pack);
  const coverage = DIMENSIONS.map((dimension) => [
    DIMENSION_LABELS[dimension],
    String(grouped[dimension].length),
    DIMENSION_EVIDENCE[dimension]
  ]);
  const shared = displayPath(paths, paths.shared);
  return [
    '# DevEco Code · Goal 模式任务简报',
    '',
    '你是 **DevEco Code（执行者）**，在 DevEco Studio 里完成本简报定义的编码与自检。',
    '**DSH（编排者）** 负责验收：它会独立取证、独立判定，不采信你的自评结论。',
    '任务包已冻结（v' + pack.specVersion + '），你不得修改验收标准。',
    '',
    '## 0. 工作区与协议',
    '',
    `- 工程目录：\`${paths.workspace}\``,
    `- 任务包：\`${displayPath(paths, paths.specMd)}\`（机器可读：\`${displayPath(paths, paths.specJson)}\`）`,
    `- 共享目录：\`${shared}/\``,
    `- 你的交付记录：\`${displayPath(paths, outboxFile(paths))}\`（只能追加）`,
    `- 你的提问文件：\`${displayPath(paths, paths.questionMd)}\`（需求确实模糊时才写）`,
    '',
    '## 1. 本轮目标',
    '',
    pack.requirement.trim(),
    '',
    '## 2. 实现规格',
    '',
    pack.spec.trim(),
    '',
    '## 3. 验收标准（逐条自证，但结论由 DSH 独立复核）',
    '',
    criteriaTable(pack),
    '',
    '维度覆盖与证据类型：',
    '',
    table(['维度', '条数', 'DSH 需要的证据类型'], coverage),
    '',
    '## 4. 约束',
    '',
    bullets(pack.constraints),
    '',
    '## 5. Goal 模式执行闭环',
    '',
    bullets([
      '读任务包与工作区现状，确认没有歧义后再动手；',
      '编码实现，遵守上面的约束；',
      '编译构建，修到零错误（警告也要看）；',
      '推送模拟器或真机，跑通关键路径；',
      '按第 3 节逐条自验，保存命令输出/截图路径；',
      '把交付记录追加到 `outbox-deveco.md`，一条记录对应本轮交付。'
    ]),
    '',
    '## 6. 交付记录格式（追加到 outbox-deveco.md）',
    '',
    '```markdown',
    `## [<ISO 时间>] delivery #${briefCounter} · 第 ${pack.iteration} 轮`,
    '- 状态: 完成 / 部分完成',
    '- 变更文件: entry/src/main/ets/pages/Index.ets, ...',
    '- 构建: hvigorw assembleHap → BUILD SUCCESSFUL',
    '- 自验:',
    '  - F-01: <操作步骤 + 结果>',
    '  - A-01: <截图路径 + 观察结论>',
    '- 未解决: <如有，写清阻塞点>',
    '```',
    '',
    '## 7. 提问协议',
    '',
    `需求实在模糊时，把问题写进 \`${displayPath(paths, paths.questionMd)}\`（一句话问题 + 两个候选方案），暂停相关实现，等 DSH 回复。不要在实现里猜测验收标准。`,
    '',
    '## 8. 禁止事项',
    '',
    bullets([
      '修改 `tasks/spec.md`、降低或删除验收标准；',
      '用「编译通过」「自测通过」替代功能验证；',
      '顺手重构无关代码，扩大返工范围；',
      '在验收标准之外自行加需求（需要加就写进 question.md）。',
      '',
      '完成定义（DoD）：构建通过 + 真机/模拟器跑通 + 第 3 节每条判据都有可复现的证据 + outbox-deveco.md 已更新。',
      `交付记录格式：\`## [时间] deliver · #a-N · from=deveco to=dsh · re=#d-${briefCounter} | 交付摘要\`；`,
      '先回执可写 `ack`（同样带 `re=#d-N`）；不发 `re=` 的记录不算回执，DSH 会一直等。'
    ]),
    ''
  ].join('\n');
}

/** The DevEco outbox path (kept as a helper so the brief and status agree). */
export function outboxFile(paths: SharedPaths): string {
  return paths.outboxDeveco;
}

/** A compact dispatch note for DSH's own outbox. */
export function renderDispatchEntry(
  pack: TaskPack,
  paths: SharedPaths,
  briefCounter: number,
  executor: 'ide' | 'cli' = 'ide'
): string {
  return [
    `任务包 v${pack.specVersion} 已冻结并派发（第 ${briefCounter} 次）。`,
    '',
    `- 简报：\`${displayPath(paths, executor === 'cli' ? paths.cliBriefMd : paths.briefMd)}\``,
    `- 判据：${pack.criteria.length} 条（must ${pack.criteria.filter((criterion) => criterion.weight === 'must').length}）`,
    `- 执行者：${executor === 'cli' ? 'CLI Agent（devecocli）' : 'DevEco Code（Goal 模式）'}`,
    '- 交付方式：追加到 `outbox-deveco.md`，一条记录对应本轮交付'
  ].join('\n');
}

/**
 * The extra section appended to the brief when `executor: cli`.
 * It pins the command surface and keeps visual evidence on DSH's side.
 */
export function renderCliSection(pack: TaskPack): string {
  return [
    '# CLI 执行模式（本轮）',
    '',
    '本轮由 **CLI Agent** 实现；DSH 仍然独立取证、独立判定，不采信你的自评。',
    '',
    '## 1. 命令约定',
    '',
    '用 DevEco CLI 完成构建与运行，不要手写 hvigor 命令：',
    '',
    '- 构建：`devecocli build --modules <module> [--build-mode release]`',
    '- 安装并启动：`devecocli run [--module <module>] [--device <serial|name>]`',
    '- 增量部署：`devecocli run --apply <changes.txt>`（先全量 `run` 一次；清单放工程 `.hvigor/` 下）',
    '- 日志：`devecocli log --level E --crash --tail 100`',
    '- 设备：`devecocli device list`',
    '',
    '把每条命令、退出码和关键输出原样写进交付记录，方便 DSH 复核。',
    '',
    '## 2. 证据边界',
    '',
    '- 截图、UI 树、性能数值由 **DSH 自己**在设备/模拟器上取；',
    '- 你只提交「代码 + 构建/运行日志 + 交付说明」；',
    '- 不要声称"已验证视觉/无障碍"——那是 DSH 的职责。',
    '',
    `## 3. 交付`, 
    '',
    `- 交付记录：追加到 \`outbox-deveco.md\`，格式见上；`,
    `- 判据共 ${pack.criteria.length} 条，逐条写清楚你做了什么、如何自测（自测不等于验收）。`
  ].join('\n');
}
