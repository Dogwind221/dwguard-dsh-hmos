/**
 * Markdown building blocks shared by every generated document.
 *
 * @module dwguard-dsh-hmos/util/md
 */

/** Collapse all whitespace runs into single spaces. */
export function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Escape a value for one markdown table cell. */
export function escapeCell(value: string): string {
  return inline(value).replaceAll('|', '\\|');
}

/** Render a markdown table; an empty row list renders only the header. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.map(escapeCell).join(' | ')} |`;
  const split = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  return [head, split, ...body].join('\n');
}

/** Render a bullet list, or a placeholder when empty. */
export function bullets(items: readonly string[], empty = '（无）'): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${item}`).join('\n');
}

/** Current time as an ISO-8601 string with seconds precision. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Truncate by characters, adding an ellipsis when shortened. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Quote a block of text as a markdown blockquote. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}
