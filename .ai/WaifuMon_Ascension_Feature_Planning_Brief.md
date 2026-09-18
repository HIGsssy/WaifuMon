# WaifuMon Ascension System --- Feature Planning Brief

## Purpose

This document is intended as a planning brief for implementation of a
new **Ascension** progression system in WaifuMon.

Do **not** begin implementation immediately.

First audit the existing codebase and produce a technical implementation
plan showing how Ascension should integrate with the current WaifuMon
level/XP system, appearances, collection copies, favourites, Buddy
state, inventory/items, Essence, Expeditions, World Encounters, Portal
APIs, card rendering, and any other relevant systems.

The design below describes the intended gameplay direction. Treat
specific costs and balance numbers as **provisional configuration**, not
immutable requirements.

------------------------------------------------------------------------

# 1. Feature Goal

WaifuMon currently progress to level 50, with new artwork/appearances
unlocking every 10 levels.

Ascension should provide a meaningful long-term progression path after
level 50.

The intended lifecycle is:

``` text
Capture
  ↓
Lv. 1
  ↓
Lv. 10  → appearance unlock
  ↓
Lv. 20  → appearance unlock
  ↓
Lv. 30  → appearance unlock
  ↓
Lv. 40  → appearance unlock
  ↓
Lv. 50  → appearance unlock + Ascension eligibility
  ↓
ASCENSION
  ↓
Level cap increases from 50 → 100
Multiple Ascension appearances unlock immediately
  ↓
Lv. 75  → additional Ascension appearance(s)
  ↓
Lv. 100 → final/mastery appearance(s)
  ↓
MASTERED
```

Ascension should feel like a major milestone rather than merely
purchasing access to another 50 levels.

It should connect several existing and planned WaifuMon systems:

-   duplicates
-   Essence
-   collection development
-   Affinity
-   Race
-   key items
-   Expeditions
-   artwork/appearances
-   future equipment
-   World Encounters / special content
-   long-term collection mastery

------------------------------------------------------------------------

# 2. Existing Appearance Progression Must Remain Intact

Base WaifuMon already unlock appearances every 10 levels.

Do not replace or redesign that progression.

Conceptually:

``` text
Lv. 1   → Base appearance
Lv. 10  → Appearance
Lv. 20  → Appearance
Lv. 30  → Appearance
Lv. 40  → Appearance
Lv. 50  → Appearance
```

At level 50, the individual WaifuMon reaches the normal level cap and
becomes eligible for Ascension.

Ascension then introduces a **second appearance progression track**.

------------------------------------------------------------------------

# 3. Ascension Appearance Track

Completing Ascension should immediately provide a meaningful visual
reward.

Rather than unlocking exactly one image, Ascension should be capable of
unlocking **multiple appearances simultaneously**.

Example:

``` text
ASCENSION COMPLETE

Level Cap: 50 → 100

Immediately unlocked:
- Ascended Appearance I
- Ascended Appearance II
- Ascended Appearance III

Future:
- additional appearance(s) at Lv. 75
- final/mastery appearance(s) at Lv. 100
```

The number of immediate Ascension appearances should **not** be
hard-coded into the Ascension engine.

A species may have:

-   1 Ascension appearance
-   2 Ascension appearances
-   3 Ascension appearances
-   more where artwork exists

Ascension should change the state of the individual WaifuMon. The
appearance system should then determine which configured appearances
have become eligible.

This is important because artwork availability will not necessarily be
identical for every species.

------------------------------------------------------------------------

# 4. Appearance Unlock Model

Audit the current appearance schema before proposing changes.

The preferred long-term direction is for appearances to support explicit
unlock conditions rather than assuming every appearance maps only to a
level.

Conceptually:

``` json
{
  "id": "ascended_alt_01",
  "unlock": {
    "type": "ascension"
  }
}
```

and:

``` json
{
  "id": "ascended_75",
  "unlock": {
    "type": "level",
    "level": 75,
    "requiresAscension": true
  }
}
```

