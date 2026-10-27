# Equipment 3.0 — E3-C Completion Report

**Phase E3-C: the high-rarity roll engine and revision-safe rewards.**

- Backend only, uncommitted, for review. E3-D was not started.
- Design basis: [equipment-3-architecture.md](equipment-3-architecture.md), [e3-a-completion.md](e3-a-completion.md) and [e3-b-completion.md](e3-b-completion.md).

> **Nothing new is reachable by players.** SSR/UR/LR copies are rolled only when backend code explicitly grants one, and no reward source, loot table, recipe or route can name an SSR/UR/LR definition. Production publishes no high-rarity rule, so even an explicit SSR/UR/LR grant fails closed there today. Two things *are* live in production. New dungeon runs and expedition deployments now record a roll-configuration pin. Combat stats now read the published per-loadout SP limit, which is still the bootstrap value of 400, so nothing changes.

---

## 1. Repository state

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `9119694` — "Add unit tests for equipment affix libraries and roll rules" (E3-B, committed). Unchanged; nothing committed. |
| Prerequisites | E3-A (`47c43a5`: migration `0070`, golden fixture) and E3-B (`9119694`: migration `0071`, rules and library services) both present and compatible. |
| Initial working tree | Clean. |
| Final working tree | 26 modified files and 6 new files (5 code/test/migration files plus this report), listed in §2. No unrelated changes. |
| Migration added | `0072_equipment_definition_roll_policy` (journal entry 72) |

A clean worktree of `9119694` was used for every baseline run. Each full root run rewrites `tests/integration/__snapshots__/captureExtraction.test.ts.snap` with LF line endings, as at baseline (see E3-A/E3-B). Its content is unchanged, and it was restored with `git checkout`.

---

## 2. Changes

**New:**

| File | Role |
| --- | --- |
| `src/modules/equipment/highRarityRoll.ts` | The SSR/UR/LR distribution roll. It is pure and has three parts: `planHighRarityRoll`, which runs every fail-closed check with no RNG; `rollHighRarityInstance`, which makes the draws; and `definitionRollPolicyIssues` and `analyseHighRarityRoll`, which give authoring feasibility and exact probabilities. |
| `drizzle/0072_equipment_definition_roll_policy.sql` | The two roll-policy columns and their constraints (§3). |
| `tests/unit/equipmentHighRarityRoll.test.ts` | 34 tests |
| `tests/integration/equipmentHighRarity.test.ts` | 25 tests (PostgreSQL) |
| `tests/integration/equipmentRewardPins.test.ts` | 6 tests (PostgreSQL, real dungeon and expedition lifecycles) |

**Modified (backend):**

| File | Change |
| --- | --- |
| `equipmentRoll.ts` | `rollEquipmentInstance` takes an optional `highRarity` context and dispatches SSR/UR/LR to the distribution roll only when it is given. **The N/R/SR body is untouched.** `EquipmentRoll.affixSnapshot` was added. `rolledPropertiesOf` also writes `affixSuffix` and `affixLibrary` for managed-library copies. `RollableDefinition` carries the roll policy. |
| `equipmentService.ts` | `grantEquipment` takes `rollPin`. It reads one rules revision (published, or the pinned one), resolves the rarity's assigned library at the right revision, and passes both to the unchanged roll call. Event metadata gains `rollRulesPinned` and `affixLibrary {key, revision}`. A complete grant-key replay is also allowed when the high-rarity configuration or pin can no longer roll. Gear-bag search matches the snapshotted suffix. |
| `equipmentRollRulesService.ts` | `forGrant(tx, pin?)` reads by revision number when pinned and caches by number. New methods: `affixLibraryForGrant`, `pinForReward` and `flatSpLimits`. Rules validate, preview, publish and rollback now also refuse rules that would leave an **enabled** SSR/UR/LR definition unable to roll. |
| `rollRules.ts` | `EquipmentRollPinSchema` and `readEquipmentRollPin`. |
| `equipmentRewardService.ts` | `rollPin` on chosen-reward grants. New `pinRollConfiguration(tx)`. Optional `rollRules` dependency. |
| `definitionSchema.ts` | `primarySpEligible` (default `false`) and `maxAdditionalBonuses` (0–3, default `null`). Both are refused on N/R/SR. |
| `equipmentDefinitionService.ts` | `assertRollPolicyFeasible` on create, update and enable. `setEnabled` now locks the row in a transaction. |
| `equipmentPackage.ts`, `equipmentImportService.ts` | Package **v3** is written. v2 and v3 are read. The planner refuses an enabled infeasible SSR+ entry against the published rules. |
| `equipmentMath.ts`, `combatStatsService.ts` | `loadoutFlatSpCeiling`: the published `perLoadoutMax` can lower the 400 rail but never raise it (§5). |
| `vocabulary.ts` | `EQUIPMENT_RANDOM_ROLL_RARITIES` is now N…LR, meaning "rollable when explicitly invoked and configured". New `EQUIPMENT_HIGH_RARITY_ROLL_RARITIES`. Reward, Workshop and bonus lists are unchanged (§9). |
| `dungeonRunService.ts` | The run pins at start (`dependencySnapshot.equipmentRollPin`) and both grant paths pass the pin (§7). |
| `expeditionService.ts`, `expeditions/types.ts` | The deploy pins beside the equipment pools. The pin is kept through the resolution trim and passed at claim (§7). |
| `shared/errors.ts`, `api/errors.ts` | `EquipmentRollUnavailableError` (`EQUIPMENT_ROLL_UNAVAILABLE`, 409) and `EquipmentRollPinMissingError` (`EQUIPMENT_ROLL_PIN_MISSING`, 503). |
| `db/schema.ts` | The 0072 columns and the CHECK mirrors. |
| `index.ts` | The reward service and combat stats get `equipmentRollRules`. |

