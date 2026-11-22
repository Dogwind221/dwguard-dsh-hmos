/**
 * Performance sampling helpers: percentile/aggregation, hidumper memory parsing
 * and RenderService fps parsing. Parsing is best-effort and every failure keeps
 * the raw text (the tool never invents a number).
 *
 * @module dwguard-dsh-hmos/perf
 */
/** Nearest-rank percentile (p in 0–100). */
export function percentile(samples, p) {
    if (samples.length === 0)
        return 0;
    const sorted = [...samples].sort((left, right) => left - right);
    const rank = Math.ceil((Math.max(0, Math.min(p, 100)) / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(rank, sorted.length - 1))] ?? 0;
}
/** Aggregate numeric samples with min/max/mean/p95. */
export function summarizeSamples(samples, unit) {
    const values = samples.filter((value) => Number.isFinite(value));
    const count = values.length;
    const sum = values.reduce((total, value) => total + value, 0);
    return {
        samples: values,
        count,
        min: count === 0 ? 0 : Math.min(...values),
        max: count === 0 ? 0 : Math.max(...values),
        mean: count === 0 ? 0 : Math.round((sum / count) * 100) / 100,
        p95: percentile(values, 95),
        unit
    };
}
/** Parse `hidumper --mem <pid>` output into PSS candidates. */
export function parseHidumperMem(text) {
    const lines = text.split('\n');
    let pssKb;
    let rssKb;
    // Targeted `hidumper --mem <pid>` ends with `Total   486032 ...` (Pss column first).
    const total = /^\s*Total\s+(\d+)/m.exec(text);
    if (total?.[1] !== undefined)
        pssKb = Number(total[1]);
    for (const line of lines) {
        const pss = /(?:Total\s+)?Pss[^\d]*(\d+)\s*kB/i.exec(line) ?? /(\d+)\s*kB\s*:\s*Pss/i.exec(line);
        if (pss !== null && pss[1] !== undefined) {
            const value = Number(pss[1]);
            if (Number.isFinite(value))
                pssKb = Math.max(pssKb ?? 0, value);
        }
        const rss = /(?:Total\s+)?Rss[^\d]*(\d+)\s*kB/i.exec(line);
        if (rss !== null && rss[1] !== undefined) {
            const value = Number(rss[1]);
            if (Number.isFinite(value))
                rssKb = Math.max(rssKb ?? 0, value);
        }
    }
    return {
        ...(pssKb === undefined ? {} : { pssKb }),
        ...(rssKb === undefined ? {} : { rssKb }),
        lines: lines.filter((line) => line.trim().length > 0).length
    };
}
/** Parse RenderService fps / refresh-rate output. */
export function parseFpsOutput(text) {
    const fps = /(?:fps|frameRate)[^\d-]*([\d.]+)/i.exec(text);
    const jank = /jank[^\d-]*(\d+)/i.exec(text);
    const refresh = /Refresh\s*Rate\s*:\s*(\d+)/i.exec(text);
    const count = /Count\s*:\s*(\d+)/i.exec(text);
    const fpsValue = fps?.[1] === undefined ? undefined : Number(fps[1]);
    const jankValue = jank?.[1] === undefined ? undefined : Number(jank[1]);
    const refreshValue = refresh?.[1] === undefined ? undefined : Number(refresh[1]);
    const countValue = count?.[1] === undefined ? undefined : Number(count[1]);
    return {
        ...(fpsValue === undefined || !Number.isFinite(fpsValue) ? {} : { fps: fpsValue }),
        ...(jankValue === undefined || !Number.isFinite(jankValue) ? {} : { jank: jankValue }),
        ...(refreshValue === undefined || !Number.isFinite(refreshValue) ? {} : { refreshRate: refreshValue }),
        ...(countValue === undefined || !Number.isFinite(countValue) ? {} : { count: countValue })
    };
}
