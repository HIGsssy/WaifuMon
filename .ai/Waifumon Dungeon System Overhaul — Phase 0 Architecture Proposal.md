# Waifumon Dungeon System Overhaul — Phase 0 Architecture Proposal

Oct 10, 2026 · @Ian

## Summary

The recommendation is to replace the Delve content model and node resolver, keep the combat engine, fighter snapshot, locking pattern, scene compositor and auth, and build the new system around one pure run engine that both the live game and the simulator call. Nothing was implemented, migrated or committed in this phase; the audit was read-only on branch `Delve`.

Five findings drive the design:

- **The current model cannot be stretched.** A room holds exactly one content item, a fight has exactly one enemy, the map must be a DAG, and a node resolves in one atomic step. There is no step cursor and no flag store.
- **Zones are a single mutable row.** `dungeon_zones` has an optimistic `revision` counter but no history, no draft/published state and no audit table. Runs survive edits only because each run copies the whole zone.
- **World Encounter infrastructure is thinner than its name suggests.** Checks are pure and reusable today. Conditions have five kinds, no composition, and one (`requiresItem`) is never enforced. Effects are a clean apply-in-transaction core with three hard-coded world-encounter strings.
- **Two global services block guaranteed recruitment and safe rewards.** Owned Waifumon are created only inline inside `captureService.attemptCapture`, with no provenance or idempotency key. Item and WaifuBux grants have no idempotency key at all.
- **No existing importer meets the staging-to-production requirement.** The encounter importer has plan/apply and a log but no conflict detection; bosses and reward tables have `expectedRevisions` but no multi-entity packages; managed artwork ids are per-environment and nothing resolves assets by content hash.

The proposed shape, in one paragraph: dungeons are authored as a draft document (rooms, connections, per-room action lists) plus a separate layout document; publishing compiles the draft and the catalogue events it references into an immutable revision; a run pins one revision and advances a cursor one step per interaction under a row lock; every grant goes through one claims table that makes delivery idempotent; and a versioned JSON package (optionally zipped with artwork) moves drafts between environments.

Six decisions need a ruling before Phase 1 starts; they are listed in the last section. The two with the largest blast radius are dropping procedural generation and adding provenance columns to `player_waifus`.

Throughout this document, sections 1 and 2 are **confirmed repository findings**. Everything from section 3 onward is **proposed design** unless a sentence says otherwise.

## 1. Current system inventory (confirmed)

Every statement here was read in code on `Delve`, not taken from `docs/`. Items that could not be verified are listed at the end of the section.

### 1.1 Dungeon runtime, navigation and persistence

| Area | Finding | Where |
| --- | --- | --- |
| Zone document | One JSON document per zone, validated by `DungeonZoneDefinitionSchema`, stored in `dungeon_zones.definition` (jsonb, PK `zone_key`) | `src/modules/dungeons/zoneDefinition.ts:610-680`, `src/db/schema.ts:3007-3041` |
| Node types | Eight: combat, elite, event, reward, rest, miniboss, boss, exit | `zoneDefinition.ts:45-54` |
| Layout modes | `procedural` (seeded generator) and `authored` (`rooms[]` with `next[]`); both compile to one `DungeonGraph` | `dungeonGenerator.ts:91-149`, `:539`; `authoredLayout.ts:268` |
| Authored limits | DAG only (loops refused), one room = one node, max 40 rooms, 3 exits per room | `authoredLayout.ts:200-204`, `zoneDefinition.ts:105-111` |
| Versioning | Integer `revision` as optimistic lock plus `contentHash`/`seedHash`. No history, no draft/published state; only an `enabled` flag | `dungeonZoneService.ts:379-408`, `schema.ts:3007-3040` |
| Run snapshot | A run copies the graph and a full zone snapshot at start: zone, enemies, events, reward tables, scenes, artwork ids | `dungeonRunService.ts:103-142`, `:371-425` |
| Run row | `dungeon_runs`: seed, status, `currentNodeId`, `currentHp`, `unbankedCurrency`, `securedRewards`, `fighter`, `nodeStates`, `settlement`. One active run per player by partial unique index | `schema.ts:3145-3189` |
| Node state | `nodeStates[nodeId] = {status: entered or completed, resolution}`. No flags or variables | `dungeonRunState.ts:250-258` |
| Progression | Two calls per node: `enterNode`, then `resolveNode`; plus `extract` and `abandon`. No backtracking | `dungeonPlayService.ts:1051-1129` |
| Event log | Append-only `dungeon_run_events`, 12 types, written in the same transaction as the state change | `schema.ts:3193-3206`, `dungeonPlayService.ts:597-601` |
| Concurrency | Every mutation starts with `SELECT … FOR UPDATE` on the run row; outcomes are `applied`, `replayed` or `refused` | `dungeonPlayService.ts:552-561`, `:294-295` |
| Daily allowance | `dungeon_settings.daily_run_limit` and `dungeon_daily_usage`; consumed inside the start transaction, never refunded | `dungeonAllowanceService.ts:198-218` |
| Discord | Custom ids under the `dg` prefix carry action, run id and node id; the id is the transition, with no nonce. A scene image is composed and attached per screen | `dungeonPresenter.ts:80-91`, `discord/dungeonArtwork.ts:198` |

### 1.2 Dungeon combat

- **Buddy stats** are frozen once at run start: `combatStats.snapshotCombatStats(tx, playerId)` builds the `fighter` from current SP and the three equipped slots, with modifiers from `aggregateCombatBonuses` (`dungeonPlayService.ts:906`, `equipment/equipmentMath.ts:165-198`).
- **One enemy per fight node.** A node's content is a single enemy key and `fightEnemy` takes one enemy. There are no waves and no multi-enemy fights anywhere in the engine today.
- **Fights are atomic and server-side.** One `resolveNode` call runs `simulateCombat` to the end (`dungeonRunState.ts:511-554`). The engine itself is step-wise, but no interactive mode is built.
- **RNG is seeded per node** from the run seed and node id (`dungeonRunState.ts:560-570`), so a retried request replays the same fight.
- **HP persists** in `dungeon_runs.current_hp` between nodes. A loss or a 30-round stalemate ends the run as `defeated`.
- **Enemies are DB-backed** (`combat_enemies`), seeded from `content/combat/enemies.json`; enemy selection happens when the graph is built.

### 1.3 Existing editor, admin API and validation

- **Portal stack:** React 19, react-router 7, TanStack Query 5, Tailwind v4, Radix. No graph, canvas or drag-and-drop dependency of any kind (`portal/package.json`).
- **Editor:** `portal/src/features/adminDungeons/`, about 5,540 lines of source and 3,810 of tests. Rooms are edited as an indented outline (`AuthoredRoomsEditor.tsx`, 776 lines); the only map is a read-only CSS view (`DungeonGraphView.tsx`). No room coordinates exist in the schema.
- **Save model:** whole-zone `PUT` with `expectedRevision`; a `409 DUNGEON_ZONE_STALE` offers a reload. Server-side dry-run validation on every change.
- **API:** `src/api/routes/v1/admin/dungeons.ts` has list, reference, export, validate, preview, simulate, get, create, update, enable, artwork browse, settings and currencies. There is no delete and no import route.
- **Validation:** `zoneValidation.ts` returns `{path, message, severity}` issues across schema, references, managed asset ids and reachability. Errors block the save; layout problems are downgraded to warnings on a disabled zone. Shipped artwork paths are not checked for file existence.
- **Simulation:** `dungeonSimulation.ts` simulates procedural generation only, over up to 20,000 seeds. It runs no combat, rewards or progression, and refuses authored zones.

### 1.4 Dungeon events

An event today is `{key, name, description, enabled, artworkPath, tags, hpChangeBasisPoints, paysReward}` in `content/dungeons/events.json` (three events). There is no table and no Portal editing. Only the HP delta and the pays-reward flag are data-driven; there are no choices, checks, conditions or branches (`eventDefinitions.ts:30-47`). Nothing is shared with World Encounters, by stated intent (`eventDefinitions.ts:9-12`).

### 1.5 Loot, items, equipment and currency

| Service | Signature and behaviour | Idempotency | Where |
| --- | --- | --- | --- |
| Reward tables | `reward_tables`, PK `(kind, table_id)`, whole table as one jsonb document. `kind` is CHECK-limited to `boss` or `expedition`. No owner or scope. A guaranteed drop is a group at 10000 bp with one entry | n/a | `schema.ts:2892-2916`, `rewardTableCore.ts:39` |
| Table rollers | Two pure rollers, each owned by its feature. Delve borrows `rollExpeditionTable` against `expedition`-kind tables and ignores their essence and XP | Deterministic from ids | `expeditions/expeditionRewards.ts:200`, `dungeonRunState.ts:365-383` |
| Equipment | `grantRandomEquipmentReward` and `grantChosenEquipmentReward` take a `tx`; a fully fixed roll exists on `equipmentService.grantEquipment`. `source_type` already includes `dungeon` and `quest` | `grantKey`, global partial unique index | `equipmentRewardService.ts:134-302`, `schema.ts:2611` |
| Items | `inventory.addItem(tx, playerId, itemId, quantity)`; plain upsert, no ledger | **None** | `inventory/inventoryService.ts:63` |
| WaifuBux, Essence | `currency.grant*(tx, playerId, amount)`; columns on `player_currencies`, no ledger | **None** | `currency/currencyService.ts:18-46` |
| Progression currency | `progressionCurrency.grant(tx, {…, requestKey})` with a ledger | Unique `(player, currency, requestKey)` | `progressionCurrencyService.ts:79-165`, `schema.ts:3096-3123` |

