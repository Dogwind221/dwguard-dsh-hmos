# AI code review — 0.9.8 (verified on 0.9.9 candidate)

Scope: the 0.9.6 typed-evidence layer only. Read-only review first; fixes were
applied and then verified in the user's terminal on 2026-11-16.

## Verification status

The user ran, from `F:\dsh\Github\dwguard-dsh-hmos`:

```text
npm run build       ✅
npm run typecheck   ✅
npm test            ✅ 188/188
```

The three fixes below are therefore verified; the final 0.9.9 publish gate still
needs `node scripts/verify-publish.mjs --tag=v0.9.9` after version alignment.

## Findings

### 1. Matrix families shared typed-evidence coverage

- Location: `src/review.ts` `summarizeEvidenceCoverage`.
- Bug: evidenceRefs were unioned across every check of a criterion. A screenshot
  supplied on `phone` could make coverage look satisfied for `foldable`, where
  the check had no screenshot.
- Why it matters: the audit gate itself downgrades per check, but the reported
  `coverage.evidence` could be false, and the checker could show 100%.
- Fix: count required/satisfied per check; missing entries carry optional
  `family`; gate messages include the family.
- Regression test: `tests/evidence-contract.test.mjs` — matrix families do not
  share typed evidence coverage.

### 2. Checker reported coverage without checking files exist

- Location: `bin/dwguard.mjs` `checker()`.
- Bug: it trusted `audit.checks[].evidenceRefs`; a deleted/missing file still
  looked covered.
- Why it matters: checker is the read-only evidence sanity tool; it must not
  claim coverage from JSON alone.
- Fix: `stat` every ref path under `.shared`; emit a note when the file is
  missing or not a regular file.
- Regression test: `tests/cli.test.mjs` checker test asserts a missing-file note.

### 3. Invalid requiredEvidence was silently dropped

- Location: `src/spec.ts` `parseTaskPack`.
- Bug: requiredEvidence values not in `EVIDENCE_KINDS` were filtered out, so
  `validateTaskPack` never saw them and a corrupted pack looked like a legacy
  pack with no requirement.
- Why it matters: a typo such as `screenshot_bogus` silently disables the gate.
- Fix: preserve string values through parsing so validation emits
  `E_CRITERION_EVIDENCE_KIND`; `buildTaskPack`/validator remain the authority.
- Regression test: `tests/evidence-contract.test.mjs` — invalid requiredEvidence
  survives parse so validation can reject it.

## Changed files

- `src/review.ts`
- `src/spec.ts`
- `bin/dwguard.mjs`
- `tests/evidence-contract.test.mjs`
- `tests/cli.test.mjs`

## Verification status (historical note)

The 0.9.8 candidate could not be built in the original shell session
(`spawn EPERM`). The user later ran the commands above manually; 188/188 tests
passed. No push/tag/publish was done by the agent.

## P1 follow-up: queue claim race

The 24-concurrent-claim stress test exposed a fourth, separate bug in
`src/harness.ts`: enqueue/claim/complete/fail did an unlocked
read-modify-write of `queue.json`, so concurrent claims overwrote each other
(observed: 1 unique task instead of 24). Fixed by serialising all queue
mutations through `withQueueLock()`; the stress suite is now 191/191.
