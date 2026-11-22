/**
 * Summarize a raw `hitrace` capture (ftrace text) into deterministic slice
 * statistics: event counts, function/path hotspots, paired slice durations and
 * process distribution. This is evidence, not a verdict: it does not compute
 * fps/jank, and it never turns a trace into a pass/fail.
 *
 * @module dwguard-dsh-hmos/traceSummary
 */
const TRACE_LINE = /^\s*\S+-(\d+)\s+\(-+\)\s+\[\d+\]\s+\S+\s+([\d.]+):\s+(\w+):\s*(.*)$/;
function normalizeName(name) {
    const stripped = name.replace(/^H:/, '').trim();
    return stripped.length === 0 ? '(unnamed)' : stripped;
}
function groupKey(name) {
    return name
        .replace(/0x[0-9a-f]+/gi, '<hex>')
        .replace(/\d+/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}
/** Parse one hitrace text capture into summary statistics. */
export function summarizeTrace(raw) {
    const normalized = raw.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const stats = new Map();
    const pids = new Map();
    const stacks = new Map();
    const slowest = [];
    let events = 0;
    let beginEvents = 0;
    let endEvents = 0;
    let firstTimestamp;
    let lastTimestamp;
    let entries = 0;
    let written = 0;
    const headerEntries = /entries-in-buffer\/entries-written:\s*(\d+)\/(\d+)/.exec(normalized);
    if (headerEntries !== null) {
        entries = Number(headerEntries[1]);
        written = Number(headerEntries[2]);
    }
    for (const line of lines) {
        if (line.trim().length === 0)
            continue;
        const match = TRACE_LINE.exec(line);
        if (match === null)
            continue;
        const pid = Number(match[1]);
        const timestamp = Number(match[2]);
        const eventName = match[3] ?? '';
        const payload = (match[4] ?? '').trim();
        if (!Number.isFinite(timestamp))
            continue;
        if (firstTimestamp === undefined)
            firstTimestamp = timestamp;
        lastTimestamp = timestamp;
        if (eventName !== 'tracing_mark_write')
            continue;
        const parts = payload.split('|');
        const kind = parts[0] ?? '';
        if (parts.length < 2)
            continue;
        if (kind !== 'B' && kind !== 'E')
            continue;
        events += 1;
        if (kind === 'B') {
            beginEvents += 1;
            const name = normalizeName(parts[2] ?? '');
            const key = groupKey(name);
            const current = stats.get(key);
            if (current === undefined) {
                stats.set(key, { sample: name, count: 1, totalMs: 0, maxMs: 0, minMs: Number.POSITIVE_INFINITY });
            }
            else {
                current.count += 1;
            }
            const stack = stacks.get(pid) ?? [];
            stack.push({ name, start: timestamp });
            stacks.set(pid, stack);
            pids.set(pid, (pids.get(pid) ?? 0) + 1);
        }
        else {
            endEvents += 1;
            const stack = stacks.get(pid) ?? [];
            const open = stack.pop();
            if (open !== undefined) {
                const durationMs = Math.max(0, (timestamp - open.start) * 1000);
                const key = groupKey(open.name);
                const current = stats.get(key);
                if (current !== undefined) {
                    current.totalMs += durationMs;
                    current.maxMs = Math.max(current.maxMs, durationMs);
                    current.minMs = Math.min(current.minMs, durationMs);
                }
                slowest.push({ name: open.name, pid, ms: Math.round(durationMs * 100) / 100 });
            }
        }
    }
    const functions = [...stats.entries()]
        .map(([key, value]) => ({
        name: value.sample,
        key,
        count: value.count,
        totalMs: Math.round(value.totalMs * 100) / 100,
        maxMs: Math.round(value.maxMs * 100) / 100,
        avgMs: value.count === 0 ? 0 : Math.round((value.totalMs / value.count) * 100) / 100
    }))
        .sort((left, right) => right.totalMs - left.totalMs || right.count - left.count || left.key.localeCompare(right.key));
    const topFunctions = functions.slice(0, 15).map((entry) => ({
        name: entry.key,
        count: entry.count,
        totalMs: entry.totalMs,
        maxMs: entry.maxMs,
        avgMs: entry.avgMs
    }));
    const slowestSlices = slowest
        .sort((left, right) => right.ms - left.ms)
        .slice(0, 10);
    return {
        lines: lines.filter((line) => line.trim().length > 0).length,
        bytes: Buffer.byteLength(raw, 'utf8'),
        entries,
        written,
        events,
        beginEvents,
        endEvents,
        functions: functions.length,
        ...(firstTimestamp === undefined || lastTimestamp === undefined
            ? {}
            : {
                spanMs: Math.round((lastTimestamp - firstTimestamp) * 1000),
                firstTimestamp: firstTimestamp.toFixed(6),
                lastTimestamp: lastTimestamp.toFixed(6)
            }),
        topFunctions,
        slowest: slowestSlices,
        topPids: [...pids.entries()]
            .map(([pid, count]) => ({ pid, count }))
            .sort((left, right) => right.count - left.count || left.pid - right.pid)
            .slice(0, 10),
        notes: [
            '统计只描述本次 trace 的切片分布，不做 fps/jank 判定；性能判据仍需独立测量值。',
            '同名函数按数字归一化后聚合，slowest 是配对到的最长单次切片。'
        ]
    };
}
