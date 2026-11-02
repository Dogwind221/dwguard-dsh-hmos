# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0 — unreleased

The "assertions" release: a criterion that states a number can now be judged by
the audit gate itself instead of by an auditor's prose.

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

- npm publication (`dwgward-dsh-hmos` on the public registry; installed with
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

