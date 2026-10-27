# Equipment 3.0 — E3-A Completion Report

Phase: **E3-A — Foundations, compatibility and effective SP.** Uncommitted, for review. E3-B was not started.

Design source: [equipment-3-architecture.md](equipment-3-architecture.md) (Revision 2).

---

## 1. Repository state

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `3fbb802` (unchanged; nothing committed) |
| Initial working tree | Clean apart from the untracked `docs/equipment/` (the architecture document) |
| Final working tree | 36 modified tracked files, 9 new files (8 code/test/migration files + this report), all listed in §2. No unrelated changes. |
| Latest migration before | `0069_region_pools` |
| Migration added | `0070_equipment_three_bonuses` |

**Restored files.**

- `tests/integration/__snapshots__/captureExtraction.test.ts.snap` is rewritten with LF line endings by every full root test run, at baseline too. Its content is unchanged.
- It was restored with `git checkout` after each run. It is not part of this change.

---

## 2. Exact changes

### Backend — implemented behaviour

| File | Change |
| --- | --- |
| `src/modules/equipment/vocabulary.ts` | Four independent rarity-capability lists, documented together. `EQUIPMENT_AUTHORING_RARITIES` = N…LR; LR is newly authorable; EX is still withheld. New `EQUIPMENT_RANDOM_ROLL_RARITIES` = N/R/SR. Flat SP ceilings `EQUIPMENT_FLAT_SP_MAX_PER_ITEM = 200` and `EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT = 400`. |
| `src/modules/equipment/rewardSelector.ts` | `EQUIPMENT_REWARD_RARITIES` is now its own literal N/R/SR list. It is no longer an alias of the affix rarities. |
| `src/modules/equipment/workshopConfig.ts` | `WORKSHOP_RECIPE_RARITIES` is now its own literal N/R/SR list. |
| `src/modules/equipment/combatBonuses.ts` | `MAX_COMBAT_BONUSES_PER_ITEM` 2 → 3. New `MAX_LEGACY_RULE_BONUS_COUNT = 2` caps the shipped N/R/SR rules. `COMBAT_BONUS_RARITIES` is its own literal list. `flat_sp` is a storable family (`EQUIPMENT_BONUS_STATS`, appended last so existing canonical orders never move). Labels and formatting (`+11 SP`). `additionalFlatSpOf`. `aggregateCombatBonuses` skips `flat_sp`. `rollCombatBonuses` returns only the five modifier families. |
| `src/modules/equipment/equipmentRoll.ts` | `EquipmentRoll.flatSp?` (optional; random rolls never set it). `rolledPropertiesOf`. `validateFixedRoll` accepts `flatSp` and enforces the per-copy ceiling on primary + additional SP. |
| `src/modules/equipment/equipmentMath.ts` | Formula version **3**. `PRIMARY_FLAT_SP_PROPERTY`, `readPrimaryFlatSp`, `itemFlatSpOf`, `flatSpOf` and the `CombatSp` type. `assembleCombatStats` computes effective SP once and derives every stat from it. `CombatStats.sp`. |
| `src/modules/equipment/combatStatsService.ts` | `previewSlot` candidates also return `stats` (all three) and per-stat `deltas`. |
| `src/modules/equipment/equipmentService.ts` | Fixed grants accept `flatSp` and store it as `rolled_properties.flatSp`. Groups key on `rolled_properties`. Grant-replay placeholders keep `flatSp`. The grant event metadata records `rolledProperties`. |
| `src/modules/equipment/equipmentDefinitionService.ts` | New `assertReferencedFieldsUnchanged`: a slot **or rarity** change on a referenced definition is refused. Removed copies count. |
| `src/modules/equipment/equipmentPackage.ts` | The import planner refuses a rarity change on a referenced definition. |
| `src/modules/equipment/seed.ts` | The reset seed applies the same rule. |
| `src/modules/equipment/definitionSchema.ts` | Rarity doc comment (LR authorable; frozen once referenced). |
| `src/shared/errors.ts`, `src/api/errors.ts` | `EquipmentRarityLockedError` → `EQUIPMENT_RARITY_LOCKED` (409). |
| `src/db/schema.ts` | The CHECK mirror is now `<= 3`. Column docs for `combat_bonuses` and `rolled_properties`. |
| `drizzle/0070_equipment_three_bonuses.sql`, `drizzle/meta/_journal.json` | The migration (§3). |
| `src/modules/dungeons/dungeonFighter.ts` | The fighter also freezes `equipmentSp` and `effectiveSp` (display only). `currentSp` stays natural. |
| `src/api/schemas/equipment.ts`, `src/api/routes/v1/equipment.ts` | See §6. |
| `src/discord/combatSpFormat.ts` (new); equipment, onboarding, Combat Trial and dungeon presenters | See §6. |