There is no unified reward-bundle service; bosses, expeditions, world encounters and Delve each assemble their own. Delve's `grantRewards` (`dungeonPlayService.ts:622-674`) is the closest template. Items, equipment definitions and species are all addressed by stable string slugs; numeric ids are per-environment.

### 1.6 Waifumon encounter, capture and ownership

- **Scripted spawn exists and is reusable:** `wildEncounterSpawner.createWildEncounter({playerId, speciesSlug or selection, regionId, origin: {kind, ref}, tx})` accepts a transaction and is idempotent through a unique index on `(origin_kind, origin_ref)` (`src/modules/encounters/wildEncounterSpawner.ts:77-113`, `schema.ts:591`). Origin kinds do not include `dungeon`.
- **One active encounter per player.** A spawn returns `blocked` if the player already has one (`schema.ts:585`).
- **Capture owns its transaction.** `captureService.attemptCapture` opens `db.transaction` itself and takes no `tx` (`src/modules/capture/captureService.ts:298`, `:820`). Its only caller is the Discord hunt command.
- **Ownership creation is inline.** The only production `insert(playerWaifus)` sits inside `attemptCapture` (`captureService.ts:1038-1045`). There is no standalone grant function, no admin grant, no starter grant.
- **No provenance.** `player_waifus` has no acquisition-source or grant-key column, and duplicates of a species are allowed (`schema.ts:650-721`).
- **Species eligibility is region-pool membership.** Species carry no region field; a region lists its `encounterPool`, seeded into `region_encounter_pools`. There is no dedicated "not in the wild" flag. An enabled, unpooled species tagged `region_exclusive` is excluded from the hunt and the global fallback but can still be spawned by slug (`huntService.ts:290`, `encounters/speciesSelection.ts:256`).
- **Buddy and SP:** `players.buddy_waifu_id`, read through `resolveActiveBuddy`; SP is `currentSeductivePower(baseSp, level, maxLevel)` (`collection/collectionService.ts:1040`, `power/seductivePower.ts:189`).

### 1.7 World Encounter infrastructure

| Piece | Finding | Where |
| --- | --- | --- |
| Model | Encounter row, choices as rows, each choice with exactly two outcome branches as jsonb. No revisions; saves are last-write-wins and re-mint choice ids | `schema.ts:1610-1746`, `worldEncounters/adminService.ts:297-364` |
| Conditions | One type, `RequirementsSchema`: affinity, raceAny, minPlayerLevel, minBuddyLevel, requiresItem, AND-only. The evaluator is a private closure. `requiresItem` is approved without checking | `worldEncounters/types.ts:218-228`, `worldEncounterService.ts:758-784` |
| Checks | Kinds `none` and `sp`. `computeChance` and `rollCheck(check, ctx, rng)` are pure. Production uses unseeded `Math.random` | `checkResolver.ts:116`, `:208`; `worldEncounterService.ts:444` |
| Effects | 16 kinds. `apply(tx, ctx, effects)` always uses the caller's transaction. Hard-coded `world_encounter` strings in XP events, equipment source and grant-key prefix | `effectExecutor.ts:223-525` |
| Follow-ups | `trigger_encounter`, `open_vendor`, `trigger_waifumon_encounter` are only tagged by the executor and carried out inside the encounter lifecycle | `worldEncounterService.ts:890-1026` |
| Flag store | None. No per-player key/value flags exist anywhere in the schema | `schema.ts` (search) |

### 1.8 Artwork and asset resolution

- **Managed artwork:** `artwork_assets` with categories including `dungeon_zone`, `dungeon_background`, `enemy_sprite`, `enemy_art`, `event_art`, `npc_portrait`. Ids are random UUIDs per environment. A sha256 `content_hash` column exists but has no index and nothing looks assets up by it (`schema.ts:3325-3339`, `artworkAssets/artworkAssetService.ts:337`).
- **Shipped artwork** lives in git under `assets/`. `assets/dungeons/` does not exist on this branch, although the dungeon picker is rooted there.
- **Delete guard:** `referencesOf` scans zone documents, enemies and bosses (`artworkAssetService.ts:261-310`). Any new content store must be added to that scan.
- **Scenes:** background, Buddy sprite and enemy sprite are composed server-side into a cached WebP, with a preview endpoint at `POST /admin/artwork/scene-preview`.

### 1.9 Authentication, authorization and audit

- **Permissions** are a closed list in `portalAuth/portalAuthService.ts:38-103`, checked per route by `requirePortalPermission`. `dungeons.read` and `dungeons.write` exist; a publish permission has precedent in `encounters.publish`.
- **Audit is per feature.** There is no generic admin audit log. `boss_definition_events` and `artwork_asset_events` are the append-only shapes to copy. Dungeon zones have no audit table at all.
- **Staging tools:** Test Controls act on real players and are refused at boot in production. The load-test fixture is the only mechanism that creates synthetic players. No sandbox mode exists for Delve runs.

### 1.10 Existing import and export

| Feature | Plan / apply | Conflict detection | Log | Notable gap |
| --- | --- | --- | --- | --- |
| World encounters | Pure `planImport`, transactional apply with in-transaction re-plan; multi-entity (vendors bundled) | None; updates overwrite silently | `world_encounter_import_log` | No manifest, no content hash |
| Equipment | Same pattern, `FOR UPDATE` on existing rows, create race mapped to a conflict error | Domain refusals only | `equipment_import_log` | No `expectedRevisions` |
| Bosses | Plan with `currentRevision`; apply with `skip` or `overwrite` and `expectedRevisions` | Yes | Audit events only | Unknown managed artwork id is an error |
| Reward tables | `expectedRevisions` required for every entry | Yes, whole import goes stale | None | Single entity type |
| Enemies | Export only | n/a | n/a | **No import exists** |
| Dungeon zones | Export only | n/a | n/a | **No import exists** |

### 1.11 Not verified

- Whether `encounters.origin_kind` is constrained by a database CHECK.
- Whether `snapshotCombatStats` locks loadout rows.
- `src/modules/dungeons/dungeonPlaythrough.ts` (307 lines) was not read; it may be a playthrough simulator.
- Whether the API already has multipart upload or a ZIP library; boss artwork upload suggests an upload path exists.
- The absence of a Waifumon collection cap rests on a search, not a full read.

## 2. Reuse, refactor, replace

Roughly a third of the dungeon code survives intact, and all of it sits below or beside the content model: combat, stats, allowance, scenes, auth. The content model, the resolver and the editor body are replaced.

### Retain as-is

| Component | Why |
| --- | --- |
| `src/modules/combat/*` engine, math, simulator | Generic, seeded, step-wise, no dungeon coupling |
| `equipment/combatStatsService` and the fighter snapshot | Clean freeze-at-entry; unchanged by the new design |
| Enemy Catalogue (`src/modules/enemies/*`, `combat_enemies`) | Already DB-backed with where-used lookup; gains one new reference source |
| `dungeonAllowanceService`, `dungeon_settings`, `dungeon_daily_usage` | Independent of the content model |
| Scene composition (`artworkAssets/scenePlacement.ts`, `sceneComposition.ts`, `discord/dungeonArtwork.ts`) and the scene-preview endpoint | Presentation only; reusable from a room inspector |
| `equipmentRewardService`, `progressionCurrencyService` | Both take a `tx` and an idempotency key today |
| `wildEncounterSpawner.createWildEncounter` | Takes a `tx` and an origin; needs only a `dungeon` origin kind |
| `checkResolver.computeChance` / `rollCheck` | Pure with injected RNG |
| Portal auth, `requirePortalPermission`, route allowlist and architecture tests | Adding a permission is a few lines with precedent |
| Portal form parts: `RewardsSection.tsx`, `ZoneBackgroundPool.tsx`, `zoneFormParts.tsx`, `adminEncounters/EquipmentRewardFields.tsx`, `effectDefaults.ts`, `describe.ts` | Props-driven; usable inside inspector panels |

### Refactor

| Component | What changes |
| --- | --- |
| Lock / replay / refuse pattern in `dungeonPlayService.ts` | Keep the pattern; move it out of the node-type branches into one step function with a step counter |
| Settlement and banking (`settle()`, unbanked progression currency) | Keep the rules; re-home them in the new run service |
| `grantRewards` | Becomes the claims-backed delivery service (section 5.5) so items and WaifuBux gain idempotency |
| Table rolling | Extract one neutral group roller from `rollExpeditionTable` instead of borrowing the expedition roller and its numeric draw id |
| `worldEncounters/effectExecutor.ts` | Parameterise source, reference and grant-key prefix; split shared resource effects from world-encounter-only follow-ups |
| `RequirementsSchema` and `isChoiceAvailable` | Extract to a shared pure module; extend into a composable condition union; enforce `requiresItem` |
| `captureService.ts:1017-1052` | Extract `createOwnedWaifu(tx, …)`; add provenance and a grant key to `player_waifus` |
| `artworkAssetService` | Add lookup by `(category, content_hash)`; extend `referencesOf` to the new content tables |
| `adminEncounters/EffectEditor.tsx` | Accept a neutral reference type instead of `AdminEncounterReference` |
| `DungeonZoneEditorPage.tsx`, list, create and preview pages | Keep the validate / 409 / dirty-state shell; swap the body for the canvas and add revision and publish states |
| `waifumonDungeon.ts`, `dungeonPresenter.ts` | Keep the `dg` id scheme and error recovery; screens become cursor-driven |
| `zoneValidation.ts` | Keep the issue shape and staging; rules are rewritten for the new model |

### Replace

