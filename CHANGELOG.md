# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.9.1 — 2026-11-10

DSH Market compatibility fix.

### Fixed

- `peerDependencies["@deepseek-ai/dsh-tools"]` changed from exact
  `0.2.1-rc.5` to `^0.2.1-rc.5`. DSH Market compares every
  `@deepseek-ai/dsh-*` peer against the **host** DSH version; the exact pin
  was classified as `aboveMax` on DSH `0.2.2-rc.1`, hiding the plugin as
  incompatible in discovery/install preflight.
- Added the missing catalog submission metadata instructions/doc; npm publish
  alone does not list a plugin in DSH Market (the catalog is curated by
  `awesome-dsh-plugin`).

## 0.9.0 — 2026-11-09

Device/automation foundations.

### Added

- Standalone CLI `bin/dwguard.mjs` (`dwguard-hmos`), no DSH process required:
  - `doctor`: Node, project structure, `.shared`, disk, `devecocli`, `hdc`,
    device/physical-device, device leases.
  - `review`: recompute evidence SHA-256/size, storedAs/path containment,
    manifest/audit/specVersion consistency, acceptance/rework consistency.
  - `bridge`: parse DevEco `outbox-deveco.md`, append events, enqueue
    `delivery-review` harness tasks with idempotent cursor.
  - `bench --faults`: built-in fault cases; `bench --device` runs device smoke
    (version/build/screenshot/layout) or reports `blocked` with exit 2.
  - `quickstart`: `devecocli create` + build a 10-minute sample project without
    hand-writing `entry/` or `AppScope/`.
- Tests for doctor, review hash tampering, bridge idempotency and fault bench.
- Docs: `docs/0.9.0-plan.md`, `docs/quickstart-10min.md`.

### Boundaries

- Physical-device evidence is only produced when a real device is connected;
  emulator-only runs report the device kind and do not claim physical coverage.
- `bridge` is a local file bridge; scheduling is left to Task Scheduler/cron or
  `scripts/harness-worker.mjs`.
- No cross-machine distributed state.

## 0.8.8 — 2026-11-08

DshHoms visual redesign — direction A, "precision console".

### Changed

- Client UI (`lib/client.js`, no data/flow changes):
  - near-black blue canvas with a subtle 24px grid behind the flow;
  - header actions grouped into one segmented control (workspace / 中-EN / refresh);
  - phase bar with semantic dot and mono workspace/version/round info;
  - next-action callout with a 2px accent rail;
  - refined node states (done/active/failed/pending), chips and live pulse;
  - history card with a timeline rail and mono timestamps;
  - monospace data/path/timestamp styling and improved secondary contrast;
  - `prefers-reduced-motion` still disables all motion.
- Palette moved to slate/cyan/emerald/amber/violet tokens.
- Docs: `docs/0.8.8-ui.md` + static preview `docs/assets/dshhoms-0.8.8.png`.

### Unchanged

- Workspace selection, language dictionaries/localStorage, 15s refresh, flow
  coordinates/rework loops, tools and audit logic.

## 0.8.7 — 2026-11-08

L4 evidence engineering (not an L4 certification).

### Added

- CI matrix: Ubuntu / Windows / macOS × Node 24, with `npm ci`, typecheck,
  build, stale-`lib/` check, tests and `npm pack` gate.
- `npm run soak:100`: sequential full-suite repeatability run with isolated
  `DSH_HOME` per round; writes `artifacts/soak/summary.json` and keeps failure
  logs as `artifacts/soak/round-<n>.log`. Result: 100/100 rounds, 16,800 test
  executions, 0 failures.
- Soak runner caps captured output and kills the process tree on timeout/overflow.
- Windows lock retry: `EPERM`/`EACCES` from an `open(..., 'wx')` lock race are
  treated as contention (found by soak round 6), not a fatal command error.
- `artifacts/` is ignored; soak evidence stays local.

### Notes

- CI matrix and soak close the repeatability/cross-platform/release-content
  evidence gap; real projects, physical devices, independent audit and external
  adoption are still required for L4.

## 0.8.6 — 2026-11-08

Release-pipeline and runtime hardening.

### Added

- Publish workflow now installs (`npm ci`), typechecks, builds, rejects stale
  committed `lib/` (`git diff --exit-code`), tests, verifies `tag ===
  package.json.version`, validates `npm pack` contents, then publishes.
