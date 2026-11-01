# 规则来源（citation）与官方语料

每条规则除了 `source`（规则家族标签）外，可以带一个 `citation`，指向**官方原文**：

```ts
citation: {
  label: '通用应用 UX 体验标准 2.1.3.3 点击热区（推荐 48vp，必须 ≥40vp）',
  url: 'https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md',
  section: '2.1.3.3',
  version: 'fetched 2026-10-31'
}
```

- `url`：官方 Markdown 源（华为 `llms` 索引里的 `.md`，或 OpenHarmony docs 的 GitHub blob）；
- `section`：标准编号或章节名，审计写报告时直接引用；
- `version`：华为页面抓取日期，或 OpenHarmony 的 git commit（`f41b934`）。

## 本地语料

| 语料 | 位置 | 规模 | 版本 |
| --- | --- | --- | --- |
| 华为设计文档 | `$DWG_DOCS_DIR/ux-design/`（默认 `~/harmony-docs/ux-design/`） | ~28 篇 / ~500 KB | `index.json` 内每篇 sha256 + 抓取时间 |
| OpenHarmony 开发文档 | `$DWG_DOCS_DIR/openharmony-docs/` | 675 篇 / 10.6 MB | commit `f41b934`（2026-05-26） |

检索（子代理用工具，不用记路径）：

```text
dwguard_rules list --dimension accessibility
dwguard_rules get --ruleId AGC-RJ-013
dwguard_rules search --query "点击热区"
```

命令行等价物：`node scripts/search-docs.mjs "点击热区" --limit=5`。语料目录默认读 `DWG_DOCS_DIR`，其次 `~/harmony-docs`，最后 `<workspace>/harmony-docs`；也可在插件配置里设 `docsDir`。

覆盖：**57 条规则中 48 条带 citation**（功能 21、审美 12、性能 11、无障碍 13）。没有官方出处的 9 条是 DwGuard 自定的验收口径（主路径、空态、幂等、状态恢复、图文比例、内存泄漏、定时器清理、非颜色编码、动效降级），保留 `source: 'DwGuard 验收规则'` 或扫描来源。

0.4 新增的官方引用：A11Y-09~13（无障碍分组/层级/提醒/焦点链/2x 字体）、STATE-02~09（V2 深度观测、V1/V2 混用、@Local 边界、@Param+@Event、@Monitor、@Computed、@Provider/@Consumer、V1→V2 迁移）、PERF-10~11（冷启动五阶段、超长帧）、AES-12（按钮 448vp/12vp）。

抓取入口（实测可用）：

- 华为：`https://developer.huawei.com/consumer/cn/llms/docs-ux-design.txt` 索引 → 每条 `.md` 链接返回完整 Markdown；
- OpenHarmony：`git clone --depth 1 --filter=blob:none --sparse https://github.com/openharmony/docs.git`，再 sparse-checkout 需要的主题目录。

> 直接抓 `developer.huawei.com` 的 HTML 页面拿不到正文（JS 渲染），只能走上面的 `.md`。

## 已引用（节选）

| 规则 | 官方依据 |
| --- | --- |
| `DW-A11Y-01` 对比度 | 通用 UX 标准 2.1.4.1：正文 4.5:1，图标/标题 3:1 |
| `DW-A11Y-02` 触控热区 | 通用 UX 标准 2.1.3.3：推荐 48vp，必须 ≥40vp |
| `DW-A11Y-04` 无障碍名称 | ArkUI 无障碍属性文档（`accessibilityText` 等） |
| `DW-AES-01` 栅格间距 | 间隔参数：屏幕边距 16/24/32/48vp 档位 |
| `DW-AES-07` 断点适配 | 折叠屏应用 UX 体验标准 |
| `DW-AES-08` 深色模式 | 通用 UX 标准 2.2.5 |
| `DW-AES-10` 图标 | 通用 UX 标准 2.1.4.3.1：1024×1024、分层 |
| `DW-AES-11` 转场时长 | 通用 UX 标准 2.1.5.2.2：≥200/250/300ms |
| `DW-AES-03/04/05` 圆角/色彩/留白 | 圆角参数、色彩、间距参数三篇设计文档 |
| `DW-PERF-08` Column/Row 替代 Flex | OpenHarmony 性能优化建议 |
| `DW-PERF-09` 列表组件复用 | 性能优化指导 · 列表场景 |
| `DW-A11Y-08` 无障碍文本只写功能简述 | ArkUI 无障碍属性 · accessibilityText |
| `DW-FN-03` 错误态重试 | AGC-RJ-018 |
| `DW-FN-12` 状态观察范围 | `arkts-state.md`：Array 的 push/pop 可观察；嵌套属性赋值不可观察 |
| `DW-PERF-06` LazyForEach | 列表开发指导 · 使用 LazyForEach 创建 ListItem |

## 一次真实的规则修正

旧扫描规则 `STATE-002` 认为「`@State` 数组就地 `push` 不刷新」——**这是过时结论**。
OpenHarmony 现行文档（`ui/state-management/arkts-state.md`）明确写：

> 当装饰的对象是 Array 时，可以观察到 Array 整体的赋值及数组元素的赋值，同时可以通过调用 Array 的接口
> `push`、`pop`、`shift`、`unshift`、`splice`、`copyWithin`、`fill`、`reverse`、`sort` 更新 Array 中的数据。
> **数组项中嵌套的属性赋值无法观察。**

因此：

- 删除 `STATE-002`（会误报正确代码）；
- 新增 `STATE-NESTED-01`：`this.user.profile.name = …`、`this.items[i].name = …` 这类嵌套赋值才是真问题；
- 测试显式断言 `this.items.push(1)` **不得**被报为状态 bug。

这正是「规则库必须能追到官方原文」的价值：没有 citation 的规则，错了也没人知道。
