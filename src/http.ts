/**
 * Bounded HTTP response reading (0.8.6).
 *
 * `response.text()`/`json()` accept arbitrarily large bodies. Embedding
 * endpoints are untrusted network input, so read with a hard byte cap and
 * abort as soon as it is exceeded.
 *
 * @module dwguard-dsh-hmos/http
 */

export const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ResponseTooLargeError extends Error {}

/** Read a response body as UTF-8 text, refusing bodies over `maxBytes`. */
export async function readResponseTextLimited(
  response: Response,
  maxBytes = MAX_HTTP_RESPONSE_BYTES
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(`响应体过大（content-length ${declared} > ${maxBytes}）`);
  }
  if (response.body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ResponseTooLargeError(`响应体过大（上限 ${maxBytes} B）`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(`响应体过大（上限 ${maxBytes} B）`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