- `pretest` builds before running tests; `prepublishOnly` runs
  typecheck/build/test/pack gate; `scripts/verify-publish.mjs` checks runtime
  assets and rejects `tests/` / `node_modules/` in the package.
- `scripts/verify-publish.mjs --tag=vX.Y.Z` for local/CI release checks.
- Bounded subprocess output (4MB total), process-tree kill on timeout/overflow.
- Screenshot validation (existence, non-empty, size, PNG/JPEG magic) for
  `screenshot` and pipeline screenshot/layout artifacts.
- Evidence `realpath` containment, rejecting symlink/Junction escapes.
- PNG decoder limits and 4MB HTTP response reader.
- Embedding/CLIP cache identity: provider + endpoint + model + modelVersion.
- Background `run/log` guard: checks every 5s, snapshots to `output.log.1` and
  truncates above `maxDevecoLogBytes` (default 10MB); `jobs`/`stop` clear it.

### Changed (breaking)

- Windows `cmd.exe` arguments containing `& | < > ^ % !` or newlines are
  rejected.
- Screenshot exit code 0 without a valid image is now a failure.
- Embedding cache schema is 2; old model-only caches are invalidated.
- `designEmbeddingModelVersion` / `designClipModelVersion` config added.

### Tests

- 168/168; added shell-metachar, screenshot-without-file, symlink evidence,
  PNG-dimension bomb, HTTP body cap, cache identity and publish-gate checks.

## 0.8.5 — 2026-11-08

Security hardening for the six release blockers found in the 0.8.0 review.

### Changed (breaking)

- `strictEvidence` defaults to `true`: must + pass requires `evidenceFiles` or a
  collector `observationRef`; self-report text is now an error, not a warning.
- `actual` must be structured for numeric assertions:
  `{ value, unit?, samples?, aggregation? }`. Free-text extraction of the first
  number is removed; unit mismatches fail; multi-sample performance values need
  `max` / `p95` / `mean`.
- Matrix audits validate `device` against `devicePool` and require the family to
  match; matrix must+pass also requires a collector `observationRef`, which
  validates the collector device and spec version.
- Board responses return workspace ids instead of absolute paths; the client uses
  `?workspace=<id>`.

### Added

- Design-pack import hardening: requested name must equal `pack.json.name`;
  `resolve`/`relative`/`realpath` containment; image sha256 validation; all paths
  are validated before any copy/write.
- Evidence bundle names are `evidence/000001-<sha256>.<ext>` and are created with
  `wx`; destination bytes are re-hashed.
- Per-device leases in `.device-locks/<hash>.json` with `token`, `jobId`,
  `acquiredAt`, `heartbeatAt`, `expiresAt`; `wx` acquisition, token-checked
  renew/release, background heartbeat, and different devices run independently.
- State `revision` + lock-protected updates; atomic id reservation; per-dimension
  progress files `audit-progress/<specVersion>/<dimension>.json`.
- `commandId` on every tool via the idempotency ledger; re-submitting an id
  returns the first result instead of repeating bookkeeping.
- Board: loopback-only by default, optional `boardToken` (`x-dwguard-token`),
  Host/Origin checks, registered-workspace allowlist, no absolute workspace
  paths in responses.
- `observationRef` support for collector evidence.

### Tests

- 161/161; added collision/path-traversal, strict evidence, structured actual,
  device pool, per-device lease/background lifecycle, state CAS, index
  reservation, progress split, commandId replay and board auth regressions.

## 0.8.0 — 2026-11-06

The recovery/knowledge/execution release. This is a developer-side AI-native
harness; app-side AI is explicitly out of scope (a phone is not a development
runtime).

### Added

- **`dwguard_harness`** (16th tool): durable `.shared/harness/run.json` with
  `checkpoint` / `resume` / `retry` / `fail` / `fallback` / `close`; a persistent
  `.shared/harness/queue.json` with `enqueue` / `queue` / `claim` / `complete` /
  `task-fail` and lease expiry. `scripts/harness-worker.mjs` can be scheduled by
  Windows Task Scheduler/cron to claim/resume without a human opening a round.
  Resume checks specVersion/iteration and marks stale runs; retry stops at
  `harnessMaxRetries` and turns into a human decision.
