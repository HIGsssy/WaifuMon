# Phase 4C2B completion — dungeon Wild Encounter and Rescue authoring

## Workspace

Implemented on `Delve`, HEAD `a0a4aa1ec9df09b01043f97f2b3bf366c6eb9d85`.
The starting working tree was clean. All changes remain uncommitted. No branch
switch, commit, push, merge, deployment, new migration, central species/content
edit, Region Pool administration or package v4 work was performed.

Integration tests use a disposable local PostgreSQL container and the existing
test setup/schema only; no application/staging/production database was targeted.
Project memory was recorded with MCP write tools.

## Files changed

31 task files, including this report:

| File | Change |
| --- | --- |
| `portal/src/api/adminDungeons.ts` | Encounter fields, read-only preview/capture-item/status clients and sandbox DTOs |
| `portal/src/features/adminDungeons/EncounterActivity.tsx` | Species/pool source, capture/direct-rescue rules, results/flags and placement |
| `portal/src/features/adminDungeons/EncounterPreview.tsx` | Production presenter data and compositor image, per-pool species/state switching and stale-response guards |
| `portal/src/features/adminDungeons/SpeciesDependencyStatus.tsx` | Current and historical active-run species health |
| `portal/src/features/adminDungeons/ActivityCard.tsx` | Normal editable encounter activity cards and existing outcome routing |
| `portal/src/features/adminDungeons/RoomInspector.tsx` | Wild Encounter and Rescue creation buttons |
| `portal/src/features/adminDungeons/dungeonActionModel.ts` | Schema-shaped defaults and encounter outcomes |
| `portal/src/features/adminDungeons/DungeonSpeciesPicker.tsx` | Reuse P4C2A picker for activity selection |
| `portal/src/features/adminDungeons/SpeciesPoolSheet.tsx` | Reuse server-computed odds presentation |
| `portal/src/features/adminDungeons/DungeonSandboxDialog.tsx` | Simulated inventory, rolls, rescues, limits, availability, conditions, grants and resulting flags |
| `portal/src/features/adminDungeons/dungeonText.ts` | Incomplete settings and friendly checklist/Show me activity targets |
| `portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx` | Published species dependency panel |
| `portal/src/features/adminDungeons/dungeonPublicationModel.ts` | Species drift/evidence status and publication explanation |
| `src/modules/dungeons/dungeonEncounterAuthoring.ts` | Read-only policy facts, production capture math, request-local inventory/grant accounting and attempt-only forced RNG |
| `src/modules/dungeons/dungeonSpeciesManifest.ts` | Informational publication evidence and live drift comparison |
| `src/modules/dungeons/dungeonContentService.ts` | Catalogue reads, atomic publication evidence and species status |
| `src/modules/dungeons/dungeonSpeciesPolicy.ts` | Optional artwork availability callback for authoring validation |
| `src/modules/dungeons/validation/dungeonEncounterValidation.ts` | Missing sprite-and-standard-artwork fallback warning |
| `src/modules/dungeons/validation/dungeonValidation.ts` | Additive artwork warning code |
| `src/modules/dungeons/engine/sandbox.ts` | Request-local fact refresh, injected RNG and optional initial condition facts |
| `src/discord/dungeonEncounterPreview.ts` | Production presenter adapter over simulated engine views |
| `src/discord/dungeonArtwork.ts` | Narrow input/context types so the authoring route can call the production renderer; rendering body unchanged |
| `src/api/routes/v1/admin/dungeons.ts` | Read-only routes, sandbox inputs and facts, scene-preview adapter and dependency DTOs |
| `tests/integration/api/adminDungeons.test.ts` | Real API, permissions, persistence, policy, presenter, pixel composition, database isolation and publication drift |
| `tests/unit/dungeons/dungeonEncounterAuthoring.test.ts` | Formula/RNG equivalence, inventory/XP/limit simulation and manifest behavior |
| `portal/src/features/adminDungeons/__tests__/EncounterAuthoring.test.tsx` | New authoring, sandbox, stale-preview and dependency-status coverage |
| `portal/src/features/adminDungeons/__tests__/DungeonEncounters.test.tsx` | Update old read-only expectations; preserve existing save/reload coverage |
| `portal/src/features/adminDungeons/__tests__/dungeonActionModel.test.ts` | Include two newly supported activities in identity coverage |
| `portal/src/features/adminDungeons/__tests__/dungeonFixtures.tsx` | Shared read-only authoring mocks |
| `portal/playwright/dungeonEncounterAuthoring.spec.ts` | Six flows on desktop and mobile using production validator, engine, authoring facts and presenter |
| `docs/dungeons/phase4c2b-completion.md` | This report |

## Wild Encounter authoring

Wild Encounter is available in every normal room activity menu. It uses existing
activity IDs, ordering, deep duplication, removal, draft save and reload. No
frontend-only encounter format or second authoring framework was introduced.

