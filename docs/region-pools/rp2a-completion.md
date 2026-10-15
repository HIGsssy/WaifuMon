# RP2A completion: Region Pool database ownership and hunting parity

Status: **implemented, uncommitted, not deployed.** Nothing was applied to staging or
production. No admin APIs, Portal screens, RP2B or RP3 work were started.

Design: [rp1-architecture.md](rp1-architecture.md). Critical findings C1–C5 and
decisions D1–D10 were approved and followed. No implementation blocker was found,
and exact parity was achieved.

## 1. Branch, HEAD and working tree

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `90456c4e3f48ff04433c85ef00a35a1d9f72c7da` (unchanged; nothing committed) |
| Starting state | Clean apart from the untracked `docs/region-pools/` (RP1) |
| Final state | 13 tracked files modified and 8 new files (§10). All work is uncommitted |

## 2. Migration 0069 schema and constraints

[`drizzle/0069_region_pools.sql`](../../drizzle/0069_region_pools.sql) is journal
index 69, hand-written in the style of 0059 and 0068. The matching Drizzle tables are
in [`src/db/schema.ts`](../../src/db/schema.ts), next to `regionEncounterPools`.

| Table | Key constraints |
| --- | --- |
| `region_pools` | PK `region_id`; CHECK region in the six canonical ids; `draft_revision >= 1`; `draft_hash ~ '^sha256:[a-f0-9]{64}$'`; `draft_entries` is a JSON array; FK `published_revision_id` → `region_pool_revisions.id` |
| `region_pool_revisions` | Identity PK; FK `region_id` → `region_pools`; unique `(region_id, number)`; `number >= 1`; hash format; `source in ('bootstrap','editor','rollback','import')`; self-FK `rolled_back_from`; `species_manifest` is a JSON array |
| `region_pool_revision_entries` | PK `(revision_id, species_id)`; unique `(revision_id, position)`; FK revision and FK species; `0 < weight <= 1000000`; `position >= 0` |
| `region_pool_events` | Identity PK; action CHECK (the 8 RP1 actions); index `(region_id, id desc)`; no region FK, so the trail outlives everything |
| Immutability | One function, `region_pool_revisions_immutable()`, with `BEFORE UPDATE OR DELETE` triggers on revisions **and** on revision entries. It raises `restrict_violation` |

The migration is schema only. It does not read, delete, truncate or alter
`region_encounter_pools`. This was verified by comparing physical tuple ids
(`ctid`) before and after migrating a populated pre-0069 database (§9).

## 3. Seeder changes

[`seedContent`](../../src/modules/content/seeder.ts) no longer deletes or inserts
pool rows. The `DELETE FROM region_encounter_pools` and the per-region insert loop
are gone, and so is `SeedSummary.regionPoolEntries`. Items and species are seeded
exactly as before.

An integration test runs `seedContent` with content whose region pools are all
emptied. Every Region Pool table and the projection come through unchanged.

## 4. Bootstrap and projection

[`src/modules/regionPools/regionPoolStore.ts`](../../src/modules/regionPools/regionPoolStore.ts)
provides `syncRegionPools(db, content, logger)`. It runs as one transaction under
`pg_advisory_xact_lock(hashtextextended('region_pools', 0))`.

1. **Bootstrap (insert-missing).** Each region in the content set with a canonical
   id and **no `region_pools` row** is resolved by `resolveShippedRegionPool`, which
   applies the seeder's exact semantics:
   - slugs with no `species` row are skipped;
   - `weight ?? max(1, perSpeciesWeight)`;
   - the file's order is kept.

   It then writes the draft (`draft_revision` 1), revision 1 (`source='bootstrap'`,
   with a species manifest), the entries in authored `position` order, the
   published pointer, and a `bootstrapped` event. The event details include the
   shipped baseline (hash, resolved entries, skipped slugs), whether the region is
   enabled, and a diff against the projection rows that existed beforehand
   (`previousProjection.identical`).
2. **Existing regions are never written.** If the shipped file's hash differs from
   the published revision, the function logs `region-pools/shipped-drift` and
   records one `drift_detected` event per (published revision, shipped hash) pair.
   The file is never applied.