**Modified (tests):**

- **Helpers.** `buildEquipmentServices`, `createDungeonWorld` (`managedRollRules`) and `bootstrapApp` (`equipmentRollRules`) gained an optional real rules service. When it is omitted, nothing changes.
- **Intended contract changes,** pinned by exact assertions:
  - `equipmentPackage.test.ts`: v3 is written; the messages now read "version 2 or 3"; the row fixture has the two new columns;
  - `equipmentDefinitionSchema.test.ts`: the parsed defaults include the two fields;
  - `equipmentRarityCapabilities.test.ts`: the random-roll list is N…LR.

---

## 3. Migration `0072_equipment_definition_roll_policy`

```sql
ALTER TABLE equipment_definitions ADD COLUMN IF NOT EXISTS primary_sp_eligible boolean DEFAULT false NOT NULL;
ALTER TABLE equipment_definitions ADD COLUMN IF NOT EXISTS max_additional_bonuses smallint;
-- CHECK max_additional_bonuses is null or 0..3
-- CHECK rarity in ('SSR','UR','LR') or (primary_sp_eligible = false and max_additional_bonuses is null)
```

- The migration is additive. Existing rows read `false`/`null`, which is exactly today's behaviour. No row is rewritten and no owned copy is touched.
- **N/R/SR cannot acquire a roll capability.** This is enforced three times: by the schema, by the DB CHECK, and by the legacy roll, which never reads either field.
- **Verified against PostgreSQL 16.** All 30 seeded rows read the defaults. N with `primary_sp_eligible = true`, N with a maximum, and SSR with a maximum of 4 are all refused with `23514`. Two re-runs leave every row byte-identical, with exactly two constraints. Every test database applies `0001…0072`.
- **Rollback:** drop the two constraints and the two columns. Rolled copies keep their stored values either way.

Equipment key immutability, the slot lock and the rarity lock are unchanged and still tested. A roll-policy edit affects future grants only, and an owned copy is byte-identical after the edit (tested).

---

## 4. High-rarity roll algorithm and RNG contract

SSR/UR/LR roll from the published `rarities.<R>` rule. They roll only when `grantEquipment` (or a caller) supplies the configuration. Every draw comes from the one injected or seeded `rng`:

| # | Draw | Bounds | When |
| --- | --- | --- | --- |
| 1 | Multiplier | `intInclusive(0, steps)` | always (identical to legacy) |
| 2 | Affix | `intInclusive(0, n − 1)` over the library's enabled entries for the slot, in library order | only for a library assignment; affixless draws nothing |
| 3 | Bonus count | `intInclusive(1, Σ kept weights)`, walked in ascending count order | only when more than one count has positive weight |
| 4 | Families | `count` draws `intInclusive(0, remaining − 1)`, uniform without replacement, in rule order | the legacy algorithm, unweighted |
| 5 | Magnitudes | one `intInclusive(0, steps)` per chosen family, in the order chosen, over **this rarity's** range | |
| 6 | Primary SP gate | `intInclusive(1, 10000) ≤ chanceBp` | only when the definition is eligible and 0 < chance < 10000 |
| 7 | Primary SP value | `intInclusive(0, steps)` | when the gate passes, or the chance is 10000 |

