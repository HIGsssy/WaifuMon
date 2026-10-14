# Dungeons Phase 4: WaifuMon Encounters, Captures, Rescues and Species Pools — architecture and design

Status: **Phase 4A design proposal. Nothing here is implemented.** Written against
`Delve` at `e7f8f0b` (clean tree) after reading the capture, hunt, spawner,
collection, inventory, content-loader, dungeon engine, run service, publication,
package, scene-composition, Discord and Portal code. Statements marked
*Verified* were checked in the code or shipped content at that commit. Everything
else is a proposal awaiting approval (§21).

Dungeon WaifuMon encounters are a dungeon-only system. They share nothing with
World Encounters: no authoring model, table, cooldown, chain or seed. They share
the **capture formula, charm inventory, ownership rows, XP and quest hooks** with
normal hunting, through three small extractions from `captureService` (§7.2).

Related: [dungeons.md](../dungeons.md), [phase2-rewards-design.md](phase2-rewards-design.md),
[phase3-events-design.md](phase3-events-design.md), [scene-sprites.md](scene-sprites.md).

---

## 1. Verified current architecture findings

### 1.1 The capture lifecycle today

| Question | Finding (*Verified*) | Where |
| --- | --- | --- |
| How is a wild species selected? | A hunt rolls `hunt.resultTable` (`encounter` weight 74). An encounter rolls **rarity first** from `hunt.rarityTable` (N 60, R 25, SR 10, SSR 4, UR 0.9, LR 0.1; level-40 shift moves 1 unit N→R; a Buddy `encounter_weight` bonus may scale it), then a species **within that rarity** from the player's region pool by region-local weight | `hunt/huntService.ts` `pickEncounterSpecies`, `rarityEntriesFor` |
| Fallbacks | Empty region bucket → Waifu Valley's bucket → every enabled species of that rarity not tagged `region_exclusive` (by `species.per_species_weight`) → up to 6 rerolls → arbitrary pooled / non-exclusive species → emergency "any enabled species", logged at error | same |
| Scripted spawns | `WildEncounterSpawner` writes an `encounters` row for a named species, the hunt's draw, or a strict filtered selector. Idempotent on `(origin_kind, origin_ref)` (partial unique index). `origin_kind` is a closed TypeScript set with no database CHECK | `encounters/wildEncounterSpawner.ts`, `encounters/speciesSelection.ts`, `drizzle/0026` |
| The formula | `clamp((base × charmModifier + buddyAffinity + captureBonus + itemCaptureBonus) × (1 + buddyBonus%/100), min, max)`. `base` is `species.base_capture_rate` when set, else the rarity default. `otherModifiers` is a reserved additive term, always 0 today | `capture/captureMath.ts` `describeCaptureChance` |
| Shipped values | Base by rarity: N 0.50, R 0.35, SR 0.22, SSR 0.12, UR 0.06, LR 0.03, EX 0.03. Clamp 0.02–0.95. **No shipped species sets `baseCaptureRate`** (0 of 175) | `content/tables.json`, species files |
| What influences success | Rarity (base), charm multiplier, item flat bonus, Buddy affinity matchup (scaled by the *Buddy's* rarity), Microdose charges, Buddy Bonus `capture_chance` (may be targeted by race, affinity or ownership). **Level does not.** Race and affinity matter only through Buddy terms | `captureService.gatherChanceInputs` |
| Charm consumption | **Always**, once per resolved attempt, success or failure, guaranteed items included. A Microdose charge is also spent per attempt, except on guaranteed captures | `captureService.attemptCapture` |
| Charm eligibility | `items.category = 'capture'`, `items.enabled`, and `items.capture_rarities` (null = every rarity). 17 capture-related items ship; `mythic_contract` is the only guaranteed one and has no shop price | `isCaptureItemEligible`, `content/items.json` |
| Attempts | `encounters.max_attempts` (3 for hunts and spawns). Fail below the limit → `failure`, selection kept; fail at the limit → `escaped` | same |
| Persistence | One `capture_attempts` row per attempt (chance, roll, success, guaranteed). **Nothing reads that table**; it is an audit log. The per-attempt breakdown also goes to the application log and a `player_progression_events` row | `db/schema.ts`, repo-wide search |
| Ownership | Success inserts one `player_waifus` row with `base_sp` rolled from the species' rarity band, in the same transaction. **This insert is the only code path that creates an owned copy** (the load-test fixture aside) | `captureService.ts:1038`, repo-wide search |
| Duplicates | Fully supported: every capture is its own row. `isDuplicate` is reported and Discord then offers Essence conversion | `captureService`, `waifumonHunt.ts` |
| Can a capture fail on catalogue restrictions? | Only on the **item** (disabled, wrong category, rarity-ineligible, not owned). The attempt does **not** re-check `species.enabled`: a species disabled mid-encounter stays capturable until the encounter expires. There is no collection-size cap | `attemptCapture` lines 850–893 |
| XP, quests, achievements | XP: 2 on a failed attempt; rarity value (10–200) plus 25 for a new dex entry on success. Quests: `capture_attempts`, `capture_success`, `capture_success_rarity_at_least`, all in the capture transaction. Achievements and leaderboards are **derived at read time** from `player_waifus` and `encounters` | `captureService`, `achievements/achievementService.ts` |
| Transactions and idempotency | `attemptCapture` opens **its own** transaction, `SELECT … FOR UPDATE` on the encounter row, with an `expectedAttemptCount` stale guard. It cannot join a caller's transaction. The roll uses the process RNG, not a seed | `attemptCapture` |
| Presentation | After commit, the hunt handler records session events, posts the SR+ rare-capture announcement, emits Activity Feed events, and toasts appearance unlocks. All are built around `CaptureAttemptResult` | `discord/commands/waifumonHunt.ts` `handleEncounterCapture` |

### 1.2 Why a dungeon encounter should not be an `encounters` row

Reusing the spawner and `attemptCapture` unchanged was evaluated first, because
it is the least new code. It is rejected for these verified reasons:

| Property of `encounters` (*Verified*) | Conflict with a dungeon run |
| --- | --- |
| `expires_at` wall-clock expiry (hunt default 120 s) | A run may be left for days and resumed; an encounter must not time out |
| `encounters_active_player_uq`: one active encounter per player | An open dungeon encounter would block hunting, and an open hunt would block the dungeon. `travelService` also blocks travel on any active encounter |
| Achievement metric "hunts completed" counts every non-active `encounters` row | Dungeon encounters would inflate it |
| `attemptCapture` owns its transaction | Charm spend and ownership could commit while the dungeon step rolled back, or the reverse |
| The roll is unseeded | A rolled-back step would re-roll on retry |

### 1.3 What the dungeon engine already provides

| Finding (*Verified*) | Where | Consequence |
| --- | --- | --- |
| `wild_encounter` and `rescue` are **reserved action types** ("Phase 4"); content using one is refused with a dedicated code | `content/dungeonDefinition.ts` `RESERVED_ACTION_TYPES` | The extension point exists and the names are taken |
| `player_waifus.acquired_via` and `player_waifus.grant_key` (unique when present) were added in migration 0059 for direct grants. **Nothing writes either** | `db/schema.ts`, `drizzle/0059` | Idempotent ownership grants need no migration |
| The engine is pure: one input → one step; `expectedStep` mismatch is refused as `stale`; `act` holds `FOR UPDATE` on the run row and commits state, effects and history together | `engine/step.ts`, `dungeonRunService.act` | Duplicate presses, retries and races are already solved |
| Random draws come from streams keyed by run seed and *place* (`deriveDungeonSeed`), never a running stream | `engine/seeds.ts` | A draw is the same whenever it is made; there is no reroll |
| Event pools: weighted entries, `when`, `oncePerRun`, explicit Nothing; drawn once on arrival and stored in `dungeon_runs.event_states`; `analyseEventPool` feeds both the draw and the author's odds | `content/dungeonEvents.ts`, `engine/events.ts` | The exact pattern species pools need |
| Facts the engine cannot look up (inventory) are read in the step transaction and passed in `ctx`; spending leaves as a `consume_items` effect whose conditional decrement fails the step on a lost race | `dungeonRunService.eventItemFacts`, `consumeItems` | The pattern for charms and capture odds |
| Conditions are `flag`, `room_completed`, `all`, `any`, `not`. `player`-scoped flags are declared but have no store | `content/dungeonPrimitives.ts`, `engine/conditions.ts` | Per-player limits cannot be expressed as conditions |
| The run pins its fighter (Buddy and stats) at start; a pinned copy cannot be released (`in_dungeon`), but the player **can** change their active Buddy mid-run | `dungeonFighter.ts`, `collection/waifuAvailability.ts` | Capture odds must choose pinned or live Buddy (§7.5) |
| One active run per player; daily run limit (default 3) spent at start | `dungeon_runs_one_active_uq`, `dungeon_settings` | Every dungeon step of one player is serialised by the run lock |
| The sandbox runs the real engine against a port that records effects and grants nothing | `engine/sandbox.ts` | Capture simulation without writes is one more port case |

### 1.4 Species catalogue and regional eligibility

| Finding (*Verified*) | Where |
| --- | --- |
| Species are **content-driven**: JSON under `content/species/` and `content/expansions/<pack>/species/`, upserted into `species` on every start and reload. A species missing from JSON is set `enabled = false`, never deleted | `content/seeder.ts` |
| 175 species ship (N 58, R 45, SR 33, SSR 20, UR 10, LR 9; no EX). All 175 have a dungeon sprite file (`waifumon/<slug>/<slug>_sprite.webp`) | content and `assets/` |
| Region exclusivity is the `region_exclusive` **tag**, enforced at two points: content validation (a tagged species in more than one enabled region's pool is fatal at boot) and the hunt's global fallback SQL. 75 species carry it | `locations/regions.ts`, `content/loader.ts` `validateRegionContent`, `huntService.notRegionExclusive` |
| `species.event_key` exists and is unused (0 set). There is no other availability field | schema, content |
| Regions are a closed set in code (`REGIONS`, six ids) with database CHECK constraints; adding one needs a migration | `locations/regions.ts` |

The regional pool audit is in §13.

### 1.5 Scenes and artwork

| Finding (*Verified*) | Where |
| --- | --- |
| A scene request has a background, environmental sprites, a reserved `playerBuddy` actor and one `sprite` actor with a `SpritePlacement` (six anchors, scale 1000–10000 bp, bounded offsets) on a 1200×675 canvas | `artworkAssets/sceneComposition.ts`, `scenePlacement.ts` |
| The Buddy is drawn from the species sprite convention through `playerBuddySpriteLayer`; she and the enemy are composed **only on fights** | `discord/dungeonArtwork.ts` |
| Composed scenes are cached by layer hashes and placements; a shipped file's hash is path + size + mtime | `sceneLayers.ts` |
| Every action already accepts optional `sceneSprites` | `actionBase` |

### 1.6 Packages

*Verified:* v1/v2/v3 are readable; v3 is emitted only for event content and adds
`dependencies.requiredItems`. Any definition with Scene Sprite placements is
refused at export, build, inspection and import
(`package_scene_sprites_unsupported`). Imports always land as disabled,
unpublished drafts. Strict schemas make older builds refuse unknown content.

### 1.7 Portal

*Verified:* the Dungeon Editor (`portal/src/features/adminDungeons`) has event and
event-pool sheets, a condition editor, enemy placement controls, a server-computed
insight hook (`useEventInsight`), a sandbox dialog and a checklist with Show me.
World Encounters has a species selector with a server candidate preview
(`WaifumonSelectorEditor`). The Admin Gallery is read-only (`gallery.read`, three
GET routes). **There is no Portal page for regions, region pools or species
editing.** The legacy admin panel (`src/admin`, off unless `ADMIN_WEB_ENABLED`)
edits species, items and tables JSON; it has no region pages.

---

## 2. Scope and explicit non-goals

### In scope (Phase 4)

- Two new dungeon activities, `wild_encounter` and `rescue`, with a dungeon-local
  library of species pools.
- Capture inside the dungeon step transaction using the existing formula, charms,
  ownership rows, XP and quest hooks.
- A backend-enforced dungeon-exclusivity policy.
- Portal authoring, sandbox simulation, validation and Discord presentation.
- Package portability for encounter content.
- A design (only) for Region Pool administration, as a separate workstream.

### Non-goals

- No change to capture probabilities, charm prices, rarity tables or species data.
- No reuse or refactor of World Encounters.
- No new combat mechanics; a wild WaifuMon is never fought.
- No generic scripting: outcomes carry text and flag writes only.
- No new placement engine, artwork store or retention pipeline.
- No Portal species editor. Species stay content-driven.
- No player-scoped flag store (still deferred).
- Region Pool editing is not part of the dungeon runtime and is not built in P4B–P4D.

---

## 3. Dungeon encounter and pool schemas

All additions are optional members with no top-level Zod default, so a definition
that uses none of them parses and hashes exactly as today (the Phase 3 rule).

### 3.1 Species pools

`definition.speciesPools?: DungeonSpeciesPool[]` (max 30), beside `events` and
`eventPools`.

```ts
DungeonSpeciesPool = {
  id,                              // stable, author-chosen, e.g. "sp_wild_androids"
  name,                            // 1–80 chars, authoring label
  entries: DungeonSpeciesPoolEntry[]   // 1–50
}

DungeonSpeciesPoolEntry =
  | { id, weight /* 1–1,000,000 */, species /* slug */,
      when?: DungeonCondition,
      oncePerRun: boolean /* default true */ }
  | { id, weight, nothing: true, when?: DungeonCondition, text?: string /* ≤200 */ }
```

- `species` is the species **slug**: the portable identity already used by content,
  packages and the Platform API. No database id appears.
- `oncePerRun`: the entry leaves the draw once that species has been *presented* by
  any encounter in this run, whether from a pool or named directly.
- Appearance probability is expressed with a Nothing entry, as event pools do. A
  single species that appears 30% of the time is a two-entry pool.
- The shape mirrors `DungeonEventPoolEntry` deliberately. The two engines stay
  separate (`engine/encounters.ts` beside `engine/events.ts`).

### 3.2 Encounter activities

```ts
DungeonSpeciesSource =
  | { kind: 'species', species /* slug */ }
  | { kind: 'pool', poolId }

encounterFields = {
  ...actionBase,                   // id, label, when, next, outcomes, sceneSprites
  source: DungeonSpeciesSource,
  intro: string,                   // ≤600, shown when she appears
  placement?: SpritePlacement,     // the existing enemy placement schema
  mirror?: boolean,
  results?: Partial<Record<Outcome, {
    text?: string,                 // ≤400
    flags?: { flag, value }[]      // ≤4, run-scoped, declared flags only
  }>>
}

CaptureRules = {
  maxAttempts: 1 | 2 | 3,          // default 3 (parity with a hunted encounter)
  allowedItems?: string[],         // item slugs; omitted = every eligible capture item
  allowGuaranteedItems: boolean    // default true
}

{ type: 'wild_encounter', ...encounterFields, capture: CaptureRules }
{ type: 'rescue', ...encounterFields, mode: 'direct' | 'capture', capture?: CaptureRules }
```

`optional` is not used: every encounter has a built-in Leave, so the validator
refuses `optional: true` on these types.

| Type | Outcomes |
| --- | --- |
| `wild_encounter` | `captured`, `escaped`, `left`, `nothing`, `unavailable` |
| `rescue` | `rescued`, `escaped` (capture mode only), `left`, `nothing`, `unavailable` |

Every outcome routes to `next` unless `outcomes` says otherwise. `retreat` is
refused as a destination (as it is for events): an encounter resolves once.
`nothing` means a pool drew a Nothing entry or had no eligible entry.
`unavailable` means the drawn species cannot be acquired under live policy (§6.3).

### 3.3 Limits

| Limit | Value |
| --- | --- |
| Species pools per dungeon | 30 |
| Entries per pool | 50 |
| Encounter activities per dungeon | 40 |
| Direct rescues per dungeon | 3 |
| Capture attempts per encounter | 3 |
| Result flag writes per outcome | 4 |

---

## 4. Wild capture rules

1. The species is fixed on arrival and stored (§8). Nothing rerolls it.
2. The player selects one of their eligible charms, then presses Capture. Selection
   is a step of its own and is stored on the run, as hunts store it on the
   encounter row, so a button never names an item the player did not choose.
3. Each attempt consumes one charm, whatever the result, and a Microdose charge
   when one is active and the item is not guaranteed. This is the existing rule.
4. The chance is the existing formula with the existing inputs (§7).
5. A failed attempt below `maxAttempts` leaves the encounter open. A failed attempt
   at the limit resolves `escaped`.
6. Leave resolves `left` at any time. The WaifuMon is gone for this run.
7. With no usable charm the player sees why and may only Leave. Buying charms
   elsewhere and returning is allowed, exactly as before a hunt; the run stays on
   the encounter until answered.
8. A resolved encounter is never offered again in that run: the action record and
   the stored instance both say so, and a completed room's sequence does not rerun.

**Recommended default: `maxAttempts` 3, capped at 3.** A dungeon encounter then
gives exactly the capture odds of a hunted one and can never be more generous.
Farming is limited by what already limits it: one encounter per site per run, the
daily run allowance, and a charm per attempt. Alternatives are in §21.

---

## 5. Rescue mechanics

A rescue is an encounter the author places behind dungeon conditions: a boss
victory flag, an event outcome flag, a key spent in an event, a gate.

| Mode | Behaviour |
| --- | --- |
| `capture` | Identical to a wild encounter; only the wording and outcome name differ |
| `direct` | One Rescue button. No charm, no roll. The copy is granted in the step transaction |

### Restrictions on direct rescue (publish errors)

1. Every species the rescue can present must list this dungeon in its content
   policy with `directRescue: true` (§6.2). A dungeon author cannot hand out an
   arbitrary species for free; the species' owner opts in.
2. That policy entry must carry a `perPlayerLimit` (default 1), enforced live from
   the acquisition ledger (§6.4).
3. At most three direct rescues per dungeon.
4. A direct rescue whose `when` is absent and whose room has no `requires` on any
   path to it raises a warning (`rescue_ungated`): it is free on arrival.

A direct rescue still obeys live availability (§6.3) and writes the same ownership
row, with `acquired_via = 'dungeon_rescue'`.

---

## 6. Dungeon-exclusive species policy

### 6.1 Recommendation

**Define exclusivity centrally on the species, in content, by extending the
existing `region_exclusive` tag mechanism. Add no policy table.**

Reasons: species are already content-driven and reseeded on every start; a new
exclusive species needs a deploy anyway (JSON and artwork); the tag pattern is
proven and already has matching enforcement points; and content ships identically
to every environment, so the policy is portable and a package cannot carry or
alter it.

### 6.2 Model

Two additions to species content:

- Tag `dungeon_exclusive`: she is never met by hunting or by any scripted spawn.
- Optional field `dungeonAccess: { dungeon: <dungeonKey>, perPlayerLimit?: number, directRescue?: boolean }[]`.

| Species is… | May be hunted | May be offered by a dungeon |
| --- | --- | --- |
| untagged (100 today) | Where a region pool lists her | **Any** dungeon. `dungeonAccess` is optional and only adds limits or direct-rescue permission |
| `region_exclusive` (75 today) | Only in her one region | Only dungeons listed in `dungeonAccess` |
| `dungeon_exclusive` | Never | Only dungeons listed in `dungeonAccess` |

This covers the four required cases: regional only (region-exclusive, no
`dungeonAccess`), dungeon only, both, and exclusive to particular dungeons.

### 6.3 Enforcement points

| Risk | Enforcement |
| --- | --- |
| A dungeon-exclusive species in a regional pool | Fatal content validation in `validateRegionContent`, beside the existing rule 6. The Region Pool editor (§13) applies the same rule at publish. `dungeon_exclusive` together with `region_exclusive` is also fatal |
| The hunt's fallbacks reaching her | `notRegionExclusive()` and `speciesSelection.globalPool` exclude both tags. The emergency tier returns nothing rather than an exclusive |
| A scripted spawn naming her | `WildEncounterSpawner` refuses a `dungeon_exclusive` slug (`unavailable`). World Encounter authoring validation reports it |
| An unrelated dungeon offering a restricted species | Dungeon validation error `species_not_permitted` at validate, publish and rollback |
| A package import bypassing policy | Policy is never in a package. Import reports each species against the target's own policy; the draft cannot publish until it passes (§15) |
| A disabled or newly restricted species acquired through an old revision | **Live check** at offer time and again at grant time, in the step transaction (§8.4) |
| Exceeding a per-player limit | Counted from the acquisition ledger under the run lock, at offer and at grant |

All ownership is created by `captureService`. With the hunt pick and the spawner as
the only two producers of `encounters` rows, and the dungeon grant path checking
policy itself, there is no fourth route.

### 6.4 Acquisition ledger

New table `dungeon_species_acquisitions`: one row per copy a dungeon granted
(player, species, dungeon key, run, room, action, mode, waifu id, grant key,
time). It answers "how many has this player taken from this dungeon" for
`perPlayerLimit`, and is the audit trail for exclusives. Counting then inserting
is safe because every dungeon step of a player holds that player's single active
run row.

### 6.5 Author visibility

The species picker shows, per species: rarity, enabled state, the regions that
pool her, an Exclusive badge with its kind, the dungeons permitted, and whether
*this* dungeon may offer her. A species this dungeon may not offer is listed,
disabled, with the reason.

### 6.6 Changes after publication

Frozen in the revision: which slugs an encounter can present, weights,
conditions, rules, placement and text. Live: `enabled`, rarity and base capture
rate, tags, `dungeonAccess`, per-player counts, charm definitions.

| Change after publish | New runs | A run that has not yet reached the encounter | A run already offered that species |
| --- | --- | --- | --- |
| Species becomes dungeon-exclusive, this dungeon listed | Unchanged | Unchanged | Unchanged |
| Species becomes exclusive or restricted elsewhere | Entry resolves `unavailable` when drawn | Same | The next attempt is refused; the encounter resolves `unavailable`; no charm is spent |
| Species disabled or removed from content | Same | Same | Same |
| Rarity or base rate changes | Live value applies | Live value applies | Live value applies to the next attempt |
| Per-player limit reached in another run | `unavailable` | `unavailable` | Cannot occur: one active run per player |

An ineligible entry is **not** removed before the draw. Its weight becomes an
`unavailable` result. This keeps the draw a pure function of the frozen pool and
never raises another entry's odds because an admin disabled something.

Nothing is silent: the outcome is logged on the run (`encounter_selected` with the
reason), the published dungeon shows a dependency warning in the Portal list
(`speciesDiffer`, in the manner of `sceneSpritesDiffer`), and the checklist names
the species and the encounters affected. Remediation is in §17.

---

## 7. Capture probability, charm integration and economy

### 7.1 What is shared and what is not

| Shared with hunting | Not shared |
| --- | --- |
| `describeCaptureChance` and `CaptureConfig` | Result table, rarity table, region pools, fallbacks |
| Item eligibility, charm consumption, Microdose charges | `encounters` and `capture_attempts` rows |
| `player_waifus` insert with rolled `base_sp` | Wall-clock expiry, one-active-encounter rule |
| XP, new-dex bonus, capture quests, appearance sync | Server-side selection column on the encounter row |
| Post-commit announcements and toasts | Energy and cooldown |

Dungeon captures can safely share the probability formula without sharing
hunt selection, because the formula takes a species row and an item and knows
nothing about how the species was chosen.

### 7.2 Minimum changes to the capture module

Three extractions, with `attemptCapture`'s behaviour unchanged:

1. **`quoteSpecies(tx, playerId, species, item | null, buddy?)`**: what `buildQuote`
   computes, without an encounter row. `buildQuote` becomes a wrapper.
2. **`resolveCaptureAttempt(tx, input)`**: the body of `attemptCapture` from item
   consumption to appearance sync, without the encounter row writes and the
   `capture_attempts` insert. It takes the species, the item, the decided roll, an
   optional provenance (`acquiredVia`, `grantKey`) and an RNG for `base_sp`.
   `attemptCapture` calls it between locking the encounter and writing its rows.
3. A grant-only entry (`grantSpeciesCopy`) for direct rescues: the success branch
   alone.

This is a refactor of the most sensitive function in the game. It ships with the
existing capture, Buddy bonus and affinity suites passing unmodified, and a test
that a hunted capture's log breakdown is identical before and after.

### 7.3 Dungeon rules on top

- `allowedItems` and `allowGuaranteedItems` narrow which owned charms are offered.
  They never add an item the global rules would refuse.
- No dungeon difficulty modifier in Phase 4. The formula's reserved
  `otherModifiers` term is where a bounded authored modifier would go later (§21).

### 7.4 Technical safeguards (not balance choices)

- The formula, clamp, charm cost per attempt and rarity gating are the global ones.
- At most three attempts per encounter; one resolution per encounter site per run.
- One copy per encounter site per run, by a unique grant key.
- Daily run allowance, spent at start, never refunded.
- Restricted species need a central opt-in; direct rescue needs a second opt-in
  and a per-player limit.

### 7.5 Which Buddy affects the odds

The hunt reads the **live** active Buddy. A dungeon pins its fighter at start.
Recommendation: use the **pinned** fighter's species for affinity and Buddy Bonus,
consistent with Phase 2's pinned reward bonuses and with the WaifuMon drawn in the
scene, and removing any reason to swap Buddy before an encounter. This needs
`quoteSpecies` to accept a Buddy override; the service resolves only the active
Buddy today. The lower-effort alternative is the live Buddy (§21).

### 7.6 The real economy lever: appearance, not capture chance

A hunt meets an LR in 0.1% of encounters. A dungeon author chooses weights, so a
pool can present an LR far more often. The capture chance is still the LR's (3%
base, 15% with a Prismatic Charm, about 39% over three such attempts). Controls
available without inventing values:

| Control | Kind |
| --- | --- |
| Portal shows each pool's rarity mix beside the hunt's rarity table | Information |
| Warning when a pool's UR+LR share exceeds a configured threshold | Validation (threshold is a product value) |
| `oncePerRun` on entries | Authoring |
| `perPlayerLimit` in species policy | Central, enforced |
| `allowGuaranteedItems: false` on an encounter | Authoring |

### 7.7 Options for repeatable exclusive captures

| Option | Effect |
| --- | --- |
| A. Ordinary repeatability | Any number over time; limited by run allowance and charms |
| B. `perPlayerLimit: 1` | First copy only; later runs find `unavailable` |
| C. `perPlayerLimit: n` | A small collection ceiling per dungeon |
| D. Once per run only (`oncePerRun`) | One chance per run, unlimited runs |

All four are supported by the design. Which applies to which species is content
(§21).

### 7.8 XP, quests and statistics

Recommended: a dungeon capture attempt grants the same XP and advances the same
capture quests as a hunted one (it is the same function). Achievements and
leaderboards follow automatically because they are derived from `player_waifus`.
"Hunts completed" is unaffected because no `encounters` row is written.

---

## 8. Deterministic selection and run persistence

### 8.1 Run state

```ts
state.encounters?: Record<`${roomId}:${actionId}`, DungeonEncounterInstance>

DungeonEncounterInstance = {
  species: string | null,          // slug; null when nothing was drawn
  status: 'offered' | 'captured' | 'rescued' | 'escaped' | 'left'
        | 'nothing' | 'unavailable',
  unavailableReason?: 'missing' | 'disabled' | 'not_permitted' | 'player_limit',
  selectedStep: number,
  pool?: { poolId, entryId: string | null, eligible: string[], totalWeight, roll: number | null },
  selectedItem?: string | null,    // item slug chosen for the next attempt
  attempts: { n, item, chance, roll, success, step }[],
  grantKey?: string,
  resolvedStep?: number
}
```

Stored in a new column `dungeon_runs.encounter_states` (jsonb, default `{}`),
separate from action records for the reason `event_states` is: a retreat elsewhere
in the room erases action records, never this.

### 8.2 Streams

| Draw | Stream |
| --- | --- |
| Pool selection | `('encounter', roomId, actionId, 'pool')` |
| Capture roll, attempt *n* | `('encounter', roomId, actionId, 'attempt', n)` |
| `base_sp` of the granted copy | `('encounter', roomId, actionId, 'sp')` |

Selection walks eligible entries by integer weight, as `selectDungeonEvent` does.
One function, `analyseSpeciesPool`, produces both the draw and the author's odds.

Seeding the capture roll adds no information a player can use: the roll is never
shown, and seeing a result costs the charm and the attempt. It means a step that
rolled back replays to the same result.

### 8.3 What cannot reroll a selection

Disconnecting, reopening Discord, pressing Resume, a stale button, a retried
interaction, leaving and re-entering the room, or a rolled-back transaction all
read the stored instance or re-derive the same stream. Abandoning ends the run.
A new run is a new seed, a new daily attempt and a new encounter.

### 8.4 Live facts

The engine cannot read the catalogue, so the run service passes facts in `ctx`,
read in the step transaction:

```ts
ctx.encounterFacts?: {
  species: Record<slug, { available: boolean, reason, name, rarity }>,
  items?: Record<slug, { owned, eligible, permitted, guaranteed, chance }>
}
```

`species` covers every slug the pinned definition's encounters can present (one
query, only for definitions with encounters). `items` is filled only while the
cursor stands on an offered capture encounter.

