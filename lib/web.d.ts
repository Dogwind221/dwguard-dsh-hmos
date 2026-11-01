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
/** The endpoint the client fetches. */
export declare const BOARD_PATH = "/dwguard/board";
/**
 * Register the board endpoint once the composition's web server is available.
 * @param ctx - plugin context.
 * @param options - resolved plugin options.
 */
export declare function registerBoardRoute(ctx: PluginContext, options: Options): void;
