/**
 * Command-id idempotency (0.8.5).
 *
 * Every tool accepts an optional `commandId`. Re-submitting the same id in the
 * same workspace returns the first result instead of repeating bookkeeping
 * (audits, dispatches, confirmations…). The ledger is protected by a lock file.
 *
 * @module dwguard-dsh-hmos/idempotency
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from './config.js';
import type { PluginContext } from './context.js';
/** Add `commandId` to a tool and make repeated calls idempotent. */
export declare function withCommandIdempotency<T>(tool: ToolDefinition<unknown, T>, options: Options, ctx?: PluginContext): ToolDefinition<unknown, T>;
export { withCommandIdempotency as withCommandId };