---

## 9. Execution model, transaction boundaries and idempotency

### 9.1 Lifecycle

| # | Step | Where |
| --- | --- | --- |
| 1 | The sequence reaches the action; `when` is evaluated | engine |
| 2 | First arrival: a named species is taken, or the pool is drawn; the instance is stored; `encounter_selected` is logged | engine |
| 3 | Live availability of the selected species is read from `ctx`. Unavailable → `unavailable`, routed on at once | engine |
| 4 | Nothing drawn → `nothing`, routed on at once. Otherwise the cursor waits | engine |
| 5 | The view shows the WaifuMon, her rarity, the player's permitted charms with the quoted chance each, attempts left, and Leave | service, presenter |
| 6 | `select_item`: stores the chosen charm on the instance. No effect | engine |
| 7 | `capture`: availability, ownership and eligibility are judged again from this step's facts; the roll is drawn; state is updated; a `capture_attempt` effect is emitted | engine |
| 8 | The live port consumes the charm and Microdose charge, records the attempt, and on success grants the copy, XP, quests and the ledger row | service |
| 9 | Result text and flags are applied; the action routes | engine |
| 10 | State, effects and history commit together | service |
| 11 | After commit: announcements, session summary, toasts | Discord |

New inputs: `select_item { item }`, `capture`, `rescue`, `leave_encounter`. New
refusals: `capture_item_required`, `capture_item_unavailable`,
`encounter_not_offered`. New effects: `capture_attempt`, `rescue_grant`. New log
types: `encounter_selected`, `capture_attempted`, `waifu_acquired`.

