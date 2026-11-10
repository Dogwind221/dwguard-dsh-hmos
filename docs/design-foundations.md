# 设计入门清单（0.9.4）

这份清单把设计原则、布局、色彩、字体、图标、动效、无障碍翻译成**可测代理**。
每一条都绑定现有 `DW-AES-*` / `DW-A11Y-*` 规则；不能指向规则和测量的“感觉”不收录。

来源索引：[`docs/design-guide/index.json`](design-guide/index.json)（167 篇官方设计文档的引用/摘要，不存正文）。

> 规则是验收口径；官方设计指南是方向与解释。两者冲突时，以可测规则为准，并把差异记为设计决策。

## 设计原则

### DF-PRINCIPLE-01 · 一屏一个主任务

首屏只保留一个主操作，主色只服务这个操作；次要操作降低视觉权重。

- 规则：`DW-AES-04` / `DW-AES-12`
- 可测：主按钮 ≤1 个；主色用于主操作；按钮宽度 ≤448vp，多按钮等宽且间距 12vp。
- 取证：布局树 bounds + 截图对照主色使用。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-PRINCIPLE-02 · 一致优于新奇

同类卡片、按钮、图标使用同一套圆角、间距、字号和层级。

- 规则：`DW-AES-03` / `DW-AES-21`
- 可测：同类卡片圆角同一值；卡片间距 ≥12vp；同组不混排不同结构。
- 取证：布局树 bounds + 设计 token 对照。
- 官方原文：[布局](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/design-layout-0000001748539680.md) / [通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-PRINCIPLE-03 · 反馈必须可解释

状态变化用文字/图标和动效共同表达，不让用户猜。

- 规则：`DW-A11Y-06` / `DW-AES-11`
- 可测：状态不只靠颜色；转场时长 ≥200/250/300ms 档位。
- 取证：状态截图 + 动效录屏/时间戳。
- 官方原文：[设计原则](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/animation-design-principles-0000001750237392.md) / [转场动效](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/transition-animation-0000001750078488.md)

### DF-PRINCIPLE-04 · 可读性优先于装饰

正文对比度、字号层级和留白先于背景纹理、阴影和装饰图形。

- 规则：`DW-A11Y-01` / `DW-AES-02` / `DW-AES-05`
- 可测：正文对比度 ≥4.5:1；全页 ≤4 级字号；标题与正文间距 ≥8vp，区块间距 ≥24vp。
- 取证：取样计算对比度 + 布局树字号/间距。
- 官方原文：[色彩](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/color-0000001776857164.md) / [通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

## 布局

### DF-LAYOUT-01 · 8vp 栅格与页边距

页面元素落在 8vp 栅格上；卡片边距 16vp、卡片间距 12vp 是默认起点。

- 规则：`DW-AES-01` / `DW-AES-05`
- 可测：左右边距 16vp；卡片间距 12vp；允许 4vp 半格。
- 取证：布局树 bounds 实测。
- 官方原文：[布局](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/design-layout-0000001748539680.md) / [响应式布局方法](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/design-responsive-layout-method-0000001795698449.md)

### DF-LAYOUT-02 · 标题栏与页签层级

单行标题栏默认 56vp；一级页不出现返回；底部页签 3–5 个。

- 规则：`DW-AES-16` / `DW-AES-17`
- 可测：标题栏 56/112vp；页签 3–5 个，图标 24vp，避让系统导航条。
- 取证：布局树 bounds + 截图。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-LAYOUT-03 · 多设备断点

手机、折叠屏、平板、电脑使用明确的断点与内容宽度，不靠拉伸适配。

- 规则：`DW-AES-07`
- 可测：每个断点声明的宽度/栏数生效；折叠态无内容遮挡或横向滚动。
- 取证：每族布局树 bounds + 截图。
- 官方原文：[电脑](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/2in1-0000001777531700.md) / [响应式布局方法](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/design-responsive-layout-method-0000001795698449.md) / [响应式应用架构](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/design-responsive-layout-structure-0000001748539684.md)

### DF-LAYOUT-04 · 列表行高与信息密度

效率型列表行高从 48/56/64/72/96vp 取值；内容型从 64/72/80/96/120vp 取值。

- 规则：`DW-AES-13` / `DW-AES-21`
- 可测：行高命中档位；右侧元素间距 12vp；同组卡片结构一致。
- 取证：布局树 bounds 实测。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

## 色彩

### DF-COLOR-01 · 语义色只表达语义

主色只用于主操作；成功/警告/错误三色与设计 token 一致，错误色不做装饰。

- 规则：`DW-AES-04`
- 可测：主色出现位置与主操作集合一致；错误色仅出现在错误态。
- 取证：截图取色 + token 对照。
- 官方原文：[色彩](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/color-0000001776857164.md)

### DF-COLOR-02 · 正文对比度

正文 ≥4.5:1，大字号 ≥3:1；深色模式同样按该阈值验证。

- 规则：`DW-A11Y-01` / `DW-AES-08`
- 可测：取样对比度 ≥4.5:1（正文）/≥3:1（大字）；深色模式逐 token 复核。
- 取证：截图取样计算 + 深色截图。
- 官方原文：[色彩](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/color-0000001776857164.md) / [通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-COLOR-03 · 状态不只靠颜色

错误、成功、禁用等状态同时使用图标或文案，不只改变颜色。

- 规则：`DW-A11Y-06`
- 可测：每个语义状态至少有一个非颜色编码（图标/文字/形状）。
- 取证：灰度截图 + 状态清单。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

## 字体

### DF-TYPE-01 · 四级字号层级

全页不超过四层：标题 24fp / 小标题 18fp / 正文 16fp / 说明 14fp。

- 规则：`DW-AES-02`
- 可测：全页字号种类 ≤4；层级与内容角色一致。
- 取证：布局树字号清单。
- 官方原文：[色彩](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/color-0000001776857164.md) / [通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-TYPE-02 · 字体放大不破版

系统字体 1.3x/1.75x/2x 时文字不截断、不重叠、不溢出容器。

- 规则：`DW-A11Y-05` / `DW-A11Y-13`
- 可测：三档字体下布局树无越界，截图无截断/重叠。
- 取证：每档字体布局树 + 截图。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-TYPE-03 · 文本输入有标签与错误位

输入框有标签/占位符，错误提示在框下，密码掩码，计数器显示已输入/上限。

- 规则：`DW-AES-14`
- 可测：标签/占位符存在；错误提示位于输入框下方；计数器存在。
- 取证：布局树 + 截图。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

## 图标

### DF-ICON-01 · 标准图标尺寸

标准图标 24×24vp（主体 22×22），描边 1.5vp；混排使用 SymbolSpan。

- 规则：`DW-AES-20` / `DW-AES-10`
- 可测：图标 bounds 24vp；描边 1.5vp；混排组件正确。
- 取证：布局树 bounds + 截图。
- 官方原文：[HarmonyOS Symbol](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/system-icons-0000001929854962.md)

### DF-ICON-02 · 图标按钮有可访问名称

纯图标按钮必须有 accessibilityText；装饰图设置无障碍忽略。

- 规则：`DW-A11Y-04` / `DW-A11Y-10`
- 可测：每个图标按钮有无障碍名称；装饰图不进入播报。
- 取证：无障碍树/布局树 + 读屏截图。
- 官方原文：[焦点导航](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/hmi-focus-0000001748650376.md)

### DF-ICON-03 · 应用图标规范

应用图标使用官方分层/尺寸规范，不拉伸、不重绘品牌资产。

- 规则：`DW-AES-10`
- 可测：图标资源 1024×1024 分层；无变形/裁切。
- 取证：资源元数据 + 桌面截图。
- 官方原文：[应用图标](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/application-icon-0000001953444009.md)

## 动效

### DF-MOTION-01 · 时长分级

短动画 150ms、短距离 250ms、长距离 350ms 以内；转场使用 200/250/300ms 档位。

- 规则：`DW-AES-11`
- 可测：实际时长命中对应档位；无拖沓的装饰性长动画。
- 取证：录屏逐帧/时间戳。
- 官方原文：[设计原则](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/animation-design-principles-0000001750237392.md) / [转场动效](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/transition-animation-0000001750078488.md)

### DF-MOTION-02 · 减少动态效果

系统开启“减少动态效果”时，非必要动效降级为淡入或直切。

- 规则：`DW-A11Y-07`
- 可测：reduced-motion 下无非必要位移/缩放动画。
- 取证：开关前后录屏/截图。
- 官方原文：[设计原则](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/animation-design-principles-0000001750237392.md)

### DF-MOTION-03 · 动效服务状态

动效必须解释层级、状态或空间关系，不做无意义循环装饰。

- 规则：`DW-AES-11` / `DW-A11Y-07`
- 可测：每个动效有触发条件、结束状态和可关闭方式。
- 取证：交互录屏 + 代码/交互清单。
- 官方原文：[设计原则](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/animation-design-principles-0000001750237392.md) / [转场动效](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/transition-animation-0000001750078488.md)

## 无障碍

### DF-A11Y-01 · 触控热区

可点击元素 ≥48vp×48vp，相邻目标间距 ≥8vp。

- 规则：`DW-A11Y-02`
- 可测：每个可点击元素 bounds 达标；相邻间距 ≥8vp。
- 取证：布局树 bounds。
- 官方原文：[通用应用 UX 体验标准](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/ux-guidelines-general-0000001760708152.md)

### DF-A11Y-02 · 焦点可见与顺序

键盘/遥控遍历时焦点框可见，顺序符合阅读顺序，不跳焦点、不丢焦点。

- 规则：`DW-A11Y-03` / `DW-A11Y-12`
- 可测：焦点顺序与视觉顺序一致；每一步焦点可见。
- 取证：焦点截图序列 + 布局树。
- 官方原文：[焦点导航](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/hmi-focus-0000001748650376.md)

### DF-A11Y-03 · 分组播报

卡片/整行用 accessibilityGroup(true) 合并播报，内部文字不逐个聚焦。

- 规则：`DW-A11Y-09`
- 可测：读屏一次读出整卡摘要，内部元素不单独停焦点。
- 取证：读屏录屏 + 无障碍树。
- 官方原文：[焦点导航](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/hmi-focus-0000001748650376.md)

### DF-A11Y-04 · 文本只讲是什么，操作放描述

accessibilityText 讲“是什么”，accessibilityDescription 讲“怎么操作”。

- 规则：`DW-A11Y-11`
- 可测：名称和操作描述分离；名称不含操作指令。
- 取证：无障碍树字段检查。
- 官方原文：[焦点导航](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/hmi-focus-0000001748650376.md)

