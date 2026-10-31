# Staged Production Rollout Verification

**Date:** 2026-10-30
**Question:** Can `Delve` go to production with `EQUIPMENT_ONBOARDING_ENABLED=false`, so administrators can import, validate and publish dungeon content before any player can reach the new progression?
**Branch:** `Delve` · **HEAD:** `0bda3fe2` (= `origin/Delve`) · **Working tree:** clean apart from the untracked audit documents `final-release-readiness-audit.md`, `assteroid-delve-equivalence-audit.md` and this file.
**Mode:** read-only. No application code, content, migrations or config were changed, and nothing was deployed, restarted or committed. Tests ran against a disposable podman PostgreSQL instance that has since been removed.

---

## 1. Verdict: **CONDITIONAL**

The two-gate strategy works, and **no code change is needed**:

1. **Gate 1, onboarding off.** No player can obtain the `equipment` unlock.
2. **Gate 2, Delve progression.** Without that unlock nobody can open or fight a Combat Trial. Without the unlock plus all three curriculum first clears, nobody can start a dungeon run. Both checks are re-run in the backend inside the write transaction, so stale or forged Discord buttons cannot get past them.

Production can't hold any record that already satisfies Gate 2. The tables involved (`player_feature_unlocks`, `combat_trial_attempts`, `dungeon_runs`, `player_equipment`) don't exist in production's schema today. No migration inserts into them, and nothing except Equipment onboarding writes an `equipment` unlock (§4). While Stage 1 and Stage 2 last, no player can enter a dungeon, whatever its publish or enable state.

The verdict is CONDITIONAL rather than SAFE because of four operational conditions. None of them needs code.

| # | Condition | Why |
|---|---|---|
| C1 | **Before setting the flag to `true`, check every dungeon's enabled state.** Disable any dungeon you don't intend to open. | A dungeon created in the **Portal editor** is created **enabled** (`dungeon_definitions.enabled DEFAULT true`, `0059_dungeon_overhaul_foundation.sql:113`; `create` omits the column, `dungeonContentService.ts:1387`). Publishing it makes it playable at once for anyone past Gate 2. Bundle imports, enemies and shared pools are all created **disabled**. During Stage 2 this exposes nothing, because nobody can pass Gate 2. At Stage 3 it would. |
| C2 | **Change the flag by recreating the bot container (`docker compose up -d waifumon-bot`), not with `docker compose restart`.** | The flag reaches the container through `env_file: .env` and is read once at startup (§2). `restart` keeps the old environment. |
| C3 | **The value must be exactly `true`, `false`, `1` or `0`.** | Anything else, including an empty `EQUIPMENT_ONBOARDING_ENABLED=`, `TRUE` or `yes`, fails config validation and **the bot refuses to start** (verified, §9). |
| C4 | **After the Stage 1 migrations, run the read-only eligibility query in §4.3. Expect every count to be 0.** | This proves the production assumption rather than relying on it. |

The release conditions from the earlier audits still apply as well:
- Restore the Dick Pic-tomancer boss (`assteroid-delve-equivalence-audit.md` §9).
- Paired backup.
- Migration rehearsal on a copy of production.
- Proxy body limits of at least 64 MiB.
- One import at a time.
- Region Pools parity check (`final-release-readiness-audit.md`).

---

## 2. Feature-flag enforcement