- **Knowledge/SOP library**: 14 SOPs (`knowledge/sops.json`) + 32 engineering
  facts (`knowledge/engineering.json`), searchable through
  `dwguard_knowledge action:"sops" / "sop" / "engineering"`. Covers environment,
  build/sign, install/launch, functional/aesthetic/accessibility/performance,
  regression, release/AGC and bugfix.
- **Execution pipeline**: `dwguard_deveco action:"pipeline"` runs
  `sign → build → run → screenshot → layout`, writes per-step evidence to
  `artifacts/deveco-<n>/pipeline.json`, stops at the first failure, supports
  `resume: true`, and automatically tries `devecocli → deveco-mcp → hdc+hvigor`
  (hdc screenshot/layout adapters verified on the emulator; every tier attempt is
  recorded). `sign` runs `devecocli signature generate`.
- **CLI/device verification**: `docs/0.8.0-verification.md` records the real
  `devecocli 1.3.10` + Pura 90 emulator run, including the API-level mismatch,
  sign-before-build fix, device-name quoting fix and layout-notice parsing.
- `harnessMaxRetries` (default 3), `devecoMcpCommand`, `hdcPath`,
  `hvigorPath` config.

### Boundaries

- Pipeline output is execution evidence, not acceptance; `dwguard_audit` still
  decides.
- No app-side AI / Intent / on-device model integration.
- No cross-machine distributed run state; multi-project runs isolate their
  `.shared` and serialise device access via the existing device lock.
- `deveco-mcp` is a configurable tier; its concrete command interface was not
  available on this machine.

### Tests

- Harness recovery (cross-instance resume, stale run, retry budget, fallback),
  queue lease/expiry/worker, knowledge/SOP counts/search, pipeline order/failure/
  resume/automatic hdc fallback and tool registration; suite is now 147/147.

## 0.7.1 — 2026-11-04

Documentation patch only. No runtime, API, schema or recommendation behavior changed.

### Fixed

- Architecture diagram now includes the design-reference/paradigm-pack branch above
  `## 安装`; the acceptance-only ASCII flow and DshHoms screenshot are labelled as
  the acceptance main loop (not the full current map).
- Stale “three skills” comments in `cordis.patch.yml`, the agent preset and the
  plugin entry comment are now “four skills”.
- `docs/benchmark-integrations.md` and `docs/learning-backlog.md` are clearly
  marked as 0.3 baseline snapshots, so their old tool counts/“weakness” notes are
  not read as 0.7.x behavior.
- Install/publish notes updated for the published 0.7.x packages.

### Tests

- No code change; suite remains 135/135.

## 0.7.0 — 2026-11-04

The pack lifecycle release: paradigm packs get a registry, supersedes, schema v2
and migration, portable import, pack-level feedback, and a top-3 benchmark.

### Added

- **Pack registry**: `.shared/design-packs/index.json` records status
  (`draft`/`paradigm`/`superseded`), module/tone/density, card ids, evidence,
  supersede links and feedback. `pack registry` prints it; `pack list` shows v2
  status/module columns.
- **`supersedes`**: `capture-pack supersedes:"old-pack"` marks the old pack
  `superseded`, records `supersededBy`, blocks its learned card, and keeps the
  old pack files for audit trail.
- **Schema v2 + migration**: packs are written as `schemaVersion: 2` with
  `status`, `cardFiles`, audit/confirmation evidence, preview, why/cost and
  `feedback`. `pack migrate packName:"..."` upgrades v1 packs to inbox-compatible
  cards + v2 metadata; without evidence the migrated pack stays `draft`.
- **Import path rewrite**: `pack import` copies the pack preview into the target
  project and rewrites card preview paths to
  `design-packs/<name>/preview/index.html`; missing previews are dropped instead
  of leaving broken paths.
- **Pack-level feedback**: `pack-feedback packName:"..." verdict:"useful"|"off"`
  updates registry counts/score and the learned card weight (bounded), and
  appends to `.shared/design-packs/feedback.jsonl`; `recommend` includes the
  feedback score in pack ranking.
- **Recommendation benchmark**: `benchmark suite:"design-library/benchmarks/recommend.json"`
  evaluates top-3 pack hits and writes `artifacts/recommend-benchmark.md`;
  `benchmarks/recommend-2026.json` is the template.
- Brief/recommend output now understands `packRef`/`componentIds` and
  `supersededBy`.

