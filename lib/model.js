/**
 * Vocabulary shared by every stage: the four acceptance dimensions, the task
 * pack, review findings, checks, and the persisted protocol state.
 *
 * @module dwguard-dsh-hmos/model
 */
/** The four acceptance dimensions the workflow gates on. */
export const DIMENSIONS = ['function', 'aesthetic', 'performance', 'accessibility'];
/** Chinese labels used by every generated document. */
export const DIMENSION_LABELS = {
    function: '功能',
    aesthetic: '审美',
    performance: '性能',
    accessibility: '无障碍'
};
/** Recommended criterion-id prefix per dimension (`F-01`, `A-01`, ...). */
export const DIMENSION_PREFIX = {
    function: 'F',
    aesthetic: 'A',
    performance: 'P',
    accessibility: 'X'
};
/** What a criterion in each dimension must be able to name. */
export const DIMENSION_EVIDENCE = {
    function: '可复现的操作步骤 + 截图 / UI 布局树 / 日志',
    aesthetic: '截图 + 规则 ID + 可度量的间距/字号/对比度数值',
    performance: '启动/帧率/耗时数据 + 设备日志或构建产物',
    accessibility: '对比度数值 / 目标尺寸 / 焦点截图 / 可访问名称'
};
/** Huawei screen families the multi-device matrix verifies against. */
export const SCREEN_FAMILIES = ['phone', 'widefold', 'foldable', 'triplefold'];
/** Chinese labels used by generated documents. */
export const SCREEN_FAMILY_LABELS = {
    phone: '直板机',
    widefold: '阔折叠',
    foldable: '双折叠',
    triplefold: '三折叠'
};
/** Whether a string is one of the screen families. */
export function isScreenFamily(value) {
    return typeof value === 'string' && SCREEN_FAMILIES.includes(value);
}
/** Matchers a criterion assertion can use. */
export const ASSERTION_MATCHERS = ['equals', 'contains', 'regex', 'range', 'gte', 'lte', 'oneOf', 'present'];
/** Allowed aggregation for a multi-sample measurement. */
export const ACTUAL_AGGREGATIONS = ['max', 'p95', 'mean'];
/** Whether a string is one of the four dimensions. */
export function isDimension(value) {
    return typeof value === 'string' && DIMENSIONS.includes(value);
}
/** Whether a string is a review dimension. */
export function isReviewDimension(value) {
    return isDimension(value) || value === 'architecture';
}
/** A fresh state document. */
export function emptyState(now) {
    return {
        schemaVersion: 1,
        iteration: 1,
        specVersion: 0,
        prereviews: 0,
        dispatches: 0,
        audits: 0,
        roundDesignSearches: 0,
        designSearches: 0,
        inboxCursor: 0,
        shadowRuns: 0,
        confirmations: 0,
        revision: 0,
        phase: 'intake',
        updatedAt: now
    };
}
