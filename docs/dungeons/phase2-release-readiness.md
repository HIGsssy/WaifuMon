# Dungeon Rewards Phase 2 release readiness

Assessment date: 2026-10-12. **Recommendation: Ready for staging testing.**
No new release-blocking defect was found in the inspected implementation or
executed checks. This is not production approval: deployed Discord behaviour,
real catalogue health and rollout/ingress checks remain outstanding below.

## Checkout and scope

Verified branch `Delve`, HEAD `a5c3bd62e67e922eefc0af89876a5189fafbe628`.
A1–A3 and T1–T15 are at HEAD. T16/T17 arrived as 20 uncommitted paths
(10 modified, 10 untracked); all were preserved. T18 adds only documentation
and one integration test. No application code, rates, migrations or global
equipment rules changed during T18. No subagents, commits, resets, pushes,
merges, deployments or staging/production database operations were used.

Read the original Phase 2 audit and design, including implemented T6 hash and
publication-insertion notes. Traced actual source from Portal forms/API DTOs
through catalogue/validation/publication, engine resolution, transactional live
grants, Discord receipts, health, and package preview/apply. Historical audit
findings describe pre-implementation code; they are not proof of current defects.

## Implementation coverage

| Task | Inspected implementation | Executed evidence |
| --- | --- | --- |
| A1 | Legacy missing item throws inside the step transaction | dungeonRuns failure/repair/retry |
| A2 | Dungeon draft/revision reference source guards legacy expedition tables | rewardTables draft, historical revision, disable and deletion tests |
| A3 | Legacy transitive item/cap/selector checks at publish/rollback | dungeonContent and dungeonRewardValidation |
| T1 | Optional bundle/abandon fields; strict reward schemas and bounds | dungeonRewards, legacy hash/package golden fixtures |
| T2 | Named streams, stable drop IDs, exact analyser, weighted Nothing | lootResolver fixed vectors, independence and statistical comparisons |
| T3 | Dedicated catalogue, optimistic revisions, archive/delete/history | dungeonLootTables incl. real migration constraints |
| T4 | Dungeon permissions, routes and frontend DTO contracts | adminDungeonLootTables, adminDungeons, contract tests |
| T5 | Transitive references and worst-case work validation | unit/integration dungeonRewardValidation; legacy issue fixtures |
| T6 | Verified embedded snapshots, gameplay hash, dependency-only publication/rollback | dungeonRewardSnapshot(s), publication race/immutability tests |
| T7 | Additive per-drop seeded instance generation, existing keys replay | equipmentSeededRewards unit/integration; live fault-injection retries |
| T8 | Copy-targeted affection, reservation, pinned bonuses | dungeonBuddyRewards concurrency/reservation; collection regressions |
| T9 | Shared final-wave/Treasure claim routine, two at-risk currencies | dungeonEngine, dungeonEngineRewards, legacy fixed-seed golden |
| T10 | Ordered secured grants, receipts and independent currency settlement in locked step | dungeonLiveRewards all stages/outcomes/concurrency; lifecycle |
| T11 | Committed receipts, pinned affection recipient, per-currency ends, step-bound abandon | dungeonPresenter, dungeonRewardDiscord, dungeonDiscord |
| T12 | Read-only Test Roll/sandbox uses the same resolver | dungeonRewardPreview 35 API cases, unsaved overrides/read-only/seed/simulation |
| T13 | Loot list/editor, item/gear pickers, odds, stale edit review | adminDungeonLoot components/client; dungeonLoot browser |
| T14 | Combat/Boss/Treasure reward forms, timing, tables and friendly issues | ActivityRewards and authoring browser |
| T15 | Risk settings, publication badges, legacy conversion, current/historical active health | conversion unit/API, Portal risk/health, browser |
| T16 | Strict v2 envelopes, pinned export, body/hash/manifests, v1 golden | dungeonPackage v1/v2 unit; dungeonPackageV2 integration |
| T17 | Explicit conflicts/remapping, target eligibility, locked stale plans, atomic apply/receipt | dungeonLootImport, dungeonImport v1/v2, API/Portal/import browser |
| T18 | Current system docs, creator guide, integrated verification and this assessment | dungeonRewardsLifecycle, broader regressions and fresh production Docker build |

