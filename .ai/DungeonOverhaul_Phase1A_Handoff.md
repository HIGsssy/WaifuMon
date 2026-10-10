# Dungeon Overhaul — Phase 1A Handoff

Runtime foundation, room sequences and content architecture. Implemented on
branch `Delve`, uncommitted. Nothing was committed, pushed, merged or
deployed, and no migration was run against staging or production; only
throwaway local Postgres containers were used.

System documentation: `docs/dungeons.md`. Example dungeon:
`content/dungeons/examples/service_tunnels.dungeon.json`.

## 1. What was implemented

- **Content model.** A dungeon definition with a map layer (rooms, directed
  connections, locks, shortcuts, exits, extraction points — cycles allowed)
  and a room-sequence layer (ordered actions with forward-only outcome
  routing). Zod schemas, TypeScript types and a separate editor layout
  document.
- **Action types:** `combat`, `boss`, `rest`, `gate`, `set_flag`, `leave`, and
  a minimal `reward` (an existing reward table and/or a currency range).
  `event`, `choice`, `objective`, `random_outcome`, `wild_encounter` and
  `rescue` are reserved names with a dedicated validation code.
- **Pure engine.** `stepDungeon(state, input, context, rng)` returning the new
  state, effects, log entries and combat events. Deterministic seeded streams
  per place. A read-model builder and a sandbox that records effects without
  applying them.
- **Chained combat.** Any number of sequential waves per action, any number of
  combat actions per room, HP carried throughout, a unique seed per wave,
  weighted enemy pools drawn deterministically, per-wave persistence,
  confirm-or-auto wave advance, configurable defeat handling.
- **Content lifecycle.** Mutable drafts with optimistic revision checking,
  explicit publish to immutable revisions, a published pointer, rollback, an
  enable switch, an append-only audit trail.
- **Live runs.** A run service that pins the published revision, snapshots
  enemy stats, reward tables and the fighter at start, and advances the run
  under a row lock with a step-number check.
- **Discord.** The Delve command and presenter rewritten for the cursor
  runtime; the scene compositor and Buddy/enemy sprite rendering are reused
  unchanged.
- **Validation.** 48 stable issue codes with severity, path and message.
- **Packaging.** The Dungeon Content Package format (schema version 1),
  hashing, serialisation, self-verification on read, export through the
  service and API, read-only inspection.
- **Admin API.** Drafts, publish, rollback, revisions, history, export,
  validate, package inspect, sandbox. New permission `dungeons.publish`.
- **Migration 0059** with explicit prototype cleanup, and the two nullable
  provenance columns on `player_waifus`.
- **Sandbox CLI:** `npm run dungeons:sandbox -- <package>`.

## 2. Files

### Created

| Path | Purpose |
| --- | --- |
| `src/modules/dungeons/content/dungeonDefinition.ts` | Definition schema, action union, routing destinations, dependency computation |
| `src/modules/dungeons/content/dungeonLayout.ts` | Editor layout schema |
| `src/modules/dungeons/engine/types.ts` | State, cursor, inputs, effects, log, receipts |
| `src/modules/dungeons/engine/seeds.ts` | Seeded streams derived from the run seed |
| `src/modules/dungeons/engine/conditions.ts` | Condition evaluation and reference walking |
| `src/modules/dungeons/engine/routing.ts` | Outcome routing and its precedence |
| `src/modules/dungeons/engine/combat.ts` | One wave through the existing combat simulator; pooled enemy selection |
| `src/modules/dungeons/engine/rewards.ts` | Reward plans, claim keys, settlement arithmetic |
| `src/modules/dungeons/engine/step.ts` | The engine |
| `src/modules/dungeons/engine/view.ts` | Presenter-neutral read model |
| `src/modules/dungeons/engine/sandbox.ts` | Sandbox effects adapter, sandbox runner, auto-play |
| `src/modules/dungeons/engine/index.ts` | Barrel |
| `src/modules/dungeons/validation/dungeonValidation.ts` | Validation |
| `src/modules/dungeons/package/dungeonPackage.ts` | Package format, build, serialise, read |
| `src/modules/dungeons/dungeonContentService.ts` | Drafts, publish, rollback, audit, export |
| `src/modules/dungeons/dungeonFighter.ts` | Fighter snapshot (moved out of the deleted run-state module) |
| `src/tools/dungeonSandbox.ts` | Sandbox CLI |
| `drizzle/0059_dungeon_overhaul_foundation.sql` | Migration |
| `content/dungeons/examples/service_tunnels.dungeon.json` | Example package |
| `tests/helpers/dungeonWorld.ts` | Database-backed test world |
| `tests/unit/dungeons/{dungeonEngine,dungeonValidation,dungeonPackage,engineArchitecture}.test.ts` | Unit tests |
| `tests/integration/{dungeonContent,dungeonRuns,dungeonMigration,dungeonDiscord}.test.ts` | Integration tests |
| `tests/integration/api/adminDungeons.test.ts` | API tests (rewritten) |

