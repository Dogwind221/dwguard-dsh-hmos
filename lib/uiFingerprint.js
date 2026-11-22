/**
 * Deterministic layout fingerprint for `uiassert expect=fingerprint`.
 *
 * The fingerprint keeps the structural identity of the UI (id / type / text /
 * accessibility id / interactive flags / child order) and drops coordinates, so
 * the same screen produces the same hash across reruns and screen sizes.
 *
 * @module dwguard-dsh-hmos/uiFingerprint
 */
import { createHash } from 'node:crypto';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const KEPT_KEYS = [
    'id',
    'type',
    'text',
    'accessibilityId',
    'accessibilityText',
    'clickable',
    'enabled',
    'checked',
    'selected',
    'focusable',
    'scrollable'
];
function normalizeNode(node, counter) {
    if (!isRecord(node))
        return null;
    const entry = {};
    for (const key of KEPT_KEYS) {
        if (node[key] !== undefined && node[key] !== null)
            entry[key] = node[key];
    }
    const attributes = node['attributes'];
    if (isRecord(attributes)) {
        for (const key of KEPT_KEYS) {
            if (entry[key] === undefined && attributes[key] !== undefined && attributes[key] !== null) {
                entry[key] = attributes[key];
            }
        }
    }
    counter.count += 1;
    const children = Array.isArray(node['children']) ? node['children'] : [];
    entry['children'] = children
        .map((child) => normalizeNode(child, counter))
        .filter((child) => child !== null);
    return entry;
}
/** Normalize a `ui layout --format json` tree and hash it. */
export function fingerprintLayout(value) {
    const counter = { count: 0 };
    const normalized = Array.isArray(value)
        ? value.map((item) => normalizeNode(item, counter)).filter((item) => item !== null)
        : normalizeNode(value, counter);
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
    return { fingerprint: `fp-${hash}`, nodes: counter.count };
}
