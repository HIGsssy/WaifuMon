# Equipment combat bonuses

Every owned Equipment instance has a rolled **primary multiplier** and one
flavour **affix**. Since migration `0056` an instance may also carry up to two
rolled **combat bonuses** — secondary, mechanical stats such as
`+4.25% Crit Chance`.

```text
Equipment instance
├── rolled primary multiplier     ATK ×1.15
├── affix identity                "of Poor Planning" — flavour only, one key
└── 0–2 combat bonuses            +6.5% Crit Chance, +4.25% Double Attack
```

What the bonuses *do* in a fight is the combat engine's business and is
documented in `docs/combat-system.md` (Combat modifiers). This document covers
how gear gets them, how they are stored, and how they add up.

## Where things live

| Concern | File |
| --- | --- |
| Families, catalogue schema, roll, aggregation, formatting | `src/modules/equipment/combatBonuses.ts` |
| Authored rules, ranges and eligibility | `content/equipment/combatBonuses.json` |
| The instance roll (multiplier → affix → bonuses) | `src/modules/equipment/equipmentRoll.ts` |
| Storage | `player_equipment.combat_bonuses` (`drizzle/0056_equipment_combat_bonuses.sql`) |
| Combat rules: base Crit, caps, formulas | `src/modules/combat/combatMath.ts` |
| Balance tool | `npm run combat:simulate-bonuses` (`src/tools/simulateCombatBonuses.ts`) |

## Affixes and bonuses are separate

An affix is still exactly what it was: a key, a suffix, a pool and an enabled
flag. The affix schema stays `.strict()` and carries no stat. Nothing in the
bonus system reads an affix, and no affix names a bonus.

The two roll independently. An SR item has **one** name and **two** bonuses;
it does not gain a second affix. Existing display names, the affix catalogue
and every owned instance are untouched. All 470 shipped affixes remain valid,
flavour-only entries.

## The five families

Stable storage keys. Player-facing wording lives in `COMBAT_BONUS_LABELS`, not
in the key, and a key is never renamed.

| Storage key | On an item | In loadout totals | Feeds |
| --- | --- | --- | --- |
| `crit_chance_bp` | Crit Chance | Crit | `critChanceBp` |
| `crit_damage_bonus_bp` | Crit Damage | Crit DMG (shown as the total multiplier) | `critDamageBonusBp` |
| `double_attack_chance_bp` | Double Attack | Double | `doubleAttackChanceBp` |
| `armor_penetration_bp` | Armor Pen | Armor Pen | `armorPenetrationBp` |
| `lifesteal_bp` | Lifesteal | Lifesteal | `lifestealBp` |

Values are integer **basis points**: `425` is 4.25%, `1200` is 12%.

## The catalogue — `content/equipment/combatBonuses.json`

Deployed content, validated by the content loader and followed through
content reloads, like the affix catalogue and the Workshop config. Three
parts; none of them is repeated per affix or per definition.

### Rarity rules — how many bonuses

| Rarity | `bonusChanceBp` | `bonusCount` | Meaning |
| --- | --- | --- | --- |
| N | 6500 | 1 | 65%: exactly one bonus. 35%: none. |
| R | 10000 | 1 | Always exactly one. |
| SR | 10000 | 2 | Always exactly two, of **distinct** families. |

The N chance is authored here, not buried in the roll. SSR and above have no
rule: random generation for them is not defined in this pass (and a random
grant of an SSR definition is already refused for want of an affix pool).

### Bonus families — how strong (initial tuning)

Each family has one discrete range per rarity, `minBp … maxBp` in `stepBp`
steps. Rarity controls magnitude.

| Family | Step | N | R | SR |
| --- | --- | --- | --- | --- |
| Crit Chance | 0.25% | 1.00% – 3.00% | 2.50% – 5.00% | 4.50% – 8.00% |
| Crit Damage | 0.5% | +5% – +10% | +8% – +15% | +12% – +20% |
| Double Attack | 0.25% | 0.50% – 2.00% | 1.50% – 3.50% | 3.00% – 6.00% |
| Armor Pen | 0.5% | 2% – 5% | 4% – 8% | 7% – 12% |
| Lifesteal | 0.25% | 0.50% – 1.00% | 0.75% – 1.50% | 1.00% – 2.00% |

Every value in a range is equally likely. Lifesteal was retuned down to these
deliberately modest ranges (persistent-HP Delve made the first draft far too
strong); the other four families are still at their `initial_tuning` values.

### Eligibility — which slot rolls what