| Component | Why |
| --- | --- |
| `zoneDefinition.ts`, `authoredLayout.ts` | DAG-only, one content item per room, three exits; none of these survive the requirements |
| `dungeonRunState.ts` node resolution | Hard-coded one-node-one-effect; no sequences, no cursor |
| `dungeon_zones` table | A revision counter is not revisioned content |
| `dungeon_runs` columns `graph`, `zoneSnapshot`, `nodeStates` | Replaced by a revision reference, a cursor and room states |
| `eventDefinitions.ts`, `content/dungeons/events.json` | Two scalar fields, file-only, no choices |
| `AuthoredRoomsEditor.tsx`, `DungeonGraphView.tsx` | The outline editor and read-only map are what the canvas supersedes |
| `dungeonGenerator.ts`, `dungeonSimulation.ts`, `ProceduralSettings.tsx` | Tied to the old node model; see open decision 1 on dropping procedural generation |

The encounter importer's code is not reused, because it is typed to encounters and vendors. Its structure is: a pure `planImport` and a transactional apply that re-plans inside the transaction and writes a log row.

## 3. Proposed architecture

The system has three stages (author, publish, play) and one rule that ties them together: a run only ever reads an immutable published revision, and only ever changes the world through a small effects port.

&#91;embedded content: dungeon architecture · authoring, publishing and runtime\]

Read the top lane left to right for authoring, then follow the revision down into the runtime lane; the two highlighted boxes are the only things a run depends on.

### 3.1 The two content layers

**Dungeon Map.** A directed graph of rooms and connections. Cycles are allowed, so shortcuts and returning to a hub work. A connection has a source room, a target room, an optional `requires` condition (a locked path), an optional label and a `kind` (`path`, `shortcut` or `secret`). A room is an entrance, a normal room or an exit; an exit room ends the run as completed when its sequence finishes.

**Room Sequence.** Each room owns an ordered list of actions. By default an action hands over to the next one in the list. An action may instead name a later action in the same room as its target, per outcome. Jumps only go forward, so a sequence always terminates. This is deliberately a list with forward jumps, not a workflow engine: there are no loops, variables, parallel branches or sub-sequences.

The canvas shows both layers but owns neither. Positions, viewport and editor notes live in a separate layout document that the runtime never reads.

### 3.2 Components and responsibilities

| Component | Location (proposed) | Responsibility |
| --- | --- | --- |
| Content schema | `src/modules/dungeons/content/` | Zod schemas for dungeon, room, connection, action, event, loot table, encounter; the single authoritative data model |
| Validator | `src/modules/dungeons/validation/` | Pure: schema, references, graph analysis, sequence analysis, asset checks. Returns `{path, severity, code, message}` |
| Draft service | `src/modules/dungeons/dungeonDraftService.ts` | Draft CRUD with optimistic revisions, layout storage, audit events |
| Event catalogue service | `src/modules/dungeons/dungeonEventService.ts` | CRUD for standalone dungeon events, where-used lookup |
| Publisher | `src/modules/dungeons/dungeonPublishService.ts` | Validate, compile draft plus referenced events into an immutable revision, move the published pointer, rollback |
| Run engine | `src/modules/dungeons/engine/` | **Pure.** `step(state, input, content, rng) -> {state, effects[], view}`. No database, no Discord |
| Effects port | `src/modules/dungeons/engine/effectsPort.ts` | Interface the engine's effects are applied through. Two implementations: live and sandbox |
| Run service | `src/modules/dungeons/dungeonRunService.ts` | Locks the run row, calls the engine, applies effects through the live port, appends run events, all in one transaction |
| Reward delivery | `src/modules/dungeons/dungeonRewardService.ts` | Claims table, deterministic rolls, calls global grant services |
| Waifumon bridge | `src/modules/dungeons/dungeonWaifumonService.ts` | Spawns wild encounters, observes their result, performs guaranteed recruitment |
| Simulator | `src/modules/dungeons/dungeonSimulator.ts` | Runs the engine with the sandbox port for playthroughs and Monte Carlo runs |
| Package | `src/modules/dungeons/package/` | Export, pure `planImport`, transactional `applyImport`, import log |
| Shared rules | `src/modules/gameRules/` | Conditions, checks and resource effects extracted from World Encounters; used by both systems |
| Admin API | `src/api/routes/v1/admin/dungeons.ts`, `dungeonEvents.ts` | Thin routes over the services above |
| Portal | `portal/src/features/adminDungeons/` | Canvas, inspector, sequence editor, event editor, import/export, test panel |
| Discord | `src/discord/commands/waifumonDungeon.ts`, `dungeonPresenter.ts` | Renders the engine's `view`; one button press is one `step` |

### 3.3 Why a pure engine with an effects port

This is the central architectural choice, so the alternatives are worth stating.

- **Alternative A: keep logic in the service, as today.** `resolve()` mixes rules, SQL and grants. A simulator would then need a second implementation of every rule, and the two would drift. Rejected.
- **Alternative B: run the real service against a scratch database for testing.** Faithful, but slow, impossible in a browser preview, and unsafe to offer in production. Kept only as the top testing tier.
- **Chosen: one pure step function.** The engine decides what happens and emits effects such as `grantReward`, `setFlag`, `spawnWildEncounter` or `endRun`. The live port turns them into transactional writes; the sandbox port records them and changes nothing. The simulator, the Portal test panel and production all execute the same rules.

The cost is discipline: the engine may not read the database, so everything a step needs (flags, claim history, encounter results) must be loaded into the state before the call. That set is small and enumerable.

### 3.4 Lifecycle of content

1. An admin edits a **draft**. One draft exists per dungeon. Saves are whole-document with `expectedRevision`, as today.
2. **Publish** validates the draft with errors blocking, resolves every referenced catalogue event, and writes a new immutable **revision** containing the compiled content. The dungeon's published pointer moves to it.
3. A **run** records the revision id at start and never follows the pointer again.
4. **Rollback** moves the pointer to an earlier published revision. No content is copied or rewritten.

### 3.5 What freezes when

| Content | Frozen at | Reason |
| --- | --- | --- |
| Rooms, connections, sequences, dungeon loot tables, dungeon encounter definitions | Publish | Owned by the dungeon |
| Catalogue events referenced by the dungeon | Publish (copied into the revision) | An event edit must not reach a published dungeon silently |
| Enemy stats, global reward tables | Run start (copied into the run) | Global, mutable, balance-tuned independently; today's behaviour |
| Buddy stats and gear | Run start | Unchanged from today |
| Items, species, equipment definitions | Never; resolved by slug at grant time | Authoritative global definitions, not duplicated |

Freezing enemies at run start rather than at publish means a balance change to an enemy reaches new runs without republishing every dungeon. Open decision 4 covers the alternative.

## 4. Dungeon content schema examples

These are illustrative shapes for review, not final field names. Every id is a string chosen by the author and stable across saves, exports and imports; nothing in a definition is a numeric database id.

### 4.1 Dungeon definition (gameplay semantics)

```json
{
  "key": "service_tunnels",
  "name": "The Service Tunnels",
  "description": "Something is living in the maintenance level.",
  "availableRegions": ["waifu-valley"],
  "entranceRoomId": "gate",
  "artwork": { "kind": "shipped", "path": "dungeons/zones/service_tunnels.webp" },
  "settings": {
    "progressionCurrency": "ascension_currency",
    "defeatCurrencyRetentionBasisPoints": 5000
  },
  "rooms": [ "…see 4.2…" ],
  "connections": [
    { "id": "c1", "from": "gate", "to": "pump_room" },
    { "id": "c2", "from": "gate", "to": "locker_room", "label": "Side door" },
    { "id": "c3", "from": "pump_room", "to": "boss_den",
      "requires": { "flag": "valve_opened", "scope": "run" },
      "lockedText": "The bulkhead is sealed." },
    { "id": "c4", "from": "locker_room", "to": "gate", "kind": "shortcut" }
  ],
  "lootTables": { "…see 4.4…": {} },
  "encounters": { "…see 4.5…": {} }
}
```

### 4.2 A room and its sequence

This room is *Event → Choice → Combat → Rescue → Room Complete*, with one optional chest.

```json
{
  "id": "pump_room",
  "name": "Pump Room",
  "kind": "room",
  "background": { "kind": "managed", "category": "dungeon_background",
                  "contentHash": "sha256:9f2c…", "name": "pump-room.webp" },
  "extraction": false,
  "actions": [
    { "id": "a1", "type": "event", "eventKey": "trapped_technician",
      "outcomes": { "fight": "a2", "sneak": "a3" } },

    { "id": "a2", "type": "combat",
      "waves": [
        { "enemy": { "key": "sewer_gremlin" } },
        { "enemy": { "pool": [ { "key": "sewer_gremlin", "weight": 3 },
                                { "key": "pipe_lurker", "weight": 1 } ] } }
      ] },

    { "id": "a3", "type": "rescue", "encounterId": "technician_rescue" },

    { "id": "a4", "type": "reward", "optional": true, "label": "Open the tool locker",
      "reward": { "policy": "per_run",
                  "guaranteed": [ { "item": "basic_charm", "quantity": 2 } ],
                  "tables": [ { "dungeonTable": "tunnel_common" } ] } },

    { "id": "a5", "type": "set_flag", "flag": "valve_opened", "scope": "run", "value": true }
  ]
}
```

### 4.3 Action types

