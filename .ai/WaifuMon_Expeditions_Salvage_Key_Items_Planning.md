# WaifuMon Expeditions & Resource Acquisition

**Planning Concept --- Salvage, Key Items, Passive Missions & Future
Equipment**\
**Planning Draft --- September 2026**

This document defines a proposed Expeditions subsystem for WaifuMon. The
goal is not merely to add passive quests, but to create a reusable
resource-acquisition loop that gives the player's collection more
strategic value, supports the WaifuBux economy, introduces salvage and
key items, and provides a clean path into a future equipment system.

## 1. Design Goals

-   **Create a meaningful passive gameplay loop.** Players can deploy
    owned WaifuMon on real-time missions while continuing to engage with
    the rest of the game.
-   **Give roster diversity practical value.** Affinity, race and level
    should influence which WaifuMon are best suited to a mission, making
    more of the collection useful.
-   **Improve the WaifuBux economy.** Expeditions become a natural
    source of salvage and other rewards without simply inflating direct
    currency drops.
-   **Establish a broader item economy.** Salvage, consumables, key
    items and future equipment should all use the canonical
    item/inventory system.
-   **Connect existing and future systems.** Expeditions should be able
    to feed shops, World Encounters, bosses, regional content,
    achievements and future equipment gameplay.
-   **Remain reusable outside Discord.** Core logic should live in
    domain/services and APIs rather than Discord command handlers so it
    can later power the React/Vite game and Discord Activity experience.

## 2. Core Player Loop

The proposed loop is:

**Expedition Board → choose an expedition → select a WaifuMon → preview
suitability → deploy → wait for the real-time duration → resolve the
expedition → collect rewards → use or sell the resulting resources**

The important design principle is that Expeditions are a
**resource-acquisition system**, not just an idle source of WaifuBux.
Different expedition types should encourage players to pursue different
reward families and maintain a varied roster.

## 3. MVP Expedition Rules

  -----------------------------------------------------------------------
  Rule                                Proposed V1
  ----------------------------------- -----------------------------------
  Durations                           Short: 2 hours; Medium: 6 hours;
                                      Long: 12 hours

  Team size                           1 WaifuMon initially; multi-Waifu
                                      teams reserved for expansion

  Matching                            Preferred Affinity + Preferred Race

  Level                               Recommended level influences
                                      suitability

  Outcomes                            Failure / Success / Exceptional
                                      Success

  Failure rewards                     Small XP and/or consolation reward
                                      rather than nothing

  Mission location                    Regional expedition pools

  Availability                        Approximately 3--5 missions
                                      available per region

  Rotation                            Candidate starting point: refresh
                                      every 12 hours

  Concurrency                         Start with 1 active expedition per
                                      player

  Assigned WaifuMon                   Cannot be assigned to another
                                      expedition while deployed

  Active Buddy                        Cannot be deployed in V1; player
                                      must choose another WaifuMon

  Duration reduction                  None in V1; fixed durations are
                                      easier to understand and balance

  Displayed odds                      Show suitability category rather
                                      than exact success percentage
  -----------------------------------------------------------------------

## 4. Suitability & Success Model

Affinity and race are preferences rather than hard requirements. A
mismatched WaifuMon can still be sent, but the player is accepting more
risk. Level should be measured relative to the mission's recommended
level rather than allowing raw high levels to scale success without
limit.

Illustrative starting model; balance values are intentionally
provisional:

-   Base mission success: approximately 40%
-   Preferred affinity match: strong positive modifier
-   Neutral affinity: no modifier
-   Disadvantaged/opposed affinity: meaningful negative modifier
-   Preferred race match: positive modifier
-   Recommended level met: positive modifier
-   Below recommended level: scaling penalty
-   Above recommended level: bounded bonus
-   Final normal success chance: clamped to a sensible minimum/maximum

Players should see a readable suitability result such as **EXCELLENT,
GOOD, FAIR, RISKY or POOR**. The exact probability remains internal.

Exceptional Success should be a second-stage result influenced by strong
matching and level, allowing ideal candidates to improve reward quality
rather than merely making ordinary success automatic.

## 5. Reward Families

  -----------------------------------------------------------------------
  Reward Family           Purpose                 Examples
  ----------------------- ----------------------- -----------------------
  Salvage                 Primary sellable loot   Scrap, curios,
                          and indirect WaifuBux   valuables, regional
                          source                  trade goods

  Consumables             Existing gameplay       Capture charms, Energy
                          resources               items, gifts

  Key Items               Unlock or satisfy       Maps, keys, fragments,
                          special content         invitations, seals
                          requirements            

  Equipment               Future WaifuMon         Accessories, relics,
                          progression             weapons; item support
                                                  now, mechanics later

  Direct Rewards          Baseline progression    WaifuBux, Essence,
                          and economy             WaifuMon XP
  -----------------------------------------------------------------------

