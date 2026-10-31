# Assteroid → Delve: Production Branch Equivalence Audit

**Date:** 2026-10-30
**Scope:** whether production can switch directly from `Assteroid` to `Delve` without merging the two branches.
**Mode:** read-only. No code, content, artwork, migrations or config changed; no merge, cherry-pick, commit or deploy; no production database or volume touched. This document is the only file created.

---

## 1. Recommendation: **CONDITIONAL**

A direct switch is **technically safe**. No merge is required. Of the 16 commits that exist only on `Assteroid`, 14 are present on `Delve` in functionally equivalent form, are superseded by the Delve originals they were backported from, or are merge commits with no changes of their own. The other 2 both carry the same single missing change. Migrations, Docker and compose config, environment defaults, species, items, encounters, expeditions, regions, reward tables and 46 of the 47 bosses are all equivalent or a strict superset on `Delve`.

**One piece of production content is missing from `Delve`:** the *Dick Pic-tomancer* boss (`e624e693` / `52e52f73`). It consists of the `dick_pic_tomancer` entry in `content/bosses.json` and the Git-tracked file `assets/bosses/dick-pic-tomancer_boss.webp`. The fix is a small content restore, not a merge. Section 9 sets out the options.

Capture capacity on `Delve` is **2,000** (`content/tables.json`, `b599e28d`), which is the intended value. Production's 200 is the old value, so the switch applies the intended change.

> **This revises P1-1 of `docs/dungeons/final-release-readiness-audit.md`.** That report treated "the Assteroid ⊕ Delve merge has not been built" as the blocker. This audit finds the merge unnecessary. The real blocker is the Dick Pic-tomancer content gap, and the capture-capacity question is settled at 2,000. The rest of that report still applies (staging rehearsal, onboarding flag, proxy limits, import race, backups).

---

## 2. Exact branch comparison

| | |
|---|---|
| Current branch | `Delve` |
| HEAD | `0bda3fe25d8c4334b904f610c2578dfd2f5866c5` (= `origin/Delve`) |
| Working tree | clean, apart from the untracked `docs/dungeons/final-release-readiness-audit.md` (and now this file) |
| `Assteroid` | `d5c2440a419b26a9fe588b452716203d7cb63331` (= `origin/Assteroid`) |
| Merge base | `8bfabc4e` (2026-09-30) "feat: implement foundational equipment system design and initial release plan" |
| Reachable from `Assteroid`, not `Delve` | **16** commits: 14 non-merge, 2 merges |
| Reachable from `Delve`, not `Assteroid` | 103 commits |

`git cherry -v Delve Assteroid` marks 5 commits `-` (an identical patch exists on Delve) and 9 `+`. The `+` commits were **not** taken as missing on that basis. Each one was checked as described in section 3.

---

## 3. Method

1. **Net file comparison.** I listed the 148 files that `Assteroid` changed since the merge base (`git diff --name-only 8bfabc4e Assteroid`). 95 of them are byte-identical on `Delve`.
2. **Added-line presence.** For each of the other 53 files, I checked every line `Assteroid` added since the merge base (`git diff -U0 8bfabc4e Assteroid`) against `Delve`'s version of the file. Nearly all of the missing lines are comments that name production's migration numbers (0045/0046 instead of 0057/0058) or production's file-based reward tables. Every remaining missing code line is accounted for in section 4.
3. **Blob comparison of all Git-tracked content.** I compared `git ls-tree -r` for `assets/`, `content/`, `drizzle/` and `portal/public/` on both branches.
4. **Semantic content comparison.** I parsed the JSON for `bosses.json`, all species files and `assets/.artwork-manifest.json` on both branches.
5. **Commit pairing.** I matched commits using `git patch-id --stable` and `git range-diff`, then confirmed each pair against source and blob hashes.
6. **Startup and migration review.** I read `src/index.ts`, `bootstrapBossDefinitions`, `seedRewardTables`, the boss artwork resolver and the drizzle journal. The migration upgrade path was rehearsed in the previous audit, and those results are cited here.

