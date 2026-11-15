/**
 * dwguard_code - run the frozen Goal brief through the DevEco Code CLI.
 *
 * This is the zero-click path: DSH starts "deveco run" in a background
 * process, streams its JSON events into artifacts/code-<n>/, and returns a
 * job id. It never treats the agent's own claims as acceptance - the audit
 * still runs independently.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
export declare function resolveCodeBinary(configured: string): string;
export declare function buildCodeArgs(input: {
    readonly dir: string;
    readonly prompt: string;
    readonly model?: string;
    readonly agent?: string;
    readonly auto: boolean;
}): string[];
export declare function createCodeTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
