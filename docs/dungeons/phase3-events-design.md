# Dungeons Phase 3: Dungeon Events — architecture and design

Status: **Phase 3 runtime, Portal authoring and package v3 are implemented.**
The [creator guide](dungeon-events-guide.md) explains current authoring and
portability. The [C6 release assessment](phase3-release-readiness.md) records
verification, remaining gaps and staging requirements. The architecture findings,
task plan and §18–20 implementation notes below retain their historical context;
temporary export/import gates described there were removed by C5. Originally written against
`Delve` at `0dc68a4` (clean tree), after reading the engine, run service,
reward snapshot, validation, package, Discord and Portal editor code. Statements
marked *Verified* were checked in the code at that commit; everything else is a
proposal.

Dungeon Events are a dungeon-only system. They share nothing with World
Encounters: no engine, table, authoring flow, seed or migration. The only thing
taken from World Encounters is the *shape* of its SP check curve (§6.3).

Related: [dungeons.md](../dungeons.md) (current behaviour),
[phase2-rewards-design.md](phase2-rewards-design.md) (reward model this builds on).

---

## 1. Current architecture findings

### 1.1 What the engine already gives events

| Finding (*Verified*) | Where | Consequence for events |
| --- | --- | --- |
| `event`, `choice`, `objective`, `random_outcome` are reserved action types; a definition using one is refused with `unsupported_action_type` | `content/dungeonDefinition.ts` `RESERVED_ACTION_TYPES` | The extension point is a new member of `DungeonActionSchema`, a handler in `engine/step.ts` and validation rules. The engine's shape does not change |
| One input = one step; `expectedStep` mismatch is refused as `stale`; `act` holds `SELECT … FOR UPDATE` on the run row and commits state, effects and history together | `engine/step.ts`, `dungeonRunService.act` | Duplicate presses, Discord retries and racing interactions are already solved. Events add no new concurrency mechanism |
| Every random draw comes from a stream keyed by run seed + place (`rng.stream(...parts)`), never a running stream | `engine/seeds.ts` | A pool roll and a check roll keyed by room/action/choice are reproducible and independent of what was drawn before |
| Routing inside a room is forward-only; a completed room's sequence never runs again | `engine/routing.ts`, `enterRoom` | Event chains cannot loop. No recursion guard is needed |
| A `retreat` deletes the action record and sets `resumeAt`; `rewardClaims` is a separate map precisely so it survives that | `follow()` in `step.ts`, migration `0060` | A persisted event selection must also live outside the action record |
| Effects are data (`grant_rewards`, `settle_run`) applied by an adapter: live in the step transaction, or recorded by the sandbox | `engine/types.ts`, `engine/sandbox.ts` | Item consumption is a third effect. Live play and the sandbox keep running one copy of the rules |
| `claimRewards()` resolves a `DungeonRewardBundle` once per `run:<runId>:<roomId>:<actionId>` from the revision's pinned snapshot; loot streams are `('loot', roomId, actionId, …dropId)` | `step.ts`, `engine/lootResolver.ts` | An event action resolves at most one outcome per run, so it can reuse the claim key, the resolver and the snapshot unchanged |
| Run flags are booleans in `dungeon_runs.flags`; conditions are `flag`, `room_completed`, `all`, `any`, `not`; flags must be declared on the dungeon; `player` scope is declared-only | `engine/conditions.ts`, `dungeonValidation.ts` | Flags and conditions already express "a choice changes a later room". No new condition type is needed |
| The pinned fighter already stores `currentSp` and `level` | `dungeonFighter.ts` (`DungeonFighter`) | SP checks can read pinned values. `EngineFighter` (the engine's narrower view) lacks `currentSp` and needs it added as an optional field |
| HP is run state (`state.hp`), healed by `hpAfterRest` with one rounding rule (`shareOf`, toward zero) | `engine/rewards.ts` | Heal and damage are pure state changes with an existing rounding rule |
| `inventoryService.consumeItem` is a conditional decrement that throws `InsufficientItemsError` | `inventory/inventoryService.ts` | Consumption is race-safe without a lock: a concurrent spend makes the step fail and roll back |

### 1.2 Constraints that shape the design

1. **The content hash covers the parsed definition with defaults filled in**
   (`dungeonContentHash`, `package/dungeonPackage.ts`). A new field with a Zod
   default on the definition, a room or an existing action would change the hash
   of every existing dungeon, mark every publication "Dungeon changed" and fail
   every existing v1/v2 package. Phase 2 hit the same constraint (design §2.1).
   **Every field Phase 3 adds to an existing object is `.optional()` with no
   default.** Defaults are fine *inside* new objects.
2. **Seven places walk `room.actions[].rewards` by hand** (*Verified*):
   `dungeonDependencies`, `hasDungeonRewardBundles`,
   `resolveDungeonRewardDependencies`, `validateDungeonRewards`,
   `validateDungeonRewardWork`, the package reader's `referenced` set, and the
   importer's table-key rewrite for copied tables (`package/dungeonLootImport.ts`).
   Loot where-used reads `dungeonDependencies().lootTables`, so it follows the
   first. Event outcomes carry reward bundles in a different place. If any
   walker misses them, a table used only by an event is absent from the
   publication snapshot and the run fails at claim time, or an imported copy
   keeps pointing at the old key. One shared walker must replace all seven (§8.1).
3. **The engine is pure and may not reach inventory.**
   `engineArchitecture.test.ts` fails on any import that reaches a service or
   driver. Item ownership must be handed in as a fact and item consumption must
   leave as an effect.
4. **`dungeon_run_events.type` has a CHECK constraint** listing the event types,
   and the architecture test asserts the engine's list equals the schema's.
   New log types need a migration.
5. **The package envelope is strict and its version is chosen by content**: v1
   when there are no reward bundles, v2 when there are. The embedded `dungeon`
   is validated with the strict definition schema first. See §11.
6. **The Portal mirrors definition types by hand** (`portal/src/api/…Types.ts`)
   and edits the whole draft. A Portal that does not know `event` actions must
   not be allowed to drop them from a draft it saves (§14, task B8).

### 1.3 World Encounters review

Reviewed for utilities and lessons only. Two things are relevant:

- `worldEncounters/checkResolver.ts` holds two SP formulas. The current one is
  `chance = clamp(base + maxSpModifier × clamp((SP − 200) / 150, −1, 1) + …, 0.05, 0.95)`.
  The 200 / 150 constants were derived from the live SP model (base 90–190,
  level cap ×2.225) and are the right reference for dungeons too.
- Its lesson: author-set base chance with a *bounded* stat modifier keeps checks
  meaningful at every Buddy strength. The legacy 50%-centred model is not carried over.

Nothing else is reused. Affinity, race tags and the Buddy bonus terms of that
formula are not pinned on a dungeon fighter and are out of scope.

---

## 2. Scope and non-goals

### In scope (Phase 3)

- A new `event` room action with two selection modes: a specific event, or a weighted pool.
- A dungeon-local library of events and pools, stored inside the definition.
- Choices with run-flag and inventory requirements, optional item consumption, and an optional SP check.
- A small effect vocabulary: set/clear a run flag, heal, non-lethal damage, rewards through the Phase 2 bundle, consume an item.
- Persisted selection, deterministic rolls, idempotent resolution.
- Discord presentation, sandbox support, Portal authoring, validation, publication and packages.

### Non-goals

- Reusing or touching World Encounters (engine, tables, seeds, authoring, migrations).
- A scripting or expression language; variables; counters; non-boolean flags.
- A global event catalogue shared between dungeons.
- `player`-scoped (persistent) flags. They stay declared-only.
- Replacing the condition union with a "shared rules module" (the comment in
  `dungeonDefinition.ts` anticipated this for Phase 3; it is not needed and is not done).
- `choice`, `objective` and `random_outcome` as separate action types. `event`
  covers them; the names stay reserved.
- Inventory conditions on `when` or on connection locks (§5.2).
- Lethal event damage, flat HP amounts, losing at-risk currency as a penalty,
  checks on ATK/DEF, affinity or species advantages, an event starting a fight
  directly, an event moving the player through a connection directly. Each has
  a workaround with flags today (§7.4) and can be added later as one new effect.
- WaifuMon encounters, rescue, recruitment (Phase 4).

---

## 3. Schemas

New pure module `content/dungeonEvents.ts` (Zod only, plus `dungeonRewards.ts`
and the artwork/condition schemas). IDs use the existing `DungeonIdSchema`
(≤ 40 chars, no colons).

### 3.1 Where events live

```ts
// DungeonDefinitionSchema — both optional, no default, absent when unused
events?: DungeonEvent[]          // max 100
eventPools?: DungeonEventPool[]  // max 50

// new member of DungeonActionSchema
{ type: 'event', ...actionBase,
  source: { kind: 'event', eventId } | { kind: 'pool', poolId } }
```

An event is defined once per dungeon and referenced by id, so one event can sit
in a room directly and in any number of pools. Because events and pools are
part of the definition, they are covered by `contentHash`, frozen by publish,
and carried by `dungeon_runs.revision_id` with no extra pinning.

The `event` action keeps `id`, `label`, `when`, `next` and `outcomes` from
`actionBase`. `optional` must be false (`event_optional_unsupported`): walking
away is a choice the author writes, not a generic Decline button.

### 3.2 Event

```ts
DungeonEvent = {
  id,
  title: string(1..80),
  text: string(1..1500),               // the narrative
  artwork?: DungeonArtworkRef | null,  // shipped path or managed {category, contentHash}
  choices: DungeonEventChoice[]        // 1..5
}
```

### 3.3 Choice

```ts
DungeonEventChoice = {
  id,
  label: string(1..60),                // the Discord button
  description?: string(..200),         // one line under the narrative
  requires?: DungeonCondition,         // existing vocabulary, run state only
  items?: { item: slug, quantity: 1..99, consume: boolean }[],   // max 2
  unavailableText?: string(..120),     // shown when requirements are not met
  hideWhenUnavailable?: boolean,       // default false: shown disabled

  // exactly one of:
  outcome: DungeonEventOutcome                        // no check: always this
  // or
  check: { type: 'sp',
           baseChanceBasisPoints: 0..10000,
           maxSpModifierBasisPoints: 0..5000 (default 1500) },
  success: DungeonEventOutcome,
  failure: DungeonEventOutcome
}
```

"Guaranteed success" and "guaranteed failure" are both the no-check form: a
choice with one `outcome`, written as good or bad news.

### 3.4 Outcome

```ts
DungeonEventOutcome = {
  text: string(..800),                 // what happened
  tone?: 'good' | 'neutral' | 'bad',   // embed colour only; default neutral
  effects: DungeonEventEffect[],       // max 6
  rewards?: DungeonRewardBundle,       // the Phase 2 bundle, unchanged
  then?: { type: 'next' } | { type: 'room_complete' } | { type: 'retreat' }
       | { type: 'end_run', outcome: 'completed' | 'defeated' }
}

DungeonEventEffect =
  | { type: 'set_flag', flag: id, value: boolean }       // run scope only
  | { type: 'heal',   basisPoints: 1..10000 }            // share of max HP
  | { type: 'damage', basisPoints: 1..10000 }            // share of max HP, floor 1 HP
```

`then` is a room-independent subset of `ActionDestination` (no `action`, no
`leave`), so an event stays reusable across rooms. When `then` is absent the
event action's own routing for `resolved` applies, by the existing precedence.

Reserved effect names (`lose_currency`, `start_combat`, `move`, `set_player_flag`,
`trigger_event`) are refused with `unsupported_event_effect`, naming them as
later work, the way reserved action types are.

### 3.5 Pool

```ts
DungeonEventPool = {
  id,
  name: string(1..80),                 // authoring label only
  entries: (                           // 1..20
    | { id, weight: 1..1_000_000, eventId, when?: DungeonCondition, oncePerRun: boolean (default true) }
    | { id, weight: 1..1_000_000, nothing: true, when?: DungeonCondition, text?: string(..200) }
  )[]
}
```

Strict alternatives enforce exactly one of an event and an explicit Nothing,
the same pattern as `DungeonLootPoolEntrySchema`.

### 3.6 Action outcomes

`ACTION_OUTCOMES.event = ['resolved', 'nothing']`, `SUCCESS_OUTCOME.event =
'resolved'`, no failure outcomes. A failed check is still a `completed` action
with outcome `resolved`: the event ran. What the check did is in the action detail.

---

## 4. Run state and persistence

### 4.1 Engine state

```ts
// DungeonRunState — optional so historical serialised states still read
events?: Record<string /* `${roomId}:${actionId}` */, DungeonEventInstance>

DungeonEventInstance = {
  eventId: string | null,              // null: the pool rolled Nothing
  status: 'offered' | 'resolved' | 'nothing',
  selectedStep: number,
  pool?: { poolId, entryId: string | null,       // null: nothing was eligible
           eligible: string[], totalWeight: number, roll: number },
  resolution?: { choiceId, branch: 'outcome' | 'success' | 'failure', step: number,
                 check?: { sp: number, chanceBasisPoints: number, roll: number } }
}
```

The instance holds ids and numbers only. Title, text, choices and outcomes are
always read from the run's pinned revision.

The cursor does not change. `cursor.actionId` already names the event action;
the instance is found by `roomId:actionId`.

Other additions, all additive:

- `DungeonInput`: `{ type: 'choose', choiceId }`.
- `DungeonRefusal`: `choice_required` (an `advance` on an event), `choice_unknown`, `choice_unavailable`.
- `DungeonEffect`: `{ type: 'consume_items', key: 'run:<runKey>:<roomId>:<actionId>:consume', roomId, actionId, items: { item, quantity }[] }` with a matching receipt.
- `DungeonActionDetail` / `DungeonRecentEntry`: an `event` kind (event id, choice id, branch, check numbers, flags set, HP before/after, `walkedAway`) and an `event_nothing` kind.
- `DungeonEngineContext.inventory?: Readonly<Record<string, number>>` (item slug → owned quantity).
- `EngineFighter.currentSp?: number`.
- `DungeonActionView.event`: title, text, artwork ref and per-choice `{ id, label, description, available, unavailableText, chanceBasisPoints | null, consumes }`. Hidden unavailable choices are omitted.
- Log types `event_selected` and `items_consumed`. Resolution reuses `action_completed`.

### 4.2 Database

One migration (§12): `dungeon_runs.event_states jsonb not null default '{}'`,
and two values added to `dungeon_run_events_type_check`. Nothing changes on
`dungeon_definitions`, `dungeon_revisions` or `dungeon_content_events`: event
content is inside the existing definition documents.

`event_states` is a separate column, like `reward_claims`, because a retreat
deletes the action record and must not delete the selection.

---

## 5. Execution state machine

### 5.1 Lifecycle

```
            sequence reaches the event action (in the step that entered the room)
                                   │
                     action.when false ──► condition_skipped (no instance, no roll)
                                   │ true
                     instance exists? ──yes──► reuse it (never re-select)
                                   │ no
        source = event ─► instance {eventId, offered}
        source = pool  ─► roll (§6.1) ─► {eventId, offered}  or  {null, nothing}
                                   │
              nothing ─► action completed, outcome `nothing`, sequence carries on
              offered ─► cursor stops on the action; player sees narrative + choices
                                   │  input `choose <choiceId>` at expectedStep
                    requirements re-checked (flags from state, items from ctx.inventory)
                                   │ met                         │ not met
                    check rolled if any (§6.3)            refused `choice_unavailable`,
                                   │                      nothing changes
                 branch outcome chosen
                                   │
        then = retreat ─► "walked away": no effects, instance stays `offered`,
                          existing retreat (resumeAt = this action)
        otherwise      ─► consume_items effect, flags, HP, claimRewards(),
                          instance `resolved`, action `completed`/`resolved`,
                          routing: outcome.then, else the action's routing
```

Selection happens inside `runSequence`, in the same step that moved the player
into the room (or `startDungeonRun` for the entrance), so the selection and the
move commit together. There is no moment at which the player is in the room and
the event is not yet chosen.

### 5.2 Rules

- **An event resolves at most once per run.** If the sequence returns to a
  `resolved` or `nothing` event action (only possible through a later retreat
  that resumes above it), the engine follows the action's routing without
  re-applying anything, exactly as an already-claimed Treasure does.
- **Walking away is the only way to leave an event open.** An outcome with
  `then: retreat` must have no effects, no rewards, no check and no consumed
  item (validated). The room stays unfinished and the same event is offered on
  return. With nowhere to go back to (`cameFrom` is null: a first arrival in
  the entrance) a walk-away choice is shown unavailable (`no_way_back`) and
  refused, so an entrance event must offer another always-available choice
  that carries on, finishes the room or ends the run (`event_entrance_no_exit`).
- **An event action's own routing may not turn back.** Only a walk-away
  outcome retreats. A resolved or empty event never runs again, so routing
  `resolved` or `nothing` to `retreat` would bar the room for good
  (`event_route_retreat`).
- **Every event has a choice that is always available** (no `requires`, no
  `items`). Validation enforces it, so an event can never trap a player whose
  flags or inventory changed.
- **Requirements are evaluated twice**: for display, and again when the choice
  is made. The second one is authoritative.
- **Inventory is not part of the condition language.** `when` and connection
  `requires` stay pure functions of run state. Live inventory changes outside
  the run, so a path lock that read it could open or close without a step. An
  item matters only at the moment a choice is made; if it should matter later,
  the outcome sets a flag (`vault_opened`).
- **Order within a resolving step:** emit `consume_items` → set flags → HP →
  claim rewards → record and log → route. The adapter applies effects in that
  order, so the cheapest failure (an item no longer owned) happens first.

### 5.3 Situations the brief asks about

| Situation | Behaviour |
| --- | --- |
| Discord retry, duplicate press | The second arrival waits on the run-row lock, then carries a step number that is no longer current: refused `stale`, screen repainted from stored state, which shows the outcome in `recent` |
| Two interactions racing with different choices | One wins the lock and resolves; the other is `stale` |
| Disconnect, resume | `dg|run|<id>` repaints from the row. An `offered` event shows the same event and choices |
| Leaving and returning | Completed room: its sequence does not run again. Walked-away room: the stored instance is offered again. No re-roll in either case |
| Refreshing Discord, re-opening the menu | Read-only. Selection is stored; nothing is drawn on read |
| Once-per-run events | An event id present in any instance of the run is ineligible for pool entries marked `oncePerRun` (§6.1) |
| Expired or stale buttons | Custom ids carry the step. An old button is refused `stale`. A choice id that no longer exists in the pinned revision cannot occur (revisions are immutable) but is refused `choice_unknown` |
| Active combat | The cursor is on exactly one action. `choose` on a non-event action is refused `not_available`; `advance` on an event is refused `choice_required`. An event cannot interrupt a fight between waves |
| Retreat | Only through a walk-away outcome; existing retreat semantics |
| Abandon | Always allowed. Settles as today. An offered event is simply never resolved |
| Extraction | Requires `cursor.actionId == null`, so it is not offered during an event |
| Completion / defeat from an outcome | `then: end_run` settles in the same step, after the outcome's rewards were claimed, so its at-risk currency is included |
| Published-revision pinning | Instance stores ids only; all content comes from `revision_id`. Republishing or editing the draft never changes a run in progress |

---

## 6. Deterministic selection and check rules

Streams use the existing `rng.stream(...)` and the frozen salt
`waifumon.dungeon.engine.v1`. The `event` prefix does not collide with
`combat`, `loot`, `reward` or the wave-enemy streams.

### 6.1 Pool selection

1. `seen` = every non-null `eventId` in `state.events`.
2. `eligible` = entries in authored order where `when` holds, and the entry is
   Nothing, or is not `oncePerRun`, or its `eventId` is not in `seen`.
3. No eligible entry → instance `{ eventId: null, status: 'nothing', pool.entryId: null }`.
4. Otherwise `roll = stream('event', roomId, actionId, 'pool').intInclusive(0, totalWeight − 1)`
   and a cumulative walk over `eligible` in authored order.

The eligible ids, total weight and roll are stored on the instance and logged
in `event_selected`, so a selection can be audited and replayed.

A specific event attached directly to a room ignores `oncePerRun` (it is the
author's explicit placement) but does add its id to `seen`.

### 6.2 Author-facing probabilities

With every entry eligible, an entry's probability is `weight / Σ weight`, shown
as a percentage and never rounded to 0% for a positive weight (the Phase 2
rule). Conditional and once-per-run entries make the real odds depend on run
state, so the Portal shows the base odds plus a scenario preview (§9.4). One
pure function, `analyseEventPool(pool, facts, seen)`, is the only place odds
are computed; the engine's selection uses the same eligibility function.

### 6.3 SP checks

**Recommendation: checks read the participating Buddy's pinned
`fighter.currentSp`.** Not live stats, not equipment-derived ATK/DEF/HP, and no
new dedicated "event score".

- The dungeon architecture freezes Buddy stats and gear at run start. Reading
  live SP would let a Buddy swap or level-up mid-run change an outcome, and
  would make the sandbox disagree with live play.
- `currentSp` is already on every pinned fighter and already folds in level.
- ATK/DEF come from equipment and have no established neutral reference;
  checks on them are deferred until someone needs one.
- A separate score would be a second number authors and players must learn.

Formula, in integer basis points, same curve as the World Encounter new model:

```
spTerm   = trunc(maxSpModifierBasisPoints × clamp(currentSp − 200, −150, 150) / 150)
chanceBp = clamp(baseChanceBasisPoints + spTerm, 500, 9500)
roll     = stream('event', roomId, actionId, 'check', choiceId).intInclusive(0, 9999)
success  = roll < chanceBp
```

- A check is never certain (5%–95%). Certainty is the no-check form.
- A fighter without `currentSp` (not expected: every run requires a Buddy)
  takes the full negative modifier.
- The neutral SP (200) and spread (150) are declared in a dungeon-owned module
  `engine/eventChecks.ts`. A unit test asserts they equal the constants exported
  by `worldEncounters/checkResolver.ts`, so the two systems stay calibrated
  without importing each other at run time and without editing World Encounters.
- The roll is keyed by choice, so it does not depend on which choices were
  looked at first. A player cannot retry: the event resolves once.
- `sp`, `chanceBp` and `roll` are stored on the instance and in the log.

---

## 7. Idempotency, transactions and rewards

### 7.1 Transaction boundary

Unchanged: `dungeonRunService.act` is one transaction.

1. `SELECT … FOR UPDATE` on the run row, scoped by player.
2. Load the pinned revision and verify its reward snapshot (existing).
3. **New:** if the cursor is on an `offered` event, read the player's quantities
   of the item slugs that event's choices name, into `ctx.inventory`. A plain
   read; no lock.
4. `stepDungeon` (refusals return here; nothing is written).
5. Apply effects in order: `consume_items`, `grant_rewards`, `settle_run`.
6. Write the run row (including `event_states`) and append history.

`start` gets step 3 too, because the entrance room may open on an event.

### 7.2 Idempotency rules

| Thing | Made once by |
| --- | --- |
| Event selection | `state.events[key]` exists → never re-selected. Written in the transaction of the step that entered the room |
| Event resolution | Row lock + `expectedStep` + instance `status` |
| Rewards | Existing claim key `run:<runId>:<roomId>:<actionId>` in `rewardClaims`; equipment grant keys derive from it as today |
| Item consumption | The step transaction and step check. `consumeItem` is a conditional decrement, not a keyed ledger entry, so its idempotency is the transaction's, the same guarantee legacy WaifuBux and item grants rely on today |
| Settlement | Existing `dungeon_run:v1:<runId>:settlement` |

### 7.3 Failure and rollback

Any throw inside the transaction rolls back everything together: the item
decrement, the check result, the instance status, flags, HP, the reward claim,
every grant, the cursor and the history rows. Because every roll is a function
of the seed and the place, the retried interaction reproduces the same check
result and the same reward plan.

| Failure | Result |
| --- | --- |
| Item spent elsewhere between read and consume | `InsufficientItemsError` → new `DungeonEventItemUnavailableError`; full rollback; the event repaints with that choice now unavailable |
| Required item deleted from the catalogue after publish | Requirement is unmet; the choice shows as unavailable. Not an error: the always-available choice still works |
| Reward grant fails (missing item, capped item, missing gear) | Existing `DungeonRewardGrantError` path: full rollback, logged with claim key and dependency; the same press works once the dependency is restored |
| Pinned snapshot invalid | Existing `reward_snapshot` failure at load, before anything is rolled |

### 7.4 Effects: now and later

| Effect | Phase 3 | Notes |
| --- | --- | --- |
| Set or clear a run flag | Yes | Flag must be declared, run scope |
| Rewards | Yes | `rewards` bundle on the outcome, Phase 2 semantics |
| Consume an inventory item | Yes | Declared on the choice requirement (`consume: true`); spent when the choice is made, whatever the check then does |
| Heal | Yes | `hpAfterRest` |
| Damage | Yes, non-lethal | `hp = max(1, hp − shareOf(maxHp, bp))`. An author who wants a death routes the outcome `then: end_run defeated` |
| Enable/disable a later path or activity | Yes, with no new mechanism | Set a flag; the connection's `requires` or the activity's `when` reads it |
| Trigger a subsequent event | Yes, with no new mechanism | Set a flag; a later `event` action (same room, further down, or another room) has `when` on it. Forward-only routing makes loops impossible |
| Start a fight from an event | Workaround | Set a flag; a later `combat` action has `when` on it |
| Lethal damage, flat HP, lose at-risk currency, direct move, direct fight, player flags | Deferred | Each is one new effect type later |

### 7.5 Reward integration

There is one reward engine and it does not change.

- An outcome's `rewards` is a `DungeonRewardBundleSchema` value: guaranteed,
  chances and loot-table references, with the same bounds.
- Resolving it calls the existing `claimRewards(w, room, action, bundle)`. The
  activity identity stays `{ roomId, actionId }`, so the loot streams, drop ids,
  equipment `rollSeed`s and grant keys keep their Phase 2 form. Only one outcome
  of one event ever resolves for an action in a run, so the identity is unique.
- At-risk Shards and WaifuBux go onto the run and follow the dungeon's defeat
  and abandon retention. Essence, items, gear and affection are secured in the
  step transaction, to the pinned Buddy with pinned bonuses.
- `DUNGEON_LOOT_RESOLVER_VERSION`, the snapshot format and the snapshot hash
  function are untouched. The snapshot simply contains the tables, selectors
  and items that event bundles reach, because the shared walker reports them.
- A dungeon whose only reward bundles are inside events gets a reward snapshot
  and a `gameplayHash` exactly as if they were on a Treasure.

---

## 8. Validation and publication

### 8.1 The shared reward-site walker (prerequisite)

New pure module `content/dungeonRewardSites.ts`. It reads the definition
structurally and imports no schema, so `dungeonDefinition.ts` and
`dungeonRewards.ts` can both use it without an import cycle:

```ts
dungeonRewardSites(definition, { scope?: 'reachable' | 'all' }):
  { path: string, bundle: DungeonRewardBundle,
    owner: { kind: 'action', roomIndex, actionIndex, roomId, actionId }
         | { kind: 'event', eventIndex, choiceIndex, eventId, choiceId, branch } }[]
dungeonRewardActivities(definition)   // per room action: the bundles it could claim
mapDungeonRewardBundles(definition, fn)
dungeonRequiredItems(definition)      // slugs reachable events' choices need
```

**Reachable, not merely written.** An event can sit in the library unused.
Only events an `event` action can present, directly or through a pool it draws
from, are reward sites by default, so an unused event's loot is not a
publication dependency and cannot block publishing. Its structure is still
validated. `scope: 'all'` and `mapDungeonRewardBundles` cover the whole
library, so an import copy rewrites every reference.

All seven walkers in §1.2 move to it. The importer's rewrite needs the write
form, `mapDungeonRewardBundles(definition, fn)`, built on the same traversal.
For a definition without events its
output is exactly the current traversal, in the same order, and golden tests
pin that the content hash, snapshot hash and v1/v2 package bytes of existing
fixtures do not move.

Work bounds: an `event` action counts as the worst case over every outcome of
every event it can present (its one event, or every event in its pool), against
the existing per-activity limits. The dungeon-wide at-risk currency ceiling
adds that worst case once per event action.

### 8.2 Issue codes

New pure module `validation/dungeonEventValidation.ts`, called from
`validateDungeonDefinition`. Codes are stable, as today.

| Concern | Code | Severity |
| --- | --- | --- |
| Missing events | `event_missing` (action or pool entry names an unknown event), `event_pool_missing` | error |
| Identity | `duplicate_event_id`, `duplicate_event_pool_id`, `duplicate_choice_id`, `duplicate_pool_entry_id` | error |
| Unused content | `event_unused`, `event_pool_unused` | warning |
| Invalid choice targets | `event_optional_unsupported`, `event_route_retreat` (the action's own routing turns back) | error |
| Entrance safety | `event_entrance_no_exit`: every event an entrance action can present, directly or through its pool, needs an always-available choice that does not walk away | error |
| Walk-away rules | `event_retreat_with_effects`, `event_check_retreat` | error |
| Permanently unavailable choices | `event_no_open_choice` (no always-available choice) | error |
| | `flag_never_set` (existing; a `requires` reads a flag nothing sets), `event_choice_contradiction` (a `requires` that is `x and not x` at top level) | warning |
| Missing inventory items | `event_item_missing` | error |
| | `event_item_disabled`, `event_item_duplicate` (same item twice on one choice) | warning / error |
| Invalid reward references | existing `reward_*` codes, with paths under `events[i].choices[j].…rewards` | as today |
| Unsupported effects | `unsupported_event_effect` | error |
| Invalid check parameters | `schema` (bounds); `event_check_flat` (modifier 0 and base outside 5–95%: the check is a constant) | error / warning |
| Pool weights and Nothing | `event_pool_duplicate_event` (give it one entry with the combined weight), `event_pool_all_nothing`, `duplicate_pool_entry_id` | error |
| | `event_pool_may_be_empty` (every entry is conditional or once-per-run, so the roll can find nothing eligible) | warning |
| Chains and loops | `transition_backward` (existing). No event invokes another, so no further rule is needed | — |
| Flag references | `flag_undeclared`, `flag_scope_mismatch`, `flag_scope_unsupported` (existing), applied to effects, choice `requires` and pool `when`. `flag_never_set` and `flag_unused` count event effects as setters | as today |
| Excessive work | schema ceilings (100 events, 50 pools, 20 entries, 5 choices, 6 effects, 2 items); existing `reward_too_many_*` per event action; `condition_too_deep` | error |
| Invalid artwork | `artwork_missing` (existing), via `dungeonDependencies().artwork` | warning |
| Routing | `ACTION_OUTCOMES.event` feeds the existing `unknown_outcome`, `action_unreachable` and ending analysis; an outcome `then: end_run completed` counts as an ending | as today |

`flagsSet` in the validator includes flags set by outcomes of events that
are reachable from some room, or every event-driven lock would warn.

Catalogue checks (required items, reward dependencies, artwork) apply to
reachable events only. Structural checks (ids, flags, the always-available
choice, walk-away rules, schema) apply to every event, used or not.

### 8.3 Publication and dependency drift

| Content | Frozen at | Drift |
| --- | --- | --- |
| Event text, choices, checks, effects, pools, weights | Publish, inside the revision's definition | None possible. A draft edit shows as "Dungeon changed" |
| Loot tables and gear candidates behind event rewards | Publish, in `reward_snapshot` | Existing "Loot changed" detection through `gameplayHash`, with no new code once the walker is shared |
| Reward items | Publish (metadata), re-checked at grant | Existing Reward Health |
| Required (consumed) items | Not frozen: the slug is the identity | Publish and rollback validate existence. If the item later disappears the choice is unavailable, never broken. Reward Health gains an informational line, not a "broken" status |
| Event artwork | Run start (`dependency_snapshot.artwork`) | Existing managed-artwork lookup and Replace behaviour; asset delete guard covers it through the dependency walker |

Publish, rollback and import all validate through the same function, so a
published revision always contains every event, choice and pool its actions
name. A run replays an event decision from `revision_id` + `seed` +
`event_states` alone.

---

## 9. Portal authoring

Everything lives inside the existing Dungeon Editor
(`portal/src/features/adminDungeons/`). No new page, route or API resource:
events are part of the draft the editor already loads, validates and saves.

### 9.1 Attaching an event to a room

Room inspector gains an **Event** row with three options:

- **No event**
- **A specific event** → pick or create
- **A random event** → pick or create a pool

Choosing one inserts a single `event` activity into the room's sequence (before
a trailing `leave`, otherwise last); "No event" removes it after confirmation.
The activity appears as a normal `ActivityCard`, so it can be reordered, given a
"only when…" rule and routed like any other activity. A room that already holds
several event activities shows "2 events, see activities" instead of the selector.
An **Event** room template is added to `dungeonRoomTemplates.ts`.

### 9.2 The event editor

Opens as a side sheet over the editor, the way `LootTableSheet` does, but
simpler: it edits the local draft, so there is no separate save, revision or
stale handling, and the page's existing dirty guard covers it.

1. **Story**: title, text, picture (`DungeonBackgroundField` / artwork picker).
2. **Choices** (cards, reorder with `moveEntry`, up to 5). Each card:
   - *Button text* and an optional one-line description.
   - *Who can pick this*: Anyone · Only when… (`DungeonConditionEditor`) · Needs an item (`ItemPicker`, quantity, "uses it up").
   - *What happens*: Always the same · Skill check. The check control is one
     slider, "Chance for an average Buddy", and shows the resulting range
     ("weakest 40% · average 55% · strongest 70%"). "How much Buddy strength
     matters" sits under Advanced.
   - One result panel (or Success and Failure panels): result text, mood,
     *Remember* (flag picker that creates the entry inline, as "Remember
     something" does today), *Health* (none / heal % / hurt %), *Rewards*
     (the existing `GuaranteedSection`, `ChanceSection`, `LootTablePicker`,
     `LootOdds`, `TestRollDialog`), *Then* (Carry on · Finish the room · Turn
     back · End the run).
3. **Starting points**: "Locked door", "Risky shortcut", "Shrine" presets that
   pre-fill choices, so nobody starts from an empty form.

### 9.3 The events list

A dungeon-level **Events** panel in the no-selection settings area (beside run
flags and currency risk): every event and pool with where it is used, plus
duplicate and delete. Delete is blocked while a room or pool references it.

### 9.4 The pool editor

Same side sheet. A table of entries: event (or **Nothing**), share, computed
percentage, "only if…", "once per run". Under it:

- **Chances**: the base odds, each as a percentage and "about 1 in N".
- **Try a situation**: tick which remembered things are true and which events
  were already seen; the odds recompute. This uses `analyseEventPool` on the
  server through the existing `POST /admin/dungeons/validate` response (a new
  `eventPools` member), so the Portal does no eligibility logic of its own.
  The one local sum is share ÷ total, as in the loot editor.

### 9.5 Preview and validation

- **Discord preview** in the event sheet: the embed and buttons as a player
  will see them, including disabled choices and the check percentage, using the
  presenter's truncation limits.
- **Play it**: the existing `POST /admin/dungeons/sandbox` accepts the `choose`
  input and an assumed inventory, so an author can walk a draft through the
  real engine. No grants, no writes.
- Issues appear in the existing checklist. `friendlyIssue` learns the
  `events[…]` and `eventPools[…]` paths, so "Show me" opens the right sheet and
  field, and messages name the event and choice rather than ids.

### 9.6 Keeping it approachable

- No jargon: "remembers" not flag, "skill check" not SP check, percentages not
  basis points, "share" not weight. Ids only in hover titles, as today.
- Every new thing starts valid: a new event has one choice ("Continue") that is
  always available.
- The always-available rule is explained where it bites ("Players need one
  choice they can always pick").
- Requirements, checks and Then are collapsed until used.
- A pool with one entry offers "attach this event directly instead".

---

## 10. Discord presentation

- `dg|ev|<runId>|<step>|<choiceId>` → `{ type: 'choose', choiceId, expectedStep }`.
  Worst case stays under Discord's 100 characters (choice ids ≤ 40).
- The event screen: embed title = event title, description = narrative, one
  line per choice with a description, requirement or consumed item, and the
  check chance. One button per choice, in one row of at most five; an
  unavailable choice is a disabled button unless hidden. Abandon and Menu keep
  their row.
- Picture: the event's artwork shown alone, as uploaded (the rule a full enemy
  artwork follows). Without one: room background → dungeon background → dungeon
  artwork → text only. No Buddy compositing in Phase 3.
- The result: `recentBlock` renders the `event` entry (choice, check line when
  there was one, result text, flags are not shown, HP change) above the existing
  reward lines, which read committed receipts as today. The next pending thing
  follows on the same screen, as for every other action.
- Refusals get one-line notices through `actionNotice`: stale, choice no longer
  available, item no longer owned.

---

## 11. Package compatibility

*Verified* behaviour of the current format with event content:

- The reader validates `dungeon` with the strict definition schema before the
  envelope. An existing build given any package containing an `event` action or
  an `events` member refuses it cleanly (`unsupported_action_type` /
  `schema`). **No new version is needed for old builds to be safe.**
- The version is chosen by content. Without a change, an event dungeon with no
  reward bundles would export as **v1** and one with bundles as **v2**.
- v1 and v2 importers differ: a v1 replace keeps the target enabled and
  published; v2 always leaves a disabled, unpublished draft. The v1 importer
  also rejects non-empty `items` manifests, so required items cannot be listed
  in a v1 package.
- v2 requires a reward snapshot and at least one bundle; `dependencies.items`
  must equal the snapshot's items exactly, so required (consumed) items cannot
  be added there either.

**Recommendation: schema version 3, emitted only for definitions that use
events.** It is the v2 envelope with three differences:

1. `dependencies.requiredItems: string[]` (sorted slugs of item requirements), recomputed and compared on read like every other manifest.
2. `rewardSnapshot` and `rewardSnapshotHash` are null when the dungeon has no reward bundles anywhere.
3. `bundled.dungeonLootTables` may be empty.

Import semantics are v2's: always a disabled, unpublished draft; loot-table
decisions as today; required items are checked against the target and reported,
never created.

Why a version rather than a quiet extension: the strict envelope cannot carry
a new manifest member without a schema change anyway; "v1" would otherwise mean
two shapes and an event dungeon would silently get v1's looser replace
semantics; and an old build reports "version 3 is not supported" instead of a
content error deep in the file.

Guarantees:

- A dungeon without events exports byte-identically to today (v1 or v2). The
  v1 golden fixture and v2 fixtures are the regression tests.
- v1 and v2 packages import exactly as today.
- A v1 or v2 envelope whose dungeon contains events is refused on import, the
  way a v1 envelope with Phase 2 bundles is refused today.
- `contentHash` stays the hash of the definition alone and now covers events and pools.
- Event artwork appears in `assets` through the dependency walker; bytes are
  not carried, as today.

Until package v3 ships (P3C), export of an event dungeon is refused with a
clear message (P3B task B7); it must not fall through to a v1 file.

---

## 12. Database migration requirements

One migration, `0065_dungeon_events` (journal index 65, `when`
`1821391200000`, after 0064's `1821304800000`). Written in P3B2.

1. `ALTER TABLE dungeon_runs ADD COLUMN event_states jsonb NOT NULL DEFAULT '{}'::jsonb`
   — metadata-only on current Postgres; existing and active runs read `{}` and
   their rows are not rewritten (tested: same row version before and after).
2. `dungeon_run_events_type_check` is dropped and re-added with `event_selected`
   and `items_consumed`. Drizzle applies a migration inside one transaction, so
   a `NOT VALID` / `VALIDATE` split would not shorten the lock; the re-add scans
   `dungeon_run_events` once under the table lock. On a large history table,
   apply it in a quiet period.

No backfill. No change to definitions, revisions, loot tables, inventory or any
World Encounter table. No seed data: Phase 3 ships no event content except the
example package under `content/dungeons/examples/`.

Rollout order, as Phase 2: database → backend/bot → Portal.

---

## 13. Compatibility risks

| Risk | Mitigation |
| --- | --- |
| A new default changes every content hash | The optional-no-default rule; golden hash tests on `service_tunnels` and the v1/v2 fixtures in the first task |
| A reward walker misses event bundles | One shared walker; a test that a table referenced only by an event is in the snapshot, the manifest, where-used and the work bound |
| Backend rolled back after an event dungeon is published | The old build cannot parse the revision, so runs on it are unreadable until roll-forward (not lost: state is in the row). Publish event dungeons only once the release is settled; note it in release readiness |
| Portal without event support saves a draft and drops events | P3B ships Portal type mirrors and a read-only event card; a round-trip test proves events survive a save |
| Existing published dungeons and active runs | No definition changes; `event_states` defaults to `{}`; `state.events` is optional; no existing stream, claim key or resolver version changes |
| Legacy room activities, combat, loot | Their handlers are not edited. `runSequence` gains one branch for `event`; `actionAwaitsInput` returns true for it |
| Equipment and affinity | Gear grants go through the unchanged Phase 2 path. Checks read pinned SP only; affinity is not consulted |
| World Encounters | Not imported at run time, not edited. One test reads two of its exported constants |
| Engine purity | `content/dungeonEvents.ts`, `engine/events.ts`, `engine/eventChecks.ts`, `validation/dungeonEventValidation.ts` import only pure modules. Baseline issue #0025 (4 known offenders in the importer) is unchanged and must not grow |
| Inventory read without a lock | The conditional decrement is the guard; a lost race is a clean rollback |
| Embed size with long narratives | Schema limits (1500 + 5 × 200) fit the existing `fitEmbed` budget; presenter tests at the limits |
| Reward Health reporting a missing required item as broken loot | It is a separate informational line; status values keep their meaning |

---

## 14. Implementation tasks

Two passes. Each task is independently testable.

### P3B — Runtime and playable events

| # | Task | Notes |
| --- | --- | --- |
| B1 | Schemas: `content/dungeonEvents.ts`; `event` action; optional `events` / `eventPools`; move `event` out of `RESERVED_ACTION_TYPES`; reserved effect names | Golden hashes prove existing content is unchanged |
| B2 | `dungeonRewardSites` / `mapDungeonRewardBundles` and conversion of the seven walkers; `dungeonDependencies` gains `requiredItems` and event artwork | Pure refactor; byte-identical outputs for event-free content |
| B3 | `validation/dungeonEventValidation.ts` and the routing-table entries | §8.2 |
| B4 | Engine: `engine/events.ts` (selection, availability, resolve), `engine/eventChecks.ts`, `choose` input, refusals, state/recent/detail, view; sandbox port for `consume_items` and assumed inventory | No database |
| B5 | Migration `0065`; run service: `event_states`, inventory facts, `consume_items` adapter and receipt, new log types, error mapping | §7 |
| B6 | Discord: `dg|ev`, event screen, result block, notices, artwork | §10 |
| B7 | Publication integration: snapshot/gameplay hash through the walker, Reward Health line, loot where-used, artwork delete guard, **export refusal for event dungeons** | §8.3, §11 |
| B8 | Portal tolerance: type mirror, read-only event activity card, save round-trip test; example dungeon with the three worked examples; `dungeons.md` update | Authoring in P3B is JSON through the existing draft API |

If P3B is too large for one pass, cut **after B4**: B1–B4 are pure, need no
migration and change nothing a player can reach (no published dungeon can
contain events until the validator accepts them, which can be held behind the
last task of the cut). B5–B8 then add persistence, Discord and publication.

### P3C — Portal authoring, polish and integration

| # | Task | Notes |
| --- | --- | --- |
| C1 | Room Event selector, event activity card, Event room template, Events panel | §9.1, §9.3 |
| C2 | Event editor sheet: story, choices, requirements, check control, result panels with the reused reward sections | §9.2 |
| C3 | Pool editor, `analyseEventPool` on `/validate`, scenario preview | §9.4 |
| C4 | Discord preview, sandbox "Play it", `friendlyIssue` paths and navigation | §9.5 |
| C5 | Package v3: build, read, importer plan/apply, Portal import review for required items | §11 |
| C6 | Creator guide, release-readiness checklist, integrated lifecycle test (two databases, as T18) | |

If P3C is too large, cut **after C4**: authoring is complete and usable inside
one environment; C5–C6 add portability and release work.

### Complexity

Relative to Phase 2 (T1–T18): P3B is about the size of Phase 2's model and
execution groups together, with less risk because no new resolver, catalogue or
settlement rule is introduced; the delicate parts are B2 (hash-neutral
refactor) and B5 (one more effect in the transaction). P3C is about the size
of Phase 2's authoring group plus T16–T17 for the package; C2 is the largest
single task. Both passes are large but neither needs new infrastructure.

---

## 15. Test strategy and acceptance criteria

### Unit (pure)

- Golden: content hash of `service_tunnels`, v1 fixture bytes, v2 fixture hashes unchanged after B1 and B2.
- Schema: exactly-one-of outcome/check; Nothing/event entry alternatives; bounds; reserved effects.
- Selection: same seed and state → same entry; distribution over 10,000 seeds matches weights; `when` and once-per-run filtering; empty eligible set → Nothing; an existing instance is never re-selected.
- Checks: chance at SP 50 / 200 / 350 and the clamps; determinism per choice; constants equal World Encounters'.
- Resolution: flags, heal, damage floor at 1 HP, rewards claimed once, `then` precedence over action routing, walk-away leaves the instance offered, re-reaching a resolved event applies nothing.
- Refusals: stale, `choice_required`, `choice_unknown`, `choice_unavailable`, `choose` during combat.
- Validation: one case per code in §8.2.
- Walker: an event-only loot table reaches snapshot, manifest, where-used and work bounds, and is rewritten by an import copy.
- Architecture test still reports only the four baseline offenders.

### Integration (Postgres)

- Start in an entrance that opens on a pool: selection stored in the start transaction.
- Two concurrent `choose` calls with different choices: one applied, one stale; one consumption, one claim.
- Replay of the same interaction after commit: stale; inventory, wallet and gear unchanged.
- Injected failure in the final reward grant: item decrement, flags, HP, instance, claim and history all roll back; the retry yields the identical check roll and reward plan.
- Item spent between read and consume: clean rollback and the choice shows unavailable.
- Walk away, re-enter: same event, no new `event_selected` row.
- Republish while a run stands on an offered event: the run still shows and resolves the old event.
- Abandon and `then: end_run` from an event settle at-risk currency by the existing rules.
- Migration: apply 0065 over a database with active runs; they continue.

### Portal and browser

- Authoring flows for the three worked examples; a draft with events survives save and reload byte-for-byte; checklist navigation; pool percentages; Discord preview at text limits; mobile layouts as existing specs.

### Acceptance criteria

1. A player cannot change a pool result or a check result by leaving, returning, refreshing, retrying or pressing twice.
2. No interaction can consume an item, grant a reward or set a flag more than once, and none can do one without the others.
3. Existing dungeons, active runs, v1/v2 packages and their hashes are unchanged, proven by golden tests.
4. A run replays its event decisions from its pinned revision alone; draft edits and loot edits never reach it.
5. The sandbox and live play produce the same selection, check and reward plan for the same seed.
6. An author with no JSON knowledge can build the three worked examples in the Portal and publish them.
7. World Encounter code, tables, seeds and migrations are untouched.

---

## 16. Worked examples

IDs shortened for reading. Each fragment is valid against §3.

### 16.1 Handcrafted: the sealed vault

```jsonc
// definition.flags: [{ "key": "vault_opened", "scope": "run", "description": "Vault opened" }]
// definition.events[]
{
  "id": "sealed_vault",
  "title": "The Sealed Vault",
  "text": "A blast door fills the corridor. Its keypad is dead, but the manual lock still turns.",
  "artwork": { "kind": "shipped", "path": "dungeons/events/sealed_vault.webp" },
  "choices": [
    { "id": "use_key", "label": "Use the Vault Key",
      "items": [{ "item": "vault_key", "quantity": 1, "consume": true }],
      "unavailableText": "You have no Vault Key.",
      "outcome": { "text": "The key bites. The door rolls aside.", "tone": "good",
        "effects": [{ "type": "set_flag", "flag": "vault_opened", "value": true }],
        "rewards": { "guaranteed": [], "chances": [], "tables": [{ "id": "t1", "table": "vault_hoard", "draws": 2 }] } } },
    { "id": "pick_lock", "label": "Work the lock",
      "check": { "type": "sp", "baseChanceBasisPoints": 5500, "maxSpModifierBasisPoints": 1500 },
      "success": { "text": "A click, then another. It opens.", "tone": "good",
        "effects": [{ "type": "set_flag", "flag": "vault_opened", "value": true }],
        "rewards": { "guaranteed": [], "chances": [], "tables": [{ "id": "t1", "table": "vault_hoard", "draws": 1 }] } },
      "failure": { "text": "The mechanism jams for good.", "tone": "bad", "effects": [] } },
    { "id": "force", "label": "Force it",
      "outcome": { "text": "It gives, and so does your shoulder.", "tone": "neutral",
        "effects": [{ "type": "damage", "basisPoints": 2500 },
                    { "type": "set_flag", "flag": "vault_opened", "value": true }] } },
    { "id": "leave", "label": "Leave it",
      "outcome": { "text": "You step back from the door.", "effects": [], "then": { "type": "retreat" } } }
  ]
}
// in room "vault_door": { "id": "a_vault", "type": "event", "source": { "kind": "event", "eventId": "sealed_vault" } }
```

Play: the key is spent and two draws of `vault_hoard` are claimed in one
transaction. The lock check for an average Buddy (SP 200) is 55%; SP 350 gives
70%, SP 90 gives 44%. Forcing costs 25% of max HP, never below 1. "Leave it"
walks back to the previous room and the vault is offered again on return, with
the lock check giving the same result it would have given before.

### 16.2 Randomised: a Scrapheap pool

```jsonc
// definition.eventPools[]
{
  "id": "scrapheap_finds",
  "name": "Scrapheap finds",
  "entries": [
    { "id": "e1", "weight": 30, "eventId": "buried_crate",     "oncePerRun": true },
    { "id": "e2", "weight": 20, "eventId": "sparking_drone",   "oncePerRun": true },
    { "id": "e3", "weight": 10, "eventId": "scavenger_trader", "oncePerRun": true,
      "when": { "type": "flag", "flag": "alarm_triggered", "scope": "run", "equals": false } },
    { "id": "e4", "weight": 40, "nothing": true, "text": "Nothing but rust." }
  ]
}
// rooms "heap_a", "heap_b", "heap_c" each hold:
// { "id": "a_find", "type": "event", "source": { "kind": "pool", "poolId": "scrapheap_finds" } }
```

Author-facing odds with everything eligible: crate 30%, drone 20%, trader 10%,
nothing 40%. After the crate was found in `heap_a` and with the alarm
triggered, `heap_b` rolls among drone (20) and nothing (40): 33% and 67%. The
scenario preview shows exactly this. Each room's roll uses its own stream, is
stored on arrival, and does not change if the player comes back.

### 16.3 A choice that unlocks a later path

```jsonc
// definition.flags: [{ "key": "generator_repaired", "scope": "run", "description": "Generator repaired" }]
// definition.events[]
{
  "id": "dead_generator",
  "title": "The Dead Generator",
  "text": "A generator squats in the dark, one panel hanging open.",
  "choices": [
    { "id": "repair", "label": "Repair it",
      "items": [{ "item": "scrap_parts", "quantity": 3, "consume": true }],
      "unavailableText": "You need 3 Scrap Parts.",
      "outcome": { "text": "The lights stutter on. Somewhere below, a lift hums.", "tone": "good",
        "effects": [{ "type": "set_flag", "flag": "generator_repaired", "value": true }] } },
    { "id": "move_on", "label": "Move on",
      "outcome": { "text": "You leave it dark.", "effects": [] } }
  ]
}
// definition.connections[]
{ "id": "c_lift", "from": "machine_hall", "to": "lower_vault", "kind": "path", "label": "Take the lift",
  "requires": { "type": "flag", "flag": "generator_repaired", "scope": "run", "equals": true },
  "lockedText": "The lift has no power." }
```

No new mechanism: the outcome sets a declared run flag and the existing
connection lock reads it. The same flag can gate an activity with `when`, for
example a second event further down the same room that only appears once the
power is on.

---

## 17. Decisions needing product input

All twelve recommendations below were **accepted** for implementation, with
three clarifications: an entrance event needs an always-available choice that
does not merely retreat; unused library events must not make their rewards
publication requirements; and the choice view must say when an item is spent on
selection (`consumesOnSelect`).

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Do players see the exact success chance of a check? | Yes, as a percentage on the choice |
| 2 | Checks use pinned SP only | Yes; ATK/DEF and affinity checks later if wanted |
| 3 | Event damage cannot kill | Yes; a lethal outcome is an explicit "end the run" |
| 4 | A consumed item is spent when the choice is made, even if a check then fails | Yes; simpler and honest. The alternative is a per-item "only on success" option |
| 5 | Pool entries are once-per-run by default | Yes |
| 6 | Events cannot be declined; every event needs one always-available choice | Yes |
| 7 | At most 5 choices; unavailable choices shown disabled unless the author hides them | Yes |
| 8 | Event art is shown as a plain picture, without the Buddy composed in | Yes for Phase 3 |
| 9 | A Nothing result is silent unless the entry has a line of text | Yes |
| 10 | Package version 3 for event dungeons | Yes (§11); the alternative is an extension of v1/v2 with no version change |
| 11 | Events are local to one dungeon; no shared catalogue | Yes; copying between dungeons comes with package import |
| 12 | Managed artwork category for event pictures | Reuse the dungeon background category unless art management wants a separate one |

---

## 18. P3B1 implementation notes

What B1–B4 built, and where it differs from the sections above.

- **Modules.** `content/dungeonPrimitives.ts` (artwork, flags, conditions and
  destinations, moved out of `dungeonDefinition.ts` and re-exported by it so the
  event schemas can use them), `content/dungeonEvents.ts`,
  `content/dungeonRewardSites.ts`, `engine/events.ts`, `engine/eventChecks.ts`,
  `validation/dungeonEventValidation.ts`.
- **`dungeonDependencies` is unchanged in shape.** Required items come from
  `dungeonRequiredItems(definition)` rather than a new member, so the
  dependency object of an event-free dungeon is byte-identical.
- **Run state.** `state.events` is created only when a run first reaches an
  event, so states of event-free runs are unchanged. `DungeonActionView.event`
  carries the offered event; each choice has `available`, `unavailableReason`
  (`requires` / `items` / `no_way_back`), `check`, `items` with `owned`,
  `consumesOnSelect` and `walksAway`.
- **No new log types yet.** `event_selected` and `items_consumed` need the
  CHECK constraint changed, which is B5's migration. Until then the pool roll is
  kept on the instance and repeated in the `action_completed` payload of the
  resolution (or of a Nothing result).
- **Temporary live gate.** P3B1 refused publish, rollback and run start for
  event dungeons (`events_not_live`). P3B2 removed it once persistence, Discord
  and publication were in place (§19).
- **Packages.** `buildDungeonPackage` throws, export answers
  `package_events_unsupported`, and `readDungeonPackage` (so inspect and import
  too) refuses any v1 or v2 envelope whose dungeon has event content.
- **Compatibility evidence.** `tests/unit/dungeons/dungeonPhase3Compatibility.test.ts`
  holds hashes recorded at `0dc68a4` before any source change: the shipped
  example, the v1 golden package, a legacy and a v2 dungeon's content, snapshot
  and gameplay hashes, ordered validation issues, v2 package bytes and the
  import-copy rewrite.

---

## 19. P3B2 implementation notes

What B5–B8 built, and where it differs from the sections above.

- **Persistence (B5).** Migration `0065` as §12. `dungeonRunService` reads and
  writes `event_states`; a run that never met an event keeps `{}` and an engine
  state without `events`. The engine now logs `event_selected` when an action
  first selects, and the adapter logs `items_consumed` from the receipt.
- **Inventory facts.** `load`, and a reload after every write, read what the
  player holds of the items the *offered* event's choices name — nothing when no
  event is offered — and hand it to the engine as `ctx.inventory`. The read is
  not locked. `consume_items` goes through `inventoryService.consumeItem` in
  the step transaction, items in slug order; a failed decrement raises
  `DungeonEventItemUnavailableError` (`DUNGEON_EVENT_ITEM_UNAVAILABLE`, 409) and
  the whole step rolls back. An item gone *before* the press is an ordinary
  `choice_unavailable` refusal.
- **Run view.** `eventArtwork` (the offered event's picture, as the run pinned
  it), `eventItemNames`, and `latestEvents` (title, choice label, outcome text
  and tone for the latest step's event entries, from the pinned revision).
- **Discord (B6).** `dg|ev|<runId>|<step>|<choiceId>`. The narrative is in the
  description and each choice is its own embed field (`▸ Label` / `🚫 Label`),
  not a description line: when an embed is full the narrative is what gives
  way, never a choice or its cost. A spent item is stated as **"Consumed when
  selected, even if the check fails."** on a checked choice and "Consumed when
  selected." on an unchecked one. Buttons carry the exact chance. Picture
  order: event artwork → room background → dungeon background → dungeon
  artwork, shown as uploaded with no Buddy composed in.
- **Publication (B7).** No new code was needed for snapshots, gameplay hashes,
  where-used or work limits: they follow the shared traversal. One defect was
  found and fixed: rollback (and the published sandbox preview) validated
  against a context whose items were only the snapshot's *reward* items, so a
  revision whose event required an item was refused as `event_item_missing`.
  Required items are now judged against the live catalogue there.
- **Reward Health.** Each dungeon entry and each active older revision gains
  `notices`: an event-required item that is missing or disabled. Informational;
  `status` and `problems` keep their meaning.
- **The live gate is gone.** `events_not_live`, `dungeonEventsNotLiveIssues`
  and `DUNGEON_EVENTS_LIVE` were deleted. The package restriction is not part
  of it and remains: `package_events_unsupported` on export, build, inspect and
  import until package v3.
- **Portal (B8).** The definition types know events and pools. An event
  activity is a read-only card (story, choices, requirements, check, effects,
  pool chances) that can be moved but not edited, duplicated or removed, with a
  note that visual editing comes in P3C. "Event" is not in the add-activity
  menu. The editor already kept the draft as one object and saved it whole, so
  events survive other edits by construction; tests pin it byte-for-byte.
- **Sandbox route.** `POST /admin/dungeons/sandbox` accepts `choose` inputs, an
  assumed `inventory` (slug → quantity, at most 50) and `fighter.currentSp`
  (default 200, an average Buddy), and returns `eventResults`. The offered
  event is `view.action.event`; selections are `state.events`.

Known limits before P3C:

- Events can only be authored as JSON through the draft API. The Portal cannot
  create, edit or delete an event, a pool or an event activity.
- An event dungeon cannot be moved between environments (no package v3).
- A backend rolled back to a build before P3B2 cannot read a published event
  revision; runs on it are unreadable until roll-forward.
- Reward Health reports required items; it does not yet link to the event that
  needs them.

---

## 20. P3C1 implementation notes

What C1–C4 built, and where it differs from §9. C5 (package v3) and C6 (guide,
release checklist, lifecycle test) are not started.

- **Where it lives.** All in `portal/src/features/adminDungeons/`, inside the
  existing editor. No new page or route. Pure edits are in
  `dungeonEventModel.ts`; the sheets are `EventEditorSheet.tsx` and
  `EventPoolSheet.tsx`; `DungeonGraphView` hosts them and the sandbox through
  `EventEditorContext`, so a room, the library and the checklist all open the
  same sheet.
- **Room Event setting (C1).** `EventSourcePicker` in the room inspector: No
  event · A specific event · A random event from a pool, each with an existing
  one or "New…". It writes one `event` activity (`setRoomEvent`: before a
  trailing `leave`, otherwise last) or changes what the existing activity
  presents, keeping the activity's id, rule and flow. "No event" removes it
  after the usual confirmation. A room with several event activities shows a
  note instead. The same picker sits in an event activity's card, which can now
  be duplicated, removed and given a rule and flow like any other; it has no
  button text and no "can be skipped", and its flow cannot turn the player back.
  An **Event** room template creates a room with a new event of its own.
- **Events list (C1).** `DungeonEventsPanel` in the dungeon settings: every
  event and pool with where it is used, edit, duplicate, delete. Delete of
  something in use is refused with the rooms and pools to change first.
  Renaming is the title or name field of the sheet. Deleting a room is also
  blocked while an event choice or pool entry waits on it.
- **Event editor (C2).** Story (title, text, picture through
  `DungeonBackgroundField`, category `dungeon_background`); up to five choices,
  each with button text, an optional line, a rule (`DungeonConditionEditor`),
  up to two item requirements (`ItemPicker`, quantity, "uses it up"), what
  unavailable players read and whether it is hidden; a result kind (certain, or
  skill check); and one or two result panels: text, mood, effects (remember,
  forget, restore or lose health), rewards (`ActivityRewards`, unchanged, lent
  the outcome's bundle) and Then. Starting points ("Locked door", "Risky
  shortcut", "Shrine") are offered when an event is created from the list, not
  inside the sheet.
- **Nothing is shown in basis points.** A check is "chance for an average
  Buddy" as a percentage; Buddy-strength influence is "points either way" under
  Advanced; the weakest/average/strongest range is the server's.
- **Pool editor (C3).** Entries (an event or Nothing), share, once per run, a
  rule, a line for Nothing, reorder and remove. An event can be listed once.
- **`POST /validate` extension (C3, C4).** New pure module
  `engine/eventAuthoring.ts` and two response members, `eventPools` and
  `eventPreviews`, driven by an optional request member `eventScenario`
  (§ "Admin API" of `dungeons.md`). `base` odds are `analyseEventPool` over the
  pool with its rules removed; `scenario` odds are `analyseEventPool` as a run
  would call it; previews are `describeEventChoice` plus `hidden` and the three
  `eventCheckChance` values. This is wider than §9.4's single `eventPools`
  member because the Discord preview needs availability too, and the Portal
  must not decide that either. No schema, migration or stored shape changed.
- **The Portal computes no odds or availability.** `useEventInsight` asks the
  server, apart from the page's own validation and never replacing it, and
  drops any answer that is not for the draft and situation on screen. Even the
  per-entry percentage is the server's (§9.4 allowed a local share ÷ total).
- **Discord preview (C4).** `EventDiscordPreview` lays out the server's choice
  views the way `dungeonPresenter` does: title and narrative, a block per
  choice (`▸` / `🚫`), the item-cost statement in full, the chance on the
  button, hidden choices named underneath, and what each result looks like.
  The presenter's text lengths and the two "Consumed when selected" sentences
  are repeated in `eventPreviewModel.ts`; a backend test reads that file and
  fails if they drift. It is a likeness, not the presenter's output: Discord
  markdown is not rendered and a result's HP line states the rule, not numbers.
- **Sandbox (C4).** There was no sandbox screen in the Portal before this;
  `DungeonSandboxDialog` ("Play the dungeon") is the first, over the existing
  `POST /sandbox`. It plays the unsaved draft from the entrance with an assumed
  Buddy strength, inventory and seed, replaying every press from the start, and
  lists what a real run would have used or paid. It needs only `dungeons.read`.
  It is a general walk-through, so fights and treasures are played too.
- **Checklist (C4).** `friendlyIssue` reads `events[…]` and `eventPools[…]`
  paths: titles name the event, pool and choice, and each carries an
  `eventTarget` (sheet, choice or entry, field). "Show me" opens the sheet,
  opens the choice and focuses the field. Blank fields the server cannot store
  (title, story, button text, an unchosen item or pool event) are raised by
  the editor itself under "Finish before saving".
- **Lossless edits.** Every edit spreads the object it changes; an optional
  member that is cleared is removed, not stored empty; the last event or pool
  deleted removes the list itself, so the dungeon reads as it did before
  events. Clearing and retyping an optional text field moves that member to the
  end of its object: same content and hash, different key order.

Known limits after P3C1:

- An event dungeon still cannot be exported or imported (package v3 is C5).
- "Attach this event directly instead" for a one-entry pool (§9.6) is not
  offered.
- The preview and sandbox take the three reference Buddy strengths (weak,
  average, strong), not an arbitrary SP.
- The sandbox starts at the entrance; "Skip ahead to the next event" presses
  through fights and rooms on the author's behalf, but cannot start mid-dungeon.
- Reward Health does not yet link an event-required item to the event.
