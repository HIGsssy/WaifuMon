# Dungeons (Delve)

Hand-authored dungeons: a map of rooms and connections, each room holding an
ordered sequence of actions, played one step per Discord interaction by a pure
engine. This document describes the system through **Phase 3 Dungeon Events**
(migrations `0059`–`0065`). The prototype it replaced — procedural zones, one
node = one resolution — is gone; its documentation is in Git history.

The graphical Portal editor, dungeon-local narrative events, random event pools,
package v1/v2/v3 importer and Dungeon Loot catalogue are implemented. WaifuMon
encounters remain Phase 4. See the [Dungeon Events creator guide](dungeons/dungeon-events-guide.md)
and [Dungeon Rewards creator guide](dungeons/dungeon-rewards-guide.md) for authoring,
and the [Phase 3 release assessment](dungeons/phase3-release-readiness.md) for
verification and staging requirements. The original [audit](dungeons/phase2-rewards-audit.md)
and [design](dungeons/phase2-rewards-design.md) retain historical context;
this page describes current behaviour.

## At a glance

| Concern | Where |
| --- | --- |
| Content schema (definition, layout) | `src/modules/dungeons/content/` |
| Validation | `src/modules/dungeons/validation/dungeonValidation.ts` |
| Pure engine, view, sandbox | `src/modules/dungeons/engine/` |
| Package format and export | `src/modules/dungeons/package/dungeonPackage.ts` |
| Drafts, publish, rollback, audit | `src/modules/dungeons/dungeonContentService.ts` |
| Live runs | `src/modules/dungeons/dungeonRunService.ts` |
| Dungeon Loot catalogue | `src/modules/dungeons/dungeonLootTableService.ts` |
| Reward schemas and publication snapshots | `src/modules/dungeons/content/dungeonRewards.ts`, `dungeonRewardSnapshot.ts` |
| Shared resolver and exact odds | `src/modules/dungeons/engine/lootResolver.ts` |
| Portal editors | `portal/src/features/adminDungeons/`, `adminDungeonLoot/` |
| Daily allowance (unchanged) | `src/modules/dungeons/dungeonAllowanceService.ts` |
| Admin API | `src/api/routes/v1/admin/dungeons.ts` |
| Discord | `src/discord/commands/waifumonDungeon.ts`, `dungeonPresenter.ts`, `dungeonArtwork.ts` |
| Tables | `dungeon_definitions`, `dungeon_revisions`, `dungeon_runs`, `dungeon_run_events`, `dungeon_content_events` |
| Example | `content/dungeons/examples/service_tunnels.dungeon.json` |
| Sandbox CLI | `npm run dungeons:sandbox -- <package.dungeon.json>` |

## The content model

A **dungeon definition** has two layers.

**The map.** `rooms[]` and `connections[]`. A connection is directed
(`from` → `to`) and may carry a `requires` condition (a locked path), a
`label`, a `lockedText` and a `kind` (`path`, `shortcut`, `secret` — a secret
connection is not shown at all while locked). The map is a graph: it may
branch, rejoin and **cycle**. A room is a `room` or an `exit`; an exit room
ends the run as completed when its sequence finishes. Any room may be an
`extraction` point. `entranceRoomId` names where a run begins.

**The room sequence.** Each room has an ordered `actions[]` list. Supported
action types:

| Type | What it does | Outcomes |
| --- | --- | --- |
| `combat` | Sequential waves; optional rewards after final victory | `victory`, `defeat` |
| `boss` | The same, presented as a boss; no automatic loot multiplier | `victory`, `defeat` |
| `rest` | Restores `healBasisPoints` of max HP | `done` |
| `gate` | Tests a condition | `passed`, `blocked` |
| `set_flag` | Sets a run-scoped flag | `done` |
| `leave` | Completes the room; with `connectionId`, walks through it | — |
| `reward` | Treasure: a new reward bundle or legacy tables/currency | `claimed` |
| `event` | A narrative with choices, selected directly or from a pool | The selected choice's certain result, success or failure |

Actions also take `when` (a condition: the action is skipped silently when
false), a `label`, `next` and `outcomes`. Supported optional activities can be
declined with outcome `declined`; events use their authored choices instead of
a generic decline button.

