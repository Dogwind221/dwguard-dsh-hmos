/**
 * Aesthetic preferences: the profile, deterministic extraction, confidence and
 * conflict rules, and the learn → user choice → apply loop.
 *
 * Nothing here writes as a side effect of `learn`: proposals are computed in
 * memory and only an explicit, user-confirmed `apply` touches the profile.
 *
 * @module dwguard-dsh-hmos/aesthetic
 */
import type { SharedPaths } from './paths.js';
/** Preference areas an entry can belong to. */
export declare const AESTHETIC_AREAS: readonly ["palette", "spacing", "radius", "type", "density", "motion", "dark", "icon", "card"];
/** One preference area. */
export type AestheticArea = (typeof AESTHETIC_AREAS)[number];
/** Chinese labels used by generated documents. */
export declare const AREA_LABELS: Record<AestheticArea, string>;
/** Where a preference came from. */
export declare const AESTHETIC_SOURCE_KINDS: readonly ["confirmation", "rejection", "audit-finding", "calibration-miss", "project-resources"];
/** One evidence source kind. */
export type AestheticSourceKind = (typeof AESTHETIC_SOURCE_KINDS)[number];
/** Chinese labels for the source kinds. */
export declare const SOURCE_LABELS: Record<AestheticSourceKind, string>;
/** Starting confidence per source kind (0.6.1 plan §5 / §1). */
export declare const SOURCE_BASE_CONFIDENCE: Record<AestheticSourceKind, number>;
/** A measurable preference value: a number+unit or a colour token. */
export interface AestheticValue {
    readonly number?: number;
    readonly unit?: string;
    readonly color?: string;
}
/** One accepted preference. */
export interface AestheticEntry {
    /** Stable id (`AES-RADIUS-01`). */
    readonly id: string;
    readonly area: AestheticArea;
    /** Human-readable decision, e.g. `卡片圆角 20vp`. */
    readonly decision: string;
    readonly value: AestheticValue;
    /** Where it came from (`confirmation-3`, `learn:rejection#2`, `project-resources`). */
    readonly source: string;
    readonly evidence: readonly string[];
    /** 0–1. */
    readonly confidence: number;
    readonly status: 'active' | 'superseded';
    readonly updatedAt: string;
    /** Set on a superseded entry, pointing at the replacement. */
    readonly supersededBy?: string;
}
/** The whole profile document. */
export interface AestheticProfile {
    readonly schemaVersion: 1;
    readonly entries: readonly AestheticEntry[];
}
/** One append-only history event. */
export interface AestheticHistoryEvent {
    readonly at: string;
    readonly kind: 'proposed' | 'applied' | 'superseded' | 'conflict';
    readonly id?: string;
    readonly area?: AestheticArea;
    readonly value?: string;
    readonly sources?: readonly string[];
    readonly note?: string;
}
/** Whether a value is one of the nine preference areas. */
export declare function isAestheticArea(value: unknown): value is AestheticArea;
/** Whether a value is one of the source kinds. */
export declare function isAestheticSourceKind(value: unknown): value is AestheticSourceKind;
/** A fresh, empty profile. */
export declare function emptyProfile(): AestheticProfile;
/** Render a value as `20vp` / `#FF0000`. */
export declare function valueLabel(value: AestheticValue): string;
/** Human-readable label including the area, e.g. `圆角 20vp`. */
export declare function areaValueLabel(area: AestheticArea, value: AestheticValue): string;
/** Normalize user-supplied value fields for an area. */
export declare function normalizeValue(area: AestheticArea, raw: {
    number?: unknown;
    unit?: unknown;
    color?: unknown;
}): {
    value?: AestheticValue;
    error?: string;
};
/** Round a confidence to two decimals and clamp it into 0–1. */
export declare function clampConfidence(value: number): number;
/** Apply one evidence delta: confirm +0.1, reject −0.2, repeat +0.05. */
export declare function adjustConfidence(current: number, kind: 'confirm' | 'reject' | 'repeat'): number;
/** Detect which preference areas a sentence mentions (deterministic order). */
export declare function detectAestheticAreas(text: string): AestheticArea[];
/** One extracted preference fact. */
export interface AestheticFact {
    readonly area: AestheticArea;
    readonly value: AestheticValue;
    readonly decision: string;
}
/**
 * Extract measurable aesthetic facts from free text.
 *
 * Deterministic by design: clause split, area keywords, then numbers/colours in
 * the clause. No model call, no guessing about unstated preferences.
 */
