/**
 * Automatic execution fallback planner (0.8.0).
 *
 * Primary path is always `devecocli`. If it fails, the pipeline can try the
 * configured MCP command and then the lower-level `hdc` + `hvigor` commands.
 * This module only builds the command plan; the tool executes and records every
 * attempt so each tier keeps its own evidence.
 *
 * @module dwguard-dsh-hmos/fallback
 */
export type FallbackStep = 'sign' | 'build' | 'run' | 'screenshot' | 'layout';
/** One command in a fallback tier. */
export interface FallbackCommand {
    readonly command: string;
    readonly args: readonly string[];
}
/** A named fallback tier. */
export interface FallbackTier {
    readonly name: 'mcp' | 'hdc+hvigor';
    readonly commands: readonly FallbackCommand[];
}
export interface FallbackPlanContext {
    readonly step: FallbackStep;
    /** Arguments of the primary devecocli command. */
    readonly primaryArgs: readonly string[];
    readonly mcpCommand?: string;
    readonly hdcPath: string;
    readonly hvigorPath: string;
    readonly device?: string;
    readonly hapPath?: string;
    readonly bundle?: string;
    readonly ability?: string;
    readonly screenshotPath?: string;
    readonly layoutPath?: string;
    readonly stamp?: number;
}
/** Plan fallback tiers for a pipeline step (primary devecocli is not included). */
export declare function buildFallbackTiers(ctx: FallbackPlanContext): FallbackTier[];