`event` (Phase 3) presents a narrative with choices: one named event, or a draw
from a weighted pool, both defined in the dungeon's own `events` / `eventPools`.
It is live: selections are stored on the run (`dungeon_runs.event_states`,
migration `0065`), a choice is answered with `dg|ev|<runId>|<step>|<choiceId>`,
and an item a choice spends is consumed in the step's transaction. Events and
pools are authored in the Dungeon Editor (a room's Event setting, the Events
list in dungeon settings, and the event and pool side sheets). Event dungeons
export as package v3, including required item slugs and reachable outcome rewards.
See the [creator guide](dungeons/dungeon-events-guide.md) and
[phase3-events-design.md](dungeons/phase3-events-design.md).

`choice`, `objective`, `random_outcome`, `wild_encounter` and `rescue`
are **reserved** for later phases. A definition that uses one is refused with
the issue code `unsupported_action_type`, naming the phase. Adding one is a new
member of `DungeonActionSchema`, a handler in `engine/step.ts` and a
validation rule — the engine's shape does not change.

### Routing inside a room

An action hands over to the next one in the list unless it is routed
elsewhere. A destination is one of:

| Destination | Meaning |
| --- | --- |
| `next` | The following action; the room completes after the last |
| `action` | A named action **later** in the same room |
| `room_complete` | The room completes now, whatever follows |
| `leave` | The room completes and the player goes through a connection |
| `retreat` | The room is left unfinished and the player goes back where they came from; the sequence resumes at that action on return |
| `end_run` | The run ends (`completed` or `defeated`) |

**Precedence**, for an action that reported `outcome`:

1. `outcomes[outcome]`, if written;
2. `next` — but only for the action's success outcome (`victory`, `done`,
   `passed`, `claimed`). A failure or a decline never follows `next`;
3. a declined action continues to the following action;
4. the type's default: a lost fight ends the run as defeated; a blocked gate
   retreats; a `leave` walks its connection or completes the room; everything
   else is `next`.

Routing only goes **forward** in the list, so a sequence always terminates.
This is deliberately not a workflow language. Loops belong to the map.

### The four ways an action ends

| Status | Meaning |
| --- | --- |
| `completed` | It ran and reported a success outcome |
| `failed` | It ran and reported a failure outcome (a routed-on defeat, a blocked gate) |
| `declined` | It was optional and the player said no |
| `condition_skipped` | Its `when` was false; the player never saw it |

They are distinct in the run state (`room_states[room].actions[action].status`)
and in the event log (`action_completed`, `action_failed`, `action_declined`,
`action_skipped`).

### Conditions and flags

Conditions are `flag`, `room_completed`, `all`, `any`, `not`. Flags are
declared on the dungeon with a scope:

- `run` — lives on the run, dies with it. Fully supported.
- `player` — persistent per player and dungeon. **Declared only**: nothing can
  set one yet (`flag_scope_unsupported`), and reading one is always false.

Both are namespaced by the dungeon. A future campaign namespace is a third
scope value, not a change to these.

### Randomness that remains

Procedural *map generation* is gone. Randomised *gameplay* is not: a wave may
name a weighted enemy `pool`, reward tables roll, combat has damage variance,
and actions can be conditional. Every draw comes from a stream derived from
the run seed and the place it is made (`engine/seeds.ts`), so it is
reproducible and cannot be re-rolled.

### Identity

Every id in a definition is an author-chosen string. Enemies, reward tables,
regions and currencies are named by their own stable keys. Artwork is a
shipped path under `assets/`, or a managed upload named by **category and
sha256 content hash** — never by its per-environment asset id. Nothing in a
definition is a numeric database id.

### Layout is separate

Where rooms are drawn, the viewport and editor notes live in a **layout
document** (`content/dungeonLayout.ts`) stored and exported beside the
definition. The runtime, the validator and the content hash never read it.

## The engine

```
stepDungeon(state, input, context, rng) → { status, state, effects, log, combat }
```

Pure: no database, no Discord, no clock, no service. The same arguments give
the same result. `tests/unit/dungeons/engineArchitecture.test.ts` walks the
import graph and fails if anything under `engine/`, `content/`, `validation/`
or `package/` could reach one.

- **Inputs:** `advance`, `decline`, `move {connectionId}`, `extract`,
  `abandon`, each with the `expectedStep` it was issued for.
