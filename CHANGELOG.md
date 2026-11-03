# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.6.1 — 2026-11-03

The aesthetic-learning release: preferences become a first-class, auditable
record instead of a fresh argument every round. `learn` only proposes; the user
chooses; only then is the profile written.

### Added

- **`dwguard_aesthetic`** (the 14th tool), four actions:
  - `profile` (`list` / `get` / `write` / `remove`): writes require a `source`
    and a `confidence`; a write without a source is rejected. `remove` only
    marks the entry `superseded` — history is never deleted.
  - `learn`: deterministic extraction (clause split, area keywords, numbers,
    units, colours). Default returns proposals/conflicts and writes nothing;
    `apply` requires `confirmed: true`; a same-area value conflict requires a
    `choice`, the loser is marked `superseded` and the decision is appended to
    `aesthetic-history.jsonl`. Confidence: confirm +0.1 / reject −0.2 / repeat
    +0.05, clamped to 0–1.
  - `baseline` (`save` / `list`): saving is refused unless the current pack has
    a passing audit **and** a user confirmation; bounds JSON and an optional
    screenshot are copied into `artifacts/visual-baseline/<specVersion>/` with
    their SHA-256.
  - `compare`: numeric layout-tree diff — spacing/radius ±2vp, font size and
    colours zero tolerance; result is written to
    `artifacts/aesthetic/compare-latest.json`.
- **`profileRef` on criteria/checks**: `dwguard_spec` accepts an aesthetic
  profile reference (`AES-RADIUS-01`) and warns (`W_AEST_PROFILE_HINT`) when an
  aesthetic criterion ignores an existing preference; malformed refs are
  rejected. The audit gate refuses a `profileRef` that is missing or
  `superseded`, and both the audit and acceptance reports render an
  「审美档案」 column plus a 「审美基线差异」 section; `audit-<n>.json` records
  `aesthetic.profileRefs` and the latest `compare`.
- **Cold start**: `learn` (`coldStart: true`) seeds palette / spacing / radius /
  type from the project's `resources/base/element/color.json` and `float.json`.

### Tests

- `tests/aesthetic.test.mjs`: all eleven acceptance criteria (AEST-A … AEST-K)
  plus deterministic extraction — profile write/read, learn-never-writes,
  confidence deltas, same-area conflicts, apply-with-choice, baseline
  prerequisites, compare thresholds, `profileRef` gate, cold start, report
  rendering, no-source rejection.
- `tests/version.test.mjs` + `tests/release.test.mjs`: release hygiene — README
  version pins and package-name spelling must track `package.json`, and a bump
  must find a CHANGELOG section for the target version.

### Changed

- Tool count 13 → 14; README, preset comment and the `dwguard-hmos` skill are
  updated. `scripts/release.mjs` now syncs README version references on bump.

## 0.6.0 — 2026-11-02

Device-matrix release: every verdict now records **which device and screen family**
it came from, and adaptation criteria cannot be certified on a single screen.

### Added

- **Host-memory-aware device policy**: `hostMemoryGb` (0 = auto-detect via
  `os.totalmem()`), `deviceMode` (`auto` / `single` / `matrix`),
  `matrixMinMemoryGb` (default 32). `< 32GB` forces single-device verification
  (16GB machines get a warning if a matrix is configured); `>= 32GB` enables the
  matrix. Auto concurrency is memory-scaled (32GB → 2, 64GB → 4).
- **Huawei screen-family matrix**: `phone` / `widefold` / `foldable` /
  `triplefold`. `matrixScope` defaults to function/performance on the bar phone
  and aesthetic/accessibility across all four families.
- **Audit evidence carries the device**: `dwguard_audit` checks accept `device`
  and `family`; in matrix mode both are required, and the gate refuses a missing
  family (`allowMissingMatrixFamilies: true` downgrades it to a warning written
  into the report).
- **Reports**: `audit.json` records `devices[]`; audit and acceptance reports
  render a 判据 × 屏幕族 matrix and a device list.
- **Serial device access**: `dwguard_deveco` defaults to the pool's bar phone and
  serialises device actions through `.shared/.device-lock.json`; a lock older
  than `deviceLockTimeoutMs` is reclaimed.
- **Status**: `dwguard_status` shows host memory, effective mode, matrix gaps and
  the current device lock.

