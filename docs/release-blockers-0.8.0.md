# 0.8.0 发布阻断项复核

> 状态：已在 **0.8.5** 修复；实现映射见 [0.8.5-hardening.md](0.8.5-hardening.md)。本文保留当时的复核证据。

复核方式：直接读代码 + 运行现有闸门测试，不采信探针结论本身。
结论：用户列出的 **P0-1 ~ P0-6 全部成立**，没有一项可以按“误报”关闭。区别只在
可利用条件和修复优先级。

| ID | 结论 | 关键证据 | 风险边界 |
| --- | --- | --- | --- |
| P0-1 | 成立 | `src/tools/audit.ts:85-87` 把 `evidence`/`evidenceFiles` 都做成可选；`src/review.ts:463` 只校验 `evidence.length >= 4`；`src/review.ts:473` 把自述降为 warning；`tests/gates.test.mjs:107-121` 固定了纯文本通过。 | 所有 must 判据；这是“验收可信”的根问题。 |
| P0-2 | 成立 | `src/state.ts:69-77` 无锁读改写；`src/progress.ts:87-100` 四维读合并写；`src/state.ts:85-95` 的 `nextIndex` 扫目录取 max+1；`src/util/fs.ts:67` 只保证单文件原子写。 | 并发子代理/并发审计；会丢状态或共用 `audit-N`。 |
| P0-3 | 成立 | `src/device.ts:238-240` 是全局单文件锁而非每设备；`src/device.ts:279` 同 holder 直接重入；`src/device.ts:305-309` 释放只核对 sn；`src/tools/deveco.ts:466,776` 设备池为空时跳过加锁、后台任务 `!useBackground` 不拿锁。 | 矩阵/多设备并行；后台任务生命周期。 |
| P0-4 | 成立 | `src/design.ts:2126-2145` 只校验请求目录名，未要求 `parsed.name === name`；`src/design.ts:2260-2268` 用 `pack.name` 拼 source/target；`src/design.ts:2282` 用未做包含检查的 `image.path`。 | 需要能放置/接收恶意 pack；`confirmed:true` 不能替代路径安全。 |
| P0-5 | 成立 | `src/evidence.ts:123` 只把斜杠替换成 `__`；`src/util/fs.ts:110-113` 用 `copyFile` 覆盖目标；manifest 仍分别记录原始路径和各自哈希。 | 证据完整性；同一次审计内即可触发。 |
| P0-6 | 成立（认证边界缺失） | `src/web.ts:81-89` 无 `sec-fetch-site` 放行、Host 只检查存在；`src/web.ts:92-103` 接受任意 `cwd`，不要求属于已登记 workspace；响应含绝对路径。 | 只有当 webServer 监听不可信网络时才构成实际远程风险；即使只监听 loopback，也**不能把该路由当安全边界**。 |

## 不是误报，但要注意定性

- P0-4/P0-5 是**安全类**问题，不是“代码风格”。P0-4 的触发前提是攻击者能让一个包进入
  `.shared/design-packs/`（下载、协作、外部模板导入都算）；P0-5 不要求攻击者，普通重名也会破坏
  哈希对应关系。
- P0-6 当前更像**本地接口缺少授权**，是否可远程利用取决于监听地址和宿主鉴权；不要把它写成
  “远程 RCE”，但也不要继续依赖浏览器请求头承担鉴权。
- P0-1/P0-2/P0-3 是**协议正确性**问题：即使没有恶意输入，也会让“四维审计通过”这个结论不可信，
  或让并发矩阵结果不可复现。

## 发布判断

- 0.8.0 当前不应该发布为“验收可信/支持矩阵并发”的版本。
- 如果 0.8.0 尚未发布：把修复并入 0.8.0；如果已经发布：P0-4/P0-5 走 0.8.1 安全补丁，
  P0-1/P0-2/P0-3 需要 0.9.0 级别的协议修订（或明确降级产品声明）。
- 现有测试全绿不构成反证：`tests/gates.test.mjs` 正好把 P0-1 的宽松行为固化成了断言。

## 建议修复顺序

1. P0-4 + P0-5：包名校验、resolve/relative/realpath、唯一证据存储名、`wx` 独占创建；
2. P0-1：must + pass 强制结构化 `evidenceFiles`/Observation；自述在严格模式直接 error；
   `actual` 结构化并带单位/样本/聚合；
3. P0-3：每设备 lease + token，后台生命周期持锁，释放校验 token；
4. P0-2：state revision/CAS、progress 按 `auditId/dimension` 拆文件、编号原子预留、commandId 幂等；
5. P0-6：cwd 限定已登记 workspace、Host/Origin allowlist、loopback 或 token。