### Rewritten in place

`src/modules/dungeons/dungeonRunService.ts`, `src/api/routes/v1/admin/dungeons.ts`,
`src/discord/dungeonPresenter.ts`, `src/discord/commands/waifumonDungeon.ts`,
`docs/dungeons.md`, `tests/helpers/dungeonFixtures.ts`.

### Modified

| Path | Change |
| --- | --- |
| `src/db/schema.ts` | New dungeon tables; rebuilt run tables; `player_waifus.acquired_via` / `grant_key` |
| `drizzle/meta/_journal.json` | Entry 59 |
| `src/shared/errors.ts`, `src/api/errors.ts` | Dungeon errors renamed and added; generation and unplayable-run errors removed |
| `src/index.ts`, `src/discord/types.ts` | Wiring: `dungeonContent`, `dungeonRuns`; startup check of open dungeons |
| `src/discord/dungeonArtwork.ts`, `src/discord/client.ts`, `src/discord/commands/waifumon.ts` | New view shape, new `dg` routes |
| `src/modules/enemies/enemyReferences.ts` | Where-used reads dungeon drafts and published revisions |
| `src/modules/artworkAssets/artworkAssetService.ts` | Delete guard reads dungeon documents by content hash |
| `src/modules/content/loader.ts`, `schemas.ts` | Dungeon events no longer loaded |
| `src/modules/portalAuth/portalAuthService.ts`, two Portal dev session providers | `dungeons.publish` |
| `src/api/routes/v1/index.ts` | Comment |
| `package.json` | `dungeons:sandbox` added; three prototype tool scripts removed |
| `docs/equipment-combat-bonuses.md`, `docs/managed-artwork.md` | Notes about removed pieces |
| Tests outside the dungeon suites | See section 8 |

### Removed

- Prototype modules: `authoredLayout`, `dungeonGenerator`, `dungeonPlayService`,
  `dungeonPlaythrough`, `dungeonRunState`, `dungeonScenes`, `dungeonSimulation`,
  `dungeonZoneService`, `dungeonZoneStore`, `eventDefinitions`, `zoneDefinition`,
  `zoneValidation` (all under `src/modules/dungeons/`).
- Tools: `src/tools/simulateDungeon.ts`, `simulateDungeonPlay.ts`,
  `simulateCombatBonuses.ts`.
- Seed content: `content/dungeons/zones.json`, `content/dungeons/events.json`.
- Their tests and fixtures.

No file under `assets/` was touched.

## 3. Database and schema changes

Migration `0059_dungeon_overhaul_foundation`, journal `when` 1820872800000.
The journal was inspected: 59 prior entries, strictly increasing, newest 0058
at 1820786400000. Drizzle applies by `when`, so this runs last. It must not be
backported.

