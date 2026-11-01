/**
 * Ambient declarations for the DeepSeek Harness packages this bundle imports.
 *
 * They mirror only the surface this plugin actually uses, so the package can be
 * type-checked and built outside a DSH checkout (DSH does not publish a plugin
 * SDK types package). The shapes are taken from the shipped `.d.ts` of
 * `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill` and
 * `@deepseek-ai/dsh-system-prompt`, and were re-checked against the built
 * `lib/index.js` of dsh 0.2.1-rc.5 (the version that actually loads it).
 *
 * @module dwguard-dsh-hmos/dsh
 */

declare module '@deepseek-ai/dsh-tools' {
  /** Execution identity handed to one accepted tool call. */
  export interface ToolRunContext {
    /** Caller cancellation; long work must observe it. */
    readonly signal: AbortSignal;
    /** The owning agent, absent for non-agent callers. */
    readonly agent?:
      | {
          readonly session: { readonly header: { readonly cwd: string } };
        }
      | undefined;
    deferContext(context: unknown): void;
    concludeTurn(): void;
  }

  /** One model-facing content block. */
  export interface ContentBlock {
    readonly type: 'text';
    readonly text: string;
  }

  /** Loose JSON-Schema node accepted by the tool registry. */
  export type JsonSchemaNode = Record<string, unknown>;

  /** Canonical output declaration: schema plus model-facing rendering. */
  export interface ToolOutput<R> {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: R): ContentBlock[];
  }

  /** Pure presentation projection for one pending call. */
  export interface ToolCallView {
    readonly card: 'generic';
    readonly title: string;
    readonly kind: string;
    readonly rawInput?: unknown;
  }

  /** A complete tool definition. */
  export interface ToolDefinition<A, R> {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, JsonSchemaNode>;
    readonly output: ToolOutput<R>;
    execute(args: A, exec: ToolRunContext): Promise<R>;
    readonly timeoutMs?: number;
    presentCall?(args: A): ToolCallView | undefined;
    isConcurrencySafe?(args: A): boolean;
  }

  /** Validate one definition against the registry contract. */
  export function defineTool<A, R>(definition: ToolDefinition<A, R>): ToolDefinition<A, R>;
}

declare module '@deepseek-ai/schemastery' {
  /** Schemastery's default export; only `object`, the leaf schemas and `default` are used here. */
  const z: any;
  export default z;
}