Authored per slot. A definition's bonus pool is derived from its slot and
rarity (`<slot>.<rarity>`), exactly as its affix pool is; nothing is stored on
the definition.

| Slot | Eligible families |
| --- | --- |
| Attack | Crit Chance, Crit Damage, Double Attack, Armor Pen, Lifesteal |
| Defense | Crit Chance, Double Attack, Armor Pen, Lifesteal |
| Health | Crit Chance, Crit Damage, Double Attack, Lifesteal |

Families overlap across slots on purpose — an Attack, a Defense and a Health
piece can each roll Crit Chance, and the three add up. Not everything rolls
everywhere: Armor Pen and Crit Damage can come from two slots, not three.

### Health gear progression

Health now ships a full **N / R / SR** catalogue, mirroring the Attack and
Defense content shape (6 N, 3 R, 1 SR). Every definition goes through the same
shared reward selector and Workshop fabrication path by `slot` + `rarity`, so
no slot-specific wiring is needed: R and SR Health are reward- and
fabrication-capable purely because the pools are no longer empty. Health keeps
its own ×0.20 (2000bp) multiplier step; the bands overlap across rarities on
purpose (a strong N meets a weak R, a strong R meets a weak SR).

| Item | Rarity | HP multiplier band |
| --- | --- | --- |
| Dented Lunchbox (starter) | N | ×1.80 – ×2.60 |
| "Do Not Pet" Patch | N | ×1.90 – ×2.70 |
| Ex's Hoodie String | N | ×2.00 – ×2.80 |
| Emotional Support Rock | N | ×2.10 – ×2.90 |
| Lucky Charm Cord | N | ×2.20 – ×3.00 |
| Screaming Keychain | N | ×2.30 – ×3.10 |
| Bloodied Bandana | R | ×2.80 – ×3.40 |
| Pocket Saint | R | ×3.00 – ×3.60 |
| Emergency Condom Tin | R | ×3.20 – ×3.80 |
| Glitch Earring | SR | ×3.80 – ×4.60 |

The onboarding Dented Lunchbox is unchanged: a fixed, bonus-free ×2.00 grant.
A *random* Dented Lunchbox still exists in the N pool and follows the ordinary
N rules (random multiplier in its band, 65% for one bonus). Health bonus
eligibility is unchanged — Crit Chance, Crit Damage, Double Attack, Lifesteal
(no Armor Pen).

### Validation

A file that fails any of these stops the content load, with the path named:

- every range has `min ≤ max`, a step that divides it evenly, whole basis
  points, and a maximum no higher than that family's combat cap;
- no duplicate family, no unknown family, no unknown field;
- **every pool can supply its rarity's `bonusCount` in distinct, enabled
  families** — so R always has a bonus to roll and SR never needs the same
  family twice. Disabling a family is checked against this too.

The catalogue is **required content wherever random gear can be generated**:
because an affix-less pool refuses the grant outright, the catalogue is
required exactly when `equipment/affixes.json` is deployed. A missing or
invalid catalogue there is a fail-closed content/startup failure — random R/SR
gear is never handed out without the bonuses its rarity contract guarantees.
A content set without the equipment feature (no affixes) may omit it, and a
test can turn the feature off explicitly with `COMBAT_BONUSES_DISABLED`.

## The roll

Normal random acquisition, in draw order:

```text
1. the base definition is selected            (the reward source / selector)
2. primary multiplier                         uniform over the definition's range
3. affix                                      uniform over the enabled affixes of the pool
4. the rarity's bonus rule is read
5. N only: the bonus chance is rolled         rng.intInclusive(1, 10000) <= bonusChanceBp
6. bonusCount distinct families               each uniform among those still unpicked
7. each family's magnitude                    uniform over that rarity's discrete values
8. the complete instance is stored
```

All randomness comes from the injected `Rng`; nothing calls `Math.random()`
directly. The pool is checked before anything is drawn, and a pool that cannot
supply distinct families is refused (`EquipmentValidationError`) — never
papered over with a duplicated stat. Bonuses are stored in canonical family
order; the order carries no meaning.

Every random source goes through this one roll, because every one of them
ends in `grantEquipment({ roll: { kind: 'random' } })`:

| Source | Path | Kind |
| --- | --- | --- |
| World Encounters | `effectExecutor` → `grantRandomEquipmentReward` | random |
| Bosses | `bossEncounterService` → `grantChosen…` / `grantRandom…` | random |
| Expeditions | `expeditionService` → `grantChosenEquipmentReward` | random, promised at deploy |
| Dungeon drops | `dungeonPlayService` → `grantChosenEquipmentReward` | random |
| Workshop fabrication | `equipmentWorkshopService` → `grantRandomEquipmentReward` | random |
| Equipment onboarding | `equipmentOnboardingService` → `grantEquipment` | **fixed** (`STARTER_ROLLS`) |

Nothing bypasses it. There is no admin grant command and no instance
restore/import path in the codebase today; if one is added it uses a fixed
roll (below).

### Replay

A grant key pins the whole instance. A retried grant reads the original row
back — same definition, multiplier, affix, bonus count, bonus families and
bonus magnitudes — and draws nothing. Workshop retries and reward replays
return the same item for the same reason.

### Fixed grants

`{ kind: 'fixed', rolledMultiplierBp, affixKey, combatBonuses? }`.

- `combatBonuses` omitted means **none**. A fixed grant never rolls.
- The onboarding starters (Rusty Pipe, Scrap Plate, Dented Lunchbox) are fixed
  grants with no bonuses, and stay that way.
- When supplied, the list is stored exactly as dictated. It is checked for
  shape — at most two entries, known and distinct families, whole basis points
  from 1 up to the family's combat cap — and **not** against the rarity
  ranges, so a restore reproduces a copy whatever the ranges are today, and an
  SSR or UR definition can be given explicit bonuses.

### Random copies of the starter definitions

The three starter definitions are still in the random N pools
(`listRewardableDefinitions` does not filter the `starter` tag), so a Rusty
Pipe can drop or be fabricated. Such a copy is ordinary N loot and follows the
N rules: 65% for one bonus. Only the **onboarding** copies are bonus-free.

## Storage

`player_equipment.combat_bonuses jsonb NOT NULL DEFAULT '[]'`:

```json
[
  { "stat": "crit_chance_bp", "valueBp": 625 },
  { "stat": "double_attack_chance_bp", "valueBp": 400 }
]
```

A CHECK requires an array of at most two entries. It is a collection on the
instance row rather than scalar `affix_stat` / `affix_value_bp` columns
because SR carries two, and JSONB rather than a child table because bonuses
are always read with their instance and never queried alone.

**The stored values are authoritative.** They are never recalculated — not on
load, on equip, entering Delve or a Trial, viewing the Portal, or a restart —
and retuning the catalogue changes future drops only.

**Existing gear.** Rows that predate the column take the default `[]`. They
keep their multiplier and affix, stay equipable, dismantlable and usable in
combat, and contribute zero modifiers. The migration invents nothing.

**Identical copies.** The Gear Bag groups copies only when definition,
multiplier, affix *and* bonuses all match.

## Aggregation and caps

```text
owned instances → active loadout → aggregateCombatBonuses → CombatStats.combatModifiers → Trial / Delve snapshot
```

`aggregateCombatBonuses` is the one place equipped bonuses become a
combatant's modifiers. Discord, the Portal, Trials, Delve and the simulators
all read its result; none of them adds basis points.

- **Additive per family**, across all three equipped items. Crit Chance
  3.25% + 2.00% + 4.50% is 9.75%. Crit Damage bonuses add to each other and
  then to the 150% base — never multiplied one by one.
- **Zero by default.** An empty slot, a bonus-free item and a pre-system item
  contribute nothing.
- **Capped centrally**, after summing, at the combat safety ceilings: Crit
  Chance 50%, total Crit Damage 250%, Double Attack 35%, Armor Penetration
  50%, Lifesteal 20%. These are ceilings, not targets — three max-rolled SR
  pieces of one family reach 24% / 210% / 18% / 36% / 15%. A cap never
  modifies a stored roll.
- **Never persisted as player data.** Totals are derived on every
  calculation. They are stored only inside a snapshot: a Trial attempt's
  `initial_state`, a Delve run's `fighter`.

`EQUIPMENT_FORMULA_VERSION` is 2: `CombatStats` gained `combatModifiers`.

## What players see

- **Gear Bag, slot screens, drops:** each copy's bonus rows under its
  multiplier. A copy with none shows nothing extra.
- **Item detail:** primary multiplier, affix (in the name), and a *Combat
  Bonuses* list.
- **Comparison:** the equipped copy and the candidate side by side, each with
  its multiplier and bonus rows. The primary stat keeps its numeric
  difference; bonus families are never scored against each other and an item
  is never reduced to one number.