Primary SP is drawn last. Toggling `primarySpEligible` never moves draws 1–5, and the test compares 300 seeds with eligibility on and off. Bonuses are stored in canonical order. `the RNG contract` in the unit suite asserts the exact bounds sequence.

**Fail closed, before any draw** (`planHighRarityRoll` → `EquipmentRollUnavailableError`). The roll is refused when:

- the rarity has no rule;
- the stored revision no longer validates (re-validated once per revision object);
- the assigned library is missing, is a different library, or has no enabled entry for the slot;
- the definition's maximum leaves no positive weight;
- a reachable count exceeds the slot's distinct families;
- or a copy could exceed the per-copy SP cap.

None of these falls back to another rarity, invents a weight, substitutes a library, reads JSON or grants a partial item. Every refusal is tested with a recording RNG that shows **zero draws**, and the PostgreSQL tests show **zero rows written**.

N/R/SR are unaffected. When given the high-rarity context they produce identical values *and* identical draw sequences (900 rolls compared), and they never reach this code.

---

## 5. Per-definition maximum and flat SP

**Maximum additional bonuses.**

- The value is 0–3, or `null` for the rarity ceiling (3).
- Counts above the maximum are **excluded** and the rest renormalised. Example: `{1:4000, 2:5000, 3:1000}` with a maximum of 2 gives P(1) = 4/9 and P(2) = 5/9. The analysis is exact, and 8,000 sampled rolls land within ±0.025 of 5/9; clamping would give 0.6. Counts are never clamped.
- When no positive weight remains, the definition is refused on create, update, enable and import if it is enabled, and the roll refuses it if it is reached anyway.
- Rules publish and rollback are refused if they would strand an enabled definition.
- A definition whose rarity has no published rule may still be saved and enabled. Nothing can roll or reward it.

**Primary flat SP** (`rolled_properties.flatSp`, the E3-A storage):

- The published rule sets the chance, minimum, maximum and step. `primarySpEligible` opts the definition in.
- It is independent of the bonus count and uses no bonus slot.
- 0 % draws nothing. 100 % always rolls a value with no gate draw. 25 % gives a measured rate of 0.25 ± 0.02.

**Additional `flat_sp`** is selected from the normal pool and uses one bonus slot. It has its own range for each rarity, is stored as `{ stat: "flat_sp", valueBp: <whole SP> }`, and is never duplicated.

**Stacking.** Primary +20 plus additional +11 gives an item contribution of +31 (tested through `itemFlatSpOf`).

**Ceilings.**

- **Per copy:** primary max + `flat_sp` max ≤ `min(published perItemMax, 200)`. This is refused at publish (E3-B) and again by the roll plan. The read-side clamp stays at the 200 code rail, so a later reduction of the limit never shrinks an owned copy.
- **Per loadout:** the live clamp is `min(published perLoadoutMax, 400)`. It is read through the calculation's transaction, so snapshots freeze the derived stats as before. Without managed rules, or before bootstrap, the 400 rail applies. Natural SP, progression and dungeon event checks are untouched.

---

## 6. Managed affix libraries

| Assignment | Behaviour |
| --- | --- |
| `none` | `affixKey = null`, no draw, nothing snapshotted |
| A shared library | Several rarities draw from it. Each draw is filtered to enabled entries for the copy's slot. |
| A dedicated library | One rarity draws from it. |

- **The snapshot.** The copy stores `affix_key` = the entry key, plus `rolled_properties.affixSuffix` (the suffix as rendered at grant) and `affixLibrary`.
- **Display, search and grouping read the snapshot.** In the database test, a renamed and republished entry leaves the copy's name and search hit unchanged, and searching for the new text finds nothing.
- **Unknown-key reporting.** `readUnknownAffixKeys` already skips snapshotted copies.
- **N/R/SR are unchanged.** They read only `affixes.json`, are not snapshotted, and keep their fail-closed empty-pool behaviour.

---

## 7. Revision pinning

**Where a reward becomes promised.**

| Source | Selection → grant | Pin taken |
| --- | --- | --- |
| Dungeons | Candidate definitions are frozen when a run starts (dependency and reward snapshots, `promised`/`allowDisabled`). The drop is resolved, and its `rollSeed` derived from the run seed, in the step that claims it. The grant is in the same transaction. | **At run start**, in `dungeon_runs.dependency_snapshot.equipmentRollPin`, alongside the enemies and reward tables the run already freezes there. Both the v1 and v2 grant paths pass it. |
| Expeditions | The pool is snapshotted at deploy, the definition is picked at resolution, and the grant is made at claim (hours later, with no seed). | **At deploy**, in `resolution_plan.equipmentRollPin`. It is kept through the resolution trim and read at claim. |
| Bosses, World Encounters, Workshop, onboarding | Selected and granted in one transaction | None. These sources read the live published revision. |