### Tests

- Registry/supersedes, pack feedback, v2 migration, import preview rewrite and
  benchmark cases added; suite is now 135/135.

## 0.6.8 — 2026-11-04

The recommendation loop: cards now know their module, tone and density, can carry
an HTML visual reference, and the accepted design freezes into a reusable pack.

### Added

- **Card metadata**: `moduleTags`, `tone`, `density` (`low|medium|high`) and a
  `preview` path (`.shared`-relative HTML, visual reference only). `colorProfile`
  (`temperature` / `contrast`) is derived from `tokens.palette`, never hand-written.
  Ingest normalizes tags, ignores invalid density/preview fields with warnings, and
  the new fields participate in `search` filters and ranking context.
- **`recommend`**: builds up to 3 diverse, explainable options from requirement,
  module, app type, platform, tone, density and brand colours; each option carries
  anchor/principle/anti-pattern ids, tokens, why, cost and preview. Writes
  `tasks/design-options.md` + `.shared/design-library/recommendations.json`.
- **`capture-pack`**: with `confirmed: true` **and** a passed four-dimension audit
  plus a matching `dwguard_confirm` record, freezes the selected option into
  `.shared/design-packs/<name>/` (`README.md`, inbox-compatible
  `cards/*.meta.json`, `pack.json` with audit/confirmation hashes, optional
  `preview/index.html`), then appends a `paradigm` card (`范式包 · <name>`,
  weight 1.2, `packRef`/`componentIds`) so later recommendations can learn from
  the accepted version. Without the gates, capture-pack refuses.
- Brief card details now render module/tone/density/color profile and the preview
  path, with an explicit “visual reference, do not copy code” note.
- `dwguard_design` description/params updated; the recommendation and capture flow
  is covered by two new tests.

### Tests

- New metadata/colour-profile/filter case and a recommend → capture-pack → learned
  project-card case; suite is now 133/133.

## 0.6.7 — 2026-11-04

The principle-layer release: abstract aesthetics from art/award curation become a
first-class card type with measurable proxies, while pattern cards keep owning
implementation and anti-patterns keep owning the hard gate.

### Added

- **`kind: principle` cards** (`PR-*` namespace) with `principle`,
  `perceptualEffect`, `proxies`, `applications`, `misuses` and optional
  `checklist`/`antiPatterns`. Ingest refuses a principle without at least one
  proxy/checklist item, so an unfalsifiable adjective cannot enter the library.
- **Dual-channel brief**: `tasks/design-brief.md` now has
  「0.2 设计原则（方向）」 (up to `designPrincipleCards`, default 3) next to brand
  constraints and pattern cards; principles never mix into the pattern result
  list, and dispatch inherits the same brief.
- **`principleRefs`**: aesthetic criteria/checks can reference `PR-*` cards as
  direction/contrast. Spec/audit validate reference integrity (format, existence,
  active status) and render a 「原则对照」 column plus
  `audit-<n>.json`'s `design.principles[]`; principle text itself is **not** a
  hard pass/fail criterion.
- **`awards-curation` skill** (4th bundled skill) and
  `benchmarks/awards-2026.json` with 20 benchmark queries for recall evaluation.
- `DESIGN_ENGINE_VERSION` → `0.6.7`.

### Tests

- New principle round-trip/brief/spec/audit case plus a benchmark schema test;
  suite is now 131/131.

## 0.6.6 — 2026-11-03

The multimodal-embedding release: DashScope native multimodal embeddings become a
first-class provider, one model can embed both text and images, and hybrid search
now expands recall semantically instead of only reranking lexical hits.

### Added

- **DashScope multimodal provider**: `designEmbeddingProvider` / `designClipProvider`
  accept `dashscope`; native endpoint
  `POST /api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`
  with `{model, input:{contents:[{text}|{image}]}}` →
  `{output:{embeddings:[{index,embedding}]}}`. Images are sent as
  `data:image/png;base64,…`; text hybrid uses the same native contents protocol,
  so `qwen3-vl-embedding` / `tongyi-embedding-vision-flash` can serve both text
  and image spaces. Endpoint defaults to the official native URL when the
  provider is `dashscope`; keys still come from env vars.
