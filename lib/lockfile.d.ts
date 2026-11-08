/**
 * Tiny cross-process file lock (0.8.5).
 *
 * `writeTextAtomic` prevents half-written files but not lost read-modify-write
 * updates. This lock is used around state/CAS and index reservation; it is not a
 * general distributed lock and is scoped to one `.shared/` directory.
 *
 * @module dwguard-dsh-hmos/lockfile
 */
export declare class LockTimeoutError extends Error {
}
/**
 * Run `fn` while holding an exclusive `wx` lock file.
 * @param file - lock file path.
 * @param fn - critical section.
 * @param timeoutMs - max wait for the lock.
 * @param staleMs - a lock older than this is reclaimed.
 */
export declare function withFileLock<T>(file: string, fn: () => Promise<T>, timeoutMs?: number, staleMs?: number): Promise<T>;
