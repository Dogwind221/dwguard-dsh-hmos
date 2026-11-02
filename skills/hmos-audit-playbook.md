# 鸿蒙外部审计取证手册

> 上架合规检查见 `docs/agc-publishing.md`；冷启动/帧率基线模板见 `docs/perf-baseline.md`。

审计的价值取决于证据的独立性。这份手册是 `dwguard_audit` 的取证流程：每条判据都对应一段你能自己复现的证据。

> 命令以 HarmonyOS NEXT / API 12+ 的 `hdc` 为例。不同 API 版本、设备与 Windows 终端可能有差异；命令不可用时改用 DevEco Studio 对应面板，并在证据里注明"替代来源"。

## 0. 四条独立性原则

1. **先取证，再看交付记录。** 先自己跑一遍并记下结果，再读 `outbox-deveco.md`，避免被执行者的结论锚定。
2. **一次交付 = 一轮证据。** 不用上一轮的截图证明这一轮。
3. **一条判据一段证据。** 一张首页截图不能证明 8 条判据。
4. **记录环境。** 机型、系统版本、`compatibleSdkVersion`、字体档、深/浅色模式，缺一项证据就打折。

## 1. 设备与安装

```powershell
hdc list targets                                   # 设备在线？
hdc shell bm dump -n <bundleName>                  # 包是否安装、版本号
hdc shell aa start -a EntryAbility -b <bundleName> # 冷启动
```

Windows PowerShell 里参数被拆散时，把整条命令包成一个字符串：`hdc shell "bm dump -n <bundleName>"`。

## 2. 截图（功能 / 审美 / 无障碍共用）

```powershell
hdc shell snapshot_display -f /data/local/tmp/dwguard-shot.jpeg
hdc file recv /data/local/tmp/dwguard-shot.jpeg .\artifacts\shots\F-01-main.jpeg
```

- 命名：`<判据ID>-<状态>.jpeg`，例如 `F-02-empty.jpeg`、`X-01-contrast.jpeg`。
- 每个页面至少三张：主路径、空态或错误态、深色模式。
- `snapshot_display` 不可用时用 DevEco 的截图面板 / 模拟器截图，证据里写清来源。

## 3. 布局树（尺寸 / 层级 / 无障碍属性）

```powershell
hdc shell uitest dumpLayout -p /data/local/tmp/dwguard-layout.json
hdc file recv /data/local/tmp/dwguard-layout.json .\artifacts\layout\home.json
```

从布局树里取：

- `bounds`：量 48vp 触控目标、间距、元素尺寸（注意设备 density，vp = px / density）；
- `accessibilityText` / `accessibilityLevel`：纯图标按钮是否有名称；
- 层级与顺序：与视觉/阅读顺序是否一致。

### 3.1 设备 UI 证据（装了 DevEco CLI 时优先）

`dwguard_deveco` 直接调真实工具链，产物自动落 `.shared/artifacts/`，可直接写进审计 `evidenceFiles`：

```text
dwguard_deveco(action="screenshot")   # → artifacts/devshots/shot-*.png
dwguard_deveco(action="layout")       # → artifacts/deveco-<n>/layout.json（含 bounds）
dwguard_deveco(action="a11y")         # → a11y.json + a11y-summary.json（布局树 + 静态扫描）
dwguard_deveco(action="verify", plan="点击打卡，期望连续天数 +1", bundle="com.example.app")
```

- 截图 1MB 级、布局树 40KB 级，远低于 20MB/100MB 证据上限；
- 多设备时必须传 `device`（名称或序列号）；
- `verify` 第一次用前先 `devecocli verify init` 配视觉模型。

> Windows 中文用户名下模拟器可能打不开 `system.img`；把镜像/实例放到 ASCII 路径（junction 或 `-imageRoot`/`-instancePath`）再启动。

### 3.2 状态管理 V2 代码审查

| 检查 | 违规示例 | 规则 |
| --- | --- | --- |
| `@ObservedV2` 只装饰 class | `@ObservedV2 struct X` / 装饰组件 | DW-STATE-02 |
| UI 用到的字段都有 `@Trace` | 类里字段无 `@Trace` 却在 `build()` 里读 | DW-STATE-02 |
| V1/V2 不混用 | `@ObservedV2` 类上再挂 `@State`；V1 组件接 V2 实例 | DW-STATE-03 |
| `@Local` 只在 `@ComponentV2`、不能外部初始化 | 父组件 `Child({ message: ... })` 给 `@Local` 传值 | DW-STATE-04 |
| V2 父子通信 | 子组件用 `@Link` 而不是 `@Param` + `@Event` | DW-STATE-05 |
| `@Monitor` 范围 | 监听普通字段或未 `@Trace` 的嵌套属性；监听类对象却指望属性变化触发 | DW-STATE-06 |
| `@Computed` 纯度 | 在 getter 里改依赖/发请求/写状态；给 `@Computed` 赋值 | DW-STATE-07 |
| `@Provider/@Consumer` | 装饰 class 属性、从外部传值初始化、在 `@Component` 中使用 | DW-STATE-08 |
| V1→V2 迁移 | 一个组件里同时混 V1/V2 装饰器；迁移顺序错乱 | DW-STATE-09 |

