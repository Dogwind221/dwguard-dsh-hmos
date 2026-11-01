/**
 * Status: re-derive the workflow phase from the artifacts on disk, show the
 * unread delivery records, and name the one next action.
 *
 * @module dwguard-dsh-hmos/status
 */

import type { Options } from './config.js';
import type { OutboxEntry } from './dispatch.js';
import { parseOutbox, unackedDispatches } from './dispatch.js';
import type { SharedState, TaskPack } from './model.js';
import { DIMENSIONS, DIMENSION_LABELS } from './model.js';
import type { SharedPaths } from './paths.js';
import { displayPath } from './paths.js';
import type { AuditReport, PrereviewReport } from './review.js';
import type { ValidationResult } from './spec.js';
import { criteriaByDimension, parseTaskPack, validateTaskPack } from './spec.js';
import { readLatestJson, readState } from './state.js';
import { readTextOrNull } from './util/fs.js';
import { table, truncate } from './util/md.js';

/** The workflow phase derived from artifacts. */
export type Phase =
  | 'intake'
  | 'spec-invalid'
  | 'prereview'
  | 'ready'
  | 'dispatched'
  | 'rework'
  | 'accepted'
  | 'confirmed';

const PHASE_LABELS: Record<Phase, string> = {
  intake: '待写任务包',
  'spec-invalid': '任务包不合法',
  prereview: '待派发前预审',
  ready: '预审通过，待派发',
  dispatched: '已派发，待交付',
  rework: '审计未通过，待返工',
  accepted: '验收通过，待用户确认',
  confirmed: '用户已确认'
};

const NEXT_ACTION: Record<Phase, string> = {
  intake: '用 `dwguard_spec`（action: write）写任务包：需求 + 规格 + 四维验收标准。',
  'spec-invalid': '按缺口修任务包，再执行 `dwguard_spec`（action: write）重写。',
  prereview: '用 `dwguard_prereview` 做派发前对抗审查（性能 / 生命周期 / 并发 / API 兼容 + 四维验收可行性）。',
  ready: '用 `dwguard_dispatch` 生成 Goal 模式简报，粘贴给 DevEco Code。',
  dispatched: '等 DevEco Code 交付；期间用 `dwguard_shadow` 定期做影子审查；交付后 `dwguard_audit` 独立取证。',
  rework: '把 `tasks/rework-<n>.md` 交给 DevEco Code，重跑 Goal 循环；交付后再次 `dwguard_audit`。',
  accepted: '把验收报告交给用户确认；确认后调 `dwguard_confirm`（accept / new_round），再沉淀经验。',
  confirmed: '本轮已确认。开下一轮用 `dwguard_spec` 写新任务包（迭代号 +1），或结束。'
};

const NEXT_ACTION_EN: Record<Phase, string> = {
  intake: 'Write the task pack with `dwguard_spec` (action: write): requirement + spec + four-dimension criteria.',
  'spec-invalid': 'Fix the task pack gaps, then re-write it with `dwguard_spec` (action: write).',
  prereview: 'Run the adversarial pre-review with `dwguard_prereview` (performance / lifecycle / concurrency / API + acceptance feasibility).',
  ready: 'Generate the brief with `dwguard_dispatch` and hand it to the executor.',
  dispatched: 'Wait for delivery; run `dwguard_shadow` periodically; audit with `dwguard_audit` once delivered.',
  rework: 'Hand `tasks/rework-<n>.md` to the executor, re-run the loop, then `dwguard_audit` again.',
  accepted: 'Take the acceptance report to the user; call `dwguard_confirm` (accept / new_round), then sediment.',
  confirmed: 'Round confirmed. Start the next round with `dwguard_spec` (iteration +1), or stop.'
};

/** Everything `dwguard_status` needs, collected once. */
export interface Snapshot {
  readonly paths: SharedPaths;
  readonly options: Options;
  readonly state: SharedState;
  readonly spec: TaskPack | null;
  readonly validation: ValidationResult | null;
  readonly prereview: { readonly index: number; readonly value: PrereviewReport } | null;
  readonly audit: { readonly index: number; readonly value: AuditReport } | null;
  /** Latest report from an older pack version, kept for "not applicable" display. */
  readonly stalePrereview: number | null;
  readonly staleAudit: number | null;
  readonly outboxEntries: readonly OutboxEntry[];
  readonly outboxSent: readonly OutboxEntry[];
  readonly unacked: readonly OutboxEntry[];
  readonly unread: readonly OutboxEntry[];
  readonly question: string | null;
  readonly phase: Phase;
  readonly nextAction: string;
  /** English rendering of `nextAction` for the panel's language toggle. */
  readonly nextActionEn: string;
}