This should eventually leave room for other unlock types such as:

-   level
-   Ascension
-   Mastery
-   affection
-   key item
-   event
-   achievement
-   boss completion
-   expedition discovery
-   equipment-related unlock

Do not introduce unnecessary abstraction if the existing appearance
model can support this cleanly with a smaller change.

The audit should determine the least disruptive path.

------------------------------------------------------------------------

# 5. Ascension Belongs to an Individual Copy

Ascension is **not species-wide progression**.

If a player owns three copies of the same species:

``` text
Lilith — Lv. 50
Lilith — Ascended Lv. 68
Lilith — Lv. 17
```

only the second copy is Ascended.

The individual player-owned WaifuMon therefore needs persistent
Ascension state.

However, appearance **discovery/unlock semantics** should be audited
separately.

Preferred behavior:

-   earning an appearance through one copy permanently discovers that
    artwork for the species/account
-   Ascended appearances can be viewed in the Encyclopedia once
    discovered
-   whether Ascended artwork can be actively applied to a non-Ascended
    copy should remain restricted unless current appearance architecture
    strongly suggests otherwise

Document the current behavior and recommend the cleanest implementation.

------------------------------------------------------------------------

# 6. Ascension Requirements

Every Ascension requires the target WaifuMon to be:

``` text
Level 50
Not already Ascended
```

Additional requirements increase with rarity.

The intended design uses four main progression costs:

1.  duplicate copies
2.  Essence
3.  Ascension materials / key items
4.  developed roster / Resonance requirements

Lower rarities rely more heavily on duplicates.

Higher rarities require fewer duplicates but increasingly rely on rare
Ascension materials and developed roster requirements.

------------------------------------------------------------------------

# 7. Proposed Rarity Rules

These values are starting points for planning and balance discussion.

They should be content/configuration driven wherever practical.

## Normal (N)

Proposed:

``` text
Target WaifuMon: Lv. 50
3 additional same-species duplicates
500 Essence
1× Ascension Shard
```

Purpose:

Normal rarity should provide a meaningful sink for commonly accumulated
duplicates.

------------------------------------------------------------------------

## Rare (R)

Proposed:

``` text
Target WaifuMon: Lv. 50
2 additional same-species duplicates
1,000 Essence
2× Ascension Shards
```

Purpose:

Still primarily duplicate-driven, with a somewhat higher material and
Essence cost.

------------------------------------------------------------------------

## Super Rare (SR)

Proposed:

``` text
Target WaifuMon: Lv. 50
2 additional same-species duplicates
2,000 Essence
1× Ascension Seal

Resonance:
Another Lv. 30+ WaifuMon sharing the target's Affinity
```

Purpose:

SR introduces the player to roster-based Ascension requirements.

The Resonance WaifuMon is **not consumed**.

------------------------------------------------------------------------

## Super Super Rare (SSR)

Proposed:

``` text
Target WaifuMon: Lv. 50
1 additional same-species duplicate
3,500 Essence
2× Ascension Seals

Resonance:
Another Lv. 40+ WaifuMon sharing the target's Affinity
```

The Resonance WaifuMon is not consumed.

------------------------------------------------------------------------

## Ultra Rare (UR)

Proposed:

``` text
Target WaifuMon: Lv. 50
1 additional same-species duplicate
6,000 Essence
1× Ascension Sigil

Resonance:
Another Lv. 50+ WaifuMon sharing the target's Affinity
```

The supporting WaifuMon should be a different owned copy and should not
be consumed.

Consider whether it must be a different species; provide a
recommendation based on exploitability and UX.

UR Ascension should represent meaningful mastery of that Affinity rather
than simply requiring multiple extremely rare duplicates.

------------------------------------------------------------------------

## Legendary Rare (LR)

Current preferred direction:

``` text
Target WaifuMon: Lv. 50
No mandatory LR duplicate
10,000 Essence
1× Mythic Ascension Core

Resonance:
Lv. 50+ WaifuMon sharing the target's Affinity
AND
Lv. 50+ WaifuMon sharing the target's Race
```

