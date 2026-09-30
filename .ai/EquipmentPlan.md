# Waifumon Equipment System — Release Design & Implementation Plan

## 1. Purpose

The Equipment System is intended to become a new core progression layer within Waifumon.

Equipment should not belong exclusively to any one gameplay mode.

Instead, it should function as a shared player-owned system that can be:

- Earned through existing Discord gameplay.
- Managed through Discord.
- Managed in greater detail through the Portal.
- Used by current and future combat systems.
- Consumed by future Dungeon / Adventure gameplay.
- Used by future Raid systems.
- Extended later with secondary effects, upgrades, affixes, and specialised builds.

The Equipment release should therefore be designed as foundational infrastructure rather than as a feature-specific reward system.

The central rule is:

**Equipment belongs to the player globally. Any supported gameplay system can reward it, and any supported combat system can consume the same player loadout through the same authoritative backend services.**

---

# 2. Primary Goals

The initial Equipment release should accomplish the following:

1. Introduce player-owned equipment.
2. Support multiple equipment categories.
3. Allow players to equip and unequip gear.
4. Provide a single active combat loadout.
5. Derive combat statistics from the player's current Buddy SP.
6. Allow equipment to be earned through existing gameplay.
7. Allow equipment management through Discord.
8. Provide richer equipment management through the Portal.
9. Centralize equipment and combat-stat calculation.
10. Establish a data model suitable for future Dungeon and Raid systems.
11. Avoid requiring future migrations away from a simplistic quantity-based inventory model.
12. Avoid overbuilding advanced equipment mechanics before the base system proves useful.

---

# 3. Core Design Philosophy

Waifumon already tracks SP as the primary measure of an individual Waifumon's developed strength.

The Equipment System should use that existing value rather than introducing an unrelated permanent RPG stat sheet.

Equipment determines how Buddy SP is expressed in combat.

Conceptually:

```text
Buddy SP
   │
   ▼
Player Equipment
   │
   ├── Attack Conversion
   ├── Defense Conversion
   └── Health Conversion
   │
   ▼
Derived Combat Stats
```

This preserves the value of:

- Levelling
- Essence investment
- Existing collection progression
- Buddy selection
- Future Ascension

The Equipment System therefore extends existing progression rather than replacing it.

---

# 4. Player-Level Ownership

Equipment is owned by the player.

In the first release, equipment is not assigned permanently to individual Waifumon.

The player's active combat loadout is applied to the currently selected Buddy.

Example:

```text
Player
  │
  ├── Equipment Inventory
  │
  └── Active Loadout
         │
         ├── Attack Slot
         ├── Defense Slot
         └── Health Slot
                  │
                  ▼
            Current Buddy
                  │
                  ▼
               Buddy SP
                  │
                  ▼
           Combat Statistics
```

If party-based gameplay is introduced later, equipment assignment can then be extended to party members.

V1 should not implement per-Waifumon equipment assignment.

---

# 5. Initial Equipment Slots

The first release should support three core equipment slots.

## Attack Slot

Determines how Buddy SP is converted into Attack.

Example:

```text
Buddy SP: 300

Attack Equipment:
ATK multiplier ×0.80

Derived ATK:
240
```

## Defense Slot

Determines how Buddy SP is converted into Defense.

Example:

```text
Buddy SP: 300

Defense Equipment:
DEF multiplier ×0.60

Derived DEF:
180
```

## Health Slot

Determines how Buddy SP is converted into Maximum HP.

Example:

```text
Buddy SP: 300

Health Equipment:
HP multiplier ×3.00

Derived HP:
900
```

---

# 6. Future Equipment Slots

The architecture should leave room for additional slots without requiring schema redesign.

Likely future slot:

## Relic / Charm / Artifact

This slot should primarily affect behaviour rather than basic stat conversion.

Potential effects:

- Critical chance
- Boss damage
- Elite damage
- Lifesteal
- Healing effectiveness
- Special charge generation
- Trap resistance
- Rare equipment find chance
- Status resistance
- Starting shield
- Dungeon-specific effects

This slot does not need to be included in the initial release.

---

# 7. Derived Combat Statistics

The first version should derive:

- Attack
- Defense
- Maximum HP

from:

- Current Buddy SP
- Current Player Equipment

Conceptually:

```text
ATK = SP × AttackMultiplier

DEF = SP × DefenseMultiplier

MAX_HP = SP × HealthMultiplier
```

Example:

```text
Buddy:
Warband Princess

SP:
420

Attack Equipment:
×0.80

Defense Equipment:
×0.55

Health Equipment:
×3.20
```