| Type | Key fields | Outcomes it can report |
| --- | --- | --- |
| `combat` | `waves[]`, each one enemy by key or weighted pool; `onDefeat` | `victory`, `defeat` |
| `boss` | Same as combat; marks the scene and summary as a boss fight | `victory`, `defeat` |
| `reward` | `reward` bundle (section 4.4) | `claimed`, `already_claimed` |
| `event` | `eventKey` into the catalogue | Whatever outcome labels the event declares |
| `choice` | Inline prompt and options, each with optional `requires` | One label per option |
| `wild_encounter` | `encounterId` | `captured`, `not_captured`, `unavailable` |
| `rescue` | `encounterId` | `rescued`, `failed`, `unavailable` |
| `gate` | `requires`, `failText`, `onFail` | `passed`, `blocked` |
| `set_flag` / `objective` | `flag`, `scope`, `value`; an objective also has display text | none |
| `rest` | `healBasisPoints` | none |
| `leave` | `connectionId`, or `endRun: completed` | none; the room ends here |

Every action also accepts `when` (a condition; the action is skipped silently when false), `optional` (the player is offered a skip button) and `label`.

### 4.4 Reward bundle and a dungeon loot table

```json
{
  "policy": "once_per_player",
  "when": { "not": { "flag": "cache_looted", "scope": "player" } },
  "guaranteed": [
    { "item": "rusty_key", "quantity": 1 },
    { "equipment": { "definitionKey": "rusty_pipe" } },
    { "equipment": { "definitionKey": "glitch_earring",
                     "fixed": { "multiplierBp": 42000, "affixKey": null, "combatBonuses": [] } } },
    { "currency": "waifubux", "amount": 250 },
    { "currency": "ascension_currency", "amount": 3 }
  ],
  "tables": [
    { "dungeonTable": "tunnel_common" },
    { "globalTable": { "kind": "expedition", "id": "scrapheap-standard" },
      "when": { "minBuddyLevel": 10 } }
  ]
}
```

A dungeon loot table uses the existing reward-group shape, so the editor and roller are shared with global tables:

```json
{
  "tunnel_common": {
    "groups": [
      { "id": "scrap", "rolls": 2, "chanceBasisPoints": 10000,
        "entries": [ { "itemId": "scrap_metal", "weight": 5, "quantity": [1, 3] } ] },
      { "id": "gear", "rolls": 1, "chanceBasisPoints": 1500,
        "equipment": [ { "rarity": "R", "weight": 1 } ] }
    ]
  }
}
```

### 4.5 Dungeon Waifumon encounters

```json
{
  "tunnel_wilds": {
    "mode": "capture",
    "pool": [ { "species": "sewer_slime", "weight": 4 },
              { "species": "pipe_nymph", "weight": 1 } ],
    "policy": "per_run",
    "onNotCaptured": "continue"
  },
  "technician_rescue": {
    "mode": "recruit",
    "species": "grease_angel",
    "policy": "until_acquired",
    "onFailed": "retry_next_run",
    "intro": "She wipes her hands on her overalls and grins.",
    "completionFlag": { "flag": "technician_rescued", "scope": "player" }
  }
}
```

### 4.6 A catalogue event

```json
{
  "key": "trapped_technician",
  "title": "A voice behind the grate",
  "body": "Someone is hammering on the far side of a flooded hatch.",
  "artwork": { "kind": "shipped", "path": "encounters/door_within_door.webp" },
  "choices": [
    { "id": "force", "label": "Force the hatch",
      "check": { "type": "sp", "baseChance": 0.45, "maxSpModifier": 0.35 },
      "success": { "text": "The hatch gives.", "outcome": "sneak",
                   "effects": [ { "type": "buddy_xp", "amount": 40 } ] },
      "failure": { "text": "The noise brings company.", "outcome": "fight",
                   "effects": [ { "type": "hp_change", "basisPoints": -1000 } ] } },

    { "id": "key", "label": "Use the rusty key",
      "requires": { "hasItem": "rusty_key" },
      "success": { "text": "It turns.", "outcome": "sneak",
                   "effects": [ { "type": "consume_item", "item": "rusty_key", "quantity": 1 } ] } },

    { "id": "leave", "label": "Walk away",
      "success": { "text": "The hammering fades behind you.", "outcome": "fight",
                   "followUp": [ { "type": "combat", "waves": [ { "enemy": { "key": "pipe_lurker" } } ] } ] } }
  ]
}
```

### 4.7 Layout document (editor only)

```json
{
  "viewport": { "x": -120, "y": 40, "zoom": 0.8 },
  "rooms": { "gate": { "x": 0, "y": 0 }, "pump_room": { "x": 320, "y": -80 } },
  "notes": [ { "id": "n1", "x": 300, "y": 200, "text": "Act 2 starts here" } ]
}
```

## 5. Room sequence and event execution

One player interaction is one engine step, one transaction and one increment of the run's step counter. The run's position is a cursor: `{roomId, actionId, waveIndex?, eventFrame?}`.

### 5.1 How actions transition

1. On entering a room, the cursor moves to the room's first action whose `when` holds.
2. The engine presents the action. Some actions need input (a choice, a fight button, a skip); others resolve immediately and chain to the next within the same step (`set_flag`, a passed `gate`, a skipped action).
3. When an action resolves it reports an outcome label. If the action maps that label to a target action id, the cursor jumps there. Otherwise it moves to the next action in the list.
4. Targets must be later in the list. The validator rejects backward and unknown targets.
5. Falling off the end of the list completes the room.

**Retry without loops.** A failed attempt that may be retried does not jump backward; the cursor simply stays on the action and an attempt counter rises. `maxAttempts` bounds it, after which the action reports its failure outcome.

### 5.2 Optional actions

`optional: true` adds a skip button; skipping reports the outcome `skipped` and moves on. `when` is different: the action is never shown and leaves no trace beyond a run event. An optional action that was skipped stays skipped for that room visit.

### 5.3 Room completion and leaving

- A room is **complete** when its cursor passes the last action or reaches a `leave` action. Completion is stored once in `roomStates[roomId]`.
- On completion the player is shown the room's outgoing connections. A connection whose `requires` fails is shown locked with its `lockedText`, or hidden if marked `secret`.
- A `leave` action with a `connectionId` moves the player straight through that connection, which is how a choice sends the player to a specific room.
- **Re-entering a completed room** skips its sequence and shows its connections. An action marked `repeatOnReentry` (a rest point, a repeatable farm fight) runs again.
- An exit room ends the run as `completed` when its sequence finishes. Extraction stays a per-room flag, as today.

### 5.4 Combat and waves

- A `combat` or `boss` action holds a `waves` array of any length. The engine has no wave cap; the validator warns above a soft threshold so an accidental 40-wave room is noticed.
- Each wave is one fight against one enemy, resolved by the existing `simulateCombat`. HP carries from wave to wave and is saved after each, with `waveIndex` in the cursor, so a restart mid-action resumes at the right wave.
- The seed for a fight is derived from run seed, room id, action id, visit number and wave index. A retried request replays the same fight.
- Defeat ends the run as `defeated` by default. `onDefeat` may instead name a later action, which allows scripted losses.
- Whether waves resolve one per click or all in one click is a presentation setting on the action; the persisted result is identical.

Fights with several enemies on screen at once are **not** in this design. The engine is strictly one-versus-one today, and changing that is a combat project, not a dungeon one (open decision 5).

### 5.5 Reward delivery

Every grant in a dungeon, from any action or event, goes through one function: `deliver(tx, claimKey, bundle, context)`.

1. Build the claim key from the policy: `run:<runId>:<roomId>:<actionId>:<visit>` for `per_run`, `player:<dungeonKey>:<rewardId>` for `once_per_player`.
2. `INSERT … ON CONFLICT DO NOTHING` into `dungeon_claims` on `(player_id, claim_key)`.
3. If the insert did nothing, return the stored result and grant nothing. This is the replay path.
4. Otherwise roll the tables with a seed derived from the claim key, store the rolled result on the claim row, and call the global services in the same transaction: `inventory.addItem`, `currency.grant*`, `equipmentRewards.grant*` with `grantKey = dungeon:<claimId>:<index>`.
5. Progression currency is added to the run's unbanked total and paid once at settlement with the existing `requestKey`, preserving today's risk rule.

The claim row is what makes item and WaifuBux grants safe, since those services have no key of their own. Because the claim, the grants and the cursor move commit together, a crash leaves either all of them or none.

**Alternative considered:** add a ledger and request key to `inventory` and `currency`. It is the better long-term answer but touches every system that grants items. The claims table solves it for dungeons without that blast radius and does not prevent the ledger later.

### 5.6 Standalone dungeon events

An event is a catalogue entry with text, artwork and choices. It does not know which room it is in.

- Each choice may have `requires` (a condition) and a `check`. With a check it has `success` and `failure` branches; without one, only `success`.
- Each branch has display text, a list of `effects`, an optional `followUp` list and an `outcome` label.
- The **outcome label is the event's whole contract with the room.** The room's event action maps labels to later actions. An unmapped label continues to the next action.
- `followUp` holds inline actions (`combat`, `reward`, `wild_encounter`, `rest`) that run before control returns to the room. This is how an event triggers a fight and stays reusable across rooms. Follow-ups may not contain events or choices, so nesting is exactly one level deep and the cursor needs one `eventFrame`, not a stack.
- Checks are rolled with a seed from run seed, room, action and choice, so a retried click cannot re-roll.

**Independence from World Encounters.** Dungeon events share three pure libraries with World Encounters and nothing else: conditions, checks, and resource effects. They have their own table, editor, lifecycle and package format. They never read or write `world_encounters`, `active_world_encounters`, history or cooldown rows, and the world-encounter-only effects (`trigger_encounter`, `open_vendor`) are not in the dungeon effect list.

