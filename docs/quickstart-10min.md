# DSH-HMOS 10 分钟快速上手

目标：**10 分钟内**从零生成一个可构建的鸿蒙示例工程，并知道下一步怎么跑 DSH 双代理流程。不会手写目标 App 的 `entry/` / `AppScope/` 源码。

## 0. 前置

- Node.js >= 20
- DevEco CLI `devecocli` 可用
- DSH + `dwguard-dsh-hmos` 插件
- 可选：已启动的 HarmonyOS 模拟器/真机

## 1. 体检

```powershell
cd F:\dsh\Github\dwguard-dsh-hmos
node bin/dwguard.mjs doctor --workspace F:\dsh\quickstart
```

看到 `node / devecocli / hdc` 为 `ok` 即可；`device` 为 `warn` 时仍可先构建。

## 2. 生成示例工程（约 1 分钟）

```powershell
node bin/dwguard.mjs quickstart --dir F:\dsh\quickstart --api 24
```

它会调用 `devecocli create` 生成 `DwGuardQuickstart` 工程，并执行一次 `devecocli build`。不会覆盖已存在目录。

## 3. 把 DSH 会话切到工程

在 DSH 里把会话工作目录切到：

```text
F:\dsh\quickstart
```

然后说：

> 给这个鸿蒙工程做一个首页：显示问候语和一个按钮，点击后计数 +1，用本地偏好存储保存计数。

DSH 会依次调用：

```text
dwguard_spec → dwguard_prereview → dwguard_dispatch
```

## 4. 执行与取证

DevEco Code 实现后，用：

```text
dwguard_deveco action:"pipeline" module:"entry" device:"<设备名>"
```

至少确认：

- build 成功
- sign 成功
- run 成功
- screenshot 真实生成
- layout 是合法 JSON

没有设备时，先做 build/sign；不要伪造 run/screenshot 证据。

## 5. 审计与复核

四维审计通过后，可独立复核证据包：

```powershell
node bin/dwguard.mjs review --workspace F:\dsh\quickstart
```

退出码：

- `0`：证据包哈希/审计/验收一致
- `1`：不一致
- `2`：缺少必要产物（审计尚未完成）

## 6. 自动回传

DevEco 在 `.shared/outbox-deveco.md` 写 `deliver` 记录后：

```powershell
node bin/dwguard.mjs bridge --workspace F:\dsh\quickstart --once
```

桥会把新交付写进 `.shared/bridge/events.jsonl`，并给 `.shared/harness/queue.json` 入队 `delivery-review` 任务，供 `scripts/harness-worker.mjs` 领取。

## 7. 设备基准

```powershell
node bin/dwguard.mjs bench --workspace F:\dsh\quickstart --device --require-physical
```

没有物理设备时会明确 `blocked`，退出码 `2`，不会伪造通过。

## 10 分钟时间预算

| 步骤 | 预计 |
| --- | --- |
| doctor | 10s |
| quickstart create + build | 1–2 分钟 |
| DSH 写任务包 + 预审 + 派发 | 2 分钟 |
| DevEco 最小实现 | 3–4 分钟 |
| pipeline build/sign | 1–2 分钟 |
| review | 5s |

无 device 时 `run/screenshot/layout` 不计入 10 分钟。

## 已验证

- `quickstart` 生成 API 24 工程并 build 成功；
- `doctor` 在模拟器连接时显示 `device: Pura 90 (emulator)`；
- `bench --device` 在模拟器上通过 build/screenshot/layout；
- `bench --device --require-physical` 在只有模拟器时 `blocked`，退出码 2。