- **Semantic recall expansion**: hybrid now embeds every eligible card
  (title/summary/rationale/tokens/tags/stylePriority/donts, cached), takes a
  semantic top-30, unions it with the BM25 top-30, and only then blends
  `(1-w)×BM25 + w×cosine`. Cards with zero lexical overlap are now reachable.
  Successful runs report `hybrid 召回：lexical X + semantic Y（并集 Z）` and no
  longer keep the stale “not configured/fallback” note.
- `qwen3.7-text-embedding-flash` is no longer part of the recommended stack; the
  same multimodal model can serve text and image embeddings.
- `DESIGN_ENGINE_VERSION` → `0.6.6`.

### Tests

- Two DashScope native-contract cases (text hybrid + imageText) run against
  loopback stubs, plus a zero-lexical-overlap recall case; suite is now 129/129.
- Live native multimodal calls are **not** claimed: the test account currently
  returns HTTP 400 (account good-standing/overdue) for
  `tongyi-embedding-vision-flash` and HTTP 403 (free quota exhausted) for
  `qwen3-vl-embedding`. The models/endpoint exist; quota must be enabled for
  live verification.

## 0.6.5 — 2026-11-03

The inheritance + portability release: anti-patterns follow their design cards
into the audit checklist, image search gains an optional multimodal ranker, and
whole card libraries can move between projects.

### Added

- **AP auto-inheritance**: referencing a `DSG-*` card now pulls that card's
  `antiPatterns` into the spec validation and audit checklist (derived, not
  frozen into `spec.json`). `spec.md` lists `criterion ← designRef → AP`; reports
  mark inherited refs as 「（继承 DSG-xxxx）」; `audit-<n>.json` adds
  `source: explicit|inherited` and `inheritedFrom`. Missing/blocked APs anywhere
  in the chain fail both spec and audit.
- **CLIP / multimodal search**: optional `designClipEndpoint` (documented
  `POST {model, images?, texts?}` → `{imageEmbeddings?, textEmbeddings?}`
  contract), `designClipModel`, `designClipApiKeyEnv`, `designClipTimeoutMs`,
  `designClipWeight`. `search image:` blends perceptual and CLIP scores;
  `search imageText:` does text→image. Vectors cache in `clip-embeddings.json`;
  image search falls back to pHash if CLIP fails, text→image reports a clear
  error. `query.mjs` stays lexical.
- **Design card packs**: `dwguard_design pack list/export/import` with a global
  `designPacksDir` (default `~/.dsh/dwguard/design-packs`). Export writes
  `pack.json` + `refs/<sha>` for active cards; import (requires
  `confirmed: true`) assigns fresh ids, preserves kind/brand/tokens/source,
  dedupes semantically, copies images and rebuilds the index.
- `DESIGN_ENGINE_VERSION` → `0.6.5`.

### Tests

- `tests/design.test.mjs` gains AP inheritance, pack export/import and CLIP
  text→image/image-search/fallback/cache cases; suite is now 127/127.

## 0.6.4 — 2026-11-03

The adversarial-knowledge release: anti-patterns become first-class acceptance
gates, retrieval can rerank semantically or by image, and a project's aesthetic
profile can be exported as a reusable template.

### Added

- **Anti-pattern gate**: criteria/checks accept `antiPatternRefs` (`AP-*` only,
  aesthetic criteria only); `dwguard_spec` and `dwguard_audit` reject missing or
  blocked refs, reports render a 「反模式对照」 column, and
  `audit-<n>.json` records `design.antiPatterns`. `library ingest` warns when a
  pattern references an AP card that has not been ingested yet.
- **Hybrid semantic rerank**: optional OpenAI-compatible embedding endpoint
  (`designEmbeddingEndpoint`, `designEmbeddingModel`,
  `designEmbeddingApiKeyEnv`, `designEmbeddingTimeoutMs`,
  `designEmbeddingWeight`). Lexical top-30 candidates are reranked by cosine
  similarity, cached in `design-library/embeddings.json`; missing timeout/errors
  fall back to lexical with an explicit note. `query.mjs` stays lexical and the
  brief marks the DSH ranking as authoritative.
- **Search by image**: zero-dependency PNG decoder (`src/image.ts`, 8-bit
  non-interlaced gray/RGB/palette/GA/RGBA) computing a DCT pHash plus a 64-bin
  RGB histogram; `dwguard_design search` accepts `image` (a `.shared/` PNG) and
  ranks cards by `0.6 × pHash similarity + 0.4 × histogram intersection`.
  Features are cached in `image-features.json`; unsupported/corrupt images and
  path escapes are refused. DSH-only (the CLI stays text-only).
