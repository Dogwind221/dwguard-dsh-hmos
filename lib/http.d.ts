/**
 * Bounded HTTP response reading (0.8.6).
 *
 * `response.text()`/`json()` accept arbitrarily large bodies. Embedding
 * endpoints are untrusted network input, so read with a hard byte cap and
 * abort as soon as it is exceeded.
 *
 * @module dwguard-dsh-hmos/http
 */
export declare const MAX_HTTP_RESPONSE_BYTES: number;
export declare class ResponseTooLargeError extends Error {
}
/** Read a response body as UTF-8 text, refusing bodies over `maxBytes`. */
export declare function readResponseTextLimited(response: Response, maxBytes?: number): Promise<string>;
