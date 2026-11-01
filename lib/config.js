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
    /** Who implements the task pack: the IDE agent (`ide`) or a CLI agent (`cli`). */
    executor: z.string().default('ide'),
    /** `devecocli` binary; empty means `devecocli` on PATH. */
    devecocliPath: z.string().default('')
});
const DEFAULTS = {
    sharedDir: '.shared',
    promptSection: true,
    installSkills: true,
    minCriteriaPerDimension: 1,
    requireRebuttalOnBlocker: true,
    requirePrereviewBeforeDispatch: true,
    knowledgeMaxEntriesPerTopic: 200,
    docsDir: '',
    shadowIntervalMinutes: 10,
    executor: 'ide',
    devecocliPath: ''
};
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function positiveInt(value, fallback, min) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.trunc(value));
}
function str(value, fallback) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}
/**
 * Normalize whatever the loader passed into complete options.
 * @param raw - the row's config value (possibly `undefined`).
 * @returns options with every default applied.
 */
export function resolveOptions(raw) {
    const input = (raw ?? {});
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
        executor: input['executor'] === 'cli' ? 'cli' : 'ide',
        devecocliPath: typeof input['devecocliPath'] === 'string' ? input['devecocliPath'].trim() : DEFAULTS.devecocliPath
    };
}
