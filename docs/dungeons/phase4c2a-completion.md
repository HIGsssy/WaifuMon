# Phase 4C2A completion — dungeon WaifuMon pool authoring

Implemented on `Delve`, starting and ending at HEAD
`869964c8f3bfbd772facdcb7323ea5450adbd814`. The starting working tree was clean.
All changes remain uncommitted. No commits, pushes, merges, deployment, central
species/content edits, Region Pool changes, runtime changes or application
migrations were performed. Backend tests used only a disposable PostgreSQL
container and the existing test database setup.

## Files changed

19 task files, including this report:

| File | Change |
| --- | --- |
| `src/modules/dungeons/engine/speciesAuthoring.ts` | New pure authoring adapter around runtime selection analysis and shared availability policy |
| `src/modules/dungeons/dungeonContentService.ts` | Read-only live species catalogue method |
| `src/api/routes/v1/admin/dungeons.ts` | Catalogue/artwork GET routes and additive validation preview contracts |
| `portal/src/api/dungeonSpeciesTypes.ts` | Wire-only catalogue, scenario and probability types |
| `portal/src/api/adminDungeons.ts` | Actual species/Nothing pool union, catalogue/artwork clients and optional insight contracts |
| `portal/src/features/adminDungeons/dungeonSpeciesModel.ts` | Stable IDs, pure pool edits, duplication, usage/deletion guards and incomplete fields |
| `portal/src/features/adminDungeons/DungeonSpeciesPoolsPanel.tsx` | Dungeon settings panel and management controls |
| `portal/src/features/adminDungeons/DungeonSpeciesPicker.tsx` | Search/filter selector, thumbnails and policy information |
| `portal/src/features/adminDungeons/SpeciesPoolSheet.tsx` | Entry editing and server probability/scenario presentation |
| `portal/src/features/adminDungeons/useSpeciesInsight.ts` | Debounced preview with abort and response identity guard |
| `portal/src/features/adminDungeons/DungeonGraphView.tsx` | Existing sheet host integration and request-error repair navigation |
| `portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx` | Settings integration and pool links from backend publication errors |
| `portal/src/features/adminDungeons/dungeonText.ts` | Friendly pool checklist issues and stable entry focus targets |
| `tests/unit/dungeons/speciesAuthoring.test.ts` | Runtime analysis equivalence, availability, rarity and compatibility tests |
| `tests/integration/api/adminDungeons.test.ts` | Real catalogue permissions, artwork bytes/ETag, odds, persistence and publication tests |
| `portal/src/features/adminDungeons/__tests__/dungeonSpeciesModel.test.ts` | Independent copies, identity preservation, deletion and checklist tests |
| `portal/src/features/adminDungeons/__tests__/DungeonSpeciesPools.test.tsx` | Editor, filtering, rules, policy, persistence, request errors and stale preview tests |
| `portal/playwright/dungeonSpeciesPools.spec.ts` | Five browser flows on desktop and mobile using production analysis/validation |
| `docs/dungeons/phase4c2a-completion.md` | Completion report and P4C2B handoff |

Project memory was updated through MCP tools, without direct `.projectmem/` edits.

## Pool management

WaifuMon Pools sits beside the existing Events panel in dungeon settings. Authors
can create, rename, duplicate and delete pools, inspect every referencing room
and encounter activity, and edit multiple independent pools. Both the UI and the
pure edit function refuse deletion while a Wild Encounter or Rescue references
the pool. Event pools with the same ID are unrelated.

New pools receive `sp_` plus 32 hex IDs; entries receive `se_` plus 32 hex IDs.
Renaming, entry edits and saving retain identity. Copies receive a new pool ID;
entry IDs remain local to each independent copied pool, following Event Pools.
Limits follow P4B1: 30 pools, 50 entries per pool, integer weights 1–1,000,000.

A new pool starts unfinished, with no automatically chosen species. The checklist
explains how to finish it. Entries support removal, species replacement, weights,
once-per-run, existing nested dungeon conditions, and Nothing with optional text.
Duplicate species are indicated and existing backend validation blocks publication.