Results:

```text
ATK: 336
DEF: 231
HP: 1344
```

These calculations should occur exclusively through centralized backend logic.

---

# 8. Central Combat Stat Service

No individual game mode should independently calculate equipment-derived statistics.

There should be one authoritative calculation path.

Conceptually:

```text
calculateCombatStats(playerId, buddyId)
```

The result should include:

```text
buddyId
sp

attack
defense
maxHp

activeEquipment
appliedEffects
```

This service can later be consumed by:

- Discord boss combat
- Raid bosses
- Dungeon mode
- Future Raid gameplay
- Portal previews
- Admin tooling
- Combat simulations
- Future challenges

The objective is to prevent formula divergence between systems.

---

# 9. Equipment as Instances

Equipment should be represented as individually owned equipment instances.

It should not simply behave like:

```text
Player owns:
Combat Belt ×3
```

Instead:

```text
Equipment Instance A
Combat Belt

Equipment Instance B
Combat Belt

Equipment Instance C
Combat Belt
```

Even if all three are identical in V1.

This provides room for future systems including:

- Rolled stats
- Secondary properties
- Item upgrades
- Locking
- Favourites
- Unique acquisition source
- Durability, if ever desired
- Trading restrictions
- Unique IDs
- Generated equipment

The initial release does not need to expose all of these systems.

---

# 10. Equipment Definitions

A definition represents the base content entry.

Conceptually:

```text
equipment_definitions
```

Fields may include:

```text
id
key
name
description

slot

rarity

attackMultiplier
defenseMultiplier
healthMultiplier

secondaryEffects

tags

artworkPath

enabled

createdAt
updatedAt
```

An individual definition should normally affect the statistic associated with its equipment slot.

Example:

```text
Spiked Combat Ring

Slot:
Attack

ATK Multiplier:
0.72
```

Example:

```text
Reinforced Battle Belt

Slot:
Defense

DEF Multiplier:
0.58
```

Example:

```text
Tactical Corset

Slot:
Health

HP Multiplier:
3.10
```

---

# 11. Owned Equipment Instances

Player-owned equipment should reference an equipment definition.

Conceptually:

```text
player_equipment
```

Potential fields:

```text
id

playerId

equipmentDefinitionId

rolledProperties

favourite
locked

sourceType
sourceKey

acquiredAt
updatedAt
```

V1 may leave `rolledProperties` empty.

The field can still exist so future generated equipment does not require a redesign.

---

# 12. Equipment Acquisition Source

Equipment instances should retain the source that created them.

Possible source types:

```text
boss
encounter
expedition
shop
admin
event
dungeon
raid
quest
```

This supports:

- Auditing
- Analytics
- Debugging
- Reward tuning
- Future collection history

Example:

```text
sourceType: boss
sourceKey: valley_bandit_queen
```

---

# 13. Equipment Rarity

Equipment can use a rarity hierarchy.

The exact naming does not necessarily need to mirror Waifumon rarity, although using the existing structure may simplify player understanding.

Possible initial equipment rarity:

```text
Normal
Rare
SR
SSR
UR
```

LR and EX equipment should probably be withheld until the system matures.

Equipment rarity should broadly influence:

- Base multiplier
- Future secondary-effect count
- Future secondary-effect strength
- Drop rarity
- Visual presentation

Rarity should not create uncontrolled power inflation.

---

# 14. Initial Multiplier Philosophy

The exact values must be established through simulation against real player SP distribution.

Illustrative Attack progression:

```text
Normal
×0.45 – ×0.55

Rare
×0.55 – ×0.65

SR
×0.65 – ×0.75

SSR
×0.75 – ×0.85

UR
×0.85 – ×0.95
```

Illustrative Defense progression:

```text
Normal
×0.35 – ×0.45

Rare
×0.45 – ×0.55

SR
×0.55 – ×0.65

SSR
×0.65 – ×0.75

UR
×0.75 – ×0.85
```

Illustrative Health progression:

```text
Normal
×2.0 – ×2.3

Rare
×2.3 – ×2.6

SR
×2.6 – ×3.0

SSR
×3.0 – ×3.4

UR
×3.4 – ×3.8
```

These values are placeholders only.

They should not be committed to production without simulation.

---

# 15. Active Loadout

The player should have one active combat loadout in V1.

The loadout contains:

```text
Attack equipment instance
Defense equipment instance
Health equipment instance
```

Conceptually:

```text
player_loadouts
```

Fields:

```text
id
playerId
name
isActive
createdAt
updatedAt
```

and:

```text
player_loadout_slots
```

Fields:

```text
loadoutId
slot
equipmentInstanceId
```

Even if V1 exposes only one loadout, the schema should support multiple loadouts.

---

# 16. Future Named Loadouts

Future UI may allow players to create presets.

Examples:

```text
Balanced

Boss Killer

Tank

Dungeon

Raid

Farming
```

This provides quick equipment switching without forcing players to manually change every slot repeatedly.

V1 can create a default loadout automatically.

Example:

```text
Default
```

Named loadout management can be exposed later.

---

# 17. Equipment Management in Discord

Discord should support practical equipment management but should not attempt to reproduce a full inventory-management application.

The primary command could be:

```text
/equipment
```

The default response should show:

```text
CURRENT EQUIPMENT

Buddy:
Warband Princess
SP: 420

ATTACK
Spiked Combat Ring
ATK ×0.80

DEFENSE
Reinforced Battle Belt
DEF ×0.55

HEALTH
Tactical Corset
HP ×3.20

COMBAT STATS

ATK: 336
DEF: 231
HP: 1344
```

Controls:

```text
[ Attack Gear ]
[ Defense Gear ]
[ Health Gear ]
[ Inventory ]
```

---

# 18. Discord Equipment Selection

Selecting an equipment slot should provide an appropriate filtered list.

Example:

```text
Attack Equipment

Spiked Combat Ring
×0.80

Plasma Coil Ring
×0.86

Raider Knuckle
×0.71
```

Only equipment compatible with the selected slot should appear.

Discord selection should prioritize usability over exposing every possible inventory detail.

---

# 19. Discord Inventory Limitations

Discord becomes cumbersome when players own large quantities of equipment.

Therefore:

**Discord should remain the quick-management interface.**

It should support:

- Viewing equipped gear
- Changing gear
- Viewing basic inventory
- Comparing obvious replacements
- Viewing derived combat stats
- Switching future presets

It should not be the preferred interface for:

- Large inventory browsing
- Complex filtering
- Bulk management
- Detailed comparison
- Affix analysis
- Equipment history

Those functions belong primarily in the Portal.

---

# 20. Portal Equipment Management

The Portal should provide the richer inventory experience.

The Equipment page should support:

- Equipment inventory
- Slot filters
- Rarity filters
- Search
- Sorting
- Equipped status
- Favourite status
- Lock status
- Side-by-side comparison
- Equip / unequip
- Current Buddy preview
- Derived combat-stat preview

Example:

```text
Current Buddy:
Warband Princess
SP: 420

CURRENT ATTACK GEAR
Spiked Combat Ring
×0.72

ATK:
302

SELECTED ITEM
Plasma Coil Ring
×0.81

NEW ATK:
340

Difference:
+38 ATK

[ EQUIP ]
```

---

# 21. Equipment Comparison

The comparison system should use the current Buddy where possible.

Rather than only showing:

```text
×0.72 -> ×0.81
```

it should also show:

```text
302 ATK -> 340 ATK

+38
```

This makes equipment improvements immediately understandable.

---

# 22. Favourite and Lock

Equipment instances should support:

```text
Favourite
Locked
```

Favourite:

Used for quick filtering and identifying preferred equipment.

Locked:

Prevents accidental:

- Selling
- Salvaging
- Deletion
- Future reroll destruction

These flags are useful even if some of those mechanics do not exist initially.

---

# 23. Reward Integration

Equipment should enter the game through existing systems.

Initial acquisition sources should include a mixture of:

- Bosses
- World Encounters
- Expeditions
- Regional shops
- Events
- Admin rewards

Future sources:

- Dungeons
- Raids
- Quests
- Crafting

---

# 24. Boss Rewards

Boss fights are a natural early source of desirable Equipment.

Boss rewards can use weighted equipment drop tables.

Example:

```text
BOSS DEFEATED

Rewards:

180 XP
24 Waifubux

RARE DROP

Reinforced Battle Belt
Rare Defense Equipment
DEF ×0.61
```

Equipment should be granted to inventory.

It should never automatically replace currently equipped gear.

---

# 25. World Encounter Rewards

World Encounters provide a good source of thematic equipment.

Example:

A Base 80085 military encounter could reward:

```text
Tactical Scope
```

An Assteroid Belt encounter could reward:

```text
Plasma Coil Ring
```

This provides regional identity without requiring new reward systems.

---

# 26. Expedition Rewards

Expeditions can provide equipment as rare reward outcomes.

Lower-duration missions may primarily reward:

- Normal equipment
- Rare equipment

Longer or more difficult missions can occasionally produce higher tiers.

Equipment should not completely displace existing:

- Salvage
- Waifubux
- Items

Instead, it should become another exciting reward category.

---

# 27. Regional Shops

Shops should provide baseline equipment.

This ensures that combat readiness is not entirely RNG-dependent.

Example:

Waifu Valley shop could sell:

```text
Basic Combat Ring

Basic Guard Belt

Basic Vitality Charm
```

These should be adequate but not optimal.

This gives new players a predictable entry point into combat.

---

# 28. Regional Equipment Identity

Equipment should support regional flavour.

### Waifu Valley

Possible themes:

- Handmade
- Adventuring
- Rustic
- Caravan
- Forest

### Twin Peeks

Possible themes:

- Climbing
- Mountain
- Cold-weather
- Rope
- Reinforcement

### Flaccid Foothills

Possible themes:

- Mining
- Industrial
- Heavy gear

### Thirstlands

Possible themes:

- Heat
- Desert
- Scorpion
- Hydration
- Sand-resistant

### Assteroid Belt

Possible themes:

- Plasma
- Vacuum
- Radiation
- Space salvage
- Alien technology

### Base 80085

Possible themes:

- Tactical
- Military
- Ballistic
- Combat
- Experimental weapons

Regional identity makes equipment collecting more interesting without changing the underlying mechanics.

---

# 29. Reward Service

All systems granting equipment should use one authoritative grant path.

Conceptually:

```text
grantEquipment()
```

Responsibilities:

- Validate Equipment definition
- Create owned instance
- Record acquisition source
- Record acquisition time
- Prevent invalid duplicates where required
- Return player-facing reward data
- Emit appropriate game events if needed

This should be reused by:

- Bosses
- Encounters
- Expeditions
- Shops
- Admin
- Future Dungeon
- Future Raid

---

# 30. Equipment Should Never Auto-Equip

Reward systems should never automatically replace player equipment.

New Equipment should always enter inventory.

Example:

```text
You received:

Plasma Coil Ring
Attack ×0.86

Added to Equipment Inventory.
```

The player chooses whether to equip it.

This prevents unexpected loadout changes.

---

# 31. Combat Usage in Discord

The initial Equipment release should ideally expose at least one meaningful current-world use case.

Potential first consumer:

**Boss combat**

Existing boss fights can begin reading player combat Equipment.

This does not necessarily mean completely redesigning the current boss system immediately.

A staged approach is preferable.

Example future calculation:

```text
Buddy SP
+
Attack Equipment
=
Boss Attack Power
```

Defense and HP become more relevant as boss combat becomes more interactive.

---

# 32. Future Raid Boss Integration

Equipment should explicitly support future Raid combat.

The Raid system should not maintain separate Raid gear.

The same active loadout should apply unless the Raid system intentionally snapshots it.

Conceptually:

```text
Current Buddy
+
Current Equipment
+
Combat Engine
=
Raid Contribution
```

---

# 33. Future Dungeon Integration

The future Dungeon system should consume the same Equipment System.

At dungeon entry:

```text
Current Buddy
+
Current Active Loadout
```

are used to derive:

```text
ATK
DEF
MAX HP
```

The Dungeon should then snapshot the equipment and combat stats for that run.

---

# 34. Dungeon Loadout Snapshot

Dungeon runs may persist across multiple sessions.

Therefore an active dungeon run should not remain bound to the player's globally active equipment.

Example:

Player begins dungeon with:

```text
Attack:
Plasma Coil Ring

Defense:
Raider Harness

Health:
Combat Corset
```

The run snapshots these.

Later the player changes the global loadout to fight a Discord boss.

The active dungeon continues using the original equipment snapshot.

This allows the player to participate in multiple systems without one mode locking their global gear.

---

# 35. Future Snapshot Model

A dungeon or Raid session may store:

```text
equipmentInstanceIds

equipmentDefinitionSnapshot

derivedStats

appliedSecondaryEffects
```

This protects an active run against changes to:

- Global loadout
- Equipment balance
- Equipment ownership
- Equipment upgrades

The exact snapshot requirements can be determined when those systems are built.

---

# 36. Secondary Effects

The Equipment model should support secondary effects conceptually from the start.

V1 does not need to make heavy use of them.

Potential future effects:

```text
+Critical Chance

+Boss Damage

+Elite Damage

+Healing

+Special Charge

+Equipment Find

+Dungeon Loot

+Status Resistance

+Counter Chance

+Lifesteal
```

Secondary effects should eventually use a data-driven effect system rather than bespoke conditional code.

---

# 37. Context-Specific Effects

Some effects may apply only in certain contexts.

