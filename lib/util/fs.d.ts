/**
 * Small filesystem helpers: atomic replacement, tolerant reads, retries for
 * Windows' transient rename interference.
 *
 * @module dwguard-dsh-hmos/util/fs
 */
/** Narrow an unknown thrown value to a Node error with a string code. */
export declare function isNodeError(error: unknown): error is NodeJS.ErrnoException;
/** Create a directory tree when missing. */
export declare function ensureDir(dir: string): Promise<void>;
/** Read UTF-8 text, returning `null` when the file does not exist. */
export declare function readTextOrNull(file: string): Promise<string | null>;
/** Whether a regular file exists at the path. */
export declare function fileExists(file: string): Promise<boolean>;
/**
 * Replace a file's content atomically (temp sibling + rename), creating parents.
 * Readers observe either the previous or the next complete content.
 */
export declare function writeTextAtomic(file: string, content: string): Promise<void>;
/** Append UTF-8 text, creating parents and the file when missing. */
export declare function appendText(file: string, content: string): Promise<void>;
/** Read a directory's entry names, or `[]` when it does not exist. */
export declare function listDir(dir: string): Promise<string[]>;
/** Remove a file if present. */
export declare function removeFile(file: string): Promise<void>;
/** SHA-256 of a file's bytes, lowercase hex. */
export declare function sha256File(file: string): Promise<string>;
/**
 * Copy a file into an evidence bundle, creating parents.
 * @returns the copied file's size in bytes.
 */
export declare function copyFileTo(source: string, destination: string): Promise<number>;