## Species selection and availability

The picker searches names/slugs and filters rarity, race, affinity and availability.
Every result shows its name, lazy artwork thumbnail, rarity, race, affinity,
enabled state, both exclusivity indicators and whether it is permitted here.
Disabled/restricted species remain visible with reasons and cannot be added;
already-listed species cannot be added twice. Existing unavailable or unknown
entries stay visible and can be replaced or removed.

The sheet displays configured dungeon access, the current dungeon's limit, and
separate direct-rescue authorization. A finite limit is explicitly labeled
**per player, in this dungeon, across runs**; it is an acquisition-ledger count,
not global ownership. Missing capture limits display unlimited by default;
explicit `unlimited` is distinguished. Direct rescue requires authorization and
an explicit finite limit, as judged by the existing backend policy function.
Central policy is read-only.

Existing `ArtworkThumbnail`, condition editing, authenticated API helpers,
Radix sheets, workspace hosting, draft save and publication workflows are reused.
Gallery and World Encounter catalogue permissions/contracts lack dungeon policy,
so their entire selectors are not imported. Race uses the shared backend resolver.

Small compatible API additions, all guarded by `dungeons.read`:

- `GET /api/v1/admin/dungeons/species?dungeonKey=…`: live catalogue with
  server-resolved policy and current-dungeon limits; no player data and no writes.
- `GET /api/v1/admin/dungeons/species/artwork?slug=…&width=256`: default artwork
  through the existing appearance resolver, containment, rendition and ETag
  sender. The caller cannot supply a file path. Missing artwork gets a placeholder.

## Probability insight

`POST /api/v1/admin/dungeons/validate` accepts optional `speciesScenario`:
`{ flags, completedRooms, seenSpecies, acquisitions }`. Acquisition counts are
simulated copies acquired from the current dungeon across runs, never real
player data. Existing `eventScenario` and Event Pool responses retain their meaning.

The additive `speciesPools` response contains each pool's `base` and `scenario`.
Base strips conditions and assumes nothing encountered/acquired. Scenario uses the
authored conditions, seen species and simulated counts. The pure adapter calls
`analyseSpeciesPool`, the same function the runtime selection uses. React only
formats returned numbers; it calculates neither probabilities nor eligibility.

Shown: every entry's weight, eligible/excluded state and reason, selection
probability, total eligible weight, Nothing probability, unavailable-outcome
probability, effective selection rarity distribution, and obtainable rarity
shares of all draws. If nothing is eligible, Nothing is 100%.

Disabled, missing, restricted or acquisition-limited species **keep their selection
weight**. They are annotated as unavailable outcomes instead of being removed or
increasing another species' probability. Conditions and once-per-run are the
actual draw exclusions. These are selection odds, not charm capture success odds.

Preview requests have their own debounce, abort and identity guard. An older
answer disappears as soon as the draft/scenario changes. Preview answers never
replace publication validation or the page's checklist. Simulation controls are
available to readers and never persist with the dungeon.

## Persistence and publication compatibility

The Portal now uses P4B1's species/Nothing entry union directly. No alternative
pool structure, backend definition schema, hash function or persistence format
was introduced. Empty optional text/conditions are removed; removing the final
pool removes `speciesPools` itself. Encounter-free drafts gain no empty pool list.

Save/reload preserves pool and entry IDs, conditions, weights, Nothing text,
once-per-run, existing encounters and Event Pools. Missing references can remain
in a readable repair draft, following backend semantics. Blank names/species,
empty entry lists and invalid weights block saving with friendly, focused issues.
All-Nothing pools remain readable but existing backend validation blocks publishing.

Publishing and rollback continue to use existing live catalogue/policy validation;
reachable restricted species block publication. Pool policy failures point to the
pool entry through Show me, including failures returned after pressing Publish.
Unused pools receive the existing warning; their species are not new publication
dependencies. Existing legacy hash/package golden tests pass. Active-run freezing
and encounter runtime behavior were not changed.

