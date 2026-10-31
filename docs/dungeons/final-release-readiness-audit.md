# Final Dungeon Release Readiness Audit

Pre-production GO / NO-GO assessment, 2026-10-30.

Audit only. No code, content, artwork, migration or configuration was changed. Nothing was committed, pushed, merged, deployed or restarted. No staging or production system was accessed. All database work used a disposable PostgreSQL 16 container. All build output went to a scratch directory. This report is the only change in the repository, and it is uncommitted.

---

## 1. Executive summary

The Dungeon release code on `Delve` is in good shape. Every release-critical test suite passes. That covers Delve progression, the run engine, rewards, captures, Scene Sprites, Shared Pools, Enemy and Dungeon portability, and the A→B Complete Bundle round trip. The backend and Portal typecheck and build cleanly. The bot image builds. All 32 migrations that production is missing apply cleanly to a production-shaped database, leave existing rows unchanged, and produce the same schema as a fresh install.

**The problem is the release artifact, not the code.** Production runs `Assteroid`, not `Delve`. The two branches have diverged: `Delve` has 103 commits that `Assteroid` lacks, and `Assteroid` has 16 that `Delve` lacks, including a production-only boss, its artwork and two backported migrations. The documented release path (`docs/boss-management.md`, "Migration history: two lines that must converge") is a merge of `Delve` into `Assteroid` with a hand-ordered migration journal. That merge has not been made, so the commit that would actually ship has never been built or tested. Deploying `Delve` as-is would regress production-only content and change a live gameplay value (capture capacity 200 → 2000).

This is also a bigger release than "Dungeons". Production does not have Equipment, the Workshop, Combat Trials, the Enemy Catalogue, Region Pools, Reward Tables or Dungeons yet. All of them arrive at once.

**Recommendation: CONDITIONAL GO.** Deploying the `Delve` branch to production as-is is **NO-GO**. Once the conditions in §18 are met, the merged release is suitable for production.

| | Count |
|---|---|
| P0 findings | **0** |
| P1 findings | **1** (P1-1: release candidate not built; includes two content-merge decisions) |
| P2 findings | 7 |
| P3 findings | 8 |

---

## 2. Release baseline

| Item | Value |
|---|---|
| Audited branch | `Delve` |
| HEAD | `0bda3fe25d8c4334b904f610c2578dfd2f5866c5`, "feat: implement Combat Trials curriculum and Delve access logic" |
| Tracking | `origin/Delve`, in sync (no ahead/behind) |
| Working tree at start | Clean: no uncommitted or untracked files |
| Work that exists only locally | None. CP-1, CP-3, CP-4A, CP-4B, Shared Pools, Species Access UX and Trials→Delve are all committed in HEAD (`753dcde4`, `1b6fcf51`, `de1d65d8`, `0bda3fe2`). Several completion reports still say "uncommitted"; that is out of date. |
| Production branch | `Assteroid` (`d5c2440a`, "halloween update again", in sync with `origin/Assteroid`). Evidence: `docs/boss-management.md` ("`Assteroid` is production; `Delve` is staging") and `docs/portal.md` "Two environments on one host". |
| Staging branch | `Delve` |
| Divergence | `Assteroid...Delve` = **16 / 103** commits. Merge base `8bfabc4e`. |
| `master` | Stale (`0403bec6`). Not a release branch. |
| Deployment process | Docker Compose on one remote host. Production project `waifumon` (`/opt/ADWaifumon/WaifuMon`). Staging `waifumon-stage`. `./assets` and `./content` are bind-mounted from the host checkout. Migrations run at bot startup (`src/index.ts:213` → `src/db/migrate.ts`). There is no CI for the bot; `.github/workflows` covers Portal build and artwork only. |
| This audit's change | `docs/dungeons/final-release-readiness-audit.md` (this file, uncommitted) |

### What production has and `Delve` lacks

`git diff --name-status Delve Assteroid`:

