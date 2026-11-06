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
function hdcPrefix(device) {
    return device === undefined ? [] : ['-t', device];
}
/** Plan fallback tiers for a pipeline step (primary devecocli is not included). */
export function buildFallbackTiers(ctx) {
    const tiers = [];
    const mcp = ctx.mcpCommand?.trim();
    if (mcp !== undefined && mcp.length > 0) {
        tiers.push({
            name: 'mcp',
            commands: [{ command: mcp, args: [...ctx.primaryArgs] }]
        });
    }
    const hdc = ctx.hdcPath;
    const stamp = ctx.stamp ?? Date.now();
    const prefix = hdcPrefix(ctx.device);
    const commands = [];
    if (ctx.step === 'build') {
        commands.push({ command: ctx.hvigorPath, args: ['assembleHap'] });
    }
    else if (ctx.step === 'run') {
        if (ctx.hapPath !== undefined && ctx.bundle !== undefined && ctx.ability !== undefined) {
            commands.push({ command: hdc, args: [...prefix, 'install', '-r', ctx.hapPath] });
            commands.push({ command: hdc, args: [...prefix, 'shell', 'aa', 'start', '-a', ctx.ability, '-b', ctx.bundle] });
        }
    }
    else if (ctx.step === 'screenshot') {
        if (ctx.screenshotPath !== undefined) {
            const remote = `/data/local/tmp/dwguard-shot-${stamp}.jpeg`;
            commands.push({ command: hdc, args: [...prefix, 'shell', 'snapshot_display', '-f', remote] });
            commands.push({ command: hdc, args: [...prefix, 'file', 'recv', remote, ctx.screenshotPath] });
        }
    }
    else if (ctx.step === 'layout') {
        if (ctx.layoutPath !== undefined) {
            const remote = `/data/local/tmp/dwguard-layout-${stamp}.json`;
            commands.push({ command: hdc, args: [...prefix, 'shell', 'uitest', 'dumpLayout', '-p', remote] });
            commands.push({ command: hdc, args: [...prefix, 'file', 'recv', remote, ctx.layoutPath] });
        }
    }
    if (commands.length > 0)
        tiers.push({ name: 'hdc+hvigor', commands });
    return tiers;
}