### 9.2 One transaction

Everything in rows 6–10 happens inside the existing `act` transaction, under the
run row's `FOR UPDATE`. There is no second transaction and no delivery queue.

Order of writes inside it: run row lock → `player_inventory` conditional
decrement → Microdose charge → `player_waifus` insert → acquisition ledger →
progression and quests → run row and `dungeon_run_events`. The hunt and capture
paths never lock a run row, so the order cannot cycle with them. This must be
confirmed against `progression.grantXp` and the quest service in P4B.

### 9.3 Idempotency keys

| Thing | Key | Enforced by |
| --- | --- | --- |
| Selection | instance at `state.encounters["<room>:<action>"]` | Run row; stream is place-keyed |
| Attempt *n* | `run:<runId>:<room>:<action>:capture:<n>` | `expectedStep` under the run lock; recorded in `attempts[]` and `capture_attempted` |
| Ownership grant | `player_waifus.grant_key = dungeon:<runId>:<room>:<action>` | Existing unique partial index |
| Ledger row | same grant key, unique | New table |
| Charm spend | inside the step | Conditional decrement, `quantity >= 0` CHECK |

A player cannot gain two copies from a retry or a race: the second arrival waits
on the run lock and is refused as `stale`; even if a bug let it through, the grant
key is unique.

