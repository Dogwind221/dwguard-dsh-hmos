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

## 4. 常见假通过

- 只报一个总数，不拆五阶段；
- 在热启动/有进程时测"冷启动"；
- 只截图不导出 Trace，无法复核；
- 只测一台设备、一个刷新率；
- 用"感觉不卡"代替丢帧率。