- `assets/bosses/dick-pic-tomancer_boss.webp`, plus its `content/bosses.json` entry ("The Dick Pic-tomancer").
- `drizzle/0045_boss_definitions.sql` and `drizzle/0046_boss_artwork_assets.sql` (production's backported forms of Delve's 0054/0057/0058), with their journal entries.
- `content/tables.json` `inventory.captureCapacity` = **200** on production, **2000** on Delve (Delve commit `b599e28d`, "fix: correct capture capacity value").
- Older Dockerfile, Compose and `.env.example` text (Delve's versions are supersets: they add the `ART_CACHE_DIR` volume and `EQUIPMENT_ONBOARDING_ENABLED`).

The Halloween appearance fix (`ownedDefaultEntry`) and the Nginx boss-artwork redirect fix are already on Delve.

---

## 3. Overall recommendation

### CONDITIONAL GO

- **Deploying `Delve` directly to production: NO-GO** (P1-1).
- **The Dungeon release, as code: ready.** It has no P0 findings, no correctness, security or data-loss defects were found, and every release-critical suite is green.
- **Change to GO** when the conditions in §18 are met. In short: build the `Assteroid` ⊕ `Delve` merge exactly as `docs/boss-management.md` prescribes, decide the two content conflicts, re-run the migration rehearsal and the focused suites on the merge commit, rehearse on staging, and set the production prerequisites (environment flag, proxy limits, backups, content).

---

## 4. Confirmed strengths and completed requirements

All of these were verified against code or tests in this audit, not taken from completion reports.

- **Migrations are additive and convergent.** 32 pending migrations. On tables production already has, they only widen a CHECK constraint, add a CHECK on a new column, and add nullable columns or columns with a default. Data was preserved (§7).
- **One enforcement point for new runs.** `dungeonRunService.start` (`src/modules/dungeons/dungeonRunService.ts`, around lines 1455–1503) runs `requireUnlocked`, takes the player row `FOR UPDATE`, checks the active run, runs `requireDelve` inside the transaction, re-reads `published(tx, key)`, checks the locked region, and consumes the daily allowance before inserting. It is the only `insert(dungeonRuns)` in `src/`. There is no player HTTP route that starts a run, and Discord goes through the service.
- **Run actions are owner-scoped.** `run()` and `act()` filter by `(runId, playerId)` (around lines 1671–1690). In-progress runs never check Delve access, so resume, extract, abandon and restart recovery are always reachable.
- **The Delve entry rule is consistent.** `entryVisible` (around line 1600) uses the same `delveAccess` plus open-dungeon plus current-region rule as `home()`. Draft and disabled dungeons are excluded by `openDungeons`.
- **The curriculum is a fixed list** (`COMBAT_TRIAL_CURRICULUM`, `src/modules/combatTrials/trialCurriculum.ts`). All three Trials and their enemies exist and are enabled in shipped content, so a future optional Trial cannot revoke an unlock.
- **Nothing seeds dungeons** (`src/index.ts`, around line 1107). Production starts with zero dungeons, so Delve stays invisible until a bundle is imported, validated, published and explicitly enabled.
- **Admin authorization is complete for the import paths.** Bundle and enemy imports gate at `onRequest`, before the body is read (`dungeonBundles.ts:304,323`; `enemyPackages.ts:229,247`). Cookie sessions require a double-submit CSRF token compared in constant time (`src/api/auth.ts:96–106`). Bearer admin access is opt-in (`PLATFORM_API_ADMIN_BEARER`, default false).
- **ZIP hardening is tested.** It refuses traversal, symlinks, duplicates, ZIP64, encryption, ratio above 100, size and dimension violations, and hash mismatches (`dungeonBundles.test.ts:876`, `enemyPackages.test.ts`).
- **Shipped artwork is tracked.** All 64 image paths referenced by onboarding, enemies, Trials, equipment, NPCs, bosses and the example dungeon exist under `assets/` and are tracked in git, so a fresh checkout on the host has them.
- **Persistence is correct in Compose.** `waifumon-pgdata` and `waifumon-managed-assets` are separate named volumes. `./assets` is mounted read-only. The art cache is disposable. The init container chowns the volumes. The image runs as uid 1000.

---

## 5. P0 / P1 release blockers

### P0

None found.

### P1-1: The production release candidate does not exist

| | |
|---|---|
| Severity | **P1, blocks release** |
| Evidence | `git rev-list --left-right --count Assteroid...Delve` = 16/103. The production-only files are listed in §2. `docs/boss-management.md` ("Migration history: two lines that must converge") requires a merge that keeps both migration histories, orders `drizzle/meta/_journal.json` by `when`, and keeps the SQL idempotent. No merge branch exists. |
| Impact | Deploying `Delve` directly would drop production's "Dick Pic-tomancer" boss artwork (the DB row survives, so the boss falls back to text) and its `bosses.json` bootstrap entry. It would also raise `captureCapacity` from 200 to 2000 for every player without an explicit decision. The commit that would ship has never been built, typechecked or tested. |
| Includes two decisions | (a) **`captureCapacity`**: production 200 vs Delve 2000. Decide which is intended. (b) **`content/bosses.json`**: take the union, keeping production's Dick Pic-tomancer and Delve's additions. |
| Tested or inferred | The divergence is verified. The merged journal was **simulated** (§7: identical schema on all paths). The merge itself has not been built. |
| Minimum correction | Create a merge branch from `Assteroid`. Merge `Delve`. Resolve the journal by `when`, the content conflicts per decisions (a) and (b), and Dockerfile/Compose/`.env.example` (take Delve's). Re-run §7's rehearsal against the real merged journal. Re-run the focused suites in §12. Deploy that commit to staging first. |

---

## 6. P2 / P3 deferred issues

### P2: important, acceptable with the stated mitigation

| ID | Finding | Evidence | Impact | Mitigation | Tested? |
|---|---|---|---|---|---|
| P2-1 | **Delve cannot unlock unless `EQUIPMENT_ONBOARDING_ENABLED=true`.** Delve requires the `equipment` unlock (`DUNGEON_FEATURE = 'equipment'`, `dungeonRunService.ts:233`), which only onboarding grants. The default is `false` (`.env.example:231`, `src/config/config.ts:126`). Production's `.env` has never had this variable. | code | If left unset, nobody reaches Trials or Delve. | Set it in production `.env` after the startup log reports "equipment onboarding ready". | inferred from code |
| P2-2 | **This is a multi-system first release.** Equipment, Workshop, Trials, Enemy Catalogue, Region Pools (0069), Reward Tables and Dungeons all go live together. Region Pools becomes authoritative for hunt spawns: it bootstraps from the shipped region files and projects into `region_encounter_pools`. | `drizzle/0069_region_pools.sql` header; `docs/region-pools/` | A hunt-pool regression would hit every player, not only Delve players. | Run `docs/region-pools/rp2a-parity.sql` on staging (production copy) and in production after deploy. Smoke-test hunting before announcing. | not executed (needs data) |
| P2-3 | **Theoretical import-recovery race.** `recoverInterruptedImports` (`src/modules/artworkAssets/package/importJournal.ts:125`) runs before every apply. It deletes staged files of any `staged` journal row older than 10 minutes whose files have no `artwork_assets` row. `markImportApplied` (same file) does not re-check `status='staged'`, and `insertStagedAssets` does not re-verify files. If one apply is still in flight after 10 minutes while a second apply starts, the first can commit asset rows whose files were just removed. | code read | Broken managed artwork (dangling rows). Requires a single apply that takes more than 10 minutes, which is unlikely within the 64 MiB / 600-image bounds. Startup recovery itself is safe because one process hosts the API and a restart kills in-flight imports. | Operational rule: **one import at a time**, wait for each to finish. Minimum code fix (post-release): make `markImportApplied` conditional on `status='staged'` and roll back otherwise. | inferred, not reproduced |
| P2-4 | **Large requests depend on the upstream proxy.** nginx allows 65m (bundle) and 49m (enemy) imports. Cloudflare Tunnel in front must accept at least 64 MiB, and large exports are subject to a 60 s default read timeout (CP-4B §12). | `portal/nginx.conf.template:249–271` | Imports or exports fail at the edge. | Verify on the host. Test with a real bundle on staging through the same tunnel path. | not verifiable from repo |
| P2-5 | **Migration locks need a quiet window.** The pending batch runs in one drizzle transaction at bot startup. 0068 takes AccessExclusive locks (documented in `phase4-release-readiness.md`). | `drizzle-orm/pg-core/dialect.js:60`; phase 4 doc | Bot downtime while migrations run. On production data volumes the duration is unmeasured. | Maintenance window. The bot is down during recreate anyway. Take a backup first. | rehearsed on small data only |
| P2-6 | **Open product-policy items carried into production.** #0144: per-dungeon acquisition ledger, so the same species can be acquired once per authorized dungeon (there is no global cap). #0113: no activity lock during runs; hunting, shop and travel stay available by design. | projectmem #0144, #0113 | A design decision, not a defect. Affects exclusive-species scarcity. | Product sign-off before enabling any dungeon that offers exclusive species. | documented |
| P2-7 | **Browser coverage gap in dungeon encounter authoring.** Playwright: 214 passed, 5 failed. In 4 of the failures (`dungeonEncounterAuthoring.spec.ts:327,407`, desktop and mobile) the editor shows "Unexpected Application Error: `w.find is not a function`". Root cause: `playwright/dungeonBackend.ts` stubs `/admin/dungeons/**` with a catch-all that answers the shared-pool list (`/admin/dungeons/waifumon-pools`) with a dungeon object. The real API returns an array (`sharedPoolService.list`, `dungeonSpeciesPools.ts:83`). **This is not a production defect**, but the pool-selection authoring flow has no working browser test, and the editor has no error boundary for a malformed response. | run log, built bundle, source | Manual UI check needed (§14). | Add the route to the stub after release. Manual check of encounter pool selection on staging. | tested (Playwright) |

### P3: post-release improvements

| ID | Finding | Evidence |
|---|---|---|
| P3-1 | Shared-pool import (`/api/v1/admin/dungeons/waifumon-pools/import`, API body limit 2 MiB, exports up to 1.9 MB) has no nginx override, so nginx's 1 MiB default applies. A pool export between 1 and 1.9 MB cannot be re-imported via the Portal. This is the same class of bug as the fixed #0164. The same applies to the dungeon draft, validate, sandbox and loot-table routes (2 MiB at the API), but real drafts are around 14 KB. | `nginx.conf.template` has no server-level `client_max_body_size`; `dungeonSpeciesPools.ts:112`; `sharedPoolService.ts:337` |
| P3-2 | `GET /api/v1/admin/dungeons/capture-items` lacks an OpenAPI summary or tag (`tests/unit/api/routes.test.ts`). | test |
| P3-3 | Several e2e stubs and specs are stale (P2-7; `regionPools.spec.ts:327` expects 75.0% odds, the stub yields 100%). | Playwright |
| P3-4 | 39 root test files fail on HEAD, mostly stale content or fixture expectations (§13). This weakens regression signal for future merges. | §13 |
| P3-5 | projectmem #0029 ("loot tables not pinned by revision") is mostly superseded by migration 0063's `reward_snapshot` for v2 rewards, but is still open. Legacy v1 reward references remain live-resolved. | `drizzle/0063_dungeon_reward_snapshots.sql` |
| P3-6 | Revision exports carry current (not frozen) enemies and shared pools (CP-4B §12). Active runs keep frozen copies, so the practical risk is low: re-exporting an old revision after catalogue edits gives the new enemy and pool bodies. | CP-4B doc, `dungeonBundles.test.ts:447` |
| P3-7 | Bundle decisions travel in the query string (6,000-character cap), and apply re-uploads the whole bundle. Fine for authored dungeons. | CP-4B §12 |
| P3-8 | Several completion reports still say "uncommitted" although the work is in HEAD. #0098: the shipped example-package set is incomplete. | docs |

---

## 7. Migration and schema readiness

### Inventory

- Delve journal: 77 entries (0000–0076), `when` strictly increasing. `tests/unit/migrationJournal.test.ts` passes 9/9.
- **0074 `dungeon_species_pools`, 0075 `enemy_package_imports`, 0076 `import_journal_kind`** are present, registered (idx 74–76, `when` 1822168800000 / 1822255200000 / 1822341600000) and correctly ordered.
- Production is at `0046_boss_artwork_assets` (`when` 1819640000000). The drizzle migrator (0.38.4) applies every entry whose `when` is greater than the newest applied, all in one transaction. That covers **all 32 Delve migrations 0045–0076**, including 0054/0057/0058, which re-target objects that production already created and are written to be idempotent (`IF NOT EXISTS`).

### Destructive-statement scan (0045–0076)

The only `DROP`s are `DROP CONSTRAINT/COLUMN/TRIGGER IF EXISTS` on tables these same migrations create (equipment, dungeon revisions). On the 5 pre-existing production tables they touch, the changes are:

| Table | Change |
|---|---|
| `artwork_assets` | category CHECK widened (adds `dungeon_scene_sprite` and others) |
| `player_currencies` | `+ salvaged_components integer NOT NULL DEFAULT 0` and its `>= 0` CHECK (no table rewrite on PostgreSQL 16) |
| `player_waifus` | `+ acquired_via`, `+ grant_key` (nullable), partial unique index on `grant_key` |
| `boss_encounters` | `+ reward_snapshot`, `+ boss_snapshot` (nullable) |
| `boss_definitions` | idempotent no-op on production |

No constraint was narrowed (verified by a constraint diff, below).

### Rehearsal on disposable databases (executed)

| Path | Steps | Result |
|---|---|---|
| Fresh | Delve journal | 77 applied |
| **Production path** | Assteroid journal (47) → **seed rows** (guild, species, 2 players, 2 waifus, buddy, currencies, `boss_art` asset, boss definition referencing it) → Delve journal | 79 tracking rows. **Fingerprints of players, waifus, currencies, artwork and bosses identical before and after.** `pg_dump --schema-only` identical to fresh Delve except the physical column position of `boss_encounters.reward_snapshot`. |
| Merged journal (simulated: Delve + Assteroid 0045/0046, sorted by `when`) | fresh / production path / staging path (Delve at 0076, then merged) | All three produce a schema **identical** to fresh Delve (sorted-DDL md5 `7d7a7b1c…`). Staging path is a 4 ms no-op. |
| Image rollback | Assteroid migrator on the upgraded DB | no-op (newest `when` is greater than all its entries). Data still identical. |
| Constraint diff | Assteroid-only DB vs upgraded DB | Removed or changed: only the widened `artwork_assets_category_check`. Added on existing tables: only `player_currencies_salvaged_components_check`. |

### Startup seeding on first boot

- Dungeons: **none seeded** (cannot auto-activate).
- Enemies: seeded from `content/combat/enemies.json`. Equipment definitions and world encounters: insert-missing. Reward tables: seeded from shipped content; Portal-edited tables are never overwritten (`src/index.ts`, around lines 1068–1081).
- Bosses: insert-missing only, so existing production rows are never updated.
- Region Pools: bootstrap each region once from its shipped region file, then project into `region_encounter_pools` (P2-2).
- Import journal recovery: removes only files of `staged` rows older than 10 minutes that no `artwork_assets` row names (`importJournal.ts:125–148`). It cannot delete artwork that an asset row references.

### Application/schema boundary

Bot and Portal must be deployed **together** (CP-4A §12; new Portal panels call new routes). This is not a rolling deployment: the single bot process runs migrations before serving.

### Migration verification checklist

1. In the merged commit, `drizzle/meta/_journal.json` has 79 entries ordered by `when`, with Assteroid `0045_boss_definitions` and `0046_boss_artwork_assets` directly after `0044`. Every `when` is unchanged.
2. `tests/unit/migrationJournal.test.ts` passes on the merge.
3. Repeat the §7 rehearsal against the merged `drizzle/` folder: production path from a **restored copy of the production backup**, then compare schema with fresh.
4. Before the production deploy, record `select count(*), max(created_at) from drizzle.__drizzle_migrations` (expect 47 / 1819640000000).
5. After deploy, expect 79 / 1822341600000, and the bot log shows "migrations complete".
6. Spot-check row counts of `players`, `player_waifus`, `player_currencies`, `boss_definitions` and `artwork_assets` before and after.

---

## 8. Docker, storage and persistence

Verified from the repository. **The production host was not inspected.**

| Check | Result |
|---|---|
| Managed artwork survives container recreation | Yes. Named volume `waifumon-managed-assets` → `/data/waifumon-assets` (`docker-compose.yml`). `down -v` destroys it (documented). |
| DB and artwork independently persistent | Yes. Separate volumes `waifumon-pgdata` and `waifumon-managed-assets`. They **must be backed up together.** |
| New volume | `waifumon-art-cache` (disposable) and the `ART_CACHE_DIR` environment variable come with the Delve Compose file. The init container chowns it. |
| Shipped artwork | `./assets` is bind-mounted **read-only** from the checkout. All 64 referenced shipped images are tracked. Bundles never write `ASSETS_DIR`. |
| Content | `./content` is bind-mounted read-write from the checkout. The host checkout must be the merged commit. |
| Bot and Portal share API and asset URLs | Portal nginx proxies `/api`, `/auth` and `/health` to `http://waifumon-bot:${PLATFORM_API_PORT}`. `VITE_PLATFORM_API_URL=/api`. |
| Upload limits | nginx: equipment import 5m, enemy import 49m, bundle import 65m, Dungeon JSON import 2m, artwork 9m. These match the API's `bodyLimit`s. Gap: P3-1. |
| Health and ordering | `postgres` has a healthcheck. The bot waits on it and on the init container. The Portal waits on `service_started` of the bot. The bot has no healthcheck; `/health` is liveness only. |
| Image builds | **Bot image built with podman** (`localhost/wm-audit-bot:0bda3fe2`, 301 MB): 77 migrations present, `dist/index.js` present, runs as uid 1000. Portal image not built; its Vite production build and `verify:bundle` were run separately (§12). |

### Operational checks before deployment (host)

- Free disk for the database growth, a full backup, and the managed-artwork volume (bundles can add up to 64 MiB each).
- `docker volume ls` shows `waifumon_waifumon-pgdata` and `waifumon_waifumon-managed-assets` (production project prefix). Confirm the managed-artwork volume is not empty if production already has boss uploads.
- `WAIFUMON_UID`/`WAIFUMON_GID` match the checkout owner.
- Cloudflare Tunnel or upstream body limit ≥ 64 MiB, and read timeout suitable for exports (P2-4).

---

## 9. Content Portability assessment

All suites pass on HEAD:

| Area | Suites (pass/total) |
|---|---|
| CP-1 Equipment | `adminEquipmentPortability` 19/19, `equipmentPackage` (unit) 19/19 |
| CP-3 Enemies | `enemyPackages` 29/29, `enemyCatalogue` 22/22 |
| CP-4A safe updates | `dungeonImport` 16/16, `dungeonImportLifecycle` 11/11, `dungeonImportV2` 22/22, `dungeonPackageV2/V3/V4` 8/8, 17/17, 29/29, unit package v1–v4 all green |
| CP-4B bundles | `dungeonBundles` 25/25, unit `dungeonBundle` 3/3, Portal `DungeonBundleImport` (in Portal suite, green) |
| Shared Pools | `dungeonSharedPools` 7/7, unit `sharedPools` 3/3, Species Access review 7/7 |

### Cross-environment acceptance

This is covered by the existing `dungeonBundles.test.ts`, which was not rebuilt for the audit. It uses separate worlds A and B with separate databases, managed roots and shipped roots, and removes A's roots before import. The test cases are:

- export with bytes and no source IDs (`:429`)
- preview showing prerequisites and disabled-until-enabled (`:457`)
- atomic apply to a disabled, unpublished draft (`:484`)
- **cannot publish until the shared pool is enabled; once enabled and published, a run completes and acquisition limits hold** (`:534`)
- identical re-import writes nothing and duplicates no artwork; an exact retry replays its receipt (`:567`)
- revision 1 stays live until revision 2 is published (`:594`)
- stale review refused (`:741`)
- failure and crash cleanup (`:764`, `:791`)
- concurrent imports: one wins (`:804`)
- missing managed file refuses the export (`:822`)
- a species B lacks gives a blocked or incomplete repair draft (`:905`)
- hostile archives (`:876`)
- permissions (`:974`)

**Missing required assets cannot produce a misleading success.** The export refuses (`:822`, `:837`). Import readiness is `incomplete` or `blocked` (`:905`).

---

## 10. Dungeon gameplay and progression

### Equipment → Trials → Delve

- `trialsDelveProgression` 28/28, `trialsDelveNavigation` 15/15, `combatTrials` 26/26, `combatTrialsDiscord` 39/39, `equipmentOnboarding` 27/27.
- **Eligibility consistency.** Code review found no inconsistent entry path (§4). The main-menu Trials and Delve entries both use the services' `entryVisible`. Stale buttons go through `start()`/`home()`/`dungeon()`, which re-check inside the service.

### Run lifecycle

`dungeonRuns` 25/25, `dungeonEncountersLive` 33/33, `dungeonEncountersDiscord` 40/40, `dungeonCapturesLifecycle` 12/12, `dungeonEventsLive` 21/21, `dungeonRewardSnapshots` 19/19, `dungeonRewardDiscord` 13/13, `dungeonOwnedSpeciesAccess` 17/17, `dungeonLootTables` 33/33, `dungeonSceneSprites` 5/5, `dungeonEncountersMigration` 4/4, and the unit engine suites (`dungeonEncounters` 64/64, `dungeonRewards` 94/94, `dungeonEvents` 25/25).

The full dungeon-named set is 75 files and 1,445 tests with **1 failure**: the stale table list in `dungeonContent.test.ts` (§13).

### Material uncertainty

Not demonstrated end to end by an automated test against **production-shaped data**:

- daily-limit timezone rollover on the production `DAILY_TIMEZONE`
- disconnection mid-interaction in real Discord
- equipment and buddy locking under real player concurrency (the design is #0113)

These are manual staging items (§14).

---

## 11. Admin Portal and security

- **Portal suite: 2,025/2,026.** The one failure is the known #0069 architecture rule (`adminArtworkAssets.ts`/`adminDungeons.ts` direct `apiClient` writes). It is an architecture rule, not runtime behavior. #0159 (flaky local-pool reopen test) passed this run.
- **Playwright (stubbed API, scratch build): 214 passed / 5 failed / 19 skipped.** The failures are stub or spec drift (P2-7, P3-3). The shared-pool page, dungeon import, artwork, events, region pools (except one scenario) and accessibility specs pass.
- **Permissions.** `portalPermissions` unit 7/7, `adminDungeons` API 78/78, bundle permission test (`:974`).
- **Security review findings.** None at P0 or P1.
  - Actor identity comes from the Discord interaction (`prov.playerId`), and dungeon screens are ephemeral.
  - Every run read and action filters by owner.
  - CSRF uses a double-submit cookie and header in constant time.
  - Imports are gated before the body is read.
  - Archive limits are enforced.
  - Content hashes are verified per asset.
  - No source storage keys, URLs or host paths are carried in packages (tested).
  - Duplicate payout and acquisition are protected by unique keys and request receipts (`dungeonBundles:567`, reward-claim suites, `player_waifus_grant_key_uq`).
- **Manual UI checks still needed:** §14 items 6–10.

---

## 12. Test matrix (exact results, this audit)

All runs used a disposable `postgres:16-alpine` container (`max_locks_per_transaction=1024`).

| Check | Command (summary) | Result |
|---|---|---|
| Backend typecheck | `tsc --noEmit -p tsconfig.json` | **0 errors** |
| Backend build | `tsc -p tsconfig.build.json --outDir <scratch>` | **OK** |
| Portal typecheck | `portal: tsc --noEmit` | **0 errors** |
| Portal production build | Vite `build()` with an empty `envDir` (the repository's `portal/.env` guard), output to scratch | **OK**. `verify-bundle`: 170 files, no dev-only code |
| Bot image | `podman build` (isolated tag) | **OK** |
| Root suite (one broad run) | `vitest run` | 439 files, **9,341 tests: 9,174 passed, 166 failed, 1 skipped**. 39 failing files (§13). Release-critical suites: all green except `dungeonContent` (stale table list) |
| Isolated reruns | `wildEncounterSpawn`, `triggeredEncounterDecline`, `captureExtraction`, `equipmentWorkshopPortal`, `adminEnemies` | Deterministic, same failures (classified in §13) |
| Portal suite | `portal: vitest run` (alone) | **2,026 tests: 2,025 passed, 1 failed** (#0069) |
| Playwright | scratch config: e2e build to scratch, port 4183, desktop and mobile | **214 passed, 5 failed, 19 skipped** |
| Migration rehearsal | §7 | **All paths pass**; data preserved; schemas identical |

---

## 13. Known baseline failures and their implications

The tree was clean, so these 166 failures **are** the HEAD baseline. The earlier recorded full-suite baseline was 117 failures in 30 files (`e7f8f0b`). The increase comes from new shipped content (Halloween appearances, more bosses, dungeon-exclusive species) and fixture drift. **None indicates a defect in release code.**

| File (failures) | Assertion, cause | Pre-existing? | Release risk |
|---|---|---|---|
| `wildEncounterSpawn` (16), `triggeredEncounterDecline` (22) | expected `'unavailable'` to be `'created'`. Fixture picks the "first enabled species" (`limit(1)`, no order), which is now a **dungeon-exclusive** species. The spawner correctly refuses it (`wildEncounterSpawner.ts:289–294`). By elimination this is the only `unavailable` branch for a named enabled slug, and the unnamed-species test passes. | New since `e7f8f0b`; deterministic | **None.** The guard is the intended behavior. |
| `buddyBonus` (22), `buddy` (1) | Encounter fixture cascade / exhausted scripted RNG (#0052, #0053) | Yes, also on Assteroid | Test fixture |
| `boss*` (31 across 6 files) | shipped boss count, timings, reward quantity 70 vs 15; `bossScheduler` timing flake | Yes, also on Assteroid | Content tuning. Bosses already run in production. |
| `care` (8), `daily` (5), `progression` (2), `consumables` (5), `shop` (7), `travel` (1), `affectionGifts` (2) | Tuning and shelf content drift (#0084) | Yes, also on Assteroid | Content-tuning tests |
| `careEphemeralSweep` (10), `giftAndCaptureUi` (2) | `getCurrentRegion` of undefined: fixture omits the travel service (#0149) | `giftAndCaptureUi` yes; `careEphemeralSweep` same cause | Test fixture |
| `captureExtraction` (4) | snapshot gains `halloween_*` in `seenAppearances` | New (Halloween content) | None. Owned skins unlock on capture by design. |
| `appearance`, `captureAppearanceUnlock`, `appearanceEndpoints`, `halloweenAppearancesShippedContent` | Species now ship 7 appearances / more multi-owned species | Yes | Content |
| `equipmentWorkshopPortal` (5) | "must not contain '7000'": 7000 is the **Advanced Rebuild WaifuBux price**, not a leaked basis point; fixture funds too low for new prices | Yes | Tuning. No data leak (response inspected). |
| `equipmentBaseCatalogue`, `equipmentWorkshopConfig`, `equipmentOnboardingContent`, `onboardingArtwork` | Content now ships 27 definitions, workshop art, Patch portrait and intro art (all files present) | Yes | Stale expectations |
| `seductivePowerMigration` (5) | Old-migration harness hits new `acquired_via` column | Yes | Test harness. The real upgrade is proven in §7. |
| `migrateSeed` (1) | expects one region seeded; content has four | Yes | Stale |
| `dungeonContent` (1) | table list lacks the two newer catalogue tables | Yes (noted at CP-4B) | Stale |
| `unit/api/routes` (2) | mutation-verb allowlist stale; `capture-items` lacks a summary | Yes | P3-2 |
| `unit/api/errors` (1) | reflection fixture passes junk to `DungeonImportError` (#0147) | Yes | Test |
| `engineArchitecture` (1) | importer reaches `fs` and DB from an engine-pure root (#0025) | Yes | Architecture lint only |
| `adminEnemies` (1) | TypeError inside the test's own `fields()` helper (`:168`) | Yes | Test |
| `combatEnemyContent`, `cards/race` (`moth` archetype unmapped), `buddyAffinity` | Content additions | Mostly yes | `race`: a card renderer label gap, P3 |

---

## 14. Manual staging acceptance checklist

Run on staging, **after deploying the merged commit** to a staging stack restored from a **copy of the production database** (not over live staging playtester data; see the project notes), with that copy's managed-artwork volume.

1. Bot log shows migrations complete (79 rows), "equipment onboarding ready", no `dungeons/published-invalid` warnings, and an `enemy-package/recovery` result.
2. Run `docs/region-pools/rp2a-parity.sql`. Hunt in each region and confirm no dungeon-exclusive species appears.
3. Run an existing-player smoke test: hunt, capture, daily, shop, travel, care, expeditions, bosses (including Dick Pic-tomancer artwork).
4. As a new test player at the onboarding level: complete Equipment onboarding. Trials appear, and Delve does **not**.
5. Clear the three Trials. Trials hide and "Delve unlocked!" appears. Delve is still hidden while no dungeon is enabled in the region.
6. Portal: import a Complete Bundle exported from Delve staging, through the real tunnel path (≥ 64 MiB limit). The review shows prerequisites. Choose decisions, apply, enable pools and enemies, validate, publish, enable.
7. Delve appears only in the dungeon's region. Travel away and it disappears. Travel back and start a run.
8. During the run: combat, room transitions, events and a text puzzle, chest rewards, an exclusive encounter with capture and the per-player limit, artwork and sprites render in Discord and Portal. Complete and confirm rewards are settled once (reclick stale buttons).
9. Retreat or extract, abandon, a failed combat, and a bot restart mid-run (resume works).
10. Portal: shared-pool selection in the encounter editor (P2-7), Species Access bulk review, Scene Sprites, enemy ZIP export/import, equipment catalogue export/import, browser hard-refresh after deploy (no stale chunk errors).
11. Re-import the same bundle: "unchanged", no duplicate assets.
12. Import a changed bundle for the live dungeon: the published revision stays live until an explicit publish.

---

## 15. Ordered production deployment runbook

Do not execute until §18 is satisfied.

### Before deployment

1. Freeze the release commit: the merge of `Delve` into `Assteroid`, with the hash recorded and staging acceptance (§14) passed on that exact hash.
2. Confirm the migrations required: production at 47 / `1819640000000`. The release adds 32 (Delve 0045–0076).
3. Announce a maintenance window (P2-5).
4. **Back up PostgreSQL and the managed-artwork volume together**, with the bot stopped for a consistent pair: `pg_dump -Fc` of `waifumon`, plus a tar of `waifumon_waifumon-managed-assets`. Verify the restore of both into a scratch stack.
5. Check host disk space, the volumes present, `WAIFUMON_UID/GID`, and that `./assets` and `./content` belong to the deploy user.
6. Update production `.env`: add `ART_CACHE_DIR` handling (Compose supplies it) and **`EQUIPMENT_ONBOARDING_ENABLED`** (plan to set `true` after step 13). Review the other new Delve variables in `.env.example`.
7. Confirm the upstream proxy (Cloudflare) body limit ≥ 64 MiB on `/api/v1/admin/dungeons/import/bundle/*` and ≥ 48 MiB on `/api/v1/admin/enemies/import/*`.
8. Confirm the external content prerequisites are in the release commit: dungeon-exclusive species and artwork, items, equipment, regions and reward tables that the planned dungeons need.
9. Confirm Portal admin roles hold `dungeons.read/write/publish`, `enemies.read/write` and `artwork.read/write`.

### During deployment

10. `git fetch && git checkout <release hash>` in `/opt/ADWaifumon/WaifuMon`. Do **not** use `down -v`.
11. `docker compose build waifumon-bot` and `docker compose --profile portal build waifumon-portal`. Both images must come from the same hash.
12. `docker compose up -d` (bot and its dependencies), then watch the logs for migrations complete (79 rows), enemy seed, equipment rules bootstrap, region pool bootstrap, import recovery, and no `dungeons/published-invalid`.
13. `docker compose --profile portal up -d waifumon-portal`. Check `/health` through the tunnel. Check `/api/v1/admin/...` with an admin session. Check that boss and managed artwork serve.
14. Do **not** enable any dungeon. Production has none at this point.

### After deployment

15. Smoke-test existing gameplay (hunt, capture, daily, shop, travel, bosses, expeditions). Run the region-pool parity check.
16. Set `EQUIPMENT_ONBOARDING_ENABLED=true` and restart the bot. Verify onboarding, Trials and the Delve-hidden state with a test account.
17. Import the first dungeon bundle (§14 steps 6–8), one import at a time (P2-3). Validate, publish, test with a staff account, then enable.
18. Verify rewards and acquisition policies on that run. Watch logs and error rates for 24 h.

---

## 16. Rollback and disaster recovery

| Scenario | Action | Safe? | Basis |
|---|---|---|---|
| **Bad dungeon content** | Portal: disable the dungeon, or roll back publication (`POST /admin/dungeons/definitions/:key/rollback` moves the pointer to an earlier revision). Active runs keep their pinned revision. | Yes | code, CP-4A tests |
| **Bad application image (keep schema)** | Re-deploy the previous `Assteroid` images. The Assteroid migrator is a no-op on the upgraded DB. New columns are nullable or defaulted, and constraints were only widened. | Likely yes. Schema compatibility was **verified**. Running the old application against the new schema was **inferred**, not exercised. Old code may not list `dungeon_scene_sprite` artwork categories. | §7 |
| **Restore the database** | Stop the bot. Restore `pg_dump` **and** the managed-artwork tar taken at the same moment. Re-deploy the matching images. | Yes, if done as a pair | Compose design |
| **Restore managed artwork only** | Only when no import or upload happened since the backup. Otherwise asset rows point to missing files. | Conditional | `artwork_assets` rows reference files |
| **Reverse a migration** | There are no down migrations. Reversal means a database restore. Data written after the deploy (onboarding, Trials, runs, rewards, captures) is lost. | Restore only | drizzle |

**Coordinated PostgreSQL + artwork restore is required** whenever any Portal upload, enemy import or bundle import happened after the backup.

---

## 17. Remaining decisions and external prerequisites

1. **`captureCapacity`**: 200 (production) or 2000 (Delve)? (P1-1a)
2. **`bosses.json` union** confirmed (P1-1b).
3. **#0144** per-dungeon acquisition ledger scope: product sign-off.
4. **#0113** no activity lock during runs: accept as shipped design.
5. Which dungeon(s) go live first, and in which regions. Their bundles must be exported from staging after the merge.
6. Host facts not verifiable here: Cloudflare limits and timeouts, disk space, volume names, backup tooling and the restore drill.
7. Who enables `EQUIPMENT_ONBOARDING_ENABLED`, and when.

---

## 18. Conditions to change the recommendation to GO

All of these must be true:

1. **P1-1 closed.** A merge commit of `Delve` into `Assteroid` exists. Its journal is ordered by `when` with all 79 entries. The `bosses.json` union and the `captureCapacity` decision are applied. Delve's Dockerfile, Compose and `.env.example` are taken.
2. On that commit: backend and Portal typecheck and build, the bot and Portal images build, the focused suites in §9–§11 pass, and the root and Portal failure lists contain **only** the families in §13.
3. The §7 rehearsal is repeated with the merged `drizzle/` folder against a **restored copy of the production database**, with data preserved and the schema identical to fresh.
4. Staging acceptance (§14) passes on that exact commit with production-copy data, including a real bundle import through the tunnel.
5. A verified paired backup (PostgreSQL + managed artwork) exists, and a restore drill has been done.
6. Production prerequisites are set: the onboarding flag plan, proxy body limits ≥ 64 MiB, and the one-import-at-a-time rule communicated to content editors.
7. Product sign-off on #0144 (and acceptance of #0113) before enabling any dungeon that offers exclusive species.

The shortest safe path: merge → re-verify (one day of CI-equivalent runs) → staging rehearsal on a production copy → paired backup → maintenance-window deploy with **no dungeon enabled** → onboarding flag → import, publish and enable the first dungeon.
