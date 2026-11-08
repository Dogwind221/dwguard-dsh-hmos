/**
 * Tiny cross-process file lock (0.8.5).
 *
 * `writeTextAtomic` prevents half-written files but not lost read-modify-write
 * updates. This lock is used around state/CAS and index reservation; it is not a
 * general distributed lock and is scoped to one `.shared/` directory.
 *
 * @module dwguard-dsh-hmos/lockfile
 */

import { open, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ensureDir } from './util/fs.js';

export class LockTimeoutError extends Error {}

/**
 * Run `fn` while holding an exclusive `wx` lock file.
 * @param file - lock file path.
 * @param fn - critical section.
 * @param timeoutMs - max wait for the lock.
 * @param staleMs - a lock older than this is reclaimed.
 */
export async function withFileLock<T>(
  file: string,
  fn: () => Promise<T>,
  timeoutMs = 5_000,
  staleMs = 30_000
): Promise<T> {
  await ensureDir(dirname(file));
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await open(file, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs > staleMs) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new LockTimeoutError(`等待锁超时：${file}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(file).catch(() => undefined);
  }
}