### 5.7 Shared rules module

| Rule | Source today | Shared form | Dungeon additions |
| --- | --- | --- | --- |
| Conditions | `RequirementsSchema`, five AND-only kinds | Discriminated union with `all`, `any`, `not`; evaluator takes a plain context object | `flag`, `hasItem` (enforced), `currencyAtLeast`, `ownsSpecies`, `claimed`, `roomCompleted`, `hpBelow` |
| Checks | `sp`, `none` | Moved unchanged | `chance` (flat probability) |
| Effects | 16 kinds, world-encounter strings hard-coded | Resource effects with source and key prefix passed in | `hp_change`, `set_flag`, `progression_currency` |

World Encounters keep their current behaviour through a thin adapter that supplies `world_encounter` as the source. Their requirements stay AND-only in the editor until someone chooses to expose composition there.

### 5.8 Flags and objectives

Two scopes, both namespaced by dungeon:

- **run** flags live in `dungeon_runs.flags` and die with the run.
- **player** flags live in `dungeon_player_flags (player_id, dungeon_key, flag_key)` and persist across runs.

An objective is a flag with display text and an optional tracker line on the run screen. Flags must be declared in the dungeon definition, so the validator can catch a condition that reads a flag nothing sets. Cross-dungeon flags are deliberately excluded (open decision 6).

### 5.9 Dungeon Waifumon encounters

**Standard capture.** A `wild_encounter` action picks a species from the encounter's pool with the run seed and calls `createWildEncounter` with origin `dungeon` and reference `<runId>:<roomId>:<actionId>:<attempt>`. The player captures through the normal capture flow, with normal items and odds. On the next dungeon interaction the engine is given the encounter's status and reports `captured` or `not_captured`. If the player already has an active encounter, the action reports that and waits; it does not fail.

**Guaranteed recruitment and rescue.** A `rescue` action (or any encounter with `mode: recruit`) grants the Waifumon directly through the extracted `createOwnedWaifu(tx, {playerId, speciesSlug, source, grantKey})`. No capture roll and no item cost. Base SP is rolled the normal way.

**Acquisition is its own record.** Each acquisition writes a `dungeon_claims` row of kind `waifumon` keyed by the encounter, and the new `player_waifus.grant_key` makes the insert itself idempotent. Encounter availability is evaluated against that record:

| Policy | Available when |
| --- | --- |
| `per_run` | Not yet resolved in this run |
| `once_per_player` | No acquisition claim for this encounter |
| `until_acquired` | No acquisition claim for this encounter; failures never consume it |

**The lockout rule.** A rescue has two separate facts: the story is complete (a player flag) and the Waifumon was obtained (an acquisition claim). The encounter's availability reads only the second. Setting `technician_rescued` by another route, or completing the quest while the grant fails, cannot remove the player's access to the species. The validator enforces this: an encounter for a dungeon-exclusive species may not carry a `when` that depends on its own completion flag, and must use `until_acquired` unless the author explicitly overrides with a warning.

**Species eligibility.** Dungeon pools are defined in the dungeon and are independent of `region_encounter_pools`. A dungeon-exclusive species is marked with a new species tag, `dungeon_exclusive`, which excludes it from the hunt and from the global fallback at the two places `region_exclusive` is already checked, and silences the loader's unpooled-species warning. A species may sit in both a region pool and a dungeon pool. The encounter's region is the player's current region, which the spawner requires.

**No second ownership system.** Owned Waifumon remain rows in `player_waifus`. The only additions are two nullable columns, `acquired_via` and `grant_key`.

## 6. Persistence and revisioning

Seven new tables, one rebuilt table and two new columns cover every lifecycle item in the brief. Content is stored as validated JSON documents, as `dungeon_zones` and `reward_tables` already do; rooms and actions are not normalised into rows.

### 6.1 Tables

| Table | Key columns | Purpose |
| --- | --- | --- |
| `dungeon_definitions` | `dungeon_key` PK, `status` (draft, published, disabled), `draft` jsonb, `layout` jsonb, `draft_revision` int, `published_revision_id` FK null, `updated_by` | One row per dungeon: the mutable draft, its editor layout and the published pointer |
| `dungeon_revisions` | `id` PK, `dungeon_key`, `number`, `content` jsonb, `content_hash`, `layout` jsonb, `published_by`, `published_at`, `source` (editor or import) | Immutable published revisions. Unique `(dungeon_key, number)`. Never updated |
| `dungeon_events` | `event_key` PK, `definition` jsonb, `revision` int, `status`, `updated_by` | The standalone event catalogue |
| `dungeon_runs` (rebuilt) | `id`, `player_id`, `revision_id` FK, `seed`, `status`, `step` int, `cursor` jsonb, `room_states` jsonb, `flags` jsonb, `current_hp`, `fighter` jsonb, `dependency_snapshot` jsonb, `unbanked_currency`, `settlement`, `is_test` bool | One run. Keeps the one-active-per-player partial unique index and the completion CHECKs |
| `dungeon_run_events` (kept) | `run_id`, `step`, `type`, `payload` | Append-only run log, now keyed by step |
| `dungeon_claims` | `id`, `player_id`, `claim_key`, `kind` (reward or waifumon), `dungeon_key`, `run_id` null, `revision_id`, `result` jsonb. Unique `(player_id, claim_key)` | Reward claims and Waifumon acquisition records |
| `dungeon_player_flags` | PK `(player_id, dungeon_key, flag_key)`, `value`, `set_at`, `run_id` | Persistent quest flags |
| `dungeon_import_log` | `id`, `actor`, `applied_at`, `package_id`, `package_hash`, `schema_version`, `source_environment`, `filename`, `summary` jsonb | Import history; shape of `equipment_import_log` |
| `dungeon_content_events` | `id`, `entity` (dungeon or event), `entity_key`, `action`, `actor`, `details` jsonb, `created_at` | Admin audit; shape of `boss_definition_events` |

New columns: `player_waifus.acquired_via` and `player_waifus.grant_key` (partial unique index), and an index on `artwork_assets (category, content_hash)`. `dungeon` is added to the encounter origin kinds.

### 6.2 How each lifecycle item maps

| Brief item | Where it lives |
| --- | --- |
| Draft revisions | `dungeon_definitions.draft` with `draft_revision` as the optimistic lock |
| Published revisions | `dungeon_revisions`, immutable |
| Dungeon run state | `dungeon_runs` |
| Room sequence progress | `dungeon_runs.cursor` and `room_states` |
| Quest flag scopes | `dungeon_runs.flags` (run) and `dungeon_player_flags` (player) |
| Acquisition records | `dungeon_claims` kind `waifumon`, plus `player_waifus.grant_key` |
| Reward claim records | `dungeon_claims` kind `reward` |
| Package import history | `dungeon_import_log` |
| Publication history | `dungeon_revisions` rows, plus `publish` and `rollback` rows in `dungeon_content_events` |
| Admin audit | `dungeon_content_events` |

### 6.3 Choices and their alternatives

- **One draft per dungeon, not a draft history.** A full draft-revision history was considered and rejected as redundant: published revisions are the history that matters, and the audit table records who saved what. If undo across sessions is wanted later, it can be added without schema change by writing draft snapshots to the audit `details`.
- **Documents, not rows.** Normalising rooms, connections and actions into tables would give foreign keys but would turn every save, publish, export and import into a multi-table diff. The repository already stores zones and reward tables as documents with Zod validation, and whole-document saves are what the canvas produces.
- **Revision reference instead of a per-run content copy.** Today each run carries the whole zone. With immutable revisions the run holds one foreign key, and only the global dependencies (enemy stats, global reward tables) are copied at start.
- **One claims table, not two.** Reward claims and acquisition records have the same shape and the same uniqueness rule.

### 6.4 Concurrency, retries, restarts and interrupted runs

**Concurrent interactions.** Every step begins with `SELECT … FOR UPDATE` on the run row, scoped by player. Each button carries the step number it was rendered for: `dg|act|<runId>|<step>|<input>`. If the stored step differs, the service changes nothing and returns the current screen. This replaces today's per-node status gate, which cannot distinguish two actions within one room.

**Retries.** A repeated request with the same step either finds the step already advanced (replay, as above) or repeats a step that did not commit, in which case seeds derived from run, room, action and wave reproduce the same result. Grants are covered by the claim key, equipment by `grantKey`, settlement by the existing `requestKey`.

**Process restarts.** Nothing lives in memory. A step is one transaction, so the run is always at a step boundary. Scene images are a cache and are recomposed on demand.

**Interrupted runs.** A run stays `active` and resumes from its cursor on the next interaction, on any day and in any region, as today. A pending wild encounter is re-read on resume; if it expired, the action reports `not_captured` and the encounter's failure rule applies.

**Publishing during runs.** A run is pinned to its revision. New runs use the new revision; active runs finish on the old one. A revision with active runs cannot be deleted.

**Rollback.** Moving the published pointer back takes effect for new runs only. For a harmful revision there is a separate, explicit admin action: retire the revision and settle its active runs as `extracted`, which pays secured rewards and banked currency under the normal rules. Claims already delivered are never reversed.

**Draft edits.** Two admins saving the same draft get the existing 409 flow through `expectedRevision`. Publish takes a row lock on the definition and checks `draft_revision`, so it cannot publish a draft that changed under the reviewer.

### 6.5 Migration of the prototype

No compatibility is kept. The cutover migration settles any active prototype runs as `extracted`, renames the old run table aside, creates the new tables, and leaves `dungeon_zones` in place and unread until a cleanup migration in Phase 6. The two shipped zones are rebuilt by hand in the new editor as the first real test of it.