### 9.4 Situations

| Situation | Behaviour |
| --- | --- |
| Two interactions at once | Serialised by the run lock; the loser is `stale` |
| Duplicate button press | `stale`; nothing spent |
| Stale step number | `stale`; the current screen is redrawn |
| Disconnect, resume | The stored instance is shown as it stands, attempts included |
| Retreat and re-entry | The instance outlives action records; an offered encounter is offered again, a resolved one routes on without reapplying anything |
| Charm sold or used between view and press | The facts are read in the step; the conditional decrement is the last word. Failure rolls the step back with `DungeonCaptureItemUnavailableError` (409) |
| Buddy or Microdose changes between facts and commit | The commit uses the facts it was given and asserts the charge decrement matches; a mismatch rolls back as retryable |
| Ownership grant fails | The whole step rolls back: no charm spent, no attempt recorded. The retry draws the same roll |
| Transaction rollback then retry | Same stream, same result |
| Abandon during an encounter | The run ends; the instance stays `offered`; nothing is granted or spent |
| Completion or defeat | Cannot happen while the cursor waits on an encounter |
| Dungeon republished mid-run | The run plays its pinned revision's pools and rules |
| Species availability changes mid-run | §6.6 |

---

## 10. Integration with Dungeon Events and run flags

**Recommendation: a dedicated encounter activity, gated by the existing `when`,
gates and connection locks, with event outcomes setting the flags.** No new event
effect and no second branching framework.

