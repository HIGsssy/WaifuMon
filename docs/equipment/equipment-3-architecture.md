# Equipment 3.0 — Architecture

Status: **architecture and implementation plan only. Nothing here is implemented.**

- Revision 2 (2026-10-27). Branch `Delve`, HEAD `3fbb802`.
- The working tree was clean apart from this document. The latest migration is `0069_region_pools`.
- Revision 1 was the first audit. Its findings are kept in Part I and re-verified against the code at the same HEAD.
- Revision 2 replaces Revision 1's design (Part II onward) with the finalized requirements.

Tags used throughout:

- **[REUSE]** — exists today, reuse unchanged.
- **[MINOR]** — minor extension.
- **[SUBSTANTIAL]** — substantial change.
- **[NOT 3.0]** — out of scope.

---

# Part I — Verified baseline (what exists today)

## 1. Storage and services

| Table / file | Role | Migration |
| --- | --- | --- |
| `equipment_definitions` | DB-authoritative catalogue. Columns: `key` (unique, immutable in code), `slot`, `rarity` (CHECK N…EX), `multiplier_min/max/step_bp`, `secondary_effects` jsonb (reserved; authoring forces `[]`), `tags`, `region_id`, `artwork_path`, `enabled`, `shop_regions`/`buy_price`/`price_currency` (no equipment shop reads them), `updated_at`, `updated_by`. **No `revision`.** | `0045`, `0046` |
| `player_equipment` | One row per copy. Columns: `definition_id` (FK RESTRICT), `slot` (copied), `rolled_multiplier_bp`, `affix_key`, `combat_bonuses` jsonb (**CHECK ≤ 2**), `rolled_properties` jsonb (default `{}`, **unused**), `source_type`, `grant_key` (unique), `removed_at`. | `0045`, `0046`, `0056` |
| `equipment_events` | Append-only ledger. Requires `player_id`, so it can't hold content audit. | `0045`, `0049` |
| `equipment_import_log` | One row per applied package. | `0045` |
| `content/equipment/equipment.seed.json` | 30 definitions (N 18, R 9, SR 3), package v2, insert-missing. | — |
| `content/equipment/affixes.json` | 470 flavour affixes in 9 pools `<slot>.<N\|R\|SR>`. Deployed content. | — |
| `content/equipment/combatBonuses.json` | `rarityRules` (N/R/SR), 5 families with N/R/SR ranges, slot `eligibility`. Deployed content. | — |
| `content/equipment/workshop.json` | Salvage yields + recipes, N/R/SR only. | — |

| Service | State |
| --- | --- |
| `equipmentDefinitionService.ts` | create/update/setEnabled/delete/list. Key immutable; **slot** frozen once referenced (`assertSlotChangeAllowed`); **rarity not frozen**. Wired in `src/index.ts:394`, **no caller**. |
| `equipmentImportService.ts` + `equipmentPackage.ts` | export / previewImport / applyImport (one transaction, re-plans under lock, writes `equipment_import_log`). Wired, **no caller**. |
| `seed.ts` | `insert-missing` at startup (`src/index.ts:956`). Never overwrites, so Portal edits survive restarts. **[REUSE]** |
| `equipmentRewardService.ts` → `equipmentService.grantEquipment` → `equipmentRoll.rollEquipmentInstance` | The one random-grant path for every source. **[REUSE]** |
| `combatStatsService.ts` → `equipmentMath.assembleCombatStats` | The one stat calculation. **[REUSE]** |

**Process topology.** The Platform API, including all Portal admin routes, runs inside the bot process (`startPlatformApi`, `src/index.ts:1512`). The Portal is a static SPA. Region Pools still serialises writes with a lock, because two processes can briefly overlap during a deploy.

## 2. N/R/SR roll behaviour (re-verified; must not change)

`rollEquipmentInstance` (`equipmentRoll.ts`), in **RNG draw order**:

1. **Multiplier.** One draw: `rng.intInclusive(0, steps)`, uniform over `min…max` by `step`.
2. **Affix.** One draw: `rng.intInclusive(0, n-1)` over `affixes.rollable('<slot>.<rarity>')`. These are the enabled entries, **in file order**. No pool means it throws `EquipmentAffixPoolEmptyError`.
3. **Bonuses** (`rollCombatBonuses`):
   - The rule comes from `rarityRules[rarity]`.
   - The chance gate is one draw, `rng.intInclusive(1, 10000) > bonusChanceBp`. It is drawn **only when the chance is below 10000**; only N draws it.
   - Then `bonusCount` draws pick families uniformly **without replacement** from `eligibility[slot]` ∩ enabled, in authored order.
   - Then one magnitude draw per chosen family, uniform over its rarity range by `stepBp`.
   - The result is sorted into canonical order.

| Rarity | Chance | Count | Families per slot (atk/def/hp) |
| --- | --- | --- | --- |
| N | 6500 bp (65%) | 1 | 5 / 4 / 4 |
| R | 10000 | 1 | 5 / 4 / 4 |
| SR | 10000 | 2 | 5 / 4 / 4 |
| SSR / UR / LR | no rule → 0 bonuses, **but the affix step throws first** | — | — |

The roll result is stored once on the row, together with `equipment_events` metadata. A grant-key replay returns the stored copy. Dungeon grants pass a `rollSeed` and resolve at **claim time** against the **live** definition and catalogues (`dungeonRunService.ts:995, 1230`).

## 3. Rarity capability (re-verified)

| | N | R | SR | SSR | UR | LR |
| --- | --- | --- | --- | --- | --- | --- |
| DB CHECK | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Authoring (`EQUIPMENT_AUTHORING_RARITIES`) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Random roll | ✅ | ✅ | ✅ | ❌ throws | ❌ throws | ❌ |
| Random reward selectors (`EQUIPMENT_REWARD_RARITIES`) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Dungeon loot / reward snapshot schemas | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Workshop salvage / fabricate | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

The two-bonus ceiling exists in three places:

- `MAX_COMBAT_BONUSES_PER_ITEM = 2`;
- the strict N/R/SR `rarityRecord` catalogue schema;
- the DB CHECK `player_equipment_combat_bonuses_check` (`0056`).

**One constant, four meanings.** `EQUIPMENT_AFFIX_RARITIES` (N/R/SR) is re-exported as all of these:

- `COMBAT_BONUS_RARITIES`;
- `EQUIPMENT_REWARD_RARITIES`, which is also the default for any selector without `rarity` (`rewardSelector.matchesFilters`), and is used by `lootResolver.ts:235` and `dungeonRewardSnapshot.ts:69`;
- `WORKSHOP_RECIPE_RARITIES`.