The Resonance WaifuMon are not consumed.

If one supporting WaifuMon satisfies both the Affinity and Race
requirement, the current design preference is to allow it to satisfy
both.

The reason LR currently has no duplicate requirement is that requiring a
second LR may make the feature effectively inaccessible through bad luck
rather than meaningful progression.

During planning, evaluate this decision against actual capture rarity
and existing duplicate acquisition rates.

------------------------------------------------------------------------

## EX

Do not give EX a normal numeric recipe yet.

EX Ascension should be capable of using species-specific or
content-specific requirements.

Examples:

-   unique key item
-   special World Encounter chain
-   particular boss completion
-   rare expedition
-   another Mastered WaifuMon
-   species-specific objective
-   event content

The Ascension architecture should support custom requirements without
hard-coding EX-specific logic throughout the service.

------------------------------------------------------------------------

# 8. Ascension Material Ladder

The current proposed material hierarchy is:

``` text
Ascension Shard
Ascension Seal
Ascension Sigil
Mythic Ascension Core
```

These should use the canonical item/inventory system and should likely
be classified as key/progression items rather than ordinary consumables.

They should **not be sellable** unless explicitly configured otherwise.

The material ladder should connect directly to the planned Expedition
system.

Possible acquisition pattern:

### Ascension Shard

Common Ascension resource.

Likely sources: - 2-hour Expeditions - normal Expedition success -
selected encounters/events

### Ascension Seal

Uncommon resource.

Likely sources: - 6-hour Expeditions - stronger mission reward tables -
Exceptional Success on shorter missions

### Ascension Sigil

Rare resource.

Likely sources: - 12-hour Expeditions - Exceptional Success - special
World Encounters - selected bosses/events

### Mythic Ascension Core

Endgame Ascension material.

Likely sources: - rare 12-hour Expedition outcomes - Exceptional
Success - special events - difficult World Encounters - bosses -
deterministic fragment progression

------------------------------------------------------------------------

# 9. Rare Material Pity / Deterministic Progress

Mandatory progression should not depend entirely on jackpot RNG.

For extremely rare Ascension materials, particularly the Mythic
Ascension Core, support a deterministic path.

Example:

``` text
10× Mythic Core Fragment
        ↓
1× Mythic Ascension Core
```

A player might receive a complete Core as a rare jackpot drop, while
normal high-level play gradually produces fragments.

The exact crafting/conversion mechanism does not need to be implemented
as part of Ascension if no appropriate system exists yet.

However, the item and reward architecture should not prevent this future
path.

------------------------------------------------------------------------

# 10. Resonance

Resonance is a roster-development requirement.

A Resonance WaifuMon:

-   must be owned by the same player
-   must satisfy the configured level / Affinity / Race requirement
-   is not consumed
-   cannot be the target WaifuMon itself
-   should not simultaneously be invalid due to release/deletion state

Audit whether the following states should prevent a WaifuMon from
serving as Resonance:

-   currently deployed on an Expedition
-   active Buddy
-   favourite
-   involved in another future gameplay state
-   already used for another simultaneous Ascension

For V1, avoid adding arbitrary cooldowns or temporary locking unless
needed for balance or transaction safety.

The purpose of Resonance is to reward roster development, not punish the
player for using their collection.

------------------------------------------------------------------------

# 11. Duplicate Consumption

When duplicates are required, the copies are permanently consumed.

Safety requirements are important.

A copy must never be automatically consumed if it is:

-   the target WaifuMon
-   favourited
-   the player's active Buddy
-   deployed on an Expedition
-   otherwise protected by existing game rules
-   unavailable because of another active state

The player should explicitly see which copies will be consumed before
confirming Ascension.

Do not silently choose protected or meaningful copies.

If the current collection model allows duplicate copies to have
different:

-   levels
-   affection
-   artwork state
-   favourite state
-   other progression

then candidate selection must expose enough information for the player
to make an informed choice.