命令行无法判定的，按代码位置 + 编译错误截图取证，不要"读一遍觉得对"就写 pass。

## 4. 日志与崩溃

```powershell
hdc shell hilog -x                                   # 清日志（部分版本支持）
hdc shell "hilog | grep -iE 'error|exception|crash'"  # 关键路径复现时的日志
hdc shell ls /data/log/faultlog/faultlogger/          # 崩溃记录
hdc file recv /data/log/faultlog/faultlogger/<file> .\artifacts\logs\
```

`hilog` 的参数随版本变化，不确定时先 `hdc shell hilog -h`。证据里贴关键几行，不要贴整个日志。

## 5. 性能

| 指标 | 采集方式 | 证据形式 |
| --- | --- | --- |
| 冷启动 | DevEco Profiler「启动分析」；或 hilog 中 Ability 创建到首帧的时间戳差 | 截图 + 毫秒数（3 次取中位数） |
| 列表帧率 | Profiler 帧率图 + 滚动录屏 | 截图 + 丢帧描述 |
| 内存 | Profiler 内存曲线，反复进出页面 10 次 | 曲线截图 + 首尾数值 |
| 包体 | `build/default/outputs/default/*.hap` 体积；`resources/rawfile` 图片体积 | 文件大小列表 |
| 主线程重活 | 代码审查 `aboutToAppear` / `build()`；Profiler 火焰图 | 代码位置 + 火焰图 |

### 5.1 冷启动五阶段与超长帧

- 冷启动按官方五阶段拆：进程创建 → Application/Ability 初始化 → Ability 生命周期 → 首帧加载绘制 → 网络二次刷新；每段给出耗时，别只报一个总数；
- 滑动用 Trace/Frame 抓 5s：**> 33.3ms 即超长帧**，记录设备型号与刷新率；
- 证据：Trace 截图 + 分段耗时表 + 丢帧率；采样 ≥ 3 次取中位数。

## 6. 无障碍核对清单

- **对比度**：从截图取样文字色与背景色，按 WCAG 公式计算；正文 ≥ 4.5:1，大字号 ≥ 3:1。
- **触控目标**：布局树 `bounds` 换算 vp，≥ 48vp × 48vp，相邻 ≥ 8vp。
- **焦点**：外接键盘或用遥控器 Tab 走查，截图焦点框；检查顺序与不丢失。
- **可访问名称**：布局树里 `clickable=true` 但 `accessibilityText` 为空的节点 = 违规。
- **分组播报**：卡片/整行应只聚焦一次（`accessibilityGroup(true)`），内部文字不逐个聚焦。
- **层级**：纯装饰图标/分割线应 `accessibilityLevel('no')`；不可用整块用 `no-hide-descendants`，否则读屏噪音。
- **提示分离**：`accessibilityText` 只写"是什么"，操作引导放 `accessibilityDescription`。
- **键盘可达**：外接键盘 Tab 能遍历全部交互元素，焦点激活态可见，顺序与视觉一致。
- **字体放大**：系统字体调到 1.3x / 1.75x，重截同一页；文字截断/重叠即违规。
- **2x 极端字体**：系统字体最大档（约 2x）再测一次，弹窗内容按 2x 封顶不溢出；完整流程见 `scripts/a11y-walkthrough.md`。
- **非颜色编码**：错误/成功状态除颜色外还有图标或文案。
- **减少动效**：系统开启后，非必要动效降级。

## 7. 四维审计流程

| 维度 | 先做什么 | 产出证据 | 常见假通过 |
| --- | --- | --- | --- |
| 功能 | 从空态开始，按判据走一遍主路径与异常路径 | 操作步骤 + 截图 + 关键日志 | 只验证主路径、只在一台机上跑 |
| 审美 | 截图后量间距/字号/圆角/颜色 | 截图 + 布局树数值 + 规则 ID | 凭肉眼说"挺整齐" |
| 性能 | Profiler 采启动/滚动/内存 | 截图 + 数值 + 采样次数 | 只报"不卡" |
| 无障碍 | 布局树 + 对比度计算 + 字体放大 + 焦点走查 | 数值 + 截图 + 布局树片段 | 只写"支持无障碍" |

## 8. 填写 `dwguard_audit` 的模式

