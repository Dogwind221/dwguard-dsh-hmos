/**
 * Read-only introspection of a DevEco / HarmonyOS project layout.
 *
 * The `project` action answers "what is this project?" without building it:
 * bundle identity, SDK versions, products/build modes, modules, abilities,
 * permissions, page tables, dependencies and existing HAP artifacts. It only
 * reads files; nothing is executed and nothing outside `root` is touched.
 *
 * DevEco config files are JSON5 (comments, trailing commas). A tiny tolerant
 * reader lives here instead of adding a dependency.
 *
 * @module dwguard-dsh-hmos/harmonyProject
 */
/** One parsed module of a HarmonyOS project. */
export interface ProjectModuleInfo {
    readonly name: string;
    readonly type: string;
    readonly srcPath: string;
    readonly deviceTypes: readonly string[];
    readonly abilities: readonly string[];
    readonly permissions: readonly string[];
    readonly pages: readonly string[];
}
/** SDK version declarations found in `build-profile.json5`. */
export interface ProjectApiVersions {
    readonly compileSdkVersion?: string;
    readonly compatibleSdkVersion?: string;
    readonly targetSdkVersion?: string;
    readonly runtimeOS?: string;
}
/** A build artifact found on disk. */
export interface ProjectArtifact {
    /** Workspace-relative POSIX path. */
    readonly path: string;
    readonly bytes: number;
}
/** Read-only summary of one HarmonyOS project. */
export interface ProjectInfo {
    readonly root: string;
    readonly bundleName?: string;
    readonly versionName?: string;
    readonly versionCode?: string;
    readonly vendor?: string;
    readonly appLabel?: string;
    readonly products: readonly string[];
    readonly buildModes: readonly string[];
    readonly signingConfigs: readonly string[];
    readonly apiVersions: ProjectApiVersions;
    readonly modules: readonly ProjectModuleInfo[];
    readonly dependencies: readonly string[];
    readonly artifacts: readonly ProjectArtifact[];
}
/**
 * Strip JSON5 comments and trailing commas, leaving a JSON.parse-compatible
 * string. String literals (including escaped quotes) are preserved verbatim.
 */
export declare function stripJson5(text: string): string;
/** Parse a JSON5-ish object file; `null` when missing or unparseable. */
export declare function readJson5Object(file: string): Record<string, unknown> | null;
/**
 * Find the project root: `start` itself, or its single child directory that
 * carries `build-profile.json5` (e.g. a workspace containing one app folder).
 */
export declare function findProjectRoot(start: string): string | null;
/** Read the project summary under `root`. */
export declare function readProjectInfo(root: string): ProjectInfo;
/** Resolve `dir` under `workspace` and reject escapes. */
export declare function resolveInside(workspace: string, dir: string): string | null;
