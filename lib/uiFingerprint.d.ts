/**
 * Deterministic layout fingerprint for `uiassert expect=fingerprint`.
 *
 * The fingerprint keeps the structural identity of the UI (id / type / text /
 * accessibility id / interactive flags / child order) and drops coordinates, so
 * the same screen produces the same hash across reruns and screen sizes.
 *
 * @module dwguard-dsh-hmos/uiFingerprint
 */
export interface LayoutFingerprint {
    readonly fingerprint: string;
    readonly nodes: number;
}
/** Normalize a `ui layout --format json` tree and hash it. */
export declare function fingerprintLayout(value: unknown): LayoutFingerprint;
