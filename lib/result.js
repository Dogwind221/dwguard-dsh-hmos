/**
 * One uniform result envelope for every DwGuard tool.
 *
 * Every tool returns `{ ok, summary, detail?, files?, next? }`, renders it as
 * markdown, and declares the same JSON Schema, so the model sees one stable
 * shape and the GUI one stable card across the whole workflow.
 *
 * @module dwguard-dsh-hmos/result
 */
/** Shared output schema (kept here so all tools cannot drift apart). */
export const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true, description: 'Whether this stage succeeded.' },
        summary: { type: 'string', required: true, description: 'One-line outcome.' },
        detail: { type: 'string', description: 'Markdown body.' },
        files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative files written or read.'
        },
        next: { type: 'string', description: 'Recommended next action.' }
    }
};
/** Build a successful result. */
export function ok(summary, extra = {}) {
    return { ok: true, summary, ...extra };
}
/** Build a rejected-but-not-thrown result (gate failure, invalid input). */
export function fail(summary, extra = {}) {
    return { ok: false, summary, ...extra };
}
/** Render one result into model-facing text. */
export function renderResult(_args, value) {
    const lines = [`${value.ok ? '【完成】' : '【未通过】'}${value.summary}`];
    if (value.detail !== undefined && value.detail.trim().length > 0) {
        lines.push('', value.detail.trim());
    }
    if (value.files !== undefined && value.files.length > 0) {
        lines.push('', '文件：');
        for (const file of value.files)
            lines.push(`- \`${file}\``);
    }
    if (value.next !== undefined && value.next.trim().length > 0) {
        lines.push('', `下一步：${value.next.trim()}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
}
/** Present one pending call as a plain card. */
export function presentCall(title, kind, rawInput) {
    return { card: 'generic', title, kind, rawInput };
}
/** Compose `【完成】` / `【未通过】` prefixes without duplicating them in summaries. */
export function statusPrefix(okFlag) {
    return okFlag ? '通过' : '未通过';
}