```json
{
  "note": "Pixel 模拟器 API 12；字体 1.0x/1.75x；深色+浅色各一轮",
  "checks": [
    {
      "criterionId": "F-01",
      "result": "pass",
      "evidence": "模拟器冷启动 → 首页 1.2s 出现列表；截图 artifacts/shots/F-01-main.jpeg"
    },
    {
      "criterionId": "X-01",
      "result": "fail",
      "evidence": "次要文字 #8A8A8A on #FFFFFF = 3.1:1 < 4.5:1；截图 X-01-contrast.jpeg 取样点 (120,640)"
    }
  ],
  "findings": [
    {
      "id": "R-01",
      "dimension": "accessibility",
      "severity": "major",
      "title": "次要说明文字对比度不足",
      "evidence": "同上，3.1:1",
      "ruleId": "DW-A11Y-01",
      "criterionId": "X-01",
      "suggestion": "把 #8A8A8A 改为 #6B6B6B（对比度 5.7:1）"
    }
  ]
}
```

`evidence` 写"怎么取的 + 取到了什么"，不要写"已确认"。

## 9. 子代理角色提示词

用 `subagent` / `subagent_fork` 并行审计时，把下面模板作为子代理任务。**要求它们只返回结论，不写文件**（避免并发写坏 `.shared/`）。

### 9.1 架构预审员

```text
你是鸿蒙架构预审专家。读 <任务包路径>，从性能、组件生命周期、并发安全、API 兼容四个视角交叉质询。
每条发现必须给出具体失败场景（什么操作、什么条件、会怎样），并写一段你自己的反驳尝试；经不起反驳的不要上报。
输出：JSON 数组 [{dimension, severity, title, evidence, suggestion, rebuttal}]。只返回结论，不要改任何文件。
```

### 9.2 影子审查者（编码期）

```text
你是只读的影子审查员。只读 <工程目录> 下最近变更的 .ets/.ts 文件，检查：
1) @State/@Link/@Prop 使用与同步方向；2) aboutToAppear/aboutToDisappear 是否配对；
3) 未清理的定时器/订阅/监听器；4) 是否偏离任务包规定的 UI 结构。
每条给出文件:行号 + 风险 + 建议。不要修改文件，不要跑构建。
```

### 9.3 功能审计员

```text
你是功能审计员。只依据 <任务包> 里的功能判据，逐条设计一条可在设备上复现的验证步骤，注明预期结果与失败判定。
不要读执行者的交付记录。输出：每条判据的验证步骤 + 需要采集的证据（截图/日志）。
```

### 9.4 审美审计员

```text
你是 UI 审美审计员。读 <截图路径> 与 <布局树路径>，按 DW-AES-01..06 检查间距、字号层级、圆角/阴影一致性、颜色语义、留白对齐。
每条违规写：页面 + 元素 + 实测值 + 规则 ID + 建议值。禁止使用"更好看"这类判断。
```

### 9.5 性能审计员

```text
你是性能审计员。读 <日志/Profiler 证据路径> 与关键源码，按 DW-PERF-01..05 判断：
启动耗时、列表帧率、内存增长、包体增量、主线程重活。
每条结论必须附数值或代码位置；没有数据就写"证据不足"，不要猜。
```

### 9.6 无障碍审计员

```text
你是无障碍审计员。读 <布局树> + <截图> + <a11y-summary.json>，按 DW-A11Y-01..13 检查对比度、触控尺寸、焦点可见与顺序、可访问名称、字体放大、非颜色编码、分组/层级、提示分离、键盘可达、2x 字体。
对比度必须给出计算值。每条违规附元素 bounds 与规则 ID。
```

## 10. 假通过清单（提交审计前自查）

- [ ] 只在一台设备 / 一个字体档 / 一种配色下验证
- [ ] 用执行者提供的截图当证据
- [ ] 把"编译通过"或"没有报错"当功能通过
- [ ] 48vp、对比度靠肉眼估，没查布局树/没算数值
- [ ] 空态、错误态、权限拒绝路径没走
- [ ] must 判据记成 `unverified` 却宣告通过
- [ ] 返工后没有重新取证，直接复用了上一轮的证据

## 11. 断言判据的实测值（`actual`，0.5.0 起）

任务包里的判据带 `assertion` 时，`dwguard_audit` 的检查必须给出 `actual`（实测值），闸门会按 matcher 重算，断言不通过却标 `pass` 会被直接拒绝。取证时：

1. **先量再写**：布局树 bounds、Profiler 数值、对比度计算值、截图取样结果——原样写进 `actual`，单位保留（`12vp` / `720ms` / `4.9:1`）；
2. **数值取第一个数字**：`actual` 里第一个数字参与比较，长文本请只写关键数值；
3. **actual 与 evidence 分开**：`actual` 是机器比较用的值，`evidence` 是人复核用的说明/路径，两者不能互相替代；
4. 量不出来时不要编 `actual`——把判据判 `unverified`（must 会被闸门拦下），回到 `tasks/question.md` 说明为什么量不到。

