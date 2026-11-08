/**
 * Collector observations (0.8.5).
 *
 * A device collector writes one observation file per evidence capture. An audit
 * can reference it via `actual.observationRef`; the gate then checks that the
 * observation exists, belongs to the declared device, and (when present) was
 * captured for the current spec version.
 *
 * @module dwguard-dsh-hmos/observation
 */
import type { SharedPaths } from './paths.js';
export interface ObservationFile {
    readonly path: string;
    readonly sha256: string;
}
export interface Observation {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly at: string;
    readonly device?: string;
    readonly action: string;
    readonly specVersion?: number;
    readonly files: readonly ObservationFile[];
}
/** Directory for collector observations. */
export declare function observationDir(paths: SharedPaths): string;
/** One observation file; ids are validated as safe filenames. */
export declare function observationFile(paths: SharedPaths, id: string): string;
/** Record a collector observation; returns its id. */
export declare function recordObservation(paths: SharedPaths, input: {
    readonly action: string;
    readonly device?: string;
    readonly specVersion?: number;
    readonly files: readonly string[];
}, now: string): Promise<string>;
/** Read an observation; null when missing/corrupt. */
export declare function readObservation(paths: SharedPaths, id: string): Promise<Observation | null>;
