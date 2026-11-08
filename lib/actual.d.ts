/**
 * Structured measurement helpers (0.8.5).
 *
 * `actual` used to be free text; numeric assertions took the first number out of
 * it. That made units and multi-sample performance results easy to fake. This
 * module accepts either a legacy string (for display/backward compatibility) or
 * a structured measurement, and reduces samples with an explicit aggregation.
 *
 * @module dwguard-dsh-hmos/actual
 */
import type { ActualInput, MeasurementActual } from './model.js';
export interface ParsedActual {
    /** Human-readable display value, kept in reports. */
    readonly actual?: string;
    /** Structured measurement, when supplied. */
    readonly measurement?: MeasurementActual;
}
/** Build a display string from a structured measurement. */
export declare function formatMeasurement(measurement: MeasurementActual): string;
/** The scalar value after the declared aggregation. */
export declare function measurementValue(measurement: MeasurementActual): string | number;
/**
 * Normalize the `actual` argument from an audit check.
 * @throws when the object is malformed.
 */
export declare function parseActualInput(value: unknown): ParsedActual;
export type { ActualInput };
