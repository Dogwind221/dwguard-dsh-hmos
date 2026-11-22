/**
 * Scenario step schema + validation for the `scenario` action.
 *
 * A scenario is an ordered list of UI steps (tap/input/swipe/wait/assert/capture)
 * that the tool executes sequentially and records as per-step evidence. The
 * parser is pure: no I/O, so a malformed scenario fails before touching a device.
 *
 * @module dwguard-dsh-hmos/scenario
 */
const MAX_STEPS = 40;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function numberField(record, key, label, min, max) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${label}.${key} 必须是 ${min}–${max} 的数字`);
    }
    return value;
}
function optionalString(record, key, label, max) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
        throw new Error(`${label}.${key} 必须是非空字符串（≤${max} 字符）`);
    }
    return value.trim();
}
/** Parse a JSON scenario (`[...]` or `{ "steps": [...] }`) into validated steps. */
export function parseScenario(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        throw new Error('scenario 是空的');
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        throw new Error('scenario 必须是合法 JSON（步骤数组或 { "steps": [...] }）');
    }
    const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['steps']) ? parsed['steps'] : null;
    if (rows === null)
        throw new Error('scenario 必须是步骤数组或 { "steps": [...] }');
    if (rows.length === 0 || rows.length > MAX_STEPS)
        throw new Error(`scenario 步骤数必须在 1–${MAX_STEPS} 之间`);
    return rows.map((row, index) => {
        const label = `scenario.steps[${index}]`;
        if (!isRecord(row))
            throw new Error(`${label} 必须是对象`);
        const op = row['op'];
        switch (op) {
            case 'click': {
                const id = optionalString(row, 'id', label, 200);
                const window = optionalString(row, 'window', label, 60);
                if (id !== undefined)
                    return { op: 'click', id, ...(window === undefined ? {} : { window }) };
                const x = numberField(row, 'x', label, -100000, 100000);
                const y = numberField(row, 'y', label, -100000, 100000);
                return { op: 'click', x, y, ...(window === undefined ? {} : { window }) };
            }
            case 'text': {
                const text = optionalString(row, 'text', label, 1000);
                if (text === undefined)
                    throw new Error(`${label}.text 不能为空`);
                const id = optionalString(row, 'id', label, 200);
                const x = row['x'] === undefined ? undefined : numberField(row, 'x', label, -100000, 100000);
                const y = row['y'] === undefined ? undefined : numberField(row, 'y', label, -100000, 100000);
                if ((x === undefined) !== (y === undefined))
                    throw new Error(`${label} 的 x/y 必须同时给出`);
                return { op: 'text', text, ...(id === undefined ? {} : { id }), ...(x === undefined || y === undefined ? {} : { x, y }) };
            }
            case 'swipe': {
                const x1 = numberField(row, 'x1', label, -100000, 100000);
                const y1 = numberField(row, 'y1', label, -100000, 100000);
                const x2 = numberField(row, 'x2', label, -100000, 100000);
                const y2 = numberField(row, 'y2', label, -100000, 100000);
                const speed = row['speed'] === undefined ? undefined : numberField(row, 'speed', label, 1, 100000);
                return { op: 'swipe', x1, y1, x2, y2, ...(speed === undefined ? {} : { speed }) };
            }
            case 'sleep': {
                return { op: 'sleep', ms: numberField(row, 'ms', label, 1, 60000) };
            }
            case 'screenshot': {
                const name = optionalString(row, 'name', label, 80);
                return { op: 'screenshot', ...(name === undefined ? {} : { name }) };
            }
            case 'assert': {
                const selector = optionalString(row, 'selector', label, 400);
                if (selector === undefined)
                    throw new Error(`${label}.selector 不能为空`);
                const expect = row['expect'];
                if (expect !== undefined && expect !== 'present' && expect !== 'absent' && expect !== 'count') {
                    throw new Error(`${label}.expect 只能是 present / absent / count`);
                }
                const count = row['count'] === undefined ? undefined : numberField(row, 'count', label, 0, 100000);
                if (expect === 'count' && count === undefined)
                    throw new Error(`${label} expect=count 需要 count`);
                if (expect === 'count')
                    return { op: 'assert', selector, expect: 'count', count };
                const timeoutMs = row['timeoutMs'] === undefined ? undefined : numberField(row, 'timeoutMs', label, 100, 120000);
                return { op: 'assert', selector, ...(expect === undefined ? {} : { expect }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
            }
            default:
                throw new Error(`${label}.op 不支持：${String(op)}（只支持 click/text/swipe/sleep/screenshot/assert）`);
        }
    });
}
