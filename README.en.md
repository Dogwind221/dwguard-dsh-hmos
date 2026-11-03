# DwGuard-Dsh-Hmos

[![CI](https://github.com/Dogwind221/dwguard-dsh-hmos/actions/workflows/ci.yml/badge.svg)](https://github.com/Dogwind221/dwguard-dsh-hmos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dwguard-dsh-hmos.svg)](https://www.npmjs.com/package/dwguard-dsh-hmos)

A DeepSeek Harness (DSH) plugin for HarmonyOS app delivery: DSH plans, pre-reviews
and **audits**; DevEco Code implements. The two agents coordinate through a
small file protocol under `.shared/`, and every verdict must be backed by
evidence DSH gathered itself.

> 中文文档见 [README.md](README.md). Changelog: [CHANGELOG.md](CHANGELOG.md).

## Why it exists

Handing a feature to a coding agent and eyeballing the result does not scale.
This plugin makes the hand-off explicit:

- **Task pack** — requirements, spec, four-dimension acceptance criteria
  (function / aesthetic / performance / accessibility), constraints, version.
- **Pre-review** — an adversarial pass before dispatch; a blocker must carry an
  attempted rebuttal and must be closed before dispatch.
- **Independent audit** — four sub-agents (one per dimension) gather evidence;
  `dwguard_audit` refuses a pass unless every must criterion is covered, all four
  dimensions are assessed, no blocker/major is open, and evidence files exist
  (copied into the bundle with SHA-256).
- **Rework and confirmation** — a failed gate writes a rework order; a passing
  one writes the acceptance report and waits for an explicit user decision.
- **Calibration** — the plugin records every gate verdict and every later
  "this passed but the user found a bug", so the miss rate is measurable.

## Install

Published on npm: [`dwguard-dsh-hmos`](https://www.npmjs.com/package/dwguard-dsh-hmos) (current 0.6.5).

The `desktop` profile is managed **exclusively by the desktop app** — the CLI
refuses `dsh plugin --profile desktop …`. Pick the path that matches how you run
DSH:

**Desktop app** — open **Plugins** in the left sidebar → **Add plugin** → enter
the package name `dwguard-dsh-hmos` (pin a version with `dwguard-dsh-hmos@0.6.5`)
→ install and choose the layer. *Install third-party plugin* in the same dialog
also takes a Git URL or a local directory. Restart DSH afterwards.

**CLI profiles** (`web` / `tui` / `headless` / custom) — `dsh plugin` forwards to
pnpm, so pnpm must be on `PATH`:

```powershell
dsh plugin --profile web add dwguard-dsh-hmos
dsh plugin --profile web add dwguard-dsh-hmos@0.6.5   # pin a version
# without a global dsh CLI:
npx @deepseek-ai/dsh@0.2.1-rc.5 plugin --profile web add dwguard-dsh-hmos
```

From GitHub or a local checkout (CLI profiles only):

```powershell
dsh plugin --profile web add .                                         # repo root
dsh plugin --profile web add https://github.com/Dogwind221/dwguard-dsh-hmos
```

Verify: `dsh --profile web --dump-config` should show `# == dwguard-dsh-hmos`.

Every **new** session then gets 15 tools, 3 skills and a policy prompt. Sessions
opened before the install keep their old tool table — open a new one.

## The `DshHoms` entry

A compact entry sits in the left sidebar between automation and plugins. It
opens a live board in the **right sidebar** without replacing the conversation:

- vertical flow, 规划 → 执行 → 验收, with parallel rows (coding beside the
  shadow reviewer, four audit sub-agent cards) and curved return edges;
- current stage spins, finished stages turn green, unstarted stages stay grey;
- history timeline under the map (prereview / dispatch / audit / rework / shadow
  / confirmation);
- **`中 / EN` toggle before refresh** (persisted, defaults to the host language);
  phase, next action and history switch together;
- `role="status"` announcements and reduced-motion support.

## Hybrid executor (0.3+, IDE-first)

`executor: auto` (default) keeps DevEco Code first. CLI only takes over when the
pack has **no visual `must` criterion** and the task is clearly batch /
regression / CI / refactor flavoured; a pack can pin `executor: ide | cli`.

In CLI mode, `tasks/cli-brief.md` gives an external CLI agent the
`devecocli build / run / run --apply / log` contract. DSH gathers build/log/device
evidence itself through **`dwguard_deveco`** (written to `artifacts/deveco-<n>/`);
`screenshot` / `layout` / `verify` call the real `devecocli ui` and
`devecocli verify` commands, `attach` registers an existing build log without
rebuilding, and `background: true` runs long builds detached (`jobs` / `stop`
manage them). A watchdog flags a dispatch with no ack/delivery after
`stallMinutes`, and `dwguard_status waitSeconds` long-polls for a delivery event.
Screenshots and the UI tree are still captured by DSH — the executor's
self-report never becomes a `pass`.

## Tools

| Tool | Purpose |
| --- | --- |
| `dwguard_spec` | Write / validate / read the task pack; criteria may carry a machine-checkable `assertion` (matcher + expected); scaffolds `.shared/` |
| `dwguard_prereview` | Record the adversarial pre-review (rebuttal required on blockers) |
| `dwguard_dispatch` | Generate the Goal-mode brief and the dispatch record (`cli-brief.md` in CLI mode) |
| `dwguard_scan` | Independent ArkTS/ArkUI static scan with stable rule IDs |
| `dwguard_deveco` | DevEco CLI evidence: `env / build / run / log / lint / device / uiHelp / ui / screenshot / layout / a11y / verify / attach / jobs / stop`; defaults to the pool's bar phone and serialises device actions via `.shared/.device-lock.json` |
| `dwguard_shadow` | Read-only shadow review during execution (incremental, optional UI tree) |
| `dwguard_rules` | Query the rule catalog (`list`/`get`) and the local official-docs corpus (`search`) |
| `dwguard_audit_dimension` | Record one dimension as its sub-agent returns |
| `dwguard_audit` | Four-dimension audit; checks carry `actual` for asserted criteria and `device` + `family` in matrix mode; a `profileRef` that is missing or `superseded` fails the gate; reports render the aesthetic-profile column and the baseline-diff section; evidence bundle; acceptance report or rework order |
| `dwguard_aesthetic` | Aesthetic learning (0.6.1) + cross-project templates (0.6.4): `profile`, `baseline`, `compare`, `learn`, `template` (list/get/export/import). Writes need `source` + `confidence`, changing an active value needs `confirmed: true`; `learn` only proposes unless `apply: true` **and** `confirmed: true`; `baseline save` needs a passing audit + user confirmation; `template import` needs `confirmed: true` (`merge` supersedes local conflicts) |
| `dwguard_design` | Design reference library (0.6.2–0.6.5): `library init/ingest/list`, `search` (filters + `image` + `imageText` CLIP text→image), `brief`, `feedback`, `capture`, `pack list/export/import`, `stats`. Lexical by default (offline); `hybrid` needs an embedding endpoint, `imageText` needs a multimodal endpoint; failures fall back (image) or fail clearly (text); `query.mjs` stays lexical; `capture`/`pack import` need `confirmed: true`; budgets hard-stop |
| `dwguard_calibration` | Gate accuracy ledger (`report` / `miss`) |
| `dwguard_confirm` | Record the user decision (`accept` / `new_round`) |
| `dwguard_knowledge` | Append durable lessons to `knowledge/<topic>.md` |
| `dwguard_status` | Derive the phase, unread deliveries, un-acked dispatches, next action; shows host memory, device mode, matrix gaps and the device lock |

`dwguard_aesthetic` closes the aesthetic loop: a preference is proposed from
confirmed user wording or project resource files, the user picks between
conflicting values, and only then is it written to
`knowledge/aesthetic-profile.md`. A passing audit plus a user confirmation let
you save a visual baseline; `compare` then turns the next layout dump into
numeric diffs (±2vp for spacing/radius, zero tolerance for font size and
colours) that appear in the acceptance report.

`dwguard_design` (0.6.2–0.6.4) turns "what should it look like" into a shared,
retrievable asset: `library init` writes `.shared/design-library/` and a
dependency-free read-only `query.mjs`; `library ingest` seeds cards from the
aesthetic rule catalog and `inbox/*.meta.json` (incl. `stylePriority`,
`antiPatterns` (`AP-*`), `checklist`, `dimensions`, and brand cards; images are
copied into `refs/` by sha256); `search` ranks with deterministic BM25 plus
token/tag/profile boosts, filters by `appType` / `platform` / `style` / `kind`,
optionally reranks with an embedding endpoint (cached vectors, explicit lexical
fallback) or searches by image (pHash + RGB histogram) or by text→image when a
CLIP endpoint is configured. `brief` writes `tasks/design-brief.md` and appends an `inspiration` outbox
record; brand cards (`source.kind: brand`) are force-injected into a
「品牌与业务约束」 section; a failed aesthetic audit writes
`rework-suggestions.json` and the next brief carries 「上一轮返工定向参考」.
Aesthetic criteria/checks may carry `designRefs` and `antiPatternRefs`; referencing
a DSG card **auto-inherits that card's antiPatterns** into the audit checklist
(reports mark `inherited from DSG-…`), and the audit gate rejects missing/blocked
refs. `feedback` adjusts weight or hides cards; `capture` (after a passing
audit + user confirmation) stores the baseline as a project card; `pack
export/import` moves active cards + images between projects (fresh ids,
semantic dedupe). Per-round budgets (`maxAuditRounds`, `maxDesignSearches`)
hard-stop and are shown by
`dwguard_status`. DSH uses the tool; DevEco runs
`node .shared/design-library/query.mjs "dark card spacing" --top 5 --json` on the
same index (parity-tested).

## Protocol (`.shared/`)

```text
.shared/
├─ state.json                 # counters, cursor, confirmations
├─ outbox-dsh.md              # DSH → DevEco
├─ outbox-deveco.md           # DevEco → DSH
├─ tasks/
│  ├─ spec.md / spec.json     # frozen task pack
│  ├─ goal-brief.md           # brief to paste into DevEco Goal mode
│  ├─ design-brief.md         # design reference brief (0.6.2; dispatch references it)
│  ├─ rework-<n>.md           # rework order
│  └─ question.md             # executor questions
├─ artifacts/
│  ├─ audit-<n>.md|json       # audit records
│  ├─ audit-<n>/              # evidence bundle: manifest.json + evidence/
│  ├─ scan-<n>.json           # static scan
│  ├─ shadow-<n>.json         # shadow review
│  ├─ confirmation-<n>.json   # user decision
│  ├─ visual-baseline/<specVersion>/  # bounds JSON + screenshots (sha256 each)
│  ├─ aesthetic/compare-latest.json   # latest baseline diff (referenced by the report)
│  └─ acceptance-report.md
├─ design-library/            # 0.6.2–0.6.4: design references
│  ├─ manifest.json           # cards (DSG-* / AP-*) + counts
│  ├─ chunks.jsonl            # section text + sha256
│  ├─ index.json              # BM25 postings/df (rebuildable cache)
│  ├─ query.mjs               # dependency-free read-only CLI (lexical only)
│  ├─ feedback.jsonl          # useful / off / block / unblock ledger
│  ├─ rework-suggestions.json # queries from the last failed aesthetic audit
│  ├─ embeddings.json         # hybrid rerank vectors (model + sha256 keyed)
│  ├─ image-features.json     # pHash / histogram cache for image search
│  ├─ clip-embeddings.json    # CLIP image/text vectors (0.6.5)
│  ├─ refs/                   # images named by sha256
│  └─ inbox/                  # user drops <name>.png + <name>.meta.json
└─ knowledge/
   ├─ index.json
   ├─ calibration.jsonl       # gate ledger
   ├─ aesthetic-profile.md    # aesthetic profile (table + JSON line)
   ├─ aesthetic-history.jsonl # append-only applied / superseded / conflict
   └─ <topic>.md
```

Outbox records are append-only and carry an envelope:

```markdown
## [2026-11-01T10:00:00+08:00] dispatch · #d-1 · from=dsh to=deveco | Round 1 brief
## [2026-11-01T10:20:00+08:00] deliver · #a-1 · from=deveco to=dsh · re=#d-1 | Delivery
```

`kind` ∈ `dispatch | ack | deliver | question | answer | blocked | shadow-risk | rework | inspiration | design-request`.
A delivery without `re=#d-N` is not an acknowledgement; `dwguard_status` lists
un-acked dispatches for the current round.

## Rules and official docs

The catalog (`src/rules.ts`) has 75 rules with stable IDs and, where possible, a
`citation` pointing at the official page/section (Huawei UX standards, OpenHarmony
guides, AGC rejection checklist). `dwguard_spec` rejects unknown `ruleId`s;
findings cite the same IDs.

`dwguard_rules search` greps a local corpus (Huawei design docs and a sparse clone
of openharmony/docs). Set `docsDir` in the plugin config or `DWG_DOCS_DIR`:

```bash
node scripts/fetch-official-docs.mjs E:/harmony-docs --index=ux-design --match=contrast,touch
git clone --depth 1 --filter=blob:none --sparse https://github.com/openharmony/docs.git
```

## Config

```yaml
- id: dwguard-hmos
  config:
    sharedDir: .shared
    promptSection: true
    installSkills: true
    minCriteriaPerDimension: 1
    requireRebuttalOnBlocker: true
    requirePrereviewBeforeDispatch: true
    knowledgeMaxEntriesPerTopic: 200
    docsDir: ''
    shadowIntervalMinutes: 10
    stallMinutes: 30
    executor: auto         # auto = IDE-first | ide | cli
    devecocliPath: ''      # empty = auto-detect (PATH / npm global)
    hostMemoryGb: 0        # 0 = auto-detect; >0 = override (CI/containers)
    deviceMode: auto       # auto (by host memory) | single | matrix
    matrixMinMemoryGb: 32  # < 32GB forces single-device; >= 32GB allows the matrix
    deviceMatrix: [phone, widefold, foldable, triplefold]
    matrixScope: {}        # families per dimension; empty = defaults (function/perf phone, aesthetic/a11y all)
    allowMissingMatrixFamilies: false
    devicePool: []         # { sn, family, apiLevel, kind: emulator|real }
    maxConcurrency: 0      # 0 = auto by host memory (32GB -> 2, 64GB -> 4)
    deviceLockTimeoutMs: 600000
    designTopK: 5          # default design search size
    designMaxChunks: 2000  # warn above this chunk count
    designRanker: lexical  # lexical (default) | hybrid (needs an embedding endpoint)
    designEmbeddingEndpoint: ""  # OpenAI-compatible /embeddings; empty = no network
    designEmbeddingModel: text-embedding-3-small
    designEmbeddingApiKeyEnv: DWG_DESIGN_EMBEDDING_KEY
    designEmbeddingTimeoutMs: 8000
    designEmbeddingWeight: 0.35
    designBriefCards: 5    # cards per tasks/design-brief.md
    designBrandCards: 3    # brand cards force-injected into every brief (0 = off)
    maxAuditRounds: 5      # hard cap on audits per round
    maxDesignSearches: 12  # hard cap on design searches per round
    aestheticTemplatesDir: ""  # empty = ~/.dsh/dwguard/aesthetic-templates
    designPacksDir: ""         # empty = ~/.dsh/dwguard/design-packs
    designClipEndpoint: ""     # CLIP/multimodal endpoint; empty = off
    designClipModel: clip-vit-base-patch32
    designClipApiKeyEnv: DWG_DESIGN_CLIP_KEY
    designClipTimeoutMs: 8000
    designClipWeight: 0.5      # semantic weight in image search (0–1)
    designLicenseRequired: true  # true = licence-unknown cards are excluded from search
```

**Device matrix (0.6.0)**: memory is auto-detected; `< 32GB` stays single-device
(16GB machines never start a matrix and get a warning if one is configured);
`>= 32GB` enables the Huawei screen-family matrix (phone / widefold / foldable /
triplefold). In matrix mode every `dwguard_audit` check must carry `device` +
`family`, and the gate refuses a missing family unless
`allowMissingMatrixFamilies: true` explicitly waives it.

## Boundaries

- DSH never edits application code; changes become findings, rework orders or a
  new task pack.
- The gate is hard: no "pass with open issues" switch.
- DSH may run build/run/log through `dwguard_deveco` as **evidence**, but never
  edits `entry/`, `AppScope/`, `hvigor/` or `build-profile.json5`; visual proof
  (screenshots, UI tree) is captured by DSH itself.
- State is derived from artifacts, not from tool claims.

## Development

```bash
npm install       # typescript, @types/node, @deepseek-ai/dsh-tools, @deepseek-ai/schemastery
npm run typecheck
npm run build
npm test          # 127 tests (scripts/preflight.mjs checks the host test deps first)
node scripts/release.mjs --bump=patch --dry-run
```

`lib/` is committed build output, so installing from a clone does not require a
build. Rebuild it before committing source changes, and never keep `node_modules`
inside a linked install (it would shadow the host's `@deepseek-ai/dsh-tools`).

Releases publish from CI: `git tag vX.Y.Z && git push origin vX.Y.Z` runs
`publish.yml`, which authenticates with **npm trusted publishing (OIDC)** and
attaches a provenance statement — no `NPM_TOKEN` secret involved.

## License

MIT