The Ascension transaction must revalidate all selected copies at
execution time.

------------------------------------------------------------------------

# 12. Ascension Transaction

Ascension should be atomic.

Conceptually, successful Ascension may involve:

1.  validate target is eligible
2.  validate required duplicate copies
3.  validate Resonance requirements
4.  validate Essence balance
5.  validate Ascension items
6.  consume selected duplicates
7.  consume Ascension materials
8.  deduct Essence
9.  mark target as Ascended
10. increase target level cap to 100
11. unlock/discover newly eligible appearances
12. persist audit/history information where appropriate

If any required operation fails, the entire Ascension should fail
without partially consuming resources.

Use existing canonical inventory, Essence, collection and appearance
services wherever possible.

Do not implement parallel mutation logic inside Discord handlers.

------------------------------------------------------------------------

# 13. Level Progression After Ascension

The preferred model is:

``` text
Lv. 50 unascended → capped
Lv. 50 ascended   → may continue earning levels up to Lv. 100
```

Do **not** reset the visible level to 1.

Ascension opens levels 51--100.

Audit:

-   current XP curve
-   level calculation
-   hard-coded level 50 assumptions
-   XP awarding
-   max-level guards
-   bulk Essence investment
-   card rendering
-   collection sorting/filtering
-   Portal APIs
-   leaderboards
-   boss calculations
-   buddy calculations
-   encounters
-   any code that assumes level \<= 50

The planning report should identify every affected assumption.

The XP curve from 50--100 requires explicit design.

Do not simply extrapolate blindly from 1--50 without evaluating the
resulting grind.

------------------------------------------------------------------------

# 14. Mastery

Level 100 should be the terminal progression state for an Ascended
WaifuMon.

Conceptually:

``` text
Ascended + Lv. 100 = MASTERED
```

Mastery should initially be primarily a progression/collection status
rather than another infinite power system.

Potential rewards:

-   final/mastery artwork
-   permanent Mastered marker
-   card/profile visual treatment
-   collection/Encyclopedia completion state
-   achievement support
-   future requirement for special content

Do not introduce level 150 or another prestige loop as part of this
feature.

------------------------------------------------------------------------

# 15. Mechanical Power

Ascension should not automatically introduce large stat inflation.

Audit how level currently affects:

-   SP
-   boss damage
-   encounter checks
-   capture systems
-   Buddy bonuses
-   XP
-   other combat/progression calculations

Increasing the cap from 50 to 100 may already affect systems that scale
from level.

The planning phase must identify these effects before implementation.

Potential future Ascension-specific mechanical benefits might include:

-   modest Buddy Bonus improvement
-   second passive
-   equipment access
-   special expedition eligibility
-   encounter choices

These are **not required for V1**.

The immediate V1 value proposition is already substantial:

-   level cap 100
-   multiple immediate appearances
-   further Lv.75 artwork
-   Lv.100 Mastery artwork/status

Do not bolt on large power bonuses simply to make Ascension feel
worthwhile.

------------------------------------------------------------------------

# 16. Player UX

The Ascension interface should make requirements completely
understandable.

Conceptual preview:

``` text
ASCEND THE WAIFU BELOW?

Current:
LR • Dominant • Demon • Lv. 50

Ascension Requirements:

✓ Level 50
✓ 10,000 Essence
✓ Mythic Ascension Core
✓ Lv. 50+ Dominant Resonance
✓ Lv. 50+ Demon Resonance

Ascension Rewards:

✦ Level cap increased to 100
🖼 3 new appearances immediately
🔒 Additional appearance at Lv. 75
🔒 Mastery appearance at Lv. 100

[ASCEND]
```

For duplicate-based recipes, the confirmation must clearly show the
exact copies that will be consumed.

The UX should distinguish:

-   satisfied requirement
-   missing requirement
-   consumable requirement
-   non-consumed Resonance requirement

Do not allow Ascension to be triggered accidentally.

------------------------------------------------------------------------