function derivePhase(
  spec: TaskPack | null,
  validation: ValidationResult | null,
  prereview: PrereviewReport | null,
  audit: AuditReport | null,
  state: SharedState
): Phase {
  if (spec === null) return 'intake';
  // A confirmation with `new_round` bumps the iteration before the next pack is
  // written; the old pack must not keep the round looking "confirmed".
  if (state.iteration > spec.iteration) return 'intake';
  if (validation !== null && validation.errors.length > 0) return 'spec-invalid';
  // Reports are already scoped to the current pack version by collectSnapshot.
  if (prereview === null || !prereview.gate.pass) return 'prereview';
  if (audit !== null && audit.gate.pass) {
    return state.confirmedSpecVersion === spec.specVersion ? 'confirmed' : 'accepted';
  }
  const dispatches = state.roundDispatches ?? state.dispatches;
  const audits = state.roundAudits ?? state.audits;
  if (dispatches > audits) return 'dispatched';
  if (audit !== null && !audit.gate.pass) return 'rework';
  if (dispatches === 0) return 'ready';
  return 'dispatched';
}

/**
 * Collect the current status.
 * @param paths - resolved protocol layout.
 * @param options - resolved options.
 * @param now - ISO timestamp for state repair.
 */
export async function collectSnapshot(paths: SharedPaths, options: Options, now: string): Promise<Snapshot> {
  const state = await readState(paths, now);
  const rawSpec = await readTextOrNull(paths.specJson);
  const spec = parseTaskPack(rawSpec);
  const validation = spec === null ? null : validateTaskPack(spec, options);
  const rawPrereview = await readLatestJson<PrereviewReport>(paths.artifactsDir, 'prereview');
  const rawAudit = await readLatestJson<AuditReport>(paths.artifactsDir, 'audit');
  // Round isolation: a report only counts for the pack version it was written
  // against; otherwise a new round would inherit the previous gate results.
  const prereview =
    rawPrereview !== null && (spec === null || rawPrereview.value.specVersion === spec.specVersion)
      ? rawPrereview
      : null;
  const audit =
    rawAudit !== null && (spec === null || rawAudit.value.specVersion === spec.specVersion) ? rawAudit : null;
  const stalePrereview = prereview === null && rawPrereview !== null ? rawPrereview.index : null;
  const staleAudit = audit === null && rawAudit !== null ? rawAudit.index : null;
  const outboxRaw = await readTextOrNull(paths.outboxDeveco);
  const outboxEntries = parseOutbox(outboxRaw);
  const outboxSent = parseOutbox(await readTextOrNull(paths.outboxDsh));
  const roundStart = state.dispatches - (state.roundDispatches ?? state.dispatches) + 1;
  const unacked = unackedDispatches(outboxSent, outboxEntries, roundStart);
  const cursor = Math.min(state.inboxCursor, outboxEntries.length);
  const unread = outboxEntries.slice(cursor);
  const questionRaw = await readTextOrNull(paths.questionMd);
  const question = questionRaw !== null && questionRaw.trim().length > 0 ? questionRaw.trim() : null;
  const phase = derivePhase(spec, validation, prereview?.value ?? null, audit?.value ?? null, state);
  let action = NEXT_ACTION[phase];
  let actionEn = NEXT_ACTION_EN[phase];
  if (prereview === null && stalePrereview !== null) {
    action += `（上一轮预审 #${stalePrereview} 不适用于 v${spec?.specVersion ?? '?'}，需要重跑预审）`;
    actionEn += ` (pre-review #${stalePrereview} from the previous round does not apply to v${spec?.specVersion ?? '?'}; run it again)`;
  }
  if (unacked.length > 0) {
    action += `（派发 ${unacked.map((entry) => `#${entry.id ?? '?'}`).join('、')} 还没有回执：请 DevEco 在 \`outbox-deveco.md\` 追加 \`## [时间] deliver · #a-N · from=deveco to=dsh · re=#d-N | …\`）`;
    actionEn += ` (dispatch ${unacked.map((entry) => `#${entry.id ?? '?'}`).join(', ')} has no acknowledgement: append a deliver record with re=#d-N to outbox-deveco.md)`;
  }
  // Shadow review goes stale while the executor codes: surface it in the one next action.
  if (phase === 'dispatched' || phase === 'rework') {
    const last = state.lastShadowAt === undefined ? null : Date.parse(state.lastShadowAt);
    const ageMinutes = last === null || Number.isNaN(last) ? null : Math.floor((Date.parse(now) - last) / 60_000);
    if (ageMinutes === null || ageMinutes >= options.shadowIntervalMinutes) {
      action += ageMinutes === null
        ? ' 影子审查还没跑过：调 `dwguard_shadow` 做一次只读巡检。'
        : ` 影子审查已 ${ageMinutes} 分钟未跑：调 \`dwguard_shadow\` 做一次只读巡检。`;
      actionEn += ageMinutes === null
        ? ' Shadow review has not run yet: call `dwguard_shadow` for one read-only pass.'
        : ` Shadow review has not run for ${ageMinutes} min: call \`dwguard_shadow\` for one read-only pass.`;
    }
  }
  return {
    paths,
    options,
    state,
    spec,
    validation,
    prereview,
    audit,
    stalePrereview,
    staleAudit,
    outboxEntries,
    outboxSent,
    unacked,
    unread,
    question,
    phase,
    nextAction: action,
    nextActionEn: actionEn
  };
}