**How the flag flows:** `.env` → Compose `env_file: .env` (bot service only, `docker-compose.yml:29`) → `EnvSchema.EQUIPMENT_ONBOARDING_ENABLED` (`src/config/config.ts:126`, enum `true|false|1|0`, default `false`) → `config.equipmentOnboarding.enabled` (`config.ts:554`) → `const equipmentOnboardingEnabled` (`src/index.ts:270`, captured once) → `createEquipmentOnboardingService({ isEnabled: () => equipmentOnboardingEnabled })` (`index.ts:646-653`), and → the level-up label (`index.ts:278`).

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Default | `false`, whether the variable is unset or `false`. | `config.ts:126`; scratch `loadConfig` check (§9) |
| 2 | Read once or dynamically | **Once, at bot startup.** The service calls `isEnabled()` on every request, but that closure returns a constant captured at boot. | `index.ts:270,653`; `equipmentOnboardingService.ts:152` comment ("a future live toggle") |
| 3 | Who reads it | The **bot** container (`waifumon-bot`) only. The Portal container gets no `env_file` and never sees it. | `docker-compose.yml:29` vs the Portal `environment:` block; there are no flag references under `portal/src` |
| 4 | Prevents new onboarding | **Yes, in the backend.** With the flag off, `deriveEquipmentOnboardingState` returns `eligible_unavailable` with `nextStep: null`, and `open`, `advance` and `complete` all return `{kind:'unavailable', reason:'disabled'}` without writing anything. | `onboardingState.ts:60-62`; `equipmentOnboardingService.ts:241-245, 311-316, 318-324, 380-384`; tested (§9) |
| 5 | Affects players already unlocked | **No.** `unlocked` maps to `completed`, which shows as `available` whatever the flag says. The gear, overview, Trials and Delve stay usable. | `onboardingState.ts:57, 75-78`; test "keeps the unlock, the gear and the overview for a completed player" |
| 6 | Prevents Trial entry | **Indirectly.** Trials check the `equipment` unlock (`COMBAT_TRIAL_FEATURE`) on list, open, fight and inside the fight transaction. The flag stops anyone from getting that unlock. | `combatTrialService.ts:108, 381-385, 474-486, 505, 532` |
| 7 | Prevents dungeon entry | **Indirectly.** `start` requires the `equipment` unlock and `delveAccess` (unlock plus all 3 curriculum first clears), both checked inside the transaction under the player lock. The flag isn't read there. | `dungeonRunService.ts:1453-1476`; `trialCurriculum.ts:83-93` |
| 8 | Discord bypasses | **None.** The onboarding buttons go through `ctx.services.equipmentOnboarding` (`waifumonOnboarding.ts:31`, `waifumon.ts:243`). The `Start Run` button calls `dungeonRunService.start` (`waifumonDungeon.ts:331`), the only code path that inserts `dungeon_runs` (`dungeonRunService.ts:1503`). A completion pressed out of order repaints the current step. | Source; tests on stale buttons (§9) |
| 9 | Affects Portal content management | **No.** No admin route or route registration reads the flag (`src/api/routes/v1/index.ts`; there are no flag references under `src/api`). | Source |
| 10 | Restart needed | **Recreate `waifumon-bot`.** The Portal doesn't need touching. | §6 |

**Direct enforcement:** onboarding (`open`, `advance`, `complete`) and the level-35 level-up label.
**Indirect gating:** Trials, Equipment management, Workshop, random Equipment rewards and Delve. All of these hang off the `equipment` unlock, and onboarding is the only thing that can write it.

---

## 3. Records that define eligibility

| Record | Table | Only writer | Notes |
|---|---|---|---|
| Equipment unlock | `player_feature_unlocks (player_id, feature_key='equipment')` | `featureUnlocks.unlock`, called only from `equipmentOnboardingService.complete` (`:344`) | `source` CHECK: `onboarding`, `admin`, `migration`. No code path writes `admin` or `migration`; those values exist only for tests and future backfills. |
| Onboarding progress | `player_equipment` rows carrying the onboarding grant keys | `equipmentOnboardingService` (`:308, :335`) | Derived. No separate "completed" flag exists. |
| Trial first clear | `combat_trial_attempts.first_clear = true` (partial unique index) | `combatTrialService` fight transaction, after `requireUnlocked` (`:532`) | Impossible without the unlock. |
| Delve eligibility | Derived: unlock and all 3 of `COMBAT_TRIAL_CURRICULUM` | `createDelveAccess` (`trialCurriculum.ts:83`) | Never stored. |

---

## 4. Production player eligibility

### 4.1 Could anything satisfy the prerequisites without onboarding?