- **One input, one step.** An input resolves what the player is looking at;
  the engine then carries the sequence through everything that needs no
  decision (skipped conditions, gates, flags, `leave`, a room completing, the
  next room's opening actions) until it reaches something that does.
  `state.step` rises by exactly one.
- **Staleness.** If `expectedStep` is not the run's step the input is refused
  as `stale` and nothing changes.
- **Effects.** What must happen in the world comes back as data:
  `grant_rewards` (with its claim key) and `settle_run` (with its request
  key). An adapter carries them out.

Two adapters exist: the **live** one inside `dungeonRunService`'s transaction,
and the **sandbox** (`engine/sandbox.ts`), which records effects and applies
none. Live gameplay and simulation therefore run one copy of every rule.

### The cursor and run state

```
cursor: { roomId, actionId | null, waveIndex, cameFrom }
```

`actionId` is null when the room is finished and the player is choosing a
connection. `waveIndex` is the next wave of a combat action to fight. Later
phases add their own optional frames. The state also holds HP, run flags, each
room's visits/completion/action records, unbanked currency, what the latest
step did (`recent`) and, once over, how the run ended.

### Combat waves

- A `combat` or `boss` action has `waves[]` of any length; a room may hold
  several such actions. The engine has **no wave limit** (the schema caps one
  action at 100 only to bound a stored document; the validator warns above 20).
- Each wave is one one-versus-one fight run by the existing combat simulator
  with the snapshotted fighter and the snapshotted enemy at full HP.
- **HP carries** from wave to wave and action to action.
- Each wave has its **own seed**, derived from run seed, room, action and wave
  index. The enemy a pooled wave fields is drawn the same way, once.
- Each wave is **persisted** as it is won: the action is `in_progress`, the
  cursor holds the next `waveIndex`. A restart resumes at the right wave.
- `advance: 'confirm'` (default) takes one press per wave; `'auto'` fights the
  remaining waves in the same step. Either way each wave is its own log entry.
- A loss — or a round-limit stalemate — ends the run as `defeated` unless the
  action routes `defeat` elsewhere, in which case the Buddy carries on at 1 HP.

Combat is automatic and server-side. Simultaneous multi-enemy fights are out
of scope.

## Drafts, publication and revisions

| Thing | Table | Mutability |
| --- | --- | --- |
| Draft + layout + published pointer | `dungeon_definitions` | Mutable; `draft_revision` is the optimistic lock |
| Published revision | `dungeon_revisions` | **Immutable** (no update path; a trigger refuses UPDATE and DELETE) |
| Audit | `dungeon_content_events` | Append-only |

- **Save** names the `expectedRevision` it edited; a mismatch is
  `DUNGEON_DRAFT_STALE` (409). A draft must have a readable shape but may
  carry validation errors.
- **Publish** is explicit and needs `dungeons.publish`. It re-validates
  against this server with errors blocking, writes revision *n+1* and moves
  the pointer. It freezes reward dependencies and compares both the definition
  and its reward gameplay identity. A loot-body or eligible-equipment change
  can require a new revision without changing the definition ("Loot changed").
- **Rollback** moves the pointer to an earlier revision after re-validating
  it. Nothing is copied.
- A dungeon is **open** to players when it is `enabled` and has a published
  revision. Creating or (later) importing a dungeon never publishes it.

### What a run is pinned to

| Content | Frozen at | Held in |
| --- | --- | --- |
| Rooms, connections, sequences | Publish | `dungeon_runs.revision_id` |
| Dungeon loot bodies, eligible gear keys and reward item metadata | Publish | `dungeon_revisions.reward_snapshot` |
| Enemy stats, legacy expedition tables, resolved managed artwork | Run start | `dungeon_runs.dependency_snapshot` |
| Buddy stats and gear | Run start | `dungeon_runs.fighter` |
| Equipment ranges, affix and combat-bonus generation rules | Grant time, live; per-drop seeded RNG | Equipment services |
| Item existence/caps and equipment-definition existence | Checked again at grant time | Shared catalogues |

Publishing or rolling back changes what **new** runs get. An enemy balance
edit reaches new runs without republishing anything, and never a run already
under way.

### Managed artwork references and Replace

A definition names a managed picture by `category` + content hash, and the
asset manager's **Replace** keeps the asset while changing its hash. A
reference is resolved to an asset on this server by one lookup
(`artworkAssets/managedArtworkLookup.ts`), shared by validation, the editor
preview, the run snapshot, the import review and the asset delete guard:

1. an **active asset holding exactly those bytes** (the oldest, if several
   uploads are identical);
2. else the asset that **most recently replaced those bytes away**, while it is
   active. This follows one asset through any number of replacements.

Otherwise the reference resolves to nothing: `artwork_missing` (a warning) in
the editor, and the screen falls back as if no picture were set.

- **Replacing an image changes how an existing dungeon looks, published
  revisions included, without changing any saved revision.** The definition
  keeps the hash it was saved with; nothing is rewritten, and nothing needs
  republishing. To pin a dungeon to a specific picture, upload it as a new
  asset instead of replacing.
- Every dungeon naming the reference moves together. The lookup reads only
  `artwork_assets` and the append-only `artwork_asset_events`, so it gives the
  same answer after a restart.
- Rule 2 never chooses between assets. If several assets once held the same
  bytes, the reference belongs to the one that held them last; if that asset
  is disabled or deleted the reference resolves to nothing rather than moving
  to another asset's new picture. The same bytes in another category are a
  different reference.
- A run pins the **asset** each reference resolved to when it started
  (`dependency_snapshot.artwork`), and reads that asset's image live. A
  replacement therefore shows in a run already under way; a disabled asset
  shows nothing until it is re-enabled; a run started while a reference did
  not resolve has no picture for it, even if it resolves later.
- An asset cannot be deleted, or moved to another category, while a draft or
  published revision names any hash that resolves, or would resolve when
  re-enabled, to it (`409 ARTWORK_ASSET_IN_USE`).

## Live runs

`dungeonRunService.act(playerId, runId, input)` is the only way a run moves:

1. `SELECT … FOR UPDATE` on the run row, scoped by player;
2. the engine steps the stored state (a stale step is refused here);
3. effects are applied through the live adapter;
4. the new state and its `dungeon_run_events` rows are written.

One transaction. A double click, a Discord retry or racing interactions fight
a wave once, pay once and move the cursor once.

Unchanged from the prototype: the `equipment` unlock gate, the Buddy and
complete-loadout requirement, one active run per player, the shared daily
allowance spent in the start transaction, region availability at start only.

### Legacy Treasure compatibility

A `reward` action pays an existing `expedition` reward table (and optionally a
second for gear) plus a range of the dungeon's progression currency.

- Gear, WaifuBux and items are **secured**: granted in the step's transaction.
- Progression currency is **unbanked** until settlement: all of it on
  extraction or completion, `defeatCurrencyRetentionBasisPoints` on defeat.
  Abandon uses `abandonCurrencyRetentionBasisPoints` when present, otherwise
  the defeat rate, preserving old definitions.
- Idempotency: `dungeon_runs.reward_claims` stores each paid plan by its
  run/room/action claim key, independently of retreat and room resume state.
  A repeated action follows its routing but pays nothing again. Claims and
  grants share the step transaction and run lock; gear
  carries a grant key derived from the action's claim key
  (`run:<runId>:<roomId>:<actionId>`); banking carries the ledger request key
  `dungeon_run:v1:<runId>:settlement`, distinct from historical prototype keys.

Legacy plans, RNG streams, content hashes and equipment keys remain compatible.
A missing legacy item now fails the complete step rather than being silently
lost. Legacy tables are guarded against deletion and validated transitively on
publish/rollback. Explicit per-Treasure conversion previews new tables and
changes the draft only; converted WaifuBux become at risk after publication,
and converted rolls use the new RNG streams.

### Phase 2 rewards

Combat and Boss may have an optional `rewards` bundle. Treasure has exactly
one of legacy `reward` and new `rewards`. A bundle combines `guaranteed`,
independent `chances` and repeated `tables` references. Dungeon Loot bodies
combine guaranteed/chance entries and weighted `pools`, with explicit Nothing
outcomes and picks with replacement. They are separate from expedition and
guild-boss tables; Phase 2 ships no dungeon-loot seeder.

Final-wave victory or opening Treasure claims rewards once. The claim remains
`run:<runId>:<roomId>:<actionId>` through retreat, re-entry and restart. Test Roll,
sandbox and gameplay use the same pure resolver. Items (charms and salvage
included), equipment, Essence and affection are secured in the locked step
transaction. Affection goes to the pinned participating copy even after a Buddy
swap. That copy cannot be released or converted during its run. Affection and
Essence use the participating Buddy's bonuses pinned at start.

Shards (the configured progression currency) and new-format WaifuBux stay at
risk. Extract/completion bank 100%; defeat and abandon apply their configured
retention separately to each currency, rounding down. New Portal dungeons
explicitly set defeat 50% and abandon 0%. Existing balances are never reduced.
Disconnect does not end a run. Missing/disabled progression currency still
causes recorded skipped Shard banking; WaifuBux settle independently.

Editing, archiving or deleting a Dungeon Loot table never changes any published
snapshot, including for new runs on that revision. Gear candidates stay frozen,
but stat ranges and affix/combat-bonus rules remain live. A failed secured grant
rolls back every grant, claim, step and successful receipt. Gear has stable drop
keys and seeds; retries reproduce properties while live generation rules stay
unchanged. Discord displays committed receipts and settlement amounts.

Reward Health checks current publications and older revisions with active runs
for missing/capped items, missing gear and invalid snapshots, read-only and with
counts rather than player identities. It does not flag ordinary live table edits
as broken publication loot. It does not inspect every unused historical revision
or guarantee validity of live gear-generation catalogues. No fixed-stat reward
authoring, once-per-player claims, nested tables or unique draws are added.

## Discord

Custom ids (`dg` scope):

```
dg|home                               dungeons, or the active run
dg|zone|<dungeonKey>                  dungeon detail
dg|start|<dungeonKey>                 start a run
dg|run|<runId>                        the run as it stands (Resume)
dg|act|<runId>|<step>|a               advance the pending action / next wave
dg|act|<runId>|<step>|d               decline an optional action
dg|mv|<runId>|<step>|<connectionId>   take a connection
dg|exq|<runId>                        extraction confirmation
dg|ex|<runId>|<step>                  extract
dg|abq|<runId>                        abandon confirmation
dg|ab|<runId>|<step>                  abandon the quoted step
dg|ev|<runId>|<step>|<choiceId>       answer the offered event
```

Old abandon buttons without a step reopen confirmation before settling.

### What a fight shows

`dungeonArtwork.ts`, per wave, from the enemy's own artwork (the Enemy
Catalogue; there is no per-wave override):

