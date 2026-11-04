/**
 * The four bundled skills.
 *
 * Bodies live in `skills/*.md` so they can be read, reviewed and edited like
 * ordinary documentation. They are loaded synchronously at module load; a
 * missing file degrades to a compact built-in body instead of failing boot.
 *
 * @module dwguard-dsh-hmos/skills
 */
/** One bundled skill. */
export interface BundledSkill {
    readonly name: string;
    readonly description: string;
    readonly whenToUse: string;
    readonly content: string;
}
/** Load every bundled skill (bodies from disk, fallback when unavailable). */
export declare function loadSkills(): BundledSkill[];