# 17. Configuration vs Hard-Coding

Rarity recipes should be configurable.

Avoid a large switch statement containing every rarity's costs if the
existing content/config architecture supports a clean data-driven model.

Conceptually:

``` json
{
  "rarity": "UR",
  "requirements": {
    "level": 50,
    "duplicates": 1,
    "essence": 6000,
    "items": [
      {
        "slug": "ascension_sigil",
        "quantity": 1
      }
    ],
    "resonance": [
      {
        "type": "affinity",
        "matchTarget": true,
        "minimumLevel": 50
      }
    ]
  }
}
```

This is illustrative only.

Inspect existing schemas and use project conventions.

Species-specific overrides should be possible later, especially for EX.

------------------------------------------------------------------------

# 18. Relationship to Expeditions

Ascension is intended to become one of the major long-term reasons to
run Expeditions.

The expected loop is:

``` text
Hunts
  ↓
captures + duplicates

Care / Essence investment
  ↓
Lv. 50 roster

Expeditions
  ↓
Ascension materials + rare key items

Collection development
  ↓
Resonance candidates

ASCENSION
  ↓
Lv. 51–100 + new artwork

MASTERED
```

This means Expedition reward tables should eventually be able to target
Ascension materials by:

-   mission duration
-   region
-   mission difficulty
-   outcome
-   Exceptional Success
-   rare/special mission type

Ascension should not require the Expedition system to exist before its
domain model can be designed, but the two systems should be
architecturally compatible.

------------------------------------------------------------------------

# 19. Relationship to Key Items

Ascension materials should use the broader key/progression-item
foundation being planned for WaifuMon.

Do not create a separate Ascension-only inventory.

The canonical item system should ultimately support:

``` text
consumable
salvage
key
equipment
```

with independent properties such as `sellValue`.

Ascension materials should normally:

``` text
category: key
sellValue: null
```

or the closest equivalent supported by the actual item schema.

------------------------------------------------------------------------

# 20. Portal / Web-Playable Readiness

Do not make Ascension Discord-specific.

The long-term WaifuMon direction includes the React/Vite Player Portal
becoming a fully playable web experience and eventually supporting a
Discord embedded app/activity.

Therefore:

``` text
Ascension Content / Configuration
        ↓
Ascension Domain Service
        ↓
Postgres + Existing Game Services
        ↓
Discord UI
Portal/Web UI
Future Discord Activity
```

Discord interactions should call the domain service rather than own the
business logic.

Identify any API endpoints or shared coordinator changes that would
eventually be required.

Do not necessarily build the Portal UI as part of V1 unless it is
already trivial to expose.

------------------------------------------------------------------------

# 21. Data Migration / Existing Players

The implementation plan must explicitly address existing player-owned
WaifuMon.

Questions to resolve:

-   How is Ascension state represented for all existing copies?
-   Does it default to false?
-   What happens to existing Lv.50 WaifuMon?
-   Are they immediately eligible to Ascend once requirements are met?
-   Are there any existing records above level 50?
-   Does existing XP beyond the cap exist or get discarded?
-   Are appearance unlock records already persisted separately?
-   Could migration accidentally unlock Ascension artwork?

Existing Lv.50 characters should not automatically Ascend.

------------------------------------------------------------------------

# 22. Audit / History

Because Ascension permanently consumes valuable resources and duplicate
WaifuMon, consider keeping a durable Ascension history/audit record.

Useful information could include:

-   player
-   target WaifuMon instance
-   species
-   rarity
-   timestamp
-   consumed duplicate instance IDs
-   consumed items
-   Essence spent
-   Resonance WaifuMon IDs
-   resulting Ascension state

This is useful for support and bug recovery.

Determine whether existing game history/event infrastructure already
provides an appropriate mechanism.

------------------------------------------------------------------------

# 23. Required Safety Tests

Planning should account for tests covering at minimum:

### Eligibility

