/**
 * Small filesystem helpers: atomic replacement, tolerant reads, retries for
 * Windows' transient rename interference.
 *
 * @module dwguard-dsh-hmos/util/fs
 */

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_ATTEMPTS = 8;

/** Narrow an unknown thrown value to a Node error with a string code. */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** Create a directory tree when missing. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Read UTF-8 text, returning `null` when the file does not exist. */
export async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether a regular file exists at the path. */
export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const transient =
        isNodeError(error) && process.platform === 'win32' && TRANSIENT_RENAME_CODES.has(error.code ?? '');
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

/**
 * Replace a file's content atomically (temp sibling + rename), creating parents.
 * Readers observe either the previous or the next complete content.
 */
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  await ensureDir(dirname(file));
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Append UTF-8 text, creating parents and the file when missing. */
export async function appendText(file: string, content: string): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, content, 'utf8');
}

/** Read a directory's entry names, or `[]` when it does not exist. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Remove a file if present. */
export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** SHA-256 of a file's bytes, lowercase hex. */
export async function sha256File(file: string): Promise<string> {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Copy a file into an evidence bundle, creating parents.
 * @returns the copied file's size in bytes.
 */
export async function copyFileTo(source: string, destination: string): Promise<number> {
  await ensureDir(dirname(destination));
  await copyFile(source, destination);
  return (await stat(destination)).size;
}

/**
 * Snapshot an actively-written log to `<file>.1` and truncate it in place.
 * The child keeps its append fd; O_APPEND writes resume at offset 0.
 */
export async function rotateActiveLog(file: string, maxBytes: number): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile() || info.size <= maxBytes) return false;
  const backup = `${file}.1`;
  await copyFile(file, backup);
  await truncate(file, 0);
  return true;
}