Widening it would silently put SSR+ into every rarity-less selector. **This is the main drop-rate hazard.**

## 4. Stat calculation and SP (re-verified)

```text
currentSp = currentSeductivePower(baseSp, level, maxLevel)        // natural; never stored
stat[slot] = deriveStat(currentSp, item.rolledMultiplierBp)       // integer half-up, per slot, shared SP
combatModifiers = clamp(Σ item.combatBonuses)                     // COMBAT_MODIFIER_CAPS
formulaVersion = 2
```

**Consumers of this calculation.** All reach it through `combatStatsService`:

- Discord equipment and Trial presenters;
- Portal `/players/:id/equipment*`;
- `combatTrialService` (snapshot per attempt);
- `dungeonRunService` (`fighterFromCombatStats` at start, frozen);
- `equipmentManagementService` previews;
- onboarding.

Nothing caches derived stats.

**Natural-SP readers outside equipment, which stay natural:**

- `bossEncounterService.snapshotBuddy`;
- `worldEncounterService.safeCurrentSp`;
- `discord/trainerProfile.ts`;
- dungeon event checks (`engine/eventChecks.ts`, reading `DungeonFighter.currentSp`).

## 5. Grant paths (re-verified)

| Source | Entry | Rarity gate |
| --- | --- | --- |
| World Encounter `give_equipment` | `effectExecutor.ts:465` → `grantRandomEquipmentReward` | selector |
| Bosses | `bossEncounterService.ts:1129/1134` | selector |
| Expeditions | `expeditionService.ts:1118` → chosen, pool snapshotted at deploy | selector |
| Dungeons | `dungeonRunService.ts:995, 1230` → chosen + `rollSeed` | loot snapshot schema |
| Workshop | `equipmentWorkshopService.ts:591` → random `{rarity, slot?}` | recipes |
| Onboarding | `equipmentOnboardingService.ts:303` → fixed roll | — |
| Admin grant / equipment shop | **not implemented** | — |

**Existing behaviour to be aware of (§10.4).** Boss, World Encounter and Workshop selectors resolve against the **live** definition list. Creating or importing an **enabled N/R/SR** definition today immediately adds it to every matching rarity-less or slot-only selector. Expedition and dungeon pools are snapshotted, so they are unaffected until the next deploy or publish.

---

# Part II — Final architecture

## 6. Overview

```text
                      ┌──────────────────────── Portal Admin → Equipment ───────────────────────┐
                      │  Catalogue (definitions)   Rarity & Bonus Rules     Affix Libraries      │
                      └──────┬──────────────────────────┬────────────────────────┬──────────────┘
                             │ direct edit + revision   │ draft → publish        │ direct edit + revision
                             ▼                          ▼                        ▼
               equipment_definitions        equipment_roll_config        equipment_affix_libraries
               (+ revision, roll-policy     (draft) + _revisions         equipment_affixes
                columns)                    (immutable, published ptr)
                             │                          │                        │
                             └────────────┬─────────────┴────────────┬───────────┘
                                          ▼                          ▼
                     grantEquipment → rollEquipmentInstance(definition, publishedConfig, libraries, legacyAffixes)
                                          │
                                          ▼
                     player_equipment: rolled_multiplier_bp · affix_key · combat_bonuses (≤3) ·
                                       rolled_properties { primarySp?, affixSuffix?, rollConfigRevision? }
                                          │
                                          ▼
                     assembleCombatStats: effectiveSp = naturalSp + Σ primarySp + Σ flat_sp → ATK/DEF/HP
```

Principles:

1. **N/R/SR run the legacy code path, byte for byte.** The new engine only handles rarities whose rule is in *distribution mode*. In 3.0 that is SSR, UR and LR. The N/R/SR rules move into the managed config **verbatim**, and the editor shows them **read-only** in 3.0.
2. **One source of truth per concern.**
   - Definitions: `equipment_definitions`.
   - Roll rules: the *published* `equipment_roll_config` revision.
   - Affixes: legacy `affixes.json` (read-only, N/R/SR) plus managed libraries (DB).
   - After bootstrap, `combatBonuses.json` is a bootstrap and reset seed only.
3. **Rolls are snapshotted.** No admin action changes an owned copy's stats or name.
4. **Reward eligibility is untouched.** Random reward selectors stay N/R/SR. Rollable rarities are a separate constant.

## 7. Configuration schemas

### 7.1 Equipment definition (package v3)

These are the existing fields plus **two new roll-policy fields**. They become real columns, not `secondary_effects` (see §11), because `secondary_effects` is reserved for a future data-driven effect system and these are roll policy.

```jsonc
{
  "key": "example_relic_blade",          // immutable
  "name": "Relic Blade",
  "description": "…",
  "slot": "attack",                       // frozen once any copy exists
  "rarity": "SSR",                        // NEW RULE: frozen once any copy exists
  "multiplierMinBp": 11000, "multiplierMaxBp": 13000, "multiplierStepBp": 500,
  "primarySpEligible": true,              // NEW, default false
  "maxAdditionalBonuses": 2,              // NEW, 0..3 or null (= rarity ceiling)
  "secondaryEffects": [],                 // still reserved, still must be []
  "tags": [], "regionId": null, "artworkPath": null,
  "enabled": false,
  "shopRegions": [], "buyPrice": null, "priceCurrency": "waifubux"
}
```

Validation additions in `definitionSchema.ts`:

- `rarity` accepts `LR`.
- `maxAdditionalBonuses` must be `null` for **legacy-mode** rarities (N/R/SR) in 3.0. Truncating a fixed legacy count would change the legacy algorithm (decision B6).
- `primarySpEligible` must be `false` for legacy-mode rarities.
- **Rule-dependent checks.** These run against the published config: "this definition can roll at least one bonus-count outcome" and "its slot has enough eligible families". They are reported as definition warnings, and they are enforced by **config publish** for every enabled definition (§9.4).

### 7.2 Roll configuration body (`waifumon-equipment-roll-config` v2)

