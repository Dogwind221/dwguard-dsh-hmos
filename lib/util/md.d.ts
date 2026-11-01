/**
 * Markdown building blocks shared by every generated document.
 *
 * @module dwguard-dsh-hmos/util/md
 */
/** Collapse all whitespace runs into single spaces. */
export declare function inline(value: string): string;
/** Escape a value for one markdown table cell. */
export declare function escapeCell(value: string): string;
/** Render a markdown table; an empty row list renders only the header. */
export declare function table(headers: readonly string[], rows: readonly (readonly string[])[]): string;
/** Render a bullet list, or a placeholder when empty. */
export declare function bullets(items: readonly string[], empty?: string): string;
/** Current time as an ISO-8601 string with seconds precision. */
export declare function nowIso(): string;
/** Truncate by characters, adding an ellipsis when shortened. */
export declare function truncate(value: string, max: number): string;
/** Quote a block of text as a markdown blockquote. */
export declare function quote(text: string): string;