Select a specific WaifuMon through the P4C2A picker, or reference an existing
species pool. Selection shows thumbnail, rarity/race/affinity, enabled state,
regional/dungeon exclusivity, current-dungeon permission, acquisition limit and
direct-rescue authorization. Restricted/disabled candidates stay visible;
existing missing/restricted selections are preserved for repair.

Pools remain definitions in `speciesPools`, with references in activities. The
activity shows entry count, server-calculated probabilities, Nothing probability,
availability annotations and an Edit selected pool link. Missing pool IDs stay
in the draft until replaced.

Rules include intro text, 1–3 capture attempts, all globally eligible charms or
an authored subset, and guaranteed-item permission. Missing/disabled authored
charms remain visible for removal. Every resolved capture attempt consumes a
charm, including failure; that is stated beside the controls. Authors cannot
set capture probabilities or override live player inventory.

## Rescue authoring

Capture rescue uses the same capture rules with rescue narrative/presentation.
Direct rescue is clearly labeled a direct grant and hides capture-attempt and
charm controls. Switching to direct mode removes the incompatible capture
member; other authored result/route data survives and offers explicit repair
controls when it no longer applies.

Per-species authorization and finite acquisition limits are read-only. An
unauthorized species can remain in a structurally readable repair draft; the
existing backend blocks publishing it. Counts are per player, per dungeon,
across runs, rather than total collection size. No rescue restriction was
bypassed or changed.

## Conditions, routing and result flags

The existing condition editor handles run flags, completed rooms and nested
all/any/not combinations. Existing forward destination controls handle captured
or rescued, escaped where applicable, left, Nothing and unavailable. Retreat is
not offered. Stored incompatible routes/results are kept and can be removed.

Each outcome supports authored text and up to four declared run-flag writes,
including false writes. Later activities/paths can use the resulting flags.
Backend validation remains authoritative for missing species/pools, policy,
items, attempt limits, conditions, flags, routes and reachability. New local
completion checks honor backend defaults and label explicit unfinished settings.

Show me opens the affected activity, or the referenced pool/species entry. Missing
artwork fallbacks generate a warning and link to the activity; text-only
production fallback remains valid.

## Artwork and sprite placement

Existing `PlacementControls` edit anchor, scale and bounded offsets. Horizontal
mirroring is stored on the encounter. The encountered species is a scene actor;
no combat enemy definition or combat mechanic is involved.

The read-only scene-preview extension calls `dungeonRunSceneArtwork` and
`speciesArtwork` directly, using existing loading, containment, compositor,
cache and MIME conventions. Offered/failure scenes render background,
background environmental sprites, stand-in pinned Buddy, encountered WaifuMon
and foreground sprites. Both room and activity sprite scopes participate.
Pool authors can switch the species preview. Terminal escape/leave/Nothing/
unavailable scenes remove the actor. Missing sprites use production standard
artwork, then room/background/text fallback.

Real image tests check placement, mirror pixels, both sprite scopes and the exact
standard-art fallback; existing production artwork tests also pass.

## Discord preview

`POST /admin/dungeons/encounter-preview`, gated by `dungeons.read`, validates the
request, builds a request-local engine/sandbox view and calls `buildRunScreen`.
React displays the returned embed fields, charm-menu options and button labels;
it does not invent encounter copy or compute odds.

Offered Wild/Capture Rescue/Direct Rescue, success, failed attempt, escape,
leave, Nothing and unavailable states are supported. Authored narrative/results
are preserved. Attempts display the production chance/spend/XP wording through
in-memory presentation receipts. Pool species selection and simulated context
are clearly labeled. An impossible guaranteed-only failure preview is refused;
a one-attempt failed-but-still-offered preview explicitly assumes an extra attempt.

No run, collection or inventory record is written. Routing is exercised in the
full sandbox; individual preview states isolate the chosen activity's presentation.

## Sandbox capabilities and isolation

The existing endpoint replays the actual dungeon engine. New inputs are
`select_item`, `capture`, `rescue`, `leave_encounter` and `dismiss_encounter`.
The existing P4B1 effects port only records `capture_attempt` and `rescue_grant`.

Authors can simulate charm quantities, choose charms, attempt capture with
normal deterministic rolls or forced success/failure, directly rescue, seed
flags/completed rooms, disable species and set cross-run acquisition counts.
Guaranteed items still succeed under forced failure. Simulated spends/grants
refresh subsequent facts, so repeated attempts cannot reuse an exhausted charm
and later encounters see simulated acquisitions. Initial facts are seeded by a
sandbox-only bootstrap room; production run initialization is unchanged.

The UI shows species/availability reasons, quotes and modifiers, attempt rolls,
would-consume charms, simulated copies/XP, encounter results, resulting flags and
the actual next activity/room/routes. All grants are labeled simulated.