Example:

```text
+10% Boss Damage
```

or:

```text
+8% Dungeon Equipment Find
```

The system should permit qualifiers.

Conceptually:

```text
effectId

value

qualifiers
```

Example:

```text
effectId:
damage_bonus

value:
0.10

qualifier:
boss
```

However, most core Equipment should remain broadly useful.

The system should avoid excessive fragmentation into:

- Dungeon-only gear
- Raid-only gear
- Boss-only gear

unless the effect itself specifically justifies it.

---

# 38. Fixed Equipment Before Random Equipment

The initial release should use fixed equipment stats.

Example:

```text
Plasma Coil Ring

ATK ×0.82
```

Every Plasma Coil Ring initially has the same value.

Do not introduce random affixes in V1.

Randomised equipment creates additional complexity around:

- Inventory size
- Comparison
- Sorting
- Balance
- Duplicate management
- Selling
- Salvaging
- Drop generation

The instance-based model leaves the option open later.

---

# 39. Future Random Equipment

A later system could allow:

```text
Plasma Coil Ring

ATK ×0.84

+4% Critical Chance
```

while another player's version could be:

```text
Plasma Coil Ring

ATK ×0.81

+8% Boss Damage
```

This should be considered a later progression feature rather than a launch requirement.

---

# 40. Equipment Upgrading

Equipment upgrade mechanics should not be included in the first release unless there is a compelling reason.

Potential future systems:

- Enhancement levels
- Material upgrades
- Rerolling
- Reforging
- Ascension
- Combining duplicates

These can significantly affect the economy.

The initial release should first establish whether:

- Equipment drops feel rewarding
- Loadouts matter
- Players understand SP conversion
- Equipment progression feels useful

---

# 41. Selling and Salvaging

Selling Equipment may eventually become necessary because instance inventories can grow significantly.

Potential future actions:

```text
Sell

Salvage

Dismantle
```

Locked Equipment should be protected from these actions.

The initial release may defer selling if inventory volumes remain small.

If Equipment is sellable at launch, it should use a dedicated Equipment valuation model rather than reusing generic item quantities blindly.

---

# 42. Inventory Limits

A decision is required on whether Equipment inventory should be unlimited.

Recommended initial approach:

**No hard inventory cap.**

Reasons:

- Avoid frustration during launch.
- Avoid requiring inventory-cleanup systems immediately.
- Gather real-world data on equipment accumulation.

If inventories become unwieldy, introduce management tools before introducing hard caps.

---

# 43. Equipment Artwork

Equipment should support artwork or icons.

V1 does not necessarily require full bespoke artwork for every item.

Options:

- Slot icons
- Rarity frames
- Generic equipment silhouettes
- Individual item artwork where available

The data model should support:

```text
artworkPath
```

from the beginning.

---

# 44. Equipment Naming

Equipment should fit Waifumon's established tone.

Names can range from:

- Straightforward
- Suggestive
- Absurd
- Region-specific
- Referential

However, the slot and mechanical purpose should remain understandable.

Example:

```text
Spiked Combat Ring

Attack Equipment

ATK ×0.72
```

The joke should not obscure the function.

---

# 45. Admin Tooling

Admin support should be included in the Equipment release.

Admins should be able to:

- View Equipment definitions
- Enable / disable definitions
- Grant Equipment
- Remove Equipment instances
- Inspect player Equipment
- Inspect active loadout
- Search Equipment by name/key
- View acquisition source
- Correct invalid equipment state

Future admin features:

- Mass grants
- Roll inspection
- Equipment migrations
- Replacement utilities

---

# 46. Import / Export

Equipment definitions should ideally support content import/export in the same spirit as other data-driven Waifumon systems.

Potential export format:

```text
waifumon-equipment
```

Content:

- Equipment definitions
- Slot
- Rarity
- Multipliers
- Secondary effects
- Tags
- Artwork paths

Player ownership should not be included in content exports.

---

# 47. Startup Seeding

Equipment seed behaviour should follow the safer model already established elsewhere in Waifumon:

**Insert missing content only.**

Startup should not overwrite administrator-edited Equipment definitions.

Reset behaviour should only occur through an explicit reset/import operation.

---

# 48. Data Validation

Equipment definitions should validate:

- Valid slot
- Valid rarity
- Multipliers within reasonable range
- Valid effect IDs
- Valid qualifiers
- Unique key
- Valid artwork path if present

Invalid Equipment content should fail loudly during import or admin editing.

---

# 49. Duplicate Equipment

Because Equipment is instance-based, multiple copies of the same Equipment definition are valid.

