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

import type { Options } from './config.js';
import type { PluginContext } from './context.js';
import { readBoard } from './board.js';
import { nowIso } from './util/md.js';
import { listWorkspaces, workspaceName } from './workspaces.js';

/** The endpoint the client fetches. */
export const BOARD_PATH = '/dwguard/board';

interface IncomingLike {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (request: IncomingLike, response: ServerResponseLike) => void | Promise<void>;
  }): () => void;
}

interface BoardResponse {
  readonly generatedAt: string;
  readonly sharedDir: string;
  readonly workspaces: ReadonlyArray<{ readonly path: string; readonly name: string; readonly lastSeen: string }>;
  readonly active: string | null;
  readonly board: Awaited<ReturnType<typeof readBoard>>;
}

function headerValue(request: IncomingLike, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponseLike, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store'
  });
  response.end(payload);
}

function mount(ctx: PluginContext, options: Options): void {
  const server = ctx.get?.('webServer') as WebServerLike | undefined;
  if (server === undefined) {
    ctx.logger?.info?.('[dwguard-hmos] 未检测到 webServer，看板接口未注册（工具与 skill 不受影响）');
    return;
  }
  try {
    const dispose = server.register({
      kind: 'exact',
      path: BOARD_PATH,
      async handler(request: IncomingLike, response: ServerResponseLike): Promise<void> {
        if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
          sendJson(response, 405, { error: 'method not allowed' });
          return;
        }
        const site = headerValue(request, 'sec-fetch-site');
        if (site !== undefined && site !== 'same-origin' && site !== 'none') {
          sendJson(response, 403, { error: 'cross-site request refused' });
          return;
        }
        if (headerValue(request, 'host') === undefined) {
          sendJson(response, 400, { error: 'missing host header' });
          return;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');
        const requested = url.searchParams.get('cwd');
        const now = nowIso();
        try {
          const records = await listWorkspaces();
          const workspaces = records.map((record) => ({
            path: record.path,
            name: workspaceName(record.path),
            lastSeen: record.lastSeen
          }));
          const active =
            requested !== null && requested.trim().length > 0 ? requested.trim() : (workspaces[0]?.path ?? null);
          const board = active === null ? null : await readBoard(active, options, now);
          const body: BoardResponse = { generatedAt: now, sharedDir: options.sharedDir, workspaces, active, board };
          sendJson(response, 200, body);
        } catch (error) {
          ctx.logger?.warn?.(`[dwguard-hmos] 看板接口失败：${error instanceof Error ? error.message : String(error)}`);
          sendJson(response, 500, { error: 'board unavailable' });
        }
      }
    });
    ctx.effect(() => dispose, 'dwguard-hmos.board-route');
    ctx.logger?.info?.(`[dwguard-hmos] 看板接口已注册：${BOARD_PATH}`);
  } catch (error) {
    ctx.logger?.warn?.(
      `[dwguard-hmos] 看板接口注册失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Register the board endpoint once the composition's web server is available.
 * @param ctx - plugin context.
 * @param options - resolved plugin options.
 */
export function registerBoardRoute(ctx: PluginContext, options: Options): void {
  if (ctx.get?.('webServer') !== undefined) {
    mount(ctx, options);
    return;
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (hostCtx) => mount(hostCtx, options));
      return;
    } catch (error) {
      ctx.logger?.warn?.(
        `[dwguard-hmos] 等待 webServer 失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  mount(ctx, options);
}