All lifecycle requirements have automated evidence. Portal browser checks use
controlled API fixtures (loot fixtures invoke real pure reward modules), not a
fully deployed backend. PostgreSQL integration tests call real services and API
injection against disposable databases. Actual Discord gateway delivery and
external ingress are manual staging checks.

## Integrated lifecycle and portability

`tests/integration/dungeonRewardsLifecycle.test.ts` creates two distinct,
fully migrated PostgreSQL databases. It publishes a two-wave Boss on the source,
exports its published v2 package, changes a source table, and verifies a second
published export still carries the original body/snapshot and valid hashes.
On the target the same import reviews missing, identical, differing-copy and
differing-use-existing tables in one plan. Copy rewrites references without
altering the old target table; use-existing discloses its different body.

The resulting draft is disabled/unpublished and publishable with valid target
dependencies. Publishing it pins imported/reused bodies. After the first wave,
there are no rewards. Editing target loot and publishing revision 2 leaves the
active revision-1 run pinned and healthy. A forced final affection-grant failure
rolls back run state/claims/history, wallet, inventory, equipment and affection.
Retry commits exactly the plan independently calculated from the old snapshot
with the same seed, including actual inventory/gear/affection/Essence balances.

Target use-existing raises that table's guaranteed WaifuBux from 11 to 99;
the total is explicitly verified as **612 WaifuBux and 45 Shards** at risk.
Secured loot matches the pinned resolver. A stale same-step replay pays nothing;
extraction banks 612 and 45 once, retains secured rewards, and rejects a second
settlement. Rolling the publication pointer back to revision 1 restores its own
snapshot despite the changed catalogue.

Additional real PostgreSQL tests cover each secured-grant failure stage, seeded
gear rollback/retry, same-step races, simultaneous settlements, repeated combat
through retreat/re-entry/restart, final-wave eligibility, Buddy swaps, release
reservation, completion/defeat/abandon rounding, existing wallet preservation and
skipped Shard banking with independent WaifuBux. Package tests cover v1 bytes,
v2 manifests/hashes, tampered/missing/extra bodies, archived/deleted live tables,
missing/disabled/capped target items, empty/changed gear eligibility, copy
collisions, stale previews, concurrent imports and catalogue insertion locks.
Forced final import-audit failure leaves no enemies/tables/draft/history/receipt.
Exact import retry returns the original receipt after later edits.

Reward Health API tests verify broken current publications and older revisions
with active runs, missing/capped items, missing gear and invalid/unsupported
snapshots. Edits/archives of live loot do not create false broken-publication
reports. Health uses a read-only repeatable-read transaction, no player identity,
and a constant query count as run/revision counts increase. Unused historical
revisions and live stat/affix generation integrity are not certified by health.

## Commands and exact results

Every backend run used a newly started local PostgreSQL 16 Alpine container
`waifumon-t18-pg`, bound to loopback port 55418. The test helper created and
migrated separate random databases per file/world and dropped them afterwards.
Only this disposable container was used and removed at completion. No shared
staging/production connection or credentials were used.

Backend main command, prefixed with the disposable `TEST_DATABASE_URL`:

```sh
npx vitest run tests/unit/dungeons tests/unit/api/dungeonLootPortalContract.test.ts tests/unit/api/dungeonImportPortalContract.test.ts tests/unit/equipmentRewardSelector.test.ts tests/unit/worldEncounters/affectionEffect.test.ts tests/integration/dungeon*.test.ts tests/integration/api/adminDungeons.test.ts tests/integration/api/adminDungeonLootTables.test.ts tests/integration/api/dungeonRewardPreview.test.ts tests/integration/api/dungeonTreasureConversion.test.ts tests/integration/equipmentRewards.test.ts tests/integration/collection.test.ts tests/integration/buddyAffectionItem.test.ts tests/integration/affectionGifts.test.ts tests/integration/buddy.test.ts tests/integration/buddyBonus.test.ts tests/integration/rewardTables.test.ts --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=/tmp/waifumon-t18-backend.json
```