| Scenario | How it is authored |
| --- | --- |
| A narrative choice unlocks a hidden capture | The outcome sets `found_hidden_cell`; a `secret` connection or the encounter's `when` requires it |
| A failed skill check prevents a rescue | Only the `success` outcome sets the flag |
| Defeating a boss exposes a captive | A `set_flag` after the boss on `victory`, or `room_completed` of the boss room |
| A random event reveals a capture opportunity | An event pool entry whose outcome sets the flag |
| Repairing a generator enables an Android encounter | An event choice that consumes an item and sets `generator_on` |
| A flag decides which pool appears | Two encounter actions with opposite `when`, or one pool with `when` on entries |

The reserved event effect `trigger_event` stays reserved. An "event outcome that
directly starts a capture" was considered and rejected: it would need the event
engine to hold an encounter frame, duplicate selection and persistence, and make
one step both resolve an event and offer an encounter.

Encounter results write run flags (§3.2), so a capture can open a later path or
change a later event pool.

---

## 11. Artwork and scene composition

- The wild WaifuMon takes the scene's existing **`sprite` actor slot**, with a
  `SpritePlacement`, and is not a combat enemy. No new placement model.
- Her image is the species dungeon sprite, resolved by the function that already
  resolves the Buddy's (`shippedArtworkLayer` on `speciesDungeonSpritePath`).
- The pinned Buddy is drawn in her reserved place. The rule "Buddy and actor are
  composed only on fights" gains one case: an offered encounter.
- Default placement is `DEFAULT_SPRITE_PLACEMENT`; an activity may override
  `placement` and `mirror` with the existing `PlacementControls`.
- Room and activity Scene Sprites compose as on any activity.

| Screen | Image precedence |
| --- | --- |
| Encounter offered | Composed scene (background, environment, Buddy, WaifuMon) → her standard artwork alone → room background → text |
| Captured or rescued | Her card, as a hunted capture shows it |
| Escaped, left, nothing, unavailable | The room scene without her |

Caching: the key already includes each layer's hash and placement, so each
species in a pool is one cached file per room and placement. Species sprites are
shipped files, so, like the Buddy's, they are not frozen in the revision; a
deploy that replaces one changes its hash. Transparency and aspect ratio are
handled by `layoutSprite`. A missing or undecodable sprite degrades through the
precedence above and is logged once.

A pool activity's Portal preview shows the first species entry, with a selector
to preview any other.

---

## 12. Portal authoring and Discord presentation

Everything lives in the existing Dungeon Editor and follows the Event Editor's
conventions. No new admin application. The Portal computes no odds, availability
or capture chance; it asks the server, as `useEventInsight` does.

### 12.1 Species pools

A **WaifuMon Pools** panel in dungeon settings, beside the Events panel
(`DungeonEventsPanel` is the model):

- Create, rename, duplicate and delete. Delete is refused while an activity uses
  the pool; the panel lists every room and activity that does.
- A pool sheet (`EventPoolSheet` is the model): add species through the shared
  picker (§14), remove them, set weights, toggle once-per-run, attach a condition
  with the existing `DungeonConditionEditor`, add a Nothing entry with its line.
- Each row shows thumbnail, name, rarity, availability badges, weight and
  effective percentage. A footer shows the Nothing probability and the pool's
  rarity mix beside the hunt's rarity table.
- **Scenario controls** (the Event scenario controls, extended): set flags,
  completed rooms, species already met this run and "player is at their limit",
  and see the odds change. Ineligible rows stay visible, greyed, with the reason.

Ids are minted by the Portal (`sp_` and `se_` plus 32 hex), as event ids are.

### 12.2 Encounters on a room

Two entries in the room's add-activity menu: **Wild Encounter** and **Rescue**.
The activity editor has five short parts:

1. **Who appears**: a specific WaifuMon (shared picker) or a pool, with the pool's
   odds shown inline and a link to open it.
2. **When**: the existing condition editor on `when`.
3. **Rules**: attempts (1–3); permitted charms (all, or a chosen list from the
   capture items); allow guaranteed items. For Rescue: Direct or Capture, with the
   direct-rescue requirements stated beside the control.
4. **Scene**: the existing enemy `PlacementControls` for position, scale and
   mirror, and the existing Scene Sprites editor for the activity.
5. **Results**: for each outcome, optional text, flag writes (declared run flags
   only) and routing, using the existing outcome routing controls.

A **Discord preview** renders the offered screen and each result screen through
the production presenter and compositor, as the Event preview does.

### 12.3 Sandbox

`DungeonSandboxDialog` and `POST /sandbox` gain capture inputs. The route already
replays every input per press and writes nothing.

| Input | Meaning |
| --- | --- |
| `captureItems` | Charms the simulated player holds, by slug and quantity |
| `buddy` | Optional species for the affinity and Buddy Bonus terms |
| `captureOutcome` | `roll` (the seeded roll against the real formula), or forced `success` / `failure`, labelled as forced |
| `speciesAtLimit` | Species to treat as at their per-player limit |

The response adds `encounterResults`: the species selected and how, each attempt
with its chance breakdown and roll, charms that *would* be consumed, and the copy
that *would* be granted. The sandbox port records `capture_attempt` and
`rescue_grant` effects and returns synthetic receipts. It has no path to
inventory, ownership, XP or the ledger.

### 12.4 Checklist

The validation codes of §17.1 appear in the existing checklist with plain
messages and Show me. `friendlyIssue` learns `speciesPools[…]` paths and the new
activity fields, so Show me opens the pool sheet on the entry, or the activity on
the field. Incomplete drafts (no species chosen, empty pool) are reported
client-side, as unfinished events are, because the server cannot store them.

### 12.5 Discord presentation

| Screen | Content | Controls |
| --- | --- | --- |
| Encounter offered | Composed scene; name and rarity; intro; attempts left; selected charm and its chance, from the service's quote | Charm select menu; Capture (disabled until a charm is chosen); Leave |
| No usable charm | As above, with the reason | Leave |
| Direct rescue | Composed scene; intro | Rescue; Leave |
| Attempt failed, attempts left | Result line; attempts left | Same as offered |
| Captured or rescued | Her card; result text; new-dex and duplicate notes | Continue; the existing duplicate-conversion prompt |
| Escaped, left, nothing, unavailable | Result or default text | Continue |