## 6. Canonical Item Model

Salvage, key items and equipment should not become independent inventory
systems. They should be canonical WaifuMon items, with category
describing what the item is and properties describing what can be done
with it.

Conceptual shape:

``` ts
type ItemCategory =
  | "consumable"
  | "salvage"
  | "key"
  | "equipment";

interface ItemDefinition {
  slug: string;
  name: string;
  description: string;
  category: ItemCategory;

  sellValue?: number | null;
  stackable?: boolean;

  // Existing effect/configuration fields as applicable.
}
```

Sellability should be controlled by an explicit positive `sellValue`
rather than a generic `sellable` boolean.

-   Positive `sellValue` → item can be sold for that many WaifuBux each.
-   Missing, `null`, or `0` → item cannot be sold.

This keeps sellability independent from category. Salvage will usually
be sellable, while a future equipment item could also be sellable if
deliberately configured.

## 7. Salvage & Shop Selling

Salvage creates an indirect currency loop:

**Gameplay → physical loot → shop → sell salvage → WaifuBux →
travel/items/progression**

Regional shops become useful economic destinations rather than
purchase-only menus.

V1 requirements:

-   Add a **Sell Items** surface to every regional shop.
-   Only show inventory items with a positive `sellValue`.
-   Display quantity owned and WaifuBux value per item.
-   Support **Sell 1**, **Sell 5**, and **Sell All**, or a cleaner
    quantity selector if appropriate.
-   Revalidate inventory quantity server-side when the sale executes.
-   Atomically remove the item and grant WaifuBux using canonical
    inventory/economy services.
-   Keep `sellValue` independent from purchase price; salvage does not
    need to be purchasable.
-   Use global sell values in V1. Regional price modifiers can be
    considered later.

## 8. Key Items & Special Content

Key items are one of the most important long-term extensions.
Expeditions can occasionally return persistent objects that are not
immediately useful but later unlock or modify special content.

Examples:

-   **Weathered Treasure Map** → unlocks a special expedition or World
    Encounter branch.
-   **Ancient Seal Fragment ×3** → can later be combined or consumed to
    access a special boss/event.
-   **Velvet Invitation** → grants access to a rare Twin Peeks mission.
-   **Sealed Black Envelope** → mysterious persistent item whose purpose
    becomes active in a later live event.

Where possible, future World Encounter requirements should consume the
same canonical item-requirement language rather than implementing
separate ad-hoc `has item?` checks.

This also allows key items to become part of live-event storytelling. An
apparently mysterious item can enter the loot pool before the event that
ultimately recognizes it.

## 9. Equipment Readiness

The expedition/item work should reserve and support an `equipment`
category now, but it should **not** attempt to design the equipment
system prematurely.

Inventory should be capable of holding equipment items and reward tables
should be capable of awarding them. The following should be designed
separately later:

-   equipment slots
-   stats
-   bonuses
-   rarity interactions
-   enhancement
-   durability, if desired
-   equip/unequip rules

For launch, equipment rewards can remain disabled even though the item
schema supports them. This avoids shipping inert rewards while
preventing a future schema rewrite.

## 10. Expedition Content Model

Expedition definitions should be content-driven rather than hard-coded
into Discord handlers.

A definition should identify its region, duration, recommended level,
preferred traits and reward tables.

Conceptual example:

``` json
{
  "id": "thirstlands_supply_run",
  "name": "Desert Supply Run",
  "region": "thirstlands",
  "durationMinutes": 360,
  "teamSize": 1,
  "recommendedLevel": 20,
  "preferredAffinities": ["dominant"],
  "preferredRaces": ["demon"],
  "baseSuccessChance": 0.40,
  "rewardTable": "thirstlands_supply_success",
  "exceptionalRewardTable": "thirstlands_supply_exceptional",
  "failureRewardTable": "expedition_failure_basic"
}
```

Content-driven definitions allow new regions and missions to expand the
system without requiring new gameplay code.

## 11. Reward Tables

Expeditions should reference reusable weighted reward tables. This
allows success and Exceptional Success to have different loot quality
without embedding reward logic into every mission.

Reward tables should support:

-   WaifuBux
-   Essence
-   WaifuMon XP
-   canonical inventory items
-   salvage
-   consumables
-   key items
-   future equipment