Main: **45 files, 1,076 passed / 26 failed / 1 skipped (1,103 tests)**.

Additional backend command with the same disposable connection:

```sh
npx vitest run tests/unit/equipmentSeededRewards.test.ts tests/unit/equipmentRoll.test.ts tests/unit/equipmentCombatBonuses.test.ts tests/unit/migrationJournal.test.ts tests/unit/bossRewards.test.ts tests/unit/expeditionRewards.test.ts tests/integration/equipmentSeededRewards.test.ts tests/integration/equipmentRolls.test.ts tests/integration/equipmentService.test.ts tests/integration/equipmentAtomicity.test.ts tests/integration/progressionCurrency.test.ts tests/integration/worldEncounterAffection.test.ts tests/integration/worldEncounterEquipment.test.ts tests/integration/expeditionEquipmentRewards.test.ts tests/integration/bossRewardSnapshot.test.ts --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=/tmp/waifumon-t18-adjacent.json
```

Adjacent: **15 files, 381 passed / 2 failed / 0 skipped (383 tests)**.
Lifecycle: `npx vitest run tests/integration/dungeonRewardsLifecycle.test.ts`,
**1 passed / 0 failed / 0 skipped**, rerun after direct balance assertions passed.
Backend unique total: **61 files, 1,458 passed / 28 failed / 1 skipped**.
All 28 failures are independently reproduced HEAD baselines below.

Portal:

```sh
npm --prefix portal run test -- src/features/adminDungeons/__tests__ src/features/adminDungeonLoot/__tests__ src/api/__tests__/adminDungeons.test.ts src/api/__tests__/adminDungeonLootTables.test.ts src/__tests__/architecture.test.ts --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=/tmp/waifumon-t18-portal.json
```

**27 files, 255 passed / 1 failed / 0 skipped (256 tests)**. The failure is the
independently reproduced Portal architecture baseline.

From `portal/`:

```sh
npx playwright test dungeonAuthoring.spec.ts dungeonLoot.spec.ts dungeonImport.spec.ts --workers=2 --reporter=json
```

**24 passed / 0 failed / 10 skipped / 0 flaky** across desktop/mobile.
The 10 mobile skips are explicitly desktop-only authoring tests (9 authoring,
1 loot creation); mobile import, risk, health and overflow/layout cases ran.
Backend's one skip is optional shipped-art sample rendering, gated by
`DUNGEON_SHOTS` and art availability; all 11 synthetic artwork assertions passed.

| Build/check | Result |
| --- | --- |
| `npm run typecheck` | Pass, rerun after final test changes |
| `npm --prefix portal run typecheck` | Pass |
| Fresh `podman build --no-cache -f portal/Dockerfile -t localhost/waifumon-portal-t18 .` from repository root | Pass; new Node 22 build and Nginx runtime stages |
| Production `npm run build` inside that fresh Docker build | Pass: build-env guard, TypeScript and Vite production compilation |
| `npm run verify:bundle` inside that build | Pass: 144 files checked, no dev-only code |
| `git diff --check` | Pass |
| Migration journal tests | 9 passed; complete SQL coverage, continuous indices, increasing timestamps |

The Docker image is `33e00d1dbc527bdf4d7a18318fa84b7389d6ffe24d363a84ba981fa1daf0e493`.
The production verification did not read or edit the developer's local Portal
env file; the Docker context excludes env files and the build removes them.
Local `/tmp/waifumon-t18-*.json` and `.log` files contain machine results/build
output and are ephemeral evidence, not required source artifacts. Counts above
exclude reruns and independent baseline comparisons.

### Per-file backend results

Paths below are relative to `tests/`; P/F/S means passed/failed/skipped.