export declare function extractAestheticFacts(text: string): AestheticFact[];
/** A model-supplied learn source. */
export interface LearnSource {
    readonly kind: AestheticSourceKind;
    readonly text: string;
    readonly evidence?: string;
}
/** One proposal produced by `learn` (never written until `apply`). */
export interface AestheticProposal {
    readonly id: string;
    readonly area: AestheticArea;
    readonly decision: string;
    readonly value: AestheticValue;
    readonly confidence: number;
    readonly reason: string;
    readonly sources: readonly string[];
    /** Existing active entry the proposal would reinforce (repeat evidence). */
    readonly mergeId?: string;
}
/** One candidate in a conflict. */
export interface AestheticConflictCandidate {
    readonly value: string;
    readonly decision: string;
    readonly sources: readonly string[];
    /** Existing entry id, absent for the newly proposed value. */
    readonly id?: string;
}
/** Two values for the same area: the user has to pick one. */
export interface AestheticConflict {
    readonly area: AestheticArea;
    readonly candidates: readonly AestheticConflictCandidate[];
    readonly question: string;
}
/** Output of `learnAesthetics` — nothing has been written. */
export interface AestheticLearnResult {
    readonly proposals: readonly AestheticProposal[];
    readonly conflicts: readonly AestheticConflict[];
}
/** Whether a string is a well-formed aesthetic id (`AES-RADIUS-01`). */
export declare function isAestheticId(value: string): boolean;
/** Next free id for an area, seeded by the highest existing suffix. */
export declare function nextAestheticId(area: AestheticArea, entries: readonly AestheticEntry[]): string;
/**
 * Compute proposals/conflicts for the current round. Pure: the profile is read,
 * never written.
 *
 * Facts are grouped per area first, so two different values proposed in the same
 * round become a conflict just like a value that contradicts the stored profile.
 */
export declare function learnAesthetics(profile: AestheticProfile, facts: readonly AestheticFact[], sourcesByKey: ReadonlyMap<string, readonly string[]>, startConfidence: ReadonlyMap<string, number>): AestheticLearnResult;
/** Build the per-fact source labels and base confidences from learn sources. */
export declare function factsFromSources(sources: readonly LearnSource[]): {
    facts: AestheticFact[];
    sourcesByKey: Map<string, string[]>;
    startConfidence: Map<string, number>;
};
/** Parse the HarmonyOS `resources/base/element/*.json` seeds. */
export interface ProjectResourceResult {
    readonly facts: AestheticFact[];
    readonly files: string[];
    /** Directories that were checked (useful when nothing was found). */
    readonly searched: string[];
}
/**
 * Cold-start seeds from the project's own resource files.
 *
 * A HarmonyOS app usually keeps them under `<module>/src/main/resources/base/element`
 * rather than `<workspace>/resources`, so several candidate roots are checked
 * and the result reports which ones were searched.
 */
export declare function readProjectAestheticFacts(workspace: string): Promise<ProjectResourceResult>;
/** Result of applying proposals to the profile. */
export interface AestheticApplyOutcome {
    readonly profile: AestheticProfile;
    readonly applied: readonly AestheticEntry[];
    readonly superseded: readonly AestheticEntry[];
    readonly events: readonly AestheticHistoryEvent[];
    readonly unresolved: readonly AestheticConflict[];
}
/**
 * Apply proposals and conflict choices to a profile in memory.
 *
 * Unresolved conflicts are returned instead of guessed: the tool refuses the
 * write and asks the user to pass `choice` (one conflict) or `choices` (one per
 * area). A single `choice` that matches more than one conflict is ambiguous and
 * leaves every matched conflict unresolved, so no preference is replaced by
 * accident.
 */
