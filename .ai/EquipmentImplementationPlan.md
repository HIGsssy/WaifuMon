# Equipment V1 — Codebase Audit & Implementation Proposal

Companion to [EquipmentPlan.md](EquipmentPlan.md), which remains the product requirements and design source of truth. This document audits the existing codebase and proposes how to implement Equipment V1 within it. No code, migrations or content have been changed as part of this audit.

**Revision 2.** Updated after owner review. The decisions in [§0](#0-owner-decisions-revision-2) supersede anything in the original design doc or in revision 1 of this plan that conflicts with them.

**Fixed architecture decisions (not reconsidered here):** DB-stored definitions; DB-backed per-instance ownership (not quantity inventory); three V1 slots (Attack, Defense, Health); equipment belongs to the player and the active loadout applies to the current Buddy; Buddy SP is the base for ATK/DEF/HP; rewards never auto-equip; one authoritative combat-stat service consumed by every client; schema supports multiple loadouts; room for secondary effects and qualifiers; startup seed inserts missing definitions only; parties, per-Waifumon gear, affixes, crafting, durability, trading and Dungeon are out of scope.

---

## 0. Owner decisions (revision 2)

| # | Decision | Consequence for this plan |
|---|---|---|
| R1 | **No fallback multipliers for empty slots.** An empty slot makes that derived stat unavailable. Equipment is a progression unlock for *future* combat activities; existing gameplay does not depend on it. | No `unequippedMultiplierBp`. Combat stats report each stat as `number \| null`, plus `missingSlots` and `isComplete` (§5). No `tables.json` tuning block is needed in V1. |
| R2 | **No automatic starter kit.** The first Attack, Defense and Health items are earned through an onboarding sequence (likely a chained World Encounter) that introduces the system, explains Current SP → ATK/DEF/HP, grants the three basic items, teaches equipping, and marks Equipment unlocked. | New `player_feature_unlocks` entitlement table (§3, §7.1). The onboarding flow is a later phase. Normal rewards still never auto-equip; onboarding may equip its tutorial items only as an explicit scripted action. |
| R3 | **No slash command.** Equipment is reached through an Equipment branch of the main Waifumon Discord interface, optionally linked from Buddy. Before unlock it is either hidden or shown as locked. | No `/equipment` and no `/wm equipment`. A single presentation function decides `hidden \| locked \| available` (§9). |
| R4 | **Do not rework boss encounters in V1.** Scouting/participation stays unchanged. Future equipment-based "Boss Attacks" are a separate combat experience that consumes the combat-stat service. | Boss damage formula untouched. The `boss_participations` combat-snapshot migration is **dropped** from V1. Boss reward-table equipment drops are also deferred, so no boss code changes in V1. |
| R5 | **Retire the `equipment` item category as content.** New use is a loader error; remove the player-facing inventory label. DB/API compatibility cleanup comes later. | Phase 1 content-handling task (§8). |
| R6 | **One instance may appear in multiple future loadout presets.** Presets are configurations; only the active loadout is in effect. | No cross-loadout uniqueness on instances. Admin removal clears the instance from every loadout (§3, §5). |

Re-approved assumptions: Current SP is the combat input; multipliers are integer basis points with centralised integer rounding; ownership is per guild/player row; disabled definitions stop acquisition but owned instances remain usable; admin removal may override a player lock and is audited; equipment is DB-backed and instance-based.

---

## 1. Existing systems and patterns to reuse

| Need | Existing precedent to copy | Where |
|---|---|---|
| DB-authoritative content, insert-missing seed, `reset` only for tests | World Encounter seed (`SeedMode = 'insert-missing' \| 'reset'`) | [seed.ts](../src/modules/worldEncounters/seed.ts) |
| Content moved between environments by key, never by id | `waifumon-world-encounters` v1 package: plan, preview, then apply in one transaction, plus an import log | [encounterPackage.ts](../src/modules/worldEncounters/encounterPackage.ts), [encounterImportService.ts](../src/modules/worldEncounters/encounterImportService.ts) |
| Per-copy owned instances with soft removal | `player_waifus` (identity PK, `is_favorite`, `released_at`) | [schema.ts:623](../src/db/schema.ts#L623) |
| Permanent per-player entitlements that are *not* inventory | `player_travel_passes`, `player_unlocked_routes` (composite PK, `source` CHECK, grant timestamp) | [schema.ts:1347-1406](../src/db/schema.ts#L1347-L1406) |
| Non-inventory ledgers | `travel_transactions`, `key_item_constructions`. Their comments explain why `shop_transactions` can't be reused (`item_id NOT NULL` with an FK) | [schema.ts:1408-1486](../src/db/schema.ts#L1408-L1486) |
| Idempotency through a DB unique key; the losing insert reads back the winner | `encounters_origin_uq (origin_kind, origin_ref)`, `boss_participations_encounter_player_uq` | [schema.ts:564](../src/db/schema.ts#L564) |
| Grants that join the caller's transaction | `inventory.addItem(tx, …)`; `effectExecutor` never opens its own transaction | [inventoryService.ts](../src/modules/inventory/inventoryService.ts) |
| One pure authoritative formula with integer arithmetic and a version constant | `currentSeductivePower` (`SP_FORMULA_VERSION`), `computeBattleDamage` | [seductivePower.ts](../src/modules/power/seductivePower.ts), [bossDamage.ts](../src/modules/bosses/bossDamage.ts) |
| A snapshot taken when a player commits to a combat | `boss_participations` stores `current_sp`, affinity and bonuses at commit — the model for future Boss Attacks / Dungeon snapshots | [bossEncounterService.ts:622](../src/modules/bosses/bossEncounterService.ts#L622) |
| Active buddy resolution that self-heals a stale pointer | `collection.resolveActiveBuddy(tx, playerId)` | [collectionService.ts:327](../src/modules/collection/collectionService.ts#L327) |
| Deterministic reward rolls, weights normalised over enabled entries | `rollExpeditionTable` | [expeditionRewards.ts](../src/modules/expeditions/expeditionRewards.ts) |
| CHECK constraints generated from a TypeScript vocabulary | `REGION_SQL_LIST` | [regions.ts](../src/modules/locations/regions.ts) |
| Post-commit gameplay events | `GameEventBus` descriptors emitted by the coordinator | [gameEvents.ts](../src/modules/events/gameEvents.ts), [gameEventEmitter.ts](../src/discord/gameEventEmitter.ts) |
| Admin account-change audit | `recordAdminAction` → `player_progression_events` with `ADMIN_ACTION_EVENT` | [adminActionAudit.ts](../src/modules/admin/adminActionAudit.ts), [waifumonAdminPlayer.ts:295](../src/discord/commands/waifumonAdminPlayer.ts#L295) |
| Staging grant/revoke of an entitlement | `test_grant_transporter_beacon` / `test_revoke_transporter_beacon` | [stagingTestControlsService.ts:662](../src/modules/testControls/stagingTestControlsService.ts#L662) |
| Player-scoped API routes, 404s, Portal self-only scope, CSRF on mutations | `registerPlayerScope`, `PUT …/appearance` | [playerScope.ts](../src/api/plugins/playerScope.ts), [collection.ts:229](../src/api/routes/v1/collection.ts#L229), [auth.ts:98](../src/api/auth.ts#L98) |
| Portal admin permission vocabulary | `ALL_PORTAL_PERMISSIONS` + descriptions | [portalAuthService.ts:38](../src/modules/portalAuth/portalAuthService.ts#L38) |
| Discord `wm\|v1\|scope\|action\|args` custom ids, `scope:action` handler map | `buildCustomId`, the `exp:*` handlers | [types.ts:288](../src/discord/types.ts#L288), [client.ts:237](../src/discord/client.ts#L237) |
| Module boundary enforced by a test | `appearanceBoundary.test.ts` | [appearanceBoundary.test.ts](../tests/unit/appearanceBoundary.test.ts) |
| Real-Postgres, per-file test databases | `createTestDb()` | [testDb.ts](../tests/helpers/testDb.ts) |

The codebase also leaves explicit hooks for this work: `seductivePower.ts` reserves "Effective SP … for equipment", and `checkResolver.ts` says "future equipment will extend this".

---

## 2. Conflicts, migration risks and constraints

1. **Migrations must be hand-written.** The drizzle-kit snapshots stop at `0004`, so `npm run db:generate` would diff against a stale baseline. Every migration since 0019 is hand-written SQL, and its journal `when` must be greater than 0044's (`1819576800000`) or the migrator silently skips it.
2. **Seeds run after migrations**, so a migration can't reference definition ids unless it inserts them itself (the 0043 precedent). With no automatic starter kit (R2), no backfill is needed.
3. **"Global to the player" means per guild.** `players` is unique on `(guild_id, discord_user_id)`. Equipment and its unlock are keyed to `players.id`, consistent with currencies, collection and buddy. (Approved.)
4. **`items.category = 'equipment'` exists as a reserved category** in the DB CHECK, the API enum ([content.ts:140](../src/api/schemas/content.ts#L140)), the Discord inventory labels ([waifumon.ts:616](../src/discord/commands/waifumon.ts#L616)), a loader guard ([loader.ts:928](../src/modules/content/loader.ts#L928)) and a startup warning ([loader.ts:1380](../src/modules/content/loader.ts#L1380)). No content uses it. Retired as content per R5 (§8).
5. **Two seed philosophies coexist.** Items and species are JSON-canonical and overwritten on every load ([seeder.ts](../src/modules/content/seeder.ts)); world encounters are DB-authoritative and insert-missing. Equipment follows the world-encounter model and must **not** go through `seedContent`.
6. **Reward tables are JSON, validated before the DB is consulted.** Equipment keys live in the DB, so equipment references in JSON reward tables need validation in the reloader (which has `db`) plus a skip-and-log at payout, as already done for missing items.
7. **World-encounter changes ship as packages.** Adding `give_equipment` to live encounters, including the onboarding chain, means authoring on staging and shipping an import package.
8. **World Encounters can't be started on demand.** Encounters start only from hunt/travel rolls (`tryRollForHunt` / `tryRollForTravel`) or as continuations (`openContinuation`). Eligibility is sources/regions/routes only, and choice requirements read only Buddy attributes. The onboarding chain therefore needs a small engine addition: a **scripted start** of a named encounter for one player, refused when the feature is already unlocked (§7.1). This is a later-phase item, not Phase 1.
9. **Design doc §63 contradicts §64.** Resolved: `enabled` gates acquisition only.
10. **"Buddy SP" is ambiguous in the design doc.** Resolved: Current SP.
11. **Floats go against codebase convention.** Resolved: integer basis points.
12. **Shop purchases can't use `shop_transactions`** (`item_id NOT NULL` FK). The `travel_transactions` precedent applies when shops are integrated.
13. **There is no "events" system.** `species.event_key` is inert, so "event" grants are admin-run grants tagged `source_type='event'`.
14. **Content admin is multi-tenant.** Encounter definitions are global tables editable by any guild's permitted admin. Equipment definitions inherit this; acceptable while there is effectively one guild.
15. **Player-facing Portal mutations are rare.** Only `PUT …/appearance` exists. Equip/unequip would expand the player write surface, using the existing CSRF/auth plumbing.
16. **Discord has no slash command for Equipment (R3).** Entry is through the main-menu custom-id tree, so gating lives in the menu builder and in every `eq:*` handler; stale buttons are re-validated on the server.

---

## 3. Proposed schema

### Migration `0045_equipment_foundation.sql` (Phase 1)

Vocabulary lives in `src/modules/equipment/vocabulary.ts` (and `src/modules/features/vocabulary.ts` for unlocks), with `*_SQL_LIST` exports for CHECKs in the same way as `REGION_SQL_LIST`:

- `EQUIPMENT_SLOTS = ['attack','defense','health']` — adding `relic` later is a CHECK-widening migration, intentionally.
- `EQUIPMENT_SOURCE_TYPES = ['onboarding','boss','encounter','expedition','shop','admin','event','dungeon','raid','quest']`.
- `EQUIPMENT_EVENT_KINDS = ['granted','equipped','unequipped','removed','flag_changed']`.
- `FEATURE_KEYS = ['equipment']`; `FEATURE_UNLOCK_SOURCES = ['onboarding','admin','migration']`.

#### `equipment_definitions`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity PK | Internal only |
| `key` | text NOT NULL UNIQUE | Stable, `^[a-z0-9_]+$`, max 64; immutable once created |
| `name` | text NOT NULL | |
| `description` | text NOT NULL default `''` | |
| `slot` | text NOT NULL | CHECK in slots; **immutable once any instance exists** (service-enforced) |
| `rarity` | text NOT NULL | CHECK in `RARITIES` (reuses N…EX); V1 validation allows N–UR only |
| `attack_bp` / `defense_bp` / `health_bp` | integer NOT NULL default 0 | Basis points: 8000 = ×0.80, 32000 = ×3.20. CHECK `>= 0` |
| `secondary_effects` | jsonb NOT NULL default `'[]'` | `[{effectId, value, qualifiers[]}]`; V1 validation requires `[]` |
| `tags` | text[] NOT NULL default `'{}'` | |
| `region_id` | text NULL | CHECK in region list; regional identity and filters |
| `artwork_path` | text NULL | Relative to `ASSETS_DIR`; `..` rejected, containment checked at resolve time |
| `enabled` | boolean NOT NULL default true | Gates **acquisition** only |
| `shop_regions` | text[] NOT NULL default `'{}'` | Mirrors `items.shop_regions`; unused until shops are integrated |
| `buy_price` | integer NULL, CHECK `> 0` | |
| `price_currency` | text NOT NULL default `'waifubux'` | CHECK |
| `created_at`, `updated_at` | timestamptz | |
| `updated_by` | text NULL | Discord id, for audit |

Additional CHECKs:

- The definition affects its own stat: `(slot='attack' AND attack_bp>0) OR (slot='defense' AND defense_bp>0) OR (slot='health' AND health_bp>0)`.
- Hard upper bounds as a backstop, mirrored as constants in `equipmentMath.ts`: `attack_bp <= 20000`, `defense_bp <= 20000`, `health_bp <= 80000`.

Indexes: `(enabled, slot)`, `(region_id)`.

#### `player_equipment` (instances)

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity PK | The instance id exposed to clients |
| `player_id` | bigint NOT NULL FK `players` | |
| `definition_id` | bigint NOT NULL FK `equipment_definitions` **ON DELETE RESTRICT** | A referenced definition can't be hard-deleted |
| `slot` | text NOT NULL | **Denormalised** from the definition at grant time (immutable); lets the DB enforce slot compatibility |
| `rolled_properties` | jsonb NOT NULL default `'{}'` | Empty in V1 |
| `is_favorite`, `is_locked` | boolean NOT NULL default false | |
| `source_type` | text NOT NULL | CHECK in source types |
| `source_key` | text NULL | Encounter slug, expedition key, region, etc. |
| `grant_key` | text NULL | Idempotency key |
| `granted_by` | text NULL | Admin Discord id |
| `acquired_at`, `updated_at` | timestamptz | |
| `removed_at` | timestamptz NULL | Soft removal |
| `removed_reason` | text NULL | |

- `UNIQUE (id, player_id, slot)` — target of the composite FK below.
- `UNIQUE (grant_key) WHERE grant_key IS NOT NULL` — retry/double-click backstop.
- Indexes: `(player_id) WHERE removed_at IS NULL`, `(player_id, definition_id)`, `(definition_id)`.

#### `player_loadouts`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity PK | |
| `player_id` | bigint NOT NULL FK `players` | |
| `name` | text NOT NULL default `'Default'` | |
| `is_active` | boolean NOT NULL default false | |
| `sort_order` | integer NOT NULL default 0 | |
| `created_at`, `updated_at` | timestamptz | |

- `UNIQUE (id, player_id)`; `UNIQUE (player_id) WHERE is_active`; `UNIQUE (player_id, lower(name))`.

#### `player_loadout_slots`

| Column | Type | Notes |
|---|---|---|
| `loadout_id` | bigint NOT NULL | |
| `player_id` | bigint NOT NULL | Denormalised so both FKs can include it |
| `slot` | text NOT NULL | CHECK in slots |
| `equipment_id` | bigint NOT NULL | Unequip deletes the row |
| `equipped_at` | timestamptz NOT NULL default now() | |

- `PRIMARY KEY (loadout_id, slot)` — one item per slot per loadout.
- `FOREIGN KEY (loadout_id, player_id) → player_loadouts(id, player_id) ON DELETE CASCADE` — the loadout belongs to the player.
- `FOREIGN KEY (equipment_id, player_id, slot) → player_equipment(id, player_id, slot) ON DELETE RESTRICT` — **the database rejects equipping another player's instance, or an instance into the wrong slot.**
- `UNIQUE (loadout_id, equipment_id)`; index `(equipment_id)`.
- **No uniqueness across loadouts** (R6): one instance may sit in several presets. Only the active loadout affects combat stats.

A soft-removed instance still satisfies the FK, so `adminRemove` deletes its slot rows from **every** loadout in the same transaction that sets `removed_at`.

#### `equipment_events` (append-only)

`id, player_id FK, equipment_id NULL, loadout_id NULL, kind CHECK, slot NULL, previous_equipment_id NULL, actor_discord_id NULL, metadata jsonb, created_at`. Indexed `(player_id, created_at)` and `(kind, created_at)`. Balancing metrics are SQL over this table plus `player_equipment`; `/metrics` retains nothing between scrapes.

#### `equipment_import_log`

Mirrors `world_encounter_import_log`: actor, applied time, package format/version/label, source filename, created/updated/unchanged counts, keys touched.

#### `player_feature_unlocks` (see §7.1)

| Column | Type | Notes |
|---|---|---|
| `player_id` | bigint NOT NULL FK `players` | |
| `feature_key` | text NOT NULL | CHECK in `FEATURE_KEYS` (`'equipment'` only in V1) |
| `source` | text NOT NULL | CHECK in `FEATURE_UNLOCK_SOURCES` |
| `source_ref` | text NULL | e.g. the onboarding active-encounter id |
| `unlocked_by` | text NULL | Admin Discord id for `source='admin'` |
| `unlocked_at` | timestamptz NOT NULL default now() | |

- `PRIMARY KEY (player_id, feature_key)` — unlocking twice is an idempotent no-op; concurrent unlocks collapse to one row.

### Deferred migrations

- `equipment_transactions` (shop ledger, `travel_transactions` shape) — with shop integration.
- ~~`boss_participations` combat snapshot~~ — **dropped** from V1 (R4). Future Boss Attacks will store their own snapshot from `snapshotCombatStats`.

---

## 4. Stable keys vs internal IDs

- **Definitions.** `key` is the only identity in content, reward tables, encounter effects, packages, `source_key`, logs and Discord custom ids. `id` is only for FKs; packages and reward JSON never contain it. Keys never change; a rename creates a new definition.
- **Instances.** The bigint `id` is the only identity. Exposed as a number (matching `waifuId`) and always re-validated against the caller's `player_id`. A wrong-owner id returns the same 404 as a nonexistent one.
- **Loadouts.** Clients address "the active loadout" in V1, so no loadout-id vocabulary is exposed until presets ship.
- **Feature unlocks.** `feature_key` is a closed code vocabulary, never content.

---

## 5. Domain and service boundaries

### Modules

| File | Responsibility |
|---|---|
| `src/modules/equipment/vocabulary.ts` | Slots, source types, event kinds, SQL lists |
| `src/modules/equipment/equipmentMath.ts` (**pure**) | `EQUIPMENT_FORMULA_VERSION`; `deriveStat(currentSp, bp) = round(currentSp × bp / 10000)` (half-up, integer numerator); bound constants |
| `src/modules/equipment/definitionSchema.ts` | Zod `EquipmentDefinitionInput`, shared by seed, import and (later) the Portal editor |
| `src/modules/equipment/equipmentDefinitionService.ts` | List/get by key, create, update (slot immutable once referenced), enable/disable, delete (only when unreferenced, otherwise returns blockers) |
| `src/modules/equipment/equipmentService.ts` | The **only** writer of `player_equipment` and the loadout tables |
| `src/modules/equipment/combatStatsService.ts` | The **only** place combat stats are calculated |
| `src/modules/equipment/equipmentPackage.ts` / `equipmentImportService.ts` / `seed.ts` | Content movement (§6) |
| `src/modules/features/featureUnlockService.ts` | `isUnlocked`, `listUnlocked`, `unlock(tx, …)`, `revoke(tx, …)` (admin/test only) |

### Key signatures

```ts
grantEquipment(tx: DbOrTx, input: {
  playerId: number; definitionKey: string; quantity?: number /* 1..5 */;
  source: { type: EquipmentSourceType; key?: string };
  grantKey?: string;              // idempotency; per-copy suffix :0, :1 … appended internally
  actorDiscordId?: string;
  allowDisabled?: boolean;        // only for payouts already rolled while enabled
}): Promise<{ definition: DefinitionView; instances: InstanceView[]; alreadyGranted: boolean;
              events: GameEventDescriptor[] }>
```

Joins the caller's transaction. On a `grant_key` conflict it inserts `ON CONFLICT DO NOTHING` and reads the existing rows back. Writes `equipment_events`, **never touches loadouts**, and returns descriptors for the coordinator to emit after commit. Granting does **not** require the feature to be unlocked: ownership is independent of the unlock, so gear earned early waits in the Gear Bag.

```ts
listEquipment(playerId, { slot?, rarity?, q?, equipped?, favorite?, locked?,
  sort?: 'multiplier'|'rarity'|'acquired'|'name', groupBy?: 'none'|'definition', cursor?, limit? })
equip(playerId, { slot, equipmentId, expectedCurrentId?: number|null })   // active loadout
unequip(playerId, { slot, expectedCurrentId? })
getActiveLoadout(playerId): Promise<LoadoutView>   // pure read; virtual empty loadout if none exists
ensureActiveLoadout(tx, playerId): Promise<LoadoutRow> // idempotent insert, write paths only
setFlags(playerId, equipmentId, { isFavorite?, isLocked? })
adminRemove(tx, { playerId, equipmentId, reason, actorDiscordId, overrideLock?: boolean })

calculateCombatStats(playerId, opts?: {
  buddyWaifuId?: number;                                        // default: active Buddy
  slotOverrides?: Partial<Record<Slot, number | null>>;         // preview only; never persisted
}): Promise<CombatStats>
snapshotCombatStats(tx, playerId): Promise<CombatStats>          // future Boss Attacks / Dungeon entry
```

### Feature gating

`equip` and `unequip` require `featureUnlocks.isUnlocked(playerId, 'equipment')` and otherwise throw `FeatureLockedError` (403-class). This is server-authoritative, so a direct Portal/API call can't bypass it. Reads, grants and admin actions are not gated. `setFlags` is gated like equip.

### `equip` transaction order

Lock order is always loadout → instance, so equip and admin removal can't deadlock.

1. Check the feature unlock.
2. `ensureActiveLoadout`, then `SELECT … FROM player_loadouts WHERE player_id=$1 AND is_active FOR UPDATE`.
3. Load the instance with `id=$2 AND player_id=$1 AND removed_at IS NULL`; not found → `EquipmentNotOwnedError` (404).
4. Slot mismatch → `EquipmentSlotMismatchError` (409).
5. If `expectedCurrentId` was supplied and doesn't match → `LoadoutConflictError` (409).
6. Upsert on `(loadout_id, slot)`; write an `equipment_events` row with the previous item.

The definition's `enabled` flag is deliberately **not** checked. Concurrent equips into one slot serialise on the loadout lock; the last committer wins, both callers get a success response describing their own change, and the PK/FKs backstop any bug.

### `CombatStats` shape (no fallbacks, per R1)

```ts
{
  formulaVersion: number,
  buddy: { waifuId, speciesSlug, name, level, baseSp, currentSp } | null,
  loadout: {
    loadoutId: number | null,
    slots: Record<'attack'|'defense'|'health',
      { equipmentId, definitionKey, name, rarity, multiplierBp, rolledProperties } | null>
  },
  stats: { attack: number | null, defense: number | null, maxHp: number | null },
  missingSlots: Slot[],          // empty slots
  isComplete: boolean,           // buddy present and missingSlots is empty
  unavailableReason: 'no_buddy' | 'incomplete_loadout' | null,
  appliedEffects: []             // V1 always empty
}
```

- A stat is `null` when its slot is empty or there is no Buddy. It is never silently `0`, so no consumer can mistake "unavailable" for "weak".
- Future combat systems require `isComplete` at entry; that rule lives in the consumer, not here.
- This object is also the snapshot a future Dungeon run or Boss Attack stores (design doc §35).

---

## 6. Seeding and maintaining definitions

- **Seed file.** `content/equipment/equipment.seed.json`, written *in the package format* (`format: "waifumon-equipment", version: 1, definitions: [...]`). The same file is both the startup seed and importable through the Portal — one schema.
- **Startup** (in [index.ts](../src/index.ts), next to `seedWorldEncounters`): `seedEquipmentDefinitions(db, { mode: 'insert-missing' })` inserts only missing keys and never updates. A failure logs and continues. `reset` mode is for tests only.
- **Seed contents.** Anything shipped in the seed becomes permanent on every server (keys are immutable and insert-missing never retracts). Phase 1 therefore ships either an empty catalogue or only the three signed-off onboarding basics. **[OPEN Q3]**
- **The DB is authoritative from then on.** Portal edits survive restarts; content moves by export → import (never deletes, one transaction, plan recomputed inside the transaction, audit row), mirroring `encounterImportService`.
- **Retiring a seeded definition** on live servers is a migration setting `enabled=false` (the 0044 precedent).
- **Validation bounds** are code constants matching the DB CHECKs (safety rails, not tuning). Per-rarity "expected band" warnings are deferred until simulation produces real values. **No `tables.json` block in V1.**
- Not edited in the legacy JSON admin web panel ([admin-web.md](../docs/admin-web.md)).

---

## 7. Onboarding, unlock and reward integration

### 7.1 Unlock state — recommended pattern

**Recommendation: a new `player_feature_unlocks` table** (schema in §3), modelled directly on `player_unlocked_routes` / `player_travel_passes`: a permanent per-player entitlement with a composite PK, a `source` CHECK and a grant timestamp.

| Alternative | Why rejected |
|---|---|
| `players.settings` jsonb | Mixed with preferences; no constraint, no audit, no source, easy to clobber in a read-modify-write |
| Key item in `player_inventory` (Transporter Beacon pattern) | Makes the unlock an ordinary item: listed in inventory, potentially sellable, counted by quantity — the model Equipment explicitly avoids |
| `player_achievements` | Achievements are derived badges defined in content that "never revert"; an unlock must be revocable for testing and support |
| Derived from owning Attack + Defense + Health gear | Admin grants or early rewards would unlock it implicitly, and there'd be no recorded completion moment |
| `players.equipment_unlocked_at` column | Works, but adds a column per future feature (Dungeon, Raid); the table generalises at zero extra cost |

Properties:

- `unlock(tx, { playerId, featureKey, source, sourceRef?, actorDiscordId? })` is an `INSERT … ON CONFLICT DO NOTHING` returning whether this call unlocked it. It runs inside the onboarding completion transaction, alongside the three grants, so "items granted" and "feature unlocked" commit together or not at all.
- `revoke` exists only for admin/staging use and writes a `recordAdminAction` row, mirroring the Transporter Beacon test controls.
- Future features (Dungeon, Raid) add a value to `FEATURE_KEYS` via a CHECK-widening migration.

### 7.2 Onboarding sequence (later phase)

- **Content:** a short chained World Encounter authored in the Portal and shipped by package. The final step's success effects are three `give_equipment` effects (basic Attack/Defense/Health) and one `unlock_feature: equipment` effect, all in the existing single resolution transaction.
- **Engine additions** (§2.8):
  - `give_equipment` effect `{ type, equipmentKey, quantity 1–3 }` → `grantEquipment` with `source_type 'onboarding'` (or `'encounter'` outside onboarding) and grant key `we:{activeEncounterId}:{choiceId}:{effectIndex}`.
  - `unlock_feature` effect `{ type, featureKey }` → `featureUnlocks.unlock`.
  - **Scripted start:** `worldEncounters.startScripted(playerId, slug, { requiresFeatureLocked: 'equipment' })`, reusing the activation/continuation machinery. Called from the locked Equipment entry ("Begin"). Refused if the feature is already unlocked or another encounter is pending. Grants happen only on the final step, so abandoning midway and restarting can't double-grant, and restarting after completion is refused.
- **Teaching equip:** preferred is teach-by-doing. The completion screen opens the Equipment branch in tutorial mode and the player equips each item. If a scripted equip is wanted, add a dedicated `equipmentService.equipForOnboarding(tx, playerId, instanceIds)` that only fills **empty** slots and is callable only from the `unlock_feature`/onboarding handler. It's deliberately a separate method so normal reward paths can never reach it. **[OPEN Q2]**
- **Prerequisites** for when onboarding becomes available (player level, region, etc.) are undecided. **[OPEN Q1]**

### 7.3 Other reward sources (later phases)

All reference definitions by **key** and grant through `grantEquipment` inside the existing reward transaction:

- **World Encounters (beyond onboarding):** the same `give_equipment` effect. Disabled/unknown definition → `applied:false` with a reason (`give_item` precedent). `crossValidate` and `planImport` gain an `equipmentKeys` target set.
- **Expeditions:** reward entries become `{ itemId, … } | { equipmentKey, weight, quantity (1–3), enabled }`. The payload gains `equipment: {key, quantity}[]`. Disabled definitions are filtered before normalisation at resolve time; `claim` grants with `allowDisabled: true` and grant key `exp:{expeditionId}:{i}`. Golden-output tests pin existing item-only tables.
- **Shops:** equipment shelf per region, shown only to unlocked players. `purchase`: lock currency → region gate → spend → `grantEquipment(source 'shop')` → `equipment_transactions` row.
- **Admin / events:** Portal (`equipment.grant`) and `/waifumon-admin player equipment grant|remove|inspect`, with `recordAdminAction`.
- **Bosses:** **deferred** (R4). Current boss rewards stay unchanged in V1.

### 7.4 Enforcement

`equipmentBoundary.test.ts`, modelled on `appearanceBoundary.test.ts`, fails if any file outside `modules/equipment/` writes `playerEquipment` or the loadout tables, or if any file outside `modules/features/` writes `playerFeatureUnlocks`.

---

## 8. Item/reward infrastructure: reuse vs keep separate

**Reuse:** reward-table shape (groups, gates, weights); deterministic draw RNGs; existing reward idempotency (expedition conditional claim, world-encounter single-transaction resolution); `currency.lockCurrencies` / `spend*`; the shop region-gate rule; the effect executor's dispatch; the package/import framework pattern; the GameEventBus; `recordAdminAction`; artwork path and containment helpers; Portal filter/pill/rarity components.

**Keep separate:** `items`, `player_inventory`, `inventoryService`, `shop_transactions`, `mergeGrants` (sums quantities), item `sell_value`, the capture-capacity cap, `max_owned`.

**Retire the `equipment` item category as content (R5, Phase 1):**

- Any `items.json` entry with `category: "equipment"` becomes a `ContentValidationError` at load, with a message pointing at the Equipment system.
- The expedition-reward equipment guard and `warnOnEnabledEquipment` are replaced by that single rule.
- The `equipment` entry is removed from `INVENTORY_CATEGORY_DISPLAY` in [waifumon.ts](../src/discord/commands/waifumon.ts).
- The DB CHECK value, `ITEM_CATEGORIES` in `schema.ts` and the API enum stay for compatibility, with comments marking them deprecated; cleanup is a later migration.

---

## 9. Discord management flow (no slash command)

- **Entry:** an **Equipment** button in the main Waifumon menu (`/waifumon`), plus an optional link from the Buddy screen. Custom-id scope `eq`. No `/equipment`, no `/wm equipment`.
- **Locked vs hidden:** `equipmentEntryState(ctx, playerId): 'hidden' | 'locked' | 'available'` is the only function the menu and Buddy screens consult. It combines the feature unlock with a presentation setting (`EQUIPMENT_LOCKED_PRESENTATION = 'hide' | 'show_locked'`, config or guild setting) and a global kill switch (`EQUIPMENT_ENABLED`). `locked` renders a disabled or "🔒 Equipment" button whose handler explains how to unlock and, once onboarding exists, offers "Begin". Every `eq:*` handler re-checks the state, so stale buttons can't bypass it.
- **Overview** (ephemeral): Buddy name and Current SP; each slot's item and `ATK ×0.80`, or "Empty"; ATK/DEF/HP from `calculateCombatStats`, with `—` for unavailable stats. Buttons: `[Attack Gear] [Defense Gear] [Health Gear] [Gear Bag] [Back]`.
- **Slot screen:** string select of compatible owned gear grouped by definition (≤25, best first), e.g. `Plasma Coil Ring ×0.86 (×3)` / `+38 ATK vs current`. The value is a representative unequipped instance id chosen by the server. Selecting equips and re-renders with `Equipped … — ATK 302 → 340`. Also `[Unequip]` and `[Back]`.
- **Gear Bag:** paged, grouped list with counts and ✅ for equipped items, plus a Portal link.
- **Tutorial mode:** the onboarding completion opens the overview with a step hint ("Equip your Training Ring") until all three slots are filled.
- **Reward lines** (later phases): "⚔️ Plasma Coil Ring (Rare Attack ×0.86), added to your Gear Bag".

---

## 10. Portal management flow

- `/equipment` navigation entry, shown as hidden/locked by the same rule as Discord (the capability endpoint reports `equipment: 'hidden' | 'locked' | 'available'`).
- **Layout:** Buddy + Combat Stats card (server values only, `—` for unavailable); three slot cards; gear grid with slot/rarity/region filters, search, sort, equipped/favourite/locked toggles and grouped identical items; a compare panel that calls `GET …/combat-stats?attack=<id>` and shows `302 → 340 (+38)`. Preview never writes, and the client never computes a stat.
- **API** (v1 conventions; mutations CSRF-protected and gated by the unlock):

| Method | Path |
|---|---|
| GET | `/players/:playerId/equipment` (filters, `groupBy`, cursor) |
| GET | `/players/:playerId/loadout/active` (with `combatStats` embedded) |
| PUT | `/players/:playerId/loadout/active/slots/:slot` `{ equipmentId, expectedCurrentId? }` |
| DELETE | `/players/:playerId/loadout/active/slots/:slot` |
| PATCH | `/players/:playerId/equipment/:equipmentId` `{ isFavorite?, isLocked? }` |
| GET | `/players/:playerId/combat-stats?attack=&defense=&health=&buddyWaifuId=` |

- A 409 `LOADOUT_CONFLICT` triggers a refetch and a toast; a 403 `FEATURE_LOCKED` renders the locked state.

---

## 11. Admin and content-management flow

Portal Admin gets an **Equipment** section. New permissions `equipment.read`, `equipment.write`, `equipment.grant` (delegable), each with a description.

- **Definitions list:** search by name/key; filter by slot, rarity, region, enabled; owned-instance counts.
- **Editor:** shared Zod validation; `ArtworkPicker` reuse; slot read-only once referenced; enable/disable; delete only when unreferenced (otherwise shows blockers).
- **Import/Export:** preview the diff, then apply; reuses `ContentPromotionPanel` patterns.
- **Player Equipment:** guild-scoped player picker. Shows the unlock state (unlock/revoke, audited); instances with source, `acquired_at` and grant key; the active loadout and presets; Grant; Remove (reason and lock override, audited); "Repair loadout".
- **Staging Test Controls:** add `test_unlock_equipment` / `test_revoke_equipment`, mirroring the Transporter Beacon controls.
- **Discord:** `/waifumon-admin player equipment grant|remove|inspect|unlock` with low per-call caps.

---

## 12. Revised phases and rollout

| Phase | Scope | Player-visible? |
|---|---|---|
| **1 — Foundation** | Migration 0045 (definitions, instances, loadouts, slots, events, import log, feature unlocks); vocabulary; `equipmentMath`; definition schema/service; `equipmentService`; `combatStatsService`; `featureUnlockService`; package, import service and insert-missing seed; retire the item category; wiring; tests | No (only the removal of an unused inventory label) |
| **2 — Admin & content tooling** | Portal admin definitions list/editor, import/export UI, player inspection/grant/remove/unlock; Discord admin subcommands; staging test controls. Author the catalogue on staging and promote to production | Admins only |
| **3 — Onboarding & Discord management** | `give_equipment` and `unlock_feature` effects; scripted encounter start; the onboarding chain (package); Discord Equipment branch with hidden/locked/available states and tutorial mode; `EQUIPMENT_ENABLED` switch | Yes, when enabled |
| **4 — Portal management** | Player API routes and the Portal Equipment page with compare/preview | Yes |
| **5 — Reward integration** | `give_equipment` in other encounters (packages), expedition reward entries, regional shop shelf with `equipment_transactions`, event/admin grants | Yes |
| **6 — Balance & analytics** | SQL reports over `equipment_events` / `player_equipment`; multiplier simulation against the real SP distribution; drop-rate tuning | — |
| **Future** | Equipment-based Boss Attacks (separate combat experience, `snapshotCombatStats`); boss reward-table drops; Relic slot; presets UI; Dungeon; selling/salvage; DB/API cleanup of the retired item category | — |

Rollback: phases 1–5 are additive. The kill switch hides the feature without touching data.

---

## 13. Testing strategy

**Unit (pure)**

- `equipmentMath`: exact halves round up; integer-only arithmetic; bounds.
- Combat stats assembly: empty slot → `null` stat, `missingSlots`, `isComplete=false`; no Buddy → all `null`, `unavailableReason='no_buddy'`; never `0` for unavailable.
- Definition validation: key regex, slot/rarity (N–UR), own-stat > 0, bounds, non-empty `secondaryEffects` rejected, `..` in artwork paths.
- Package build/plan: no numeric ids, unchanged detection, unsupported version refused.
- Loader: `category: "equipment"` in items content is a validation error.

**Constraints (raw SQL against a real DB)** — each must fail:

- a slot row pointing at another player's instance
- a wrong-slot instance
- two rows for the same `(loadout, slot)`
- two active loadouts
- deleting a referenced definition
- a duplicate `grant_key`
- an unknown `feature_key`

And one must **succeed**: the same instance in two different loadouts (R6).

**Ownership and gating**

- Foreign, removed and nonexistent ids give identical 404s; mismatched slot → 409.
- Disabled definition still equipable; disabled definition refused by `grantEquipment` unless `allowDisabled`.
- `equip`/`unequip`/`setFlags` refused before unlock; allowed after.
- `grantEquipment` works before unlock.

**Concurrency** (`Promise.all` against real Postgres)

- N simultaneous equips into one slot → exactly one row, all N resolve, N events.
- Equip racing admin removal → never a slot row pointing at a removed instance, in any loadout.
- Concurrent `grantEquipment` with the same key → one instance.
- Concurrent `ensureActiveLoadout` → one loadout.
- Concurrent `unlock` → one row, exactly one caller reports "newly unlocked".

**Combat stats**

- Swapping the Buddy changes the stats; a released Buddy self-heals to `no_buddy`.
- `slotOverrides` preview never writes.
- A preview with a foreign/removed instance id is rejected like `equip`.

**Seeding and import**

- Insert-missing leaves an admin-edited definition untouched.
- `reset` overwrites (tests only).
- Import never deletes; one transaction; audit row only on success.

**Boundary:** `equipmentBoundary.test.ts`.

**Migration:** apply 0045 to a database populated to the 0044 state.

Later phases add: onboarding chain grants + unlock exactly once (double-click, abandon/restart, restart-after-complete refused); Discord menu hidden/locked/available; API scope and CSRF; stale `eq:*` buttons.

---

## 14. Recommended changes to EquipmentPlan.md

1. §63: remove "Equipment is enabled" from the equip checks; `enabled` gates acquisition only. Add "Equipment feature is unlocked".
2. §7/§8: specify **Current SP**; Effective SP stays reserved.
3. §7: an empty slot makes its stat **unavailable** (no fallback); combat modes require a complete loadout at entry.
4. Store multipliers as basis points with half-up integer rounding; add a formula version.
5. §4: "global" means per guild player row.
6. §10/§65: slot immutable once instances exist; keys immutable; delete only when unreferenced.
7. §52–§54: replace the starter-kit options with the onboarding sequence and the feature unlock; note the scripted-equip exception.
8. §17: no slash command; Equipment is a main-menu branch with hidden/locked/available states; rename "Inventory" to "Gear Bag".
9. §24/§31/§66 Phase 8: current boss encounters are unchanged in V1; equipment combat arrives with future Boss Attacks; boss drops deferred.
10. §72: rarity reuses N/R/SR/SSR/UR codes.
11. §22/§45: admin removal may override the lock, audited.
12. §36: V1 is schema-only for secondary effects; non-empty lists rejected.
13. §23: no events system exists; "event" means admin-run grants.
14. §35: adopt the `CombatStats` snapshot shape.
15. §16: an instance may appear in multiple presets; only the active loadout applies.
16. §59: metrics come from SQL over `equipment_events`.
17. The ordinary-item `equipment` category is retired.
18. §6: adding the Relic slot is a CHECK-widening migration.
19. Content admin is global across guilds.

---

## 15. File-by-file implementation plan

### Phase 1 — Foundation

- **Database:** new `drizzle/0045_equipment_foundation.sql`; [_journal.json](../drizzle/meta/_journal.json) idx 45; [schema.ts](../src/db/schema.ts) (tables, row types, deprecation comment on the `equipment` item category).
- **Domain (new):** `src/modules/equipment/{vocabulary,equipmentMath,definitionSchema,equipmentDefinitionService,equipmentService,combatStatsService,equipmentPackage,equipmentImportService,seed}.ts`; `src/modules/features/{vocabulary,featureUnlockService}.ts`.
- **Errors:** [errors.ts](../src/shared/errors.ts) — `EquipmentNotOwnedError`, `EquipmentSlotMismatchError`, `EquipmentDefinitionNotFoundError`, `EquipmentDefinitionDisabledError`, `EquipmentLockedError`, `EquipmentDefinitionReferencedError`, `LoadoutConflictError`, `FeatureLockedError`, `EquipmentValidationError`.
- **Content:** new `content/equipment/equipment.seed.json`; [loader.ts](../src/modules/content/loader.ts) (retire the category); [waifumon.ts](../src/discord/commands/waifumon.ts) (remove the label).
- **Wiring:** [index.ts](../src/index.ts) (construct services, run seed); [discord/types.ts](../src/discord/types.ts) / [api/context.ts](../src/api/context.ts) service types (no handlers or routes yet).
- **Tests:** see §13.

### Phase 2 — Admin & content tooling

- `src/api/routes/v1/admin/equipment.ts`, `src/api/schemas/equipment.ts`, [portalAuthService.ts](../src/modules/portalAuth/portalAuthService.ts), [routes/v1/index.ts](../src/api/routes/v1/index.ts).
- `portal/src/api/adminEquipment.ts`, `portal/src/features/adminEquipment/*`, [navigation.ts](../portal/src/app/navigation.ts), [router.tsx](../portal/src/app/router.tsx).
- [waifumonAdminPlayer.ts](../src/discord/commands/waifumonAdminPlayer.ts), [commandRegistry.ts](../src/discord/commandRegistry.ts) (admin subcommands only), [stagingTestControlsService.ts](../src/modules/testControls/stagingTestControlsService.ts).

### Phase 3 — Onboarding & Discord management

- World encounters: [types.ts](../src/modules/worldEncounters/types.ts), [effectExecutor.ts](../src/modules/worldEncounters/effectExecutor.ts), [worldEncounterService.ts](../src/modules/worldEncounters/worldEncounterService.ts) (scripted start), [adminService.ts](../src/modules/worldEncounters/adminService.ts), [encounterPackage.ts](../src/modules/worldEncounters/encounterPackage.ts), [encounterImportService.ts](../src/modules/worldEncounters/encounterImportService.ts), [worldEncounterPresenter.ts](../src/discord/worldEncounterPresenter.ts), `WORLD_ENCOUNTER_EFFECT_TYPES` in schema.ts.
- Portal authoring: [EffectEditor.tsx](../portal/src/features/adminEncounters/EffectEditor.tsx), [effectDefaults.ts](../portal/src/features/adminEncounters/effectDefaults.ts), [describe.ts](../portal/src/features/adminEncounters/describe.ts), [useAuthoringData.ts](../portal/src/features/adminEncounters/useAuthoringData.ts).
- Discord: new `src/discord/commands/waifumonEquipment.ts`; [client.ts](../src/discord/client.ts) (`eq:*` handlers); [waifumon.ts](../src/discord/commands/waifumon.ts) (menu branch, Buddy link); [config.ts](../src/config/config.ts) (kill switch, locked presentation).
- Events: [gameEvents.ts](../src/modules/events/gameEvents.ts), [activityFeedService.ts](../src/modules/activity/activityFeedService.ts), [gameEventBuilders.ts](../src/discord/gameEventBuilders.ts).

### Phase 4 — Portal management

- `src/api/routes/v1/equipment.ts`, [resources.ts](../src/api/resources.ts), [capabilities.ts](../src/api/routes/v1/capabilities.ts).
- `portal/src/api/equipment.ts`, `portal/src/api/hooks/useEquipment.ts`, [queryKeys.ts](../portal/src/api/queryKeys.ts), [types.ts](../portal/src/api/types.ts), `portal/src/features/equipment/*`.

### Phase 5 — Reward integration

- [schemas.ts](../src/modules/content/schemas.ts) (expedition entry union), [expeditionRewards.ts](../src/modules/expeditions/expeditionRewards.ts), [expeditionService.ts](../src/modules/expeditions/expeditionService.ts), [reloadService.ts](../src/modules/content/reloadService.ts) (DB key validation), [waifumonExpeditions.ts](../src/discord/commands/waifumonExpeditions.ts).
- Shop: migration for `equipment_transactions`, `src/modules/equipment/equipmentShopService.ts`, the shop screens.

### Docs

- New `docs/equipment.md`; update [content-authoring.md](../docs/content-authoring.md) and [platform-api.md](../docs/platform-api.md) in the phases that change them.

---

## 16. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | Prerequisites for onboarding availability (player level, region, Buddy level, none?) | Phase 3 |
| Q2 | Onboarding teaches by doing (player equips) or uses the scripted `equipForOnboarding`? | Phase 3 |
| Q3 | Phase 1 seed contents: empty, or the three onboarding basics (keys, names and placeholder multipliers signed off, since keys are permanent)? | Phase 1 |
| Q4 | Default locked presentation: `hide` or `show_locked`? | Phase 3 |
| Q5 | Should the regional shop equipment shelf require the unlock? (Assumed yes.) | Phase 5 |

### Assumptions made without asking

- Granting equipment does not require the feature to be unlocked; equipping does.
- `setFlags` (favourite/lock) is gated with equip.
- An unavailable stat is `null`, not `0`.