- **Cross-project aesthetic templates**: `dwguard_aesthetic template
  list/get/export/import` with a global directory
  (`aestheticTemplatesDir`, default `~/.dsh/dwguard/aesthetic-templates`).
  `import` requires `confirmed: true`; `merge` supersedes conflicting local
  entries and skips duplicates, `replace` swaps the whole profile; history is
  appended to `knowledge/aesthetic-history.jsonl`.
- `DESIGN_ENGINE_VERSION` → `0.6.4`.

### Tests

- `tests/design.test.mjs` gains eight 0.6.4 cases (AP spec/audit gates + report,
  hybrid rerank unit + cache + loopback HTTP + fallback, PNG pHash/histogram,
  image search, template export/import); suite is now 124/124.

## 0.6.3 — 2026-11-03

The structured-knowledge release: design cards get business dimensions and
anti-pattern references, brand constraints are injected into every brief, the
round has hard retrieval/audit budgets, and a failed aesthetic audit now feeds
the next brief's retrieval instead of only listing what went wrong.

### Added

- **Structured cards (A)**: `DesignCard` accepts `stylePriority`,
  `antiPatterns` (`AP-*` refs), `checklist` and `dimensions`
  (`appType` / `platform` / `style`); `search`/`query.mjs` gain matching
  filters (`appType`, `platform`, `style`, `kind`), with `kind: anti-pattern`
  cards in the `AP-*` namespace and the default search restricted to patterns.
- **Brand / business cards (B)**: `source.kind: brand` cards carry
  `positioning`, `audience`, `constraints`, `bannedStyles`; `generateDesignBrief`
  force-injects up to `designBrandCards` active brand cards into a
  「品牌与业务约束（强制注入）」 section, regardless of retrieval score. Brand
  cards are excluded from normal pattern search and queried explicitly with
  `kind: brand`.
- **Orchestration budgets (C)**: `maxAuditRounds` (default 5) and
  `maxDesignSearches` (default 12); state tracks `roundAudits`,
  `roundDesignSearches` and lifetime `designSearches`; `dwguard_spec` resets the
  per-round counters, `dwguard_audit`/`dwguard_design` refuse past the cap, and
  `dwguard_status` shows 「本轮预算：审计 N/M · 设计检索 N/M」 plus a stop action.
- **Rework → retrieval bridge (F)**: a failed audit writes
  `design-library/rework-suggestions.json` (one query + refs per failed
  aesthetic criterion), the rework order gets a 「2.5 设计参考建议」 section, and
  the next `brief` renders 「0.5 上一轮返工定向参考」 with targeted top-2 hits;
  a passing audit clears the queue.
- `DESIGN_ENGINE_VERSION` → `0.6.3`; card chunks include the title, and search
  results/list/stats expose the effective card kind.

### Tests

- `tests/design.test.mjs` gains five 0.6.3 cases (A schema+filters+CLI parity,
  B brand validation/forced brief injection, C search budget + reset, C audit
  budget + status, F rework queue → brief → clear); suite is now 116/116.

## 0.6.2 — 2026-11-03

The design-reference release: "what should it look like" becomes a shared,
retrievable and citable asset — one deterministic index read by both agents,
with design references wired into the four-dimension gate.

### Added

- **`dwguard_design`** (the 15th tool): `library init` writes
  `.shared/design-library/` (manifest / chunks / index) and generates a
  dependency-free read-only `query.mjs`; `library ingest` seeds cards from the
  aesthetic rule catalog and `inbox/*.meta.json` (images are copied into `refs/`
  by sha256); `library list`, `search` (deterministic BM25 + token/tag/profile
  boosts), `stats`.
- **Design brief + dual-agent channel (P1)**: `brief` writes
  `tasks/design-brief.md` and appends an `inspiration` outbox record;
  `dwguard_dispatch` generates and embeds the brief automatically; DevEco can
  append a `design-request` and `brief --request q-1` answers it;
  `dwguard_status` lists unanswered design requests in its next action.
- **Protocol v2.1**: new outbox kinds `inspiration` and `design-request`
  (append-only, `inspiration` answers carry `re=#q-N`).