Custom ids follow the existing `dg|…|<runId>|<step>` form, so every control
carries the step guard: `dg|ci` (charm select; the value is the item slug),
`dg|cap`, `dg|res`, `dg|cl`. The charm is never in a button id.

---

## 13. Region Pool management: audit and design

### 13.1 Audit (*Verified*)

| # | Question | Finding |
| --- | --- | --- |
| 1 | Where is regional eligibility stored? | Authored in `content/regions/waifu-valley.json` and `content/expansions/<pack>/region.json` (`encounterPool: [{ species, weight? }]`). Projected into `region_encounter_pools (region_id, species_id, weight)` |
| 2 | File, database or computed? | File-authored, database-projected. The hunt reads only the table |
| 3 | How are region restrictions enforced? | Pool membership, the `region_exclusive` tag, fatal content validation, and the fallback SQL exclusion. `region_id` has a CHECK against the six canonical ids |
| 4 | How does rarity influence selection? | Rarity is rolled first from a global table; the pool decides only who within that rarity |
| 5 | Per-species weights? | **Yes, region-local.** They matter only inside a rarity bucket. An entry with no weight inherits `species.perSpeciesWeight`. Waifu Valley's 100 entries set none; the five expansion regions set all of theirs (30–40 entries each) |
| 6 | Region-exclusive species? | The tag; at most one enabled region may pool a tagged species. 90 species are pooled in more than one region |
| 7 | Do edits need a restart? | The table is **deleted and rebuilt** from JSON on every content seed: at startup and on the legacy panel's Reload Content. A direct table edit is lost at the next seed |
| 8 | Seeds and sync? | As 7. Disabled regions are not seeded. The content directory is a read-write bind mount in `docker-compose.yml` |
| 9 | Portal today? | None for regions or pools. Species are view-only (Admin Gallery, Encyclopedia) |
| 10 | Is runtime editing safe for hunt maths? | Yes. The hunt reads the table per draw inside its transaction. Replacing one region's rows in one transaction changes who is drawn, not how. Only the seeder stands in the way |

### 13.2 Source of truth

| Option | Assessment |
| --- | --- |
| Edit the JSON files from the Portal | Works with the writable mount and the legacy service's validate-backup-rename path. No audit trail, no drafts, lost on an image redeploy that replaces `content/`, needs a reload that reseeds everything |
| Database override with draft and publish | **Recommended.** The pattern bosses, enemies, dungeons and world encounters already follow: the database is authoritative, JSON only bootstraps |
| Export an authoring package for files | Safe and reviewable, but every change needs a deploy. Kept as an export button, not the workflow |

### 13.3 Proposed design

- New tables: `region_pool_revisions` (region, number, entries, hash, published by,
  time; immutable), `region_pool_drafts` (region, entries, draft revision for
  optimistic locking) and `region_pool_events` (audit).
- `region_encounter_pools` stays the runtime projection. **The hunt is not
  changed.** Publish replaces one region's rows in one transaction.
- The seeder stops deleting the table. It bootstraps a region that has no
  published revision from JSON, and never overwrites one that has.
- Rollback republishes an earlier revision's entries as a new revision.
- Concurrency: a stale draft save is refused (as dungeon drafts are). Publishes of
  one region serialise on its draft row.

### 13.4 Workflow

1. Select a region. See every pooled species with thumbnail, rarity, race,
   affinity, weight and exclusivity.