## 7. Visual editor and testing tools

`@xyflow/react` is the right choice. The Portal has no graph, canvas or drag-and-drop library today, so there is nothing to conflict with or reuse, and the library's current major version supports React 19, which the Portal runs. The version and licence should be confirmed at install time in Phase 1.

### 7.1 Data flow

The editor holds two documents in memory, exactly as the server stores them: the **definition** (gameplay) and the **layout** (positions). The canvas is a projection of both.

- xyflow nodes and edges are derived from the definition on every render; they are never saved.
- Dragging a room changes only the layout. Connecting two rooms, or editing in the inspector, changes only the definition.
- All edits go through one reducer with an undo stack. The Portal has no state library and does not need one for this.
- Saving sends both documents in one `PUT` with `expectedRevision`. A layout-only change saves without bumping the gameplay hash, so moving boxes never looks like a content change in an import diff.
- A room with no stored position is placed by auto-layout. This is what makes an imported or hand-written definition open cleanly.

### 7.2 Features and where they come from

| Requirement | Approach |
| --- | --- |
| Drag-and-drop room creation | Palette of room kinds dragged onto the canvas; xyflow drop handler |
| Visual connections | Room nodes have a target handle and one source handle; dragging creates a connection in the definition |
| Zoom, pan, minimap | Built into xyflow (`Controls`, `MiniMap`, `Background`) |
| Automatic layout | `@dagrejs/dagre` layered layout, run on demand and for unpositioned rooms. `elkjs` was considered; it lays out better but is several times larger and asynchronous, which is not justified for graphs of tens of rooms |
| Multi-selection and duplication | xyflow selection; duplicate copies rooms with fresh ids and keeps connections among the copied set |
| Node inspector | Right-hand panel driven by the selection: room, connection or dungeon settings. Reuses `RewardsSection`, `ZoneBackgroundPool` and `EquipmentRewardFields` |
| Per-room sequence editing | Phase 1: an ordered action list in the inspector with reorder controls. Phase 5: a second canvas scoped to one room, actions as nodes laid out top to bottom |
| Connection-based choice destinations | In the sequence canvas, an event or choice node shows one source handle per outcome label; dragging it to a later action sets the jump. Dragging to the room's exit port and on to another room creates a `leave` action |
| Contextual node creation | Dropping a connection on empty canvas opens a small menu to create the target room or action there |
| Live validation | Debounced server dry-run, as the current editor does; issues are mapped by path to rooms, connections and actions and shown as badges on the canvas and a filterable list |
| Artwork and enemy previews | Room nodes show a background thumbnail and enemy sprites; the inspector embeds the existing scene preview |
| Dungeon-wide navigation | Search box over rooms, actions, events and flags that selects and centres the match; an outline panel listing rooms |
| Advanced configuration | Collapsed "Advanced" groups in the inspector, plus a read-only JSON view of the selected element |

### 7.3 Why the canvas arrives in Phase 1

The brief asks for this and the audit supports it: the existing outline editor is 776 lines that would have to be rewritten for the new model anyway. Writing a new form editor first and a canvas later means building the room editor twice. Phase 1 therefore ships rooms, connections, drag, zoom, the inspector and the list-based sequence editor on xyflow. Phase 5 adds the sequence canvas and the productivity features.

### 7.4 Testing tiers

| Tier | What it is | Covers | Touches real data |
| --- | --- | --- | --- |
| 1. Static validation | Pure analysis of the definition | Unreachable rooms, rooms with no path to an exit, choices with no outcomes, outcome labels the room does not handle, backward or unknown jump targets, conditions on undeclared or never-set flags, missing enemies, tables, species, items and artwork | No |
| 2. Simulation | The real engine with the sandbox effects port | Start from any room or action, step through with chosen inputs, preview dialogue and artwork, inspect flags, see rolled rewards, run combat with a chosen test fighter, Monte Carlo completion and reward rates | No |
| 3. Sandboxed test run | A real run in Discord with `is_test = true` on an unpublished draft | Discord rendering and component limits, scene composition, the step and locking path | No: the run uses the sandbox port for grants, claims and player flags |
| 4. Staging playthrough | A normal run on a published staging revision | The real capture flow, real grants, real settlement, concurrency | Yes, on staging players |

**Purely simulated:** everything in tiers 1 and 2. Progression, branching, combat sequences, flags, reward rolls and dialogue need no database because the engine is pure. Forced outcomes are available in the simulator: pass or fail a check, win or lose a fight, capture or not.

**Needs a real runtime:** Discord presentation, image composition, the wild-capture flow (it consumes items and uses the shared one-active-encounter slot) and anything about transactions. Tier 3 gives the first two safely; tier 4 is the only place the last two are exercised, and it belongs on staging.

### 7.5 Deadlock detection, honestly scoped

Exact deadlock detection over flags is a state-space search and grows exponentially. The design uses two cheaper checks that together catch the practical cases:

- **Static over-approximation.** Assume every flag that some reachable action can set is set, then check that an exit is reachable. If not, the dungeon cannot be finished under any play, which is an error.
- **Randomised walks.** The simulator plays several thousand seeded runs choosing randomly among available inputs and reports any run that reaches a state with no available input and no exit. Each finding comes with a replayable seed and input list.

A one-way door that strands a player only on one rare path may be missed by the first check and is what the second is for.

### 7.6 Safety of test runs

A test run cannot alter inventories, ownership, currencies or progression because it never has the means: the live effects port is not constructed for a run with `is_test`. Test runs are excluded from the daily allowance, are visibly labelled in Discord, show rewards as "would grant", replace wild encounters with a forced-outcome prompt, and require `dungeons.write`. They do occupy the player's one active run slot, which is intended.

## 8. Export/import: the Dungeon Content Package

A package is one JSON document describing one dungeon, optionally wrapped in a ZIP with its artwork. It is a file an operator downloads from staging and uploads to production; the two environments never connect.

### 8.1 Format

```json
{
  "format": "waifumon-dungeon-package",
  "schemaVersion": 1,
  "packageId": "0b6f6d0e-…",
  "exportedAt": "2026-10-10T14:02:11Z",
  "source": { "environment": "staging", "dungeonKey": "service_tunnels",
              "draftRevision": 41, "publishedRevision": 7 },
  "contentHash": "sha256:…",

  "dungeon": { "…definition as in section 4.1: rooms, connections, sequences, lootTables, encounters, flags…": {} },
  "events": [ { "…every catalogue event the dungeon references…": {} } ],
  "editor": { "layout": { "…as in section 4.7…": {} } },

  "assets": [
    { "ref": "sha256:9f2c…", "kind": "managed", "category": "dungeon_background",
      "name": "pump-room.webp", "bytes": 184223, "bundled": true },
    { "ref": "encounters/door_within_door.webp", "kind": "shipped" }
  ],

  "dependencies": {
    "species": ["sewer_slime", "pipe_nymph", "grease_angel"],
    "items": ["basic_charm", "rusty_key", "scrap_metal"],
    "equipment": ["rusty_pipe", "glitch_earring"],
    "enemies": [ { "key": "sewer_gremlin", "contentHash": "…" } ],
    "rewardTables": [ { "kind": "expedition", "id": "scrapheap-standard" } ],
    "regions": ["waifu-valley"],
    "currencies": ["ascension_currency"]
  },

  "bundled": { "enemies": [ { "…full enemy definitions, create-if-missing…": {} } ] }
}
```

| Brief requirement | Where it is in the package |
| --- | --- |
| Dungeon definition and metadata | `dungeon` |
| Rooms and graph connections, room action sequences | `dungeon.rooms`, `dungeon.connections` |
| Dungeon event definitions | `events` |
| Dungeon-specific loot tables | `dungeon.lootTables` |
| Waifumon encounter definitions, rescue configurations | `dungeon.encounters` |
| Quest conditions and flags | Conditions inline; declarations in `dungeon.flags` |
| Editor layout metadata | `editor.layout` |
| Asset references | `assets` |
| Dependency manifest | `dependencies` |
| Package schema version | `schemaVersion` |

Export is sorted and hashed over gameplay content only, so the same content always produces the same `contentHash`, and a layout change does not alter it.

### 8.2 Global definitions are referenced, not copied

Species, items, equipment definitions, global reward tables, regions and currencies appear only as slugs in `dependencies`. The audit confirmed all of them have stable string identifiers.

Enemies are the one exception worth a decision. Enemies are authored in the Portal per environment, and the catalogue has an export but **no import**. A dungeon built on a new staging enemy would therefore fail its dependency check in production with no way to fix it. The proposal is that the package may carry the enemy definitions it uses under `bundled.enemies`, and import creates those that are missing and never modifies one that exists. A differing existing enemy is reported as a warning with the changed fields. This is open decision 3.

### 8.3 Assets across environments

- **Shipped artwork** is referenced by its path under `assets/` and arrives with the deploy. Import checks the file exists.
- **Managed artwork** is referenced by category and sha256 content hash, never by its per-environment UUID. Import resolves the hash against the target's `artwork_assets`. This needs the new index and a lookup function; the hash column already exists.
- **ZIP bundle.** If the upload is a ZIP, it contains `package.json` and `assets/<sha256>.<ext>`. For each managed reference missing on the target, import uploads the bundled bytes through `artworkAssetService`, after verifying the hash.
- **Missing artwork** is reported per reference in the plan. It is a warning at import, because drafts may be incomplete, and an error at publish.

JSON-only packages work from Phase 1. The ZIP path is added with events in Phase 3, when art-heavy content first exists. Whether the API has a ZIP reader and multipart support was not verified.