- **`designRefs` gate (P2)**: criteria/checks may reference `DSG-*` cards;
  `dwguard_spec` validates they exist and are active (unknown/blocked are
  errors), the audit gate rejects missing/blocked refs, and audit/acceptance
  reports render a 「参考对照」 column; `audit-<n>.json` records
  `design.refs` (title/license/tokens).
- **Feedback + capture (P3)**: `feedback` applies `useful / off / block /
  unblock` (weight ×1.1 / ×0.8 inside 0.5–1.5, block hides the card, ledger in
  `feedback.jsonl`); `capture` (after a passing audit + user confirmation)
  stores the visual baseline as a `project` card, deduped by baseline hash.
- Config: `designTopK`, `designMaxChunks`, `designRanker` (`lexical` default,
  `hybrid` reserved with explicit fallback), `designBriefCards`,
  `designLicenseRequired`; paths for `design-library/` and `design-brief.md`.
- `hybrid` is accepted by the interface but falls back to lexical in 0.6.2 and
  says so in the result notes; no vector database, no model calls, no network.

### Tests

- `tests/design.test.mjs` (18 cases): RAG-A deterministic re-ingest, RAG-B
  24-card/8-query top-3 + stability, RAG-C path isolation + read-only search,
  RAG-E CLI parity, standalone CLI/licence/empty-query, hybrid fallback,
  P1 brief + design-request round-trip + dispatch embedding + empty-library
  behaviour, P2 spec/audit designRefs gates and report column, P3
  feedback block/unblock/weight and capture prerequisites/dedup.
- Full suite: 111/111.

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

### Fixed

- `learn` no longer mis-assigns numbers when a sentence mixes areas with `、`
  or an ASCII comma: the clause splitter handles those separators and each
  number binds to the nearest preceding keyword (falling back to the nearest
  following one), not to whichever keyword sits furthest right.
- Conflicts are resolved per area: `choices: { radius: "20vp", spacing: "12vp" }`
  resolves several conflicts in one confirmed call, while a single `choice` that
  matches more than one conflict is refused instead of silently replacing a
  preference the user never chose.
- Rejection evidence naming the value the profile already holds now lowers
  confidence (−0.2) instead of raising it (+0.05); `AEST-C`'s negative delta is
  reachable from product code.
- `profile write` refuses to overwrite an unparseable profile, requires
  `confirmed: true` when it would replace an active value, and the JSON block is
  written as marker + single line so backticks in a decision can no longer close
  the fence early and silently empty the profile.
- `compare` is unit-aware: `vp` and `dp` are equivalent, any other mismatch
  (`px`/`pt`/`fp` vs `vp`) fails with 「单位不一致」; a baseline with no
  measurable fields fails instead of passing zero rows; results are kept per
  page/state and every comparison is attached to the audit, whose report now
  states failed compares in the conclusion and the residual-risk section
  (no more “通过 + 未通过” contradiction, no duplicated heading).
- Baseline index entries with `.` / `..` names are rejected, and file stems carry
  a short hash so `a.b` and `a_b` cannot overwrite each other.
- Cold start scans `<module>/src/main/resources/base/element`,
  `entry/src/main/resources/...` and `AppScope/resources/...`, and lists the
  searched roots when nothing is found.
- Release helper: syncs the lockfile's version fields, builds before writing the
  bumped version files, and a dry run prints the computed version even when the
  CHANGELOG section is missing (`npm run release:dry` no longer always exits 1).

### Tests

- `tests/aesthetic.test.mjs`: all eleven acceptance criteria (AEST-A … AEST-K)
  plus deterministic extraction — profile write/read, learn-never-writes,
  confidence deltas, same-area conflicts, apply-with-choice, baseline
  prerequisites, compare thresholds, `profileRef` gate, cold start, report
  rendering, no-source rejection.
- `tests/version.test.mjs` + `tests/release.test.mjs`: release hygiene — README
  version pins and package-name spelling must track `package.json`, and a bump
  must find a CHANGELOG section for the target version.
- `npm test` is now self-contained: the host test packages are devDependencies,
  a committed `package-lock.json` pins the tree (`npm ci` in CI), and the
  `pretest` preflight prints the exact install command instead of an
  `ERR_MODULE_NOT_FOUND` stack when they are missing.

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