| Object | Change |
| --- | --- |
| `dungeon_definitions` | New. `dungeon_key` PK, `enabled`, `draft`, `layout`, `draft_revision`, `draft_hash`, `published_revision_id` (FK), `position`, audit columns |
| `dungeon_revisions` | New. Immutable; unique `(dungeon_key, number)`; trigger refuses UPDATE and DELETE |
| `dungeon_content_events` | New. Append-only audit |
| `dungeon_runs` | Rebuilt. `revision_id` FK, `step`, `cursor`, `flags`, `room_states`, `recent`, `dependency_snapshot`; keeps the one-active-run partial unique index and the completion/settlement checks |
| `dungeon_run_events` | Rebuilt. Adds `step`, `room_id`, `action_id`; new type list |
| `player_waifus` | `acquired_via`, `grant_key` (nullable; partial unique index). Unwritten until Phase 4; capture is untouched |
| `dungeon_zones`, old `dungeon_runs`, old `dungeon_run_events` | Renamed with a `_prototype` suffix (indexes and sequences too). Not read again |

Prototype cleanup, restricted to those three tables: every active prototype
run is settled as an extraction with its unbanked currency banked in full
through the ledger, under the request key the prototype would have used. Every
step is guarded and re-runnable. `dungeon_settings`, `dungeon_daily_usage`,
currency and artwork tables are untouched.

Not introduced (deferred to their phases): `dungeon_claims`,
`dungeon_player_flags`, the event catalogue, the import log.

## 4. Execution engine and cursor

`stepDungeon(state, input, context, rng = streams(state.seed))` →
`{ status, refusal, state, effects, log, combat }`.

- **State:** `status`, `step`, `seed`, `cursor`, `hp`, `flags`, `rooms`
  (visits, completed, resume point, per-action records), `unbankedCurrency`,
  `recent`, `end`.
- **Cursor:** `{ roomId, actionId | null, waveIndex, cameFrom }`. A null
  action means the room is finished and the player is choosing a connection.
- **Inputs:** `advance`, `decline`, `move`, `extract`, `abandon`, each with
  `expectedStep`.
- **One input is one step.** After resolving the input, the engine carries the
  sequence through everything that needs no decision and stops at the next
  thing that does.
- **Routing precedence:** `outcomes[outcome]`, then `next` (success outcome
  only), then a decline continues, then the type default (lost fight ends the
  run; blocked gate retreats; `leave` walks or completes; otherwise next).
  `room_complete` is an explicit destination.
- **Action end states:** `completed`, `failed`, `declined`,
  `condition_skipped` — distinct in state and in the log.
- **Purity** is enforced by an architecture test over the import graph.
- **Adapters:** live (in `dungeonRunService`) and sandbox. Both go through
  `applyDungeonEffects`.

## 5. Combat waves

See `docs/dungeons.md` → "Combat waves". In short: waves are sequential
one-versus-one fights through the existing simulator with the existing stat
snapshot and equipment modifiers; HP persists; each wave has its own seed and
its own log row; a pooled wave's enemy is drawn once from the run seed; the
action is stored `in_progress` between waves with `waveIndex` in the cursor;
there is no engine wave limit; `advance` is `confirm` or `auto`; defeat ends
the run unless routed, in which case HP is set to 1.

## 6. Publication and revisions

- Save: `expectedRevision` or `DUNGEON_DRAFT_STALE`. Shape must parse; other
  validation errors are allowed in a draft.
- Publish: explicit, `dungeons.publish`, errors block, writes revision *n+1*.
  An unchanged draft publishes nothing.
- Rollback: pointer move after re-validation.
- A run references `revision_id`. Publish and rollback change new runs only.
- Enemy stats and reward tables are frozen at run start, not at publish.
- Nothing publishes implicitly.

## 7. Package schema and export

Envelope: `format`, `schemaVersion` (1), `packageId`, `exportedAt`, `source`
(environment, dungeon key, origin, draft and published revision numbers),
`contentHash`, `dungeon`, `editor.layout`, `dependencies` (enemies with
hashes, reward tables, regions, currencies; species/items/equipment reserved),
`assets`, `bundled.enemies`.