2. Search and filter by name, rarity, race and affinity.
3. Add (shared species picker) or remove species; edit region-local weights.
4. Preview the **existing** effective distribution, computed by the server from a
   pure function extracted beside `pickEncounterSpecies`: per rarity, the table
   share at a chosen player level; per species, share within her bucket and
   overall. A rarity with no species here is labelled with its real fallback
   (Waifu Valley's bucket, then the global non-exclusive set). Buddy bonuses are
   stated as excluded.
5. Validate: unknown or disabled species, non-positive weights, a
   `region_exclusive` species already pooled elsewhere, any `dungeon_exclusive`
   species, an enabled region left empty.
6. Review the diff against the published revision, then publish.
7. History lists revisions and audit events, with rollback.

Permissions: new `regions.read`, `regions.write`, `regions.publish`.

The fixed rarity table is preserved and shown read-only. The editor manages the
weights that exist (within-rarity) and does not invent a cross-rarity weight.

---

## 14. Shared Portal components

A small shared layer under `portal/src/components/species/`, used by Dungeon
Pools, Region Pools and, later, the World Encounter selector:

| Component | Used for |
| --- | --- |
| `SpeciesPicker` | Search, rarity/race/affinity/availability filters, multi-select |
| `SpeciesThumb`, `RarityBadge` | Thumbnail and rarity label |
| `AvailabilityBadges` | Enabled, region-exclusive, dungeon-exclusive, permitted here |
| `WeightField` + `ShareBar` | A weight input with its computed share |
| `PoolIssueList` | Validation messages keyed to an entry |

One read endpoint supplies them: slug, name, rarity, race, affinity, enabled,
tags, thumbnail reference, pooled regions and permitted dungeons.

Candidates to extract from, to be confirmed in P4C: `WaifumonSelectorEditor` and
`EntitySelect` (World Encounters), `GalleryBadges` and `GallerySpeciesTile`
(Admin Gallery), `ArtThumb` and `EventPoolSheet` (Dungeon Editor).

Not shared: the calculations. Dungeon odds come from `analyseSpeciesPool`
(flat weights, conditions, once-per-run, Nothing). Region odds come from the
rarity-first hunt model. The Portal computes neither; each has its own server
endpoint.

---

## 15. Publication, dependencies and packages

### 15.1 Publication

- Pools, encounter rules and species slugs are part of the definition, so they are
  hashed, published and pinned with it. A pool edit needs a republish to reach new
  runs; active runs keep their revision.
- Publish validates every reachable species against live policy (§17.1).
- A small **species manifest** is frozen with the revision (slug, name, rarity,
  exclusivity at publish). It is informational: it drives the `speciesDiffer`
  status and drift messages. It is never used for capture maths.
- `dungeonDependencies` gains `species` (reachable slugs) and capture `items`
  (`allowedItems`). Unused pools are validated structurally but are not
  dependencies, as unused events are not.
- Species sprites are shipped assets and need no publication freeze or
  managed-asset protection.

### 15.2 Package version 4

A new version is needed for the same reason v3 was: a new manifest member and a
clear refusal message, since older builds already refuse the content through
strict schemas.

- **v4** = the v3 envelope plus `dependencies.requiredSpecies` (sorted reachable
  slugs with rarity and exclusivity at export) and `dependencies.captureItems`.
  `requiredItems` may be empty; the reward snapshot is nullable as in v3.
- Emitted only when the definition has a species pool or an encounter activity.
  Every other dungeon exports byte-identical v1, v2 or v3.
- v1/v2/v3 packages import exactly as today. A v1–v3 envelope that contains
  encounter content is refused (`package_schema_version`).
- v4 shares v2/v3's locks, conflict decisions, receipts and
  disabled-unpublished-draft result.

### 15.3 Import checks

| Target state of a required species | Review status | Import | Publish |
| --- | --- | --- | --- |
| Present, enabled, permitted for this dungeon key | `ok` | Allowed | Allowed |
| Unknown slug | `missing` | Only with `allowMissingDependencies` | Blocked |
| Disabled | `disabled` | Only with `allowMissingDependencies` | Blocked |
| Restricted and this dungeon not listed | `restricted` | Only with `allowMissingDependencies` | Blocked |
| Direct rescue not permitted | `direct_rescue_not_permitted` | Only with `allowMissingDependencies` | Blocked |
| Rarity differs from the source | `ok`, with a warning | Allowed | Allowed |

Exclusivity is content, so it is the same in every environment running the same
build. A package neither carries nor changes it.

### 15.4 Scene Sprites gate

Unchanged. A dungeon with encounters **and** Scene Sprite placements is still
refused, by the existing check, which runs before version handling. v4 adds no
visual dependency and does not carry sprite artwork. The future sprite manifest
needs its own version after v4; the two must not be merged without an explicit
decision.

---

## 16. Required database migrations

Proposed only. None is written in Phase 4A. Numbers assume the next free index
after `0067`.

| Migration | Contents |
| --- | --- |
| `0068_dungeon_encounters` | `dungeon_runs.encounter_states jsonb not null default '{}'`; `dungeon_run_events_type_check` extended with `encounter_selected`, `capture_attempted`, `waifu_acquired`; table `dungeon_species_acquisitions` with a unique grant key and an index on `(player_id, dungeon_key, species_id)` |
| Region Pools workstream, later | `region_pool_revisions`, `region_pool_drafts`, `region_pool_events` |

Not needed: any change to `species`, `encounters`, `capture_attempts`,
`player_inventory` or `player_waifus` (`acquired_via` and `grant_key` exist since
0059). Exclusivity uses tags and a content field, so it needs no migration.

---

## 17. Risks, compatibility safeguards and recovery

### 17.1 Validation

Issue paths name `speciesPools[…]` and `rooms[…].actions[…]`, so the checklist's
Show me opens the pool sheet or the activity, focused on the field.

| Code | Severity | Meaning |
| --- | --- | --- |
| `species_missing` | error | Slug not in the catalogue |
| `species_disabled` | error | Species is disabled |
| `species_not_permitted` | error | Restricted species and this dungeon is not listed |
| `species_pool_missing` | error | Encounter names a pool the dungeon lacks |
| `species_pool_empty` | error | Pool has no species entry |
| `species_pool_duplicate_entry` | error | Same species twice in one pool |
| `species_pool_weight_invalid` | error | Weight outside 1–1,000,000 |
| `species_pool_unused` | warning | Pool referenced by no activity |
| `species_pool_always_nothing` | warning | No species entry can ever be eligible (condition analysis as for event pools) |
| `species_pool_rarity_heavy` | warning | UR+LR share above the configured threshold |
| `encounter_condition_impossible` | warning | `when` can never hold |
| `encounter_unreachable` | warning | No path reaches the room or action |
| `encounter_route_retreat` | error | An outcome routes to `retreat` |
| `encounter_optional` | error | `optional: true` on an encounter |
| `capture_item_missing` | error | `allowedItems` names an unknown item |
| `capture_item_not_capture` | error | Item is not a capture-category item |
| `capture_item_disabled` | warning | Item disabled; it will not be offered |
| `capture_no_usable_item` | error | No permitted item is eligible for some species the encounter can present |
| `capture_settings_invalid` | error | `maxAttempts` out of range, or `capture` missing where required |
| `rescue_direct_not_permitted` | error | §5 rule 1 |
| `rescue_direct_limit_missing` | error | §5 rule 2 |
| `rescue_direct_too_many` | error | More than three direct rescues |
| `rescue_ungated` | warning | §5 rule 4 |
| `encounter_flag_undeclared` | error | A result writes an undeclared or player-scoped flag |
| `encounter_sprite_missing` | warning | Species has no dungeon sprite; the fallback image is used |
| `encounter_too_many` | error | Over the per-dungeon limits |
| `package_species_*` | error | Import review statuses of §15.3 |

Draft saves accept unresolved references for repair, as they do for scene sprites.
Publish and rollback block on errors.

### 17.2 Risks and safeguards

| Risk | Safeguard |
| --- | --- |
| Refactoring `attemptCapture` changes hunt behaviour | Extraction only; existing suites unmodified; a before/after breakdown-equality test; P4B2 is reviewed on its own |
| Double grant | Run lock, step guard, unique grant key, unique ledger key |
| Charm spent without an attempt recorded, or the reverse | One transaction |
| Lock-order deadlock with hunts | Fixed write order (§9.2); a concurrency test running hunts against dungeon captures |
| Pinned Buddy quote diverges from the service | One code path with an optional Buddy argument, not a copy |
| Authors flood rare species | §7.6 controls; per-player limits; rarity warning |
| Exclusivity policy drifts between JSON and dungeons | Dangling dungeon keys are reported in the Portal's species view; restricted species default to unobtainable |
| `dungeon_run_events` CHECK change locks history | Same shape as migration 0065: rehearse on representative data with a lock timeout |
| Old builds reading new content | Strict schemas refuse it; deploy database → backend/bot → Portal; roll forward, not back, once encounter content is published |
| Seeder change (Region Pools) strands pools | Bootstrap-if-absent, covered by a migration test on a copy of production pools; separate workstream |

### 17.3 Recovery when a published encounter becomes unavailable

1. Players are never blocked: the encounter resolves `unavailable` and the run
   continues. No charm is spent.
2. The Portal dungeon list flags the dungeon; the checklist names the species, the
   reason and each encounter.
3. Administrator options: restore the species or its `dungeonAccess` (content
   deploy); or edit the pool and republish (new runs); or disable the dungeon.
4. Active runs on the old revision keep resolving `unavailable` for that species.
   This is deliberate: live policy outranks a frozen revision.
5. Compensation for affected players is manual, through existing staging/admin
   tooling; no automatic grant is proposed.

---

## 18. Recommended implementation tasks

| Pass | Tasks | Relative size | Main risk |
| --- | --- | --- | --- |
| **P4B1 — pure runtime** | Schemas and limits; `analyseSpeciesPool` and selection; engine handler, inputs, effects, view; structural validation; sandbox port cases. Live play, publish and export gated off (as P3B1 gated events), with a read-only Portal card so saves do not drop the content | M | Hash stability of existing content |
| **P4B2 — capture integration** | The three `captureService` extractions; species policy in loader, hunt fallback and spawner; migration 0068; live facts, live port, ledger; policy validation at publish; remove the gate | **L** | The capture refactor; lock order |
| **P4C1 — Discord** | Encounter screen, charm selector, result screens, scene composition with the WaifuMon actor, post-commit announcements reusing the hunt helpers | M | Reusing helpers built around `CaptureAttemptResult` |
| **P4C2 — Portal** | Shared species components; pool panel and sheet; encounter activity editor with placement; server insight endpoint; sandbox capture inputs; checklist and Show me | **L** | Editor size; keeping odds server-computed |
| **P4D — portability and readiness** | Package v4 build/read/import review; two-database lifecycle test; creator guide; release assessment | M | Coordination with the Scene Sprites gate |
| **RP1–RP3 — Region Pools (separate)** | RP1 tables, seeder bootstrap, distribution function; RP2 API, publish, audit; RP3 Portal page | M each | The seeder change |

P4B2 and P4C2 are the two that should not grow. If P4B2 is too large, split the
capture extraction (no dungeon code, hunt tests only) from the dungeon wiring.
If P4C2 is too large, ship pools and encounter authoring before the sandbox
extension.

---

## 19. Testing strategy and acceptance criteria

### Unit (pure)

- Pool analysis: weights, conditions, once-per-run, Nothing, empty eligibility.
- Selection determinism: same seed and place, same species; independent of other
  draws; unchanged by retreat.
- Engine: every outcome and route; attempt limit; stale and refusal cases;
  availability at offer and at attempt; result flags applied once.
- Existing dungeon golden hashes unchanged; encounter-free packages byte-identical.
- Formula: a dungeon quote equals `describeCaptureChance` for the same inputs.

### Integration (Postgres)

- Capture success, failure, escape, leave: charm, Microdose, copy, XP, quests,
  ledger and history all agree, and all roll back together when the last write is
  made to fail.
- Concurrent duplicate capture presses: one attempt, one charm, one copy.
- Forced rollback then retry: same roll and outcome.
- Grant key uniqueness under a forced second grant.
- Hunts racing dungeon captures for the same player: no deadlock.
- Species disabled, restricted and limit-reached between offer and attempt.
- Per-player limit across runs.
- Hunt regression: existing capture suites unmodified.
- Exclusive species unreachable by hunt fallback and by scripted spawn.
- Migration 0068 on disposable Postgres, including the CHECK swap.
- Two-database v4 export/import with missing, disabled and restricted species.

### Portal and browser

- Pool create, rename, duplicate, delete-refused-while-used; odds match the server.
- Encounter authoring, placement, Discord preview; checklist Show me.
- Sandbox capture: no inventory or collection write (asserted against the database).

### Acceptance criteria

1. A published dungeon can present a wild or rescued WaifuMon that is captured
   with the player's real charms at the hunt's exact odds.
2. No sequence of retries, races, disconnects or re-entries changes a selection,
   repeats an attempt, or grants a second copy.
3. A dungeon-exclusive species cannot be obtained by hunting, scripted spawn, an
   unlisted dungeon or an imported package.
4. Runs on an older revision keep its pools; live policy still applies to them.
5. Authors need no JSON to build pools and encounters.
6. Dungeons without encounters behave, hash and export exactly as before.
7. Hunted captures are unchanged.

---

## 20. Worked examples

Slugs marked † are illustrative and do not exist in content. The others ship
today. `scrapheap_gauntlet` is an illustrative dungeon key.

### 20.1 Scrapheap Gauntlet — Wild Android Pool

```json
{
  "id": "sp_wild_androids",
  "name": "Scrapheap Gauntlet — Wild Androids",
  "entries": [
    { "id": "pe_konbini",  "weight": 40, "species": "konbini_android" },
    { "id": "pe_courier",  "weight": 40, "species": "courier_android" },
    { "id": "pe_enforcer", "weight": 25, "species": "enforcer_unit" },
    { "id": "pe_icehouse", "weight": 10, "species": "ice_house_android" },
    { "id": "pe_seraph",   "weight": 2,  "species": "scrapheap_seraph",
      "when": { "type": "flag", "flag": "generator_on" } },
    { "id": "pe_nothing",  "weight": 30, "nothing": true,
      "text": "Only rust and silence." }
  ]
}
```

`scrapheap_seraph`† is tagged `dungeon_exclusive` with
`dungeonAccess: [{ "dungeon": "scrapheap_gauntlet", "perPlayerLimit": 1 }]`.

| Entry | Rarity | Generator off (total 145) | Generator on (total 147) |
| --- | --- | --- | --- |
| Konbini Android | N | 27.6% | 27.2% |
| Courier Android | N | 27.6% | 27.2% |
| Enforcer Unit | R | 17.2% | 17.0% |
| Ice House Android | SR | 6.9% | 6.8% |
| Scrapheap Seraph† | exclusive | — | 1.4% |
| Nothing | | 20.7% | 20.4% |

Two rooms reference the pool. Each draws independently; with the default
`oncePerRun`, a species met in the first room is out of the second room's draw.
A player who already owns the Seraph finds `unavailable` when she is drawn.

```json
{ "type": "wild_encounter", "id": "act_wild_1",
  "source": { "kind": "pool", "poolId": "sp_wild_androids" },
  "intro": "Something moves between the crushed hulls.",
  "capture": { "maxAttempts": 3, "allowGuaranteedItems": true } }
```

Against the SR with a Silk Charm the chance is 0.22 × 1.5 = 33% per attempt,
before Buddy terms, exactly as in a hunt.

### 20.2 The Captive Guardian

The boss action sets a flag on victory; the next room holds the captive.

```json
{ "type": "set_flag", "id": "act_boss_down", "flag": "warden_defeated" }
```

```json
{ "type": "rescue", "id": "act_captive", "mode": "capture",
  "when": { "type": "flag", "flag": "warden_defeated" },
  "source": { "kind": "species", "species": "gauntlet_guardian" },
  "intro": "The cell door hangs open. She watches you, wary.",
  "capture": { "maxAttempts": 3, "allowGuaranteedItems": false },
  "results": {
    "rescued": { "text": "She takes your hand.",
                 "flags": [{ "flag": "guardian_freed", "value": true }] },
    "escaped": { "text": "She slips past you into the dark." }
  } }
```

`gauntlet_guardian`† is `dungeon_exclusive`, listed for `scrapheap_gauntlet`. If
the boss was not beaten the action is skipped by its condition and no selection
is made.

### 20.3 The Broken Android

An event requires a repair; only its success opens the rescue.

```json
{ "id": "ch_repair", "label": "Repair her",
  "items": [{ "item": "spare_actuator", "quantity": 1, "consume": true }],
  "check": { "type": "sp", "baseChanceBasisPoints": 6000 },
  "success": { "text": "Her eyes flicker on.",
               "effects": [{ "type": "set_flag", "flag": "android_repaired", "value": true }] },
  "failure": { "text": "The actuator burns out.", "tone": "bad" } }
```

```json
{ "type": "rescue", "id": "act_broken_android", "mode": "direct",
  "when": { "type": "flag", "flag": "android_repaired" },
  "source": { "kind": "species", "species": "broken_android" },
  "intro": "She stands, unsteady, and looks to you." }
```

`spare_actuator`† and `broken_android`† are illustrative. Publishing requires
`broken_android` to list this dungeon with `directRescue: true` and a
`perPlayerLimit`. A player at the limit sees the `unavailable` text instead. The
item is spent whether or not the check succeeds, as events already work.

### 20.4 Regional comparison

| Species | Tag | Region pools | `dungeonAccess` | Hunt | Scrapheap Gauntlet | Any other dungeon |
| --- | --- | --- | --- | --- | --- | --- |
| `cyber_security_android` (N) | `region_exclusive` | Base 80085 | none | Base 80085 only | Refused at publish | Refused |
| `scrapheap_seraph`† | `dungeon_exclusive` | none allowed | Scrapheap, limit 1 | Never | Allowed | Refused |
| `prototype_zero` (LR) | none | Waifu Valley, Assteroid Belt | none | Both regions | Allowed | Allowed |

---

## 21. Open product decisions requiring approval

Each has a recommendation; the design works with any listed option.

| # | Decision | Recommendation | Alternatives |
| --- | --- | --- | --- |
| 1 | Where exclusivity is defined | Species content: `dungeon_exclusive` tag and `dungeonAccess` | A Portal-managed policy table (no deploy to change policy; needs a hunt-side read and per-environment setup) |
| 2 | May any dungeon offer an untagged species? | Yes | Require listing for SSR and above; or for every species |
| 3 | May a dungeon offer a `region_exclusive` species? | Only when listed in `dungeonAccess` | Never; or freely when the dungeon's regions match |
| 4 | Default and maximum capture attempts | Default 3, maximum 3 | Default 1; or author-set up to 3 with default 1 |
| 5 | Leaving an encounter | Ends it for the run | An authored "she waits" mode through retreat |
| 6 | Which Buddy sets capture odds | The run's pinned Buddy | The live active Buddy (less code, allows swapping before an encounter) |
| 7 | Dungeon difficulty modifier on capture chance | None in Phase 4 | A bounded authored additive term via `otherModifiers` |
| 8 | Guaranteed-capture items in dungeons | Allowed, with a per-encounter off switch | Never allowed for restricted species |
| 9 | Per-player limits for exclusives | Supported centrally; values per species are content | A global default limit for every `dungeon_exclusive` species |
| 10 | Live policy against already-offered encounters | Strict: refused, `unavailable` | Honour an encounter already offered |
| 11 | XP and quests for dungeon captures | Same as hunted captures | Reduced or no quest credit |
| 12 | XP and quests for direct rescues | Capture-success XP and dex bonus; no capture-quest credit | Full parity; or none |
| 13 | Rarity warning threshold for pools | A configured UR+LR share (value needed) | No warning |
| 14 | Direct rescue cap per dungeon | 3 | Another number; or 1 |
| 15 | Rare-capture public announcement for dungeon captures | Same as hunts (SR and above) | Suppressed in dungeons |
| 16 | Region Pool source of truth | Database with draft and publish; JSON bootstraps | Portal edits JSON; or export-only |
| 17 | Compensation when policy makes an offered encounter unavailable | Manual, case by case | An automatic consolation reward |