| Mechanism | Finding |
|---|---|
| Existing production data | **Impossible.** None of `player_feature_unlocks`, `combat_trial_attempts`, `dungeon_runs` or `player_equipment` exists on `Assteroid` (`git grep` over `Assteroid:drizzle` and `src/db/schema.ts` finds none). They are created by Delve migrations 0045, 0048 and 0050/0059. |
| Migrations | **None.** No Delve migration inserts into these tables. 0045 states "Tables only". A search for `INSERT` across 0045–0076 finds none that targets `player_feature_unlocks`, `combat_trial_attempts` or `dungeon_runs`. The ones that exist seed catalogue tables such as `progression_currencies`. |
| Startup seeds | **None.** The seeds write equipment definitions, roll rules, enemies, reward tables, world encounters and bosses. None writes player rows. |
| Admin grant command (`/waifumon-admin grant-item`) | **Can't.** It grants inventory items, and `equipment` is in `ADMIN_UNGRANTABLE_CATEGORIES` (`adminItemGrantService.ts:56`). It never touches unlocks or trial attempts. |
| Staging Test Controls | **Can't grant.** They only reset or revoke the onboarding (`stagingTestControlsService.ts:913`, which uses `revoke`). They are also refused when `DEPLOYMENT_ENV` resolves to `production`, which is what an unset or unknown value resolves to (`config.ts:270-275`). |
| Portal admin APIs | **None** write `player_feature_unlocks` or `combat_trial_attempts`. Those tables are referenced only in `featureUnlockService.ts`, `combatTrialService.ts`, `trialCurriculum.ts` and `schema.ts`. |
| Direct SQL by an operator | The only way. It is outside the application. |

### 4.2 The limitation

**If an `equipment` unlock exists, the flag does not stop that player.** With an unlock and all three first clears, a player can start a run in any published, enabled dungeon in their region, whatever the flag says. This is by design (`onboardingState.ts:72-73`: "the switch gates the onboarding, never an unlock a player already has"). Production can't hold such rows today, so this only matters if someone inserts them by hand. Condition C4 checks for exactly that.

### 4.3 Operator check (aggregates only; do not run against production from here)

Run this after the Stage 1 migrations, on production in a read-only transaction or on a restored copy. Before the deploy, `SELECT to_regclass('public.player_feature_unlocks')` returns NULL on production, which already proves the point.

```sql
BEGIN READ ONLY;
SELECT
  (SELECT count(*) FROM player_feature_unlocks WHERE feature_key = 'equipment')                          AS equipment_unlocks,
  (SELECT count(*) FROM player_feature_unlocks WHERE feature_key = 'equipment' AND source <> 'onboarding') AS non_onboarding_unlocks,
  (SELECT count(DISTINCT player_id) FROM combat_trial_attempts)                                          AS players_with_trial_attempts,
  (SELECT count(*) FROM (
     SELECT a.player_id
       FROM combat_trial_attempts a
       JOIN player_feature_unlocks u ON u.player_id = a.player_id AND u.feature_key = 'equipment'
      WHERE a.first_clear
        AND a.trial_key IN ('trial_scrapyard_drone', 'trial_alley_bruiser', 'trial_security_automaton')
      GROUP BY a.player_id
     HAVING count(DISTINCT a.trial_key) = 3) eligible)                                                     AS delve_eligible_players,
  (SELECT count(*) FROM player_equipment)                                                                AS equipment_instances,
  (SELECT count(*) FROM dungeon_runs)                                                                    AS dungeon_runs,
  (SELECT count(*) FROM dungeon_definitions WHERE enabled AND published_revision_id IS NOT NULL)         AS open_dungeons;
ROLLBACK;
```

**Expected during Stage 1:** every column 0. During Stage 2, `open_dungeons` may rise, but the player columns must stay 0. A non-zero player column before Stage 3 means a row was written outside the application, and needs looking into before the flag goes on. *(The query was checked against a scratch database migrated to Delve HEAD with 77 migrations, and returned all zeros.)*

---

## 5. Private admin preparation (onboarding off)

No admin capability depends on the flag. Everything is gated by Portal permissions checked in the backend.

