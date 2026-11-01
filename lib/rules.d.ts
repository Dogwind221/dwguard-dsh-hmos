/**
 * The DwGuard rule catalog.
 *
 * Stable IDs are the contract between the task pack, the static scan, and the
 * audit: every criterion or finding can cite one, and the same rule keeps the
 * same ID across rounds. Aliases map our IDs to the community/official IDs so
 * reports can cite both. `citation` points at the exact official page (and
 * section / commit) a rule comes from, so a verdict can be re-read at source.
 *
 * @module dwguard-dsh-hmos/rules
 */
import type { Dimension } from './model.js';
/** Severity used when a rule is cited without one. */
export type RuleSeverity = 'must' | 'warn';
/** Official evidence behind a rule. */
export interface RuleCitation {
    /** Human label, e.g. `通用应用 UX 体验标准 2.1.3.3`. */
    readonly label: string;
    /** Canonical URL of the page (markdown source where possible). */
    readonly url: string;
    /** Section / standard number, e.g. `2.1.3.3`. */
    readonly section?: string;
    /** Version marker: page fetch date or docs commit. */
    readonly version?: string;
}
/** One catalog entry. */
export interface RuleEntry {
    /** Canonical DwGuard ID, e.g. `DW-FN-12`. */
    readonly id: string;
    readonly dimension: Dimension;
    readonly title: string;
    /** How an auditor proves it (screenshot / tree bounds / scan / measurement). */
    readonly verify: string;
    readonly severity: RuleSeverity;
    /** External or scan IDs that mean the same thing (`STATE-NESTED-01`, `AGC-RJ-013`…). */
    readonly aliases?: readonly string[];
    /** Short human label of the rule family. */
    readonly source: string;
    /** Official page + section this rule is grounded in. */
    readonly citation?: RuleCitation;
}
/** Canonical catalog. Keep IDs append-only; never renumber. */
export declare const RULES: readonly RuleEntry[];
/** Resolve a canonical ID or alias to its entry. */
export declare function findRule(id: string): RuleEntry | undefined;
/** Whether an ID or alias is in the catalog. */
export declare function isKnownRuleId(id: string): boolean;
/** All IDs and aliases (for error messages / docs). */
export declare function knownRuleIds(): string[];
/** Rule IDs that the static scanner emits, mapped to canonical entries. */
export declare function scanRuleIds(): string[];
