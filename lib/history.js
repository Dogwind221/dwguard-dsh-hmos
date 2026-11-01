/**
 * Round history for the board: what happened, in order.
 *
 * Reads the artifact filenames + their small JSON payloads (audit, prereview,
 * confirmation, shadow) and the dispatch/rework records in `outbox-dsh.md`.
 *
 * @module dwguard-dsh-hmos/history
 */
import { parseOutbox } from './dispatch.js';
import { listDir, readTextOrNull } from './util/fs.js';
function numbered(files, prefix, extension = 'json') {
    const pattern = new RegExp(`^${prefix}-(\\d+)\\.${extension}$`);
    const found = [];
    for (const file of files) {
        const match = pattern.exec(file);
        if (match?.[1] === undefined)
            continue;
        found.push({ index: Number.parseInt(match[1], 10), file });
    }
    return found.sort((left, right) => right.index - left.index);
}
function iso(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}
/**
 * Recent events, newest first.
 * @param paths - resolved protocol layout.
 * @param limit - max events returned.
 */
export async function readHistory(paths, limit = 12) {
    const events = [];
    const artifacts = await listDir(paths.artifactsDir);
    for (const entry of numbered(artifacts, 'audit').slice(0, 8)) {
        const raw = await readTextOrNull(`${paths.artifactsDir}/${entry.file}`);
        if (raw === null)
            continue;
        try {
            const parsed = JSON.parse(raw);
            const at = iso(parsed.createdAt);
            if (at === null)
                continue;
            events.push({
                at,
                kind: 'audit',
                label: `审计 #${entry.index} ${parsed.gate?.pass === true ? '通过' : '未通过'}`,
                labelEn: `Audit #${entry.index} ${parsed.gate?.pass === true ? 'passed' : 'failed'}`,
                ok: parsed.gate?.pass === true
            });
        }
        catch {
            /* skip corrupt file */
        }
    }
    for (const entry of numbered(artifacts, 'prereview').slice(0, 4)) {
        const raw = await readTextOrNull(`${paths.artifactsDir}/${entry.file}`);
        if (raw === null)
            continue;
        try {
            const parsed = JSON.parse(raw);
            const at = iso(parsed.createdAt);
            if (at === null)
                continue;
            events.push({
                at,
                kind: 'prereview',
                label: `预审 #${entry.index} ${parsed.gate?.pass === true ? '通过' : '未通过'}`,
                labelEn: `Pre-review #${entry.index} ${parsed.gate?.pass === true ? 'passed' : 'failed'}`,
                ok: parsed.gate?.pass === true
            });
        }
        catch {
            /* skip corrupt file */
        }
    }
    for (const entry of numbered(artifacts, 'confirmation').slice(0, 4)) {
        const raw = await readTextOrNull(`${paths.artifactsDir}/${entry.file}`);
        if (raw === null)
            continue;
        try {
            const parsed = JSON.parse(raw);
            const at = iso(parsed.createdAt);
            if (at === null)
                continue;
            events.push({
                at,
                kind: 'confirm',
                label: parsed.decision === 'new_round' ? '用户确认 · 开下一轮' : '用户确认完成',
                labelEn: parsed.decision === 'new_round' ? 'User confirmed · next round' : 'User confirmed',
                ok: true
            });
        }
        catch {
            /* skip corrupt file */
        }
    }
    const shadows = numbered(artifacts, 'shadow');
    const newestShadow = shadows[0];
    if (newestShadow !== undefined) {
        const raw = await readTextOrNull(`${paths.artifactsDir}/${newestShadow.file}`);
        if (raw !== null) {
            try {
                const parsed = JSON.parse(raw);
                const at = iso(parsed.scannedAt);
                if (at !== null) {
                    const newRisks = Array.isArray(parsed.newRisks) ? parsed.newRisks.length : 0;
                    events.push({
                        at,
                        kind: 'shadow',
                        label: `影子审查 #${newestShadow.index} · must ${parsed.must ?? 0}（新增 ${newRisks}）`,
                        labelEn: `Shadow #${newestShadow.index} · must ${parsed.must ?? 0} (new ${newRisks})`,
                        ok: newRisks === 0
                    });
                }
            }
            catch {
                /* skip corrupt file */
            }
        }
    }
    const sent = parseOutbox(await readTextOrNull(paths.outboxDsh));
    for (const entry of sent) {
        if (entry.kind !== 'dispatch' && entry.kind !== 'rework')
            continue;
        const match = /^\[([^\]]+)\]/.exec(entry.header);
        const at = match?.[1] === undefined ? null : iso(match[1]);
        if (at === null)
            continue;
        events.push({
            at,
            kind: entry.kind,
            label: entry.kind === 'dispatch' ? `派发 #${entry.id ?? '?'}` : `返工 #${entry.id ?? '?'}`,
            labelEn: entry.kind === 'dispatch' ? `Dispatch #${entry.id ?? '?'}` : `Rework #${entry.id ?? '?'}`,
            ok: entry.kind === 'dispatch'
        });
    }
    return events
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
        .slice(0, limit);
}
