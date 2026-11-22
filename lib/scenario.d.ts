/**
 * Scenario step schema + validation for the `scenario` action.
 *
 * A scenario is an ordered list of UI steps (tap/input/swipe/wait/assert/capture)
 * that the tool executes sequentially and records as per-step evidence. The
 * parser is pure: no I/O, so a malformed scenario fails before touching a device.
 *
 * @module dwguard-dsh-hmos/scenario
 */
export type ScenarioStep = {
    readonly op: 'click';
    readonly id?: string;
    readonly x?: number;
    readonly y?: number;
    readonly window?: string;
} | {
    readonly op: 'text';
    readonly text: string;
    readonly id?: string;
    readonly x?: number;
    readonly y?: number;
} | {
    readonly op: 'swipe';
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly speed?: number;
} | {
    readonly op: 'sleep';
    readonly ms: number;
} | {
    readonly op: 'screenshot';
    readonly name?: string;
} | {
    readonly op: 'assert';
    readonly selector: string;
    readonly expect?: 'present' | 'absent' | 'count';
    readonly count?: number;
    readonly timeoutMs?: number;
};
/** Parse a JSON scenario (`[...]` or `{ "steps": [...] }`) into validated steps. */
export declare function parseScenario(raw: string): ScenarioStep[];