| Task | Possible with the flag off | Backend gate | State after |
|---|---|---|---|
| Use the Admin Portal | Yes | Portal session and permissions (`portalAuthService.ts`) | n/a |
| Import enemy ZIPs and artwork | Yes | `enemies.write`, `artwork.write` (`enemyPackages.ts`) | Enemies created **disabled** |
| Import and enable shared Dungeon WaifuMon Pools | Yes | `dungeons.write` (`dungeonSpeciesPools.ts`) | Pools created **disabled**; enabling is a separate step, and publication refuses a disabled pool (`species_pool_missing`) |
| Import complete Dungeon Bundle ZIPs | Yes | `dungeons.write`, `enemies.write`, `artwork.write` (`dungeonBundles.ts`) | Dungeon created **disabled and unpublished** (`dungeonImportService.ts:892-895`); result shows `needs_enabling` and `remainsDisabled` |
| Configure Species Access | Yes | `dungeons.write` (draft edit) | Takes effect on publish |
| Validate | Yes | `dungeons.read` (validate writes nothing) | n/a |
| Publish / roll back | Yes | `dungeons.publish` | Publishing sets `published_revision_id` only and **never changes `enabled`** (`dungeonContentService.ts:1516, 1576`) |
| Keep published dungeons disabled | Yes | `dungeons.write` → `setEnabled` (`:1592`) | `openDungeons` and `published()` both require `enabled` |
| Dependency warnings, export, reimport | Yes | `dungeons.read` / `dungeons.write` | n/a |
| Sandbox playthrough | Yes | `dungeons.read` | Writes nothing |

Nothing shared blocks admin work while onboarding is off. **One related caveat:** onboarding *readiness* (the three starter equipment definitions, with rolls in range, and the narrative) is checked separately from the flag. If an admin retunes a starter definition in the Equipment Catalogue during Stage 2 so its fixed roll falls out of range, onboarding will report **not ready** when the flag goes on (`equipmentOnboardingService.ts:181-201`). Check the `equipment-onboarding/readiness` startup log line before Stage 3.

---

## 6. Dungeon activation matrix

"Entry" means `dungeonRunService.start` and the menu, which run the same checks. `start` checks, in order inside one transaction: `equipment` unlock → no active run → `delveAccess` → `published()` (missing, disabled or unpublished is refused) → region.

| Onboarding | Trials completed | Published | Enabled | New entry | Enforced by | Evidence |
|---|---|---|---|---|---|---|
| Disabled | No | Yes | Yes | **Denied** | No unlock possible → `requireUnlocked` | Tested: onboarding-off suite; `trialsDelveProgression` "Trials and Delve are hidden and every entry is refused as locked" |
| Disabled | No | Yes | No | **Denied** | Unlock, then `published()` → `disabled` | Tested (both gates separately) |
| Enabled | No | Yes | Yes | **Denied** | `requireDelve` → `DelveLockedError` | Tested: "no Trial cleared: … Delve hidden even with a live dungeon here"; "some Trials cleared … Delve stays locked"; "a previously rendered Delve button cannot bypass the prerequisite" |
| Enabled | Yes | Yes | No | **Denied** | `published()` → `disabled` | Tested: `dungeonRuns` "refuses a dungeon that is missing, unpublished, disabled or not available where the player stands"; "disabling or unpublishing the dungeon after the menu was drawn prevents entry" |
| Enabled | Yes | No | Yes | **Denied** | `published()` → `unpublished` | Tested (same two tests) |
| Enabled | Yes | Yes | Yes | **Allowed**, subject to region, Buddy, loadout and daily limit | All gates pass | Tested: "clearing it opens Delve, retires the Trials…"; "region and publication checks still apply once Delve is unlocked" |
| **Disabled** | **Yes (pre-existing records)** | Yes | Yes | **Allowed** | The flag isn't consulted | Source (§4.2). Production can't hold such records; C4 confirms it. |

**Is "onboarding off plus dungeons disabled" enough for private preparation?** Yes. In fact onboarding off is enough on its own, because it makes Gate 2 unreachable. Keeping dungeons disabled is the second layer, and it becomes the **primary** control at Stage 3 (C1). No extra flag is needed, because no bypass exists.

Already-active runs (none can exist before Stage 3): `act`, `run` and `activeRun` require only the `equipment` unlock, not `delveAccess` or `enabled`. A run plays out on its pinned revision, and **abandon needs no unlock at all** (`dungeonRunService.ts:1687`). Tested: "stays reachable, playable and extractable, including after a restart"; "can always be abandoned"; "keeps an active run playable after the player travels away"; retreat and extract flows in `dungeonRuns`.

---

## 7. Release transition (flag false → true)

