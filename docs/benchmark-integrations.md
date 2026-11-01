# 与 dsh-collaboration / dsh-deveco / harmonyos-ai-workspace / hmharness 的对比与借鉴

> 结论先行：**我们最强的是"闸门"，最弱的是"证据的客观性"与"规则库的广度"**。
> 四个参考项目分别补的是：协作协议（dsh-collaboration）、结构化 UI 证据（dsh-deveco）、
> 领域规则库与静态扫描（harmonyos-ai-workspace / harmonyos-skills）、验证纪律（hmharness）。
> 不建议整套引入任何一个——借鉴协议与数据格式，比引入运行时更划算。

## 1. 四个参考项目是什么

| 项目 | 形态 | 核心能力 | 与我们的关系 |
| --- | --- | --- | --- |
| [`dsh-collaboration`](https://github.com/Socialist-Sister/dsh-collaboration) | DSH 多智能体套件（宿主 + 工具包） | 十种专家身份、每人独立工具面与模型、`team_call` 雇佣持久实例/分身、`team_message` 星型中转、`roundtable` 并行圆桌、视觉桥 | 借鉴**角色=工具面+模型**的配置思想与星型中转协议；不引入其运行时 |
| [`dsh-deveco`](https://github.com/MoonlitDropOfBlood/dsh-deveco) | DSH 插件（右侧栏 + agent 工具） | HiLog 流、ArkUI Inspector、`.ets` 查看器、设备管理，以及 **`harmony_ui_tree`**：返回缩进树文本或 JSON（组件名、bounds、文本、padding/margin/border **声明值**、childCount） | 直接补我们的"审美/无障碍证据"缺口 |
| [`harmonyos-ai-workspace`](https://github.com/Octo-o-o-o/harmonyos-ai-workspace) | 鸿蒙 app 的 AI 规则安装器（`npx`） | 4 层共 ~155 条：32 条扫描规则、75 条审查清单（稳定 ID 如 `STATE-002`）、20 条 AGC 拒因（`AGC-RJ-*`）、28 条 OHPM 伪包黑名单；PostToolUse 钩子；`build → install → run → hilog` 调试闭环；API 版本契约 | 借鉴**规则 ID 体系与静态扫描**；只读其规则，不跑它的安装器 |
| [`harmonyos-skills`](https://github.com/coreylyn/harmonyos-skills)（及其[文档镜像版](https://github.com/liasica/harmonyos-skills)） | Agent Skills 规则包 | 面向 HarmonyOS 开发与代码审查的 Skill，基于官方开发指南 | 作为规则库的补充来源 |
| [`hmharness`](https://github.com/swsgbl/hmharness) | 独立自进化 Agent 运行时 | 双门（训练门 A/B + 保留门复验）、校准（每动作预测可靠度）、不可变审计日志、证据数据集、MCP 导出、跨环境迁移实验 | 借鉴**验证纪律**（双门/校准/可复现证据）；不引入其运行时 |

> 本机现状：当前 DSH profile 里没有安装 `dsh-deveco` / `dsh-collaboration`（`profiles/node_modules/@deepseek-ai` 只有官方包）。
> `harmonyos-ai-workspace` 的安装器会往 app 仓库写文件，**与"DSH 不碰应用源码"的边界冲突**，所以只取其规则文本。

## 2. 我们现在的框架

`.shared/` 协议 + 7 个工具 + 3 个 Skill + 右侧栏看板：

- 任务包（四维判据、must/should、specVersion）→ 派发前对抗预审（阻断项必须带反驳）→ Goal 简报派发；
- DevEco 执行（编码/构建/推设备/自验）→ 影子审查（只读）→ 自评/澄清闸门 → 交付；
- DSH 外部审计：四维逐条 `checks` + 证据 + 闸门（must 全覆盖、四维全评估、无 open blocker/major）；
- 返工单只列失败项 → 知识沉淀 → 用户确认；
- 看板实时展示阶段、并行模块、四维子代理进度。

**这是四个参考项目都没有的东西**：它们提供工具/规则/运行时，**没有一个是"交付验收闸门"**。

## 3. 逐项对比

| 维度 | 我们 | dsh-collaboration | dsh-deveco | harmonyos-ai-workspace | hmharness |
| --- | --- | --- | --- | --- | --- |
| 角色隔离 | 约定级：Prompt/Skill 规定 DSH 不写 `entry/**`，但工具面没有强制 | **结构级**：审查员只读、工程师可写，按身份配工具面 | 插件只读展示，不写应用代码 | 只写规则文件，不改业务代码 | 角色契约 + 共享预算 |
| 协作协议 | `.shared/` 文件 + `## [ts]` 记录，无 ID/ack/租约 | 星型中转 + 实例 + 追问/转发 | 无（单机工具） | 无 | 多智能体治理 + 审计前缀 |
| 规则库 | 自建 DW-FN/AES/PERF/A11Y，几十条，随插件更新 | 无领域规则 | 无（提供数据） | **~155 条 + 稳定 ID + 版本契约** | 无鸿蒙领域规则 |
| UI 证据 | 截图 + `read_image` 人工判断 | 视觉桥（看图） | **结构化树**（bounds/文本/声明值/childCount） | 无 | 无 |
| 代码静态检查 | 只有"看代码" | 无 | 无 | **32 条扫描器 + 伪包校验** | lint/LSP 传感器 |
| 证据可复现 | 文字证据（路径/命令/数值），无哈希、无归档目录 | 无 | 树可导出 | 扫描输出可落盘 | **不可变审计日志 + 证据数据集** |
| 闸门 | **有**（四维 + must + blocker 反驳） | 无 | 无 | 无 | 无（有门禁的是进化候选） |
| 学习闭环 | 追加式知识（纯文本、无验证） | 无 | 无 | 规则版本更新 | **双门 + 校准 + 回滚**（自证"30 天零显著晋升"） |
| 可视化 | **有**（阶段/并行/子代理） | 团队面板 | Inspector | 无 | 认知面板 |

## 4. 我们的短板（诚实版）

1. **隔离是"君子协定"**。DSH 的 `write`/`edit` 工具能写 `entry/**`，只靠 Prompt 约束；
   DevEco 也能改 `.shared/` 里的任务包或交付记录，没有租约、没有消息 ID、没有 ack。
2. **UI/审美证据靠截图猜**。没有组件树就没有 bounds、没有声明值、没有 childCount，
   "间距一致、触控目标够大、没有截断"只能靠眼睛——这正是我们要求 DevEco 不许自证、
   自己却用主观证据的地方。
3. **规则库太窄**。`STATE-002`（数组就地 mutation 不重渲染）、`@kit.*` vs `@ohos.*`、
   V1/V2 混用、OHPM 伪包这些"LLM 在 ArkTS 上的高频坑"，我们的判据里没有稳定覆盖。
4. **证据不归档**。审计报告写"截图 artifacts/xxx.png"，但没有哈希、没有 manifest、
   没有设备/pid/时间戳，复核时无法证明"这张图就是那次审计的"。
5. **知识不验证**。`knowledge/*.md` 只增不验，无法判断一条经验是真有效还是幸存者偏差；
   hmharness 的双门与校准正是治这个。
6. **没有自己的准确率**。我们不知道四维闸门漏检率多少——"通过了但用户后来发现有 bug"
   这件事没有记录。

## 5. 借鉴清单

### P0 · 不依赖外部插件，先把自己的证据变硬

> 进度：**P0-1 证据包**、**P0-2 静态扫描**、**P0-3 规则 ID 目录**（`src/rules.ts`，`dwguard_spec` 校验
> `ruleId`，`dwguard_scan` / findings 共用 ID）、**P0-4 协议 v2**（`dispatch · #d-N · from/to · re` 封套、
> 回执与「未回执派发」检测）均已落地，测试 25 个全过。

**P0-1 证据包（evidence bundle）**

每次 `dwguard_audit` 生成 `artifacts/audit-<n>/`：

```jsonc
// manifest.json
{
  "auditId": 2,
  "specVersion": 2,
  "generatedAt": "2026-10-31T10:00:00+08:00",
  "delivery": { "outboxEntry": "…", "sha256": "…" },
  "evidence": [
    { "criterionId": "A-02", "kind": "ui-tree", "file": "ui-tree.json", "sha256": "…",
      "source": "dsh-deveco:harmony_ui_tree", "device": "…", "capturedAt": "…" },
    { "criterionId": "F-01", "kind": "screenshot", "file": "home.png", "sha256": "…" }
  ]
}
```

- `checks` 里新增 `evidenceFiles: string[]`；工具校验文件存在 + 哈希匹配，缺证据的 `must` 判据直接不算通过；
- 报告只引用证据包内文件，外部路径一律不收。

**P0-2 独立静态扫描（function 维度）**

- 把 ArkTS 高频坑做成我们自己的检查清单（对标 32 条扫描规则的高价值子集）：
  `STATE-002` 数组就地 mutation、`@kit.*`/`@ohos.*`、`any`、解构/索引签名、V1/V2 混用、
  `aboutToAppear`/`disappear` 配对、OHPM 伪包名（参照 `@os/dayjs` 这类陷阱）。
- 审计时**自己跑一遍**（grep + 规则），命中记成 finding（`ruleId` + `文件:行` + 证据），
  不再只靠"我看了代码"。

**P0-3 规则 ID 注册表**

- `skills/hmos-acceptance-rubric.md` 增加映射表：我们的 `DW-FN-01` ↔ 上游 `STATE-002`、
  `DW-A11Y-02` ↔ 触控目标 44vp 等；新判据必须引用至少一个规则 ID，或写明"自定义 + 理由"。
- 不照搬 75 条全量，按维度各取 8–12 条高价值项，保持闸门可执行。

**P0-4 协议 v2 封套（借 dsh-collaboration 的星型中转）**

```markdown
## [2026-10-31T10:02:11+08:00] deliver · #d-014 · from=deveco to=dsh · re=#q-007
```

- 每条出站/入站记录带 `id / kind / from / to / replyTo`；`kind` 取
  `dispatch | ack | deliver | question | answer | blocked | shadow-risk`；
- `dwguard_status` 能发现"发出未 ack 超时"；DSH 是唯一枢纽，DevEco 不直连其他 agent；
- 我们已有 `## [ts]` 记录，升级成带 ID/回执即可，不引入新运行时。

### P1 · 接 dsh-deveco 的结构化证据

**P1-1 `harmony_ui_tree` 作为审美/无障碍的一等证据**

- 装了 `dsh-deveco` 时，审计先取树（`format=json`、`include_attrs`），再截图；
- 可机器判定的检查：触控目标 ≥ 44vp、越界/重叠、文本截断（`maxLines` 与文本长度）、
  padding/margin 声明值是否符合设计、组件树层级是否与任务包 UI 结构一致；
- **来源标注**：DevEco 调试树有声明值，uitest/无障碍树没有 padding/margin——缺值时明确写
  "该源不提供"，不编造；
- 降级：没有调试包或 Inspector 被占用时，退回 uitest 树 + 截图，并在报告里注明证据等级。

**P1-2 功能 E2E**

- 用 tap/swipe/text 复现任务包的"关键交互"步骤，每步抓 tree 快照 + 截图，
  断言页面/文本出现；作为 `F-*` 证据（比"看代码说它能跑"硬）。

### P2 · 借 hmharness 的验证纪律

**P2-1 校准账本**

`knowledge/calibration.jsonl`：每轮记录 `{round, auditId, dimension, verdict, laterOutcome}`。
用户后续报 bug / 返工原因可回填，按月算**漏检率**；看板显示"闸门历史准确率"。
这比"再观察一下"有用：它让闸门本身可被审计。

**P2-2 知识双门**

- 训练门：一条经验先在 2 个历史 case 上复测（能解释/能预测才算过）；
- 保留门：采纳后复验，回归就回滚；
- 只写 `knowledge/`，不碰内核——与 hmharness 的"进化只写技能与记忆"一致。
- **注意**：hmharness 自己的 30 天报告写明"零统计可靠晋升"，所以别学它的叙事，
  学它的门与日志。

**P2-3 MCP 导出**

把 `dwguard_*` 审计工具以 MCP 暴露给其他宿主（Claude Code / Codex / Cursor），
别人也能用我们的闸门——对应 hmharness 的 `mcp-serve` 思路。

## 6. 不建议照搬

| 不搬 | 原因 |
| --- | --- |
| dsh-collaboration 整套团队运行时 | 我们已有原生 subagent；再引入专家名册/实例/中转会重复角色、抬高上下文成本。只借"身份=工具面+模型"的配置思想 |
| harmonyos-ai-workspace 的安装器与钩子 | 它往 app 仓库写 `CLAUDE.md`/`tools/`，违反"DSH 不碰应用源码"边界；规则文本可读、可引用，安装器不跑 |
| hmharness 的"自进化"叙事 | 其自证 30 天零显著晋升；我们只借双门、校准、不可变日志 |
| dsh-deveco 的单一调试树依赖 | 调试树需要 debug 包且独占 DevEco Inspector socket；必须有 uitest/无障碍树降级，否则审计在发布包上不可用 |

## 7. 落地顺序与验收

| 步骤 | 交付物 | 验收（可证伪） |
| --- | --- | --- |
| 1 | 证据包 + `checks.evidenceFiles` 校验 | 缺文件/哈希不符时 `must` 判据不能 pass（测试用例覆盖） |
| 2 | 静态扫描清单 + 命中即 finding | 对一个含 `this.list.push(x)` 的样例，审计必须报 `STATE-002` |
| 3 | 规则 ID 映射 | 任务包中每条判据都能追到规则 ID 或"自定义+理由" |
| 4 | 协议 v2 封套 | 发一条 dispatch，DevEco 回 ack；`dwguard_status` 能显示未回执项 |
| 5 | `harmony_ui_tree` 证据 | 同一条 A-* 判据：有树时给出 bounds 数值，无树时标注"证据等级：截图" |
| 6 | 校准账本 | 连续 10 轮审计后能算出四维漏检率（哪怕样本很小） |

## 8. 参考

- dsh-collaboration — <https://github.com/Socialist-Sister/dsh-collaboration>（[插件页](https://dshplugin.online/zh/plugins/socialist-sister--dsh-collaboration)）
- dsh-deveco（`harmony_ui_tree`）— <https://github.com/MoonlitDropOfBlood/dsh-deveco>
- harmonyos-ai-workspace — <https://github.com/Octo-o-o-o/harmonyos-ai-workspace>
- harmonyos-skills — <https://github.com/coreylyn/harmonyos-skills>（[文档镜像](https://github.com/liasica/harmonyos-skills)）
- hmharness — <https://github.com/swsgbl/hmharness>

## 9. 对"官方文档 + 获奖 UI"建议的吸收

外部建议（RAG 官方文档、Design Token、Few-shot、人工打分飞轮）归纳为 **4 采纳 / 3 改造**：

| 建议 | 决定 | 落点 |
| --- | --- | --- |
| 官方文档做成知识库，预审/审计时检索引用 | **采纳** | 插件内 `rules/` 语料：稳定 ID + 官方来源 + 版本 + 验证方式；检索先走关键词/章节索引 |
| 审美量化为 Design Token（栅格/间距/对比度/字号层级） | **采纳** | `skills/hmos-acceptance-rubric` 增补可测量判据（8pt 栅格、44vp 触控、对比度） |
| 人类专家打分 → 写回知识 → 下次加载 | **采纳（加约束）** | 裁决必须带证据与范围；配合 P2 校准账本记"判定 vs 后续结果" |
| 别把几十万字塞进上下文；审美不能压过功能 | **采纳** | 规则按维度按需检索；四维 must 全过，优先级只影响呈现与返工排序 |
| 用向量库（Chroma/FAISS）做 RAG | **改造** | 规则只有几十到几百条时，结构化解片 + 关键词检索足够；上千条再评估 embedding，避免引入 Python 运行时依赖 |
| 用"优秀截图 + ArkUI 代码"做 Few-shot | **改造** | 文本模型对比截图不稳；改为**结构证据 + 数值**（`harmony_ui_tree` 的 bounds/padding），few-shot 用"判据 + 正反 checks" |
| 官方规则放 `.shared/knowledge/` | **改造** | 官方规则随插件版本走（`skills/`），`.shared/knowledge/` 只放**项目裁决与教训**，避免每个 workspace 复制漂移 |
