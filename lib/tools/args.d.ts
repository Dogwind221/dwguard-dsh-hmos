/**
 * Tiny argument validators.
 *
 * The registry accepts the declared parameter JSON Schema; these helpers give
 * the failure a Chinese message the model can act on, and they narrow `unknown`
 * so the rest of each tool body is typed.
 *
 * @module dwguard-dsh-hmos/tools/args
 */
/** A rejected argument list (surfaces as a tool error). */
export declare class ArgError extends Error {
    constructor(message: string);
}
/** Require the argument root to be an object. */
export declare function asRecord(value: unknown, tool: string): Record<string, unknown>;
/** Read a non-empty string, optionally required. */
export declare function optionalString(record: Record<string, unknown>, key: string, tool: string, maxLength?: number): string | undefined;
/** Read a required non-empty string. */
export declare function requiredString(record: Record<string, unknown>, key: string, tool: string, maxLength?: number): string;
/** Read a boolean with a default. */
export declare function optionalBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean;
/** Read an array of strings, dropping blanks. */
export declare function optionalStringArray(record: Record<string, unknown>, key: string, tool: string, maxItems?: number): string[];
/** Read a required non-negative integer with an upper bound. */
export declare function requiredInt(record: Record<string, unknown>, key: string, tool: string, max?: number): number;
/** Read an optional integer with bounds. */
export declare function optionalInt(record: Record<string, unknown>, key: string, fallback: number, tool: string, min?: number, max?: number): number;
/** Read an array of objects (each still needs its own field checks). */
export declare function arrayOfRecords(record: Record<string, unknown>, key: string, tool: string, maxItems?: number): Array<Record<string, unknown>>;
/** Read a string constrained to an allowed set. */
export declare function optionalEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[], tool: string): T | undefined;
/** Read a string constrained to an allowed set, required. */
export declare function requiredEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[], tool: string): T;
