/**
 * One uniform result envelope for every DwGuard tool.
 *
 * Every tool returns `{ ok, summary, detail?, files?, next? }`, renders it as
 * markdown, and declares the same JSON Schema, so the model sees one stable
 * shape and the GUI one stable card across the whole workflow.
 *
 * @module dwguard-dsh-hmos/result
 */
import type { ContentBlock, JsonSchemaNode } from '@deepseek-ai/dsh-tools';
/** Canonical value every DwGuard tool returns. */
export interface ToolResult {
    /** Whether the requested stage succeeded (a failed gate is a `false`, not an error). */
    readonly ok: boolean;
    /** One line the model can quote. */
    readonly summary: string;
    /** Markdown body: tables, gaps, briefs, reports. */
    readonly detail?: string;
    /** Files written or read, relative to the workspace. */
    readonly files?: readonly string[];
    /** The one recommended next action. */
    readonly next?: string;
}
/** Shared output schema (kept here so all tools cannot drift apart). */
export declare const RESULT_SCHEMA: JsonSchemaNode;
/** Build a successful result. */
export declare function ok(summary: string, extra?: Omit<ToolResult, 'ok' | 'summary'>): ToolResult;
/** Build a rejected-but-not-thrown result (gate failure, invalid input). */
export declare function fail(summary: string, extra?: Omit<ToolResult, 'ok' | 'summary'>): ToolResult;
/** Render one result into model-facing text. */
export declare function renderResult(_args: unknown, value: ToolResult): ContentBlock[];
/** Present one pending call as a plain card. */
export declare function presentCall(title: string, kind: 'read' | 'edit' | 'other', rawInput: unknown): {
    card: 'generic';
    title: string;
    kind: string;
    rawInput: unknown;
};
/** Compose `【完成】` / `【未通过】` prefixes without duplicating them in summaries. */
export declare function statusPrefix(okFlag: boolean): string;
