# Content Portability CP-4A — Safe Published-Dungeon Updates

Status: complete, uncommitted on `Delve` for review. CP-4B (dungeon ZIP/artwork
bundles) was not started.

## 1. Starting repository state

- Branch `Delve`, HEAD `753dcde4` ("Add integration tests for Shared Pool
  Encounter and Equipment Portability").
- Worktree held the uncommitted CP-3 enemy-package work (17 modified and 10
  untracked paths: migration 0075, `enemyPackage*`, `artworkAssets/package/`,
  enemy import Portal page, nginx/router/client changes, tests and the CP-3
  report). None of those files were edited by CP-4A.

## 2. Confirmed pre-existing behaviour

The audit (`docs/content-portability-audit.md` §7, lines 237–244) was verified
against the branch:

| Finding | Confirmed at |
| --- | --- |
| v2/v3/v4 replacement wrote `enabled: false, publishedRevisionId: null` | `dungeonImportService.ts` replace branch (`...(pkg.schemaVersion !== 1 ? { enabled: false, publishedRevisionId: null } : {})`) |
| v1 replacement preserved both | same branch (spread skipped for v1) |
| Plan forced `replace` for any enabled or published v2+ target, even with an identical draft | pseudo fields `'enabled'` / `'publication'` appended to `target.changedFields` |
| Clearing the pointer withdrew dungeon-owned species terms from active runs | `publishedDungeonSpeciesPolicies` inner-joins `publishedRevisionId`; no pointer means no entries, read at every offer (`dungeonRunService.ts:792`) and grant (`:1100`) |
| New imports created disabled, unpublished | create branch, `enabled: false`, no pointer |
| Portal warned "This import also disables the dungeon and clears its current publication" (v2+ only) | `DungeonImportPanel.tsx` |

Runtime paths were checked for reads of the mutable draft. Run start
(`content.published` / `openDungeons`), run reload (`revisionById`), the species
policy reader and publication all use the published pointer or the run's pinned
revision. The draft readers (`dungeonRewardTableReferences`,
`dungeonLootTableService` usage, `sharedPoolService.references`,
`readDungeonContentDocuments`) are admin where-used lookups. No runtime path
needed correcting.

## 3. Exact lifecycle changes

All in `src/modules/dungeons/package/dungeonImportService.ts`:

1. The replace branch no longer writes `enabled` or `publishedRevisionId` for
   any package version. It writes only `draft`, `layout`, `draftHash`,
   `draftRevision`, `updatedAt` and `updatedBy`.
2. `target.changedFields` compares only the draft and the editor layout. An
   identical draft is now `identical` and needs the `unchanged` decision. Before,
   an enabled or published v2+ target always had to be replaced.
3. Plan `target` gains `enabled` (boolean, or null for a new target) and
   `publishedRevision` (the live revision number, or null).
4. The apply result and the `imported` audit event record `enabled` and
   `publishedRevision`. Both are optional on the result schema, so receipts
   recorded before CP-4A still replay.

Create semantics are unchanged: new imports are disabled and unpublished.

## 4. Draft/publication state before and after import

| Target before import | Before CP-4A (v2–v4) | After CP-4A (v1–v4) |
| --- | --- | --- |
| Does not exist | created disabled, unpublished | unchanged: created disabled, unpublished |
| Published rN, enabled | disabled, unpublished | draft replaced; **rN live, enabled** |
| Published rN, disabled | disabled, unpublished | draft replaced; **rN kept, still disabled** |
| Unpublished, enabled or disabled | disabled, unpublished | draft replaced; unpublished, enabled flag kept |
| Identical draft, live | forced `replace` and unpublished | `unchanged`, no writes |

Before CP-4A, v1 already behaved like the right-hand column. Importing never
publishes. Publishing still needs the post-import `draftRevision` and
revalidates the draft against current destination dependencies.

## 5. Active-run preservation

Import has never written `dungeon_revisions` or `dungeon_runs`. That still
holds, and the integration tests compare both tables row for row across
imports. Since the published pointer now stays, new runs keep starting on the
live revision until a publish. Runs that were already active keep their pinned
revision, enemy and reward snapshots, equipment pins, progression, flags,
encounter states and frozen shared-pool bodies. This is checked after an
import, after a restart (`restartedRuns`) and after the next publish.

## 6. Dungeon-exclusive acquisition policy

No policy code changed. `publishedDungeonSpeciesPolicies` keeps reading the
published revision, so:

- an import leaves the published `speciesPolicies` exactly as they were;
- a draft that loosens a limit, allows Direct Rescue or adds a species grants
  nothing until it is published;
- the ledger is not touched by import, and the published finite limit, not the
  draft's, stops the next acquisition;
- a run started before the import can still acquire the species under the
  published terms. Before CP-4A this failed, because the reader returned no
  entries.

Ledger scope (per player, species and dungeon) and Direct Rescue rules are
unchanged. The scope question in issue #0144 is still open.

## 7. Shared-pool compatibility

Import does not write `dungeon_species_pools` or their events. The new test
checks both tables, and a run's frozen `dependency_snapshot`, across an import
that references a pool. Missing pool keys are still reported as errors by the
existing dependency validation (`sharedPoolKey` path, unpublishable). The plan
hash still pins the referenced pool bodies. Pool membership still grants no
acquisition permission.

## 8. Import preview and concurrency changes

**Portal** (`DungeonImportPanel.tsx`, `dungeonImportModel.ts`,
`api/dungeonImportTypes.ts`):

- The review shows **Current state: Enabled/Disabled · Published revision N /
  Unpublished** for an existing target.
- A "Publication after import" list (`draftLifecycleNotes`) states:
  - which revision stays live for players, active runs and acquisition terms;
  - that the enabled or disabled state is kept, and that new runs keep using
    revision N until publish;
  - that publishing is a separate action that revalidates the draft;
  - for incomplete drafts, that the draft cannot be published until repaired
    and that the live revision is unaffected meanwhile.
- The outdated warning "This import also disables the dungeon and clears its
  current publication" is removed. The event and encounter sections no longer
  claim every import creates a disabled draft, and the encounter section says
  draft species terms grant nothing until published.
- The success message reports which published revision is still live and the
  enabled state.

**Concurrency.** The plan hash already included `publishedRevisionId` and
`enabled`, so no new freshness check was needed. A publish, rollback, enable
or disable between preview and apply returns `DUNGEON_IMPORT_STALE` with no
writes. Tests cover a rollback, which changes only the pointer and leaves the
draft revision unchanged. Draft edits are still caught by `expectedRevision`.
Locks, transaction boundaries, receipts, retry replay, explicit decisions and
audit history are unchanged.

## 9. Files modified by CP-4A

Backend
- `src/modules/dungeons/package/dungeonImportService.ts`

Portal
- `portal/src/api/dungeonImportTypes.ts`
- `portal/src/features/adminDungeons/dungeonImportModel.ts`
- `portal/src/features/adminDungeons/DungeonImportPanel.tsx`
- `portal/src/features/adminDungeons/__tests__/DungeonImport.test.tsx`, `DungeonImportV2.test.tsx`, `DungeonImportV3.test.tsx`, `DungeonImportV4.test.tsx`
- `portal/playwright/dungeonImport.spec.ts`, `portal/playwright/dungeonImportV4.spec.ts` (fixture fields only)

Tests
- new `tests/integration/dungeonImportLifecycle.test.ts`
- `tests/integration/dungeonImportV2.test.ts`, `dungeonPackageV3.test.ts`, `dungeonPackageV4.test.ts`, `api/adminDungeons.test.ts` (old-lifecycle assertions rewritten)

Docs
- `docs/dungeons.md`, `docs/dungeons/dungeon-authoring-reference.md`, `docs/dungeons/dungeon-events-guide.md`, `docs/dungeons/dungeon-rewards-guide.md`
- this report

Historical completion and readiness reports (phase2/3/4, scene sprites, the
audit) still describe the earlier behaviour as it was at the time. They were
left as records.

## 10. Tests and results

The integration tests ran against a disposable podman Postgres 16, which has
since been removed.

New `dungeonImportLifecycle.test.ts`: **11/11**, three consecutive runs.

| Scenario | Coverage |
| --- | --- |
| A | live r1 + active run → import r2 → r1 still open for existing/new runs, draft visible to admins only, stale publish refused, explicit publish → new runs r2, older runs keep r1 (incl. after restart) |
| B | dungeon-exclusive `gym_oni` limit 1; ledger unchanged by import; pre-import run captures after import; draft limit 5/Direct Rescue/extra species not live; limit 1 enforced; publish makes draft terms live |
| C | disabled published target stays disabled, revision kept, not in `openDungeons`, run start refused |
| D | unpublished target stays unpublished, no revisions created |
| E/G | missing species + new loot table: refused apply rolls back completely (loot table too); approved repair draft leaves the live revision and runs alone; publish refuses with no writes |
| F | v1/v2/v3/v4: new import disabled/unpublished; replacement keeps live revision; draft equals package exactly (hash match), historical revision unchanged |
| G | rollback ×2, disable, enable and draft edit between preview and apply → `DUNGEON_IMPORT_STALE`, no writes; exact retry replays the identical receipt with no writes; audit records preserved state |
| Shared pools | pool rows/events and run snapshot unchanged; missing pool key reported |

**Mutation check.** With the old destructive write temporarily restored, 8 of
the 11 new tests failed: A, B, C, E/G, F v2–v4 and shared pools. The three that
still passed are F v1 (v1 always preserved state), D (nothing to unpublish) and
G (staleness). The file was then restored.

**Focused regression.** 51 files, 1053 tests: imports v1–v4, rewards
lifecycle, admin dungeon API, owned species access, shared pools, content,
runs, reward snapshots, captures lifecycle, live encounters, the Portal
contract test and `tests/unit/dungeons`. Result: 1050 passed, 1 skipped, 2
failed. Both failures are baselines (below).

`tests/unit/api`: 592/595; the 3 failures are baselines.

**Portal.** `src/features/adminDungeons` + `src/api`: **388/388** (45 files).
The import component tests are 43/43. `tsc --noEmit` exits 0.

**Builds.**
- Backend `tsc --noEmit` and `npm run build` both exit 0.
- Portal `npm run build` refuses by design because a local `portal/.env`
  exists. The same Vite production build was run through its API with an empty
  `envDir` into the scratchpad, and it succeeded. `portal/.env` was not touched.

**Baseline failures.** Each was reproduced identically on an isolated
untouched-HEAD `753dcde4` worktree:
- `tests/unit/dungeons/engineArchitecture.test.ts` (#0025): the same four
  offenders, with byte-identical assertion output.
- `tests/integration/dungeonContent.test.ts` "stores the expected dungeon
  foundation…": the expected table list predates migration 0074 and lacks
  `dungeon_species_pools` and `dungeon_species_pool_events`.
- `tests/unit/api/errors.test.ts` reflection sweep and `tests/unit/api/routes.test.ts` ×2: 3 failed / 109 passed on both HEAD and the worktree.

**Not run.** The Playwright specs (only their fixture types changed, and they
typecheck), and the full root suite, since nothing outside the import path
changed.

## 11. Remaining limitations

- Ordinary managed artwork is still referenced by logical asset id, not
  immutable bytes. Replacing a shared asset can still change how a live or
  active run looks. This is unchanged and is CP-4B territory.
- The species policy stays live by design: a later **publish** that tightens
  terms reaches active runs at their next offer or grant. Only import no longer
  has that effect.
- An import whose draft is identical is now `unchanged`. Operators who relied
  on a re-import to take a dungeon offline must now disable it explicitly.
- The scope of the per-dungeon acquisition ledger (#0144) is unchanged and
  still needs product sign-off.
- Scene Sprite placements still block package export and import.

## 12. Migration and deployment requirements

- No database migration. No schema change. No new API routes.
- The plan and result responses gain additive fields: `target.enabled`,
  `target.publishedRevision`, and optional `enabled`/`publishedRevision` on the
  result.
- Deploy the backend and the Portal together. An older Portal ignores the new
  fields but would still show the outdated warning text. A newer Portal
  against an older backend would show every existing target as
  "Disabled · Unpublished", which understates what that older backend's
  replacement does.