| The enemy has | The picture |
| --- | --- |
| a usable combat sprite | room background → dungeon background → dungeon artwork → a plain generated stage, with the run's Buddy and the enemy sprite composed over it |
| no usable sprite, full artwork | the enemy's full artwork **alone**, as uploaded: no background and no Buddy (she would look pasted over an opaque character scene) |
| neither | the room background, else the dungeon artwork, else the dungeon background, with the Buddy over it; else text only |

"Usable" means it resolves now: a disabled or missing sprite counts as none.
Each wave is decided on its own, so one fight can move between the rows.
Sprite placement, mirroring and scale are unchanged by which row applies. The
editor's wave preview (`POST /scene-preview`) follows the same rules.

`<step>` is the run's step when the screen was drawn. Ids stay under Discord's
100 characters (ids in a definition are at most 40). Connections are laid out
five to a row; the validator warns above ten ways out of one room.

## Validation

`validateDungeonDefinition(raw, context)` returns issues with a **stable
code**, a severity, a path and a message. Errors block publication; warnings
never do. Codes are listed in `DUNGEON_ISSUE_CODES`. Highlights:

- shape: `schema`, `unsupported_action_type`, `unknown_action_type`;
- identity: `duplicate_room_id`, `duplicate_connection_id`,
  `duplicate_action_id` (per room), `duplicate_flag`;