```jsonc
{
  "format": "waifumon-equipment-roll-config",
  "version": 2,

  // N/R/SR: exactly today's combatBonuses.json v1 content, verbatim (bootstrap source).
  // Read-only in 3.0; executed by the unchanged legacy roll code.
  "legacy": {
    "rarityRules": { "N": {"bonusChanceBp":6500,"bonusCount":1}, "R": {...}, "SR": {...} },
    "bonuses":     [ /* the five families with N/R/SR ranges, as shipped */ ],
    "eligibility": { "attack": [...], "defense": [...], "health": [...] }
  },

  // Distribution-mode rarities. Absent rarity = not randomly rollable (fail-closed, as today).
  "rarities": {
    "SSR": {
      "bonusCountWeightsBp": { "0": 0, "1": 4000, "2": 5000, "3": 1000 },   // must total 10000
      "families": [
        { "stat": "crit_chance_bp", "enabled": true, "slots": ["attack","defense","health"],
          "minBp": 500, "maxBp": 1000, "stepBp": 25 },
        { "stat": "flat_sp", "enabled": true, "slots": ["attack","defense","health"],
          "min": 10, "max": 20, "step": 1 }                                   // unit: SP
      ],
      "primarySp": { "chanceBp": 5000, "min": 10, "max": 100, "step": 5 },   // or null
      "affixes": { "library": "high_rarity_affixes" }                        // or { "affixless": true }
    },
    "UR": { … }, "LR": { … }
  },

  "flatSpLimits": { "perItemMax": null, "perLoadoutMax": null }               // must be set before any rarity enables SP
}
```

All numbers above are **illustrative**, not approved.

- **Slots.** `families[].slots` is per rarity and per family. It replaces the global per-slot `eligibility` for distribution-mode rarities only. Slots stay `attack`/`defense`/`health`.
- **Families** are the existing five plus `flat_sp` and nothing else. The stat list is code (`EQUIPMENT_BONUS_STATS`); config can only reference it.
- **Ranges.** Basis-point families use `minBp/maxBp/stepBp`. `flat_sp` uses `min/max/step` in whole SP. The family registry in code declares each family's unit (`'bp' | 'sp'`).

### 7.3 Affix library (`waifumon-equipment-affix-library` v1)

```jsonc
{
  "format": "waifumon-equipment-affix-library",
  "version": 1,
  "library": { "key": "high_rarity_affixes", "name": "High-rarity affixes", "description": "" },
  "affixes": [
    { "key": "the_unbroken_oath", "suffix": "of the Unbroken Oath", "slots": ["attack","defense"], "enabled": true }
  ]
}
```

- **Keys.** Affix keys are **globally unique** across all managed libraries **and** the legacy file. Suffixes are unique case-insensitively, the same rule `affixes.json` applies today.
- **Slots.** `slots` lists the slots an entry is eligible for. Empty means none; this is invalid on an enabled entry.

## 8. Roll execution order

`rollEquipmentInstance(definition, ctx)` dispatches on the rarity's rule mode.

