/**
 * `dwguard_rules` — query the rule catalog and the local official-docs corpus.
 *
 * Sub-agents should not need to know where the corpus lives or how the catalog
 * is shaped: `list`/`get` answer "which rule covers this?", `search` greps the
 * official Markdown and returns file:line + source URL for a citation.
 *
 * @module dwguard-dsh-hmos/tools/rules
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_rules` tool.
 * @param options - resolved plugin options (carries `docsDir`).
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createRulesTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