## 12. 取证剧本模板（0.5.0 起）

一次审计 = 一份**可复现的剧本**。把下面模板复制到本轮审计记录里，按 beforeAll → 步骤 → afterAll 执行；每条判据的 `actual` 都从剧本里取，而不是事后回忆。

### 12.1 模板

```markdown
### 剧本：<需求标题>（spec v<n> · audit #<n>）
- 设备：<SN / 模拟器名> · <机型> · HarmonyOS <版本> (API <n>)
- 环境：字体档 <默认 / 1.75x> · <浅色 / 深色> · 分辨率 <...>
- 被测包：<bundleName>@<version> · HAP sha256 <...>

#### beforeAll（整轮一次）
1. 设备在线：`hdc list targets`
2. 安装/确认包：`hdc install <hap>` 或 `hdc shell bm dump -n <bundle>`
3. 清数据（冷状态）：`hdc shell bm clean -n <bundle> -d`
4. 固定环境：字体档 / 深浅色 / 屏幕方向（记录设置路径与当前值）
5. 基线截图 + 布局树：`hdc shell snapshot_display ...`、`hdc shell uitest dumpLayout ...`
6. 清性能计数：`hdc shell "hidumper -s RenderService -a 'clearFpsCount'"`

#### 步骤（每条判据一段）
| 判据 | 动作（可脚本化） | 等待 | 取证 |
| --- | --- | --- | --- |
| `<F-01>` | `devecocli ui click --device <sn> <x> <y>` | `devecocli ui wait element "text=..."` | 截图 + `actual` |

#### afterAll（整轮一次）
1. 收尾日志：`hdc shell hilog -x` 取尾部并落盘；
2. 恢复环境（字体 / 主题 / 方向 / 卸载测试包），记录恢复结果；
3. 把所有证据文件写进 `checks[].evidenceFiles`。
```

### 12.2 等待（waitForIdle）

- 动效/页面切换后**等 UI 稳定再取证**：先 `devecocli ui wait 500`（毫秒），再连续两次 `devecocli ui layout`，两次布局树一致才算 idle；不一致再等最多 1s；
- 目标控件用 `devecocli ui wait element "text=确认"`（或 `id=` / `type=`）显式等待，**禁止固定 sleep 后盲截**；
- 冷启动首帧不要用固定 sleep 代等待——首帧耗时走 `docs/perf-baseline.md` 第 4 节的外部 trace 采集。

### 12.3 重试（retry）

- 每个取证动作最多 **2 次重试**（共 3 次）；只重试"环境不稳定"类失败（控件未出现、设备忙、截图黑屏）；
- 结果取**稳定那一次**；数值类判据取 3 次测量中位数（`actual` 写中位数，`note` 写 3 次原始值）；
- 重试次数写进 `checks[].note`（如 `attempt=2/3`）；3 次仍失败 → 记 `unverified` / `fail`，不许无限重试。

### 12.4 弹窗规则（popup rules）

首启/权限/升级弹窗会挡住取证，按「识别 → 处理 → 记录」三步做：

| 弹窗 | 识别特征（UI 树 text） | 处理 | 备注 |
| --- | --- | --- | --- |
| 隐私协议 | `隐私政策`、`同意`、`继续` | 点「同意 / 同意并继续」 | 首次启动必须截图留证 |
| 权限申请 | `允许`、`仅使用期间允许`、`禁止` | 按判据意图选择（测拒绝路径时点「禁止」） | 拒绝路径必须单独取证 |
| 升级 / 公告 | `立即更新`、`稍后`、`以后再说` | 点「稍后」或关闭 | 关闭后截图确认 |
| 锁屏 / 系统弹层 | 锁屏界面、系统级弹层 | 先解锁屏幕（模拟器手动滑动）再测 | 解锁状态写进环境 |

- 弹窗**关不掉**：截图 + `hdc shell hilog` 片段，记 `blocker`，不要绕过；
- 新发现的弹窗规则追加到 `knowledge/popup-rules.md`，下一轮直接复用。

### 12.5 与断言的关系

剧本里的每个「动作 + 等待 + 测量」产出一条 `checks[].actual`，格式对齐任务包里的 `assertion`（见第 11 节）：

```json
{
  "criterionId": "P-02",
  "result": "pass",
  "actual": "点击→列表出现 96ms（3 次中位数）",
  "evidence": "截图 + hitchs 增量 0（>16.67ms）",
  "note": "attempt=1/3"
}
```