Example:

```text
Player Equipment

Plasma Coil Ring
Plasma Coil Ring
Plasma Coil Ring
```

For fixed-stat V1 equipment, these copies are mechanically identical.

This is acceptable because future systems may:

- Sell duplicates
- Salvage duplicates
- Upgrade through duplicates
- Roll different stats

The UI should group identical fixed-stat Equipment where useful.

---

# 50. Equipment Economy

Equipment should not immediately overwhelm existing game rewards.

Launch distribution should be conservative.

A player should feel that receiving Equipment is meaningful.

Suggested broad hierarchy:

### Shops
Baseline gear.

### Expeditions
Slow supplementary acquisition.

### World Encounters
Thematic or unusual Equipment.

### Bosses
More exciting Equipment source.

### Events
Limited or themed Equipment.

### Future Dungeon
Primary source for deeper Equipment progression.

### Future Raids
High-end and specialised Equipment.

---

# 51. Avoiding Power Creep

Equipment should strengthen existing progression without invalidating it.

Important constraints:

- SP remains the primary underlying power source.
- Equipment multipliers should stay within bounded ranges.
- Higher rarity Equipment should be better but not exponentially better.
- New regions should not automatically invalidate old Equipment.
- Secondary effects should introduce build diversity rather than only larger numbers.

---

# 52. Starter Equipment

Players may need a basic set of starter Equipment.

Possible approaches:

### Option A
Automatically grant baseline gear when Equipment launches.

### Option B
Make baseline gear extremely cheap in Waifu Valley.

### Option C
Give one starter Equipment set through a small introductory interaction.

Preferred approach:

A short introduction plus baseline Equipment.

Example:

```text
Attack:
Training Ring

Defense:
Padded Belt

Health:
Basic Harness
```

This ensures every player can immediately understand the system.

---

# 53. Existing Players

Existing players should not be disadvantaged at launch.

Potential launch strategy:

- All players receive a basic starter set.
- Existing high-level players do not receive disproportionately powerful Equipment automatically.
- Better Equipment becomes available through normal gameplay.

This preserves the value of the new progression system.

---

# 54. Equipment Tutorial

The system should briefly explain:

```text
Your Buddy provides SP.

Equipment converts SP into combat stats.

Attack Gear determines ATK.

Defense Gear determines DEF.

Health Gear determines HP.
```

The explanation should be concise.

Players should be able to see the arithmetic directly.

Example:

```text
Buddy SP:
420

Attack Gear:
×0.80

ATK:
336
```

---

# 55. Portal Combat Preview

The Portal should provide live stat preview.

Example:

```text
Current Buddy

Warband Princess
SP 420

Current Combat Stats

ATK 336
DEF 231
HP 1344
```

Changing the preview Equipment should update these values without modifying the actual loadout until the player confirms.

---

# 56. Buddy Changes

Because Equipment belongs to the player, changing Buddy automatically recalculates combat statistics.

Example:

Current Buddy:

```text
Warband Princess
420 SP

ATK:
336
```

Change Buddy:

```text
Witchy Mechanic
310 SP

ATK:
248
```

No Equipment needs to be moved.

---

# 57. Future Dungeon Traits

Dungeon Traits should not be implemented as part of Equipment V1.

However, the Equipment model should not prevent them.

Dungeon Traits belong primarily to the Waifumon species/Buddy layer.

Future combat will combine:

```text
Buddy SP

Buddy Dungeon Trait

Buddy Special

Player Equipment

Combat Context
```

Equipment remains one input to that system.

---

# 58. Future Ascension Interaction

Ascension should remain compatible with Equipment.

Possible future behaviour:

```text
Ascension increases effective combat SP.
```

or:

```text
Ascension unlocks additional Equipment interaction.
```

No Ascension-specific Equipment logic is required in V1.

---

# 59. Logging and Observability

Equipment actions should be observable.

Useful events include:

- Equipment granted
- Equipment equipped
- Equipment unequipped
- Equipment sold
- Equipment removed by admin
- Loadout changed

Metrics may include:

```text
equipment_grants_total

equipment_by_source

equipment_equipped_total

equipment_inventory_size

equipment_rarity_distribution
```

This will be valuable during balancing.

---

# 60. Auditability

Because Equipment can eventually become valuable, grant operations should be traceable.

Owned instances should preserve:

- Creation time
- Acquisition source
- Equipment definition
- Player
- Administrative origin where applicable

This will help investigate:

- Duplicate grants
- Reward bugs
- Compensation events
- Exploits

---

# 61. API Design

Suggested service/API capabilities:

```text
GET equipment inventory

GET active loadout

POST equip Equipment

POST unequip Equipment

POST switch active loadout

GET combat-stat preview

GET Equipment definitions
```

Admin capabilities:

```text
POST grant Equipment

DELETE/remove Equipment

GET player Equipment
```

Actual endpoint structure should follow existing Waifumon API conventions.

---

# 62. Concurrency

Equipment changes should be transaction-safe.

Potential race:

Two simultaneous Equip requests attempt to replace the same slot.

Expected result:

- One final authoritative state.
- No duplicate slot assignment.
- No lost Equipment.
- Clear response to both clients.

Database constraints should enforce:

```text
one Equipment instance cannot occupy multiple incompatible slots

one active Equipment item per slot per loadout
```

---

# 63. Equipment Ownership Validation

Every Equip request must verify:

- Equipment instance exists.
- Player owns it.
- Equipment is enabled.
- Slot matches.
- Equipment is not otherwise invalid.
- Loadout belongs to player.

Never trust Equipment IDs supplied by the client without ownership validation.

---

# 64. Disabled Equipment

Administrators may need to disable an Equipment definition.

If disabled:

- It should stop dropping.
- It should stop appearing in shops.
- Existing owned instances should not necessarily disappear.

A policy decision is needed for whether disabled Equipment can remain equipped.

Recommended default:

Existing instances remain owned and usable unless specifically revoked.

This prevents surprise removal from players.

---

# 65. Deleting Equipment Definitions

Definitions referenced by player-owned instances should not be hard-deleted.

Use:

```text
enabled = false
```

or archival behaviour.

Player ownership must remain referentially valid.

---

# 66. Release Phases

## Phase 0 — Audit and Design Validation

Before writing migrations:

Audit existing:

- Items system
- Player inventory
- Buddy system
- SP calculations
- Boss rewards
- World Encounter effects
- Expedition reward tables
- Shops
- Portal APIs
- Admin tooling

Goal:

Identify reusable infrastructure and avoid duplicating existing functionality.

---

## Phase 1 — Equipment Data Model

Implement:

- Equipment definitions
- Player Equipment instances
- Loadouts
- Loadout slots
- Constraints
- Content validation

Goal:

Create stable foundational data structures.

---

## Phase 2 — Equipment Service

Implement central service:

```text
grantEquipment

listEquipment

equip

unequip

getActiveLoadout

calculateCombatStats
```

Goal:

All Equipment behaviour goes through one domain layer.

---

## Phase 3 — Admin and Content Tooling

Implement:

- Equipment definition management
- Manual grants
- Player inspection
- Removal
- Import/export if appropriate

Goal:

Allow safe testing and content authoring.

---

## Phase 4 — Portal Management

Implement:

- Inventory
- Filtering
- Comparison
- Equip / unequip
- Derived combat-stat preview
- Favourite
- Lock

Goal:

Provide full management interface.

---

## Phase 5 — Discord Equipment UI

Implement:

```text
/equipment
```

Features:

- Current loadout
- Derived stats
- Slot replacement
- Basic inventory
- Buddy-based combat preview

Goal:

Make Equipment fully manageable without leaving Discord.

---

## Phase 6 — Starter Equipment

Implement:

- Starter set
- Introduction
- Basic regional shop Equipment

Goal:

Guarantee every player can participate.

---

## Phase 7 — Reward Integration

Add Equipment drops to selected:

- Bosses
- Encounters
- Expeditions
- Events

Goal:

Make Equipment part of existing gameplay loops.

---

## Phase 8 — Initial Combat Consumer

Integrate Equipment into at least one existing combat-related system.

Most likely:

- Boss combat
- Raid boss calculation
- Future boss redesign

Goal:

Prove Equipment has immediate gameplay value.

---

## Phase 9 — Balance and Analytics

Review:

- Equipment acquisition rate
- Inventory size
- Slot usage
- Rarity distribution
- Player SP ranges
- Combat-stat ranges

Adjust multipliers and drop rates.

---

# 67. Explicit Non-Goals for V1

The first Equipment release should NOT require:

- Dungeon mode
- Parties
- Per-Waifumon Equipment
- Random affixes
- Equipment crafting
- Equipment enhancement
- Durability
- Trading
- Equipment sets
- PvP
- Multiple mandatory loadouts
- Complex combat skill trees
- 100+ Equipment definitions
- Highly specialised Dungeon-only Equipment

These may be added later.

---

# 68. Content Scope Recommendation

A sensible initial launch catalogue could be approximately:

### Attack
8–12 items

### Defense
8–12 items

### Health
8–12 items