- The content hash covers gameplay only; layout, export time and package id do
  not affect it.
- `readDungeonPackage` checks format, version, shape, hash, that the manifest
  equals the recomputed dependencies, bundle integrity, and structural
  validity. It refuses unknown versions and unknown members.
- Bundled enemy hashes use the Enemy Catalogue's own hash, so the Phase 1B
  importer can detect a differing enemy and require a decision.
- Export: `dungeonContentService.exportPackage(key, 'draft' | 'published' | { revision })`
  and `GET /admin/dungeons/definitions/:key/export`.
- Not implemented (Phase 1B): import plan/apply, conflict preview, import log.

## 8. Tests and typecheck

**Typecheck.** `npx tsc --noEmit -p tsconfig.json` (backend and tests): 0
errors. `portal`: `npx tsc --noEmit`: 0 errors. The root project has no ESLint
configuration, so nothing was linted there.

**Relevant suites, run in isolation against a throwaway local Postgres**
(44 files, 1,042 tests): **1,041 pass, 1 fails.**

| Suite | Result |
| --- | --- |
| `tests/unit/dungeons/dungeonEngine.test.ts` | 33 / 33 |
| `tests/unit/dungeons/dungeonValidation.test.ts` | 26 / 26 |
| `tests/unit/dungeons/dungeonPackage.test.ts` | 20 / 20 |
| `tests/unit/dungeons/engineArchitecture.test.ts` | 2 / 2 |
| `tests/integration/dungeonContent.test.ts` | 22 / 22 |
| `tests/integration/dungeonRuns.test.ts` | 21 / 21 |
| `tests/integration/dungeonMigration.test.ts` | 6 / 6 |
| `tests/integration/dungeonDiscord.test.ts` | 24 / 24 |
| `tests/integration/api/adminDungeons.test.ts` | 42 / 42 |
| `tests/integration/enemyCatalogue.test.ts` | 22 / 22 |
| `tests/integration/api/adminArtworkAssets.test.ts` | 27 / 27 |
| `tests/integration/api/adminEnemies.test.ts` | 16 / 17 |
| `tests/unit/api/*` (routes, errors, dashboard resources, …), `tests/unit/combat/*`, journal, shipped artwork tree, combat-bonus Discord | all pass |

**The one failure is pre-existing, not caused by this work:**
`adminEnemies.test.ts` › "editing a shipped enemy marks it edited and shows the
shipped copy beside it" edits enemy `wojak_shade`, which
`content/combat/enemies.json` does not ship at HEAD either. It was already
recorded as failing before this phase.

**Where each required test lives**

| Required | Test |
| --- | --- |
| Room and connection validation; cyclic maps | `dungeonValidation.test.ts`; `dungeonEngine.test.ts` › the map |
| Forward-only routing, early completion | `dungeonEngine.test.ts` › room sequences; validation `transition_backward` |
| Optional and conditional actions | `dungeonEngine.test.ts` › optional and conditional actions |
| Multi-wave combat, HP persistence | `dungeonEngine.test.ts` › chained combat; `dungeonRuns.test.ts` |
| Seeded enemy selection, deterministic replay | `dungeonEngine.test.ts` › determinism |
| Restarting between waves | `dungeonEngine.test.ts` › restarts; `dungeonRuns.test.ts` (new service over the same database); `dungeonDiscord.test.ts` |
| Stale Discord interactions | `dungeonDiscord.test.ts`; `dungeonRuns.test.ts` › interaction safety |
| Concurrent step submissions | `dungeonRuns.test.ts` › interaction safety (six racing presses, racing moves, racing reward claims, racing abandons) |
| Immutable publication | `dungeonContent.test.ts` (including the database trigger) |
| Revision pinning, rollback | `dungeonRuns.test.ts` › what a run is pinned to; `dungeonContent.test.ts` › rollback |
| Package serialisation and round trips | `dungeonPackage.test.ts`; `dungeonContent.test.ts` (export, land in a second database, export again, same hash) |
| Sandbox/live rule consistency | `dungeonEngine.test.ts` › the sandbox; the architecture test |
| Completion and extraction | `dungeonEngine.test.ts`; `dungeonRuns.test.ts` › ending a run |
| Migration over prototype data | `dungeonMigration.test.ts` |

