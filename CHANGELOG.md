# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