Total:

Approximately 24–36 Equipment definitions.

Spread across:

- Starter
- Shops
- Bosses
- Expeditions
- Encounters

This is enough to create meaningful progression without creating an authoring burden.

---

# 69. Suggested Initial Equipment Distribution

Example:

### Starter
3 items

### Waifu Valley Shop
3 upgrades

### Regional Shops
6–10 items

### Boss Drops
6–8 items

### Expedition Rewards
4–6 items

### World Encounter Rewards
4–6 items

Some overlap between reward pools is acceptable.

---

# 70. Future Dungeon Compatibility Checklist

Before declaring the Equipment system complete, confirm that it supports the following future Dungeon needs:

- Equipment is player-owned.
- Equipment instances have stable unique IDs.
- Equipment can be snapshotted.
- Equipment derives ATK / DEF / HP from Buddy SP.
- Combat calculation is server-authoritative.
- Secondary effects can be added later.
- Context qualifiers can be added later.
- Multiple loadouts are structurally possible.
- Equipment inventory is accessible through API.
- Dungeon rewards can create Equipment through the same grant service.
- Current loadout can be read at Dungeon entry.
- Equipment changes outside a Dungeon do not require redesigning the Equipment model.
- Equipment can support future rarity and affix systems.
- Equipment UI exists independently of Dungeon UI.

If all of these are true, Dungeon development can build on the Equipment System without revisiting its foundation.

---

# 71. Future Raid Compatibility Checklist

Confirm that Equipment can also support:

- Shared boss combat
- Raid damage calculations
- Defense calculations
- HP calculations
- Loadout snapshots
- Boss-specific effects
- Raid-specific effects
- Multiple simultaneous players
- Central authoritative combat calculations

The Equipment system should not assume combat is always solo.

---

# 72. Major Open Questions

The following should be decided during implementation planning.

## Exact Equipment Rarity Structure

Should Equipment reuse:

```text
Normal / Rare / SR / SSR / UR
```

or use a separate naming system?

## Exact Multiplier Curves

Requires simulation using actual player SP values.

## Initial Boss Integration

How much should Equipment affect current boss gameplay?

## Starter Distribution

Automatic grant versus tutorial versus shop.

## Equipment Selling

Launch feature or later addition?

## Equipment Artwork

Individual images versus slot-based visuals for V1.

## Equipment Drop Frequency

Requires economy balancing.

## Named Loadouts

Schema-only support or launch UI?

## Relic Slot

Launch, shortly after launch, or Dungeon release?

---

# 73. Architectural Rules

The following rules should be treated as foundational.

### Rule 1

Equipment belongs to the player, not a gameplay mode.

### Rule 2

Equipment rewards always create player-owned Equipment.

### Rule 3

Reward systems never automatically equip Equipment.

### Rule 4

Combat statistics are calculated through one authoritative backend service.

### Rule 5

Discord, Portal, Dungeon, Raid, and future clients consume the same Equipment state.

### Rule 6

V1 Equipment uses fixed stats.

### Rule 7

Equipment uses individual ownership instances even when stats are identical.

### Rule 8

SP remains the core underlying Buddy power value.

### Rule 9

Equipment converts SP into combat capability.

### Rule 10

The data model must support future secondary effects without requiring redesign.

### Rule 11

The first release should avoid premature complexity.

---

# 74. Overall Progression Model

After Equipment launches, the Waifumon progression ecosystem becomes:

```text
Hunt
  │
  ▼
Capture
  │
  ▼
Level / SP Investment
  │
  ▼
Choose Buddy
  │
  ▼
Acquire Equipment
  │
  ▼
Build Loadout
  │
  ▼
Improved Combat Capability
  │
  ├── Bosses
  ├── Future Dungeon
  ├── Future Raids
  └── Future Combat Systems
```

Equipment becomes a bridge between the existing collection game and future active combat systems.

---

# 75. Definition of Success

The Equipment release should be considered successful if:

- Players understand that Buddy SP powers Equipment-derived combat stats.
- Equipment is easy to manage in Discord.
- Equipment is pleasant to browse and compare in the Portal.
- Players are excited to receive Equipment from existing gameplay.
- Equipment adds meaningful progression without invalidating SP investment.
- The backend provides one authoritative combat-stat calculation path.
- New gameplay modes can consume Equipment without modifying its underlying architecture.
- Future Dungeon development can begin without redesigning the Equipment system.

The most important success criterion is:

**A piece of Equipment earned anywhere in Waifumon should feel like a permanent addition to the player's broader account progression, not a reward tied to one isolated feature.**