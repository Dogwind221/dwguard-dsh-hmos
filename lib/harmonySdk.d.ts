/**
 * Local HarmonyOS SDK lookup: locate an installed SDK, find a module's `.d.ts`
 * declaration and read its documentation tags (`@since`, `@deprecated`,
 * `@syscap`...). Read-only: nothing is downloaded, nothing is executed.
 *
 * @module dwguard-dsh-hmos/harmonySdk
 */
/** One installed SDK that can answer API questions. */
export interface SdkLayout {
    readonly root: string;
    /** OpenHarmony `ets/api` directory (declares `@ohos.*`). */
    readonly apiDir: string;
    /** OpenHarmony `ets/kits` directory (declares `@kit.*`). */
    readonly kitsDir?: string;
    /** HMS `ets/api` directory. */
    readonly hmsApiDir?: string;
    /** HMS `ets/kits` directory (declares HMS `@kit.*`). */
    readonly hmsKitsDir?: string;
    readonly apiVersion?: string;
    readonly platformVersion?: string;
    readonly sdkVersion?: string;
}
/**
 * Candidate SDK roots: explicit config, then environment variables, then the
 * platform default install locations. Only existing directories are returned.
 */
export declare function candidateSdkRoots(configured: string): string[];
/** Find the first installed SDK that has the OpenHarmony `ets/api` tree. */
export declare function findSdkLayout(configured: string): SdkLayout | null;
/** List module names available in one SDK registry (`api` or `kits`). */
export declare function listSdkModules(layout: SdkLayout, kind: 'openharmony' | 'hms' | 'kit'): string[];
/** One documentation tag found in a declaration file. */
export interface ApiTag {
    readonly tag: string;
    readonly value: string;
    readonly line: number;
}
/** Result of one SDK API lookup. */
export interface ApiLookup {
    readonly module: string;
    readonly file: string;
    readonly kind: 'openharmony' | 'hms' | 'kit';
    readonly tags: readonly ApiTag[];
    readonly declarations: readonly string[];
}
/** Read a module's declaration file and extract tags + declaration lines. */
export declare function lookupSdkApi(layout: SdkLayout, rawModule: string, nameFilter?: string): ApiLookup | null;