3. **Projection.** For each of the six `REGIONS`:
   - The target is the published revision when the region file is `enabled`, and
     empty otherwise. Disabled regions and regions with no file get no rows.
   - If the current rows already equal the target as a `slug → weight` map, the
     region is left untouched, so a repeated start writes nothing and keeps heap
     order.
   - Otherwise it deletes the region's rows and inserts the revision's entries in
     `position` order, as one multi-row insert like the seeder's, and records a
     `projection_rebuilt` event with the diff.
4. **Coverage** (§6) is read from the projection inside the same transaction.

Region pools are bootstrapped even when the region is disabled (D4), and no pool
enable switch was added (D1).

## 5. Startup and Reload Content

[`reloadService.ts`](../../src/modules/content/reloadService.ts) now exports
`applyContent(db, content, logger)`, which runs `seedContent` and then
`syncRegionPools`. `createContentReloader` uses it.

Both startup ([`index.ts:209`](../../src/index.ts#L209)) and the legacy admin
panel's Reload Content ([`index.ts:1220`](../../src/index.ts#L1220)) already go
through that reloader. Neither call site changed, and the order is now:

1. migrations
2. load and validate content
3. seed items and species
4. bootstrap missing pools
5. project
6. construct services

`ReloadResult` gains `regionPools`. The legacy panel's response text is unchanged.

A published pool survives each of these cases:

| Case | Evidence |
| --- | --- |
| Application restart | Integration test, plus the end-to-end run (§9) |
| Repeated startup | Integration test (table fingerprints identical), plus the end-to-end run (event count 7 → 7) |
| Legacy Reload Content | Integration test using the real `createContentReloader` against the real `content/` |
| Shipped JSON drift | Integration test: the region file is edited, the projection stays the same, one drift event is recorded, and a repeat records none |

## 6. World Encounter planner and coverage reporting (C4)

- **Planner.** `encounterImportService.targetState` builds `regionPools` from the
  database projection with `projectedRegionPoolSlugs`. Its keys are still the
  content's enabled regions; its sets are the projected slugs. `encounterPackage`
  selector logic, probabilities and effects are unchanged. An integration test
  shows `selector_region_no_candidates` appears only after a published revision
  removes the region's last LR, even though the region file still lists one.
- **Coverage.** The loader's file-based `warnOnUnpooledSpecies` was removed.
  `reportCoverage` now runs after projection:
  - `regions/unpooled-species` (same tag) lists enabled species that are not
    dungeon-exclusive and appear in no projected pool. The wording now says
    "no hunt can draw them while every rarity is covered" instead of
    "UNOBTAINABLE" (RP1 S2).
  - A new `region-pools/empty-tier` warning names each released region and rarity
    with no huntable species.

  Both are warnings only. Dungeon-exclusive species are no longer listed as
  unpooled, because they are never pooled by design. That only affects the log;
  no shipped species carries the tag.

## 7. Fixture migration and regression results (C5)

| File | Change |
| --- | --- |
| [`tests/helpers/fixtures.ts`](../../tests/helpers/fixtures.ts) | `bootstrapApp` calls `applyContent`, the production lifecycle, instead of `seedContent` |
| `base80085`, `thirstlands`, `flaccidFoothills`, `assteroidBelt` | Their "every pool gone" cases restore with `applyContent` (re-projecting the published pools) instead of `seedContent` |
| `dexCompletion` | Its pack enable/disable reloads use `applyContent` ("exactly what enabling a pack and reloading content does") |
| [`tests/helpers/testDb.ts`](../../tests/helpers/testDb.ts) | Optional `migrationsFolder`, so a test can stop at 0068 |
| `migrateSeed`, `seductivePower`, `multiTagSpecies` | Unchanged. They exercise `seedContent` itself or species rows only, or delete pools deliberately |
| [`tests/helpers/regionPoolFixtures.ts`](../../tests/helpers/regionPoolFixtures.ts) (new) | Frozen copy of the pre-0069 seeder pool logic; `canonicalProjection`; `projectRegionPoolsFromContent` (isolated: rebuilds only the projection from a test's own content, and the next sync restores the published state); `publishRegionPoolRevisionForTest` (an RP2B stand-in that writes an immutable revision and moves the pointer) |

No assertion was removed or weakened. Production bootstrap semantics were not
changed to suit fixtures.

## 8. Before/after Region Pool set comparison

The canonical set is `(region_id, species_slug, weight)`, explicitly sorted.

| Check | Result |
| --- | --- |
| Clean database: new projection vs the frozen pre-0069 seeder (integration test) | Equal, 280 rows |
| Populated legacy database: snapshot after old-seeder rows, vs after migrating 0069 and syncing (integration test) | Equal; physical tuples unchanged; zero `projection_rebuilt` events; all six `previousProjection.identical = true` |
| **End to end with real code:** startup of the **untouched HEAD release** into a database, then startup of the **RP2A tree** into the same database, compared with [`rp2a-parity.sql`](rp2a-parity.sql) | Query A byte-identical (280 rows). Query B (projection vs published revision) has 0 rows. Query C shows all six regions `identical = true` with no skipped slugs. Query D per-rarity totals match the RP1 §1.1 table exactly |
| Disabled region (`base-80085` off) | Equal to the frozen seeder for the same content (it also skipped disabled regions) |
| Disabled species and unknown slug | Equal to the frozen seeder: the disabled species is kept (the hunt filters it), and the unknown slug is skipped and recorded |

**Distribution parity through the real draw.** 12,000 seeded
`pickSpeciesForSpawn` draws each for Twin Peeks at level 1 and Waifu Valley at
level 40 (the N→R shift) were compared with the analytic rarity-first odds by
Pearson chi-square. The requirement was p > 0.001, and both pass. A deliberately
wrong odds model (flat within each rarity) **fails** the Twin Peeks case, so the
test can detect the problem. Waifu Valley's weights are all 1, so the wrong model
coincides with the right one there.

`huntService`, `speciesSelection`, the spawner, `captureService`, and the dungeon
and content directories have **no diff**. No `ORDER BY` was added (D9).

Reproducing this on a real environment: [`rp2a-parity.sql`](rp2a-parity.sql) gives
the steps (run before and after the deploy, then diff the `A` lines).

## 9. Repeat-start and rollback evidence

All of the following was run against disposable Postgres 16 with the real
`content/` directory:

| Step | Observed |
| --- | --- |
| A projection row tampered with, then restart | Query B flagged one row (`twin-peeks … 7 vs 6`). After restart, Query B returned 0 rows and Query A was identical again. One `projection_rebuilt` event |
| Two further restarts | Event count 7 → 7. Nothing was written |
| Simulated admin publish (twin-peeks revision 2, first entry dropped), then restart | Projection has 39 rows. Query B returns 0 rows. Shipped drift is logged |
| **Code rollback:** untouched HEAD release started against the migrated database | The old seeder rebuilt twin-peeks from JSON (40 rows). The 7 revisions were kept and the new tables were ignored, as RP1 §5.4 expected |
| Redeploy the RP2A tree | Projection back to revision 2 (39 rows). Query B returns 0 rows |
| Injected projection failure on the last region (integration test) | The whole sync rolled back: no pools, revisions, events or projection rows. It succeeded after the fault was removed |
| Four concurrent `syncRegionPools` calls on a fresh database (integration test) | Exactly 6 pools, 6 revisions, 6 `bootstrapped` and 6 `projection_rebuilt` events. No errors. Projection equals the frozen seeder |
| UPDATE or DELETE on revisions or entries (integration test) | Each is rejected with `… rows are immutable` |

## 10. Files changed

Modified:

- `drizzle/meta/_journal.json`
- `src/db/schema.ts`
- `src/modules/content/loader.ts`
- `src/modules/content/reloadService.ts`
- `src/modules/content/seeder.ts`
- `src/modules/worldEncounters/encounterImportService.ts`
- `tests/helpers/fixtures.ts`
- `tests/helpers/testDb.ts`
- `tests/integration/assteroidBelt.test.ts`
- `tests/integration/base80085.test.ts`
- `tests/integration/dexCompletion.test.ts`
- `tests/integration/flaccidFoothills.test.ts`
- `tests/integration/thirstlands.test.ts`

New:

- `drizzle/0069_region_pools.sql`
- `src/modules/regionPools/regionPoolStore.ts`
- `tests/helpers/regionPoolFixtures.ts`
- `tests/integration/regionPools.test.ts` (19 cases)
- `tests/unit/regionPools/regionPoolBoundary.test.ts` (3 cases)
- `docs/region-pools/rp2a-parity.sql`
- `docs/region-pools/rp2a-completion.md` (this file)
- `docs/region-pools/rp1-architecture.md` (from RP1)

Unchanged: region JSON, species content, hunting and selection code, dungeon code,
the Portal, and API routes.

## 11. Exact test results

All runs used disposable podman `postgres:16-alpine` with `TEST_DATABASE_URL`.

| Run | Result |
| --- | --- |
| `tests/integration/regionPools.test.ts` | **19/19 pass** |
| `tests/unit/regionPools/regionPoolBoundary.test.ts` | **3/3 pass** |
| Full root suite, **untouched HEAD** (detached worktree) | 8635 tests: 8517 passed, **117 failed in 30 files** |
| Full root suite, **RP2A tree** | 8657 tests: 8536 passed, 1 skipped, **120 failed in 31 files** |
| Focused areas within the RP2A full run (70 files: hunt, regions and expansions, travel, seeding and migration, content loader, World Encounters, selectors and spawn, Buddy, dungeon encounters and captures, region pools) | 1269 passed, 24 failed. All 24 are baseline failures: `buddyBonus` 22, `migrateSeed` "migrates a fresh database…" 1, `travel` regional shop 1 |
| `npm run typecheck` (`tsc --noEmit`, src and tests) | exit 0 |
| `git diff --check` and a trailing-whitespace scan of the new files | clean |

**Failure diff, full RP2A run vs baseline:** none fixed; three appeared:

- `bossScheduler` "suspends with an actionable message…" and "does not reroll…
  across a restart": this is the known timing flake. Three repeated runs per tree
  failed 6/6/7 on RP2A and 7/6/6 on untouched HEAD, with a different set of cases
  each time.
- `questRewardPreview` "shows every Essence reward adjusted…": passed twice in
  isolation on the RP2A tree. It is a load-dependent flake in the full run. It
  doesn't touch pools.

**Baseline failures** (present at untouched HEAD, unchanged by RP2A):
`affectionGifts`, `appearance`, `bossEncounters`, `bossScheduler`, `buddy`,
`buddyAffinity`, `buddyBonus`, `captureAppearanceUnlock`, `care`,
`careEphemeralSweep`, `consumables`, `daily`, `equipmentBaseCatalogue`,
`giftAndCaptureUi`, `migrateSeed`, `progression`, `seductivePowerMigration`,
`shop`, `travel`, unit `bossContent`, `bossPresenter`, `bossRewards`,
`bossShuffleBag`, `equipmentWorkshopConfig`, api `adminEnemies`,
`appearanceEndpoints`, `equipmentWorkshopPortal`, unit api `errors`, `routes`,
and `dungeons/engineArchitecture`.

The Portal suite was not run, because no Portal file changed.

## 12. Risks and RP2B handoff

**Risks**

- **Code rollback reverts published edits** while the old release runs (verified
  in §9). They come back on redeploy. Release notes must say so (RP1 §5.4).
- **Bootstrap freezes the JSON of the release that ships 0069.** If that release
  also edits a region file, the edit is bootstrapped and recorded in
  `previousProjection.diff`, not lost. However, the parity check (Query A) would
  then show the difference. Keep region JSON frozen in that release (D7).
- **Run the pre-deploy snapshot on each real environment.** Query A before
  deploying confirms nobody hand-edited `region_encounter_pools` since the last
  restart; such an edit would have been wiped by the old seeder anyway.
- **The species table is still content-owned.** Rarity, enabled state and tag
  changes can empty tiers or create exclusive conflicts without any pool edit.
  RP2A logs empty tiers. Manifest-based species drift and cross-region exclusive
  checks belong to RP2B.
- **The advisory lock serialises syncs.** That only happens at startup and reload;
  hunts never take it.
- **`region_encounter_pools` CHECK and `REGIONS`** still need a migration for any
  new region. That is unchanged.

**RP2B handoff**

- Write paths must go through a service that, in one transaction under the same
  advisory lock: validates (RP1 §8.1–8.2), inserts revision N+1 with entries and a
  manifest, moves `published_revision_id`, re-projects **that region** (the
  `projectRegion` logic can be exported), and records `published` or `rolled_back`.
- Optimistic locking uses `region_pools.draft_revision`. The draft is already
  populated at bootstrap.
- `publishRegionPoolRevisionForTest` shows the row shapes. Replace its callers
  with the real service in RP2B tests.
- Drift detection uses `region_pool_revisions.species_manifest` (already written)
  and `drift_detected` events with `details.kind`. `shipped` is used today; add
  kinds for species drift.
- The probability analyser, admin routes, `regions.*` permissions, and the "Load
  shipped pool into draft" action are not started.