| Item | Finding |
|---|---|
| Where to change it | The production `.env` on the host, as `EQUIPMENT_ONBOARDING_ENABLED=true`. `docker-compose.yml` sets nothing for it. |
| What must restart | **`waifumon-bot` only, and it must be recreated.** `docker compose restart waifumon-bot` restarts the existing container with its *original* environment, so it would not pick up the new `env_file` value. `docker compose up -d waifumon-bot` sees the changed config and recreates the container. No `--build` is needed, because the image doesn't change. Leave the Portal and Postgres alone. |
| Cached at startup | Yes (`index.ts:270`), hence the recreate. |
| Migrations rerun | `runMigrations` runs on every boot; with nothing new to apply it is a no-op. The startup seeds run again too, and are insert-missing or unchanged-only. |
| Imported dungeon content | Kept. It lives in PostgreSQL (`dungeon_definitions`, `dungeon_revisions`, pools, enemies) and the `waifumon-managed-assets` volume, and recreating the bot doesn't touch either. |
| Onboarding offered immediately | Yes, to players at level 35 or above, on their next menu open. The level-up label shows only when a player *reaches* level 35 after the change (`onboardingState.ts:94-101`). |
| Unlock exposes Trials | Yes. Tested: "stay closed through every onboarding step and open the moment completion unlocks". |
| Trials retire after the 3 clears, Delve opens | Yes. Tested: "clearing it opens Delve, retires the Trials and announces the unlock once"; stale-button tests. |
| Delve hidden where nothing is open | Yes. `entryVisible` needs at least one `openDungeons` entry whose `availableRegions` includes the player's region (`dungeonRunService.ts:1600-1606`). Tested: "stays hidden in every region until the Trials are cleared"; "region and publication checks still apply". |
| Correction to an earlier doc | `final-release-readiness-audit.md` §15 step 16 says "restart the bot". It should say **`docker compose up -d waifumon-bot`**. |

---

## 8. What players see during preparation (Stages 1–2)

**Live as soon as `Delve` is deployed, not gated by onboarding:**

| System | What changes |
|---|---|
| Capture capacity | 200 → **2,000** for every player (intended). |
| Region Pools | Hunting draws come from the Region Pools service, bootstrapped from the region files. These are identical on both branches, but the draw engine is new. **Run the parity check in staging** (readiness audit P2-2). |
| Bosses | Boss definitions and schedules are unchanged. Reward tables now come from the DB, seeded from the identical `bossRewards.json`. The 7 new Delve bosses arrive **Disabled**. Dick Pic-tomancer needs its content restored. |
| Reward tables | Boss and expedition tables move to the DB. The values are unchanged; Delve only appends the dungeon expedition tables, which nothing outside dungeons uses. |
| World encounters, items, shop, expeditions | Content identical to production. New encounter-pool selection code, same content. |
| Species and appearances | 22 new species, all `dungeon_exclusive`, so never met in the wild. 4 existing Twin Peeks species gain a `dungeonAccess` entry and stay wild. |
| Currency columns | `salvaged_components` (0049) and the dungeon progression currency exist with a balance of 0. Whether any profile or balance screen shows them before the unlock needs **staging confirmation**. |
| Discord menu | Unchanged for locked players: Equipment, Trials and Delve stay hidden (`trialsDelveNavigation` "neither entry shows before Equipment is unlocked"). |

**Gated behind the `equipment` unlock, so unreachable while onboarding is off:** Equipment onboarding (Patch), equipment management and loadouts, Workshop (`equipmentWorkshopService.ts:338`), random Equipment drops from bosses, expeditions and encounters (`equipmentRewardService.ts:265-270`; locked boss participants roll with gear removed), Combat Trials, and Delve and dungeon runs.

---

## 9. Tests and evidence

**Run on a disposable PostgreSQL 16 instance against `Delve` HEAD `0bda3fe2`. All green.**