**Legacy mode (N, R, SR): the current function, unchanged.** Same inputs (the legacy block is equal to today's catalogue), same draws, same output. Nothing is appended. `rolled_properties` stays `{}`.

**Distribution mode (SSR, UR, LR).** Every draw comes from the one injected or seeded `rng`, in this fixed order:

1. **Multiplier.** One draw, exactly as legacy.
2. **Affix.**
   - If the rarity is `affixless`, there is **no draw** and `affixKey = null`.
   - Otherwise the candidates are the enabled entries of the assigned library eligible for the slot, in library order. One draw.
   - If there are no candidates, it fails closed with `EquipmentAffixPoolEmptyError`. Publish and library-disable validation prevent this.
3. **Bonus count.** The cap is `min(definition.maxAdditionalBonuses ?? 3, |eligible families for slot|)`.
   - Keep the weights for counts `0..cap` and renormalise them.
   - If exactly one count has positive weight, there is no draw. Otherwise draw once with `rng.intInclusive(1, Σ kept weights)` and walk the counts in ascending order.
   - If Σ kept weights = 0, throw a config error. Publish refuses any config that would produce this for an enabled definition.
4. **Families.** `count` draws, uniform without replacement over the enabled, slot-eligible families in config order. This is the existing algorithm, with no weights.
5. **Magnitudes.** One draw per chosen family, in canonical order, uniform over its rarity range by step.
6. **Primary SP.** Only if `definition.primarySpEligible` and the rarity has `primarySp` with `chanceBp > 0`.
   - The gate is one draw `intInclusive(1, 10000)`, only when the chance is below 10000. A chance of 10000 is guaranteed and draws nothing.
   - Then one value draw over `min…max` by `step`.
   - The result is stored as `rolled_properties.primarySp`.

Primary SP is drawn **last** so that turning it on or off for a definition never shifts the draws that came before it. A future decision to give N/R/SR primary SP would then append to, not disturb, their legacy sequence.

**Example: renormalisation.** SSR weights `{0:0, 1:4000, 2:5000, 3:1000}`, definition maximum 2. The kept weights are `{1:4000, 2:5000}`, giving P(1) = 44.4% and P(2) = 55.6%. The over-limit 10% is spread proportionally, **not** piled onto 2.

**Compatibility of the legacy and distribution models.** A legacy rule `{chance, count}` *is* the distribution `{0: 10000−chance, count: chance}`. However, its draw (`> chance` on `1..10000`) differs from the cumulative walk above. Converting N/R/SR to distribution mode would therefore change seeded results. That is why they stay in legacy mode, and why the equivalence is documented and not executed.

**Recording.** Each grant records the published config revision it used. It goes into `equipment_events` metadata, and into `rolled_properties.rollConfigRevision` for distribution-mode copies.

## 9. Ownership and publication

### 9.1 Who owns what

| Concern | Authoritative | Bootstrap | Lifecycle |
| --- | --- | --- | --- |
| Equipment definitions | `equipment_definitions` | `equipment.seed.json`, insert-missing (unchanged) | Direct edit, integer `revision`, audit event |
| Roll rules (N/R/SR legacy block + SSR/UR/LR) | Published `equipment_roll_config_revisions` row | `combatBonuses.json` → `legacy` block, `rarities: {}`; once, at first start | Draft → validate → **publish** → rollback |
| Legacy affixes (N/R/SR) | `content/equipment/affixes.json` (deploy) | — | Unchanged; shown read-only in the Portal |
| Managed affix libraries | `equipment_affix_libraries` + `equipment_affixes` | none (start empty) | Direct edit, integer `revision`, audit event |
| Rarity → library assignment | Published roll config | — | Published with rules |

### 9.2 Roll-config lifecycle (the Region Pools pattern, `0069`)

- **Bootstrap.** Startup holds an advisory lock. If no config row exists, it creates one from shipped `combatBonuses.json`: the `legacy` block verbatim, `rarities: {}`, `flatSpLimits` null. It publishes that as revision 1 (`source: bootstrap`) and records a `bootstrapped` event.
- **Restarts** never overwrite. If the shipped JSON's legacy block differs from the published one, startup logs a `drift_detected` event and keeps the DB. The Region Pools behaviour is the precedent.
- **Draft.**
  - Saves are optimistic on `draft_revision`; a stale save returns `409 EQUIPMENT_RULES_STALE`.
  - Validation runs on every save: schema, weights total 10000, pool-size feasibility, cap checks, limits set before SP is enabled, assigned libraries exist and are enabled. Problems are reported as errors or warnings.
  - The `legacy` block is **immutable** in 3.0. A draft whose legacy block differs from the published one is refused.
- **Publish** (`equipment.publish`). In one transaction:
  1. lock the config row `FOR UPDATE`;
  2. re-validate the draft against **live** definitions and libraries — every enabled definition must be rollable under the new rules;
  3. insert an immutable revision (number, body, `sha256` hash, source, publisher);
  4. move the published pointer;
  5. write a `published` event.
- **Rollback.** Re-publish an earlier revision's body as a new revision (`source: rollback`, `rolled_back_from`). It is re-validated the same way.
- **Import/export.** Export the published revision or the draft. An import **writes the draft only**; it never publishes.

### 9.3 Publication boundary (when new rules take effect)

- A grant reads the published pointer **inside its transaction** with `FOR SHARE`. It then uses an in-memory body cached by revision id; a revision is immutable, so the cache is always correct.
  - Grants that started before a publish finish under the old revision. Publish waits for them.
  - Grants that start after the publish commits use the new revision.
  - One grant, including a multi-copy grant, never mixes revisions.
- It's a single API+bot process today, but this approach is also correct across processes, because the pointer is read from Postgres on every grant and nothing is pushed between processes.
- **Owned copies:** stored rolls stay authoritative forever.
- **Dungeon `rollSeed` claims** resolve at claim time against the live published config. They stay reproducible in 3.0 because:
  - dungeon loot can only name N/R/SR (snapshot schemas stay on `EQUIPMENT_REWARD_RARITIES`), **and**
  - the legacy block is immutable.

  If a later phase makes N/R/SR editable or lets dungeons drop SSR+, the run must also pin `rollConfigRevision` into its frozen reward plan at start. That's an additive field, and it's recorded here as a precondition for that work. **[NOT 3.0]**

### 9.4 Cross-object validation rules

| Action | Refused when |
| --- | --- |
| Publish rules | Any enabled definition of a distribution rarity would have zero rollable count mass, or fewer eligible families than its minimum positive-weight count. An assigned library is missing, disabled, or has no enabled entry for a slot that an enabled definition of that rarity uses. SP is enabled for a rarity while `flatSpLimits` are unset, or a rarity's `primarySp.max` + `flat_sp.max` exceeds `perItemMax`. |
| Save / enable definition | Same feasibility checks against the **published** rules. If the rarity has no published rule, the definition *may* still be saved and enabled. It can't be rolled randomly, and no random selector can reach SSR+, so nothing pays it. The editor shows a warning. |
| Disable library / disable its last slot-eligible entry | The published config assigns it to a rarity with enabled definitions. Reassign and publish first. Warnings start earlier, when a draft or published config references it. |

### 9.5 Cap warnings (combat caps are not raised)

The existing hard rule stays: a family's single-item `maxBp` must be at most its family cap (`maxCombatBonusValueBp`). Publish adds **warnings**, never errors, per rarity and family:

- `3 × maxBp > cap` → "A full loadout of max rolls hits the cap."
- `3 × mean > cap` → "A full loadout typically hits the cap."

They're shown with the computed numbers. Equipped totals are still clamped by `clampCombatModifiers`, as today.

For flat SP, `perItemMax` and `perLoadoutMax` are new **SP-only** limits. They're enforced as validation, and `perLoadoutMax` also clamps in the math (§10.2). **No combat cap is changed.**

## 10. Flat SP

### 10.1 Two independent sources, stored independently

| | Primary SP | Additional `flat_sp` |
| --- | --- | --- |
| Rule | `rarities.<R>.primarySp` (chance, min, max, step) | `rarities.<R>.families[stat=flat_sp]` (range, slots) |
| Definition opt-in | `primarySpEligible` | via slot eligibility; counts toward `maxAdditionalBonuses` |
| Consumes a bonus slot | **No** | **Yes** |
| Stored at | `rolled_properties.primarySp` (integer SP) | `combat_bonuses[] { stat: "flat_sp", valueBp: <SP> }` |
| Distinct per item | one value | one entry (no-duplicate rule) |

**Example.** One copy can store `rolled_properties: {"primarySp": 20}` and `combat_bonuses: [{"stat":"flat_sp","valueBp":11}, …]`. Its total is +31.

**Storage-shape decision (B4).** Recommended: keep the single `{stat, valueBp}` entry shape, where `valueBp` holds whole SP when the family unit is `sp`. That way validation, grouping, ordering and every existing reader handle one shape. A registry entry per family declares the unit. The alternative is a `value` key used only by flat families. That would mean branching in `combatBonusListIssues`, `readStoredCombatBonuses` and the API.

### 10.2 Calculation (`assembleCombatStats` stays canonical)

```text
naturalSp     = currentSeductivePower(...)                         // unchanged; CombatBuddy.currentSp stays natural
itemSp(i)     = (i.rolledProperties.primarySp ?? 0) + (i.combatBonuses[flat_sp]?.valueBp ?? 0)
flatSpBonus   = min(Σ itemSp(i) over equipped slots, flatSpLimits.perLoadoutMax ?? ∞)
effectiveSp   = naturalSp + flatSpBonus
ATK/DEF/HP    = deriveStat(effectiveSp, i.rolledMultiplierBp)      // all slots
combatModifiers = aggregateCombatBonuses(items)                    // flat_sp excluded (not a CombatModifier)
formulaVersion  = 3
```

- **No recursion.** Every term is a stored integer.
- **No double application.** SP is summed once, and `aggregateCombatBonuses` skips `sp`-unit families. This is done by splitting `EQUIPMENT_BONUS_STATS` from the modifier-mapped `COMBAT_BONUS_STATS`.
- **Natural SP is never written.**
- `CombatBuddy` gains `flatSpBonus` and `effectiveSp`. It's additive.
- **Natural SP stays the input for:** progression, leveling, bosses, World Encounters, the trainer profile, and **dungeon event skill checks**. `DungeonFighter.currentSp` stays natural; an `effectiveSp` field is added for display only.
- **Snapshots.** Dungeon runs and Combat Trials store already-derived ATK/DEF/HP, so in-progress runs and stored attempts are untouched. New snapshots carry `formulaVersion: 3`.
- `perLoadoutMax` is read from the published config when stats are calculated. **Decision B5:** clamp live, or freeze per copy? Recommend live clamp. It's a safety ceiling, the same role `COMBAT_MODIFIER_CAPS` plays.
- **`previewSlot`** must return deltas for **all three** stats, since a flat-SP item moves every stat. **[MINOR]**

## 11. Affix libraries and existing names

### 11.1 Storage and resolution

- **N/R/SR keep the legacy path exactly.**
  - `affixes.json` is loaded as today, and `affixes.rollable('<slot>.<rarity>')` stays the draw source.
  - The Portal shows it as three **read-only virtual libraries**, `legacy_n`, `legacy_r` and `legacy_sr`, each entry's slot taken from its pool.
  - This is an *adapter for display and key-uniqueness checks only*. Nothing is copied into the DB, and the file isn't rewritten.
- **Managed libraries (SSR/UR/LR)** live in the DB (§13, migration D). Assignment is per rarity in the published config:
  - `{ library: key }`, which can be shared — SSR and UR → `high_rarity_affixes`;
  - dedicated — LR → `legacy_affixes`;
  - `{ affixless: true }`, the 3.0 default for all three.
- **Key resolution** for display (`equipmentDisplayName`) checks the legacy catalogue first, then managed affixes (an in-memory map refreshed on every library write), then falls back to `[Unknown Affix]`, as today.

### 11.2 Preserving historical names (smallest safe approach)

- **Snapshot the suffix.** Every copy rolled from a **managed** library stores `rolled_properties.affixSuffix`, the rendered suffix text at grant time. Display prefers the snapshot. Editing, disabling or deleting an entry, or reassigning a library, never renames an existing copy.
- **Legacy copies** (all copies before 3.0) have no snapshot and keep resolving through the unchanged legacy file. That file's existing rule still holds: disable, never delete. The startup check `readUnknownAffixKeys` stays.
- **Keys are never reused.**
  - Managed affix rows are never hard-deleted once any copy references the key. The check is `player_equipment.affix_key`, and the Portal offers **disable**.
  - An unreferenced entry may be deleted, but its key stays reserved in an audit event, and the uniqueness check includes the reserved keys.
- **No snapshot for N/R/SR.** Their rows stay byte-identical to today; display already resolves through the file.

**Lifecycle choice.** Libraries have **their own versioning**: a per-library integer `revision` plus audit events. They do not share the rules' draft/publish lifecycle. Reasons:

- affixes are flavour only and change no stats;
- every copy snapshots its suffix;
- the only operational risk is a rarity losing all its candidates, which §9.4 blocks.

What *does* affect the roll — which library a rarity uses — is part of the published rules.

## 12. Admin Portal — Equipment

### 12.1 Permissions and conventions

- **Permissions.** Add `equipment.read`, `equipment.write` and `equipment.publish` (publish and roll back rules) to `ALL_PORTAL_PERMISSIONS`, with descriptions. These are code-only, like `enemies.*` and `regions.*`. A future `equipment.grant`, for player grants, is separate and **[NOT 3.0]**.
- **Existing conventions apply.** Routes under `/v1/admin/equipment/*` use the existing session auth, `requirePortalPermission`, the CSRF double-submit (`wm_portal_csrf` / `x-portal-csrf`), the response envelope, and `ApiErrorWithDetails` with per-field `details.issues`. All validation runs server-side through the shared schemas; the Portal only renders the results.
- **Optimistic concurrency** uses explicit **integer revisions**, never `updated_at`.
  - `now()` is the transaction start time, not the commit time.
  - JS `Date` truncates Postgres microseconds, so a round-tripped ISO timestamp never matches without special SQL.
  - Every existing editor (enemies, dungeons, region pools) uses an integer revision.
- **Audit.** One `equipment_admin_events` table covers definitions, rules and libraries (migration C). Package imports still also write `equipment_import_log`.

### 12.2 Equipment Catalogue (manual authoring)

| Capability | Route | Backing |
| --- | --- | --- |
| List / search / filter (slot, rarity N…LR, status, name or key) | `GET /definitions` | `listDefinitions` **[REUSE]** + LR |
| View, with owned count, rule feasibility, derived bonus pool, field-lock state | `GET /definitions/:key` | — |
| Validate (dry run) | `POST /definitions/validate` | `validateEquipmentDefinition` + rule checks |
| Create | `POST /definitions` | `create` + event |
| Edit (`expectedRevision`) | `PUT /definitions/:key` | `update` + rarity freeze + event |
| Enable / disable (`expectedRevision`) | `POST /definitions/:key/enabled` | `setEnabled` + **reward-pool impact** (§12.3) |
| Duplicate (new key; copies fields; starts **disabled**) | `POST /definitions/:key/duplicate` | `create` |
| Delete (only if never referenced) | `DELETE /definitions/:key` | `delete` **[REUSE]** |
| Preview rolls | `POST /definitions/:key/preview-rolls` | §12.6 |
| Usage and references | `GET /definitions/:key/references` | owned/equipped counts. Reward tables, dungeon loot tables and encounter `give_equipment` selectors that **name or match** it, reusing `auditRewardTableSelectors` and `equipmentSelectorIssues`. Workshop recipes that match. |
| Export (all, filtered, or selected keys) | `GET /export?keys=` | `exportPackage` **[REUSE]** |

**Form fields.**

- Shown: key (create only), name, description, slot, rarity, multiplier min/max/step, primary-SP eligible, max additional bonuses, tags, region, artwork path, enabled.
- Locked fields render read-only with the reason ("12 copies exist").
- `secondaryEffects`, `shopRegions`, `buyPrice` and `priceCurrency` are **not shown**. Nothing reads them, and they round-trip unchanged.
- Artwork stays the existing filesystem `artworkPath`. Managed `equipment_art` assets are **[NOT 3.0]**.

**Field effects on existing copies:**

| Field | Effect |
| --- | --- |
| key | Immutable |
| slot, rarity | Frozen once any copy exists (rarity is new; it prevents the snapshot-claim failure found in Revision 1) |
| multiplier range, `primarySpEligible`, `maxAdditionalBonuses`, enabled, tags, region | **Future drops only.** The range also moves the *display-only* roll-quality % of existing copies. |
| name, description, artwork | **Changes how existing copies look**; never their stats |

### 12.3 Import/export (one system: the existing package path)

Workflow:

1. **Upload or paste.** JSON, size-limited, read in the browser and sent as a body. The server never touches a path.
2. **Schema validation:** `parseEquipmentPackage`, accepting **v2 and v3**. A v2 entry defaults `primarySpEligible: false` and `maxAdditionalBonuses: null`. Exports write v3; the seed file stays v2 and still works.
3. **Dependency validation:**
   - unknown region;
   - artwork path shape;
   - rule feasibility against published rules (warning);
   - frozen-field changes on referenced keys (error, the existing `assertSlotChangeAllowed` path plus rarity).
4. **Preview.** `previewImport` gives a create/update/unchanged plan with changed fields. **New:** a per-entry **reward-pool impact** list — which live selectors (boss, World Encounter, Workshop) an *enabled N/R/SR* entry would join.
5. **Conflict detection.** The preview returns a `planHash`, and `applyImport` takes `expectedPlanHash`. It already re-plans under lock; it now also refuses with `409 EQUIPMENT_IMPORT_STALE` if the plan changed. **[MINOR]**
6. **Confirmation.** An explicit apply, with an option to **"import new definitions as disabled"**, on by default (decision B9).
7. **Atomic application:** `applyImport` **[REUSE]**.
8. **Audit:** an `equipment_import_log` row **[REUSE]**, plus one `equipment_admin_events` row per key.

**Reward isolation.**

- **SSR/UR/LR:** imports can never reach random rewards, because selectors, loot schemas and recipes stay N/R/SR.
- **N/R/SR:** enabled imports do join live rarity-less selectors. That's today's behaviour, so it's surfaced in the preview and avoided by default through import-as-disabled. **Reward rarity eligibility itself is unchanged.**

**Sample author file** (package v3, real field names):

```json
{
  "format": "waifumon-equipment",
  "version": 3,
  "label": "SSR test batch (staging)",
  "definitions": [
    {
      "key": "example_relic_blade",
      "name": "Relic Blade",
      "description": "Older than the dungeon. Sharper too.",
      "slot": "attack",
      "rarity": "SSR",
      "multiplierMinBp": 11000,
      "multiplierMaxBp": 13000,
      "multiplierStepBp": 500,
      "primarySpEligible": true,
      "maxAdditionalBonuses": 3,
      "secondaryEffects": [],
      "tags": [],
      "regionId": null,
      "artworkPath": null,
      "enabled": false,
      "shopRegions": [],
      "buyPrice": null,
      "priceCurrency": "waifubux"
    }
  ]
}
```

Fields with defaults may be omitted: `description`, `secondaryEffects`, `tags`, `regionId`, `artworkPath`, `enabled`, `shopRegions`, `buyPrice`, `priceCurrency`, and the two new fields. An `id`, or any unknown field, is refused.

### 12.4 Rarity & Bonus Rules

- **Shows:** published revision (number, publisher, time), draft status and diff, warnings.
- **Per rarity:**
  - N/R/SR: a **read-only** legacy panel showing chance, count, ranges and eligibility.
  - SSR/UR/LR, editable:
    - bonus-count weights 0–3, with a live total that must be 100.00%;
    - families: enable, slots, min/max/step in each family's unit;
    - primary SP: chance, min, max, step, or off;
    - affix assignment: library or affixless.
- **Global:** `flatSpLimits`.
- **Actions:** save draft (`expectedDraftRevision`), validate, discard draft, **publish**, revision history, **rollback**, export (draft or published), import (to draft).
- **Preview** (§12.6), for any rarity × slot × `maxAdditionalBonuses`, using the draft.

Routes: `GET/PUT /rules/draft`, `POST /rules/validate`, `POST /rules/publish`, `GET /rules/revisions`, `POST /rules/revisions/:n/rollback`, `GET /rules/export`, `POST /rules/import`.

### 12.5 Affix Libraries

- **Libraries:** list and search (legacy virtual libraries included, read-only), create and edit (`expectedRevision`), enable and disable.
- **Entries:** add, edit (suffix, slots), enable, disable, and delete when unreferenced.
- **Disabling** is guarded by §9.4. A warning appears whenever a draft or the published config assigns the library.
- **Assignment** is shown read-only: "Used by: SSR, UR (published) · LR (draft)". It's edited on the Rules screen.
- **Name preview:** pick a definition and see up to N sample names.
- **Import/export** uses the §7.3 JSON with a create/update/unchanged plan, the same preview → confirm → atomic apply flow, and conflict detection on library `revision`. Import never deletes entries. A key that collides with the legacy file or another library is an error.
- **History:** per-library `equipment_admin_events` (author, time, before/after).
- **No filesystem paths are accepted.** Libraries are identified by managed key only.

Routes: `/affix-libraries[/:key[/affixes[/:affixKey]]]`, plus `/affix-libraries/:key/export` and `/affix-libraries/import`.

### 12.6 Roll preview

Previews are pure and write nothing. They run on the server only and use the real `rollEquipmentInstance` with the chosen config (draft or published).

- **Analytic:** count distribution after renormalisation, per-family selection probability, magnitude ranges, primary-SP probability and range, total-SP min/max, cap warnings.
- **Sampled:** K rolls (max 50) with a caller-visible seed, so a preview can be reproduced. Each sample shows name, multiplier, bonuses, primary SP and total SP.

## 13. Migration plan

Not created in this task. Numbers are indicative; each migration is hand-written, idempotent and forward-only, following the house style.

| # | Migration | Contents | Needed by |
| --- | --- | --- | --- |
| A | `0070_equipment_three_bonuses` | `player_equipment_combat_bonuses_check` → `jsonb_array_length <= 3`. Add `player_equipment_rolled_properties_check`: `jsonb_typeof = 'object'`. | E3-A |
| B | `0071_equipment_definition_roll_policy` | `equipment_definitions`: add `revision integer not null default 1` (CHECK ≥ 1); `primary_sp_eligible boolean not null default false`; `max_additional_bonuses smallint null` (CHECK 0–3). Existing rows read as revision 1, ineligible, and null, which is today's behaviour. | E3-A |
| C | `0072_equipment_roll_config` | `equipment_roll_config` (singleton: `id smallint pk check (id = 1)`, `draft_body jsonb`, `draft_revision`, `draft_hash`, `published_revision_id` FK, `updated_*`). `equipment_roll_config_revisions` (immutable: `number` unique, `body`, `content_hash`, `source in ('bootstrap','editor','import','rollback')`, `rolled_back_from`, `published_by/at`). `equipment_admin_events` (`subject_kind in ('definition','rules','affix_library','affix')`, `subject_key`, `action`, `actor`, `details jsonb`, `created_at`). | E3-B |
| D | `0073_equipment_affix_libraries` | `equipment_affix_libraries` (`key` pk, `name`, `description`, `enabled`, `revision`, `created_*`, `updated_*`). `equipment_affixes` (`key` pk, `library_key` FK RESTRICT, `suffix`, `slots text[]` CHECK ⊆ slot list, `enabled`, `position int`, timestamps); unique index on `lower(suffix)`. | E3-B |

**What is deliberately not migrated:**

- `primarySp`, `affixSuffix` and `rollConfigRevision` per copy go in `rolled_properties`. That column exists, is jsonb, is named for exactly this ("rolled properties"), and is already carried into `CombatSlotItem`.
- `secondary_effects` stays reserved.
- The rarity CHECK already admits LR.

**Rollback considerations:**

- B, C and D are additive. Rolling back means dropping the new tables and columns, and only before E3-C ships SSR+ rolls.
- Once any copy has 3 bonuses, A **cannot** be narrowed again. It's forward-only, and the code would need a "≤ 3" reader in any case.
- Old code reading new rows is safe: `readStoredCombatBonuses` skips the unknown `flat_sp`, and `rolled_properties` is ignored. Those copies would just lose their SP effect until the code returns. That's acceptable for a rollback, and noted.

## 14. Implementation phases

The order is revised from the suggested one. The high-rarity engine needs a configuration source. Building it straight on the managed config avoids temporarily extending `combatBonuses.json` and then migrating that extension.

### E3-A — Foundations and the effective-SP math

- **Depends on:** nothing.
- **Migrations:** A, B.
- **Scope:**
  - Split the rarity constants: `EQUIPMENT_ROLLABLE_RARITIES` (N…LR) vs the unchanged `EQUIPMENT_REWARD_RARITIES`, `COMBAT_BONUS_LEGACY_RARITIES` and `WORKSHOP_RECIPE_RARITIES`.
  - Add LR to authoring.
  - Rarity freeze; integer `revision` on definition writes.
  - `MAX_COMBAT_BONUSES_PER_ITEM = 3` (legacy rule ceilings stay 2).
  - `EQUIPMENT_BONUS_STATS` with `flat_sp`, unit `sp`.
  - `readRolledProperties`.
  - `assembleCombatStats` v3 with `effectiveSp`; all-stat `previewSlot`; `GROUP BY rolled_properties`.
  - Fixed grants may dictate `primarySp` and `flat_sp`, which is how the tests build such copies.
  - Display (Discord, Portal, API `COMBAT_BONUS_FAMILY_IDS` + `flat_sp`, `primarySp`/`effectiveSp` fields; `DungeonFighter.effectiveSp`).
- **Files:**
  - `equipment/{vocabulary,combatBonuses,equipmentMath,equipmentRoll,equipmentService,equipmentQueries,definitionSchema,equipmentDefinitionService,equipmentPackage,rewardSelector,workshopConfig}.ts`;
  - `combatStatsService.ts`, `dungeonFighter.ts`;
  - `api/schemas/equipment.ts`;
  - presenters, `portal/src/features/equipment/*`.
- **Risks:**
  - The constant split must leave every selector, loot and snapshot schema on N/R/SR.
  - Grouping changes must not split today's groups; existing rows are all `{}`.
- **Acceptance:**
  - Golden N/R/SR seeds are byte-identical.
  - Formula v3 equals v2 numbers when there's no SP.
  - 250 + 20 + 30 → 300 for all stats.
  - Existing rows are valid.

### E3-B — Managed configuration and affix libraries (no new behaviour)

- **Depends on:** E3-A.
- **Migrations:** C, D.
- **Scope:**
  - The roll-config store: bootstrap, draft, publish, rollback, drift detection, advisory lock, events. It's modelled on `regionPoolStore.ts` and `regionPoolService.ts`.
  - The runtime reads the **published legacy block** in place of `getContent().equipmentCombatBonuses`, for the identical legacy roll. The content loader still validates the JSON for bootstrap and drift.
  - The affix-library store, display resolution and in-memory map.
  - Definition admin events.
- **Risks:**
  - The bootstrap must reproduce the shipped catalogue exactly; a hash comparison test guards it.
  - Grants gain one pointer read.
- **Acceptance:**
  - The full equipment suite is unchanged against the baseline.
  - Golden seeds are identical with the config coming from the DB.
  - A restart doesn't overwrite a published config.
  - Publish and rollback are atomic and audited.

### E3-C — High-rarity roll engine

- **Depends on:** E3-B.
- **Migrations:** none.
- **Scope:**
  - The distribution-mode branch of `rollEquipmentInstance` (§8): renormalised counts, per-definition maximum, distinct families with per-rarity ranges and slots, `flat_sp`, primary SP, library or affixless affixes, `affixSuffix` and `rollConfigRevision` snapshots.
  - Publish and definition feasibility validation (§9.4) and cap warnings (§9.5).
  - Preview functions (§12.6) as pure functions.
- **Risks:**
  - Any accidental shift of legacy draws.
  - Exhaustion edge cases: cap 0, single positive weight, pool smaller than count.
- **Acceptance:**
  - SSR/UR/LR roll with and without affixes.
  - Distributions match their weights within statistical tolerance over seeded runs.
  - Legacy goldens are still identical.
  - No reward selector can reach SSR+.

### E3-D — Admin Equipment Catalogue

- **Depends on:** E3-A. Its rule-feasibility warnings need E3-C. It can be built in parallel with E3-B and E3-C, and lands after E3-C.
- **Migrations:** none.
- **Scope:**
  - Permissions.
  - The §12.2 routes and §12.3 import with `planHash` and reward-pool impact.
  - Package v3.
  - Portal pages and MSW handlers.
- **Acceptance:**
  - The permission matrix holds.
  - Stale revision → 409.
  - A frozen-field edit is refused.
  - Import is atomic, audited and conflict-detected.
  - Imported SSR+ is unreachable by rewards; an N/R/SR import shows its impact and defaults to disabled.

### E3-E — Admin Rarity Rules and Affix Library editors

- **Depends on:** E3-C, E3-D (shell and permissions).
- **Migrations:** none.
- **Scope:** the §12.4 and §12.5 routes and pages; rules and library import/export; history and rollback UI; previews.
- **Acceptance:**
  - Draft edits don't affect drops until published.
  - Rollback restores the earlier rules.
  - Disabling a library in use is refused with guidance.
  - Old copies keep their names through every library edit.

**Approximate size:** A ≈ 15 files plus a portal touch; B ≈ 10 new or changed modules; C ≈ 5 modules with heavy unit tests; D and E ≈ 2 route modules plus 2 Portal feature folders each.

## 15. Regression and compatibility tests

**Baseline.** The suite has known pre-existing failures (about 107 root, about 20 portal). Run every comparison against a clean worktree at `3fbb802` and diff the failure sets; never compare absolute counts.

| Area | Tests |
| --- | --- |
| **Golden N/R/SR (gate for every phase)** | A new `tests/unit/equipmentRollGolden.test.ts`. For each of the 30 seeded definitions × seeds 1…200, record `{rolledMultiplierBp, affixKey, combatBonuses}` from today's code into a checked-in fixture. Assert byte equality after each phase, including when the rules come from the DB published legacy block (E3-B). It also records the RNG call count per roll, so no extra draw can hide. |
| Bonus probabilities and ranges | The legacy block equals shipped `combatBonuses.json` (hash). N chance-gate frequency ≈ 65% over seeded runs. Ranges and step values are unchanged. |
| Affix names | Every shipped legacy affix renders identically. `equipmentDisplayName` for legacy keys is unchanged. The unknown-key behaviour is unchanged. |
| Ownership and grouping | Existing rows group as before. Copies differing only in `rolled_properties` don't merge. Loadout FKs and slot rules hold (`equipmentConstraints`, `equipmentService`). |
| Primary SP | Chance 0 / partial / 10000 (no gate draw at 10000). Value within range and on step. Ineligible definition → no draws. Stored independently of `flat_sp`. |
| Two SP sources on one item | `primarySp: 20` + `flat_sp: 11` → item +31. `flat_sp` uses one bonus slot; primary uses none. |
| Multi-slot SP | Three items' SP sum. `perLoadoutMax` clamps. All three stats use effective SP. Natural `currentSp` is unchanged. `flat_sp` is absent from `combatModifiers`. |
| Distributions | Renormalisation exactness (analytic and sampled). Single-outcome case draws nothing. Zero mass → config error. |
| Per-definition maximum | Max 0 → no bonuses. Max 1/2 truncation. Null → rarity ceiling. Legacy rarities refuse a non-null maximum. |
| Distinct families | Never a duplicate stat. Count capped by slot pool size. Publish refuses an infeasible config. |
| SSR/UR/LR affixes | Affixless → null with no draw. Library → slot-filtered candidates. `affixSuffix` snapshot. An empty library is refused at publish or disable. |
| Drop-rate isolation | Every existing selector, loot table, snapshot schema and recipe resolves the same candidate set after an enabled SSR, UR and LR definition is added (`equipmentRewardSelector`, `equipmentRewards`, `bossEquipmentRewards`, `expeditionEquipmentRewards`, `worldEncounterEquipment`, `equipmentWorkshop`). |
| Dungeon reproducibility | Seeded dungeon claims are identical before and after (`equipmentSeededRewards`, dungeon integration). |
| Snapshots | An in-progress run's fighter is unchanged after deploy. New runs and Trials carry formula v3 with effective-SP stats. Event checks use natural SP. |
| Affix preservation | Edit suffix, disable, delete-unreferenced, reassign library, rename library → existing copies keep their names. A referenced affix delete is refused. Key reuse is refused. |
| Definition import/export | v2 and v3 round-trip. v2 defaults. `planHash` conflict. Frozen-field refusal. Import-as-disabled. Reward-impact list. Atomic rollback on any error. |
| Rules and library import/export | Rules import writes the draft only. Library import plan create/update/unchanged. A collision with legacy keys is refused. |
| Concurrency | Two editors on one definition, one library and the rules draft → the second gets 409. Publish racing a grant: the grant uses exactly one revision. Two processes bootstrapping → one bootstrap. |
| Permissions | No permission → 403. `read` can't write. `write` can't publish. Player routes expose no admin fields. CSRF required on writes. |
| Restart persistence | Edited definition, published rules and libraries survive a restart. JSON drift is logged, not applied. |
| Publication and rollback | Publish is atomic and audited. Rollback creates a new revision with the old body. Draft discard. |
| Migrations | A: existing rows valid, 3 accepted, 4 refused. B: defaults reproduce today. C/D: idempotent re-run (`equipmentMigration` style). |

## 16. Decisions requiring approval

**Balance.** Values are deliberately not set here.

| # | Decision |
| --- | --- |
| B1 | SSR/UR/LR bonus-count weights (0–3) |
| B2 | SSR/UR/LR per-family magnitude ranges and slot eligibility, including `flat_sp` |
| B3 | SSR/UR/LR primary-SP chance and range |
| B5 | `flatSpLimits.perItemMax` / `perLoadoutMax`. Technically safe defaults to start from, **pending approval**: per item ≤ 200, per loadout ≤ 400. These are integrity rails far below integer-safety concerns, not tuning. Live clamp recommended. |
| B7 | Which rarities, if any, get managed affix libraries at launch (default: all affixless) |

**Design** (recommendation in brackets).

| # | Decision |
| --- | --- |
| B4 | `flat_sp` stored as `{stat, valueBp}` with unit `sp` [yes] vs a separate `value` key |
| B6 | N/R/SR stay legacy mode, read-only, with no per-definition maximum and no primary SP in 3.0 [yes] |
| B8 | Separate `equipment.publish` permission [yes], vs folding it into `equipment.write` |
| B9 | Portal create, duplicate and import default new definitions to **disabled** [yes] |
| B10 | Affix libraries versioned independently of rules [yes] (§11.2) |
| B11 | The phase order A → B → C → D → E, with D in parallel after A [yes] |

## 17. Explicitly out of scope

- New combat mechanics or bonus families beyond `flat_sp`.
- Raising combat caps.
- Crafting or upgrades.
- Set bonuses.
- New slots.
- Equipment shops.
- Admin player grants.
- Automatic high-rarity drops.
- SSR+ in reward selectors, dungeon loot or Workshop.
- Production SSR/UR/LR definitions or affix content.
- Changes to owned equipment.
- Managed equipment artwork.
- Per-definition bonus pools.
- Dungeon or Region Pool refactoring.
- Pinning roll-config revisions into dungeon runs. That's a precondition recorded for later work.
