/**
 * Plugin configuration and its defensive normalization.
 *
 * The loader validates this schema before `apply` runs, but `apply` also
 * accepts an empty object (a row with no `config:`), so every field is
 * re-defaulted here instead of trusting the argument.
 *
 * @module dwguard-dsh-hmos/config
 */

import z from '@deepseek-ai/schemastery';

import type { DeviceConfig } from './device.js';
import { resolveDevicePolicy } from './device.js';
import { SCREEN_FAMILIES } from './model.js';

/** Loader-facing schema of the `dsh` row's `config` block. */
export const Config = z.object({
  /** Directory (relative to the workspace, or absolute) holding the shared protocol. */
  sharedDir: z.string().default('.shared'),
  /** Register the DwGuard team-policy system-prompt section. */
  promptSection: z.boolean().default(true),
  /** Register the three DwGuard skills. */
  installSkills: z.boolean().default(true),
  /** Minimum acceptance criteria required per dimension when a task pack is written. */
  minCriteriaPerDimension: z.number().default(1),
  /** Refuse a pre-review blocker that carries no attempted rebuttal. */
  requireRebuttalOnBlocker: z.boolean().default(true),
  /** Refuse to dispatch a task pack that has no passing pre-review. */
  requirePrereviewBeforeDispatch: z.boolean().default(true),
  /** Entries kept per knowledge topic before the append starts warning. */
  knowledgeMaxEntriesPerTopic: z.number().default(200),
  /** Local official-docs corpus for `dwguard_rules search` (absolute, or relative to the workspace). */
  docsDir: z.string().default(''),
  /** Minutes between shadow-review nudges while DevEco is coding. */
  shadowIntervalMinutes: z.number().default(10),
  /** Minutes without a delivery before `dwguard_status` reports a stalled round. */
  stallMinutes: z.number().default(30),
  /** Executor policy: `auto` = IDE-first, CLI only where it wins. */
  executor: z.string().default('auto'),
  /** `devecocli` binary; empty means `devecocli` on PATH. */
  devecocliPath: z.string().default(''),
  /** Host memory in GB; 0 means auto-detect (`os.totalmem()`), >0 overrides (CI/containers). */
  hostMemoryGb: z.number().default(0),
  /** Device mode: `auto` (by host memory) / `single` / `matrix`. */
  deviceMode: z.string().default('auto'),
  /** Below this host-memory threshold the policy forces single-device verification. */
  matrixMinMemoryGb: z.number().default(32),
  /** Screen families the matrix covers (phone / widefold / foldable / triplefold). */
  deviceMatrix: z.array(z.string()).default([...SCREEN_FAMILIES]),
  /** Per-dimension required families; empty/invalid entries fall back to the defaults. */
  matrixScope: z.any().default({}),
  /** Downgrade missing matrix families from gate error to warning. */
  allowMissingMatrixFamilies: z.boolean().default(false),
  /** Device pool entries `{ sn, family, apiLevel?, kind? }`. */
  devicePool: z.array(z.any()).default([]),
  /** Max concurrent devices; 0 = auto from host memory. */
  maxConcurrency: z.number().default(0),
  /** A lock older than this is treated as stale and stolen. */
  deviceLockTimeoutMs: z.number().default(600000),
  /** Design RAG (0.6.2): default result count. */
  designTopK: z.number().default(5),
  /** Chunk cap before the library warns about index size. */
  designMaxChunks: z.number().default(2000),
  /** `lexical` (deterministic BM25) or `hybrid` (reserved; falls back to lexical). */
  designRanker: z.string().default('lexical'),
  /** Cards per design brief handed to DevEco (0.6.2 P1). */
  designBriefCards: z.number().default(5),
  /** Exclude cards whose license is unknown from search results. */
  designLicenseRequired: z.boolean().default(true)
});