| Suite | Result | Covers |
|---|---|---|
| `integration/equipmentOnboarding` | pass | Flag off: hidden, `open`/`advance`/`complete` refused with no writes; pause and resume; completed player keeps the unlock with the flag off; stale buttons; concurrent completion |
| `unit/equipmentOnboardingDiscord` | pass | Discord: switched off shows "not available"; entry absent while hidden |
| `integration/combatTrials` | pass | Locked player can't list, open or fight |
| `integration/trialsDelveProgression` | pass | The full matrix rows; stale and forged Delve buttons; disable or unpublish after the menu was drawn; per-region visibility; active run reachable, extractable and abandonable after a restart |
| `unit/trialsDelveNavigation` | pass | Menu permutations; curriculum carried in the shipped `trials.json` |
| `integration/dungeonRuns` | pass | Locked, unpublished, disabled and wrong-region refusals; stale interactions; retreat, extract, abandon; restart re-entry; editor-created dungeon playable straight after publish (the C1 default) |
| `integration/dungeonDiscord` | pass | Unpublished or disabled not listed; locked view on every route |
| `integration/api/adminDungeons`, `dungeonImportV2`, `dungeonSharedPools`, `dungeonOwnedSpeciesAccess` | pass | Authoring, publish, species access; import → `enabled: false` |
| **Subtotal** | **11 files, 299 tests passed** | |
| `integration/dungeonBundles`, `integration/enemyPackages` | **2 files, 54 passed** | Bundle and enemy ZIP import; created disabled; `needs_enabling` |
| `integration/dungeonImport`, `integration/dungeonImportLifecycle` | **2 files, 27 passed** | Import lifecycle and replacement keep the enabled state |

**Scratch checks, outside the repository:**
- `loadConfig` with the real schema: unset, `false` or `0` → `{enabled:false}`; `true` or `1` → `{enabled:true}`; `TRUE`, `yes` or empty → **throws "Invalid environment configuration"** (C3).
- The §4.3 query against a scratch database migrated to Delve: executes, read-only, all 0.

**Evidence status per conclusion:**

| Conclusion | Status |
|---|---|
| Onboarding off prevents new unlocks | Verified by test |
| Trials need authorization | Verified by test |
| Delve entry fails without the curriculum | Verified by test |
| Disabled dungeon refuses entry whatever the progression | Verified by test |
| Editor-created dungeons default to enabled | Verified by source and test |
| Bundle, enemy and pool imports arrive disabled | Verified by test |
| Admin import and publish don't depend on the flag | Verified by source; the tests exercise them without it |
| Active runs resume, retreat, extract and abandon | Verified by test |
| Flag parsed once at startup; recreate needed | Parsing verified by scratch script; read-once and Compose behaviour **verified by source only**, so confirm in staging |
| Stale and direct interaction enforcement | Verified by test |
| Region-specific Delve visibility | Verified by test |
| No production player can already be eligible | Verified by source and schema; **operator confirms with §4.3** |
| Player-facing surfaces in Stages 1–2 (§8) | Source inspection; **needs staging confirmation** |
| A live deployment | **Not tested.** No deployment was run. |

---

## 10. Operational limitations

- **No live toggle.** Changing the flag means recreating the bot, which drops Discord sessions briefly. Schedule it.
- **The flag can't close Delve.** Turning onboarding back off stops *new* onboarding only. Players who have already unlocked keep Trials and Delve. To close dungeons, disable the dungeons (§12).
- **Editor-created dungeons start enabled** (C1). Prefer bundle import for production content, or disable straight after creating in the editor.
- **Config typos stop the bot** (C3).
- **Readiness can regress** if starter equipment definitions are retuned (§5).
- **Disabling the progression currency** makes active runs settle *without banking* (`dungeonRunService.ts:1321-1327`; tested "ends the run without banking when the currency was switched off under it"). Don't use it as an emergency switch.

---

## 11. Required pre-deployment checks

1. All conditions from `assteroid-delve-equivalence-audit.md` §10: Dick Pic-tomancer content, same compose project directory or name, paired backup, maintenance window.
2. Production `.env` contains exactly `EQUIPMENT_ONBOARDING_ENABLED=false` (C3). `DEPLOYMENT_ENV` is unset or `production`, and `ENABLE_TEST_ADMIN_CONTROLS` is unset or `false`.
3. Upstream proxy body limit is at least 64 MiB; one import at a time.
4. Staging rehearsal on a production copy: migrations, smoke test, Region Pools parity, and the §8 currency display question.

---

## 12. Approved rollout sequence

### Stage 1: deploy with onboarding off