**The pin:** `{ rulesRevision, affixLibraryRevisions: { <library>: <revision> } }`.

- It records the published revision of **every library the pinned rules assign**. Libraries are versioned independently of the rules, so the rules revision alone does not fix their content.
- When paying, `forGrant` reads exactly that rules revision by number, never the pointer. `affixLibraryForGrant` reads exactly that library revision.
- Both kinds of revision are immutable and protected by the 0071 triggers.

**Fail-closed cases** (`EquipmentRollPinMissingError`, 503, nothing written):

- a missing rules revision;
- a missing library revision;
- a library the pin does not record;
- a malformed stored pin.

For a dungeon these abort the step atomically (`DungeonRewardGrantError`). Repairing the pin lets the same step retry (tested).

**Compatibility.**

- Runs and plans written before E3-C have no pin. They read the live published revision, which carries the same immutable legacy block for N/R/SR.
- Tested: a pinned and an unpinned N/R/SR drop each equal the seeded legacy roll.
- No existing snapshot or claim is invalidated.

**Tested — the pinned reward:**

- A UR reward pinned under rules revision A and library revision A was paid after rules B and library B published. B changed the weights, the ranges, the primary SP and the library entries.
- It equals the pure roll under A/A; an unpinned grant with the same seed equals B/B, and the two differ.
- The suffix snapshot and the event metadata name the A revisions.

---

## 8. Idempotency and delayed rewards

- **Determinism.** The same definition, seed and immutable configuration give one result. A fresh process (empty caches) re-rolls a pinned grant identically.
- **Duplicate claims.**
  - A grant-key replay returns the stored copy, and nothing is written; this holds after a restart too.
  - The reward service's `alreadyPaid` check runs before any roll.
  - In the core, a complete replay is returned even when the configuration or pin it rolled under can no longer roll. A partial replay is still refused.
- **Concurrency.** Two concurrent pinned payouts of one reward create exactly one row (the `grant_key` unique index).
- **Publication timing** is irrelevant once a reward is pinned. Unpinned grants keep E3-B's `FOR SHARE` read. Library reads also take `FOR SHARE` on the library row, so a library publish waits for a grant that is in flight.
- **Partial writes are impossible.** Every refusal happens before the insert, inside the grant's transaction.

---

## 9. Reward eligibility safeguards

| List | Value | Changed? |
| --- | --- | --- |
| `EQUIPMENT_REWARD_RARITIES` (selectors, the default for a rarity-less selector, dungeon loot and snapshot schemas) | N, R, SR | **No** |
| `WORKSHOP_RECIPE_RARITIES` | N, R, SR | No |
| `COMBAT_BONUS_RARITIES` / `EQUIPMENT_AFFIX_RARITIES` | N, R, SR | No |
| `EQUIPMENT_RANDOM_ROLL_RARITIES` | N…LR | Widened. It is a capability list; no selector reads it. |

- **Selector tests.** Selectors still resolve only N/R/SR. This is tested against PostgreSQL with enabled SSR, UR and LR definitions present: `eligibleDefinitions({})` and every slot-only selector. The E3-A capability suite also still passes.
- **Out-of-scope surfaces untouched:** dungeon loot, boss, expedition and World Encounter selectors, and Workshop recipes.
- **No production content was created.** No SSR/UR/LR definition and no affix entry was added to `content/`.
- **Future authoring dependency.** No existing reward schema can name an SSR/UR/LR definition. Selector and whitelist schemas refuse them, by design. Authoring an explicit high-rarity reward (a dedicated selector field or reward type) is therefore a decision for a later phase. It was not done by widening the existing lists.

---

## 10. Golden compatibility

- `tests/unit/equipmentRollGolden.test.ts` rolls **30 definitions × 200 seeds = 6,000 rolls**. It runs through both the shipped-catalogue path and the published-rules path (62 tests).
- The fixture is `tests/fixtures/equipmentRollGolden.json`, sha256 `308b5a81…69ee13`. It was unchanged before and after.

| Run | Result |
| --- | --- |
| Before any change | 62 / 62 — **6,000 / 6,000** identical on each path |
| After implementation | 62 / 62 — **6,000 / 6,000** identical on each path |