- map: `entrance_missing`, `connection_unknown_room`, `exit_has_connections`,
  `no_ending`, `room_no_route_to_exit` (errors); `room_unreachable`,
  `connection_self_loop`, `many_connections` (warnings);
- sequences: `transition_backward`, `transition_unknown_action`,
  `transition_invalid_connection`, `retreat_from_entrance`, `unknown_outcome`
  (errors); `action_unreachable`, `many_waves` (warnings);
- references: `enemy_missing`, `enemy_pool_duplicate`, `reward_table_missing`,
  `region_missing`, `currency_missing`, `flag_undeclared`,
  `flag_scope_mismatch`, `flag_scope_unsupported` (errors); the `_disabled`
  variants, `flag_never_set`, `flag_unused`, `artwork_missing` (warnings).

Reachability and "has a route to an exit" are judged on the map as drawn with
every lock assumed openable. Nothing requires branches to be balanced or
optional rooms to be visited.

## The Dungeon Content Package

One dungeon as portable JSON (`format: "waifumon-dungeon-package"`). Definitions
with an event library, pool or event action export as `schemaVersion: 3`; event-free
reward bundles use v2 and legacy-only definitions use v1. All three are read and
verified. An event-free definition's existing hashes and v1/v2 format are preserved.
The v1 foundation is:

| Member | Content |
| --- | --- |
| `packageId`, `exportedAt`, `source` | One export; where it came from |
| `contentHash` | sha256 of the parsed definition in canonical JSON. Layout is **not** part of it |
| `dungeon` | The definition |
| `editor.layout` | The layout document |
| `dependencies` | Enemies (with hashes), reward tables, regions, currencies; species/items/equipment reserved |
| `assets` | Artwork references |
| `bundled.enemies` | The enemy definitions the dungeon names, for the importer to create when missing |