### Portal

- `portal/src/api/types.ts`: new optional fields that mirror the API.
- `portal/msw/equipment.ts`: the fake server derives stats from effective SP.
- `LoadoutSummary.tsx`: the combat-SP line.
- `EquipmentDetailDialog.tsx`: other-stat change rows.

### Tests

**New:**

- `tests/unit/equipmentRollGolden.test.ts` plus the `tests/fixtures/equipmentRollGolden.json` fixture (§8);
- `tests/unit/equipmentEffectiveSp.test.ts` (28);
- `tests/unit/equipmentRarityCapabilities.test.ts` (21);
- `tests/integration/equipment3Foundations.test.ts` (19);
- `tests/integration/dungeonEffectiveSp.test.ts` (2);
- a Portal "flat SP" block in `EquipmentPage.test.tsx` (3).

**Updated** where they pinned the old limits or exact old shapes:

- unit `equipmentCombatBonuses.test.ts`: max 2 → 3, and formula version 2 → 3;
- unit `equipmentDefinitionSchema.test.ts`: LR is now authorable;
- integration `equipmentCombatBonuses.test.ts`: the service and the database now refuse a *fourth* bonus;
- integration `equipmentManagement.test.ts` and `equipmentRolls.test.ts`: an unavailable preview candidate also carries `stats: null` and null `deltas`;
- integration `api/equipmentPortal.test.ts`: bonus resources carry `sp: null`, and the comparison gains `changes`;
- two Discord fixture builders gained `rolledProperties: {}`.

---

## 3. Migration `0070_equipment_three_bonuses`

```sql
ALTER TABLE "player_equipment" DROP CONSTRAINT IF EXISTS "player_equipment_combat_bonuses_check";
ALTER TABLE "player_equipment" ADD CONSTRAINT "player_equipment_combat_bonuses_check"
  CHECK (jsonb_typeof("combat_bonuses") = 'array' and jsonb_array_length("combat_bonuses") <= 3);
```

- **Verified the old constraint first.** At HEAD it was exactly the `0056` form, `<= 2`, mirrored in `schema.ts`.
- **Verified against PostgreSQL 16** (Testcontainers), in `equipment3Foundations.test.ts`:
  - the live constraint reads `<= 3`;
  - three distinct bonuses insert; four are refused with SQLSTATE `23514`;
  - restoring the `0056` constraint over rows with zero, one and two bonuses, then applying the migration **twice**, leaves those rows byte-identical;
  - the result is exactly one constraint, fully validated (`convalidated = true`);
  - every migration test database in the suite also runs the full migration chain.
- **Rollback is unsafe once any copy holds three bonuses.** Re-adding `<= 2` would then fail, or require deleting player data. Before such a copy exists, restoring the `0056` form is safe. The migration header records this.
- No N/R/SR rule can produce a third bonus: `MAX_LEGACY_RULE_BONUS_COUNT = 2`, and `combatBonuses.json` is unchanged.

---

## 4. Flat SP storage and calculation semantics

**Storage.** Both kinds are snapshotted per copy at grant and never recalculated.

| Source | Stored at | Consumes a bonus slot |
| --- | --- | --- |
| Primary flat SP | `player_equipment.rolled_properties` → `{ "flatSp": n }` | No |
| Additional flat SP | `player_equipment.combat_bonuses` → `{ "stat": "flat_sp", "valueBp": n }`, where `valueBp` holds **whole SP** for this family | Yes |