| Suite | P | F | S |
| --- | ---: | ---: | ---: |
| `unit/equipmentRewardSelector.test.ts` | 37 | 0 | 0 |
| `integration/affectionGifts.test.ts` | 35 | 2 | 0 |
| `integration/buddy.test.ts` | 17 | 1 | 0 |
| `integration/buddyAffectionItem.test.ts` | 26 | 0 | 0 |
| `integration/buddyBonus.test.ts` | 6 | 22 | 0 |
| `integration/collection.test.ts` | 28 | 0 | 0 |
| `integration/dungeonArtworkReplacement.test.ts` | 7 | 0 | 0 |
| `integration/dungeonBuddyRewards.test.ts` | 26 | 0 | 0 |
| `integration/dungeonContent.test.ts` | 39 | 0 | 0 |
| `integration/dungeonDiscord.test.ts` | 24 | 0 | 0 |
| `integration/dungeonImport.test.ts` | 16 | 0 | 0 |
| `integration/dungeonImportV2.test.ts` | 22 | 0 | 0 |
| `integration/dungeonLiveRewards.test.ts` | 45 | 0 | 0 |
| `integration/dungeonLootTables.test.ts` | 33 | 0 | 0 |
| `integration/dungeonMigration.test.ts` | 7 | 0 | 0 |
| `integration/dungeonPackageV2.test.ts` | 8 | 0 | 0 |
| `integration/dungeonRewardDiscord.test.ts` | 13 | 0 | 0 |
| `integration/dungeonRewardSnapshots.test.ts` | 19 | 0 | 0 |
| `integration/dungeonRewardValidation.test.ts` | 7 | 0 | 0 |
| `integration/dungeonRuns.test.ts` | 25 | 0 | 0 |
| `integration/equipmentRewards.test.ts` | 26 | 0 | 0 |
| `integration/rewardTables.test.ts` | 36 | 0 | 0 |
| `unit/api/dungeonImportPortalContract.test.ts` | 1 | 0 | 0 |
| `unit/api/dungeonLootPortalContract.test.ts` | 2 | 0 | 0 |
| `unit/dungeons/dungeonEngine.test.ts` | 34 | 0 | 0 |
| `unit/dungeons/dungeonEngineRewards.test.ts` | 42 | 0 | 0 |
| `unit/dungeons/dungeonImport.test.ts` | 5 | 0 | 0 |
| `unit/dungeons/dungeonLootImport.test.ts` | 9 | 0 | 0 |
| `unit/dungeons/dungeonPackage.test.ts` | 28 | 0 | 0 |
| `unit/dungeons/dungeonPackageV2.test.ts` | 33 | 0 | 0 |
| `unit/dungeons/dungeonPresenter.test.ts` | 25 | 0 | 0 |
| `unit/dungeons/dungeonRewardBonuses.test.ts` | 4 | 0 | 0 |
| `unit/dungeons/dungeonRewardSnapshot.test.ts` | 20 | 0 | 0 |
| `unit/dungeons/dungeonRewardValidation.test.ts` | 27 | 0 | 0 |
| `unit/dungeons/dungeonRewards.test.ts` | 94 | 0 | 0 |
| `unit/dungeons/dungeonSceneArtwork.test.ts` | 11 | 0 | 1 |
| `unit/dungeons/dungeonTreasureConversion.test.ts` | 17 | 0 | 0 |
| `unit/dungeons/dungeonValidation.test.ts` | 26 | 0 | 0 |
| `unit/dungeons/engineArchitecture.test.ts` | 1 | 1 | 0 |
| `unit/dungeons/lootResolver.test.ts` | 41 | 0 | 0 |
| `unit/worldEncounters/affectionEffect.test.ts` | 17 | 0 | 0 |
| `integration/api/adminDungeonLootTables.test.ts` | 34 | 0 | 0 |
| `integration/api/adminDungeons.test.ts` | 50 | 0 | 0 |
| `integration/api/dungeonRewardPreview.test.ts` | 35 | 0 | 0 |
| `integration/api/dungeonTreasureConversion.test.ts` | 18 | 0 | 0 |
| `unit/bossRewards.test.ts` | 47 | 2 | 0 |
| `unit/equipmentCombatBonuses.test.ts` | 68 | 0 | 0 |
| `unit/equipmentRoll.test.ts` | 41 | 0 | 0 |
| `unit/equipmentSeededRewards.test.ts` | 5 | 0 | 0 |
| `unit/expeditionRewards.test.ts` | 25 | 0 | 0 |
| `unit/migrationJournal.test.ts` | 9 | 0 | 0 |
| `integration/bossRewardSnapshot.test.ts` | 9 | 0 | 0 |
| `integration/equipmentAtomicity.test.ts` | 5 | 0 | 0 |
| `integration/equipmentRolls.test.ts` | 41 | 0 | 0 |
| `integration/equipmentSeededRewards.test.ts` | 21 | 0 | 0 |
| `integration/equipmentService.test.ts` | 35 | 0 | 0 |
| `integration/expeditionEquipmentRewards.test.ts` | 20 | 0 | 0 |
| `integration/progressionCurrency.test.ts` | 19 | 0 | 0 |
| `integration/worldEncounterAffection.test.ts` | 14 | 0 | 0 |
| `integration/worldEncounterEquipment.test.ts` | 22 | 0 | 0 |
| `integration/dungeonRewardsLifecycle.test.ts` | 1 | 0 | 0 |