The integration isolation test fingerprints every public database table,
including row `xmin`, before and after successful/failed/deterministic captures,
a direct rescue and a production preview. Row contents, versions and counts
match. Live inventory, collection, XP, quests, runs, acquisition ledger and
authoring records remain unchanged. The authoring adapter calls no live capture,
grant or progression operation.

## Species dependencies and publication

A small versioned manifest is added to the existing transactional `published`
audit event, keyed by revision ID. It records referenced species rarity,
enabled/exclusivity policy and current-dungeon authorization/limits. This is the
smallest addition supported without a migration or a new revision architecture.
Unused pools are not publication dependencies.

The read-only `species-status` endpoint reports the current publication and
historical revisions with active runs, separating recorded drift, unknown older
evidence and current live acquisition restrictions. Management shows those
states separately from draft validation. `speciesDiffer` reaches the existing
publication badge/confirmation; republishing changed/missing evidence writes a
new revision with the same definition hash when appropriate. Existing optional
`sceneSpritesDiffer` is also now retained by the summary serializer.

Old publications without evidence report unknown; no historical policy is
fabricated or backfilled. No immutable revision or active run is modified.
The manifest is informational: live policy still controls acquisition.

## Legacy compatibility and P4D boundary

No definition schema/hash format, capture formula, species selection, acquisition
policy, ownership/grant transaction, combat/reward system or content catalogue
was changed. Legacy engine/hash/package compatibility tests pass. Existing Event
Pool and species-pool authoring regressions pass. Older revision content and
pinned active runs retain their existing behavior.

Encounter/species-pool package gates remain until P4D/v4. Sprite-bearing packages
retain their separate portability gate. No incomplete package is emitted; the
existing backend export/import checks remain authoritative.

## Verification

Final results and exact commands are recorded below. All database commands target
only the disposable local test server.

| Check | Result |
| --- | --- |
| Root `npm run typecheck` | Pass |
| Portal `npm run typecheck` | Pass |
| Backend `npx vitest run tests/unit/dungeons tests/integration/dungeonContent.test.ts tests/integration/dungeonEncountersLive.test.ts tests/integration/dungeonEncountersDiscord.test.ts tests/integration/api/adminDungeons.test.ts --maxWorkers=2 --minWorkers=1` | 33 files, 794 tests: **792 passed, 1 baseline failure, 1 existing skip** |
| Final backend `npx vitest run tests/unit/dungeons/dungeonEncounterAuthoring.test.ts tests/integration/api/adminDungeons.test.ts` | **80/80 passed**: 7 adapter tests, 73 API tests |
| Portal `npx vitest run src/features/adminDungeons src/features/adminDungeonLoot --maxWorkers=2 --minWorkers=1` | **35 files, 343/343 passed** |
| Browser `npx playwright test playwright/dungeonEncounterAuthoring.spec.ts playwright/dungeonSpeciesPools.spec.ts playwright/dungeonEvents.spec.ts --workers=2` | **32 passed, 4 existing mobile skips**; new encounter flows 12/12 |
| Final browser `npx playwright test playwright/dungeonEncounterAuthoring.spec.ts --workers=2` | **12/12 passed** |
| `git diff --check` | Pass |
| `podman build -f portal/Dockerfile -t localhost/waifumon-portal-p4c2b .` | **Pass**, image `a8789409b5955bdd25ff49ad4267fce35f676e0087313dec3aa6c47a00bbb52c` |

The backend failure is existing **#0025**, the architecture check's four
importer/enemyStore I/O/database imports. A separate read-only archive of untouched
HEAD reproduces exactly those four violations. The skip is the existing optional
artwork case. No unrelated architecture fix was made.

Initial feature typing/fixture/selector issues were corrected and logged. A
late local completion check initially overblocked two old pool fixtures; the
check was corrected to honor backend defaults and preserve repair drafts.

## Limitations and handoff

- Preview/sandbox capture quotes use a clearly labeled simulated Buddy with zero
  affinity, active-effect and Buddy Bonus modifiers. They do not quote any real
  player's equipment, inventory or collection. SP still controls existing
  combat/Event tests. XP follows configured capture/new-dex values for this
  neutral simulated context; level-up rewards are not materialized.
- Successful image previews use production repaint/standard artwork. The
  first-acquisition owned-copy card and duplicate conversion need a real owned
  copy, which read-only authoring deliberately never creates. Text, result,
  spend and XP presentation use the production presenter.
- Older publication evidence is unknown until republishing. Status is shown in
  dungeon Management and the loaded editor's publication badge; no new Region
  or global species administration page is introduced.
- Initial flags/completed rooms and availability/limit controls replay the
  simulated run from its seed. They never mutate a saved or live run.
- Package v4/species portability and the separate Scene Sprite portability
  manifest remain P4D work. No P4D implementation was started.

Stop at P4C2B; changes are left uncommitted for review.