### Changed

- Coverage rolls up one verdict per criterion (single mode) or one per
  criterion × screen family (matrix mode).

### Compatibility

- Empty `devicePool` + `single` mode behaves like 0.5.0; packs written earlier
  need no migration. `checks[].device/family` are optional outside matrix mode.

## 0.5.0 — 2026-11-02

The "assertions" release: a criterion that states a number can now be judged by
the audit gate itself instead of by an auditor's prose, and evidence gathering
gets a repeatable script template plus external interaction-trace recipes.

### Added

- `dwguard_spec` criteria accept an optional `assertion`: `matcher` (`equals` /
  `contains` / `regex` / `range` / `gte` / `lte` / `oneOf` / `present`) plus
  `expected` / `min` / `max` / `unit` / `source`. Invalid assertions (unknown
  matcher, `range` without bounds, bad regex…) are rejected before the pack is
  frozen.
- `dwguard_audit` checks accept `actual` (the measured value). For a criterion
  with an assertion the gate recomputes the verdict, stores it in
  `assertionVerdict`, refuses a `pass` that contradicts the assertion or omits
  `actual`, and warns when a `fail` contradicts a passing assertion.
- `tasks/spec.md` and the Goal brief render an「断言」column; audit, acceptance
  and rework documents render 断言 / 实测值 / 断言判定 columns.
- Proposal + migration notes: `docs/0.5.0-assertion-plan.md`; guidance added to
  the `hmos-acceptance-rubric` and `hmos-audit-playbook` skills.
- **P1** — evidence-gathering script template in `skills/hmos-audit-playbook.md`
  §12: beforeAll / afterAll, `waitForIdle` (layout-stability check), retry budget
  (`attempt=n/3`), and a popup rule table (privacy / permission / upgrade / lock
  screen).
- **P2** — interaction-trace recipe in `docs/perf-baseline.md` §4: external fps
  and jank buckets (`hidumper -s RenderService -a 'fps|hitchs <bundle>'`),
  `hitrace` capture as review material, and click→usable-layout timing as
  `actual` (app-side `hiTraceMeter` marks are auxiliary only).

### Changed

- Rework orders now include a「闸门问题」section so gate errors (not only failed
  criteria) reach the executor.
- `W_CRITERION_NO_ASSERTION` nudges `must` criteria that state a number but carry
  no assertion.

### Compatibility

- `assertion` / `actual` are optional: packs written by 0.4.x keep working
  unchanged, and older readers simply ignore the new fields.

## 0.4.2 — 2026-11-01

Documentation sync release — no code changes. Brings the npm README up to date
with the actual tool count.

### Fixed

- README (zh/en) and the preset comment now say **13 tools**: `dwguard_audit_dimension`
  was missing from the count (`dwguard_spec`, `prereview`, `dispatch`, `shadow`,
  `scan`, `rules`, `deveco`, `audit_dimension`, `audit`, `calibration`, `confirm`,
  `knowledge`, `status`).
- README version pins and npm links point at 0.4.2.

### Changed

- `publish.yml` now checks the registry first and **skips publishing when the
  version already exists**, so re-tagging / force-moving an already published
  release no longer produces a failed workflow (and a failure email).

## 0.4.1 — 2026-11-01

The install-path release: the plugin ships on npm, and the install docs now match
how DSH actually manages profiles.

### Added

- npm publication (`dwguard-dsh-hmos` on the public registry; installed with
  `dsh plugin add dwguard-dsh-hmos` in CLI profiles or the **Plugins → Add
  plugin** dialog in the desktop app) plus an npm badge in both READMEs.
- Trusted publishing (OIDC) for the tag-triggered publish workflow: no
  long-lived `NPM_TOKEN` secret, and provenance is attached to every publish.

### Fixed

- Install/uninstall docs: `desktop` is managed exclusively by the Desktop app and
  `dsh plugin --profile desktop …` is rejected by the CLI. Desktop users install
  from the sidebar **Plugins → Add plugin** dialog; CLI profiles (`web` / `tui` /
  `headless`) keep using `dsh plugin --profile <name> add …`. Verified end-to-end
  against DSH `0.2.1-rc.5`: registry install, profile bundle reconciliation
  (`dsh.profile.bundles` gains the package), no `--allow-version` exemption
  needed (`engines.dsh` matches).

