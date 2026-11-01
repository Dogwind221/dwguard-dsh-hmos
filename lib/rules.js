/**
 * The DwGuard rule catalog.
 *
 * Stable IDs are the contract between the task pack, the static scan, and the
 * audit: every criterion or finding can cite one, and the same rule keeps the
 * same ID across rounds. Aliases map our IDs to the community/official IDs so
 * reports can cite both. `citation` points at the exact official page (and
 * section / commit) a rule comes from, so a verdict can be re-read at source.
 *
 * @module dwguard-dsh-hmos/rules
 */
const RUBRIC = 'DwGuard 验收规则';
const SCAN = 'dwguard_scan 静态扫描';
const AGC = 'AGC 提审 Top20 拒因（2026）';
const DESIGN = 'HarmonyOS 应用设计指南';
const OH = 'OpenHarmony 应用开发文档';
/** Design docs fetched from Huawei's llms index (`.md` source). */
const UX_BASE = 'https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design';
const UX_FETCHED = 'fetched 2026-10-31';
/** OpenHarmony docs commit used for dev citations. */
const OH_SHA = 'f41b9345badd47c7ab0c263344cd7f4b5a549afb';
const OH_BASE = `https://github.com/openharmony/docs/blob/${OH_SHA}/zh-cn/application-dev`;
const AGC_URL = 'https://github.com/Octo-o-o-o/harmonyos-ai-workspace/blob/main/07-publishing/checklist-2026-rejection-top20.md';
/** AGC rejection-reason citation helper. */
const agc = (section, label) => ({
    label,
    url: AGC_URL,
    section,
    version: '2026 版'
});
/** Canonical catalog. Keep IDs append-only; never renumber. */
export const RULES = [
    // ── 功能 ────────────────────────────────────────────────────────────────
    {
        id: 'DW-FN-01',
        dimension: 'function',
        title: '主路径可完成',
        verify: '操作步骤 + 截图/录屏，首屏到目标页 ≤ 1s',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-FN-02',
        dimension: 'function',
        title: '空态有引导',
        verify: '清空数据后截图：空态插画 + 引导按钮可点',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-FN-03',
        dimension: 'function',
        title: '错误态与重试',
        verify: '断网提交 → 提示文案 + 重试可用（日志见第二次请求）',
        severity: 'must',
        aliases: ['AGC-RJ-018'],
        source: RUBRIC,
        citation: {
            label: 'AGC 提审 Top20 · AGC-RJ-018 网络异常处理缺失',
            url: 'https://github.com/Octo-o-o-o/harmonyos-ai-workspace/blob/main/07-publishing/checklist-2026-rejection-top20.md',
            section: 'AGC-RJ-018',
            version: '2026 版'
        }
    },
    {
        id: 'DW-FN-04',
        dimension: 'function',
        title: '返回栈正确',
        verify: '详情页连续返回两次回首页，滚动位置保持',
        severity: 'must',
        source: RUBRIC,
        citation: {
            label: '通用应用 UX 体验标准 2.1.1.1 系统返回',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.1.1.1',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-FN-05',
        dimension: 'function',
        title: '幂等 / 防重复提交',
        verify: '连点 5 次，后台只留 1 条记录',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-FN-06',
        dimension: 'function',
        title: '状态恢复',
        verify: '切后台 30s 回前台，数据不丢、不重复加载',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-FN-07',
        dimension: 'function',
        title: '权限拒绝有兜底',
        verify: '拒绝权限后显示引导，不崩、不白屏',
        severity: 'must',
        aliases: ['AGC-RJ-002'],
        source: RUBRIC,
        citation: agc('AGC-RJ-002', 'AGC-RJ-002 权限申请缺合理性')
    },
    {
        id: 'DW-FN-08',
        dimension: 'function',
        title: '隐私政策首启确认',
        verify: '首次启动弹出可访问的 HTTPS 隐私政策，同意后才进入主界面',
        severity: 'must',
        aliases: ['AGC-RJ-001'],
        source: AGC,
        citation: agc('AGC-RJ-001', 'AGC-RJ-001 隐私政策缺失或不可访问')
    },
    {
        id: 'DW-FN-09',
        dimension: 'function',
        title: '数字商品走 IAP',
        verify: '购买流程走华为 IAP（@kit.IAPKit），不走第三方支付',
        severity: 'must',
        aliases: ['AGC-RJ-012'],
        source: AGC,
        citation: agc('AGC-RJ-012', 'AGC-RJ-012 内购/支付未走 IAP')
    },
    {
        id: 'DW-FN-10',
        dimension: 'function',
        title: '发布包无敏感日志',
        verify: 'release 构建后 grep console.* 为 0；敏感字段用 %{private}',
        severity: 'must',
        aliases: ['AGC-RJ-007'],
        source: AGC,
        citation: agc('AGC-RJ-007', 'AGC-RJ-007 调试日志泄漏')
    },
    {
        id: 'DW-FN-11',
        dimension: 'function',
        title: '后台任务有前台通知',
        verify: '长时任务注册 continuousTask，通知可见且可停止',
        severity: 'must',
        aliases: ['AGC-RJ-009'],
        source: AGC,
        citation: agc('AGC-RJ-009', 'AGC-RJ-009 后台执行权限滥用')
    },
    {
        id: 'DW-FN-12',
        dimension: 'function',
        title: '嵌套属性赋值不能直接改',
        verify: 'dwguard_scan 无 STATE-NESTED-01 命中；@State 数组整体赋值或用 Array API，数组项/嵌套对象属性整体替换',
        severity: 'must',
        aliases: ['STATE-NESTED-01'],
        source: SCAN,
        citation: {
            label: '@State 观察变化范围（Array 的 push/pop 等可观察；嵌套属性不可观察）',
            url: `${OH_BASE}/ui/state-management/arkts-state.md`,
            section: '观察变化',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-FN-13',
        dimension: 'function',
        title: 'ArkTS 严格子集与导入规范',
        verify: 'dwguard_scan 无 any / @ohos.* / V1V2 混用 / 伪包命中',
        severity: 'must',
        aliases: ['ARKTS-ANY-001', 'ARKTS-IMPORT-KIT', 'ARKTS-V1V2-MIX', 'OHPM-FAKE-001'],
        source: SCAN,
        citation: {
            label: 'TypeScript 到 ArkTS 的适配规则（禁 any / 解构 / 索引签名等）',
            url: `${OH_BASE}/quick-start/typescript-to-arkts-migration-guide.md`,
            section: '约束',
            version: OH_SHA.slice(0, 7)
        }
    },
    // ── 审美 ────────────────────────────────────────────────────────────────
    {
        id: 'DW-AES-01',
        dimension: 'aesthetic',
        title: '8vp 栅格',
        verify: '布局树 bounds：边距/间距是 4 的倍数，主间距 8/12/16/24',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '间隔参数（屏幕边距 16/24/32/48vp 档位）',
            url: `${UX_BASE}/interval-parameter-0000002562577161.md`,
            section: '屏幕边缘间隔',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-02',
        dimension: 'aesthetic',
        title: '字号层级 ≤ 4 级',
        verify: '布局树字号集合 ≤ 4 种，且层级有序（手机正文 ≥12vp，最小 8vp）',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '通用应用 UX 体验标准 2.1.4.2 字体大小（手机正文推荐 12vp，最小 8vp；层级为 DwGuard 补充）',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.1.4.2',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-03',
        dimension: 'aesthetic',
        title: '圆角与阴影一致',
        verify: '同类卡片圆角/阴影一致；阴影只用于浮层',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '圆角参数（组件圆角档位）',
            url: `${UX_BASE}/corner-radius-parameter-0000002556468705.md`,
            section: '圆角参数',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-04',
        dimension: 'aesthetic',
        title: '颜色语义一致',
        verify: '主色只用于主操作；成功/警告/错误不混用',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '色彩（主色/辅助色与语义色）',
            url: `${UX_BASE}/color-0000001776857164.md`,
            section: '色彩',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-05',
        dimension: 'aesthetic',
        title: '留白与对齐',
        verify: '同组左对齐；标题与正文 ≥ 8vp；区块间 ≥ 24vp',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '间距参数（页面边距与区块间距）',
            url: `${UX_BASE}/spacing-parameters-0000002202912577.md`,
            section: '间距参数',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-06',
        dimension: 'aesthetic',
        title: '图文比例稳定',
        verify: '缩略图统一比例、不拉伸；文字不压图',
        severity: 'must',
        source: DESIGN
    },
    {
        id: 'DW-AES-07',
        dimension: 'aesthetic',
        title: '断点适配',
        verify: '折叠屏/平板横竖屏切换后无错位、无裁切',
        severity: 'must',
        aliases: ['AGC-RJ-013'],
        source: AGC,
        citation: {
            label: '折叠屏应用 UX 体验标准',
            url: `${UX_BASE}/ux-guidelines-foldable-screen-0000001807866557.md`,
            section: '折叠屏',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-08',
        dimension: 'aesthetic',
        title: '深色模式可用',
        verify: '切换系统深色后颜色语义正确、对比度仍达标',
        severity: 'must',
        aliases: ['AGC-RJ-016'],
        source: AGC,
        citation: {
            label: '通用应用 UX 体验标准 2.2.5 深色模式',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.2.5',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-09',
        dimension: 'aesthetic',
        title: '文案资源化',
        verify: 'UI 文案走 `$r(app.string.*)`，源码中无硬编码中文',
        severity: 'must',
        aliases: ['AGC-RJ-014'],
        source: AGC,
        citation: agc('AGC-RJ-014', 'AGC-RJ-014 国际化字符串硬编码')
    },
    {
        id: 'DW-AES-10',
        dimension: 'aesthetic',
        title: '图标与启动图合规',
        verify: '图标 1024×1024 PNG、无系统图标/商标；启动图无广告',
        severity: 'must',
        aliases: ['AGC-RJ-004'],
        source: AGC,
        citation: {
            label: '通用应用 UX 体验标准 2.1.4.3.1 应用图标（1024×1024、前后景分层）',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.1.4.3.1',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-AES-11',
        dimension: 'aesthetic',
        title: '全屏转场时长达标',
        verify: '录屏计时：<8.5in ≥200ms、8.5–12in ≥250ms、>12in ≥300ms；不得单帧直切',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '通用应用 UX 体验标准 2.1.5.2.2 转场动效时长下限',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.1.5.2.2',
            version: UX_FETCHED
        }
    },
    // ── 性能 ────────────────────────────────────────────────────────────────
    {
        id: 'DW-PERF-01',
        dimension: 'performance',
        title: '冷启动到首帧 ≤ 800ms',
        verify: 'Profiler 启动分析 + hilog 时间戳（AGC 红线 2s）',
        severity: 'must',
        aliases: ['AGC-RJ-017'],
        source: RUBRIC,
        citation: {
            label: '应用性能问题分析指导 · 应用性能分析（冷启动响应速度）',
            url: `${OH_BASE}/performance/application-performance-guide.md`,
            section: '应用性能分析',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-02',
        dimension: 'performance',
        title: '长列表滚动不丢帧',
        verify: '100 项列表滚动帧率图 ≤ 2 帧/秒卡顿',
        severity: 'must',
        source: RUBRIC,
        citation: {
            label: '应用性能优化指导 · 列表场景（LazyForEach + 组件复用 + 缓存列表项）',
            url: `${OH_BASE}/performance/application-performance-optimization-guidance.md`,
            section: '第一要素：合理使用并行化、预加载和缓存',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-03',
        dimension: 'performance',
        title: '无内存泄漏',
        verify: '反复进出页面 10 次，内存增长 ≤ 5MB',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-PERF-04',
        dimension: 'performance',
        title: '包体预算',
        verify: 'HAP 增量 ≤ 2MB；单图 ≤ 300KB',
        severity: 'must',
        aliases: ['AGC-RJ-015'],
        source: RUBRIC,
        citation: agc('AGC-RJ-015', 'AGC-RJ-015 包大小过大（单 HAP 推荐 <200MB）')
    },
    {
        id: 'DW-PERF-05',
        dimension: 'performance',
        title: '重活不占主线程',
        verify: 'build()/aboutToAppear 内无同步解析/排序/大图解码',
        severity: 'must',
        source: RUBRIC,
        citation: {
            label: '应用性能问题分析指导 · 丢帧问题分析思路（主线程状态）',
            url: `${OH_BASE}/performance/application-performance-guide.md`,
            section: '丢帧问题分析思路',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-06',
        dimension: 'performance',
        title: '长列表用 LazyForEach',
        verify: 'dwguard_scan 无 PERF-LIST-FOREACH 命中',
        severity: 'warn',
        aliases: ['PERF-LIST-FOREACH'],
        source: SCAN,
        citation: {
            label: '列表开发指导 · 使用 LazyForEach 创建 ListItem',
            url: `${OH_BASE}/ui/arkts-layout-development-create-list.md`,
            section: '使用LazyForEach创建ListItem',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-07',
        dimension: 'performance',
        title: '定时器与订阅有清理',
        verify: 'dwguard_scan 无 LIFECYCLE-TIMER 命中',
        severity: 'warn',
        aliases: ['LIFECYCLE-TIMER'],
        source: SCAN
    },
    {
        id: 'DW-PERF-08',
        dimension: 'performance',
        title: '简单行列用 Column/Row，不用 Flex',
        verify: '代码审查：高频布局（列表项/卡片）无 Flex 包裹；帧率对比无明显回退',
        severity: 'warn',
        source: OH,
        citation: {
            label: '性能优化 · 使用 Column/Row 替代 Flex',
            url: `${OH_BASE}/performance/arkts-performance-improvement-recommendation.md`,
            section: '使用Column/Row替代Flex',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-09',
        dimension: 'performance',
        title: '长列表组件复用',
        verify: '列表项使用 @Reusable / 复用能力；滚动帧率与首屏时间有前后对比数据',
        severity: 'warn',
        source: OH,
        citation: {
            label: '性能优化指导 · 列表场景 LazyForEach + 组件复用 + 缓存列表项',
            url: `${OH_BASE}/performance/application-performance-optimization-guidance.md`,
            section: '列表场景',
            version: OH_SHA.slice(0, 7)
        }
    },
    // ── 无障碍 ──────────────────────────────────────────────────────────────
    {
        id: 'DW-A11Y-01',
        dimension: 'accessibility',
        title: '文字对比度 ≥ 4.5:1',
        verify: '取色计算：正文 ≥ 4.5:1，大字号 ≥ 3:1',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '通用应用 UX 体验标准 2.1.4.1 色彩对比度（正文 4.5:1，图标/标题 3:1）',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.1.4.1',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-A11Y-02',
        dimension: 'accessibility',
        title: '触控目标 ≥ 48×48vp',
        verify: '布局树 bounds ≥ 48vp（官方硬下限 40vp），相邻目标间距 ≥ 8vp',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '通用应用 UX 体验标准 2.1.3.3 点击热区（推荐 48vp，必须 ≥40vp）',
            url: `${UX_BASE}/ux-guidelines-general-0000001760708152.md`,
            section: '2.1.3.3',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-A11Y-03',
        dimension: 'accessibility',
        title: '焦点可见且顺序正确',
        verify: '键盘/遥控遍历：焦点框可见、顺序可预期',
        severity: 'must',
        source: DESIGN,
        citation: {
            label: '人机交互 · 焦点导航',
            url: `${UX_BASE}/hmi-focus-0000001748650376.md`,
            section: '焦点导航',
            version: UX_FETCHED
        }
    },
    {
        id: 'DW-A11Y-04',
        dimension: 'accessibility',
        title: '可点击元素有无障碍名称',
        verify: 'dwguard_scan 无 A11Y-TEXT-001 命中；读屏可播报',
        severity: 'must',
        aliases: ['A11Y-TEXT-001'],
        source: SCAN,
        citation: {
            label: 'ArkUI 无障碍属性（accessibilityText 等）',
            url: `${OH_BASE}/ui/arkts-universal-attributes-accessibility.md`,
            section: '无障碍属性',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-A11Y-05',
        dimension: 'accessibility',
        title: '字体放大不破版',
        verify: '系统字体 1.3x/1.75x：不截断、不重叠、不出容器',
        severity: 'must',
        source: RUBRIC,
        citation: {
            label: '系统环境变量 · fontScale（跟随系统字体缩放）',
            url: `${OH_BASE}/ui/arkts-env-system-property.md`,
            section: '@Env支持参数',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-A11Y-06',
        dimension: 'accessibility',
        title: '状态不只靠颜色',
        verify: '错误/成功同时有图标或文案',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-A11Y-07',
        dimension: 'accessibility',
        title: '动效可降级',
        verify: '系统「减少动态效果」开启后，非必要动效淡入或直切',
        severity: 'must',
        source: RUBRIC
    },
    {
        id: 'DW-A11Y-08',
        dimension: 'accessibility',
        title: '无障碍文本只写功能简述',
        verify: '读屏检查：accessibilityText 是一句功能描述，不塞操作引导或冗长提示',
        severity: 'warn',
        source: OH,
        citation: {
            label: 'ArkUI 无障碍属性 · accessibilityText 使用建议',
            url: `${OH_BASE}/ui/arkts-universal-attributes-accessibility.md`,
            section: 'accessibilityText',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-A11Y-09',
        dimension: 'accessibility',
        title: '信息型组合按组播报',
        verify: '读屏检查：卡片/整行只聚焦一次并合并播报（accessibilityGroup(true)），内部文字不被逐个聚焦',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 无障碍 · 设置无障碍分组（accessibilityGroup）',
            url: `${OH_BASE}/ui/arkts-universal-attributes-accessibility.md`,
            section: '设置无障碍分组',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-A11Y-10',
        dimension: 'accessibility',
        title: '装饰元素移出无障碍树',
        verify: '读屏遍历：纯装饰图标/分割线不聚焦（accessibilityLevel("no")），不可用整块用 no-hide-descendants',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 无障碍 · 设置无障碍重要性（accessibilityLevel）',
            url: `${OH_BASE}/ui/arkts-universal-attributes-accessibility.md`,
            section: '设置无障碍重要性',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-A11Y-11',
        dimension: 'accessibility',
        title: '操作提示与功能描述分离',
        verify: '读屏：accessibilityText 只描述“是什么”，操作方式写在 accessibilityDescription，不混在一起',
        severity: 'warn',
        source: OH,
        citation: {
            label: 'ArkUI 无障碍 · 设置无障碍提醒（accessibilityDescription）',
            url: `${OH_BASE}/ui/arkts-universal-attributes-accessibility.md`,
            section: '设置无障碍提醒',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-A11Y-12',
        dimension: 'accessibility',
        title: '外接键盘/遥控器可遍历全部交互元素',
        verify: '键盘 Tab 或遥控器：所有可交互元素可达、焦点激活态可见、顺序与视觉一致、首焦点在预期位置',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 焦点处理 · 基础概念与走焦规范',
            url: `${OH_BASE}/ui/arkts-common-events-focus-event.md`,
            section: '基础概念与规范',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-STATE-02',
        dimension: 'function',
        title: '@ObservedV2 + @Trace 才可深度观测',
        verify: '代码检查：@ObservedV2 只装饰 class；UI 用到的字段都有 @Trace，未 @Trace 的字段不参与刷新',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 状态管理 V2 · @ObservedV2/@Trace 使用限制',
            url: `${OH_BASE}/ui/state-management/arkts-new-observedV2-and-trace.md`,
            section: '使用限制',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-STATE-03',
        dimension: 'function',
        title: 'V1 装饰器不与 @ObservedV2 混用',
        verify: '编译通过；V1 组件不接收 @ObservedV2 实例，V1 装饰器不修饰 @ObservedV2 类',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 状态管理 V1/V2 混用指导 · 限制条件',
            url: `${OH_BASE}/ui/state-management/arkts-v1-v2-mixusage.md`,
            section: '限制条件',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-STATE-04',
        dimension: 'function',
        title: '@Local 只用于 @ComponentV2 且不外部初始化',
        verify: '代码检查：@Local 只出现在 @ComponentV2；父组件不向 @Local 传值（编译应报错）',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 状态管理 V2 · @Local 限制条件',
            url: `${OH_BASE}/ui/state-management/arkts-new-local.md`,
            section: '限制条件',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-STATE-05',
        dimension: 'function',
        title: 'V2 父子通信用 @Param + @Event',
        verify: '代码检查：@ComponentV2 子组件输入用 @Param、回调用 @Event；不再用 @Link 做 V2 双向同步',
        severity: 'must',
        source: OH,
        citation: {
            label: 'ArkUI 状态管理 V2 · @Param / @Event 装饰器说明',
            url: `${OH_BASE}/ui/state-management/arkts-new-param.md`,
            section: '装饰器说明',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-10',
        dimension: 'performance',
        title: '冷启动按五阶段取证',
        verify: 'SmartPerf/Profiler 冷启动 Trace：给出进程创建→Ability 生命周期→首帧的分段耗时，首帧 ≤ 800ms（中端机）',
        severity: 'must',
        source: OH,
        citation: {
            label: '提升应用冷启动速度 · 分析应用冷启动耗时（五阶段）',
            url: `${OH_BASE}/performance/improve-application-cold-start-speed.md`,
            section: '分析应用冷启动耗时',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-PERF-11',
        dimension: 'performance',
        title: '滑动场景无超长帧',
        verify: 'Trace/Frame 抓 5s 滑动：无 > 33.3ms 超长帧，记录丢帧率、设备型号与刷新率',
        severity: 'must',
        source: OH,
        citation: {
            label: '应用滑动场景帧率问题分析 · 流畅评测指标',
            url: `${OH_BASE}/performance/long-frame-optimization.md`,
            section: '流畅评测指标',
            version: OH_SHA.slice(0, 7)
        }
    },
    {
        id: 'DW-AES-12',
        dimension: 'aesthetic',
        title: '按钮宽度上限与多按钮间距',
        verify: '布局树 bounds：单按钮 ≤ 448vp；多按钮等宽、间距 12vp；容器两侧留 16vp',
        severity: 'warn',
        source: DESIGN,
        citation: {
            label: '按钮 · 响应式布局（最大 448vp、间距 12vp、两侧 16vp）',
            url: `${UX_BASE}/button-0000001929683228.md`,
            section: '响应式布局',
            version: UX_FETCHED
        }
    }
];
const BY_ID = new Map();
for (const rule of RULES) {
    BY_ID.set(rule.id, rule);
    for (const alias of rule.aliases ?? [])
        BY_ID.set(alias, rule);
}
/** Resolve a canonical ID or alias to its entry. */
export function findRule(id) {
    return BY_ID.get(id.trim());
}
/** Whether an ID or alias is in the catalog. */
export function isKnownRuleId(id) {
    return BY_ID.has(id.trim());
}
/** All IDs and aliases (for error messages / docs). */
export function knownRuleIds() {
    return [...BY_ID.keys()].sort();
}
/** Rule IDs that the static scanner emits, mapped to canonical entries. */
export function scanRuleIds() {
    return RULES.flatMap((rule) => rule.aliases ?? []).filter((alias) => !alias.startsWith('AGC-'));
}
