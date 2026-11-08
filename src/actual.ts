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

import type { ActualAggregation, ActualInput, MeasurementActual } from './model.js';
import { ACTUAL_AGGREGATIONS } from './model.js';

export interface ParsedActual {
  /** Human-readable display value, kept in reports. */
  readonly actual?: string;
  /** Structured measurement, when supplied. */
  readonly measurement?: MeasurementActual;
}

/** Build a display string from a structured measurement. */
export function formatMeasurement(measurement: MeasurementActual): string {
  const value =
    measurement.samples !== undefined && measurement.samples.length > 0
      ? String(reduceSamples(measurement))
      : typeof measurement.value === 'number'
        ? String(measurement.value)
        : measurement.value;
  return measurement.unit === undefined ? value : `${value}${measurement.unit}`;
}

/** The scalar value after the declared aggregation. */
export function measurementValue(measurement: MeasurementActual): string | number {
  if (measurement.samples !== undefined && measurement.samples.length > 0) return reduceSamples(measurement);
  return measurement.value;
}

/** Reduce samples by max / p95 / mean; p95 uses nearest-rank. */
function reduceSamples(measurement: MeasurementActual): number {
  const samples = measurement.samples ?? [];
  if (samples.length === 0) {
    return typeof measurement.value === 'number' ? measurement.value : Number.NaN;
  }
  const aggregation = measurement.aggregation;
  if (aggregation === undefined) throw new Error('samples 需要 aggregation: max / p95 / mean');
  if (aggregation === 'max') return Math.max(...samples);
  if (aggregation === 'mean') return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(sorted.length * 0.95));
  return sorted[rank - 1] ?? sorted[sorted.length - 1] ?? Number.NaN;
}

/**
 * Normalize the `actual` argument from an audit check.
 * @throws when the object is malformed.
 */
export function parseActualInput(value: unknown): ParsedActual {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length === 0 ? {} : { actual: text };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('actual 必须是字符串或结构化测量对象');
  }
  const record = value as Record<string, unknown>;
  const rawValue = record['value'];
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
    throw new Error('actual.value 必须是字符串或数字');
  }
  const unit = record['unit'];
  if (unit !== undefined && (typeof unit !== 'string' || unit.trim().length === 0)) {
    throw new Error('actual.unit 必须是非空字符串');
  }
  const observationRef = record['observationRef'];
  if (observationRef !== undefined && (typeof observationRef !== 'string' || observationRef.trim().length === 0)) {
    throw new Error('actual.observationRef 必须是非空字符串');
  }
  const samplesRaw = record['samples'];
  let samples: number[] | undefined;
  if (samplesRaw !== undefined) {
    if (!Array.isArray(samplesRaw) || samplesRaw.length === 0) throw new Error('actual.samples 必须是非空数字数组');
    samples = samplesRaw.map((sample) => {
      if (typeof sample !== 'number' || !Number.isFinite(sample)) throw new Error('actual.samples 只能包含有限数字');
      return sample;
    });
  }
  const aggregationRaw = record['aggregation'];
  if (
    aggregationRaw !== undefined &&
    (typeof aggregationRaw !== 'string' || !(ACTUAL_AGGREGATIONS as readonly string[]).includes(aggregationRaw))
  ) {
    throw new Error(`actual.aggregation 必须是 ${ACTUAL_AGGREGATIONS.join(' / ')}`);
  }
  if (samples !== undefined && aggregationRaw === undefined) {
    throw new Error('actual.samples 需要 aggregation（max / p95 / mean）');
  }
  const measurement: MeasurementActual = {
    value: rawValue,
    ...(unit === undefined ? {} : { unit: unit.trim() }),
    ...(samples === undefined ? {} : { samples }),
    ...(aggregationRaw === undefined ? {} : { aggregation: aggregationRaw as ActualAggregation }),
    ...(observationRef === undefined ? {} : { observationRef: observationRef.trim() })
  };
  return { actual: formatMeasurement(measurement), measurement };
}

export type { ActualInput };