## 0.4.0 — 2026-11-01

The "learn the docs" release: backlog items become cited rules or explicit
documentation, and the rule catalog grows to 75 entries (66 with official
citations).

### Added

- **ArkUI V2 rules** — `STATE-06` @Monitor scope, `STATE-07` @Computed purity,
  `STATE-08` @Provider/@Consumer constraints, `STATE-09` V1→V2 component-by-component
  migration.
- **Accessibility depth** — `A11Y-13` 2x font layout; `scripts/a11y-walkthrough.md`
  (screen-reader walkthrough with evidence naming); `dwguard_deveco a11y`
  snapshot (layout tree + accessibilityId + static accessibility scan).
- **Design components** — `AES-13~21`: list row heights, text box, dialog,
  title bar, bottom tabs, switch, progress, Symbol icons, card-style lists.
- **Performance templates** — `docs/perf-baseline.md`: device matrix, cold-start
  five stages, long-frame collection, memory/package-size templates.
- **AGC + privacy** — `AGC-01~09`: release signing/debuggable, first-launch
  privacy policy, permission denial behavior, sensitive-permission purpose &
  minimization, store-listing consistency, test account, privacy "double list",
  no review-bypass updates, ad-law wording. Checklist in
  `docs/agc-publishing.md`, sourced from Huawei `50104` / `50170` / `faq-05`.

### Changed

- Rule catalog: 52 → **75** rules; cited 43 → **66** (function 30, aesthetic 21,
  performance 11, accessibility 13).
- Test suite 49; docs/rule-sources, learning-backlog and 0.4.0-plan updated.
- npm publish workflow now skips publishing when `NPM_TOKEN` is absent (tagging
  no longer fails on a missing secret).

## 0.3.0 — 2026-11-01

The hybrid-executor release: the IDE agent stays the visual judge, a CLI agent
can implement, and DevEco CLI becomes a first-class evidence source.

### Added

- **IDE-first executor routing** — `executor: auto` (default) keeps DevEco Code
  first; CLI only takes over when the pack has no visual `must` criterion and the
  requirement/spec/constraints clearly ask for batch / regression / CI work.
  A pack can pin `executor: ide | cli`; explicit options still win.
- **Executor modes** — `executor: ide | cli`. In `cli` mode `dwguard_dispatch`
  also writes `tasks/cli-brief.md` with the `devecocli` command contract
  (`build` / `run` / `run --apply` / `log` / `device`), while visual evidence
  stays on DSH's side.
- **`dwguard_deveco`** — evidence adapter over DevEco CLI:
  `env / build / run / log / lint / device / uiHelp / ui / attach / jobs / stop`.
  Every run records the exact command, exit code, duration and output under
  `artifacts/deveco-<n>/` (`result.json` + `output.log`) and can be cited from
  `checks[].evidenceFiles`.
- **Device evidence** — `screenshot` / `layout` / `verify` run the real
  `devecocli ui screenshot|layout` and `devecocli verify --test-plan` commands;
  screenshots land in `artifacts/devshots/`, layout JSON in
  `artifacts/deveco-<n>/layout.json`. Verified against `devecocli 1.3.10` on
  Windows (`env`, `device list`).
- **Async jobs** — `background: true` on build/run/log starts `devecocli`
  detached, returns a job id immediately, and `jobs` / `stop` manage it — long
  builds no longer block the DSH conversation.
- **Auto-detect binary** — `devecocli` is resolved from `devecocliPath`, the npm
  global bin (`%LOCALAPPDATA%\Programs\nodejs\devecocli.cmd`,
  `%APPDATA%\npm\devecocli.cmd`), then PATH.
- **Evidence reuse** — `dwguard_deveco attach` registers an existing build/deploy
  log as evidence without rebuilding, avoiding duplicate builds.
- **Watchdog** — `dwguard_status` flags a dispatched round with no ack/delivery
  after `stallMinutes` (default 30), in both Chinese and English next actions.
- **Event wait** — `dwguard_status waitSeconds` long-polls for a new delivery
  (0–120s), a lightweight "delivery event" subscription.