P4C1's `encounterActor`, `latestEncounters`, receipt and mirror additions were
checked against the implemented contracts. Pool insight depends on selection
analysis rather than Discord view/receipt data, so no P4C1 preview adapter change
is required in this pass.

## Verification

Backend commands ran with `TEST_DATABASE_URL` pointing exclusively to disposable
PostgreSQL, then the container was removed. Exact final results:

| Check | Result |
| --- | --- |
| Root `npm run typecheck` | Pass |
| Portal `npm run typecheck` | Pass |
| `npx vitest run tests/unit/dungeons tests/integration/dungeonContent.test.ts tests/integration/dungeonEncountersLive.test.ts tests/integration/api/adminDungeons.test.ts` | 31 files; **744 passed, 1 baseline failure, 1 existing skip**, 746 total |
| Final focused `npx vitest run tests/unit/dungeons/speciesAuthoring.test.ts tests/integration/api/adminDungeons.test.ts` | **61/61 passed**: pure authoring 5, API 56 |
| Portal `npx vitest run src/features/adminDungeons src/features/adminDungeonLoot --maxWorkers=2 --minWorkers=1` | **34 files, 331/331 passed** |
| Portal `npx playwright test playwright/dungeonSpeciesPools.spec.ts playwright/dungeonEvents.spec.ts --workers=2` | **20 passed, 4 existing mobile skips, 0 failures**; new pool flows **10/10** |
| `git diff --check` | Pass |
| `podman build -f portal/Dockerfile -t localhost/waifumon-portal-p4c2a .` | Production Portal build, environment guard and bundle verification pass |

Production image: `a6e6051025e9749870dc10ed4dbbdee770c232057ab910ce089cbe9d0ef8e179`.

The backend failure is existing issue **#0025**:
`tests/unit/dungeons/engineArchitecture.test.ts` reports four importer/enemyStore
I/O/database import violations. A read-only archive of untouched HEAD reproduces
exactly the same failure (1 passed, 1 failed in that file). No unrelated fix was
made. The skip is the existing optional artwork case in `dungeonSceneArtwork`.

An initial heavily concurrent Portal run timed out one unchanged Event authoring
test at its 5-second limit. It passes in the bounded final run; untouched HEAD's
Event authoring suite also passes 29/29. A final container-build attempt raced
Playwright's temporary `test-results` directory and was rerun after Playwright
finished. Initial feature typing/test-selector errors were corrected and are
recorded in project memory.

## Limitations and P4C2B handoff

- This pass authors pools only. Wild Encounter/Rescue activity cards remain
  read-only; authors cannot attach a newly created pool through an activity editor
  until P4C2B. Existing activity references are fully supported.
- Pool simulation covers flags, completed rooms, seen species and acquisition
  counts. It does not simulate charm capture chances, attempts, ownership or XP.
  Encounter sandbox controls and Discord/scene previews belong to P4C2B.
- Availability is a current catalogue read. A later content change may invalidate
  a saved pool; publication revalidates and live encounters retain existing policy
  checks. No central policy editor or new `speciesDiffer` revision manifest/drift
  UI was added.
- The catalogue endpoint returns the small current species catalogue, with search
  and metadata filters in the picker. It does not expose regional pool editing.
- Existing encounter/species-pool package export gates remain until package v4.
  No package v4 or migration was added. The full unrelated backend suite was not
  rerun; relevant dungeon/API/runtime regressions were run as listed above.

P4C2B can reuse `DungeonSpeciesPicker`, `SpeciesAvailability`, `SpeciesThumb`,
`speciesPoolUsage`, the sheet host's `speciesPool` target, and `useSpeciesInsight`.
Add activity source/rules/placement/result authoring, pool attachment/open links,
encounter previews and sandbox controls through the existing editor. Keep direct
rescue authorization separate from ordinary capture availability and retain
current unavailable-draw and scoped acquisition-limit semantics. Stop here at
P4C2A; the changes are left for review without committing.
