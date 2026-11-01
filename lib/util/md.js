/**
 * Markdown building blocks shared by every generated document.
 *
 * @module dwguard-dsh-hmos/util/md
 */
/** Collapse all whitespace runs into single spaces. */
export function inline(value) {
    return value.replace(/\s+/g, ' ').trim();
}
/** Escape a value for one markdown table cell. */
export function escapeCell(value) {
    return inline(value).replaceAll('|', '\\|');
}
/** Render a markdown table; an empty row list renders only the header. */
export function table(headers, rows) {
    const head = `| ${headers.map(escapeCell).join(' | ')} |`;
    const split = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
    return [head, split, ...body].join('\n');
}
/** Render a bullet list, or a placeholder when empty. */
export function bullets(items, empty = '（无）') {
    if (items.length === 0)
        return empty;
    return items.map((item) => `- ${item}`).join('\n');
}
/** Current time as an ISO-8601 string with seconds precision. */
export function nowIso() {
    return new Date().toISOString();
}
/** Truncate by characters, adding an ellipsis when shortened. */
export function truncate(value, max) {
    if (value.length <= max)
        return value;
    return `${value.slice(0, Math.max(0, max - 1))}…`;
}
/** Quote a block of text as a markdown blockquote. */
export function quote(text) {
    return text
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
}
