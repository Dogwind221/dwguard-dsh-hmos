/**
 * `dwguard_calibration` — the gate's accuracy ledger.
 *
 * `report` aggregates every audit/confirm/miss record into per-dimension
 * "audited / failed / missed / miss-rate" rows. `miss` records the case that
 * matters: the gate said pass, but the user later found a problem. Without this,
 * the framework can only claim rigor; with it, it can show whether the gate
 * actually catches things.
 *
 * @module dwguard-dsh-hmos/tools/calibration
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Options } from '../config.js';
import type { PluginContext } from '../context.js';
import { type ToolResult } from '../result.js';
/**
 * Create the `dwguard_calibration` tool.
 * @param options - resolved plugin options.
 * @param ctx - plugin context (used to resolve the session working directory).
 */
export declare function createCalibrationTool(options: Options, ctx?: PluginContext): ToolDefinition<unknown, ToolResult>;