`readDungeonPackage` verifies a file on its own terms: format, version, shape,
that the hash matches the content, that the manifest matches what the content
really names, that bundled enemies match their hashes, and that the dungeon is
structurally valid. A reader refuses a version or a member it does not know.

**Phase 1A** ships the format, export
(`GET /admin/dungeons/definitions/:key/export`), read-only inspection
(`POST /admin/dungeons/package/inspect`) and round-trip tests.
**Phase 1B.4A** adds the JSON importer: plan, conflicts, apply, import log. An
existing enemy that differs from a bundled one must be surfaced as a conflict
and never silently overwritten — which is why each dependency carries a hash
computed exactly as the Enemy Catalogue computes it.

Import plans are read-only, verify the existing package reader's hashes and
manifest, compare the draft and layout, and validate the target's references.
The plan includes `planHash`, `packageHash`, `target.expectedRevision`,
`target.status`, changed fields, per-enemy status and per-path issues.
`publishable` describes the current target dependencies, before proposed enemy
creation. Reward dependencies are checked for missing items and invalid Equipment
selectors too. V2/v3 include hashed Dungeon Loot bodies and a frozen reward
snapshot. Missing tables can be created; different tables require an explicit
use-existing or import-as-copy decision. Copy rewrites normal rewards and all
event outcome branches. V1 legacy reward tables, regions and currencies are
named by key; their source definitions cannot be compared.

V3 also lists the inventory items required by reachable event choices. It checks
their availability on the target without creating global item definitions or
transferring player inventory. Missing or disabled required items need explicit
acceptance as an incomplete import. All new imports begin disabled and unpublished.
A replacement import changes only the existing dungeon's draft: its enabled flag and
published revision stay as they were, so players, active runs and its published
species policy keep using that revision until the draft is published (CP-4A).

Apply takes `{ package, requestId, expectedPlanHash, expectedRevision, decisions }`.
`requestId` is a fresh UUID for one reviewed apply request; keep the whole request
unchanged when retrying. `expectedRevision` is null for a new dungeon, otherwise
the revision returned by the plan. Decisions are required:

```json
{
  "dungeon": "create",
  "enemies": { "new_enemy": "create", "differing_enemy": "use_existing" },
  "allowMissingDependencies": false
}
```

`dungeon` must match the plan: `create`, `replace` or `unchanged`. Identical
gameplay with a different layout still needs `replace`. Missing bundled enemies
require `create`; differing existing enemies require `use_existing`. Import
never updates an existing enemy. To retain missing direct enemies, tables,
regions or currencies in an incomplete draft, explicitly set
`allowMissingDependencies: true` and use `leave_missing` for missing enemies.
Structural package errors and broken target reward-table dependencies remain
blocking. Missing artwork is a warning, never silently substituted; managed
references resolve by category/hash and stored bytes, and shipped paths must
resolve to files inside the assets root. Artwork remains optional under the
existing publication rules; other missing dependencies still block publishing.

**Managed artwork across environments.** A package carries each managed
reference exactly as the dungeon was saved — category, content hash and
display name; no asset id, no image bytes and no replacement history. Export
does not rewrite a reference whose image has since been replaced. The target
resolves it with its *own* assets and its *own* replacement history (the
lookup above), so:

- it resolves when the target has an active asset holding those exact bytes;
- if a target asset held those bytes and was since replaced there, it follows
  that asset and the review adds the warning `artwork_replaced`, naming it;
- otherwise it is `artwork_missing`. An unrelated image is never matched.

Known limitation: if an image was replaced in the source after the dungeon was
saved, the package still names the **old** bytes. Uploading the current picture
to the target does not satisfy it. Either re-choose the image in the source
dungeon (so it is saved with the current hash) and export again, or upload the
original bytes to the target. The package format is unchanged.

Application locks the request, dungeon and referenced enemy identities,
locks existing target/dependency rows, and re-plans. Any reviewed state change
returns `409 DUNGEON_IMPORT_STALE`. Enemy creation, the draft, import history
and the `imported` authoring event commit together. New dungeons start disabled
and unpublished; replacements of every package version preserve enabled state and
the published pointer, which the plan reports as `target.enabled` and
`target.publishedRevision` and pins in its hash (a publish, rollback, enable or
disable after review is stale). Published revisions and active runs are never written. An identical import
does not bump the draft revision. Exact retries return the original receipt
(`replayed: true`), even after later edits; reuse of a request ID for a different
package, plan, decisions or administrator returns
`409 DUNGEON_IMPORT_REQUEST_CONFLICT`.

