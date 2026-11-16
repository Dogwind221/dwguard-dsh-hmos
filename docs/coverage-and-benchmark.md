# 1.0.0 quality evidence

## Coverage baseline (2026-11-16)

```text
npm run coverage
tests: 191/191 pass
line:   86.92%
branch: 72.48%
funcs:  86.56%
```

Low spots are recorded, not hidden: `lib/client.js` is UI wiring; `lib/tools/scan.js`
is a tool wrapper; `lib/deveco.js` has command-failure branches. No threshold is
enforced yet.

## Benchmark baseline (2026-11-16)

```text
node scripts/bench-scan.mjs --samples 10 --write-baseline
files: 40
hits:  120
p50:   18.07 ms
p95:   19.51 ms
max:   19.51 ms
```

Baseline file: `benchmarks/scan-baseline.json`. Same-machine comparisons only.

## Concurrency

`tests/concurrency-stress.test.mjs` covers:

- 64 concurrent state updates: no lost increments, revision count exact;
- 64 concurrent index reservations: unique, contiguous;
- 24 concurrent queue claims: no task claimed twice.

The queue claim test found a real race: `claimHarnessTask`/enqueue/complete/fail
did read-modify-write without a queue lock. They now share
`withQueueLock(paths, ...)`.

These are local-file concurrency tests, not Go `-race` and not a multi-process
production load test.

## Clean install

Verified on a temporary headless profile:

```text
profile: dwguard-clean-0919
install: dwguard-dsh-hmos 0.9.9 (local tarball)
dump-config: # == dwguard-dsh-hmos / id: dwguard-hmos
headless: CLEAN-INSTALL-0.9.9 (exit 0)
```

Temp profile removed after the test. See [clean-install-checklist.md](clean-install-checklist.md).

## Still not verified

- npm-installed 0.9.9/1.0.0 (not published yet)
- marketplace/catalog visibility
- live desktop profile upgrade
- physical HarmonyOS device