/** Chinese label of a phase. */
export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase];
}

/** Render the status document. */
export function renderStatusMarkdown(snapshot: Snapshot): string {
  const { spec, validation, prereview, audit, unread, question, state, paths } = snapshot;
  const prereviewText =
    prereview !== null
      ? `#${prereview.index} ${prereview.value.gate.pass ? '通过' : '未通过'}`
      : snapshot.stalePrereview !== null
        ? `（当前任务包未预审；上一轮 #${snapshot.stalePrereview} 不适用）`
        : '（未做）';
  const auditText =
    audit !== null
      ? `#${audit.index} ${audit.value.gate.pass ? '通过' : '未通过'}`
      : snapshot.staleAudit !== null
        ? `（当前任务包未审计；上一轮 #${snapshot.staleAudit} 不适用）`
        : '（未做）';
  const lines: string[] = [
    `# DwGuard 状态 · ${PHASE_LABELS[snapshot.phase]}`,
    '',
    `- 共享目录：\`${displayPath(paths, paths.shared)}/\``,
    `- 任务包：${spec === null ? '（尚未写入）' : `v${spec.specVersion} · ${spec.criteria.length} 条判据（must ${spec.criteria.filter((criterion) => criterion.weight === 'must').length} / should ${spec.criteria.filter((criterion) => criterion.weight === 'should').length}）`}`,
    `- 校验：${validation === null ? '—' : validation.errors.length === 0 ? `通过（${validation.warnings.length} 条提醒）` : `${validation.errors.length} 个错误`}`,
    `- 预审：${prereviewText}`,
    `- 派发：${state.roundDispatches ?? state.dispatches} 次（本轮）· 共 ${state.dispatches} 次`,
    `- 审计：${auditText}`,
    `- 未读交付：${unread.length} 条（共 ${snapshot.outboxEntries.length} 条）`,
    `- 未回执派发：${snapshot.unacked.length} 条${snapshot.unacked.length === 0 ? '' : `（${snapshot.unacked.map((entry) => `#${entry.id ?? '?'}`).join('、')}）`}`,
    `- 影子审查：${(state.shadowRuns ?? 0)} 次${state.lastShadowAt === undefined ? '' : `（最近 ${state.lastShadowAt}）`}`,
    `- 用户确认：${(state.confirmations ?? 0) > 0 ? `${state.confirmations} 次${state.confirmedAt === undefined ? '' : `（最近 ${state.confirmedAt}）`}` : '（未确认）'}`
  ];

  if (spec !== null) {
    const grouped = criteriaByDimension(spec);
    lines.push(
      '',
      '## 维度覆盖',
      '',
      table(
        ['维度', '判据数', 'must'],
        DIMENSIONS.map((dimension) => [
          DIMENSION_LABELS[dimension],
          String(grouped[dimension].length),
          String(grouped[dimension].filter((criterion) => criterion.weight === 'must').length)
        ])
      )
    );
  }

  if (validation !== null && (validation.errors.length > 0 || validation.warnings.length > 0)) {
    lines.push('', '## 任务包缺口', '');
    for (const issue of validation.errors) lines.push(`- **错误** ${issue.message}`);
    for (const issue of validation.warnings) lines.push(`- 提醒 ${issue.message}`);
  }

  if (audit !== null && !audit.value.gate.pass && audit.value.gate.errors.length > 0) {
    lines.push('', `## 最近一次审计未通过（#${audit.index}）`, '');
    for (const error of audit.value.gate.errors.slice(0, 8)) lines.push(`- ${error}`);
    if (audit.value.gate.errors.length > 8) {
      lines.push(`- …其余 ${audit.value.gate.errors.length - 8} 条见 \`${displayPath(paths, paths.artifactsDir)}/audit-${audit.index}.md\``);
    }
  }

  if (unread.length > 0) {
    lines.push('', '## 未读交付记录（DevEco Code → DSH）', '');
    for (const entry of unread) {
      lines.push(`### ${entry.header}`, '', truncate(entry.body, 1200), '');
    }
  }

  if (snapshot.unacked.length > 0) {
    lines.push('', '## 未回执的派发', '');
    for (const entry of snapshot.unacked) {
      lines.push(`- \`#${entry.id ?? '?'}\` · ${entry.header}`);
    }
    lines.push(
      '',
      '> 回执格式：`## [时间] deliver · #a-N · from=deveco to=dsh · re=#d-N | 交付摘要`（或 `ack` / `question`）。',
      ''
    );
  }

  if (question !== null) {
    lines.push('', '## 待回答的问题（tasks/question.md）', '', truncate(question, 1200), '');
  }

  lines.push('', '## 下一步', '', snapshot.nextAction, '');
  return lines.join('\n');
}