"Identical" covers the multipliers, affix keys, bonus families and values, and every RNG call's arguments, result and order. The live PostgreSQL grant path (E3-B's 30 × 3 seeded grants) and `equipmentSeededRewards` also pass unchanged.

---

## 11. Tests and builds

| Check | Result |
| --- | --- |
| Backend typecheck (`npm run typecheck`) | Clean |
| Backend build (`npm run build`) | Clean |
| `git diff --check` | Clean |
| Golden gate | 6,000 / 6,000 (twice), before and after |
| `equipmentHighRarityRoll` (unit) | 34 / 34 |
| `equipmentHighRarity` (PostgreSQL) | 25 / 25 |
| `equipmentRewardPins` (PostgreSQL, dungeon + expedition lifecycles) | 6 / 6 |
| Portal | Not affected. No API type, serializer or route changed. Definitions have no API serializer, and player views carry no roll policy. Portal typecheck and tests were therefore not re-run. |

**Focused comparison.** This covered every equipment, combat, dungeon, expedition, boss, Workshop and World Encounter suite (unit and integration), including the migration suites, run identically in the baseline worktree and in the working tree.

| | Tests | Failed |
| --- | --- | --- |
| Baseline (`9119694`) | 3,980 | 42 |
| After | 4,045 (65 new) | 43 |

- All 42 baseline failures are still present; none was fixed or changed.
- The one difference was `bossScheduler` › "the two-message delivery survives a restart › never moves the completion stamp once set".
  - Run alone twice after the change, that test **passes** both times. The file fails 6, then 5 tests, a different set each time.
  - The baseline worktree run alone fails the same 5 as its recorded baseline.
  - This is the load-dependent scheduler file both earlier phases documented. It imports no code this phase changed.

**Full root suite: not completed — cancelled.**

- The comparison was planned as two sequential full root runs: the clean `9119694` worktree first, then the working tree.
- It was cancelled on request about ten minutes in, while the baseline run was still going. The working-tree run never started.
- Neither run produced a result. No full-suite pass or fail count is claimed for E3-C.
- The job's processes and its Testcontainers PostgreSQL container were stopped and removed, as was the temporary baseline worktree. No other services or containers were touched.
- Because the working-tree run never started, `captureExtraction.test.ts.snap` was not rewritten and needed no restore.

The verification E3-C relies on is therefore:

- the golden gate, 6,000 / 6,000 before and after;
- the 65 new E3-C tests;
- typecheck and build;
- the 4,045-test focused comparison above, which shows no E3-C regression against the baseline.

Suites outside the focused set were not re-run for this phase. Examples are captures, cards, the Portal API beyond equipment, and load tests. A full root comparison against `9119694` remains a recommended check before merge.

---

## 12. Remaining limitations and E3-D/E3-E dependencies

**Exercisable only through backend tests or explicit code:**

- SSR/UR/LR random rolling, managed affix draws, primary SP and additional `flat_sp` rolls;
- pinned high-rarity grants;
- definition roll policy (authorable through the definition service and package v3, but neither has a route).

**Live, but invisible with the current data:**

- dungeon and expedition pins are recorded (N/R/SR roll identically either way);
- the per-loadout clamp reads the published limit (still 400).

**Dependencies and limitations:**

1. **Authoring an SSR+ reward.** No reward schema can name SSR/UR/LR (§9). An explicit high-rarity reward needs a deliberate schema addition and a balance decision.
2. **Rules and library editors (E3-E).** Nothing in production publishes a high-rarity rule. Until something does, explicit SSR+ grants fail closed with `EQUIPMENT_ROLL_UNAVAILABLE`.
3. **Catalogue editor (E3-D).** The roll policy is validated and stored, but has no route or Portal control. Package v3 import and export work through the existing services.
4. **Workshop.** Salvage and fabrication remain N/R/SR. Dismantling an SSR+ copy is not defined, and is unreachable until players can own one.
5. **Fixed grants** cannot name a managed-library affix key, because `validateFixedRoll` checks the shipped catalogue only. Restoring a managed-affix copy would need that path extended.
6. **No revision on the copy.** `rolled_properties` does not store the rules revision; `equipment_events` metadata records the rules revision, the pin flag and the library revision. This keeps otherwise-identical copies grouping together.
7. **Previews.** `analyseHighRarityRoll` provides exact count and SP probabilities. A sampled preview API is part of E3-E.
8. **Balance.** Decisions B1, B2, B3, B5 and B7 (architecture §16) remain open. Every number in this phase's tests is test-only.