/** Fully resolved options used by every tool. */
export interface Options {
  readonly sharedDir: string;
  readonly promptSection: boolean;
  readonly installSkills: boolean;
  readonly minCriteriaPerDimension: number;
  readonly requireRebuttalOnBlocker: boolean;
  readonly requirePrereviewBeforeDispatch: boolean;
  readonly knowledgeMaxEntriesPerTopic: number;
  /** Local official-docs corpus; empty means auto-detect. */
  readonly docsDir: string;
  /** Shadow-review nudge interval in minutes. */
  readonly shadowIntervalMinutes: number;
  /** Minutes without a delivery before the round is reported as stalled. */
  readonly stallMinutes: number;
  /** Executor policy: `auto` = IDE-first; `ide` / `cli` force one. */
  readonly executor: 'auto' | 'ide' | 'cli';
  /** `devecocli` binary; empty means resolve from PATH. */
  readonly devecocliPath: string;
  /** Effective device policy (host memory, mode, matrix scope, pool, lock timeout). */
  readonly device: DeviceConfig;
  /** Design RAG (0.6.2) settings. */
  readonly designTopK: number;
  readonly designMaxChunks: number;
  readonly designRanker: 'lexical' | 'hybrid';
  /** Cards included in `tasks/design-brief.md`. */
  readonly designBriefCards: number;
  readonly designLicenseRequired: boolean;
}

const DEFAULTS: Options = {
  sharedDir: '.shared',
  promptSection: true,
  installSkills: true,
  minCriteriaPerDimension: 1,
  requireRebuttalOnBlocker: true,
  requirePrereviewBeforeDispatch: true,
  knowledgeMaxEntriesPerTopic: 200,
  docsDir: '',
  shadowIntervalMinutes: 10,
  stallMinutes: 30,
  executor: 'auto',
  devecocliPath: '',
  device: resolveDevicePolicy({}),
  designTopK: 5,
  designMaxChunks: 2000,
  designRanker: 'lexical',
  designBriefCards: 5,
  designLicenseRequired: true
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Normalize whatever the loader passed into complete options.
 * @param raw - the row's config value (possibly `undefined`).
 * @returns options with every default applied.
 */
export function resolveOptions(raw: unknown): Options {
  const input = (raw ?? {}) as Record<string, unknown>;
  return {
    sharedDir: str(input['sharedDir'], DEFAULTS.sharedDir),
    promptSection: bool(input['promptSection'], DEFAULTS.promptSection),
    installSkills: bool(input['installSkills'], DEFAULTS.installSkills),
    minCriteriaPerDimension: positiveInt(input['minCriteriaPerDimension'], DEFAULTS.minCriteriaPerDimension, 1),
    requireRebuttalOnBlocker: bool(input['requireRebuttalOnBlocker'], DEFAULTS.requireRebuttalOnBlocker),
    requirePrereviewBeforeDispatch: bool(input['requirePrereviewBeforeDispatch'], DEFAULTS.requirePrereviewBeforeDispatch),
    knowledgeMaxEntriesPerTopic: positiveInt(input['knowledgeMaxEntriesPerTopic'], DEFAULTS.knowledgeMaxEntriesPerTopic, 1),
    docsDir: typeof input['docsDir'] === 'string' ? input['docsDir'].trim() : DEFAULTS.docsDir,
    shadowIntervalMinutes: positiveInt(input['shadowIntervalMinutes'], DEFAULTS.shadowIntervalMinutes, 1),
    stallMinutes: positiveInt(input['stallMinutes'], DEFAULTS.stallMinutes, 1),
    executor: input['executor'] === 'ide' || input['executor'] === 'cli' ? input['executor'] : 'auto',
    devecocliPath: typeof input['devecocliPath'] === 'string' ? input['devecocliPath'].trim() : DEFAULTS.devecocliPath,
    device: resolveDevicePolicy({
      hostMemoryGb: input['hostMemoryGb'],
      deviceMode: input['deviceMode'],
      matrixMinMemoryGb: input['matrixMinMemoryGb'],
      deviceMatrix: input['deviceMatrix'],
      matrixScope: input['matrixScope'],
      allowMissingMatrixFamilies: input['allowMissingMatrixFamilies'],
      devicePool: input['devicePool'],
      maxConcurrency: input['maxConcurrency'],
      deviceLockTimeoutMs: input['deviceLockTimeoutMs']
    }),
    designTopK: positiveInt(input['designTopK'], DEFAULTS.designTopK, 1),
    designMaxChunks: positiveInt(input['designMaxChunks'], DEFAULTS.designMaxChunks, 1),
    designRanker: input['designRanker'] === 'hybrid' ? 'hybrid' : 'lexical',
    designBriefCards: positiveInt(input['designBriefCards'], DEFAULTS.designBriefCards, 1),
    designLicenseRequired: bool(input['designLicenseRequired'], DEFAULTS.designLicenseRequired)
  };
}
