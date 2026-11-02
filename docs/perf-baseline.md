# 性能基线与 Profiler 取证模板

> 目的：把 `PERF-01/02/03/10/11` 从"贴个截图"变成可复现的采集步骤 + 机型基线。基线值先留空，首个项目实测后回填。

## 1. 机型矩阵

| 机型 | 类型 | 系统/API | 刷新率 | 冷启动基线 | 滑动超长帧基线 | 内存基线 |
| --- | --- | --- | --- | --- | --- | --- |
| 中端直板机 | phone | HarmonyOS ___ / API ___ | 60/120Hz | ___ms | ___ 帧/5s | ___MB |
| 折叠屏（展开） | foldable | HarmonyOS ___ / API ___ | ___Hz | ___ms | ___ 帧/5s | ___MB |
| 平板 | tablet | HarmonyOS ___ / API ___ | ___Hz | ___ms | ___ 帧/5s | ___MB |

## 2. 采集步骤（每项 3 次取中位数）

### 冷启动（PERF-01 / PERF-10）

1. 设备重启或强制停止应用，确保无进程；
2. DevEco Profiler → **启动分析**（或 SmartPerf Host 抓 Trace）；
3. 记录五阶段：进程创建 → Application/Ability 初始化 → Ability 生命周期 → 首帧加载绘制 → 网络二次刷新；
4. 截图 + 导出 Trace；文件名 `P-01-<机型>-coldstart-<n>.png`。

### 滑动超长帧（PERF-02 / PERF-11）

1. 进入长列表，连续滑动 5s；
2. Profiler/Frame 抓帧耗时；
3. 统计 > 33.3ms 的超长帧数量与丢帧率；
4. 录屏 + Trace 截图；文件名 `P-11-<机型>-scroll-<n>.png`。

### 内存（PERF-03）

1. 反复进出同一页面 10 次；
2. Profiler 内存曲线记录首尾值；
3. 判断是否持续增长（默认 ±5MB）；文件名 `P-03-<机型>-memory-<n>.png`。

### 包体（PERF-04）

1. `devecocli build --build-mode release` 产出 HAP；
2. 记录 HAP 体积、图片资源体积；
3. 文件名 `P-04-<机型>-size.txt`。

## 3. 证据落盘

```text
.shared/artifacts/perf/
  P-01-<device>-coldstart-1.png
  P-01-<device>-coldstart-1.trace
  P-11-<device>-scroll-1.png
  P-03-<device>-memory-1.png
  P-04-<device>-size.txt
```

审计时写进 `checks[].evidenceFiles`，例如：

```json
{ "criterionId": "P-01", "result": "pass", "evidence": "冷启动 720ms，3 次中位数", "evidenceFiles": ["artifacts/perf/P-01-phone-coldstart-1.png"] }
```

## 4. 交互轨迹采集（0.5.0 起）

目标：把「点击 / 滑动 → 首帧 / 可用布局」从"感觉流畅"变成可复核的数值证据，作为性能判据的 `actual`（配合 `assertion: lte`）。

### 4.1 外部可观测证据（优先）

在设备上直接量，不依赖应用自报：

1. **窗口帧率**（交互期间）：`hdc shell "hidumper -s RenderService -a 'fps <bundleName>'"`；
2. **卡顿分桶**（>16.67 / >33 / >66 ms 次数）：`hdc shell "hidumper -s RenderService -a 'hitchs <bundleName>'"` —— 交互前后各取一次，差值即本次交互的 jank 计数；
3. **清计数再测**：`hdc shell "hidumper -s RenderService -a 'clearFpsCount'"`（或 `fpsClear <surface>`），保证每轮从零开始；
4. **交互到可用布局耗时**（脚本）：记录 `devecocli ui click` 前的时间戳，轮询 `devecocli ui layout` 直到目标节点出现，差值即「点击→可用」（含轮询粒度，取 3 次中位数并注明方法）。

> 以上两条 `hidumper` 选项在 HarmonyOS 6.1.1（API 24）模拟器上实测可用：`RenderService` 支持 `fps` / `fpsCount` / `fpsClear` / `clearFpsCount` / `hitchs` / `screen`。

### 4.2 系统 Trace（复核材料）

```powershell
# 1) 后台抓 8 秒系统 trace（图形 / ArkUI / 应用 / 窗口）
hdc shell "hitrace -t 8 graphic ace app window -o /data/local/tmp/dw-trace.ftrace"
# 2) 在这 8 秒内执行交互
devecocli ui click --device <sn> <x> <y>
# 3) 抓完拉回本地
hdc file recv /data/local/tmp/dw-trace.ftrace .\artifacts\perf\
```

- 类别先用 `hdc shell "hitrace -l"` 确认（本机验证：`ace` / `app` / `graphic` / `ohos` / `window`）；
- trace 作为**复核材料**附进 `evidenceFiles`；帧耗时结论优先用 4.1 的 fps / hitchs 数值，trace 用来解释 jank 来源。

### 4.3 应用内埋点（执行者可选，仅作辅助）

如果执行者愿意加 `hiTraceMeter` 打点（`startTrace` / `finishTrace`）或在关键路径打 hilog 时间戳：

- `hdc shell "hilog -x"` 取日志，按时间戳算差值；
- 该数值来自被测应用，**不能单独作为通过依据**；必须与 4.1 的外部测量一致，否则以外部测量为准（参见 [查看 HiTraceMeter 日志](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/hitracemeter-view)）。

### 4.4 证据落盘与断言示例

```text
artifacts/perf/
  P-02-<device>-fps-before.txt
  P-02-<device>-fps-after.txt
  P-02-<device>-hitchs-before.txt
  P-02-<device>-hitchs-after.txt
  P-02-<device>-trace.ftrace
```

```json
{
  "criterionId": "P-02",
  "result": "pass",
  "actual": "点击→列表出现 96ms（3 次中位数）",
  "evidence": "hitchs 增量 0（>16.67ms）",
  "evidenceFiles": ["artifacts/perf/P-02-phone-trace.ftrace"]
}
```

断言可写成 `assertion: { "matcher": "lte", "expected": 150, "unit": "ms" }`；jank 用 `lte 0`（>33ms 次数）或 `range` 限定次数。

### 4.5 常见假通过（交互轨迹部分）

- 只报 fps 均值、不报 jank 次数；
- 交互前没 `clearFpsCount`，把上一轮统计算进本轮；
- 用应用自报埋点当唯一证据；
- 截图/录像里看不出交互时间，却写了具体毫秒数。

## 5. 常见假通过

- 只报一个总数，不拆五阶段；
- 在热启动/有进程时测"冷启动"；
- 只截图不导出 Trace，无法复核；
- 只测一台设备、一个刷新率；
- 用"感觉不卡"代替丢帧率。