1. **Back up:** `pg_dump` of the production database **and** an archive of the `waifumon-managed-assets` volume, taken together. Practise restoring them.
2. **Keep the Compose identity:** work in the same checkout directory, or set the same `COMPOSE_PROJECT_NAME`, so the `waifumon-pgdata` and `waifumon-managed-assets` volumes are reused. Never run `down -v`.
3. **Switch the code:** check out the validated `Delve` commit, with Dick Pic-tomancer restored.
4. **Set the flag:** set `EQUIPMENT_ONBOARDING_ENABLED=false` in `.env`.
5. **Build and start:**
   - `docker compose up -d --build waifumon-bot`. Migrations run at bot startup: 32 new, in one transaction.
   - `docker compose --profile portal up -d --build waifumon-portal`.
6. **Check the logs:** expect "migrations complete", `equipment-onboarding/readiness` with `enabled:false, ready:true`, the boss bootstrap with 7 held back, and the reward-table seed.
7. **Run the §4.3 query (C4).** Every column must be 0.
8. **Smoke-test existing gameplay** with a normal account: hunt, capture (the capacity is now 2,000), daily, shop, travel, expeditions, a boss encounter, the gallery and profile. Confirm the menu shows no Equipment, Trials or Delve entry.

### Stage 2: prepare content privately

9. **Import content** in this order:
   1. Enemy ZIPs.
   2. Shared Dungeon WaifuMon Pools.
   3. Dungeon Bundle ZIPs, one at a time.
10. **Resolve and validate:** work through the dependency warnings and Keep/Update decisions, enable the required shared pools, configure Species Access, and validate.
11. **Publish while keeping dungeons disabled:**
    - Publish each dungeon.
    - **Leave it disabled.** If it was created in the editor, disable it now.
    - Re-run §4.3: the player columns stay 0.
12. **Confirm readiness:** the `equipment-onboarding/readiness` log line is still `ready:true`, and no starter definitions were retuned.

### Stage 3: open the release

13. **Audit dungeon states (C1):** in Portal → Dungeons, check that every dungeon is **Disabled**, except any you deliberately want open the moment players finish the Trials.
14. **Flip the flag:** set `EQUIPMENT_ONBOARDING_ENABLED=true` in `.env` (C3).
15. **Recreate the bot:** `docker compose up -d waifumon-bot`. **Not `restart`.** Leave the Portal and Postgres alone.
16. **Check the log:** expect `equipment-onboarding/readiness` with `enabled:true, ready:true`.
17. **Walk the path with a test account at level 35 or above:**
    - Onboarding completes, and Trials appear.
    - All three Trials clear, then the Trials retire.
    - Delve is still **hidden**, because no dungeon is enabled yet.
18. **Enable the first dungeon:** Portal → Dungeons → *Enable*. This takes effect immediately; no restart is needed.
    - With the test account, Delve appears only in that dungeon's regions.
    - Start, play, retreat or extract, and check that rewards settle.
19. **Monitor launch:**
    - Errors: `dungeons/start-failed`, `dungeons/unreadable-revision`, `dungeons/banking-skipped`, `equipment-onboarding/not-ready`.
    - The daily-limit refusal rate.
    - Boss and hunt error rates.
    - Counts: re-run §4.3 periodically.
    - Database load during the first hour.

### Emergency: close new dungeon entry without stranding runs

1. **Disable the dungeon(s)** in Portal → Dungeons (`setEnabled(false)`, `dungeons.write`).
   - This takes effect immediately. The start transaction and the menu re-read `enabled`, and stale `Start Run` buttons are refused.
   - Active runs are untouched: they play out on their pinned revision and can still retreat, extract or abandon.
2. **Do not:**
   - Unpublish or roll back as a closing measure.
   - Disable the progression currency (runs would settle without banking).
   - Disable shared pools that active runs depend on.
   - Revoke `equipment` unlocks (active runs would need abandoning, since `act` requires the unlock).
3. **Optionally, also stop new onboarding:** set the flag to `false` and run `docker compose up -d waifumon-bot`. This doesn't close Delve for players who have already unlocked, and isn't needed to close dungeons.
4. **For a full rollback:** restore the paired backup (`final-release-readiness-audit.md` §16). Anything written after the deploy is lost.

---

## 13. Release blockers

**None from the staged-rollout strategy itself.** No code change and no extra flag are needed. Conditions C1–C4 are operational. The blockers already recorded elsewhere still stand: Dick Pic-tomancer content, plus the backup, rehearsal and proxy-limit prerequisites.