### Per-file Portal results

Paths are relative to `portal/src/`.

| Suite | P | F | S |
| --- | ---: | ---: | ---: |
| `__tests__/architecture.test.ts` | 9 | 1 | 0 |
| `api/__tests__/adminDungeonLootTables.test.ts` | 3 | 0 | 0 |
| `api/__tests__/adminDungeons.test.ts` | 7 | 0 | 0 |
| `features/adminDungeonLoot/__tests__/LootCatalogue.test.tsx` | 9 | 0 | 0 |
| `features/adminDungeonLoot/__tests__/LootEditor.test.tsx` | 22 | 0 | 0 |
| `features/adminDungeonLoot/__tests__/RewardPicker.test.tsx` | 7 | 0 | 0 |
| `features/adminDungeonLoot/__tests__/bundleModel.test.ts` | 6 | 0 | 0 |
| `features/adminDungeonLoot/__tests__/lootModel.test.ts` | 12 | 0 | 0 |
| `features/adminDungeonLoot/__tests__/lootRoutes.test.tsx` | 6 | 0 | 0 |
| `features/adminDungeons/__tests__/ActivityRewards.test.tsx` | 13 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonArtwork.test.tsx` | 7 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonImport.test.tsx` | 22 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonImportSupport.test.tsx` | 3 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonImportV2.test.tsx` | 9 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonMap.test.tsx` | 11 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonPages.test.tsx` | 14 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonRiskPublication.test.tsx` | 20 | 0 | 0 |
| `features/adminDungeons/__tests__/DungeonWorkspace.test.tsx` | 9 | 0 | 0 |
| `features/adminDungeons/__tests__/RoomInspector.test.tsx` | 5 | 0 | 0 |
| `features/adminDungeons/__tests__/TreasureConversionHealth.test.tsx` | 13 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonActionModel.test.ts` | 4 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonAuthoringModel.test.ts` | 7 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonMapModel.test.ts` | 7 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonModel.test.ts` | 2 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonRiskPublicationModel.test.ts` | 6 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonRoutes.test.tsx` | 6 | 0 | 0 |
| `features/adminDungeons/__tests__/dungeonText.test.ts` | 16 | 0 | 0 |

## Baseline failures versus new failures

An isolated archive created with `git archive HEAD` under
`/tmp/waifumon-t18-baseline` used the same installed dependency versions and
separate disposable test databases. No current source/test changes were copied
into it. The root comparison ran engineArchitecture, buddy, buddyBonus and
affectionGifts: **59 pass / 26 fail**. The additional bossRewards comparison was
**47 pass / 2 fail**. Portal architecture comparison was **9 pass / 1 fail**.
For all three comparisons, failed assertion names and complete message prefixes
before stack locations matched current results exactly. Different filesystem
paths and line numbers in stacks were excluded from this comparison.

| Existing failure | Evidence and consequence |
| --- | --- |
| engineArchitecture: 1 failure | Same four offenders: importer reaches node:fs, drizzle-orm and DB schema, and enemyStore reaches drizzle-orm. Vocabulary assertion passes. The existing DB importer is inside the nominal pure package subtree. |
| Portal architecture: 1 failure | Same direct-write API helper offenders: adminArtworkAssets.ts and adminDungeons.ts. Nine other architecture assertions, including no backend import, pass. |
| buddy: 1 failure | Hunt test exhausts scriptedRng at draw 1 in rollWeighted; 17 other cases pass. |
| buddyBonus: 22 failures | Initial capture fixture says “Encounter is no longer active”; cleanup then violates capture_attempts→encounters FK for 21 remaining cases. Six cases pass. Same initial error and cascade on HEAD. |
| affectionGifts: 2 failures | Shipped weight total 10,900 versus expected 10,000; scripted capture gift expects fluffy_cuffs but rolls cream_pie_slice. 35 cases pass. |
| bossRewards: 2 failures | Shipped quantity 70 versus expected 15 and documented weights/quantities assertion. 47 cases pass. |

**New failing assertions: none.** These baseline failures were not fixed or
silently removed from results. Gift/boss discrepancies may be stale fixtures or
content/documentation mismatches; this task establishes their baseline status,
not their product correctness. They need separate reconciliation without
changing reward balance under T18. The full repository suite, Portal lint and
all browser specs were not run; this report certifies only the listed scope.
Existing pg concurrent-query, Vite CJS, Node localStorage and dependency
deprecation warnings do not change the reported pass/fail counts.

## Database and deployment

| Journal index/tag | `when` | Required effect |
| --- | ---: | --- |
| 62 / `0062_dungeon_loot_tables` | 1821132000000 | Catalogue and event tables; immutable keys; append-only events |
| 63 / `0063_dungeon_reward_snapshots` | 1821218400000 | Nullable reward_snapshot/gameplay_hash pair on immutable revisions |
| 64 / `0064_dungeon_unbanked_waifubux` | 1821304800000 | Nonnegative integer default 0 on runs |

Each follows 0061 (1821045600000); every journal tag resolves to one SQL file
and timestamps strictly increase. Catalogue constraints/triggers are verified
on real PostgreSQL. Upgrade tests apply 0063 to a real 0062 revision without
rewriting its content, and 0064 to a real 0063 run without changing wallet or
historical run fields. Legacy rows retain null snapshots and zero new currency.
Existing revision immutability remains enforced. T16/T17/T18 add no migrations.

Prepare a database backup and deployment-specific recovery procedure. Apply the
complete migration chain through 0064 **before new backend services**, then start
the matching backend/bot, verify it healthy, and expose the matching Portal.
`src/index.ts` already runs migrations before loading services, so coordinated
backend startup can perform the database step. Do not serve new endpoints/forms
from the Portal against an old backend. Root-context Docker build is required;
a Portal-only context is incorrect. Verify external ingress accepts import
bodies through 2 MiB as well as the shipped Nginx import location.

Legacy-only definitions, content hashes, packages, claims, gear keys and payout
streams remain supported. Legacy WaifuBux stay secured until explicit conversion
and publication. Mixed legacy/new dungeons are supported. A binary rollback to
pre-Phase-2 backend code after publishing/starting v2 content is unsafe: old
schemas cannot read new bundles/plans. Nullable/additive DDL alone does not make
that rollback compatible. Retain the Phase 2 backend while using content rollback
to an earlier verified revision; content rollback never changes active runs.

V2 package import replacement intentionally disables and unpublishes its target;
v1 replacement retains enabled/current-publication state. V2 requires explicit
republish/enable. Source items/equipment/regions/currencies and artwork bytes are
not transferred; target gear candidates may differ. Metadata is not fully hashed
and published description/origin can be null. Reward hashes provide consistency,
not package authenticity. Import locks briefly serialize catalogue writes;
representative staging imports should check latency and contention.

## Ranked findings

| Severity | Finding | Disposition |
| --- | --- | --- |
| Blocker | No new implementation blocker found within this verification scope | No feature fix proposed; production decision still requires staging evidence |
| High | Post-publication item caps/deletion or gear deletion can block an active run's activity | Approved synchronous failure policy; restore promised keys/remove cap, inspect active-revision health; republish alone cannot repair active runs |
| High | Removed/disabled progression currency forfeits earned Shard banking with a recorded skip | Approved existing policy; avoid currency disable during active runs; WaifuBux settle independently |
| High | Old backend cannot safely resume v2 content/runs; no live upgrade/rollback verification yet | Database→backend→Portal order and compatible rollback procedure are required before production |
| Medium | 29 reproducible baseline assertions fail (28 backend, 1 Portal) | Reconcile gift/boss expectations, Buddy fixtures/cleanup and architecture guards separately; broader CI is not green |
| Medium | V2 portability freezes bodies/source candidates but publishes against target global catalogues | Review candidate differences/use-existing, promote missing globals, publish and enable explicitly |
| Medium | Equipment stat/affix/bonus rules remain live and health does not validate all generation inputs | Approved D7 boundary; verify catalogue edits separately; seeded retry equality assumes unchanged generation rules |
| Medium | Deployed Discord, ingress, representative import contention and migration recovery remain untested | Manual staging checklist below; automated fixtures do not establish production UX or operations |
| Low | 10 desktop-only browser cases skip on mobile; optional art sample skipped | Mobile focused import/risk/health/layout cases passed; synthetic art assertions passed; extend manual device review |
| Low | Production main JS chunk is about 537 kB (175 kB gzip) | Build passes; assess loading on staging devices; no editor/build redesign in T18 |

The High findings describe approved compatibility/operational constraints and
unverified deployment steps, not newly discovered payout regressions. If staging
finds duplicate/partial grants, wrong recipient, mutable pinned loot or import
partial writes, stop promotion and propose a focused fix with the failing
scenario; do not waive it as baseline or expand into another feature phase.

## Manual staging checklist (not performed here)

1. Back up the intended database; rehearse migrations through 0064 and recovery.
   Confirm legacy revisions/runs, wallet balances and ledger identities survive.
2. Start matching backend/bot before Portal; confirm sessions, CSRF, read/write/
   publish roles and reward-health access with real accounts. Verify services
   remain compatible with legacy-only and mixed content.
3. Author loot and a multi-wave boss through the real Portal. Test Roll unsaved
   changes, compare odds, save and publish. Edit shared loot, observe Loot changed,
   start on the old publication, then republish while another run stays active.
4. In Discord win intermediate/final waves, retry/double-click, retreat/re-enter,
   restart/resume and switch Buddy. Verify final-wave-only payout, pinned affection
   recipient/bonus, committed gear/item/Essence receipts, and release reservation.
5. Check extraction, completion, defeat and step-bound abandon confirmations;
   compare both banked currencies with database balances/ledgers, including
   rounding and unchanged pre-run balances. Disconnect must keep the run active.
6. In disposable staging content only, cause a blocked secured grant, check the
   safe retry message and no successful receipt/partial grant, then restore the
   dependency and retry once. Check current and older-active Reward Health;
   verify counts disclose no player identities. Remove test damage afterwards.
7. Transfer a real published v2 file to an independent test destination. Exercise
   missing/identical/copy/use-existing and target gear differences; stale preview,
   uncertain-response exact retry and incomplete import. Confirm disabled,
   unpublished results, review changed references, publish and enable. Exercise
   v1 too and inspect import/table history; never overwrite global catalogue data.
8. Confirm the actual ingress/Nginx upload size, near-limit import payloads,
   error messages and browser refresh behaviour. Test representative concurrent
   authoring/import latency and mobile reward/import layouts.
9. Verify gear rolls under the deployed ranges/affix/bonus catalogues and usable
   Discord names/truncation/artwork. Document a compatible backend recovery path;
   do not downgrade a running v2 environment to a legacy backend.
10. Record staging evidence and resolve unexpected failures before revisiting
    production readiness. Automated green reward suites alone are insufficient.

## T18 files

- Updated `docs/dungeons.md` to current Phase 2 lifecycle, publication/package,
  API, migration and compatibility behaviour.
- Created `docs/dungeons/dungeon-rewards-guide.md` with practical creator workflows
  and the worked Shards/chance-equipment/shared-table Boss example.
- Created this release assessment.
- Added `tests/integration/dungeonRewardsLifecycle.test.ts` (one integrated case,
  two disposable databases; no redundant isolated cases).

All work remains uncommitted. T18 stops here; no next development phase begins.