-   Lv.49 cannot Ascend
-   Lv.50 can become eligible
-   already Ascended copy cannot Ascend again
-   rarity recipe selected correctly
-   species-specific override works if supported

### Duplicates

-   correct number required
-   target cannot count as duplicate
-   protected/favourite copy cannot be consumed
-   active Buddy cannot be consumed
-   Expedition-deployed copy cannot be consumed
-   stale duplicate selection is rejected
-   exact selected copies are consumed

### Essence / Items

-   insufficient Essence rejected
-   insufficient Ascension materials rejected
-   correct quantities consumed
-   non-sellable/key item behavior remains correct

### Resonance

-   correct Affinity requirement
-   correct Race requirement
-   minimum level enforced
-   target cannot satisfy its own Resonance
-   LR candidate capable of satisfying both Affinity and Race behaves
    according to final rule
-   Resonance WaifuMon survives Ascension

### Transactionality

-   failure after validation does not consume partial resources
-   duplicate deletion failure rolls back
-   inventory failure rolls back
-   Essence mutation failure rolls back
-   repeated request cannot Ascend twice

### Progression

-   unascended Lv.50 remains capped
-   Ascended Lv.50 can progress beyond 50
-   Ascended cap is 100
-   Lv.100 becomes Mastered
-   XP behavior beyond 50 is correct

### Appearances

-   base level unlocks remain unchanged
-   Ascension immediately unlocks all configured Ascension appearances
-   number of Ascension appearances is not hard-coded
-   Lv.75 unlock works
-   Lv.100/mastery unlock works
-   non-Ascended copy does not improperly gain Ascended state

### Integration

-   card rendering handles Ascended/Mastered state
-   collection filters/sorting do not break above Lv.50
-   Portal/API serialization handles Ascension
-   buddy/boss/encounter calculations do not accidentally overflow or
    double-scale from levels 51--100

------------------------------------------------------------------------

# 24. Questions the Planning Audit Must Answer

Before implementation, inspect the repository and answer:

1.  How are player-owned WaifuMon currently represented?
2.  How are level and XP currently calculated and capped?
3.  Where is the level 50 cap enforced?
4.  What systems assume that level cannot exceed 50?
5.  How are appearance unlocks currently defined?
6.  Are appearance unlocks persisted, derived, or both?
7.  How are duplicate copies represented and safely deleted/released?
8.  What protections already exist for favourites and Buddy copies?
9.  How should Expedition-deployed WaifuMon be protected once
    Expeditions exist?
10. What canonical service currently mutates Essence?
11. What canonical service currently consumes inventory items?
12. How should Ascension materials fit the item schema?
13. What transaction boundary can safely cover all Ascension mutations?
14. How should Resonance requirements be represented?
15. How should rarity recipes be configured?
16. How can EX/species-specific recipes override normal rarity rules?
17. How should Ascended/Mastered state be exposed through the API?
18. How should cards and Discord embeds display Ascension?
19. How will levels 51--100 affect SP, bosses, encounters and other
    calculations?
20. What should the XP curve from 50--100 look like?
21. What migration(s) are required?
22. What existing tests will need updating?
23. What new tests are required?
24. Are there any architectural conflicts with the planned Expedition,
    key-item or equipment systems?

------------------------------------------------------------------------

# 25. Deliverable Requested From Planning Phase

Do **not** implement the feature yet.

Return a planning report containing:

## A. Current-State Audit

Relevant files, schemas, services, database tables and current gameplay
assumptions.

## B. Recommended Data Model

How Ascension state, Mastery, recipes, Resonance and appearance
conditions should be represented.

## C. Level / XP Impact

Exact places affected by raising the cap from 50 to 100 and a
recommendation for the post-50 XP curve.

## D. Appearance Integration

How to preserve current every-10-level unlocks while adding multiple
immediate Ascension appearances and Lv.75/Lv.100 unlocks.

## E. Ascension Transaction Design

Exact transaction sequence and canonical services involved.

## F. Rarity Recipe Model

Recommended configuration format and any adjustments to the provisional
N/R/SR/SSR/UR/LR rules.