**Not done: a trustworthy full-suite comparison.** A full root run on a
scratch copy of clean HEAD reported 491 failures in 80 files, but that copy
was built with `git archive` and symlinked asset folders, and a targeted
isolated re-run showed it failing 62 tests where the working tree fails 1 — so
that baseline measures the scratch copy, not HEAD, and was discarded. In place
of it, twelve shared non-dungeon suites that touch what this phase changed
(content loading, collection, capture, hunt, seeding, equipment surfaces, read
endpoints, test controls) were run in isolation on the working tree: 339 of
340 pass. The one failure, `migrateSeed.test.ts` › "migrates a fresh database
and seeds shipped content", asserts a single shipped region and is on the
project's recorded list of pre-existing failures. **The full root suite was not
run on the working tree**, so a regression in a suite outside those listed
here cannot be ruled out. The Portal test suite was not run (only its
typecheck): the Portal source is unchanged apart from two permission lists.

**Tests changed outside the dungeon suites**

- Removed with what they tested: `shippedArtworkTree.test.ts` › "shipped
  dungeon zones" (zone seeding and its artwork path convention), and one
  assertion on procedural graph reproduction in `enemyCatalogue.test.ts`.
- Adapted to the new model: enemy where-used and delete guard, artwork delete
  guard (now by content hash), waifu row fixtures (two new nullable columns).
- Three assertions were replaced because the rule itself changed — see
  section 10, last three rows.

## 9. Known limitations and deferred work

- **Portal.** Not touched beyond the permission lists. The existing dungeon
  pages call the removed zone endpoints: the zone list shows an error state,
  while the Delve settings and currency panels on the same page still work.
  Until Phase 1B, authoring is through the admin API.
- **No importer.** A package is brought into another environment by posting
  its `dungeon` (and `editor.layout`) to `POST /definitions`. That creates a
  draft and never publishes, but it does no conflict or dependency planning.
- **Rewards** are the Phase 1A subset: table references and currency ranges.
  Items and WaifuBux are protected by the step transaction, not by a key of
  their own. The sandbox resolves no reward tables.
- **Player-scoped flags** are declared but cannot be set.
- **A completed room does not run again** on re-entry.
- **Managed artwork** is referenced by content hash. With duplicate uploads,
  the oldest active asset with that hash is used.
- **Deleting a dungeon** is not offered (the audit action exists).
- **Prototype tools removed**, including the combat-bonus balance simulator,
  which simulated prototype zones. Not rebuilt on the new engine.
- **`*_prototype` tables** remain until a cleanup migration.
- **Discord copy** was written without design review.

## 10. Deviations from the Phase 0 design