export declare function conflictsMatchingChoice(conflicts: readonly AestheticConflict[], choice: string): AestheticConflict[];
export declare function applyAestheticProposals(profile: AestheticProfile, result: AestheticLearnResult, options: {
    readonly choice?: string;
    readonly choices?: Readonly<Partial<Record<AestheticArea, string>>>;
    readonly now: string;
}): AestheticApplyOutcome;
/** Render the profile markdown (human table + machine-readable JSON line). */
export declare function renderProfileMarkdown(profile: AestheticProfile): string;
/** Whether the stored profile was readable. */
export type ProfileStatus = 'missing' | 'ok' | 'invalid';
/** Outcome of reading the profile document. */
export interface ProfileReadResult {
    readonly profile: AestheticProfile;
    readonly status: ProfileStatus;
    /** Set when status is `invalid`. */
    readonly error?: string;
}
/**
 * Read the profile with its parse state.
 *
 * A missing file is a normal empty profile; a file that exists but cannot be
 * parsed is `invalid` and every write path must refuse instead of overwriting
 * it (0.6.1 review M6). The reader understands both the current marker+line
 * format and the legacy fenced-JSON format written by early 0.6.1 builds.
 */
export declare function readProfileDocument(paths: SharedPaths): Promise<ProfileReadResult>;
/** Read the profile, tolerating a missing or corrupt document (read-only callers). */
export declare function readProfile(paths: SharedPaths): Promise<AestheticProfile>;
/** Write the profile markdown. */
export declare function writeProfile(paths: SharedPaths, profile: AestheticProfile): Promise<void>;
/** Append history events to `knowledge/aesthetic-history.jsonl`. */
export declare function appendAestheticHistory(paths: SharedPaths, events: readonly AestheticHistoryEvent[]): Promise<string | null>;
/** Find an entry by id (active or superseded). */
export declare function findProfileEntry(profile: AestheticProfile, id: string): AestheticEntry | undefined;
/** Default global directory for cross-project aesthetic templates (0.6.4). */
export declare function defaultAestheticTemplatesDir(): string;
/** One exported cross-project template. */
export interface AestheticTemplate {
    readonly schemaVersion: 1;
    readonly name: string;
    readonly createdAt: string;
    readonly entries: readonly AestheticEntry[];
}
/** One row of `template list`. */
export interface AestheticTemplateSummary {
    readonly name: string;
    readonly createdAt: string;
    readonly entries: number;
    readonly path: string;
}
/** Result of `template export`. */
export interface TemplateExportResult {
    readonly file: string;
    readonly template: AestheticTemplate;
}
/** Result of `template import`. */
export interface TemplateImportResult {
    readonly profile: AestheticProfile;
    readonly imported: readonly AestheticEntry[];
    readonly superseded: readonly string[];
    readonly skipped: readonly string[];
    readonly file: string;
}
/** Validate a template name (safe as a filename). */
export declare function isTemplateName(value: string): boolean;
/** List templates in the global directory (invalid files are skipped). */
export declare function listAestheticTemplates(dir: string): Promise<AestheticTemplateSummary[]>;
/** Export active preferences under a reusable name. */
export declare function exportAestheticTemplate(dir: string, profile: AestheticProfile, name: string, now: string): Promise<TemplateExportResult>;
/** Read a template by name (throws when missing/invalid). */
export declare function readAestheticTemplate(dir: string, name: string): Promise<AestheticTemplate | null>;
/**
 * Import a template into the local profile.
 *
 * `merge` (default): same area+value is skipped; same area with a different
 * value supersedes the local active entry; id collisions get a fresh id.
 * `replace`: the template becomes the whole profile.
 */
export declare function importAestheticTemplate(paths: SharedPaths, dir: string, profile: AestheticProfile, name: string, strategy: 'merge' | 'replace', now: string): Promise<TemplateImportResult>;
/** Active entry ids, used by the audit gate to validate `profileRef`. */
export declare function activeProfileIds(profile: AestheticProfile): Set<string>;
/** Render proposals as a markdown table. */
export declare function renderProposals(proposals: readonly AestheticProposal[]): string;
/** Render conflicts as a list of questions with candidates. */
export declare function renderConflicts(conflicts: readonly AestheticConflict[]): string;
/** Files the profile/history live in, as display paths. */
export declare function profileFiles(paths: SharedPaths): string[];
/** Normalize a source label into something short enough for a table cell. */
export declare function sourceLabel(source: string): string;
