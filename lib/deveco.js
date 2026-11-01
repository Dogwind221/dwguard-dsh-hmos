/**
 * Best-effort bridge to the `dsh-deveco` UI-tree tool.
 *
 * DSH's tool registry is not a public plugin SDK, so this module duck-types the
 * registry: if the host exposes an execution surface (`execute` or `get(name)`),
 * `dwguard_shadow` can pull a structured UI tree without the agent having to
 * export a file by hand. Any mismatch simply returns `null` and the manual
 * `uiTree` path keeps working.
 *
 * @module dwguard-dsh-hmos/deveco
 */
const UI_TREE_TOOL = 'harmony_ui_tree';
function extractText(result) {
    if (typeof result === 'string')
        return result.trim().length > 0 ? result : null;
    if (typeof result !== 'object' || result === null)
        return null;
    const record = result;
    for (const key of ['detail', 'text', 'result', 'content']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0)
            return value;
    }
    return null;
}
/**
 * Try to call `harmony_ui_tree` through whatever registry surface exists.
 * @param ctx - plugin context (optional service lookup).
 * @param exec - the current tool run context (forwarded to the nested call).
 * @returns the tree text/JSON, or `null` when the tool is unavailable.
 */
export async function captureHarmonyUiTree(ctx, exec) {
    try {
        const registry = (ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('tools') : undefined) ??
            ctx?.tools;
        if (typeof registry !== 'object' || registry === null)
            return null;
        const api = registry;
        if (typeof api['execute'] === 'function') {
            const run = api['execute'];
            return extractText(await run(UI_TREE_TOOL, { format: 'json' }, exec));
        }
        if (typeof api['get'] === 'function') {
            const definition = api['get'](UI_TREE_TOOL);
            if (typeof definition === 'object' && definition !== null) {
                const candidate = definition;
                if (typeof candidate.execute === 'function') {
                    return extractText(await candidate.execute({ format: 'json' }, exec));
                }
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
