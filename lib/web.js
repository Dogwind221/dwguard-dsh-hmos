/**
 * The panel's read-only HTTP endpoint.
 *
 * `dsh-host-webserver` exposes a named-route registry; this module claims one
 * exact path and answers the Web client with the same projection the tools
 * derive from `.shared/`. It never writes and refuses cross-site callers.
 *
 * The row may mount before the web server does, so registration goes through
 * `ctx.inject(['webServer'])` when the service is not there yet — the same
 * pattern the market plugin uses.
 *
 * @module dwguard-dsh-hmos/web
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readBoard } from './board.js';
import { nowIso } from './util/md.js';
import { listWorkspaces, workspaceName } from './workspaces.js';
/** The endpoint the client fetches. */
export const BOARD_PATH = '/dwguard/board';
function workspaceId(path) {
    return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16);
}
function hostname(host) {
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end < 0 ? host : host.slice(1, end).toLowerCase();
    }
    return host.split(':')[0]?.toLowerCase() ?? host.toLowerCase();
}
function isLoopbackHost(host) {
    const name = hostname(host);
    return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}
function headerValue(request, name) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
function sendJson(response, status, body) {
    const payload = `${JSON.stringify(body)}\n`;
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
        'cache-control': 'no-store'
    });
    response.end(payload);
}
function mount(ctx, options) {
    const server = ctx.get?.('webServer');
    if (server === undefined) {
        ctx.logger?.info?.('[dwguard-hmos] 未检测到 webServer，看板接口未注册（工具与 skill 不受影响）');
        return;
    }
    try {
        const dispose = server.register({
            kind: 'exact',
            path: BOARD_PATH,
            async handler(request, response) {
                if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
                    sendJson(response, 405, { error: 'method not allowed' });
                    return;
                }
                const site = headerValue(request, 'sec-fetch-site');
                if (site !== undefined && site !== 'same-origin' && site !== 'none') {
                    sendJson(response, 403, { error: 'cross-site request refused' });
                    return;
                }
                const host = headerValue(request, 'host');
                if (host === undefined) {
                    sendJson(response, 400, { error: 'missing host header' });
                    return;
                }
                if (options.boardToken.length === 0 && !isLoopbackHost(host)) {
                    sendJson(response, 403, { error: 'board is loopback-only; configure boardToken to allow remote hosts' });
                    return;
                }
                const token = headerValue(request, 'x-dwguard-token');
                if (options.boardToken.length > 0 && token !== options.boardToken) {
                    sendJson(response, 403, { error: 'invalid board token' });
                    return;
                }
                const origin = headerValue(request, 'origin');
                if (origin !== undefined) {
                    try {
                        const parsed = new URL(origin);
                        if (!isLoopbackHost(parsed.host) && hostname(parsed.host) !== hostname(host)) {
                            sendJson(response, 403, { error: 'cross-origin request refused' });
                            return;
                        }
                    }
                    catch {
                        sendJson(response, 403, { error: 'invalid origin' });
                        return;
                    }
                }
                const url = new URL(request.url ?? '/', 'http://localhost');
                const requestedId = url.searchParams.get('workspace');
                const requestedCwd = url.searchParams.get('cwd');
                const now = nowIso();
                try {
                    const records = await listWorkspaces();
                    const views = records.map((record) => ({
                        id: workspaceId(record.path),
                        name: workspaceName(record.path),
                        lastSeen: record.lastSeen
                    }));
                    let activeRecord = records[0] ?? null;
                    if (requestedId !== null && requestedId.trim().length > 0) {
                        const wanted = requestedId.trim();
                        activeRecord = records.find((record) => workspaceId(record.path) === wanted) ?? null;
                        if (activeRecord === null) {
                            sendJson(response, 403, { error: 'workspace is not registered' });
                            return;
                        }
                    }
                    else if (requestedCwd !== null && requestedCwd.trim().length > 0) {
                        const wanted = resolve(requestedCwd.trim());
                        activeRecord = records.find((record) => resolve(record.path) === wanted) ?? null;
                        if (activeRecord === null) {
                            sendJson(response, 403, { error: 'workspace is not registered' });
                            return;
                        }
                    }
                    const active = activeRecord === null ? null : workspaceId(activeRecord.path);
                    const board = activeRecord === null ? null : await readBoard(activeRecord.path, options, now);
                    const body = { generatedAt: now, sharedDir: options.sharedDir, workspaces: views, active, board };
                    sendJson(response, 200, body);
                }
                catch (error) {
                    ctx.logger?.warn?.(`[dwguard-hmos] 看板接口失败：${error instanceof Error ? error.message : String(error)}`);
                    sendJson(response, 500, { error: 'board unavailable' });
                }
            }
        });
        ctx.effect(() => dispose, 'dwguard-hmos.board-route');
        ctx.logger?.info?.(`[dwguard-hmos] 看板接口已注册：${BOARD_PATH}`);
    }
    catch (error) {
        ctx.logger?.warn?.(`[dwguard-hmos] 看板接口注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Register the board endpoint once the composition's web server is available.
 * @param ctx - plugin context.
 * @param options - resolved plugin options.
 */
export function registerBoardRoute(ctx, options) {
    if (ctx.get?.('webServer') !== undefined) {
        mount(ctx, options);
        return;
    }
    if (typeof ctx.inject === 'function') {
        try {
            ctx.inject(['webServer'], (hostCtx) => mount(hostCtx, options));
            return;
        }
        catch (error) {
            ctx.logger?.warn?.(`[dwguard-hmos] 等待 webServer 失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    mount(ctx, options);
}