Migration `0061_dungeon_import_history` stores the package ID/hash, source
environment, dungeon key, timestamp, actor, decisions and compact result, plus
the idempotency request identity/hash. It stores no dungeon/package payload.
Rejected transactions leave no successful import history. JSON-only transfer
is supported; ZIP files and asset bytes, legacy reward tables, items, currencies,
regions and Equipment definitions must be installed separately.

Phase 1B.4B adds **Import Dungeon** to the Portal dungeon list. Selecting a
JSON file plans it without writing; draft and enemy decisions, warning
acknowledgement and permitted incomplete-draft acceptance precede Apply.
The Portal checks UTF-8 bytes for both wrapped plan and actual apply bodies.
Uncertain responses retain the exact submitted payload and request ID for
retry, with package/decision changes locked. Keep the page open until a
receipt is confirmed: retry state is held in memory, not persisted across
browser sessions. A definitive conflict requires an explicit new plan and
review. Import history is read-only on the dungeon management page.
Exports distinguish saved draft, current publication and numbered revisions.

The shipped Portal Nginx template sets `client_max_body_size 2m` only for
`/api/v1/admin/dungeons/import/`. Any additional ingress/proxy in a deployment
must also permit request bodies through 2 MiB. Template changes take effect
only when that environment's Portal proxy configuration is updated; no
deployment is performed by the editor implementation.

### Package v2 rewards and conflict review

V2 adds the complete verified `rewardSnapshot`, nullable `rewardSnapshotHash`,
bundled Dungeon Loot bodies with hashes/source revisions, and exact table,
item and equipment-candidate manifests. Revision exports use frozen bodies and
candidates; draft exports validate current catalogues and refuse broken reward
dependencies. Description/origin are null where the publication did not store
them. Display metadata/provenance are outside the gameplay hash; table bodies,
item slugs and candidate identities are hashed.

Missing tables default to create, identical bodies to reuse, and differing
bodies require copy-under-a-free-key or explicit use-existing. Copies rewrite
every reference and change the definition hash; use-existing warns that rewards
differ. Target gear candidates are compared with the source. Global items,
equipment, regions, currencies and asset bytes are not imported. Explicit
incomplete drafts cannot publish until repaired. Import refuses v1 envelopes
containing new reward bundles.

Plan requests optionally carry `lootTables`; apply carries the same choices
under `decisions.lootTables`, for example
`{ "boss_hoard": { "action": "copy", "key": "boss_hoard_imported" } }`.
Choices, destination rows and dependency state enter the plan hash. Apply
re-plans under locks; a stale plan needs fresh review. Catalogue locks protect
missing-key and equipment-insertion races. Table creation/history, enemies,
draft, audit and receipt commit together. Existing tables are never overwritten;
exact retries return the original receipt.

**V2 create leaves the target disabled and unpublished; replacement changes only
the draft.** Like v1, v3 and v4, replacement keeps the enabled flag, the current
publication, historical revisions and active runs. Publish explicitly to put the
imported draft live; publication revalidates it here.

## Admin API

All under `/api/v1/admin/dungeons`.

| Route | Permission |
| --- | --- |
| `GET /definitions`, `GET /definitions/:key` | `dungeons.read` |
| `POST /definitions` | `dungeons.write` |
| `PUT /definitions/:key/draft`, `PUT /definitions/:key/enabled` | `dungeons.write` |
| `POST /definitions/:key/publish`, `POST /definitions/:key/rollback` | `dungeons.publish` |
| `GET /definitions/:key/revisions`, `…/revisions/:number`, `…/history`, `…/export` | `dungeons.read` |
| `GET /reference`, `POST /validate`, `POST /package/inspect`, `POST /sandbox` | `dungeons.read` |
| `POST /import/plan`, `POST /import/apply` | `dungeons.write` |
| `GET /definitions/:key/import-history?limit=100` | `dungeons.read` |
| `GET /reward-health`, `POST /loot-tables/validate`, `POST /loot-tables/test-roll` | `dungeons.read` |
| Loot-table list/get/where-used/history | `dungeons.read` |
| Loot-table create/update/archive/restore/delete/duplicate | `dungeons.write` |
| `POST /definitions/:key/treasure-conversion/plan`, `…/apply` | `dungeons.write` |
| `/artwork*`, `/settings`, `/currencies*` | unchanged |

