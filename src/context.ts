/**
 * The Cordis context surface this plugin consumes.
 *
 * Declared locally (rather than importing `@deepseek-ai/cordis`) so the bundle
 * has no compile-time dependency on the host installation; only the members
 * registered into `inject` are used.
 *
 * @module dwguard-dsh-hmos/context
 */

/** One runtime skill contributed by this plugin. */
export interface SkillContribution {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly content: string;
}

/** One ordered system-prompt section. */
export interface PromptSectionInput {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

/** Minimal logger surface. */
export interface PluginLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/** The session working-directory service (dsh 0.2+). */
export interface WorkingDirectoryService {
  ensure(agent: unknown, signal: AbortSignal): Promise<string>;
}

/** The services this plugin requires, all registered by `dsh-base`. */
export interface PluginContext {
  readonly tools: { register(definition: unknown): void };
  /** Resolve an optional service without declaring an injection requirement. */
  get?(name: string): unknown;
  /** Run a child plugin once the named services exist (Cordis `ctx.inject`). */
  inject?(dependencies: readonly string[], callback: (scope: PluginContext) => void): void;
  effect(body: () => (() => void) | void, label?: string): void;
  readonly logger?: PluginLogger;
}