### 8.4 Import flow

1. **Plan** (`POST /admin/dungeons/import/plan`, permission `dungeons.write`). Pure and read-only. Order: format, schema version, schema, internal consistency, full content validation, dependencies, assets, comparison with the target.
2. The plan returns, per entity, one of `create`, `update`, `unchanged` or `conflict`, with changed fields and the target's current revision, plus a list of issues `{severity, code, path, message}`.
3. **Apply** (`POST /admin/dungeons/import/apply`, permission `dungeons.write`). The operator sends the package again with the `expectedRevisions` from the plan and an explicit decision for each conflict.
4. Apply runs in one transaction: lock the target rows, re-plan inside the transaction, refuse if the plan differs from what was approved or has errors, write events, write the draft and layout, upload bundled assets, write the import log and audit rows.
5. The result is a **draft**. Nothing is published.

| Required property | How it is met |
| --- | --- |
| Package and schema validation | Zod envelope with strict `format` and `schemaVersion`; unknown versions refused with the supported range |
| Dependency checks | Every slug in `dependencies` is looked up; missing is an error, disabled is a warning. The manifest is also recomputed from the content, so a hand-edited package cannot under-declare |
| Missing artwork detection | Per-reference result in the plan, by hash or path |
| Conflict detection | `expectedRevisions` for the draft and each event; `FOR UPDATE` and in-transaction re-plan |
| Dry-run preview | The plan endpoint; the Portal shows it as a diff before enabling Apply |
| Atomic import | One transaction; asset bytes are written to storage first and orphaned bytes are swept if the transaction fails |
| Idempotent retries | Identical content is `unchanged` and writes no content. `dungeon_import_log` is unique on `(package_id, package_hash)`, so a retried apply returns the first result |
| Existing drafts | Explicit `draftMode`: `fail` (default) or `replace`. Replace requires the draft's `expectedRevision` and a separate confirmation in the Portal |
| Clear diagnostics | Stable issue codes, a path into the package, and the target value where relevant |

### 8.5 Conflicts on shared events

The dungeon is one entity, but catalogue events can be used by several dungeons. If a package carries an event that exists on the target with different content, the plan marks it `conflict` and lists the other dungeons whose drafts reference it. The operator chooses `overwrite` or `keep target` per event. Published revisions are never affected either way, because they hold their own frozen copy.

### 8.6 Publishing, revisions and rollback

- **Publishing is a separate action** with its own permission, `dungeons.publish`, following the `encounters.publish` precedent. Import never publishes and has no option to.
- Publish re-validates on the target, with missing dependencies and artwork as errors, then writes the immutable revision.
- A dungeon imported for the first time has status `draft` and is invisible to players.
- Rollback and active-run behaviour are as described in section 6.4.
- The import log and audit table together answer "which package produced the revision players are on".

### 8.7 Alternatives considered

- **Reuse the encounter package format.** Rejected: it has no manifest, no hashes and no conflict detection, and is typed to encounters.
- **Ship dungeons as Git content files seeded at startup**, like bosses and enemies. Rejected as the primary path: it requires a deploy per content change and the seed-hash divergence model exists precisely because DB edits and files fight. Packages remain plain JSON, so committing them to `content/dungeons/` for history is still possible.
- **Environment-to-environment sync.** Rejected by requirement; production must not reach staging.

## 9. Integration boundaries

The dungeon module calls existing services through their current public functions and owns no copy of their rules. Eight changes are needed outside the dungeon module; each is small and is listed with the phase that needs it.

| System | Dungeon calls | Dungeon never does | Change required outside dungeons | Phase |
| --- | --- | --- | --- | --- |
| Combat | `simulateCombat`, `combatStats.snapshotCombatStats` | Define stats, formulas or modifiers | None | 1 |
| Enemies | `enemyService` definitions and snapshot | Store enemy stats in dungeon content | Add a dungeon `EnemyReferenceSource` for where-used and the delete guard | 1 |
| Reward tables | Read global tables by `(kind, id)`; shared group roller | Write to `reward_tables` | Extract a neutral roller from `expeditionRewards.ts`; expedition and boss callers keep their wrappers | 2 |
| Items and currency | `inventory.addItem`, `currency.grant*`, `progressionCurrency.grant` | Touch balances directly | None; idempotency comes from `dungeon_claims` | 2 |
| Equipment | `equipmentRewards.grant*`, `equipmentService.grantEquipment` for fixed rolls, source type `dungeon` | Roll multipliers, affixes or bonuses itself | None | 2 |
| Conditions, checks, effects | `src/modules/gameRules/` | Import anything from `worldEncounters/` | Extract the three libraries; World Encounters switch to them through an adapter with unchanged behaviour | 3 |
| Wild encounters | `createWildEncounter` with origin `dungeon`; read encounter status | Roll capture chance, consume capture items, write `capture_attempts` | Add `dungeon` to origin kinds | 4 |
| Ownership | `createOwnedWaifu(tx, …)` | Insert into `player_waifus` itself | Extract the function from `captureService.ts`; add `acquired_via` and `grant_key`; capture keeps calling it | 4 |
| Species and regions | Species by slug from loaded content; `locations/regions.ts` for availability | Maintain its own species list | Add the `dungeon_exclusive` tag at the two existing exclusion points and in the loader warning | 4 |
| Artwork | `artworkAssetService`, scene composition, scene preview | Store image bytes | Lookup by content hash; extend `referencesOf` to drafts, revisions and events | 1 and 3 |
| Auth and audit | `requirePortalPermission` | Invent its own roles | Add `dungeons.publish`; new `dungeon_content_events` table | 1 |
| Daily allowance | `dungeonAllowanceService` unchanged |  | None | 1 |

### Boundary rules

- **The engine imports nothing but content types and the combat simulator.** A lint rule or an architecture test enforces that `src/modules/dungeons/engine/` has no database, Discord or service imports.
- **World Encounters and dungeons do not import each other.** Both depend on `gameRules`. The existing statement of intent in `eventDefinitions.ts` is kept and made testable.
- **The capture flow is observed, not wrapped.** Because `attemptCapture` owns its transaction, the dungeon does not try to call it. It spawns the encounter and reads the result. This avoids refactoring the capture service's transaction handling, at the cost of one extra interaction for the player to return to the dungeon.
- **Behaviour-preserving extractions land with their own tests first.** The three extractions (roller, rules, `createOwnedWaifu`) each ship as a refactor with the existing suites green before any dungeon code depends on them.

## 10. Technical risks and tradeoffs

The largest risk is Phase 1 scope: it carries the new model, the engine, revisions, the first canvas and the first package format at once. The roadmap splits it in two for that reason.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Phase 1 is too large to review as one increment | Slow, shallow review of the foundation everything else rests on | Split into 1A (backend, playable from tests and Discord) and 1B (canvas and package) |
| Engine purity erodes: someone adds a database read inside a step | Simulator and production diverge silently | Architecture test on imports; every action type has a simulator test that runs the same fixture through both ports |
| Extracting shared rules changes World Encounter behaviour | Regression in a live feature with 133 authored encounters | Extraction is behaviour-preserving, lands alone, and runs the existing encounter suites; production RNG stays unseeded there |
| Changes to `player_waifus` and `captureService` | Touches the core collection path | Columns are nullable and additive; the extraction is a pure move with the capture tests as the guard |
| Migration ordering between `Delve` and Assteroid | A migration with the wrong journal timestamp can make production skip others; this has already bitten the boss backport | New migrations take timestamps after `0058`; no dungeon migration is backported; the rule is restated in the Phase 1 checklist |
| The one-active-encounter slot | A dungeon wild encounter is blocked while a hunt encounter is open, and the reverse | The action waits instead of failing and says why; documented as intended. Rescue and recruit do not use the slot |
| Deadlock detection is approximate | A strandable path ships | Static check plus randomised walks with replayable seeds; a stranded player can always abandon, and settlement still pays secured rewards |
| Discord limits: 5 buttons per row, 25 components, 100-character custom ids, 3-second acknowledgement | Rooms with many exits or choices, or slow image composition | Validator warns above 5 choices and 5 visible exits; overflow uses a select menu; ids carry only run, step and a short input; composition stays cached and deferred replies are used as today |
| Published revisions and run snapshots grow storage | Larger rows than today's single zone row | A revision is written per publish, not per save; runs now hold a reference instead of a full copy, which is a net reduction per run |
| Enemy edits reach in-flight content | A balance change alters a published dungeon's difficulty without a new revision | Deliberate (section 3.5). Enemy stats are frozen per run, so no run changes mid-way |
| Managed artwork is not deduplicated | Two uploads of the same image give two assets with one hash | Import resolves to the first active match; the package never depends on an id |
| Import overwrites a shared event another dungeon uses | Unintended change to a second dungeon's draft | Plan lists affected dungeons; overwrite is per event and explicit; published revisions are unaffected |
| The existing Portal architecture test already fails at HEAD | New Portal work appears to break it | Known and pre-existing on `api/adminArtworkAssets.ts`; fix or baseline it at the start of 1B |
| Sequence model proves too limited | An author wants a loop or a counter | Retry counters and re-entry cover the known cases. Anything more is expressed with rooms and connections, which may cycle. This is a stated limit, not an oversight |

### Tradeoffs accepted