## G. Duplicate Safety

How copies are selected, protected, displayed and consumed.

## H. Resonance Design

How matching Affinity/Race/level requirements should work and be
validated.

## I. Item / Expedition Integration

How Ascension Shards, Seals, Sigils, Cores and fragments fit the planned
item and Expedition systems.

## J. API / Discord / Portal Impact

Which interfaces require changes now and which should remain future
work.

## K. Migration Strategy

How existing players and existing Lv.50 WaifuMon are handled safely.

## L. Test Plan

Concrete test coverage.

## M. Implementation Phases

Recommend a sequence of small, reviewable implementation phases rather
than one giant change.

## N. Open Decisions

Clearly identify any decisions that still need gameplay/product input
before implementation.

------------------------------------------------------------------------

# 26. Design Principles

Use these principles when evaluating implementation choices:

1.  **Ascension should reward investment immediately.** The player
    receives multiple new appearances at Ascension rather than only
    permission to grind more levels.
2.  **Low rarity duplicates should become useful.** N/R/SR Ascension
    provides a meaningful duplicate sink.
3.  **High rarity progression should not depend entirely on duplicate
    RNG.**
4.  **Developing a varied roster should matter.** Resonance turns
    Affinity, Race and level diversity into progression assets.
5.  **Rare mandatory materials need a deterministic long-term
    acquisition path.**
6.  **Ascension belongs to the individual owned copy.**
7.  **Appearance configuration should not assume every species has the
    same number of Ascension images.**
8.  **Permanent consumption must be explicit and transactional.**
9.  **Do not introduce unnecessary power creep merely because the level
    cap increases.**
10. **Do not build the business logic into Discord.**
11. **Integrate with canonical inventory, Essence, collection and
    appearance systems.**
12. **Keep EX extensible for special content rather than forcing it into
    the standard rarity ladder.**
13. **Level 100 should provide a meaningful finish line through Mastery
    rather than immediately creating another infinite progression
    tier.**
14. **Prefer configuration/content-driven rules over rarity-specific
    hard-coded branches where the existing architecture supports it.**

------------------------------------------------------------------------

# 27. Current Provisional Recipe Summary

  -------------------------------------------------------------------------------------------------
  Rarity             Duplicates          Essence Material                Resonance
                       Consumed                                          
  ------------ ---------------- ---------------- ----------------------- --------------------------
  N                           3              500 1× Ascension Shard      None

  R                           2            1,000 2× Ascension Shards     None

  SR                          2            2,000 1× Ascension Seal       Lv.30+ same Affinity

  SSR                         1            3,500 2× Ascension Seals      Lv.40+ same Affinity

  UR                          1            6,000 1× Ascension Sigil      Lv.50+ same Affinity

  LR                          0           10,000 1× Mythic Ascension     Lv.50+ same Affinity +
                                                 Core                    Lv.50+ same Race

  EX                    Special          Special Unique/content-driven   Species/content-specific
  -------------------------------------------------------------------------------------------------

These numbers are **planning defaults only**.

The repository audit and later playtesting may justify changing them.

------------------------------------------------------------------------

# 28. Desired End State

Ascension should create this broader progression loop:

``` text
HUNT
  ↓
Capture WaifuMon + accumulate duplicates
  ↓
LEVEL / CARE / INVEST
  ↓
Build Lv.50 characters and a diverse roster
  ↓
EXPEDITIONS / EVENTS / ENCOUNTERS
  ↓
Acquire Ascension materials and key items
  ↓
ASCEND
  ↓
Immediate new artwork + level cap 100
  ↓
Continue development
  ↓
Lv.75 artwork
  ↓
Lv.100 final artwork
  ↓
MASTERED
```

The feature should make duplicate captures, roster diversity,
Expeditions, rare items and artwork collection reinforce one another
rather than behave as isolated systems.

Ascension should feel like a major achievement for a favourite WaifuMon
and provide a clear long-term destination after level 50.