- **Panel language toggle** — `中 / EN` button before refresh, persisted in
  `localStorage`; phase, next action and history labels switch together
  (`board.nextEn`, `history[].labelEn`), with host-language default.
- **Device UI probe** — `uiHelp` captures `devecocli ui --help` so the agent can
  learn the installed CLI's UI interface before calling `ui`.

### Changed

- README (zh + en) documents the hybrid mode and the new tool; config gains
  `executor` and `devecocliPath`.
- Test suite 39 → 48 (CLI brief, deveco env/failure/missing binary, unsafe args,
  IDE-first routing, attach reuse, background jobs, device actions, stall watchdog).

## 0.2.0 — 2026-11-01

The hardening release: the framework stops trusting prose and starts recording
evidence, rules, round boundaries and gate accuracy.

### Added

- **Evidence bundles** — `dwguard_audit` accepts `checks[].evidenceFiles`
  (relative to `.shared/`), copies them into `artifacts/audit-<n>/evidence/`,
  records SHA-256 in `manifest.json`, and refuses missing or oversized files
  (20 MB per file, 100 MB per bundle).
- **Independent static scan** — `dwguard_scan` with eight rules and stable IDs
  (`STATE-NESTED-01`, `ARKTS-ANY-001`, `ARKTS-IMPORT-KIT`, `ARKTS-V1V2-MIX`,
  `OHPM-FAKE-001`, `PERF-LIST-FOREACH`, `LIFECYCLE-TIMER`, `A11Y-TEXT-001`).
- **Rule catalog** — 41 rules with `citation` (official URL + section + version);
  `dwguard_spec` validates `ruleId`, findings reject unknown IDs.
- **Rules + corpus tool** — `dwguard_rules list|get|search` over the catalog and
  a local official-docs corpus (`docsDir` / `DWG_DOCS_DIR`).
- **Protocol v2** — outbox records carry `kind · #id · from/to · re`; `ack` and
  deliver records are matched by `re=`; un-acked dispatches are reported for the
  current round only.
- **Shadow review** — `dwguard_shadow` runs during `dispatched`/`rework`
  (incremental scan, optional UI tree via a manual path or the host's
  `harmony_ui_tree`), writes `artifacts/shadow-<n>.json`, and sends only **new**
  must-level risks to the outbox.
- **User confirmation as state** — `dwguard_confirm` records `accept` /
  `new_round`, bumps the iteration, and adds a `confirmed` phase.
- **Calibration ledger** — every audit/confirmation appends to
  `knowledge/calibration.jsonl`; `dwguard_calibration report|miss` shows the
  per-dimension miss rate.
- **Board history timeline** — the panel lists recent prereview / dispatch /
  audit / rework / shadow / confirmation events.
- **Panel polish** — English dictionary (host language), `role="status"`
  announcements, `prefers-reduced-motion` support.
- **Engineering** — CI workflow, release script, English README, client wiring
  tests.

### Changed

- Round isolation: a new task pack version no longer inherits the previous
  round's prereview/audit verdicts (`specVersion` scoping + per-round counters).
- `dwguard_dispatch` requires a passing prereview **for the current pack**.
- `STATE-002` was removed: current ArkUI observes `@State` array APIs
  (`push`/`pop`/`splice`…). The real trap is nested property assignment, now
  `STATE-NESTED-01`.
- The sidebar entry and board are documented as `DshHoms`; the board runs
  top-to-bottom with parallel rows and return edges.

### Fixed

- The scaffold `outbox-deveco.md` header no longer counts as an unread delivery.
- Deleted workspaces are pruned from the panel's workspace selector.

## 0.1.0 — 2026-10-30

First working loop.

### Added

- Six tools: `dwguard_spec`, `dwguard_prereview`, `dwguard_dispatch`,
  `dwguard_audit`, `dwguard_knowledge`, `dwguard_status`.
- Four-dimension task packs with a hard acceptance gate (must criteria covered,
  all dimensions assessed, no open blocker/major, no `unverified` on must).
- Pre-review gate (a blocker needs an attempted rebuttal), rework orders,
  knowledge sediment, status derivation from artifacts.
- Three skills (`dwguard-hmos`, `hmos-acceptance-rubric`, `hmos-audit-playbook`).
- Right-sidebar board entry `DshHoms` with the live flow map.

