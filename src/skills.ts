/**
 * The four bundled skills.
 *
 * Bodies live in `skills/*.md` so they can be read, reviewed and edited like
 * ordinary documentation. They are loaded synchronously at module load; a
 * missing file degrades to a compact built-in body instead of failing boot.
 *
 * @module dwguard-dsh-hmos/skills
 */

import { readFileSync } from 'node:fs';

/** One bundled skill. */
export interface BundledSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly content: string;
}

interface SkillSource {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly file: string;
  readonly fallback: string;
}

const SOURCES: readonly SkillSource[] = [
  {
    name: 'dwguard-hmos',
    description:
      'DSH 侧鸿蒙双 Agent 编排协议：任务包、派发前对抗预审、DevEco Code Goal 模式派发、四维外部审计、返工与知识沉淀。任何 HarmonyOS / ArkTS / ArkUI / DevEco 需求都先加载它。',
    whenToUse:
      '用户提出鸿蒙应用/元服务/ArkTS 需求，或要求验收、返工、审计鸿蒙交付物，或提到 DevEco Code 时。',
    file: 'dwguard-hmos.md',
    fallback: `# DwGuard · 鸿蒙双 Agent 编排协议

DSH 负责写任务包、预审、派发、独立审计；DevEco Code 负责编码与自验。二者只通过 \`.shared/\` 协作。

阶段：\`dwguard_spec\`（冻结任务包，四维判据）→ \`dwguard_prereview\`（对抗预审）→ \`dwguard_dispatch\`（Goal 简报）→ \`dwguard_audit\`（独立取证）→ \`dwguard_knowledge\`（沉淀）。

硬规则：DSH 不写应用代码；没有四维判据不派发；没有通过预审不派发；审计必须自己取证；返工单只列失败项。`
  },
  {
    name: 'hmos-acceptance-rubric',
    description:
      '把模糊的鸿蒙需求写成可证伪的四维验收标准：功能/审美/性能/无障碍的判据模板、规则 ID（DW-FN/AES/PERF/A11Y）与阈值。配合 dwguard_spec 使用。',
    whenToUse: '需要写或审查鸿蒙任务的验收标准、判断某条判据是否可证伪时。',
    file: 'hmos-acceptance-rubric.md',
    fallback: `# 鸿蒙验收标准写法

三条铁律：可观察、可反驳、有证据。

- 功能：给定-当-则；覆盖空态/错误/权限/返回栈。
- 审美：写成间距、字号、圆角、对比度的具体值 + 规则 ID，禁用"美观"。
- 性能：带数值与测量方式（首帧 ≤ 800ms、丢帧 ≤ 2 帧/秒）。
- 无障碍：对比度 ≥ 4.5:1、触控 ≥ 48vp、焦点可见、可访问名称、字体放大不截断。`
  },
  {
    name: 'hmos-audit-playbook',
    description:
      '鸿蒙交付物的外部审计取证手册：hdc 截图/布局树/日志/性能采集命令、四维逐条检查、假通过清单、审计子代理角色提示词。配合 dwguard_audit 使用。',
    whenToUse: 'DevEco Code 交付后需要独立取证、填写 dwguard_audit 的 checks，或要派审计子代理时。',
    file: 'hmos-audit-playbook.md',
    fallback: `# 鸿蒙外部审计取证手册

1. 先取证再看交付记录。
2. 截图：\`hdc shell snapshot_display -f /data/local/tmp/shot.jpeg\` + \`hdc file recv\`。
3. 布局树：\`hdc shell uitest dumpLayout -p /data/local/tmp/layout.json\`，量 48vp 与可访问名称。
4. 日志：\`hdc shell "hilog | grep -iE 'error|exception'"\`；崩溃看 \`/data/log/faultlog/faultlogger/\`。
5. 性能：DevEco Profiler 启动/帧率/内存 + 包体大小。
6. 无障碍：对比度计算、触控尺寸、焦点走查、字体放大重截。
7. 每条判据一段证据；禁止用执行者截图。`
  },
  {
    name: 'awards-curation',
    description:
      '把 Apple Design Awards / iF / Core77 / A\' Design 等获奖作品策展成 principle（PR-*）、pattern（DSG-*）与 anti-pattern（AP-*）卡：字段模板、版权规则、原则→可测代理翻译、基准查询与质量闸门。',
    whenToUse: '要学习奖项/传统艺术/装置艺术并沉淀为设计卡，或要判断一个“审美原则”能否进入验收流程时。',
    file: 'awards-curation.md',
    fallback: `# 奖项 → 可执行设计卡策展

- principle（PR-*）给方向：必须有 principle + 至少一个 proxy/checklist + misuse；
- pattern（DSG-*）给实现：tokens/checklist/dimensions/Do-Don't；
- anti-pattern（AP-*）给闸门：写清触发场景与替代做法；
- 只存事实、原则、token、链接；截图/描述需授权，license 不明默认不进检索；
- 一条卡一个模式，至少 2 个作品支撑再提权重；奖项是参考不是验收标准。`
  }
];

function readBody(source: SkillSource): string {
  try {
    return readFileSync(new URL(`../skills/${source.file}`, import.meta.url), 'utf8');
  } catch {
    return source.fallback;
  }
}

/** Load every bundled skill (bodies from disk, fallback when unavailable). */
export function loadSkills(): BundledSkill[] {
  return SOURCES.map((source) => ({
    name: source.name,
    description: source.description,
    whenToUse: source.whenToUse,
    content: readBody(source)
  }));
}