---

## 4. Per-commit findings

| # | Assteroid commit | Purpose | Classification | Delve counterpart and evidence |
|---|---|---|---|---|
| 1 | `120fee26` | Cracked teleport core in expedition rewards; item weights | **Functionally present** | Already in the merge base: `git diff f2264b0b 8bfabc4e -- content/expeditionRewards.json content/items.json content/tables.json content/encounters content/expeditions assets/encounters` is empty, so these paths are unchanged from merge base to `Assteroid`. On `Delve`, `content/expeditionRewards.json` keeps all of it and adds 57 lines (dungeon scrapheap tables). |
| 2 | `f2264b0b` | Asteroid Belt world encounters (19 artworks, 2 encounter files), expedition/item/table tweaks, key-item test | **Functionally present** | Same evidence as #1: every path is identical at the merge base and on `Delve`. All 19 `assets/encounters/ab_*.webp` blobs, both `content/encounters/*-2026-09-30*.json` files and `tests/unit/keyItemContent.test.ts` are identical on `Delve`. The only difference in `content/tables.json` is `captureCapacity`; see #3a. |
| 3 | `e624e693` | Boss Addition: **Dick Pic-tomancer** (bosses.json entry and `assets/bosses/dick-pic-tomancer_boss.webp`) | **Missing and required** | Never on the Delve line: `git log --all -- assets/bosses/dick-pic-tomancer_boss.webp` returns only `e624e693` and `52e52f73`, and `git branch --contains 52e52f73` lists `Assteroid`, the backport branches and `V2Encounter`, but not `Delve`. `Delve:content/bosses.json` has 53 bosses: all 47 from `Assteroid` except `dick_pic_tomancer`, plus 7 Delve-only bosses. See section 9. |
| 4 | `52e52f73` | The same Boss Addition, on the `V2Encounter` side of PR #25 | **Missing and required** (same change as #3) | Same 13-line `bosses.json` hunk and the same 545,976-byte image as #3. |
| 5 | `89ded23b` | Merge PR #25 (`V2Encounter`) | **Merge, no independent changes** | `git diff-tree --cc 89ded23b` is empty. It brings in `52e52f73`; the rest of `V2Encounter` is already in the merge base. |
| 6 | `253e2b5a` | `/waifumon-admin` grant-item command (`adminItemGrantService.ts`, registry, client wiring, tests) | **Functionally present** | `2d4667d6` (Delve, 2026-10-07) has an identical patch-id; range-diff shows `=`. All 7 files are byte-identical on `Delve`. |
| 7 | `6483f37d` | Count Jack-ula boss (backport from `cd7bfbd9`) | **Functionally present** | Delve's original is `cd7bfbd9`. `assets/bosses/count-jackula_boss.webp` has the same blob, and the `count_jackula` entry in `bosses.json` is identical. |
| 8 | `3a46d12f` | Five Halloween bosses and art (Franken-Simp, Creeper of the Black Lagoon, Jekyll/Mr Slide…, The Mummy's Boy, Registered Hex Offender), despite the commit subject | **Functionally present** | `4447d632` has an identical patch-id. All five image blobs and `bosses.json` entries are identical. |
| 9 | `b2167c37` | Boss Management: DB-backed `boss_definitions`, schedules, admin Portal, migration `0045_boss_definitions` | **Superseded** (production backport of Delve's `ced5fcad`) | Production's `drizzle/0045_boss_definitions.sql` is **byte-identical** to Delve's `drizzle/0057_boss_definitions.sql`. `bootstrapBossDefinitions` is in `src/modules/bosses/bossDefinitions.ts:272` with the same insert-missing-only semantics, and is wired at `src/index.ts:760-779`. The code lines missing from `Delve` are production's trimmed forms: production reads reward tables from `content/bossRewards.json` (`src/index.ts` `listRewardTables: … contentSnapshot.bossRewards`, and `bossEncounterService.ts` `boss/reward-table-missing` checks against the file). Delve uses DB reward tables instead (`listBossRewardTableOptions`, `src/index.ts:753`; the same `boss/reward-table-missing` and `-disabled` checks at `bossEncounterService.ts:619,631`). |
| 10 | `7ca8a8dc` | Merge PR #26 (BossManagement-Backport) | **Merge, no independent changes** | `git diff-tree --cc` is empty. |
| 11 | `17b300d0` | Boss artwork upload: `artwork_assets`, `artwork_asset_events`, `MANAGED_ASSETS_DIR`, managed-assets volume, migration `0046_boss_artwork_assets` | **Superseded** (production backport of Delve's `ab80a2d1`) | By its own header, production's 0046 is "Delve 0054's artwork tables without `combat_enemy_artwork`, then Delve 0058 statement for statement". Delve has `0054_artwork_assets.sql` and `0058_boss_artwork_assets.sql`. Delve's `Dockerfile`, `docker-compose.yml`, `.env.example` and `config.ts` keep `MANAGED_ASSETS_DIR=/data/waifumon-assets` and the `waifumon-managed-assets` volume unchanged, and add `ART_CACHE_DIR` and the `waifumon-art-cache` volume. Storage startup is at `src/index.ts:488,572-582`, now covering both directories. The Discord fallback chain (managed → shipped → text) is in `src/discord/bossArtwork.ts`. `artworkAssetService.ts` on Delve is the general service; production's version was cut down to boss references only. |
| 12 | `18be70ce` | Fix: shipped boss artwork missing in Portal behind Nginx (`/admin/bosses/artwork/` redirect) | **Functionally present** | `db064a75`. The range-diff differs only in surrounding context, from the extra Delve nginx blocks and a test title. Delve's `portal/nginx.conf.template:187-210` has the slash-less `location ^~ /api/v1/admin/bosses/artwork/assets` and the boss import location. `src/api/routes/v1/admin/bosses.ts:644-655` registers the shipped-artwork route with and without the trailing slash. |
| 13 | `593b3a3e` | 13 Halloween appearances, appearance handling fixes (default appearance, gallery, trainer profile, loader) | **Functionally present** | `3fbb8028`, `348f3bb8`, `51d0bcf8` and `bf90f595`. Every image blob is identical. `appearanceContent.ts`, `schemas.ts`, `trainerProfile.ts`, `galleryCatalog.ts`, `portal/src/images/assets.ts` and the tests have every production-added line. The only line missing from `loader.ts` is a reworded comment. All 175 production species are on `Delve` with identical appearances. |
| 14 | `be2b34bd` | Halloween update (10 more appearances) | **Functionally present** | `582f89cd`, identical patch-id. |
| 15 | `c08e9f6a` | Halloween more (`sandworm_bride/halloween_nun`) | **Functionally present** | `d7c871a3`, identical patch-id. |
| 16 | `d5c2440a` | Replacement glacier-bear Halloween art | **Functionally present** | Its patch-id matches `51d0bcf8`, and the `assets/waifumon/glacier_bear/halloween.{png,webp}` blobs are identical on `Delve`. |
| 3a | *(not an Assteroid commit)* | `captureCapacity` 200 → 2000 | **Intentional Delve change** | `b599e28d` (Delve, 2026-10-01). `Assteroid` has 200; `Delve` has 2000. Confirmed as the intended value. |

**Totals:** 10 functionally present, 2 superseded, 2 merge-only, 1 missing change carried by 2 commits (#3/#4). Nothing is classified as "intentionally obsolete" or "uncertain" at the Git level. Section 10 lists the database-state questions that can only be answered on a copy of production.

---

## 5. Differences in Git-tracked content

Blob comparison of `assets/`, `content/`, `drizzle/` and `portal/public/`:

**Present on `Assteroid` only (3 files)**

| Path | Assessment |
|---|---|
| `assets/bosses/dick-pic-tomancer_boss.webp` | **Missing and required.** See section 9. |
| `drizzle/0045_boss_definitions.sql` | Superseded by Delve `0057` (identical bytes). |
| `drizzle/0046_boss_artwork_assets.sql` | Superseded by Delve `0054` + `0058`. |

**Present on both, content differs (6 files)**

| Path | Difference | Assessment |
|---|---|---|
| `content/bosses.json` | `Delve` lacks `dick_pic_tomancer` and adds 7 bosses (`frieda_cougar`, `the_boomstick_bimbo`, `hellvira_mistress_of_the_snark`, `pain_princess`, `xeno_mommy`, `candy_gobbler`, `the_smothering_spirit`). The other 46 production bosses are field-for-field identical. | Restore the one entry. |
| `content/tables.json` | Only `inventory.captureCapacity` (200 on Assteroid, 2000 on Delve). | Intended. |
| `content/expeditionRewards.json` | `Delve` appends dungeon reward tables (57 lines) and changes nothing that exists. | Superset. |
| `content/expansions/twin_peaks/species/twin_peaks_species.json` | `Delve` adds `dungeonAccess: [{dungeon: "tower_of_picus_dickus", perPlayerLimit: 1}]` to `mountain_rescue_angel`, `yuki_onna_bartender`, `summit_surveyor` and `mineral_spring_divine`. Their tags stay `region_exclusive`, **not** `dungeon_exclusive`, so they keep spawning in the wild. | Additive. |
| `assets/.artwork-manifest.json` | All 1,074 production entries are present and identical; `Delve` has 1,206. | Superset. |
| `drizzle/meta/_journal.json` | Different migration history. | See section 7. |

**Present on `Delve` only:** 12 content files (Equipment, Combat, Trials, NPCs, onboarding, `species/dungeon_exclusives.json`, an example dungeon) and 480 asset files. All 22 species tagged `dungeon_exclusive` on `Delve` are new species that do not exist on `Assteroid`, so no species production players can hunt today becomes un-huntable. Three stray backup files (`content/bosses.json.bak`, `content/combat/enemies.json.bak`, `…twin_peaks_species.json.bak-dungeonaccess`) are tracked but are not loaded: the loader reads fixed filenames and `*.json` only.

**Other config and environment:** `Dockerfile`, `docker-compose.yml`, `.env.example` and `src/config/config.ts` differ only by additions: `ART_CACHE_DIR` and its volume, and `EQUIPMENT_ONBOARDING_ENABLED` (default `false`). Every production setting is kept. `package.json` adds one script, and `portal/package.json` adds `@xyflow/react`.

---

## 6. Startup seeding: can Git content alter production records?

This is what Delve's startup (`src/index.ts`) writes from Git content into an existing production database.

| Seeder | Behaviour on an existing production DB | Risk |
|---|---|---|
| `bootstrapBossDefinitions` (`bossDefinitions.ts:272`, run at `index.ts:1106` and on reload `:1338`) | Table already populated → **inserts only bosses whose key has no row; never updates, re-enables, re-orders or deletes**. The 7 Delve-only bosses arrive **Disabled** (`heldBack`) and need activating in Boss Management. | **The `dick_pic_tomancer` row is not deleted.** It keeps the status it has in production, but its `artwork` path no longer exists on disk (section 9). |
| `seedRewardTables` (`index.ts:1072`; `0047_reward_tables.sql` header) | Inserts any missing table. Updates an existing one only while it still holds the last-seeded content (`content_hash = seed_hash`). `reward_tables` is new to production, so every boss and expedition table is created from `content/bossRewards.json` and `content/expeditionRewards.json`. `bossRewards.json` is identical on both branches. | None. Payouts come from the same definitions production uses now. |
| Open boss encounter at the moment of the switch | `reward_snapshot` is NULL (column added by 0047). `applyParticipationRewards` (`bossEncounterService.ts:~989`) falls back to `liveRewardTable(encounter.rewardTable)`, which is seeded before the scheduler runs. | None. |
| `seedWorldEncounters` / `seedWorldEncounterVendors` (`mode: 'insert-missing'`) | Same as production. `content/encounters/` is identical on both branches. | None. |
| `seedEquipmentDefinitions`, `bootstrapEquipmentRollRules`, `seedCombatEnemies` | Write only to tables new on `Delve`. | None to existing data. |
| Species and region content | Species: a superset with additive `dungeonAccess`. `content/regions/` is identical. Region Pools bootstrap from the same region files. | Covered by the Region Pools parity check in the readiness audit (P2-2). |

No Git content on `Delve` overwrites or disables an existing production record. The only state-related effect is the orphaned artwork path on `dick_pic_tomancer`.

---

## 7. Database and migration risks

- **Ordering.** Production's newest applied migration is `0046_boss_artwork_assets` (`when` 1819640000000). All 32 Delve entries from `0045_equipment_foundation` (1819663200000) to `0076_import_journal_kind` are strictly newer, and Delve's journal is monotonic. The node-postgres migrator therefore applies all 32 in one transaction (`src/db/migrate.ts`). No Delve entry falls at or below production's newest `when`, so none is skipped.
- **Production's 0045/0046 are absent from Delve's journal.** This is harmless. The migrator compares `when` values only and ignores rows in `__drizzle_migrations` that the journal doesn't list. Delve's `0054`, `0057` and `0058` find production's objects already present and are idempotent (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `duplicate_object` guards). The production `artwork_assets_category_check` already includes `boss_art`, and Delve's 0058 rewrites it to the same list.
- **Rehearsed.** The previous audit ran exactly this path on a disposable database: production's 47 migrations, then seeded rows, then **`Delve` as-is**. It applied 79 migrations, the data fingerprints were unchanged, and the schema matched a fresh `Delve` install apart from the column position of `boss_encounters.reward_snapshot`.
- **Rollback.** After the upgrade, an `Assteroid` image's migrator is a no-op, because the newest applied `when` exceeds everything in its journal. The added tables and columns are additive, so the old code ignores them. Data written by the new features will not be understood by the old code, so the paired backup is the real rollback.
- **Remaining requirements:** a maintenance window (32 migrations in one transaction), a fresh paired backup, and a rehearsal on a copy of the production database.

---

## 8. Managed artwork persistence

These are three separate stores, and a branch switch affects them differently:

| Store | Where it lives | Effect of `git checkout Delve` and redeploy |
|---|---|---|
| **Git-tracked artwork** (`assets/…`, including `assets/bosses/*.webp`) | The Git checkout, bind-mounted read-only into the bot at `/app/assets` | **Replaced by `Delve`'s tree.** Files tracked on `Assteroid` but not on `Delve` are **deleted** from the working tree. That applies to exactly one file: `dick-pic-tomancer_boss.webp`. Untracked files in `assets/` are left alone. |
| **Managed artwork bytes** (Portal uploads) | The `waifumon-managed-assets` named volume at `/data/waifumon-assets` | **Unaffected.** Same volume name, same mount, same `MANAGED_ASSETS_DIR` on `Delve`. |
| **Managed artwork metadata** | `artwork_assets` and `artwork_asset_events` in PostgreSQL | **Unaffected.** Same tables; Delve's 0054/0058 are no-ops on them. |
| Composed-scene cache | New `waifumon-art-cache` volume | Created empty on first `up`. Disposable. |

Caveats:

- Compose prefixes volume names with the project name, which defaults to the checkout directory name, because `docker-compose.yml` sets no top-level `name:`. Deploy `Delve` from **the same directory** (or with the same `COMPOSE_PROJECT_NAME`) as production. Otherwise compose creates an empty `…_waifumon-managed-assets` and `…_waifumon-pgdata`, and uploads and data appear to vanish.
- If an admin has already uploaded managed artwork for `dick_pic_tomancer` (`boss_definitions.artwork_asset_id` set), that boss keeps its picture after the switch regardless of the Git file. Check this on a copy of production.
- Back up the managed-assets volume **together with** the database, as `docs/boss-management.md` and the compose comments require.

---

## 9. Genuinely missing changes

**Exactly one: the Dick Pic-tomancer boss** (`e624e693` and `52e52f73`, identical patches).

- **Git content missing on `Delve`:**
  - The `dick_pic_tomancer` object in `content/bosses.json`: `enabled: true`, `artwork: "bosses/dick-pic-tomancer_boss.webp"`, `rewardTable: "standard-scouting-v1"`, `affinity: "dominant"`, plus its prose.
  - `assets/bosses/dick-pic-tomancer_boss.webp` (545,976 bytes).
- **What happens on a direct switch without a fix:**
  1. The production `boss_definitions` row survives: the bootstrap never deletes, and the table is authoritative. If it is Active, the boss keeps spawning.
  2. The shipped image is gone from `ASSETS_DIR`. `resolveBossArtwork` (`src/discord/bossArtwork.ts`) finds no file, and the encounter is announced **text-only** unless a managed upload is assigned.
  3. In the Portal, saving that boss shows the warning *"No file at … — the encounter will render without artwork."* (`bossDefinitionService.ts:406`). This is a warning, not an error.
  4. Any fresh or staging database built from `Delve` never gets the boss at all, so staging won't reproduce production's roster.
- Nothing else is missing. Every other production change is present, superseded by its Delve original, or a merge commit.

---

## 10. Minimum corrective actions before deployment

1. **Restore the Dick Pic-tomancer content on `Delve`.** Bring the `bosses.json` entry and `assets/bosses/dick-pic-tomancer_boss.webp` from `52e52f73` into a small content commit on `Delve`. Merging `Assteroid` is not required.
   - *Alternative with no Git change:* after the switch, upload the same image as managed boss artwork in Portal → Boss Management and assign it to `dick_pic_tomancer`. Staging will still lack the boss, and the Git roster will not match production.
   - *Alternative:* decide the boss is retired and disable it in Boss Management after the switch.
2. **On a restored copy of the production database**, before the deploy:
   - Confirm the `dick_pic_tomancer` row's status and whether `artwork_asset_id` is set.
   - Confirm the 7 new bosses import as Disabled, and decide whether to activate them.
   - Run the standard migration rehearsal on that copy, and the staging acceptance checks from `final-release-readiness-audit.md` §14.
3. **Deploy from the same compose project directory or name**, so the `waifumon-pgdata` and `waifumon-managed-assets` volumes are reused.
4. **Take a paired backup** of the database and the managed-assets volume immediately before the deploy, and schedule a maintenance window for the 32-migration transaction.
5. **Keep `captureCapacity` at 2000.** Nothing to change; note in the release notes that the limit rises from 200 to 2000 for every player.

Optional cleanup, not required for safety: remove the three tracked `.bak` content files. Update `docs/boss-management.md`'s "two lines that must converge" section, which assumes a merge, to describe the direct switch.

Once action 1 is done (or one of its alternatives is chosen and recorded), and the normal backup, migration rehearsal and staging acceptance checks pass, a **direct switch from `Assteroid` to `Delve` is safe**.

---

## 11. Limits of this audit

- No production database or volume was read. Statements about production row state (the `dick_pic_tomancer` status, managed uploads, admin edits to boss definitions) follow from the code's semantics and must be checked on a restored copy (action 2).
- No tests were run for this audit. Build, typecheck and suite results are in `final-release-readiness-audit.md` §12 and were taken on this same `Delve` HEAD (`0bda3fe2`).