Import POST bodies have a 2 MiB ceiling and are permission-checked before
parsing. Planning takes `{ package }`, returns the plan under `data`, and writes
nothing. Apply returns `importId`, `dungeonKey`, `result`
(`created`/`replaced`/`unchanged`), `draftRevision`, `createdEnemies`, `issues`,
`publishable` and `replayed`. History returns `{ imports: [...] }`, newest first,
with `limit` from 1 to 500. An invalid package plan returns 200 with
`validPackage: false` and issues; invalid apply decisions/content return
400 `DUNGEON_IMPORT_INVALID` for service-level refusals; malformed request bodies
use the API's normal field-validation errors. Normal Portal session, CSRF and administrative
permission checks apply to all routes.

`POST /sandbox` plays a draft, a published revision or an inline definition
through the sandbox with a synthetic fighter and returns the view, state,
recorded effects and log. New rewards use a validated ephemeral draft snapshot
or verified published snapshot, without player grants or writes. Legacy
expedition loot is not resolved by this reward preview path. An event is
answered with a `choose` input; `inventory` and `fighter.currentSp` are assumed,
never read from a player. The Dungeon Editor's "Play the dungeon" is this route.

`POST /validate` also answers how a definition's events would play, from the
engine's own draw and check functions (`engine/eventAuthoring.ts`): `eventPools`
gives each pool's odds with every entry in the draw (`base`) and for an imagined
run (`scenario`); `eventPreviews` gives every event's choices as a player in
that run would meet them (available, hidden, check chance, item cost). The run
is the optional `eventScenario` in the request — `flags`, `completedRooms`,
`seenEvents`, `inventory`, `currentSp`, `canTurnBack` — and defaults to an empty
run with an average Buddy. Both lists are empty for a definition without events
or one whose shape cannot be read. The Portal shows these numbers and computes
no odds or availability of its own.

## Migration 0059

- Journal `when` 1820872800000, after 0058's 1820786400000. Drizzle orders on
  `when`, not on the filename number. **Not to be backported** to another
  branch.
- Prototype runs still active are settled as extractions: their unbanked
  currency is banked in full through the ledger.
- `dungeon_zones`, `dungeon_runs` and `dungeon_run_events` are renamed aside
  with a `_prototype` suffix and never read again. A later cleanup drops them.
- `dungeon_settings`, `dungeon_daily_usage`, the currency tables, artwork
  tables and everything under `assets/` are untouched.
- `player_waifus` gains nullable `acquired_via` and `grant_key` (unique when
  set). Nothing writes them yet; capture is unchanged.

Covered by `tests/integration/dungeonMigration.test.ts`, which stops at 0058,
plants prototype data and then applies 0059.

Migration `0060_dungeon_reward_claims` adds the independent claim map and
backfills paid plans from run history, including claims whose action records
were erased by retreat. Historical currency ledger entries are unchanged.

## Phase 2 migrations and rollout

`0062_dungeon_loot_tables` creates the catalogue, immutable keys and append-only
events. `0063_dungeon_reward_snapshots` adds paired nullable snapshot/gameplay
hash columns; legacy revisions stay null. `0064_dungeon_unbanked_waifubux` adds
a nonnegative integer defaulting to 0, preserving old runs. Journal indices and
increasing `when` values must stay ordered; include all preceding migrations.
T16–T18 require no further migration.

Deployment order: database through 0064, then matching backend/bot, then Portal.
Backend startup runs migrations before services. Coordinate this before exposing
the new Portal or creating v2 content; old backends cannot interpret v2 bundles
or runs. Build the Portal from repository root with
`podman build -f portal/Dockerfile .`; its production build excludes local env
files and verifies the public bundle. Preserve the import proxy's 2 MiB limit
through any additional ingress. Complete the release assessment's staging
checklist before considering production.

## Still out of scope

- Persistent player flags, event effects other than run flags/percentage health/rewards,
  and skill checks other than SP.
- WaifuMon encounters, rescue and recruitment (Phase 4).
- Re-running a completed room's sequence on re-entry.

## Phase 3 migration and rollout

`0065_dungeon_events` adds non-null `event_states` with an empty-object default
and extends the run-history type constraint for selection and item consumption.
Existing event-free runs retain their state and hashes. The constraint replacement
takes an exclusive lock and validates historical rows; rehearse its duration on a
representative database and schedule a maintenance window with bounded lock waits.

Deploy the database through 0065, then the matching backend/API and Discord bot,
then the Portal. Withhold event publishing until all readers support events and
package v3. Disabling a dungeon stops new starts but does not migrate active runs;
an older backend cannot safely resume runs pinned to event revisions. Keep the
additive migration when rolling application code back. The
[Phase 3 assessment](dungeons/phase3-release-readiness.md) gives the detailed
deployment, rollback and manual staging checklist.