- **Loadout totals** (Equipment home, Portal loadout, Trial detail, Delve zone
  and run screens): `Crit: 9.75% · Crit DMG: 167.5% · Lifesteal: 2.5%`, zero
  rows omitted. Crit DMG is the total multiplier, base included.
- **Fight results:** a hit that crits reads "crits", a bonus strike is marked,
  and a totals line counts Crits, bonus attacks and Lifesteal for the fight.

The API (`/players/:id/equipment…`) sends percentages and ready-made text,
never basis points or storage keys.

## Packages

Equipment packages (`waifumon-equipment`, version 2) carry **definitions
only** — owned instances never travel — so the package format and version are
unchanged, and there is no per-instance export in which a second SR bonus
could be dropped. The bonus catalogue ships with the deploy, like the affix
catalogue.

## Balance (initial tuning, measured)

`npm run combat:simulate-bonuses` plays the shipped Trials and the shipped
Delve zone through the real engine for a matrix of Current SP × primary tier ×
bonus build. Figures below: 1,000 seeded fights per Trial cell and 1,000 Delve
runs per cell on `scrapheap_gauntlet`.

**Observed frequencies track configured chance.** Crit 12.5% configured →
11.9–12.1% observed; 16% → 15.3–15.8%; 24% → 22.7–24.1%. Double Attack 18% →
13.8–16.3% per normal attack (it is not rolled when the first hit kills, so
short fights read low). The unit suite checks the engine directly: 12,000
strikes per case, within 2 points.

**R → SR is still mostly the primary multiplier.** Trial 3 win rate and Delve
completion (never extracting):

| Current SP | R, no bonus | R + R bonuses | SR, no bonus | SR + SR typical | SR + SR max |
| --- | --- | --- | --- | --- | --- |
| 185 — Trial 3 | 0% | 22% | 100% | 100% | 100% |
| 185 — Delve done | 0% | 0% | 0% | 10% | 29% |
| 240 — Delve done | 0% | 3% | 95% | 100% | 100% |
| 300 — Delve done | 98% | 100% | 100% | 100% | 100% |

The SR primaries alone move Trial 3 at SP 185 from 0% to 100% and Delve at SP
240 from 0% to 95%. Two SR bonus rolls on each piece then add 15–20 points of
HP remaining and, at SP 185, open a 10–29% Delve completion that no primary
tier reaches. So the bonuses widen an existing gap rather than create it —
but at the low-SP edge the widening is the difference between impossible and
occasional.

**Lifesteal was retuned here.** The first draft (N 1–2%, R 1.5–3%, SR 2.5–5%)
made sustain dominate persistent-HP Delve: three SR-max Lifesteal pieces (15%)
on R primaries at SP 240 took Delve completion from 0% to 80%, restoring about
277 HP per run (44% of max HP). The shipped ranges are far lower — N 0.50–1.00%,
R 0.75–1.50%, SR 1.00–2.00% — and the strongest obtainable total is three
SR-max pieces at 6% (Lifesteal is eligible on all three slots). Re-simulated at
the new ranges (R primaries):

| Lifesteal build (total) | SP 240 Delve done | Healing / run | % of max HP |
| --- | --- | --- | --- |
| none | 0% | 0 | 0% |
| one R typical (1.25%) | 0% | ~19 | ~3% |
| one SR max (2%) | 0% | ~34 | ~5% |
| two-slot SR max (4%) | 1% | ~70 | ~11% |
| three-slot SR max (6%, the ceiling) | 2% | ~106 | ~17% |

So a build with essentially no completion chance no longer jumps to a high one
on Lifesteal alone (0% → 2% at the 6% ceiling, versus 0% → 80% before), while
a sustain build is still rewarded: Lifesteal steadily improves HP-at-exit and
per-run healing across a full Delve. Crit, Crit Damage, Double Attack, Armor
Pen, the primary multipliers, enemy stats and the Delve layout were left
unchanged; the interaction cases (Crit + Crit Damage, Crit + Double, Double +
Lifesteal, Armor Pen + Crit) were re-simulated and exposed no anomaly.

**Armor Penetration scales with enemy DEF**, as designed: 12% is worth +2.3%
damage into DEF 20, +4.2% into DEF 55 and +7.4% into DEF 110.

## Not in this pass

Dodge, miss chance, block, damage reduction, healing received, execute,
opening strike, stun, status effects, DOT, revive, retaliation, more than two
bonuses on one item, random bonus rules for SSR / UR, enemy modifiers, and any
change to the starter definitions' place in the random N pools.
