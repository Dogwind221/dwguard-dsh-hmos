# 无障碍读屏手动走查

> 这份脚本给审计者用：**读屏必须真开**，不能只看截图。每页按固定顺序过一遍，证据落 `.shared/artifacts/`，最后写进 `dwguard_audit` 的 `checks[].evidenceFiles`。

## 0. 准备

- 设备/模拟器在线：`devecocli device list`（或 `hdc list targets`）；
- 开启屏幕朗读：**设置 → 无障碍 → 屏幕朗读**（不同版本名称可能为"读屏/TalkBack"），关闭新手引导；
- 字体先回到 **1.0x** 做基线，再单独做 2x；
- 记录表：

| 页面 | 元素 | 期望播报/行为 | 实际 | 规则 ID | 截图 |
| --- | --- | --- | --- | --- | --- |
| 首页 | 打卡按钮 | "打卡，按钮，双击激活" | "按钮" | A11Y-04 | `X-01-home-1x.png` |

## 1. 每页固定流程

1. **焦点顺序**：键盘 Tab 或读屏滑动，焦点顺序与视觉阅读顺序一致；首焦点在标题/主内容，不落到装饰元素（`A11Y-03`、`A11Y-12`）。
2. **名称与角色**：纯图标按钮必须播报功能名；图片有语义补描述，装饰图不聚焦（`A11Y-04`、`A11Y-10`）。
3. **分组**：卡片/整行应只聚焦一次，内容合并播报；内部文字不逐个聚焦（`A11Y-09`）。
4. **提示分离**：`accessibilityText` 只讲"是什么"；"单指双击"等操作提示放 `accessibilityDescription`（`A11Y-11`）。
5. **状态变化**：勾选、错误、进度、加载完成要能播报，不能只变颜色（`A11Y-06`）。
6. **表单**：输入框有标签，错误提示与字段关联；键盘弹出不遮挡输入框。
7. **弹窗/半模态**：焦点进入弹窗、关闭后回到触发元素；不能困在背景页。
8. **列表**：每项可读、可操作；滚动加载后焦点不丢。
9. **2x 字体**：同一页复测，文字不截断、不重叠、不出容器（`A11Y-13`）。

## 2. 取证命令

```powershell
# 截图（落 .shared/artifacts/devshots/）
dwguard_deveco action=screenshot device="127.0.0.1:5555"

# 布局树 / 无障碍快照（含 bounds、text、clickable、accessibilityId + 静态扫描）
dwguard_deveco action=a11y device="127.0.0.1:5555"

# 原始布局树（需要自己筛字段时）
dwguard_deveco action=layout device="127.0.0.1:5555"
```

- 截图命名：`<规则ID>-<页面>-<状态>.png`（如 `A11Y-09-home-grouped.png`）；
- 审计引用：`evidenceFiles: ["artifacts/devshots/A11Y-09-home-grouped.png", "artifacts/deveco-1/a11y-summary.json"]`。

> `a11y` 快照只有布局树字段（bounds/text/clickable/accessibilityId），**没有** `accessibilityText/Level/Group`；名称与层级以源码静态扫描 + 本脚本人工走查为准。

## 3. 2x 极端字体（A11Y-13）

1. **设置 → 显示和亮度 → 字体大小/显示大小** 调到最大（约 2x）；不同机型路径可能不同，记录实际路径；
2. 同一页用 `dwguard_deveco action=screenshot` 再截一张；
3. 对照：标题/按钮/列表行/输入框/弹窗，文字不截断、不重叠、不被容器裁切；弹窗内容放大不超过 2x；
4. 恢复 1.0x，避免影响后续用例。

## 4. 常见假通过

- 只截图、不开读屏；
- 只测首页，不测弹窗/空态/错误态；
- 把 `accessibilityId`（uitest 用）当成无障碍名称；
- 用"支持无障碍"一句话代替逐元素记录；
- 2x 字体只测标题，不测按钮和输入框。

## 5. 交给审计的产物

- 每页至少 1 张 1x 截图 + 1 张 2x 截图（如涉及）；
- `a11y-summary.json`（节点/可点击/无文本/静态命中）；
- 记录表填完的 Markdown 片段（贴进验收报告）。
