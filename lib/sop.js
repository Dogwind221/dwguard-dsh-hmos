/**
 * Bundled engineering knowledge + SOP library (0.8.0).
 *
 * The data lives next to `lib/` in the package (`knowledge/*.json`); it is
 * read-only and searched deterministically. The tool layer only formats it.
 *
 * @module dwguard-dsh-hmos/sop
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let cached;
function readJson(relative) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    return JSON.parse(readFileSync(file, 'utf8'));
}
/** Load the bundled library once. */
export function loadKnowledgeLibrary() {
    if (cached !== undefined)
        return cached;
    const engineering = readJson('../knowledge/engineering.json');
    const sops = readJson('../knowledge/sops.json');
    cached = { entries: engineering.entries, sops: sops.sops };
    return cached;
}
function tokens(value) {
    return value
        .toLowerCase()
        .split(/[\s，。；、,.;:!?()[\]{}]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
function score(fields, query) {
    if (query.length === 0)
        return 1;
    const haystack = fields.join(' ').toLowerCase();
    let hits = 0;
    for (const token of query) {
        if (token.length === 0)
            continue;
        if (haystack.includes(token))
            hits += 1;
    }
    return hits;
}
/** Search SOPs by free text and/or phase. */
export function searchSops(query, phase, limit = 5) {
    const { sops } = loadKnowledgeLibrary();
    const words = tokens(query);
    return sops
        .filter((sop) => phase === undefined || sop.phase.toLowerCase() === phase.toLowerCase())
        .map((sop) => ({ sop, score: score([sop.id, sop.title, sop.purpose, ...sop.steps, ...sop.gate], words) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.sop.id.localeCompare(right.sop.id))
        .slice(0, Math.max(1, Math.min(20, limit)))
        .map((item) => item.sop);
}
/** Look up one SOP by id. */
export function getSop(id) {
    return loadKnowledgeLibrary().sops.find((sop) => sop.id.toLowerCase() === id.toLowerCase());
}
/** Search engineer facts. */
export function searchEngineering(query, limit = 8) {
    const { entries } = loadKnowledgeLibrary();
    const words = tokens(query);
    return entries
        .map((entry) => ({
        entry,
        score: score([entry.id, entry.topic, entry.title, entry.statement, entry.why, entry.check, ...entry.rules], words)
    }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
        .slice(0, Math.max(1, Math.min(32, limit)))
        .map((item) => item.entry);
}
/** Counts for `stats`/doctor output. */
export function knowledgeCounts() {
    const library = loadKnowledgeLibrary();
    return { entries: library.entries.length, sops: library.sops.length };
}
