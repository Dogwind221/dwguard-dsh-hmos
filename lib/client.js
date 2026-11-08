/**
 * DshHoms — the DwGuard sidebar entry plus its right-sidebar flow board.
 *
 * A vertical flow chart that uses the whole panel width (up to 640px):
 * 规划 → 执行 → 验收, with same-layer parallel modules — 编码实现 runs beside the
 * 增量② shadow reviewer, and the four-dimension audit fans out into four
 * sub-agent cards (功能 / 审美 / 性能 / 无障碍) — plus the return edges drawn as
 * curves: 预审✗ and Spec-level clarification back to the task pack, the shadow
 * risk back to “理解任务包”, implementation-level doubts and 返工 back to coding.
 *
 * The left row must not replace the conversation: its click only selects a
 * launcher panel that immediately gives the main column back to the Conversation.
 *
 * Data: `GET /dwguard/board` (lib/web.js).
 */
window.__ModuleLoader__.load({
  id: 'dwguard-dsh-hmos',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    const NS = 'dwguard-hmos'
    const PANEL_ID = 'dsh-homs'
    const TAB_KIND = 'dwguard-board'
    const TAB_TYPE_ID = 'dwguard-dsh-hmos/board'
    const BOARD_URL = '/dwguard/board'
    let HOST = null

    const NODE_H = 46
    const GAP = 34
    const SECTION_H = 20
    const CAPTION_H = 18
    const TOP = 8
    const LANE = 56
    const MAX_W = 640

    const zh = {
      panel: 'DshHoms',
      title: 'DshHoms',
      subtitle: '鸿蒙双代理 · 开发流程',
      refresh: '刷新',
      loading: '读取中…',
      emptyTitle: '这个工作区还没有任务包',
      emptyBody: '在任意会话里描述一个鸿蒙需求，DSH 会自动加载 dwguard-hmos 技能并冻结任务包；之后流程图会随阶段点亮。',
      emptyStep1: '新建会话，把工作目录切到鸿蒙工程',
      emptyStep2: '说需求：「给鸿蒙做个打卡页，能看连续天数」',
      emptyStep3: 'DSH 调 dwguard_spec 写任务包 → dwguard_prereview → dwguard_dispatch',
      emptyStep4: 'DevEco Code 交付后，DSH 调 dwguard_audit 独立取证',
      newSession: '新建会话',
      noWorkspace: '还没有任何工作区用到 DwGuard',
      next: '下一步',
      running: '进行中',
      failed: '未通过',
      legendDone: '已完成',
      legendRunning: '进行中',
      legendWaiting: '未开始',
      legendFailed: '返工',
      loops: '回退线：左＝任务包层（改包重审）· 右＝实现层（返工）',
      error: '看板接口不可用',
      offlineBody: '工具、技能与闸门照常工作；这里只是读不到实时看板。重启 DSH 后仍不可用，说明宿主没有挂载 /dwguard/board 路由。',
      launcherError: '右侧栏打不开',
      launcherErrorBody: '当前没有可显示的会话，或者右侧栏服务不可用。打开一个会话后再点 DshHoms。',
      backToChat: '回到会话',
      groups: { plan: '规划', build: '执行', verify: '验收' },
      steps: {
        intake: '需求澄清',
        intakeMeta: '目标 · 范围 · 这一轮不做什么',
        spec: '生成任务包',
        specMeta: '四维判据 · 约束',
        prereview: '派发前预审',
        prereviewMeta: '性能 / 生命周期 / 并发 / API + 反驳',
        dispatch: '派发给 DevEco',
        dispatchMeta: 'Goal 模式简报 + 出站记录',
        understand: '理解任务包',
        understandMeta: '读 Spec，确认无歧义；有疑问先澄清',
        execute: '编码实现',
        executeMeta: '构建 → 推设备 → 自验 → 修复',
        shadow: '影子审查 ②',
        shadowMeta: '只读中间代码与产物 · 结构风险→回理解',
        clarify: '自评 · 澄清 / 反馈',
        clarifyMeta: '双方无异议才交付',
        deliver: '交付结果',
        deliverMeta: '代码 / 构建产物 / 自验证记录',
        gate: '审计闸门',
        gateMeta: '四维 + must 全过',
        knowledge: '知识沉淀',
        knowledgeMeta: '决策 / 模式 / 返工教训 / 偏好',
        report: '验收报告',
        reportMeta: '结论 + 证据索引',
        confirm: '用户确认',
        confirmMeta: '完成 / 下一轮'
      },
      captions: { audit: '四维外部审计 ③ · 4 个子代理并行取证' },
      dims: { function: '功能', aesthetic: '审美', performance: '性能', accessibility: '无障碍' },
      tags: { prereview: '①', execute: '②', audit: '③', knowledge: '④' },
      chips: { parallel: '并行', subagent: '子代理' },
      reworkChip: '返工',
      reworkMeta: '回到编码实现',
      must: 'must',
      criteria: '判据',
      unread: '未读交付',
      workspaceLabel: '工作区',
      history: '历史',
      langToggle: '切换到英文',
      roundLabel: '第 {n} 轮',
      phaseNames: {
        intake: '待写任务包',
        spec: '待预审',
        'spec-invalid': '任务包不合法',
        prereview: '待派发前预审',
        ready: '预审通过，待派发',
        dispatched: '已派发，待交付',
        rework: '审计未通过，待返工',
        accepted: '验收通过，待用户确认',
        confirmed: '用户已确认'
      }
    }

    const en = {
      panel: 'DshHoms',
      title: 'DshHoms',
      subtitle: 'HarmonyOS dual-agent · flow',
      refresh: 'Refresh',
      loading: 'Loading…',
      emptyTitle: 'No task pack in this workspace yet',
      emptyBody: 'Describe a HarmonyOS task in any session; DSH loads the dwguard-hmos skill and freezes the task pack. The flow lights up as the round advances.',
      emptyStep1: 'Open a session whose working directory is the HarmonyOS project',
      emptyStep2: 'Say what you need: “给鸿蒙做个打卡页，能看连续天数”',
      emptyStep3: 'DSH runs dwguard_spec → dwguard_prereview → dwguard_dispatch',
      emptyStep4: 'After DevEco Code delivers, DSH runs dwguard_audit with its own evidence',
      newSession: 'New session',
      noWorkspace: 'No workspace has used DwGuard yet',
      next: 'Next',
      running: 'Running',
      failed: 'Failed',
      legendDone: 'Done',
      legendRunning: 'Running',
      legendWaiting: 'Waiting',
      legendFailed: 'Rework',
      loops: 'Return edges: left = task-pack level · right = implementation level',
      error: 'Board endpoint unavailable',
      offlineBody: 'Tools, skills and gates keep working; only the live board is unreadable. If a restart does not fix it, the host did not mount the /dwguard/board route.',
      launcherError: 'Right sidebar unavailable',
      launcherErrorBody: 'There is no session on screen, or the right-sidebar service is unavailable. Open a session and click DshHoms again.',
      backToChat: 'Back to conversation',
      groups: { plan: 'Plan', build: 'Build', verify: 'Verify' },
      steps: {
        intake: 'Clarify the need',
        intakeMeta: 'Goal · scope · what this round skips',
        spec: 'Freeze the task pack',
        specMeta: 'Four dimensions · constraints',
        prereview: 'Adversarial pre-review',
        prereviewMeta: 'Performance / lifecycle / concurrency / API + rebuttal',
        dispatch: 'Dispatch to DevEco',
        dispatchMeta: 'Goal-mode brief + outbox record',
        understand: 'Understand the pack',
        understandMeta: 'Read the spec; ask before coding when unclear',
        execute: 'Implement',
        executeMeta: 'Build → device → self-check → fix',
        shadow: 'Shadow review ②',
        shadowMeta: 'Read-only · structural risk → re-read the pack',
        clarify: 'Self-check · clarify',
        clarifyMeta: 'Deliver only when both sides agree',
        deliver: 'Deliver results',
        deliverMeta: 'Code / artifact / self-check record',
        gate: 'Acceptance gate',
        gateMeta: 'All dimensions + every must',
        knowledge: 'Knowledge sediment',
        knowledgeMeta: 'Decisions / patterns / rework lessons',
        report: 'Acceptance report',
        reportMeta: 'Verdict + evidence index',
        confirm: 'User confirmation',
        confirmMeta: 'Done / next round'
      },
      captions: { audit: 'Four-dimension audit ③ · 4 sub-agents in parallel' },
      dims: { function: 'Function', aesthetic: 'Aesthetic', performance: 'Performance', accessibility: 'Accessibility' },
      tags: { prereview: '①', execute: '②', audit: '③', knowledge: '④' },
      chips: { parallel: 'parallel', subagent: 'sub-agent' },
      reworkChip: 'Rework',
      reworkMeta: 'back to coding',
      must: 'must',
      criteria: 'criteria',
      unread: 'unread',
      workspaceLabel: 'Workspace',
      history: 'History',
      langToggle: 'Switch to Chinese',
      roundLabel: 'Round {n}',
      phaseNames: {
        intake: 'Waiting for task pack',
        spec: 'Waiting for pre-review',
        'spec-invalid': 'Task pack invalid',
        prereview: 'Pre-review needed',
        ready: 'Ready to dispatch',
        dispatched: 'Dispatched, awaiting delivery',
        rework: 'Rework required',
        accepted: 'Accepted, awaiting confirmation',
        confirmed: 'Confirmed'
      }
    }

    const GROUP_COLORS = { plan: '#7dd3fc', build: '#4ade80', verify: '#c4b5fd' }

    const CSS = `
.dwg-root{height:100%;overflow:auto;padding:16px 12px 28px;box-sizing:border-box;background:#0d1117;color:#e6edf3;font-variant-numeric:tabular-nums}
.dwg-inner{max-width:640px;margin:0 auto}
.dwg-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
.dwg-title{font-size:15px;line-height:22px;font-weight:600;letter-spacing:.01em}
.dwg-sub{font-size:11px;line-height:16px;color:#8b949e;margin-top:2px}
.dwg-btn{height:26px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:#161b22;color:#c9d1d9;font-size:11px;cursor:pointer}
.dwg-btn:hover{background:#21262d;border-color:rgba(255,255,255,.2)}
.dwg-btn:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}
.dwg-btn[disabled]{opacity:.45;cursor:default}
.dwg-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:#8b949e;margin-bottom:8px}
.dwg-phase{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid currentColor}
.dwg-phase[data-tone=ok]{color:#4ade80}
.dwg-phase[data-tone=bad]{color:#fbbf24}
.dwg-phase[data-tone=info]{color:#7dd3fc}
.dwg-phase[data-tone=neutral]{color:#8b949e}
.dwg-next{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:#111822;border:1px solid rgba(125,211,252,.18);font-size:11.5px;line-height:18px;color:#b9c7d6}
.dwg-next b{color:#7dd3fc;font-weight:600}
.dwg-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:10.5px;color:#8b949e;margin-bottom:6px}
.dwg-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}
.dwg-loopnote{font-size:10px;line-height:15px;color:#6e7781;margin-bottom:10px}
.dwg-flow{position:relative;width:100%}
.dwg-edges{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
.dwg-edge{fill:none;stroke-width:1.6;stroke-linecap:round}
.dwg-edge[data-state=done]{opacity:.85}
.dwg-edge[data-state=pending]{stroke:rgba(255,255,255,.14)}
.dwg-edge[data-state=failed]{stroke:rgba(251,191,36,.7)}
.dwg-edge-flow{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:5 8;animation:dwg-dash .9s linear infinite}
.dwg-loop{fill:none;stroke-width:1.4;stroke-dasharray:3 4;opacity:.72}
.dwg-loop[data-state=active]{stroke-width:2;stroke-dasharray:5 6;opacity:1;animation:dwg-dash 1.1s linear infinite}
.dwg-section{position:absolute;display:flex;align-items:center;gap:6px;font-size:10px;color:#8b949e;letter-spacing:.06em}
.dwg-section i{display:inline-block;width:8px;height:2px;border-radius:2px}
.dwg-caption{position:absolute;display:flex;align-items:center;gap:6px;font-size:10px;color:#a78bfa;letter-spacing:.02em}
.dwg-caption i{display:inline-block;width:8px;height:2px;border-radius:2px;background:#c4b5fd}
.dwg-aura{position:absolute;left:0;right:0;pointer-events:none;background:radial-gradient(52% 72% at 50% 50%,rgba(125,211,252,.14),transparent 72%);animation:dwg-aura 4.5s ease-in-out infinite;z-index:0}
.dwg-node{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:7px 12px 7px 22px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:#121821;overflow:hidden;animation:dwg-in .32s ease both}
.dwg-node[data-state=done]{border-color:rgba(74,222,128,.22)}
.dwg-node[data-state=active]{border-color:rgba(125,211,252,.65);background:#122132;animation:dwg-in .32s ease both,dwg-breathe 2.4s ease-in-out infinite}
.dwg-node[data-state=failed]{border-color:rgba(251,191,36,.55);background:#1d1a12}
.dwg-node[data-state=pending]{opacity:.66}
.dwg-node[data-dashed=true]{border-style:dashed;border-color:rgba(196,181,253,.45);background:rgba(196,181,253,.05)}
.dwg-node[data-dashed=true][data-state=active]{border-color:rgba(196,181,253,.85);box-shadow:0 0 14px rgba(196,181,253,.18)}
.dwg-mark{position:absolute;left:9px;top:50%;transform:translateY(-50%);display:flex;justify-content:center}
.dwg-dot{width:8px;height:8px;border-radius:50%}
.dwg-dot[data-state=done]{background:#4ade80;box-shadow:0 0 0 2px rgba(74,222,128,.15)}
.dwg-dot[data-state=pending]{background:transparent;border:1px solid #3a4350}
.dwg-dot[data-state=failed]{background:#fbbf24;box-shadow:0 0 0 2px rgba(251,191,36,.18)}
.dwg-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(125,211,252,.22);border-top-color:#7dd3fc;animation:dwg-spin .9s linear infinite}
.dwg-node[data-dashed=true] .dwg-spin{border-color:rgba(196,181,253,.25);border-top-color:#c9a7ff}
.dwg-itext{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;align-items:center;text-align:center}
.dwg-label{font-size:12px;line-height:17px;font-weight:600;color:#e6edf3;display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;overflow:hidden;max-width:100%}
.dwg-meta-line{font-size:10.5px;line-height:15px;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dwg-chip{flex:none;font-size:9px;line-height:14px;padding:0 5px;border-radius:999px;border:1px solid rgba(255,255,255,.14);color:#9aa7b4;font-weight:500}
.dwg-chip[data-tone=ok]{color:#4ade80;border-color:rgba(74,222,128,.5)}
.dwg-chip[data-tone=bad]{color:#fbbf24;border-color:rgba(251,191,36,.5)}
.dwg-chip[data-tone=info]{color:#7dd3fc;border-color:rgba(125,211,252,.5)}
.dwg-chip[data-tone=vio]{color:#c9a7ff;border-color:rgba(196,181,253,.5)}
.dwg-empty{border:1px dashed rgba(255,255,255,.16);border-radius:10px;padding:16px 14px}
.dwg-empty h2{margin:0;font-size:14px;line-height:22px;font-weight:600}
.dwg-empty p{margin:6px 0 12px;font-size:11.5px;line-height:19px;color:#8b949e}
.dwg-steps{margin:0;padding-left:17px;font-size:11.5px;line-height:21px;color:#8b949e}
.dwg-banner{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:17px;border:1px solid rgba(248,81,73,.5);color:#ff7b72;background:rgba(248,81,73,.06)}
.dwg-foot{margin-top:12px;font-size:10.5px;line-height:16px;color:#6e7781;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;word-break:break-all}
@keyframes dwg-spin{to{transform:rotate(360deg)}}
@keyframes dwg-dash{to{stroke-dashoffset:-26}}
@keyframes dwg-breathe{0%,100%{box-shadow:0 0 0 1px rgba(125,211,252,.28),0 0 10px rgba(125,211,252,.10)}50%{box-shadow:0 0 0 1px rgba(125,211,252,.62),0 0 20px rgba(125,211,252,.22)}}
@keyframes dwg-aura{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes dwg-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes dwg-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
.dwg-live{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;color:#7dd3fc}
.dwg-live i{width:6px;height:6px;border-radius:50%;background:#7dd3fc;box-shadow:0 0 8px #7dd3fc;animation:dwg-pulse 1.6s ease-in-out infinite}
.dwg-node:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}
.dwg-history{margin-top:14px;border-top:1px solid rgba(255,255,255,.06);padding-top:10px}
.dwg-history-title{font-size:10px;letter-spacing:.08em;color:#6e7781;margin-bottom:6px}
.dwg-history-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.dwg-history-item{display:flex;align-items:center;gap:7px;font-size:11px;color:#8b949e}
.dwg-history-item i{width:6px;height:6px;border-radius:50%;background:#4ade80;flex:none}
.dwg-history-item[data-kind=rework] i,.dwg-history-item[data-kind=audit][data-ok=false] i{background:#fbbf24}
.dwg-history-item[data-kind=confirm] i{background:#c4b5fd}
.dwg-history-item[data-kind=shadow] i{background:#7dd3fc}
.dwg-history-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwg-history-time{flex:none;color:#6e7781;font-variant-numeric:tabular-nums}
.dwg-lang{min-width:36px;padding:4px 8px;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: reduce){
  .dwg-spin,.dwg-edge-flow,.dwg-aura,.dwg-node,.dwg-live i{animation:none!important}
  .dwg-spin{border-color:#7dd3fc}
}

/* 0.8.8 — precision console visual layer. No layout/data changes. */
.dwg-root{
  --dwg-bg:#080b10;
  --dwg-surface:#0d131a;
  --dwg-raised:#111a23;
  --dwg-line:rgba(148,163,184,.15);
  --dwg-line-strong:rgba(148,163,184,.25);
  --dwg-text:#e7edf4;
  --dwg-muted:#8b98a8;
  --dwg-faint:#718091;
  --dwg-accent:#7dd3fc;
  --dwg-ok:#4ade80;
  --dwg-warn:#fbbf24;
  --dwg-violet:#c4b5fd;
  padding:14px 11px 24px;
  background:
    radial-gradient(120% 72% at 50% -18%,rgba(125,211,252,.075),transparent 58%),
    linear-gradient(180deg,#080b10 0%,#0a0f15 100%);
  color:var(--dwg-text);
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  letter-spacing:-.005em;
}
.dwg-root *{box-sizing:border-box}
.dwg-inner{max-width:660px}
.dwg-top{align-items:center;margin-bottom:12px;padding:0 2px}
.dwg-title{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px;letter-spacing:.01em}
.dwg-title::before{
  content:"";
  width:8px;height:8px;border-radius:2px;flex:none;
  background:linear-gradient(135deg,var(--dwg-accent),var(--dwg-violet));
  box-shadow:0 0 12px rgba(125,211,252,.55);
}
.dwg-sub{margin-top:3px;color:var(--dwg-faint);font-size:9.5px;line-height:13px;letter-spacing:.11em;text-transform:uppercase}
.dwg-actions{
  display:flex;align-items:center;gap:2px;padding:3px;
  border:1px solid var(--dwg-line);border-radius:10px;
  background:rgba(17,26,35,.82);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 6px 18px rgba(0,0,0,.14);
}
.dwg-actions .dwg-btn{
  height:26px;border:0;border-radius:7px;background:transparent;
  padding:0 9px;color:#aab6c5;font-size:10.5px;font-weight:500;letter-spacing:0;
}
.dwg-actions .dwg-btn:hover{background:rgba(148,163,184,.10);color:var(--dwg-text);border-color:transparent}
.dwg-actions .dwg-workspace{
  max-width:142px;appearance:none;padding-right:9px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;
}
.dwg-actions .dwg-workspace option{background:#101820;color:#dbe5ef}
.dwg-actions .dwg-lang{min-width:38px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px}
.dwg-actions .dwg-lang[aria-pressed=true]{color:var(--dwg-accent);background:rgba(125,211,252,.08)}
.dwg-actions .dwg-refresh{color:#c7d3df}
.dwg-actions .dwg-btn+.dwg-btn{border-left:1px solid rgba(148,163,184,.10);border-radius:0 7px 7px 0}
.dwg-actions .dwg-btn:first-child{border-radius:7px 0 0 7px}
.dwg-btn:focus-visible,.dwg-node:focus-visible{outline-color:var(--dwg-accent)}
.dwg-meta{
  gap:7px;padding:8px 10px;margin-bottom:8px;
  border:1px solid var(--dwg-line);border-radius:10px;
  background:linear-gradient(180deg,rgba(17,26,35,.92),rgba(13,19,26,.92));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.03);
  color:var(--dwg-muted);font-size:10.5px;
}
.dwg-meta-info{color:#9eacbb;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9.5px}
.dwg-phase{
  gap:5px;padding:3px 8px;border:1px solid transparent;border-radius:6px;
  font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;
}
.dwg-phase::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}
.dwg-phase[data-tone=ok]{color:var(--dwg-ok);background:rgba(74,222,128,.075);border-color:rgba(74,222,128,.20)}
.dwg-phase[data-tone=bad]{color:var(--dwg-warn);background:rgba(251,191,36,.075);border-color:rgba(251,191,36,.20)}
.dwg-phase[data-tone=info]{color:var(--dwg-accent);background:rgba(125,211,252,.075);border-color:rgba(125,211,252,.20)}
.dwg-phase[data-tone=neutral]{color:#a4b1c0;background:rgba(148,163,184,.06);border-color:rgba(148,163,184,.14)}
.dwg-next{
  position:relative;margin:8px 0 10px;padding:10px 11px 10px 13px;
  border:1px solid rgba(125,211,252,.16);border-left:2px solid var(--dwg-accent);border-radius:8px;
  background:linear-gradient(90deg,rgba(125,211,252,.07),rgba(125,211,252,.015));
  color:#b8c7d7;font-size:10.5px;line-height:17px;
}
.dwg-next b{color:var(--dwg-accent);font-size:9px;letter-spacing:.09em;text-transform:uppercase}
.dwg-legend{gap:12px;padding:0 2px;margin-bottom:6px;color:#718091;font-size:9px;letter-spacing:.02em}
.dwg-legend i{width:5px;height:5px}
.dwg-loopnote{padding:0 2px;color:#5f6d7c;font-size:9px;letter-spacing:.02em}
.dwg-flow{
  margin:10px 0 12px;border:1px solid rgba(148,163,184,.13);border-radius:12px;overflow:hidden;
  background:
    linear-gradient(rgba(148,163,184,.035) 1px,transparent 1px) 0 0/100% 24px,
    linear-gradient(90deg,rgba(148,163,184,.035) 1px,transparent 1px) 0 0/24px 100%,
    radial-gradient(80% 55% at 50% 0%,rgba(125,211,252,.055),transparent 68%),
    #0a0f15;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 10px 26px rgba(0,0,0,.16);
}
.dwg-section{color:#718091;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase}
.dwg-caption{color:var(--dwg-violet);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8.5px}
.dwg-node{
  border-radius:8px;border-color:rgba(148,163,184,.13);
  background:linear-gradient(180deg,#111a23,#0c131a);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035);
}
.dwg-node[data-state=done]{border-color:rgba(74,222,128,.24);background:linear-gradient(180deg,#0f1c18,#0c1412)}
.dwg-node[data-state=active]{
  border-color:rgba(125,211,252,.62);
  background:linear-gradient(180deg,#122432,#0d1822);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 0 0 1px rgba(125,211,252,.10),0 0 20px rgba(125,211,252,.10);
}
.dwg-node[data-state=failed]{border-color:rgba(251,191,36,.46);background:linear-gradient(180deg,#211b0f,#161208)}
.dwg-node[data-state=pending]{opacity:.58}
.dwg-node[data-dashed=true]{border-color:rgba(196,181,253,.32);background:linear-gradient(180deg,rgba(196,181,253,.055),rgba(196,181,253,.015))}
.dwg-node[data-dashed=true][data-state=active]{border-color:rgba(196,181,253,.78);box-shadow:0 0 18px rgba(196,181,253,.12)}
.dwg-label{font-size:11.5px;line-height:16px;letter-spacing:-.005em;color:#edf3f9}
.dwg-meta-line{color:#8593a3;font-size:9.5px;line-height:14px}
.dwg-chip{
  padding:1px 6px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:8.5px;letter-spacing:.02em;border-color:rgba(148,163,184,.20);color:#93a1b1;
}
.dwg-chip[data-tone=info]{color:var(--dwg-accent);border-color:rgba(125,211,252,.34);background:rgba(125,211,252,.06)}
.dwg-chip[data-tone=ok]{color:var(--dwg-ok);border-color:rgba(74,222,128,.34);background:rgba(74,222,128,.06)}
.dwg-chip[data-tone=bad]{color:var(--dwg-warn);border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.06)}
.dwg-chip[data-tone=vio]{color:var(--dwg-violet);border-color:rgba(196,181,253,.34);background:rgba(196,181,253,.06)}
.dwg-dot[data-state=done]{background:var(--dwg-ok);box-shadow:0 0 0 2px rgba(74,222,128,.14)}
.dwg-dot[data-state=failed]{background:var(--dwg-warn);box-shadow:0 0 0 2px rgba(251,191,36,.16)}
.dwg-spin{width:12px;height:12px;border-color:rgba(125,211,252,.20);border-top-color:var(--dwg-accent)}
.dwg-node[data-dashed=true] .dwg-spin{border-color:rgba(196,181,253,.20);border-top-color:var(--dwg-violet)}
.dwg-live{color:var(--dwg-accent);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;letter-spacing:.03em}
.dwg-live i{background:var(--dwg-accent);box-shadow:0 0 8px var(--dwg-accent)}
.dwg-empty{
  padding:18px 16px;border:1px solid var(--dwg-line);border-radius:12px;
  background:linear-gradient(180deg,rgba(17,26,35,.88),rgba(13,19,26,.88));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035);
}
.dwg-empty h2{font-size:13px;line-height:20px;letter-spacing:-.01em}
.dwg-empty p{color:#8593a3;font-size:10.5px;line-height:17px}
.dwg-steps{color:#8593a3;font-size:10.5px;line-height:19px;padding-left:16px}
.dwg-empty .dwg-btn{margin-top:12px}
.dwg-banner{padding:9px 11px;border-radius:9px;border-color:rgba(251,191,36,.28);color:var(--dwg-warn);background:rgba(251,191,36,.055);font-size:10px;line-height:16px}
.dwg-history{
  margin-top:16px;padding:10px 11px;
  border:1px solid var(--dwg-line);border-radius:10px;
  background:rgba(13,19,26,.72);
}
.dwg-history-title{color:#718091;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase}
.dwg-history-list{position:relative;gap:0}
.dwg-history-list::before{content:"";position:absolute;left:3px;top:6px;bottom:6px;width:1px;background:rgba(148,163,184,.12)}
.dwg-history-item{position:relative;padding:5px 0 5px 15px;gap:8px;font-size:10px;color:#8593a3}
.dwg-history-item i{position:absolute;left:0;top:9px;width:5px;height:5px;background:var(--dwg-ok)}
.dwg-history-item[data-kind=rework] i,.dwg-history-item[data-kind=audit][data-ok=false] i{background:var(--dwg-warn)}
.dwg-history-item[data-kind=confirm] i{background:var(--dwg-violet)}
.dwg-history-item[data-kind=shadow] i{background:var(--dwg-accent)}
.dwg-history-time{color:#5f6d7c;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8.5px}
.dwg-foot{margin-top:12px;padding-top:9px;border-top:1px solid rgba(148,163,184,.10);color:#6f7d8d;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8.5px;letter-spacing:.01em}
.dwg-root{color-scheme:dark;scrollbar-color:rgba(148,163,184,.28) transparent}
.dwg-root::-webkit-scrollbar{width:9px}
.dwg-root::-webkit-scrollbar-track{background:transparent}
.dwg-root::-webkit-scrollbar-thumb{background:rgba(148,163,184,.22);border:2px solid var(--dwg-bg);border-radius:999px}
.dwg-root ::selection{background:rgba(125,211,252,.22);color:#f2f8ff}
.dwg-loopnote{color:#6b7a8a}
.dwg-history-time{color:#6f7d8d}
@keyframes dwg-breathe{0%,100%{box-shadow:0 0 0 1px rgba(125,211,252,.24),0 0 12px rgba(125,211,252,.08)}50%{box-shadow:0 0 0 1px rgba(125,211,252,.58),0 0 22px rgba(125,211,252,.20)}}
`

    function useStyles() {
      react.useEffect(() => {
        if (document.querySelector('style[data-dwg-panel]')) return
        const tag = document.createElement('style')
        tag.dataset.dwgPanel = '1'
        tag.textContent = CSS
        document.head.appendChild(tag)
      }, [])
    }

    function phaseTone(phase) {
      if (phase === 'accepted' || phase === 'confirmed') return 'ok'
      if (phase === 'rework') return 'bad'
      if (phase === 'dispatched' || phase === 'ready') return 'info'
      return 'neutral'
    }

    function DshHomsIcon(props) {
      const size = (props && props.size) || 18
      const activate = (event) => {
        try {
          event.preventDefault()
          event.stopPropagation()
        } catch {
          /* synthetic event is best-effort */
        }
        openBoardFromEntry()
      }
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { cursor: 'pointer' }, onClick: activate },
        h('path', {
          d: 'M12 2.6 3.6 5.9v6c0 4.9 3.5 8.1 8.4 9.5 4.9-1.4 8.4-4.6 8.4-9.5v-6L12 2.6Z',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinejoin: 'round'
        }),
        h('path', {
          d: 'M9.2 9.1v5.8M14.8 9.1v5.8M9.2 12h5.6',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinecap: 'round'
        })
      )
    }

    /** Which stage the round is actually on, by id. */
    function activeIdFor(board) {
      const phase = board.phase
      if (phase === 'intake') return 'intake'
      if (phase === 'spec' || phase === 'spec-invalid') return 'spec'
      if (phase === 'prereview') return 'prereview'
      if (phase === 'ready') return 'dispatch'
      if (phase === 'dispatched') return board.unread > 0 ? 'audit' : 'execute'
      if (phase === 'rework') return 'execute'
      if (phase === 'accepted') return 'knowledge'
      if (phase === 'confirmed') return 'confirm'
      return 'intake'
    }

    /**
     * Build the flow: rows top-to-bottom (single cards, one parallel row, one
     * four-cell audit fan), the fork/merge buses, and the return edges.
     */
    function buildFlow(t, board, width) {
      const innerW = Math.max(280, Math.min(width || 0, MAX_W))
      const spine = innerW / 2
      // Cards stay comfortably narrow so the return edges get real room.
      const cardW = Math.max(260, Math.min(460, innerW - 200))
      const nodeX = (innerW - cardW) / 2
      const contentW = cardW
      const gateFailed = board.audit !== null && board.audit !== undefined && board.audit.pass === false
      const auditActive = board.phase === 'dispatched' && board.unread > 0
      const dimensions = board.dimensions
      const live = board.phase !== 'intake' && board.phase !== 'accepted'

      const rows = []
      const section = (id, label, color) => rows.push({ kind: 'section', id, label, color })
      const caption = (id, label) => rows.push({ kind: 'caption', id, label })
      const single = (stage, label, meta, tag) =>
        rows.push({
          kind: 'row',
          stage,
          cells: [{ id: stage, label, meta, tag, x: nodeX, w: contentW, offsetY: 0, top: true, bottom: true }]
        })

      section('plan', t.groups.plan, GROUP_COLORS.plan)
      single('intake', t.steps.intake, t.steps.intakeMeta)
      single('spec', t.steps.spec, `${t.criteria} ${board.criteria.total} · ${t.must} ${board.criteria.must}`)
      single(
        'prereview',
        t.steps.prereview,
        board.prereview ? `#${board.prereview.id} ${board.prereview.pass ? '✓' : '✗'}` : t.steps.prereviewMeta,
        t.tags.prereview
      )
      single('dispatch', t.steps.dispatch, t.steps.dispatchMeta)

      section('build', t.groups.build, GROUP_COLORS.build)
      single('understand', t.steps.understand, t.steps.understandMeta)

      // Same-layer parallel: coding runs beside the shadow reviewer.
      const execW = Math.max(150, Math.round(contentW * 0.58) - 4)
      const shadowW = Math.max(96, contentW - execW - 8)
      rows.push({
        kind: 'row',
        stage: 'execute',
        cells: [
          { id: 'execute', label: t.steps.execute, meta: t.steps.executeMeta, tag: t.tags.execute, x: nodeX, w: execW, offsetY: 0, top: true, bottom: true },
          {
            id: 'shadow',
            label: t.steps.shadow,
            meta: t.steps.shadowMeta,
            x: nodeX + execW + 8,
            w: shadowW,
            offsetY: 0,
            top: true,
            bottom: true,
            dashed: true
          }
        ]
      })

      single('clarify', t.steps.clarify, t.steps.clarifyMeta)
      single('deliver', t.steps.deliver, board.unread > 0 ? `${t.unread} ${board.unread}` : t.steps.deliverMeta)

      section('verify', t.groups.verify, GROUP_COLORS.verify)
      // How many dimension sub-agents already returned (host-reported states).
      const returnedNow = dimensions.filter(
        (dimension) => dimension.state === 'done' || dimension.state === 'failed'
      ).length
      caption(
        'audit-caption',
        auditActive ? `${t.captions.audit} · ${returnedNow}/4` : t.captions.audit
      )

      // Four-dimension audit: four sub-agent cards, 4×1 on wide panes, 2×2 below.
      const dimMeta = (dimension) => `${dimension.passed}/${dimension.total}`
      const dimCells = dimensions.map((dimension) => ({
        id: `audit-${dimension.key}`,
        dimKey: dimension.key,
        label: t.dims[dimension.key] || dimension.label,
        meta: dimMeta(dimension),
        state: 'pending'
      }))
      if (innerW >= 560) {
        const gapX = 8
        const w = (contentW - gapX * 3) / 4
        dimCells.forEach((cell, index) => {
          cell.x = nodeX + index * (w + gapX)
          cell.w = w
          cell.offsetY = 0
          cell.top = true
          cell.bottom = true
        })
      } else {
        const gapX = 8
        const w = (contentW - gapX) / 2
        dimCells.forEach((cell, index) => {
          cell.x = nodeX + (index % 2) * (w + gapX)
          cell.w = w
          cell.offsetY = index < 2 ? 0 : NODE_H + 8
          cell.top = index < 2
          cell.bottom = index >= 2
          cell.col = index % 2
          cell.gridRow = index < 2 ? 0 : 1
        })
      }
      rows.push({ kind: 'row', stage: 'audit', cells: dimCells })

      single(
        'gate',
        t.steps.gate,
        gateFailed
          ? `↩ ${t.reworkChip}${board.files.rework > 0 ? ` #${board.files.rework}` : ''} · ${t.reworkMeta}`
          : `${t.must} ${board.criteria.mustPassed}/${board.criteria.must}`
      )
      single('knowledge', t.steps.knowledge, t.steps.knowledgeMeta, t.tags.knowledge)
      single('report', t.steps.report, t.steps.reportMeta)
      single('confirm', t.steps.confirm, t.steps.confirmMeta)

      const stageRows = rows.filter((row) => row.kind === 'row')
      const order = stageRows.map((row) => row.stage)
      const activeId = activeIdFor(board)
      const activeIndex = Math.max(0, order.indexOf(activeId))

      // Layout.
      let cursor = TOP
      for (const row of rows) {
        if (row.kind === 'section') {
          row.y = cursor
          row.h = SECTION_H
          row.x = nodeX
          cursor += SECTION_H + 6
          continue
        }
        if (row.kind === 'caption') {
          row.y = cursor
          row.h = CAPTION_H
          row.x = nodeX
          // Leave room for the fan-out bus, which sits just above the cards.
          cursor += CAPTION_H + 26
          continue
        }
        row.y = cursor
        row.h = Math.max(...row.cells.map((cell) => cell.offsetY + NODE_H))
        for (const cell of row.cells) {
          cell.y = row.y + cell.offsetY
          cell.h = NODE_H
        }
        row.state = (() => {
          const index = order.indexOf(row.stage)
          return index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending'
        })()
        if (row.stage === 'gate' && gateFailed) row.state = 'failed'
        cursor += row.h + GAP
      }
      const height = cursor + 4

      // States.
      for (const row of stageRows) {
        for (const cell of row.cells) {
          if (cell.id === 'shadow') cell.state = row.state
          else if (row.stage === 'audit') {
            const dimension = dimensions.find((entry) => entry.key === cell.dimKey)
            // The host knows which sub-agent already returned; use it verbatim.
            if (dimension && typeof dimension.state === 'string') cell.state = dimension.state
            else if (auditActive) cell.state = 'active'
            else if (!board.audit) cell.state = 'pending'
            else if (row.state === 'done') cell.state = 'done'
            else if (dimension && dimension.failed > 0) cell.state = 'failed'
            else if (dimension && dimension.total > 0 && dimension.passed === dimension.total) cell.state = 'done'
            else cell.state = 'pending'
          } else if (cell.id === 'gate' && gateFailed) cell.state = 'failed'
          else cell.state = row.state
        }
      }
      if (board.phase === 'rework') {
        for (const row of stageRows) {
          if (row.stage === 'deliver' || row.stage === 'clarify') row.state = 'done'
          for (const cell of row.cells) {
            if (cell.id === 'deliver' || cell.id === 'clarify') cell.state = 'done'
          }
        }
      }
      // Confirmed: the whole round is done — no spinner left on the map.
      if (board.phase === 'confirmed') {
        for (const row of stageRows) {
          row.state = 'done'
          for (const cell of row.cells) cell.state = 'done'
        }
      }

      const rowByStage = new Map(stageRows.map((row) => [row.stage, row]))
      const cellById = new Map(stageRows.flatMap((row) => row.cells.map((cell) => [cell.id, cell])))

      const edges = []
      for (let index = 0; index + 1 < stageRows.length; index += 1) {
        const from = stageRows[index]
        const to = stageRows[index + 1]
        const exitY = from.y + from.h
        const state = to.state
        edges.push({
          id: `v-${from.stage}-${to.stage}`,
          d: `M ${spine} ${exitY} L ${spine} ${to.y}`,
          state,
          kind: 'v'
        })
        const bottoms = from.cells.filter((cell) => cell.bottom)
        if (bottoms.length > 1) {
          const mergeY = exitY + 16
          for (const cell of bottoms) {
            edges.push({
              id: `m-${cell.id}`,
              d: `M ${cell.x + cell.w / 2} ${exitY} L ${cell.x + cell.w / 2} ${mergeY}`,
              state,
              kind: 'm'
            })
          }
          const xs = bottoms.map((cell) => cell.x + cell.w / 2)
          edges.push({
            id: `mb-${from.stage}`,
            d: `M ${Math.min(...xs)} ${mergeY} L ${Math.max(...xs)} ${mergeY}`,
            state,
            kind: 'm'
          })
        }
        const tops = to.cells.filter((cell) => cell.top)
        if (tops.length > 1) {
          const forkY = to.y - 16
          for (const cell of tops) {
            edges.push({
              id: `f-${cell.id}`,
              d: `M ${cell.x + cell.w / 2} ${forkY} L ${cell.x + cell.w / 2} ${to.y}`,
              state,
              kind: 'f'
            })
          }
          const xs = tops.map((cell) => cell.x + cell.w / 2)
          edges.push({
            id: `fb-${to.stage}`,
            d: `M ${Math.min(...xs)} ${forkY} L ${Math.max(...xs)} ${forkY}`,
            state,
            kind: 'f'
          })
        }
        // 2×2 audit grid: link the two grid rows inside the block.
        // (Handled after the boundary loop, where the grid rows are known.)
      }

      for (const row of stageRows) {
        for (const cell of row.cells) {
          if (!cell.gridRow) continue
          const above = row.cells.find((candidate) => candidate.col === cell.col && candidate.gridRow === cell.gridRow - 1)
          if (above) {
            edges.push({
              id: `g-${above.id}-${cell.id}`,
              d: `M ${above.x + above.w / 2} ${above.y + above.h} L ${cell.x + cell.w / 2} ${cell.y}`,
              state: row.state,
              kind: 'g'
            })
          }
        }
      }

      const leftEdge = (row) => row.cells[0].x
      const loopInto = (fromStage, toStage, lane, color, endOffset) => {
        const from = rowByStage.get(fromStage)
        const to = rowByStage.get(toStage)
        if (!from || !to) return null
        const startY = from.y + 12
        const endY = to.y + (endOffset ?? 12)
        return {
          id: `loop-${fromStage}-${toStage}`,
          d: `M ${leftEdge(from)} ${startY} C ${lane} ${startY}, ${lane} ${endY}, ${leftEdge(to)} ${endY}`,
          color
        }
      }
      const loopUnder = (fromStage, toStage, x, lane, color, drop) => {
        const from = rowByStage.get(fromStage)
        const to = rowByStage.get(toStage)
        if (!from || !to) return null
        const cell = from.cells[0]
        const startY = from.y + 12
        const runY = to.y + to.h + drop
        return {
          id: `loop-${fromStage}-${toStage}`,
          d: `M ${cell.x + cell.w} ${startY} C ${lane} ${startY}, ${lane} ${runY}, ${lane - 16} ${runY} L ${x} ${runY} L ${x} ${to.y + to.h + 6}`,
          color
        }
      }

      const execRow = rowByStage.get('execute')
      const execBottomY = execRow ? execRow.y + execRow.h : 0
      const loops = [
        loopInto('prereview', 'spec', 14, '#7dd3fc', 12),
        loopInto('clarify', 'spec', 32, '#7dd3fc', 30),
        // Shadow finding → understand the pack again (left gutter, purple).
        loopInto('execute', 'understand', 50, '#c4b5fd', 14),
        // Implementation-level doubts and rework return under the parallel row.
        loopUnder('clarify', 'execute', spine - 20, innerW - 44, '#fbbf24', 22),
        loopUnder('gate', 'execute', spine + 20, innerW - 26, '#fbbf24', 30)
      ].filter(Boolean)

      const nextId = order[activeIndex + 1]
      let flowEdge = edges.find((edge) => edge.id === `v-${order[activeIndex]}-${nextId}`) ?? null
      if (board.phase === 'rework') {
        const reworkLoop = loops.find((loop) => loop.id === 'loop-gate-execute')
        if (reworkLoop) flowEdge = reworkLoop
      }

      const activeRow = rowByStage.get(activeId)
      const activeY = activeRow ? activeRow.y : 0
      const returned = dimensions.filter((dimension) => dimension.state === 'done' || dimension.state === 'failed').length

      return {
        width: innerW,
        height,
        rows,
        cells: [...cellById.values()],
        edges,
        loops,
        flowEdge,
        spine,
        live,
        activeY,
        returned
      }
    }

    function FlowNode({ t, node, index }) {
      const dashed = node.dashed === true
      return h(
        'div',
        {
          className: 'dwg-node',
          'data-state': node.state,
          'data-dashed': dashed ? 'true' : 'false',
          style: {
            left: node.x,
            top: node.y,
            width: node.w,
            height: node.h,
            animationDelay: `${Math.min(index * 16, 240)}ms`
          }
        },
        h(
          'span',
          { className: 'dwg-mark', 'aria-hidden': 'true' },
          node.state === 'active'
            ? h('span', { className: 'dwg-spin' })
            : h('span', {
                className: 'dwg-dot',
                'data-state': node.state === 'failed' ? 'failed' : node.state === 'done' ? 'done' : 'pending'
              })
        ),
        h(
          'span',
          { className: 'dwg-itext' },
          h(
            'span',
            { className: 'dwg-label' },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, node.label),
            node.tag ? h('span', { className: 'dwg-chip' }, node.tag) : null,
            node.chip ? h('span', { className: 'dwg-chip', 'data-tone': dashed ? 'vio' : undefined }, node.chip) : null,
            node.id === 'gate' && node.state === 'failed'
              ? h('span', { className: 'dwg-chip', 'data-tone': 'bad' }, t.failed)
              : null
          ),
          h('span', { className: 'dwg-meta-line' }, node.meta)
        )
      )
    }

    function FlowChart({ t, board }) {
      const wrapRef = react.useRef(null)
      const [width, setWidth] = react.useState(320)

      react.useEffect(() => {
        const element = wrapRef.current
        if (!element) return undefined
        const update = () => {
          const measured = element.clientWidth
          if (measured > 0) setWidth(measured)
        }
        update()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(update)
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      const flow = buildFlow(t, board, width)

      const edgeState = (edge) => {
        const to = edge.id.startsWith('v-') ? edge.id.split('-').slice(2).join('-') : null
        if (to) {
          const row = flow.rows.find((candidate) => candidate.kind === 'row' && candidate.stage === to)
          if (row) return row.state
        }
        return edge.state
      }

      return h(
        'div',
        { className: 'dwg-flow', ref: wrapRef, style: { height: `${flow.height}px` } },
        flow.live
          ? h('div', {
              key: 'aura',
              className: 'dwg-aura',
              style: { top: `${Math.max(0, flow.activeY - 80)}px`, height: '200px' }
            })
          : null,
        h(
          'svg',
          { className: 'dwg-edges', width: flow.width, height: flow.height, viewBox: `0 0 ${flow.width} ${flow.height}`, 'aria-hidden': 'true' },
          h(
            'defs',
            null,
            ['#7dd3fc', '#fbbf24', '#c4b5fd'].map((color) =>
              h(
                'marker',
                {
                  key: color,
                  id: `dw-arrow-${color.slice(1)}`,
                  viewBox: '0 0 8 8',
                  refX: 7,
                  refY: 4,
                  markerWidth: 6,
                  markerHeight: 6,
                  orient: 'auto-start-reverse'
                },
                h('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: color })
              )
            )
          ),
          flow.edges.map((edge) =>
            h('path', {
              key: edge.id,
              className: 'dwg-edge',
              d: edge.d,
              'data-state': edgeState(edge),
              style: {
                stroke:
                  edgeState(edge) === 'pending'
                    ? 'rgba(255,255,255,.14)'
                    : edgeState(edge) === 'failed'
                      ? '#fbbf24'
                      : '#4ade80'
              }
            })
          ),
          flow.flowEdge && !flow.flowEdge.id.startsWith('loop-')
            ? h('path', {
                key: 'flow',
                className: 'dwg-edge-flow',
                d: flow.flowEdge.d,
                style: { stroke: '#7dd3fc', filter: 'drop-shadow(0 0 5px rgba(125,211,252,.8))' }
              })
            : null,
          flow.loops.map((loop) =>
            h('path', {
              key: loop.id,
              className: 'dwg-loop',
              d: loop.d,
              'data-state': loop.id === flow.flowEdge?.id ? 'active' : 'idle',
              style: { stroke: loop.color, markerEnd: `url(#dw-arrow-${loop.color.slice(1)})` }
            })
          )
        ),
        flow.rows
          .filter((row) => row.kind === 'section')
          .map((row) =>
            h(
              'div',
              { key: `s-${row.id}`, className: 'dwg-section', style: { left: row.x, top: row.y, height: row.h } },
              h('i', { style: { background: row.color } }),
              row.label
            )
          ),
        flow.rows
          .filter((row) => row.kind === 'caption')
          .map((row) =>
            h('div', { key: `c-${row.id}`, className: 'dwg-caption', style: { left: row.x, top: row.y, height: row.h } }, h('i'), row.label)
          ),
        flow.cells.map((cell, index) =>
          h(FlowNode, { key: cell.id, t, node: cell, index })
        )
      )
    }

    function EmptyState({ t, onNewSession, hasWorkspace, offline }) {
      const steps = [t.emptyStep1, t.emptyStep2, t.emptyStep3, t.emptyStep4]
      return h(
        'div',
        { className: 'dwg-empty' },
        h('h2', null, offline ? t.error : hasWorkspace ? t.emptyTitle : t.noWorkspace),
        h('p', null, offline ? t.offlineBody : hasWorkspace ? t.emptyBody : t.emptyStep1),
        h('ol', { className: 'dwg-steps' }, steps.map((step) => h('li', { key: step }, step))),
        onNewSession
          ? h('div', { style: { marginTop: '12px' } }, h('button', { className: 'dwg-btn', onClick: onNewSession }, t.newSession))
          : null
      )
    }

    /** A dimmed placeholder board so the flow is visible before any task pack. */
    function demoBoard() {
      return {
        workspace: '',
        name: '—',
        title: '等待任务包',
        phase: 'intake',
        phaseLabel: '待写任务包',
        specVersion: 0,
        iteration: 0,
        updatedAt: '',
        criteria: { total: 0, must: 0, mustPassed: 0 },
        dimensions: [
          { key: 'function', label: '功能', total: 0, must: 0, passed: 0, failed: 0, unverified: 0, missing: 0, state: 'pending' },
          { key: 'aesthetic', label: '审美', total: 0, must: 0, passed: 0, failed: 0, unverified: 0, missing: 0, state: 'pending' },
          { key: 'performance', label: '性能', total: 0, must: 0, passed: 0, failed: 0, unverified: 0, missing: 0, state: 'pending' },
          { key: 'accessibility', label: '无障碍', total: 0, must: 0, passed: 0, failed: 0, unverified: 0, missing: 0, state: 'pending' }
        ],
        prereview: null,
        audit: null,
        unread: 0,
        files: { spec: false, brief: false, report: false, rework: 0 },
        next: '给鸿蒙提一个需求；任务包冻结后，这张图会一段段亮起来。'
      }
    }

    /** Short local timestamp for the history list. */
    function eventTime(iso) {
      try {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return ''
        const pad = (value) => String(value).padStart(2, '0')
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      } catch {
        return ''
      }
    }

    function HistoryList({ t, events, lang }) {
      if (!Array.isArray(events) || events.length === 0) return null
      const labelOf = (event) => (lang === 'en' ? event.labelEn || event.label : event.label)
      return h(
        'section',
        { className: 'dwg-history' },
        h('div', { className: 'dwg-history-title' }, t.history),
        h(
          'ul',
          { className: 'dwg-history-list' },
          events.map((event, index) =>
            h(
              'li',
              {
                key: `${event.at}-${index}`,
                className: 'dwg-history-item',
                'data-kind': event.kind,
                'data-ok': event.ok === false ? 'false' : 'true'
              },
              h('i', { 'aria-hidden': 'true' }),
              h('span', { className: 'dwg-history-label' }, labelOf(event)),
              h('time', { className: 'dwg-history-time', dateTime: event.at }, eventTime(event.at))
            )
          )
        )
      )
    }

    /** Host language, falling back to Chinese. */
    function hostLang() {
      try {
        const language =
          (typeof navigator !== 'undefined' && navigator.language) ||
          (typeof document !== 'undefined' && document.documentElement.lang) ||
          (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : '') ||
          ''
        return String(language).toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    function storedLang() {
      try {
        const value = typeof localStorage !== 'undefined' ? localStorage.getItem('dwguard.lang') : null
        return value === 'en' || value === 'zh' ? value : null
      } catch {
        return null
      }
    }

    function rememberLang(lang) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('dwguard.lang', lang)
      } catch {
        /* language memory is best-effort */
      }
    }

    function BoardView({ compact }) {
      useStyles()
      const [lang, setLang] = react.useState(() => storedLang() || hostLang())
      const t = lang === 'en' ? en : zh
      const [state, setState] = react.useState({ loading: true, error: null, data: null })
      const [cwd, setCwd] = react.useState(null)

      const startSession = react.useCallback(() => {
        try {
          const workspace = HOST && typeof HOST.get === 'function' ? HOST.get('uiWorkspace') : null
          if (workspace && typeof workspace.startSession === 'function') workspace.startSession()
        } catch {
          /* convenience only */
        }
      }, [])

      const load = react.useCallback(async (target) => {
        setState((previous) => ({ ...previous, loading: true, error: null }))
        try {
          const query = target ? `?workspace=${encodeURIComponent(target)}` : ''
          const response = await fetch(BOARD_URL + query, { cache: 'no-store', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState({ loading: false, error: null, data })
        } catch (error) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }, [])

      react.useEffect(() => {
        load(null)
        const timer = setInterval(() => load(null), 15000)
        return () => clearInterval(timer)
      }, [load])

      const data = state.data
      const board = data ? data.board : null
      const workspaces = data ? data.workspaces || [] : []

      const onSelect = (event) => {
        const next = event.target.value
        setCwd(next)
        load(next)
      }

      const top = h(
        'div',
        { className: 'dwg-top', key: 'top' },
        h('div', null, h('div', { className: 'dwg-title' }, t.title), h('div', { className: 'dwg-sub' }, t.subtitle)),
        h(
          'div',
          { className: 'dwg-actions' },
          workspaces.length > 1
            ? h(
                'select',
                { className: 'dwg-btn dwg-workspace', value: data.active || '', onChange: onSelect, 'aria-label': t.workspaceLabel },
                workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, workspace.name))
              )
            : null,
          h('button', {
            className: 'dwg-btn dwg-lang',
            type: 'button',
            onClick: () => {
              const next = lang === 'en' ? 'zh' : 'en'
              setLang(next)
              rememberLang(next)
            },
            'aria-pressed': lang === 'en',
            'aria-label': t.langToggle,
            title: t.langToggle
          }, lang === 'en' ? '中' : 'EN'),
          h('button', { className: 'dwg-btn dwg-refresh', onClick: () => load(cwd), disabled: state.loading }, t.refresh)
        )
      )

      const body = []
      if (state.error) body.push(h('div', { className: 'dwg-banner', key: 'error' }, `${t.error}：${state.error}`))

      if (state.loading && !board) {
        body.push(h('p', { className: 'dwg-meta-line', key: 'loading' }, t.loading))
      } else if (!board) {
        // Open the panel and the whole flow is already there, dimmed: the round
        // lights up as soon as the first task pack exists.
        body.push(
          h(EmptyState, {
            key: 'empty',
            t,
            hasWorkspace: workspaces.length > 0,
            offline: Boolean(state.error),
            onNewSession: startSession
          })
        )
        body.push(h(FlowChart, { key: 'flow', t, board: demoBoard() }))
      } else {
        const phaseName = t.phaseNames[board.phase] || board.phaseLabel
        body.push(
          h(
            'div',
            { className: 'dwg-meta', key: 'meta', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'dwg-phase', 'data-tone': phaseTone(board.phase) }, phaseName),
            h('span', { className: 'dwg-meta-info' }, `${board.name} · v${board.specVersion} · ${t.roundLabel.replace('{n}', board.iteration)}`),
            board.unread > 0 ? h('span', { className: 'dwg-chip', 'data-tone': 'info' }, `${t.unread} ${board.unread}`) : null,
            board.phase !== 'intake' && board.phase !== 'accepted'
              ? h('span', { className: 'dwg-live', key: 'live' }, h('i'), t.running)
              : null
          )
        )
        body.push(h('p', { className: 'dwg-next', key: 'next' }, h('b', null, `${t.next}：`), lang === 'en' && board.nextEn ? board.nextEn : board.next))
        body.push(
          h(
            'div',
            { className: 'dwg-legend', key: 'legend', 'aria-hidden': 'true' },
            h('span', null, h('i', { style: { background: '#4ade80' } }), t.legendDone),
            h('span', null, h('i', { style: { background: '#7dd3fc', boxShadow: '0 0 6px #7dd3fc' } }), t.legendRunning),
            h('span', null, h('i', { style: { border: '1px solid #3a4350' } }), t.legendWaiting),
            h('span', null, h('i', { style: { background: '#fbbf24' } }), t.legendFailed)
          )
        )
        body.push(h('div', { className: 'dwg-loopnote', key: 'loopnote' }, t.loops))
        body.push(h(FlowChart, { key: 'flow', t, board }))
        body.push(h(HistoryList, { key: 'history', t, events: board.history, lang }))
        body.push(
          h('footer', { className: 'dwg-foot', key: 'foot' }, h('span', null, board.title), h('span', null, board.workspace))
        )
      }

      return h('div', { className: 'dwg-root' }, h('div', { className: 'dwg-inner' }, [top].concat(body)))
    }

    let tabTypeRegistered = false

    function service(name) {
      try {
        return HOST && typeof HOST.get === 'function' ? HOST.get(name) : null
      } catch {
        return null
      }
    }

    function ensureTabType() {
      if (tabTypeRegistered) return true
      const tabs = service('sidebarRightTabs')
      if (!tabs || typeof tabs.register !== 'function') return false
      tabs.register({ id: TAB_TYPE_ID, kind: TAB_KIND, title: () => zh.title })
      tabTypeRegistered = true
      return true
    }

    function openBoardFromEntry() {
      const right = service('sidebarRight')
      if (right !== null && ensureTabType()) {
        try {
          right.openTab(TAB_KIND)
          return
        } catch {
          /* fall through to the launcher */
        }
      }
      const layout = service('layout')
      if (layout !== null) {
        try {
          layout.selectPanel(PANEL_ID)
        } catch {
          /* nothing else to try */
        }
      }
    }

    function BoardLauncher() {
      useStyles()
      const [error, setError] = react.useState(null)

      react.useLayoutEffect(() => {
        const layout = service('layout')
        if (layout === null) {
          setError('layout service unavailable')
          return
        }
        let attempts = 0

        const attempt = () => {
          const right = service('sidebarRight')
          if (right !== null && ensureTabType()) {
            try {
              right.openTab(TAB_KIND)
              return true
            } catch {
              /* the surface may not be mounted yet */
            }
          }
          return false
        }

        try {
          layout.selectPanel(null)
        } catch {
          /* keep going; the conversation may already be selected */
        }

        const retry = () => {
          if (attempt()) return
          attempts += 1
          if (attempts > 24) {
            console.warn('[dwguard-hmos] 右侧栏没有打开：sidebarRight 无可用的会话 surface')
            return
          }
          setTimeout(retry, 60)
        }
        setTimeout(retry, 30)
      }, [])

      if (!error) return null
      return h(
        'div',
        { className: 'dwg-root' },
        h(
          'div',
          { className: 'dwg-inner' },
          h(
            'div',
            { className: 'dwg-empty' },
            h('h2', null, zh.launcherError),
            h('p', null, zh.launcherErrorBody),
            h('p', { className: 'dwg-meta-line' }, error)
          )
        )
      )
    }

    function apply(ctx) {
      HOST = ctx
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dwguard-hmos: dictionaries')

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID }, () => h(BoardView, { compact: true }))
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => h(BoardLauncher)))
      ensureTabType()

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 5, locale: NS, label: () => zh.title },
          DshHomsIcon
        )
      )
    }

    exports.name = 'dwguard-hmos-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    exports.PANEL_ID = PANEL_ID
    exports.TAB_KIND = TAB_KIND
    return module.exports
  }
})
