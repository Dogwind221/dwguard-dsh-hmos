/**
 * Media artifact validation (0.8.6).
 *
 * A zero exit code is not proof that a screenshot was produced. This module
 * checks existence, size and magic bytes (PNG/JPEG) before the evidence is
 * recorded as successful.
 *
 * @module dwguard-dsh-hmos/media
 */

import { open, stat } from 'node:fs/promises';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export interface ImageValidation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly bytes?: number;
  readonly format?: 'png' | 'jpeg';
}

/** Validate a screenshot artifact without decoding the whole image. */
export async function validateImageFile(
  file: string,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<ImageValidation> {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile()) return { ok: false, reason: '文件不存在' };
  if (info.size <= 0) return { ok: false, reason: '文件为空' };
  if (info.size > maxBytes) return { ok: false, reason: `文件过大（${info.size} B）` };
  const headerBuffer = Buffer.alloc(8);
  let header: Buffer | null = null;
  try {
    const handle = await open(file, 'r');
    try {
      const { bytesRead } = await handle.read(headerBuffer, 0, 8, 0);
      header = headerBuffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    header = null;
  }
  if (header === null || header.length < 4) return { ok: false, reason: '无法读取文件头' };
  if (header.subarray(0, 8).equals(PNG)) return { ok: true, bytes: info.size, format: 'png' };
  if (header.subarray(0, 3).equals(JPEG)) return { ok: true, bytes: info.size, format: 'jpeg' };
  return { ok: false, reason: '文件头不是 PNG/JPEG', bytes: info.size };
}