- **No SP → `{}`.** A copy without primary SP stores `{}`, exactly as every pre-3.0 copy does. N/R/SR random rolls never set it, so their rows are unchanged.
- **Naming.** The E3-A brief named the primary key `flatSp`. The architecture document's draft name, `primarySp`, was not used.

**Calculation.** The single place is `assembleCombatStats`; nothing else adds SP.

```text
naturalSp        = currentSeductivePower(baseSp, level, maxLevel)              (unchanged, never written)
item contribution = min(primary flatSp + additional flat_sp, 200)              per equipped copy
equipmentBonus   = min(Σ item contributions, 400)                              per loadout
effectiveSp      = naturalSp + equipmentBonus
ATK / DEF / HP   = deriveStat(effectiveSp, each item's rolled multiplier)
combatModifiers  = aggregateCombatBonuses(items)                               (flat_sp skipped)
```

**Safety rules.**

- Values are non-negative whole SP. Malformed stored values read as 0 and never throw.
- Each copy counts once, and empty slots add nothing.
- Every term is a stored integer, so effective SP can't feed back into itself.
- `flat_sp` never reaches `CombatModifiers`; the combat caps are unchanged.
- **Per-copy ceiling (200).** Enforced **before storage**: `validateFixedRoll` refuses `flatSp` outside 0–200 and refuses a primary + additional total above 200, and `combatBonusListIssues` refuses `flat_sp` outside 1–200. A stored copy over the ceiling (only possible by writing the table directly) is clamped to 200 on read.
- **Per-loadout ceiling (400).** Applied deterministically and order-independently, the same model as the combat-modifier caps.
  - Every copy keeps its stored values; only the amount added to SP is clamped.
  - `CombatStats.sp` reports `primaryFlat` and `additionalFlat` uncut, plus `capped: true`, so nothing is silently discarded from the record.

`CombatStats.sp = { natural, primaryFlat, additionalFlat, equipmentBonus, effective, capped }`. It is null without a Buddy. `CombatBuddy.currentSp` stays the natural value.

**Not changed:**

- progression and leveling;
- Buddy bonuses;
- boss participation (`bossEncounterService` uses natural SP directly);
- World Encounter checks (`worldEncounterService.safeCurrentSp`);
- dungeon event skill checks, which read `DungeonFighter.currentSp` — still natural.

---

## 5. Formula version and snapshot compatibility

`EQUIPMENT_FORMULA_VERSION` is **3**. Without flat SP, formula 3 gives exactly formula 2's numbers. This is tested over a range of SP values, and against the onboarding starters.

| Snapshot | Behaviour |
| --- | --- |
| Dungeon runs | `fighterFromCombatStats` freezes ATK, DEF and HP derived from effective SP, and also records `equipmentSp` and `effectiveSp` for display. A run under way is **not** recalculated: tested by changing gear mid-run, reading the run back, and reading it again through a restarted run service. Older runs lack the two new optional fields; nothing requires them. |
| Combat Trials | Each attempt stores the derived ATK, DEF and HP and an `initial_state` engine snapshot. New attempts use effective-SP stats; stored attempts are untouched. Tested. |
| Formula-2 snapshots | Nothing re-reads a stored `CombatStats` for arithmetic. `CombatStats.sp` is documented as absent from formula-2 snapshots. |

**Surfaces checked:**

- Onboarding: unchanged values. Its explanation line now multiplies the SP the stat actually used.
- Buddy Inspect, Care Mode and Player Profile: these show natural SP only and do not read equipment stats (`trainerProfile.ts` uses `currentSeductivePower` directly). They are unchanged, which is correct.

---

## 6. Preview and display changes

