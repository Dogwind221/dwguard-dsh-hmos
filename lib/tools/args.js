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
export class ArgError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ArgError';
    }
}
/** Require the argument root to be an object. */
export function asRecord(value, tool) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ArgError(`${tool}: 参数必须是对象。`);
    }
    return value;
}
/** Read a non-empty string, optionally required. */
export function optionalString(record, key, tool, maxLength = 20000) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new ArgError(`${tool}: 参数 \`${key}\` 必须是字符串。`);
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return undefined;
    if (trimmed.length > maxLength)
        throw new ArgError(`${tool}: 参数 \`${key}\` 超过 ${maxLength} 字符。`);
    return trimmed;
}
/** Read a required non-empty string. */
export function requiredString(record, key, tool, maxLength = 20000) {
    const value = optionalString(record, key, tool, maxLength);
    if (value === undefined)
        throw new ArgError(`${tool}: 缺少必填参数 \`${key}\`。`);
    return value;
}
/** Read a boolean with a default. */
export function optionalBoolean(record, key, fallback) {
    const value = record[key];
    return typeof value === 'boolean' ? value : fallback;
}
/** Read an array of strings, dropping blanks. */
export function optionalStringArray(record, key, tool, maxItems = 64) {
    const value = record[key];
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        throw new ArgError(`${tool}: 参数 \`${key}\` 必须是字符串数组。`);
    if (value.length > maxItems)
        throw new ArgError(`${tool}: 参数 \`${key}\` 最多 ${maxItems} 项。`);
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string')
            throw new ArgError(`${tool}: 参数 \`${key}\` 的每一项都必须是字符串。`);
        const trimmed = item.trim();
        if (trimmed.length > 0)
            result.push(trimmed);
    }
    return result;
}
/** Read a required non-negative integer with an upper bound. */
export function requiredInt(record, key, tool, max = 10_000) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new ArgError(`${tool}: 参数 \`${key}\` 必须是非负整数。`);
    }
    if (value > max)
        throw new ArgError(`${tool}: 参数 \`${key}\` 不能大于 ${max}。`);
    return value;
}
/** Read an optional integer with bounds. */
export function optionalInt(record, key, fallback, tool, min = 1, max = 10_000) {
    const value = record[key];
    if (value === undefined || value === null)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw new ArgError(`${tool}: 参数 \`${key}\` 必须是整数。`);
    }
    if (value < min || value > max)
        throw new ArgError(`${tool}: 参数 \`${key}\` 必须在 ${min}–${max} 之间。`);
    return value;
}
/** Read an array of objects (each still needs its own field checks). */
export function arrayOfRecords(record, key, tool, maxItems = 128) {
    const value = record[key];
    if (!Array.isArray(value))
        throw new ArgError(`${tool}: 参数 \`${key}\` 必须是数组。`);
    if (value.length > maxItems)
        throw new ArgError(`${tool}: 参数 \`${key}\` 最多 ${maxItems} 项。`);
    return value.map((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new ArgError(`${tool}: 参数 \`${key}[${index}]\` 必须是对象。`);
        }
        return item;
    });
}
/** Read a string constrained to an allowed set. */
export function optionalEnum(record, key, allowed, tool) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new ArgError(`${tool}: 参数 \`${key}\` 只能是 ${allowed.map((item) => `\`${item}\``).join(' / ')}。`);
    }
    return value;
}
/** Read a string constrained to an allowed set, required. */
export function requiredEnum(record, key, allowed, tool) {
    const value = optionalEnum(record, key, allowed, tool);
    if (value === undefined)
        throw new ArgError(`${tool}: 缺少必填参数 \`${key}\`。`);
    return value;
}