| Phase 0 | Phase 1A | Why |
| --- | --- | --- |
| `dungeon_definitions.status` (draft, published, disabled) | `enabled` flag plus a nullable published pointer | The two facts are independent; a status column would have to encode both |
| Catalogue events frozen into the revision | Not applicable yet | No events until Phase 3 |
| Step numbering unspecified | Log rows carry the *resulting* step; the start is step 0 | Lets a screen fetch "what the latest step did" by `step = run.step` |
| Gate with `onFail` | `gate` reports `blocked`; default destination is a new `retreat` | Gives a locked door sensible behaviour with no authoring, and keeps routing uniform |
| `repeatOnReentry` | Deferred | Not needed by any Phase 1A action |
| `is_test` column on runs | Deferred | Sandboxed Discord runs are Phase 6 |
| Managed artwork resolved at import | Also resolved at run start into the dependency snapshot | A run should not change pictures mid-way |
| Sandbox as a later phase | Basic sandbox, API route and CLI delivered now | Required by the Phase 1A brief; nearly free with a pure engine |
| Old tables dropped in Phase 6 | Renamed aside now, dropped later | As proposed; active runs are settled first so no currency is lost |
| Adding a disabled enemy to a zone was refused | A disabled enemy in a dungeon is an `enemy_disabled` warning | The old rule compared a save against the stored document; a draft may now hold work in progress, and enemies are frozen per run. Easy to make an error at publish if wanted |
| An unknown managed asset id was refused | An unknown content hash is an `artwork_missing` warning | Artwork may legitimately arrive after the content (a package before its images); publish-time strictness is a Phase 1B decision |
| Zone saves wrote `reference_added` / `reference_removed` asset audit events | Dungeon saves do not; the delete guard still works | Not rebuilt in this phase; restore with the Phase 1B editor if the asset trail matters |

No approved decision was reversed.

## 11. Phase 1B prerequisites and suggested sequence

Prerequisites already in place: stable ids on everything the canvas will draw;
the layout document stored, saved and exported separately; whole-draft save
with `expectedRevision`; live validation with path-addressed issues; the
reference endpoint; export; publish and rollback endpoints; the package reader.

Suggested order:

1. **Portal API client** for the new routes, replacing the zone client. Keep
   the settings, currency and artwork calls.
2. **Canvas shell** on `@xyflow/react`: rooms and connections derived from the
   definition, positions from the layout, pan/zoom/minimap, drag to create,
   connect to create. One reducer with undo. Confirm the library version and
   licence at install.
3. **Inspector**: dungeon settings, room, connection, and the ordered action
   list with per-type forms. Reuse the existing reward, background and
   artwork form parts.
4. **Live validation** mapped onto nodes, edges and actions by issue path.
5. **Publish and rollback screens**, revision list, history.
6. **Importer**: `planImport` (pure, built on `readDungeonPackage`) and
   `applyImport` (one transaction, row locks, `expectedRevisions`, explicit
   draft mode), the import log table, bundled-enemy conflict decisions, the
   Portal import panel with diff. Nginx body-limit location for the route.
7. **Auto-layout** (`@dagrejs/dagre`) for unpositioned rooms.
8. Remove the old Portal dungeon pages and their tests.

Decisions to make at the start of 1B: whether `PUT /draft` should accept a
layout-only body from the canvas on every drag end or batch it; and whether
the importer may create enemies or only report them as missing when the
operator lacks `enemies.write`.

## Example dungeon

`content/dungeons/examples/service_tunnels.dungeon.json` — "The Service
Tunnels", five rooms.

```
gate ──c_main──▶ pump_room ──c_pump_bulk──▶ bulkhead ──c_boss (needs valve_opened)──▶ colossus_den (exit)
  │  ▲               ▲                         │  ▲
c_side c_back        └───────c_bulk_pump───────┘  │
  ▼  │                                            │
locker_room ─────────────c_locker_bulk────────────┘
```

| Requirement | Where |
| --- | --- |
| Multiple rooms | Five |
| Branching connections | `gate` → `pump_room` or `locker_room` |
| Two or more sequential waves | `gate_guards` (a fixed enemy, then a weighted pool); `bulkhead_sentry` (two waves, auto-advance) |
| A conditional gate | `vault_door`: needs `found_keycard`; blocked routes forward past the vault |
| An alternate route | The locker room: a second way into the bulkhead, with a shortcut back to the gate. The boss door needs the valve, so this route doubles back through the pump room |
| A valid exit | `colossus_den` |

Run it:

```
npm run dungeons:sandbox -- content/dungeons/examples/service_tunnels.dungeon.json --seed 3
npm run dungeons:sandbox -- content/dungeons/examples/service_tunnels.dungeon.json --runs 200
```

It is also played along both routes by `tests/unit/dungeons/dungeonPackage.test.ts`.