The same reward infrastructure may eventually be reusable by hunts,
bosses and World Encounters, but the expedition implementation should
integrate with existing reward services rather than forcing a premature
global reward-system rewrite.

Player-facing expedition previews should show broad reward categories
rather than exhaustive drop percentages.

Example:

> **Possible Rewards**\
> 💰 WaifuBux\
> 🔩 Salvage\
> ✨ Charms\
> 🗝️ Possible Rare Find

This preserves discovery around key items and rare rewards.

## 12. Regional Identity

Each region should eventually have its own expedition pool and salvage
identity. This makes travel economically meaningful and lets new regions
expand Expeditions through content rather than new code.

### Waifu Valley

Starter errands, local salvage, common supplies and approachable
missions.

### Twin Peeks

Trade goods, social/urban curios, invitations and region-specific
valuables.

### Flaccid Foothills

Rugged salvage, caravan materials, lost cargo and exploration rewards.

### Thirstlands

Desert salvage, ancient fragments, maps, relics and higher-risk
expeditions.

A useful content target after the system is proven would be
approximately **5--8 themed salvage items per region** rather than one
global pool of generic vendor trash.

## 13. Backend Architecture

The domain engine should be independent of Discord. Discord, the Player
Portal and a future Discord Activity/web client should all call the same
expedition services/API.

``` text
Expedition Content
        ↓
Expedition Domain / Service
        ↓
Postgres State
        ↓
Canonical Reward / Economy / Inventory Services
        ↓
Discord UI • Portal UI • Future Discord Activity
```

Postgres timestamps should be authoritative for real-time duration.

The system should store:

``` text
startedAt
completesAt
```

rather than relying on an in-memory timer or Redis job as the source of
truth.

A worker may resolve completed expeditions or send notifications, but a
Redis, bot or server restart must never strand a mission.

## 14. Expedition State & Idempotency

A player expedition record should persist enough information to
reconstruct and safely resolve the mission, including conceptually:

``` text
id
player_id
expedition_key
waifu_id
started_at
completes_at
status
success_chance
resolution_roll
outcome
resolved_at
claimed_at
```

The outcome and generated rewards must be resolved exactly once.

Reopening the UI, retrying a request, reconnecting Discord, or
restarting the bot must never reroll an expedition or duplicate its
rewards.

Conceptual state flow:

``` text
ACTIVE
  ↓
COMPLETE / RESOLVED
  ↓
CLAIMED
```

Resolution and reward claiming may be separate operations so the result
can exist safely before the player collects it.

## 15. Example Expedition Types

  -----------------------------------------------------------------------
  Type              Typical Duration  Reward Bias       Example Theme
  ----------------- ----------------- ----------------- -----------------
  Salvage Run       2--6h             Salvage /         Abandoned
                                      WaifuBux          warehouse,
                                                        scavenging route

  Supply Run        2--6h             Consumables /     Caravan resupply,
                                      salvage           lost shipment

  Essence Hunt      6h                Essence           Investigate an
                                                        unstable energy
                                                        source

  Training Mission  2--6h             WaifuMon XP       Patrol, sparring,
                                                        escort duty

  Treasure Hunt     6--12h            Mixed / rare key  Ruins, map
                                      item              fragments, hidden
                                                        cache

  Forbidden         12h               Rare key items /  Temple,
  Expedition                          future equipment  restricted zone,
                                                        high-risk relic
                                                        hunt
  -----------------------------------------------------------------------

Different expedition types allow the player to intentionally pursue
resources instead of every mission simply being another randomized
payout.

## 16. Multi-Waifu Expeditions --- Later Phase

V1 should use one WaifuMon per mission.

A later expansion can introduce two- or three-member teams with
complementary requirements.

Example:

``` text
Hostile Negotiations
Duration: 12 hours
Team Size: 2

Desired Affinities:
Dominant + Caregiver

Desired Races:
Demon + Human
```

The requirements can be satisfied across the team rather than requiring
one impossible all-purpose character.

This creates a deeper roster-building game while keeping the initial
implementation manageable.

## 17. World Encounter Integration --- Future

The expedition outcome model should remain extensible enough to trigger
special follow-up content later.

For example:

> Lilith should have returned three hours ago...
>
> **Something happened.**

Collecting the expedition could then launch a World Encounter chain.

Other possibilities include:

-   discovering a special location
-   finding a wandering vendor
-   triggering a rare boss
-   encountering another WaifuMon
-   finding a key item that enables a new World Encounter choice

This should not be part of V1, but the state model should avoid reducing
expedition outcomes to a simple boolean `success`.

