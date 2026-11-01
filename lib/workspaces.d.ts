/**
 * Which workspaces the DwGuard tools have touched.
 *
 * The panel needs a workspace list before any session in it is open, so every
 * tool call stamps its workspace into a small registry under the DSH home. The
 * 10-minute throttle keeps the file write off the hot path.
 *
 * @module dwguard-dsh-hmos/workspaces
 */
/** One remembered workspace. */
export interface WorkspaceRecord {
    readonly path: string;
    /** ISO timestamp of the last DwGuard tool call in it. */
    readonly lastSeen: string;
}
/** Registry file path (`<dshHome>/dwguard/workspaces.json`). */
export declare function registryFile(): string;
/** Display name of a workspace directory. */
export declare function workspaceName(path: string): string;
/** Remembered workspaces, newest first. */
export declare function listWorkspaces(): Promise<WorkspaceRecord[]>;
/**
 * Record that a workspace is in use, at most once per throttle window.
 * @param workspace - absolute workspace path.
 * @param now - ISO timestamp.
 */
export declare function rememberWorkspace(workspace: string, now: string): Promise<void>;
