Written for: whoever implements Phase 1 (you, or an agent you hand it to).

Phase 1 task: Equipment foundation
Goal: add the Equipment data model, domain services, combat-stat calculation, and content seeding/import, all fully tested. Players see nothing new; the only visible change is removing an item-inventory label that no content uses.

Reference: .ai/EquipmentImplementationPlan.md §0, §3–§6, §7.1, §8, §13. Treat EquipmentPlan.md as background only where the two disagree.

Out of scope
Discord UI, API routes and Portal pages.
World Encounter effects and scripted start, onboarding content.
Expedition, shop and boss integration.
equipment_transactions, game-event kinds, the kill switch, tables.json changes.
Any change to boss encounters.
1. Migration: drizzle/0045_equipment_foundation.sql
Hand-written SQL in the style of 0043. Do not run db:generate.
Add the journal entry at idx 45, with when greater than 1819576800000.
Create six tables, exactly as in plan §3:
equipment_definitions
player_equipment
player_loadouts
player_loadout_slots
equipment_events
equipment_import_log
player_feature_unlocks
Constraints to include:
The own-stat CHECK and the hard bound CHECKs on definitions.
ON DELETE RESTRICT from instances to definitions.
UNIQUE (id, player_id, slot) on instances.
The composite FKs from player_loadout_slots to loadouts (CASCADE) and to instances (RESTRICT).
PK (loadout_id, slot) and UNIQUE (loadout_id, equipment_id) on slots.
The partial unique indexes on grant_key and on the active loadout.
PK (player_id, feature_key) on unlocks.
Every statement uses IF NOT EXISTS or is otherwise idempotent.
Mirror everything in src/db/schema.ts: tables, row types, and CHECKs built from the vocabulary SQL lists. Add a deprecation comment on the equipment value of ITEM_CATEGORIES.
2. Vocabulary
src/modules/equipment/vocabulary.ts: slots, source types (including onboarding) and event kinds, each with an *_SQL_LIST.
src/modules/features/vocabulary.ts: FEATURE_KEYS = ['equipment'] and unlock sources ['onboarding','admin','migration'].
3. equipmentMath.ts (pure)
EQUIPMENT_FORMULA_VERSION = 1.
deriveStat(currentSp, bp) returns Math.round(currentSp * bp / 10000):
The numerator must be an integer.
Rounding is half-up.
Throws on a non-integer or negative input.
Bound constants matching the DB CHECKs.
No fallback multipliers.
4. definitionSchema.ts
A Zod EquipmentDefinitionInput keyed by key, with no id.
Rules:
Key regex ^[a-z0-9_]+$, at most 64 characters.
Slot must be a known slot; rarity must be N–UR.
The definition's own-slot multiplier must be greater than 0.
V1 requires the other two multipliers to be 0.
Bounds are enforced.
secondaryEffects must be [].
regionId, if present, must be a known region.
artworkPath must not contain ...
shopRegions must be known regions.
Failures throw EquipmentValidationError with paths ("fail loudly").
5. equipmentDefinitionService.ts
Operations: listDefinitions(filters), getByKey, create, update, setEnabled, delete.
update refuses to change slot once any instance references the definition. key can never change.
delete returns blockers (instance count) and refuses when the definition is referenced. The FK is the backstop.
Writes updated_by.
6. featureUnlockService.ts
Operations: isUnlocked(playerId, key), listUnlocked(playerId), unlock(tx, {playerId, featureKey, source, sourceRef?, actorDiscordId?}), revoke(tx, {…, actorDiscordId, reason}).
unlock is INSERT … ON CONFLICT DO NOTHING and returns { newlyUnlocked }.
revoke writes a recordAdminAction row.
7. equipmentService.ts: the only writer of instances and loadouts
grantEquipment(tx, input):
Resolves the definition by key; unknown → EquipmentDefinitionNotFoundError.
A disabled definition → EquipmentDefinitionDisabledError, unless allowDisabled is set.
Quantity must be 1–5.
Copies slot from the definition onto the instance.
Per-copy grant_key is ${grantKey}:${i}, inserted with ON CONFLICT DO NOTHING so a retry reads the existing rows back and reports alreadyGranted.
Writes one granted event per new instance.
Never touches loadouts and does not require the unlock.
listEquipment: filters, groupBy: 'definition', keyset cursor. Excludes removed instances.
getActiveLoadout: a pure read that returns a virtual empty loadout when none exists.
ensureActiveLoadout(tx): idempotent insert against the partial unique index.
equip / unequip:
Refused with FeatureLockedError until the feature is unlocked.
Lock order is loadout FOR UPDATE, then the instance.
Checks ownership and removed_at, with identical 404s for foreign, removed and missing ids.
Slot mismatch → 409; expectedCurrentId mismatch → LoadoutConflictError.
Upserts the slot row and writes an event recording the previous item.
Does not check the definition's enabled flag.
setFlags: gated by the unlock; writes a flag_changed event.
adminRemove(tx):
Locks the player's loadouts, deletes the instance's slot rows from every loadout, then sets removed_at and removed_reason.
A locked instance requires overrideLock.
Writes a removed event and a recordAdminAction row.
8. combatStatsService.ts: the only stat calculation
calculateCombatStats(playerId, { buddyWaifuId?, slotOverrides? }):
Resolves the Buddy with resolveActiveBuddy, or validates an explicitly supplied copy (owned and not released).
Uses Current SP from currentSeductivePower with maxLevel from content.
Reads the active loadout, applies overrides after the same ownership and slot validation equip uses, and never writes.
Returns the plan §5 CombatStats shape: null stats for empty slots or no Buddy, plus missingSlots, isComplete, unavailableReason, and appliedEffects: [].
snapshotCombatStats(tx, playerId): the same result, read inside the caller's transaction.
9. Content movement
equipmentPackage.ts (pure):
Format waifumon-equipment v1; build and plan an import (create, update, unchanged).
Refuse unknown versions and any package containing ids.
Plan issues include a slot change on a referenced definition.
equipmentImportService.ts:
Applies in one transaction, recomputing the plan inside it.
Never deletes.
Writes an equipment_import_log row only on success.
seed.ts: seedEquipmentDefinitions(db, { mode: 'insert-missing' | 'reset', catalogue? }), reading content/equipment/equipment.seed.json in package format.
Call the seed from src/index.ts next to seedWorldEncounters, wrapped so a failure logs and continues.
Blocked on Q3: decide whether the seed ships empty or with three signed-off onboarding basics.
10. Retire the item category
In loader.ts, category: "equipment" in items content becomes a ContentValidationError. This replaces the expedition-reward guard and warnOnEnabledEquipment.
Remove the equipment entry from INVENTORY_CATEGORY_DISPLAY in waifumon.ts.
Leave the DB CHECK and the API enum unchanged.
11. Wiring and errors
Construct the services in index.ts and add them to the AppServices and ApiContext types. No handlers or routes consume them yet.
Add the new error classes to errors.ts, with the HTTP status mapping each would use later.
12. Tests (plan §13, Phase 1 subset)
Unit:
equipmentMath: halves round up, integer inputs only.
Combat-stat assembly: null for unavailable stats, never 0.
Definition schema rules.
Package build and plan.
Loader rejects the retired category.
Integration (real Postgres):
Every constraint violation listed in §13, plus the case that must succeed: one instance in two loadouts.
Ownership: identical 404s; wrong slot; disabled definition still equipable; grant refuses a disabled definition unless allowDisabled.
Unlock gating: equip refused before unlock, allowed after; grant works before unlock.
Concurrency (Promise.all):
N equips into one slot → one row, N events.
Equip racing adminRemove → no dangling slot row.
Duplicate grantKey → one instance.
ensureActiveLoadout → one loadout.
unlock → one row, and exactly one caller sees newlyUnlocked.
Combat stats: Buddy swap, released Buddy, overrides never write.
Seeding: insert-missing preserves an edited row; reset overwrites.
Import: atomic, never deletes, log row only on success.
Migration: 0045 applies cleanly on a database at the 0044 state.
Boundary: equipmentBoundary.test.ts confirms that only modules/equipment writes the equipment tables and only modules/features writes player_feature_unlocks.
Acceptance criteria
npm run typecheck and npm test pass.
The migration applies on a fresh database and on one at the 0044 state.
Startup seeds without errors and a restart changes nothing.
No Discord, API or Portal behaviour changes apart from the removed label.
Nothing other than the equipment and features modules writes the new tables, and equipmentBoundary.test.ts enforces it.
Before starting
Q3: decide the seed contents.
Confirm the working branch. Phase 1 could live on V2Encounter or on a new branch.
Nothing is implemented or committed.