- **Forward-only sequences** give guaranteed termination and simple validation, and push loops up to the map level.
- **Whole-document saves** keep the editor and importer simple and make concurrent editing coarse: two admins on one dungeon get a conflict, not a merge.
- **Events frozen at publish** means fixing a typo in a shared event requires republishing each dungeon that uses it. The publish screen will show "events changed since this revision" to make that visible.
- **Observed capture** costs the player one extra tap and saves a risky refactor.
- **A claims table instead of an inventory ledger** fixes dungeons only; the other systems keep their existing protection.

## 11. Implementation roadmap

The brief's six phases hold, with three changes: Phase 1 is split in two, three behaviour-preserving extractions are scheduled as explicit prerequisites, and a basic simulator arrives in Phase 1 because the pure engine makes it nearly free. Packaging is present in every phase: each phase extends the package schema for the content it adds and ships a round-trip test.

| Phase | Delivers | Depends on |
| --- | --- | --- |
| 1A. Runtime foundation | New content schema, drafts, immutable revisions, publish and rollback, pure engine, run service, Discord play | Decisions 1, 2, 5 |
| 1B. Canvas and package v1 | xyflow editor for rooms and connections, list-based sequence editor, JSON export and import with plan and apply | 1A |
| 2. Rewards | Claims-backed delivery, dungeon loot tables, guaranteed and conditional rewards, policies | 1A; roller extraction |
| 3. Events | Event catalogue and editor, shared rules, flags and objectives, choices, ZIP asset bundles | 1B, 2; rules extraction |
| 4. Waifumon | Wild and rescue encounters, guaranteed recruitment, exclusive species, acquisition records | 2, 3; `createOwnedWaifu` extraction; decision 2 |
| 5. Full editor | Sequence canvas, outcome wiring by connection, auto-layout, multi-select, duplication, previews, navigation | 3, 4 |
| 6. Testing and publishing polish | Full simulator UI, deadlock detection, sandboxed test runs, publish diff, revision retirement, legacy cleanup | 5 |

### Phase 1A: runtime foundation

- **Scope.** Content schemas for dungeon, room, connection and the actions `combat`, `boss`, `rest`, `gate`, `set_flag` (run scope), `leave`, plus a minimal `reward` that references an existing table. Tables `dungeon_definitions`, `dungeon_revisions`, rebuilt `dungeon_runs`, `dungeon_content_events`. Validator with schema, reference and reachability rules. Draft service, publisher, pure engine with both effects ports, run service with step counter. Discord command and presenter driven by the engine view. Permission `dungeons.publish`. Cutover migration.
- **Packaging.** The export function and the package schema exist from the first commit and are used by the test fixtures, so every test dungeon is a package.
- **Tests.** Unit tests per action type through the sandbox port. Integration tests for step locking, stale-step replay, multi-wave HP carry-over and restart mid-wave, publish immutability, a run surviving a new publish, rollback. A seeded end-to-end playthrough of a fixture dungeon. Route allowlist updated.
- **Reviewable result.** A dungeon written as JSON can be published and played to completion in Discord on staging, with waves.

### Phase 1B: canvas and package v1

- **Scope.** Add `@xyflow/react` and `@dagrejs/dagre`. Canvas with drag-to-create rooms, connections, zoom, pan, minimap, layout document, inspector for room, connection and dungeon settings, ordered action list in the inspector, live validation badges, publish and rollback screens. Import plan and apply routes, import log, Portal import panel with diff. Nginx body-limit location for the import route.
- **Tests.** Reducer tests for every edit and undo. Component tests for the inspector. Package round trip: export, import to an empty database, export again, identical hash. Conflict, existing-draft and idempotent-retry cases. One Playwright path: create, connect, save, publish.
- **Reviewable result.** A dungeon is built on the canvas in staging, exported, imported into a second environment as a draft and published there.

### Phase 2: rewards and loot

- **Prerequisite.** Extract the neutral group roller; expedition and boss suites stay green.
- **Scope.** `dungeon_claims`, `dungeonRewardService`, reward bundles with guaranteed items, equipment (random and fixed), currency, table references and `when`; policies `per_run` and `once_per_player`; dungeon loot tables with the existing reward-row editor; reward inspector; rewards in the package and dependency manifest.
- **Tests.** Double-delivery attempts under concurrency, replay returns the stored result, crash between claim and grant leaves nothing, once-per-player across runs, deterministic rolls, fixed equipment round trip.

### Phase 3: dungeon events

- **Prerequisite.** Extract conditions, checks and resource effects into `gameRules`; World Encounter suites stay green.
- **Scope.** `dungeon_events`, event service, where-used, `event` and `choice` actions, outcome labels and follow-ups, `dungeon_player_flags`, objectives, the extended condition union, event editor reusing `EffectEditor` and `EquipmentRewardFields`, events frozen at publish, events and shared-event conflicts in the package, managed artwork by content hash, ZIP bundles.
- **Tests.** Seeded check replay, every effect kind through both ports, follow-up combat returning to the room, flag scopes, an event edit not reaching a published revision, import conflict on a shared event, asset resolution by hash with and without a bundle.

### Phase 4: Waifumon encounters and rescue

- **Prerequisite.** Extract `createOwnedWaifu`; add `acquired_via` and `grant_key`; capture suites stay green.
- **Scope.** `dungeon` origin kind, `wild_encounter` and `rescue` actions, dungeon pools, policies including `until_acquired`, acquisition claims, the `dungeon_exclusive` species tag, the lockout validator rule, encounters in the package with species dependencies.
- **Tests.** Recruitment is idempotent under retry and concurrency. A completion flag set without acquisition leaves the encounter available. A failed rescue is retryable. A blocked encounter slot waits and resumes. An exclusive species never appears in the hunt or the global fallback. Expired encounters resolve on resume.

### Phase 5: complete visual editor

- **Scope.** Per-room sequence canvas, outcome handles wired by connection, contextual creation, auto-layout for both levels, multi-select, duplicate, copy between dungeons, artwork and enemy previews on nodes, embedded scene preview, search and outline navigation, advanced panels, keyboard shortcuts.
- **Tests.** Reducer tests for wiring and duplication, id uniqueness after duplicate, layout stability, accessibility checks with the existing axe setup.

### Phase 6: testing, validation and publishing polish

- **Scope.** Simulator panel in the Portal (start from any room or action, forced outcomes, flag and reward inspectors, Monte Carlo report), deadlock checks, sandboxed test runs in Discord, publish screen with a diff against the current revision and changed-events notice, revision retirement with run settlement, removal of `dungeon_zones`, the generator and the old editor files.
- **Tests.** Simulator and live engine parity on a fixture set, a deliberately deadlocked fixture is caught by both checks, test runs write no claims, flags or grants, retirement settles runs correctly.

### Cross-phase rules

- Every phase ends with the package round-trip test extended to its new content, and with `schemaVersion` unchanged unless a breaking change is unavoidable.
- Every new mutating route is added to the allowlist in `tests/unit/api/routes.test.ts` in the same change.
- Integration tests run against the podman Postgres baseline; new failures are measured against the known baseline of pre-existing ones.
- Each extraction prerequisite is its own reviewable change with no dungeon code in it.

## 12. Open decisions for review

Six decisions should be settled before Phase 1A begins; four more can wait until the phase named. Each has a recommendation.

### Before Phase 1A

1. **Drop procedural generation?** The shipped `scrapheap_gauntlet` zone is procedural, and the generator, its simulation and a 1,045-line settings editor exist only for that mode. Recommended: drop it. Authored maps with weighted enemy pools per wave and conditional rooms give variety without a second layout system. Keeping it means maintaining a generator that emits the new model, roughly doubling Phase 1A's content surface.
2. **Add provenance columns to `player_waifus`?** Guaranteed recruitment cannot be made idempotent without a grant key on the ownership row. Recommended: add nullable `acquired_via` and `grant_key`. The alternative, relying only on `dungeon_claims`, leaves a window where a claim exists and the insert is repeated by another path.
3. **Bundle enemy definitions in packages?** Recommended: yes, create-if-missing and never overwrite. The alternative is to build a separate enemy importer first, which is cleaner but adds a second import step to every promotion.
4. **Freeze enemy stats at run start or at publish?** Recommended: run start, as today, so balance changes need no republish. Freezing at publish gives stricter immutability but makes enemy tuning a per-dungeon chore.
5. **Are simultaneous multi-enemy fights required?** The brief asks for multiple waves, which this design covers with sequential one-versus-one fights. Fights against several enemies at once need combat-engine work and are assumed out of scope.
6. **Cross-dungeon flags?** Recommended: no; player flags are namespaced per dungeon. A campaign spanning dungeons would need a global namespace and a cross-package dependency rule, which can be added later without changing stored data.

### Before the phase named

7. **Phase 2: a `dungeon` kind in global `reward_tables`?** Recommended: no. Dungeon-specific tables live in the dungeon definition and travel with it; global tables stay `boss` and `expedition` and are referenced.
8. **Phase 3: ZIP bundles or a two-step asset upload?** Recommended: ZIP, as one file is harder to get wrong during a production promotion. It depends on what upload support the API already has, which was not verified.
9. **Phase 4: does releasing a recruited Waifumon reopen an `until_acquired` encounter?** Recommended: no by default, with a per-encounter `reopenOnRelease` option, since an exclusive species otherwise becomes permanently unobtainable after a release.
10. **Phase 6: idle run expiry.** Runs stay active indefinitely today. Recommended: keep that, and revisit only if retired revisions accumulate stale runs.

### Assumptions made without asking

- Combat stays automatic; no turn-by-turn player input is added.
- The daily run allowance and the unbanked-currency risk rule are kept unchanged.
- One active run per player remains the rule.
- Dungeon content is authored only in the Portal; no startup seeding from `content/dungeons/` is carried forward.