**Preview.** `previewSlot` keeps `value` and `delta` (the slot's own stat) and adds `stats` and `deltas` for all three stats, from the same `assembleCombatStats` call.

**API:**

- Item `combatBonuses` entries gain `sp` (whole SP for `flat_sp`). `percent` is null for `flat_sp`.
- Items gain `primarySp` and `spBonus`.
- The overview `buddy` gains `equipmentSp` and `effectiveSp`; `currentSp` stays natural.
- The item comparison gains `changes` (current, with-item and delta for each stat).
- Loadout modifier rows keep the five-family enum.
- Field descriptions saying "none, one or two" now say "none to three".

**Discord.** A shared `gearSpSuffix` appends ` · Gear +31 SP → 281 combat SP` to the existing Current SP lines on:

- equipment home and item;
- onboarding;
- the Combat Trial screen;
- the dungeon pre-run screen.

The item comparison adds `Also: DEF +12 · HP +60` when other stats move. **With no gear SP, every line is byte-identical to before.**

**Portal.**

- The loadout card shows "Gear +30 SP → 450 combat SP" under the natural-SP line, only when gear adds SP.
- The item comparison lists the other stats that would change.
- No other layout changes.

**Grouping.** `listEquipmentGroups` groups on `rolled_properties` too, so copies with different primary SP are separate. Old `{}` copies still group together, which is tested.

---

## 7. Rarity compatibility and reward-selection safeguards

| List | Value | Used by |
| --- | --- | --- |
| `EQUIPMENT_AUTHORING_RARITIES` | N, R, SR, SSR, UR, **LR** | definition schema |
| `EQUIPMENT_RANDOM_ROLL_RARITIES` | N, R, SR | documentation / future engine (random rolls still fail closed via the affix pool) |
| `EQUIPMENT_REWARD_RARITIES` | N, R, SR | selectors, dungeon loot resolver and reward snapshot schemas |
| `WORKSHOP_RECIPE_RARITIES` | N, R, SR | Workshop recipes and salvage |
| `COMBAT_BONUS_RARITIES` / `EQUIPMENT_AFFIX_RARITIES` | N, R, SR | shipped bonus rules / affix pools |

**What the tests prove:**

- The lists are distinct arrays.
- Every default selector shape resolves only N/R/SR, and resolves an *identical* set whether or not enabled SSR, UR and LR definitions exist.
- SSR, UR and LR can't be named by a selector, whitelisted, or put in a Workshop recipe.
- A random SSR, UR or LR roll throws the existing unsupported-pool error **before drawing anything**.

**Rarity lock.** Key immutable (unchanged), slot frozen (unchanged), and rarity frozen once any copy references the definition, removed copies included. This holds through the service (`EQUIPMENT_RARITY_LOCKED`, 409), package import (whole package refused) and the reset seed. Other fields stay editable, and owned rolls are never touched by an edit. All tested.

**No existing definition, content file, probability, range or reward table was changed.**

---

## 8. Deterministic 6,000-roll regression gate

- `tests/unit/equipmentRollGolden.test.ts` rolls all **30 shipped definitions × 200 seeds**. The seed for roll `n` of definition `i` is `(i + 1) × 1000 + n`.
- It uses the real `rollEquipmentInstance` with the shipped `affixes.json` and `combatBonuses.json`.
- For each roll it records the multiplier, the affix key, the bonus families and magnitudes in order, and **every RNG call** (bounds and result, in sequence).
- The fixture `tests/fixtures/equipmentRollGolden.json` (sha256 `308b5a81…69ee13`) was **recorded before any source change**, at `3fbb802`.

**Result: 6,000 / 6,000 identical** — multipliers, affix keys, bonus families, magnitudes, and RNG draw counts and order. The gate was re-run after every backend change.

Related reproducibility suites pass unchanged: `equipmentSeededRewards` (dungeon seeded grants), `equipmentRolls`, `equipmentRewards`, `equipmentWorkshop`, `bossEquipmentRewards`, `expeditionEquipmentRewards` and `worldEncounterEquipment`. New N/R/SR rows store `rolled_properties = {}`, as before.

---

## 9. Tests, builds and baseline comparison

| Check | Result |
| --- | --- |
| Backend typecheck (`npm run typecheck`) | Clean |
| Backend build (`npm run build`) | Clean |
| Portal typecheck | Clean |
| Portal ESLint (changed files) | Clean |
| Portal Prettier (changed files) | Clean for the three files that were clean at HEAD. `msw/equipment.ts` and `src/api/types.ts` were already flagged at HEAD. |
| Portal build | `npm run build` is refused by the repository's own guard (`verify-build-env`) because a local `portal/.env.local` exists on this machine; that file was left alone. The bundler was verified with `vite build --mode e2e` into a scratch folder outside the repository: built successfully. The output was then deleted. |
| `git diff --check` (+ trailing-whitespace scan of new files) | Clean |
| Golden gate | 6,000 / 6,000 |
| New focused tests | 28 + 21 unit, 19 + 2 integration, 3 Portal — all pass |
| Portal equipment tests | 59 / 59 |

**Root suite comparison.** The baseline is a full run at `3fbb802` before any change: 8,849 tests, **172 failed**.

**After the full run** (8,924 tests): 178 failed.

- 172 are the baseline failures, all still present and none fixed.
- **6 were new, and all were intended contract changes** pinned by exact assertions: the old two-bonus maximum, twice; the unavailable-preview shape, twice; the API bonus and comparison shapes, twice. Those tests were updated (§2) and their four files now pass, 151 / 151.

**Focused re-run** of every equipment, combat, Trial, onboarding, dungeon, boss, expedition and World Encounter file (187 files, 4,363 tests) after the updates:

- 47 failed, against 46 baseline failures in those files.
- The one difference is `bossScheduler` ("suspends with an actionable message when the channel disappears"). Run alone twice, the file fails exactly its five baseline tests and that one passes. It is a load-dependent scheduler test that touches no equipment code.
- **No regression remains.**

**Portal suite comparison.** The baseline is a full run on a clean worktree of `3fbb802`: 1,840 tests, 24 failed. After: 1,843 tests, 16 failed.

- The failing *set* moves between runs: 11 tests that failed on HEAD passed afterwards, including two equipment tests.
- The three that appeared were in `adminDungeons/DungeonEventAuthoring` and `adminEnemies/EnemyPages`, which this change does not touch.
- Re-running those two files alone: run 1, 63/63 passed. Run 2, a *different* test timed out at 5,046 ms against the 5,000 ms limit.
- These are load-dependent timeouts, not regressions.

**Pre-existing failure checked.** `tests/unit/api/errors.test.ts` ("classifies every AppError subclass") already fails at baseline. It crashes on `DungeonImportError` before reaching later classes, so the new error's 409 mapping is asserted in `equipment3Foundations.test.ts` instead.

---

## 10. Remaining risks and E3-B dependencies

**Implemented and live now:**

- effective SP (the formula-3 arithmetic, previews, snapshots and displays);
- three-bonus storage;
- the rarity lock;
- the separated rarity lists;
- LR authoring;
- storage and validation of both flat-SP kinds through **fixed** grants.

**Foundations only — not yet reachable by players:**

- Nothing random produces flat SP, a third bonus, or an SSR/UR/LR copy. The only way to create one is a fixed grant from code, and no route issues those.
- `EQUIPMENT_RANDOM_ROLL_RARITIES` is declared but the roll still fails closed through the affix-pool check. The E3-C engine will read it.

**Risks and notes:**

- **Older clients.** Older Portal builds receive `percent: null` for a `flat_sp` bonus. None exist in production data yet. The current Portal renders the server's `text`.
- **Data-cleanup migrations.** The 400 per-loadout clamp is a live safety rail. A future migration that writes `rolled_properties` directly would bypass the per-copy validation; reading clamps it.
- **Ceiling values.** The provisional ceilings (200 / 400) are hard-coded in `vocabulary.ts`. Making them part of published rules is E3-B's job (`flatSpLimits` in the architecture).
- **Field naming.** `valueBp` holds whole SP for `flat_sp` (decision B4 in the architecture). It is documented on the type and in the schema.

**E3-B dependencies:**

- the managed roll-config store (bootstrap from `combatBonuses.json`, draft, publish, rollback, events);
- reading the published legacy block in place of `getContent().equipmentCombatBonuses`, gated by this golden fixture;
- moving the flat SP ceilings into published config;
- affix-library storage and display resolution.

The golden fixture and `equipmentRarityCapabilities.test.ts` are the regression gates for every later phase.