## 18. Implementation Roadmap

### Phase 1 --- Item Foundation

Audit the canonical item/inventory model.

Add:

-   `salvage` category
-   `key` category
-   reserved `equipment` category
-   `sellValue` semantics
-   appropriate stacking/validation support

Do not implement equipment mechanics yet.

### Phase 2 --- Shop Selling

Add **Sell Items** to regional shops.

Implement:

-   eligible-item filtering
-   quantity selection
-   bulk selling
-   atomic inventory/currency transactions
-   server-side validation
-   tests

This makes salvage useful before Expeditions begin producing it.

### Phase 3 --- Expedition Domain Engine

Implement:

-   expedition definitions/schema
-   suitability calculation
-   success calculation
-   player expedition state
-   real-time timestamps
-   completion/resolution
-   Exceptional Success
-   failure handling
-   idempotency
-   reward integration

Keep this layer UI-agnostic.

Start with only a handful of test missions.

### Phase 4 --- Discord Gameplay

Build:

-   Expedition Board
-   candidate selection
-   suitability preview
-   deploy confirmation
-   active expedition status
-   remaining time display
-   completion/results
-   reward collection

### Phase 5 --- Initial Content & Economy

After the engine survives playtesting:

-   create regional expedition pools
-   create approximately 5--8 themed salvage items per region
-   establish success/exceptional/failure reward tables
-   tune WaifuBux generation against travel and shop costs
-   tune Essence and XP generation
-   determine charm/item rarity

Do not author dozens of missions before the mechanics are proven.

### Phase 6 --- Key Item Hooks

Introduce a small number of rare key items.

Connect them selectively to:

-   World Encounters
-   special expeditions
-   bosses
-   regional events
-   live events

Some key items can deliberately appear before their purpose is revealed.

### Phase 7 --- Expansion

Potential later features:

-   two- and three-Waifu teams
-   multiple affinity requirements
-   multiple race requirements
-   rare expedition chains
-   expedition-triggered World Encounters
-   expedition completion DMs
-   achievements
-   expedition-only items
-   affection interactions
-   equipment rewards
-   Player Portal / HTML5 UI
-   Discord Activity integration

## 19. MVP Acceptance Criteria

The initial system should satisfy the following:

-   A player can see region-appropriate expeditions.
-   A player can deploy one eligible owned WaifuMon.
-   Suitability is calculated from affinity, race and recommended level.
-   Suitability is presented in understandable terms.
-   The expedition remains valid across bot/server restarts because
    timing is persisted in Postgres.
-   The same expedition cannot be resolved or rewarded twice.
-   Failure, Success and Exceptional Success produce appropriate
    persisted results.
-   Rewards can include XP, Essence, WaifuBux, consumables, salvage and
    key items through canonical services.
-   Salvage can be sold at shops for its configured `sellValue`.
-   Key items remain persistent inventory objects and cannot
    accidentally be sold unless explicitly configured.
-   The architecture is callable independently of Discord.
-   Equipment is recognized as an item category without prematurely
    implementing equipment mechanics.

## 20. Decisions to Validate During Playtesting

These should remain configurable until actual gameplay gives us data:

-   Are 2h / 6h / 12h durations satisfying, or does one tier feel
    irrelevant?
-   Does one concurrent expedition create meaningful choice or simply
    feel restrictive?
-   How much salvage value should an active player generate per day
    relative to travel-pass costs and the daily claim?
-   How punitive should an affinity disadvantage be?
-   How much should race matching contribute relative to affinity?
-   How often should Exceptional Success occur for an ideal candidate?
-   Should completed expeditions auto-resolve or resolve when the player
    returns?
-   How often should expedition boards rotate?
-   Should all players in a region see the same board or receive
    individual selections?
-   Which key items should be mysterious future hooks versus immediately
    useful unlocks?

## 21. Recommended First Build

Do **not** begin by implementing the entire Discord quest interface.

The recommended sequence is:

1.  Extend the item foundation.
2.  Implement salvage selling.
3.  Build the expedition domain engine with a handful of test missions.
4.  Playtest suitability, timing, outcomes and rewards.
5.  Build the Discord presentation.
6.  Expand regional expedition and salvage content.
7.  Introduce key-item hooks.
8.  Add richer cross-system integrations after the core economy is
    understood.

This minimizes rework and ensures salvage already has a purpose before
Expeditions begin producing it.

> **Working principle:** Expeditions should make the collection matter,
> make regional travel matter, and create resources that feed back into
> active gameplay. They should not become an unattended currency
> printer.
