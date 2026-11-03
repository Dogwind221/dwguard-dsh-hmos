/**
 * DwGuard-Dsh-Hmos — the DSH half of a HarmonyOS dual-agent workflow.
 *
 * One host row registers fifteen tools, three skills and one team-policy prompt
 * section. The tools are the stage gates; the skills carry the methodology; the
 * section states the one rule that matters: DSH orchestrates and audits, it
 * does not write the app.
 *
 * @module dwguard-dsh-hmos
 */
import { resolveOptions } from './config.js';
import { PROMPT_SECTION_NAME, PROMPT_SECTION_TEXT } from './prompt.js';
import { loadSkills } from './skills.js';
import { createAuditTool } from './tools/audit.js';
import { createAuditDimensionTool } from './tools/auditDimension.js';
import { createAestheticTool } from './tools/aesthetic.js';
import { createDesignTool } from './tools/design.js';
import { createCalibrationTool } from './tools/calibration.js';
import { createConfirmTool } from './tools/confirm.js';
import { createDevecoTool } from './tools/deveco.js';
import { createDispatchTool } from './tools/dispatch.js';
import { createKnowledgeTool } from './tools/knowledge.js';
import { createPrereviewTool } from './tools/prereview.js';
import { createRulesTool } from './tools/rules.js';
import { createScanTool } from './tools/scan.js';
import { createShadowTool } from './tools/shadow.js';
import { createSpecTool } from './tools/spec.js';
import { createStatusTool } from './tools/status.js';
import { registerBoardRoute } from './web.js';
/** Cordis plugin name. */
export const name = 'dwguard-hmos';
/**
 * Only the tool registry is mandatory. The skill registry and the prompt
 * registry are resolved optionally through `ctx.get`, so the plugin still loads
 * in a composition that mounts neither.
 */
export const inject = ['tools'];
export { Config } from './config.js';
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Register the DwGuard capabilities.
 * @param ctx - plugin context carrying the tool registry (and optionally skills / systemPrompt).
 * @param config - the row's `config` block, already defaulted by the loader.
 */
export function apply(ctx, config) {
    const options = resolveOptions(config);
    const tools = [
        createSpecTool(options, ctx),
        createPrereviewTool(options, ctx),
        createDispatchTool(options, ctx),
        createScanTool(options, ctx),
        createDevecoTool(options, ctx),
        createRulesTool(options, ctx),
        createShadowTool(options, ctx),
        createAuditDimensionTool(options, ctx),
        createAuditTool(options, ctx),
        createAestheticTool(options, ctx),
        createDesignTool(options, ctx),
        createCalibrationTool(options, ctx),
        createConfirmTool(options, ctx),
        createKnowledgeTool(options, ctx),
        createStatusTool(options, ctx)
    ];
    for (const tool of tools) {
        try {
            ctx.tools.register(tool);
        }
        catch (error) {
            // A rejected definition must not take the whole host down with it.
            ctx.logger?.error?.(`[dwguard-hmos] 工具 ${tool.name} 注册失败：${describeError(error)}`);
        }
    }
    const skills = ctx.get?.('skills');
    if (options.installSkills && skills !== undefined) {
        ctx.effect(() => {
            const disposers = [];
            for (const skill of loadSkills()) {
                try {
                    disposers.push(skills.register(skill));
                }
                catch (error) {
                    ctx.logger?.warn?.(`[dwguard-hmos] skill ${skill.name} 注册失败：${describeError(error)}`);
                }
            }
            ctx.logger?.info?.(`[dwguard-hmos] 已注册 ${tools.length} 个工具、${disposers.length} 个 skill、共享目录 ${options.sharedDir}`);
            return () => {
                for (const dispose of disposers)
                    dispose();
            };
        }, 'dwguard-hmos.skills');
    }
    const prompt = ctx.get?.('systemPrompt');
    if (options.promptSection && prompt !== undefined) {
        try {
            ctx.effect(() => prompt.section({
                name: PROMPT_SECTION_NAME,
                order: prompt.getSectionOrder('TEAM_POLICY'),
                text: PROMPT_SECTION_TEXT
            }), 'dwguard-hmos.policy');
        }
        catch (error) {
            ctx.logger?.warn?.(`[dwguard-hmos] 提示词片段注册失败：${describeError(error)}`);
        }
    }
    // The DshHoms panel's read-only board endpoint; a composition without a web
    // server simply skips it.
    try {
        registerBoardRoute(ctx, options);
    }
    catch (error) {
        ctx.logger?.warn?.(`[dwguard-hmos] 看板接口初始化失败：${describeError(error)}`);
    }
}
