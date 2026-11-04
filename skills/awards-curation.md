# 奖项 → 可执行设计卡策展

把 Apple Design Awards、iF DESIGN AWARD、Core77、A' Design Award 等获奖/入围作品，
变成 DwGuard 设计库里**可检索、可对照、可审计**的卡片。核心不是“让 AI 看获奖作品感悟”，
而是完成一次翻译：**抽象原则 → UI 动作 → 可测代理 → 设备证据**。

## 1. 先分清三种卡

| 卡 | 命名空间 | 负责 | 是否可硬判 |
| --- | --- | --- | --- |
| principle | `PR-*` | 方向、气质、取舍（留白/节奏/材质诚实…） | 不硬判；必须有可测代理 |
| pattern | `DSG-*` | 布局、tokens、Do/Don't、checklist | 可做 `designRefs` 对照 |
| anti-pattern | `AP-*` | 明确禁止项与误用 | 可做 `antiPatternRefs` 硬闸门 |

奖项本身是**参考证据**，不是验收标准；不要把获奖产品名直接写成 `DSG` 卡。

## 2. 来源与版权（先做这一步）

- 只记录事实、原则、token、链接与自己的分析；**不要**批量复制官方截图、大段描述或作品图。
- 卡片必须带 `source { kind, ref, license }`；`license: unknown` 默认不进检索。
- 遵守奖项站点的 ToS/robots；优先人工整理或你已获授权的数据，不绕过限制。
- 每张卡记录：奖项名、年份、类别、获奖/入围、来源 URL、检索日期（可写在 tags 或 evidence）。
- 图片只在有明确授权时放进 `design-library/inbox/`；否则只存链接。

## 3. principle 卡模板

```jsonc
{
  "kind": "principle",
  "title": "负空间即注意力预算",
  "principle": "留白不是空，是引导视线和降低认知负荷的手段",
  "perceptualEffect": "安静、聚焦、高级感",
  "proxies": ["空白占比 ≥ 35%", "首屏主操作 = 1", "字号级数 ≤ 3"],
  "applications": ["阅读类首屏", "会员中心", "数据看板空态"],
  "misuses": ["为了留白牺牲信息密度", "在工具型界面强行极简"],
  "checklist": ["首屏只有一个主 CTA", "正文/背景对比 ≥ 4.5:1"],
  "dimensions": { "appType": "阅读", "platform": "harmonyos", "style": "极简" },
  "tags": ["ADA-2026", "principle", "reading"],
  "source": { "kind": "official", "ref": "https://…", "license": "link-only" }
}
```

硬规则：**至少一个 `proxies` 或 `checklist` 项**；没有可测代理的原则卡不允许入库
（ingest 会跳过并警告）。原则正文写“为什么/何时成立”，不要写“要好看”。

## 4. pattern 卡模板

```jsonc
{
  "kind": "pattern",
  "title": "阅读类 · 单列大字号 + 渐进披露",
  "summary": "一屏只推进一个层级，正文大字号、行高宽松",
  "rationale": "降低认知负荷，让长文阅读可持续",
  "tokens": {
    "palette": [{ "name": "bg", "value": "#FAF8F4" }],
    "type": [{ "name": "body", "value": 17, "unit": "vp" }],
    "spacing": [{ "name": "page", "value": 24, "unit": "vp" }],
    "radius": [{ "name": "card", "value": 16, "unit": "vp" }]
  },
  "stylePriority": ["极简主义", "高对比"],
  "checklist": ["首屏只有一个主操作", "深色模式对比度 ≥ 4.5:1"],
  "antiPatterns": ["AP-0003"],
  "dimensions": { "appType": "阅读", "platform": "harmonyos", "style": "极简" },
  "source": { "kind": "user", "ref": "策展：ADA-2026 阅读类作品归纳", "license": "internal" }
}
```

一条记录只描述**一个可复用模式**；同一模式至少 2 个作品支撑才提高权重，
避免把单个产品的品牌偶然特征当成通用规则。

## 5. anti-pattern 卡模板

```jsonc
{
  "kind": "anti-pattern",
  "title": "装饰性动效压过内容",
  "rationale": "动画不服务空间连续性/状态解释时，会拖慢任务并干扰阅读",
  "checklist": ["动效有明确目的与退出路径", "尊重减少动态效果设置"],
  "dimensions": { "platform": "harmonyos" },
  "source": { "kind": "user", "ref": "评审复盘 + HIG", "license": "internal" }
}
```

## 6. 执行流程

1. **收集**：按奖项/年份/类别整理候选，记录 URL 与许可，不直接抓站。
2. **拆模式**：每个候选问：解决什么问题？哪些规则可迁移？哪些只是品牌特征？
3. **翻译**：原则 → 2–3 个 UI 动作 → 至少一个可测代理；写清误用。
4. **入库**：
   ```text
   .shared/design-library/inbox/<name>.meta.json
   dwguard_design library ingest sources:["inbox"]
   dwguard_design pack export packName:"awards-2026"   # 版本化
   ```
5. **基准**：用 `benchmarks/awards-2026.json` 的 20 条查询跑 top-3；
   miss 记入知识/校准，调 tags、同义词、weight，不靠“感觉”。
6. **应用**：`brief` 会分两路注入 principle（方向）和 pattern（实现）；
   审美判据用 `designRefs`（pattern）与 `principleRefs`（原则对照）；
   AP 通过 `antiPatternRefs` 或 pattern 继承进审计。

## 7. 质量闸门

- principle：有原则陈述 + 至少一个 proxy/checklist + 至少一个 misuse；
- pattern：有 tokens 或 checklist + 至少一个 dimension + 明确的 do/don't；
- AP：写清触发场景与替代做法，不写“禁止丑”；
- 所有卡：source license 明确，标签能追到奖项/年份；
- 不把奖项当验收证据；验收仍以设备取证 + 用户确认为准。

## 8. 常见错误

- 把“获奖作品截图”当 token 来源（版权 + 平台错配）；
- 把产品名当模式名（无法复用）；
- 原则没有可测代理（不可证伪）；
- 把 ADA 的 iOS 交互直接套 HarmonyOS（需按平台维度重验）；
- 只收 winner、不看 finalist（幸存者偏差）；
- 用奖项数量当审美分数（奖项不是因果）。
