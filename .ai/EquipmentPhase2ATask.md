Phase 2A task: Equipment onboarding and starter catalogue

Goal: players at Trainer Level 35 or above can complete a short onboarding with Patch. It grants Rusty Pipe, Scrap Plate and Dented Lunchbox, explains SP → ATK/DEF/HP with their real Buddy, equips the three items into empty slots, and unlocks the `equipment` feature. After that, the main menu opens a read-only Equipment overview.

Reference: .ai/EquipmentPhase2A.md (the approved design; decisions D1–D10). Phase 1 on `origin/Equipment` is the baseline.

Before starting

- Branch from `origin/Equipment`, not from `V2Encounter` or `Assteroid`, which lack Phase 1.
- Get the signed-off narrative copy for `content/onboarding/equipment.json` and the Patch entry in `content/npcs.json` (D8). If you start before the copy is ready, use strings prefixed `[DRAFT]`. Tests must not assert exact copy. Onboarding must not be enabled anywhere until the real copy replaces them.
- Nothing is implemented or committed yet.

Out of scope

- Equip/unequip UI, gear bag, the Portal Equipment page.
- Shops, and Expedition, boss or generic World Encounter equipment rewards.
- A `give_equipment` or `unlock_feature` WE effect, and any change to the World Encounter engine, its tables or packages.
- Dungeon, Raid, affixes, crafting, upgrades.
- Any change to `combatStatsService` (D9).
- Migrations: this phase adds none.

1. Starter catalogue

`content/equipment/equipment.seed.json`: add three definitions, all `rarity: "N"`, `tags: ["starter","onboarding"]`, `artworkPath: null`, `regionId: null`, `shopRegions: []`, `buyPrice: null`, `enabled: true`, with the other two multipliers at 0:

- `rusty_pipe`: name "Rusty Pipe", description "Still hits. Still embarrassing.", slot attack, `attackBp: 4500`.
- `scrap_plate`: name "Scrap Plate", description "Bolted together hope.", slot defense, `defenseBp: 3500`.
- `dented_lunchbox`: name "Dented Lunchbox", description "Keeps something alive.", slot health, `healthBp: 20000`.

Update the seed label to reflect that the file is no longer empty. Keys are permanent. Do not rename them.

2. Onboarding vocabulary and state (pure)

Create `src/modules/onboarding/vocabulary.ts` with:

- `EQUIPMENT_ONBOARDING_MIN_LEVEL = 35`.
- `EQUIPMENT_ONBOARDING_STEPS = ['intro','attack','defense','health','explain','complete']`.
- `STARTER_EQUIPMENT: Record<EquipmentSlot, string>` = `{ attack: 'rusty_pipe', defense: 'scrap_plate', health: 'dented_lunchbox' }`.
- `onboardingGrantKey(playerId, slot)` returns `onboarding:equipment:${playerId}:${slot}`. The stored per-copy key is that key plus `:0`. Export a helper for the stored form too.
- `EQUIPMENT_ONBOARDING_SOURCE_REF = 'equipment_onboarding:v1'`.

Create `src/modules/onboarding/onboardingState.ts` with `deriveEquipmentOnboardingState(input)`:

- Input: `{ level, unlocked, granted: Record<EquipmentSlot, boolean>, enabled, ready }`.
- Output: `{ phase: 'not_eligible'|'eligible_unavailable'|'pending'|'in_progress'|'completed', nextStep: Step|null }`.

Rules (design §2):

- `unlocked` → `completed` (nextStep null).
- Any grant present counts as started, whatever the level.
- Not started and level < 35 → `not_eligible`.
- Eligible or started but `!enabled || !ready` → `eligible_unavailable`.
- 0 grants → `pending` with nextStep `intro`.
- Otherwise `in_progress` with nextStep = the first missing of attack, defense, health, or else `explain`.

Also export `equipmentEntryState(state)`, which maps to `'hidden'|'begin'|'resume'|'available'`. `completed` is `available` even when `!enabled`.

3. Content: NPCs and onboarding narrative

- Add `content/npcs.json`: an array of `{ key, name, title?, description?, portraitPath? }`. Keys use the `^[a-z0-9_]+$` pattern and must be unique. First entry: `patch` / "Patch", with `portraitPath: null`.
- Add `content/onboarding/equipment.json` in the exact shape of design §7 (`format: "waifumon-onboarding"`, `version: 1`, `flow: "equipment"`, `npc`, `menu`, `levelUpLabel`, `steps`).
- In `src/modules/content/schemas.ts` and `loader.ts`:
  - Add Zod schemas for both files. `steps` must contain exactly the six step keys. `explain` additionally requires `noBuddyBody`.
  - `npc` must exist in the registry.
  - Artwork paths go through the existing artwork-path validation.
  - Failures are `ContentValidationError`s with paths.
  - Expose the results as `content.npcs` and `content.onboarding.equipment`.

4. Equipment service additions (`src/modules/equipment/equipmentService.ts`)

`findByGrantKeys(tx, playerId, grantKeys)`:

- Reads instances by stored grant key for this player, **including removed ones**, joined to their definition.
- Returns a map from grant key to `{ instance, definition, removed }`.

`equipForOnboarding(tx, playerId, items: Partial<Record<EquipmentSlot, number>>)`:

- Calls `requireUnlocked(tx, playerId)` first. Throw `FeatureLockedError` if the unlock isn't visible through `tx`.
- Then `lockActiveLoadout(tx, playerId)` (lock order: loadout, then instance).
- For each slot:
  - Validate the instance is owned, not removed, and has a matching slot. Otherwise record it as `skipped` with a reason (`not_owned|removed|slot_mismatch`), without throwing.
  - If the slot already holds anything → `kept` with the current id. Never overwrite.
  - Otherwise insert the slot row and write an `equipped` event with `metadata: { definitionKey, reason: 'onboarding' }`.
- Returns `{ equipped: EquipmentSlot[], kept: {slot, equipmentId}[], skipped: {slot, equipmentId, reason}[] }`.
- Idempotent. A second call reports every slot as `kept`.

`adminReleaseGrantKeys(tx, { playerId, grantKeys, actorDiscordId, reason })`:

- Sets `grant_key = NULL` only on this player's instances that are already removed and carry one of the keys.
- Writes a `recordDomainAdminAction` row.
- Returns the count. Used only by the staging reset.

Also:

- Add all three methods to the `EquipmentService` interface.
- Do not touch `grantEquipment`, `equip` or `combatStatsService`.

5. Onboarding service (`src/modules/onboarding/equipmentOnboardingService.ts`)

Dependencies:

- `db`
- `equipment: Pick<EquipmentService, 'grantEquipment'|'findByGrantKeys'|'equipForOnboarding'|'getActiveLoadout'>`
- `featureUnlocks`
- `combatStats`
- `resolveActiveBuddy`
- `getContent()` (read live)
- `enabled: boolean`
- `logger`

Methods:

`isReady(tx?)`: all three starter keys exist in `equipment_definitions`. Enabled status doesn't matter. Returns `{ ready, missingKeys }`.

`getState(playerId)`: reads the level, the unlock and the grant keys, then calls `deriveEquipmentOnboardingState`. When the player would be offered onboarding but `ready` is false, log a warning.

`advance(playerId, fromStep)` returns a view model for the step to render:

- If the recomputed state is `completed`, return the overview.
- If it is not offered (`not_eligible`/`eligible_unavailable`), return `{ kind: 'unavailable' }`.
- If `fromStep !== nextStep`, return the current `nextStep` view without writing. `intro` is a special case: `fromStep = 'intro'` while nextStep is `intro` renders `attack` without a write. Otherwise a mismatch means a stale button.
- If `fromStep` is `attack`, `defense` or `health` and matches, one transaction runs `grantEquipment({ playerId, definitionKey, quantity: 1, source: { type: 'onboarding', key: 'equipment' }, grantKey: onboardingGrantKey(playerId, slot), allowDisabled: true })`, then the service renders the next step.
- If `fromStep` is `explain`, delegate to `complete`.

The `explain` view model:

- Resolve the Buddy. With no Buddy, return `{ kind: 'needs_buddy' }`.
- Otherwise call `calculateCombatStats(playerId, { slotOverrides: { attack, defense, health } })` with the three onboarding instance ids, taking only unremoved ones.
- Return the Buddy name, Current SP, each item's name and multiplier, and the derived ATK/DEF/HP.

`complete(playerId)`: one `db.transaction`, as in design §4:

1. Already unlocked → return the overview.
2. Re-apply the three grants.
3. `resolveActiveBuddy(tx)`. If null, return `{ kind: 'needs_buddy' }` without committing any unlock or equip. Because the grants are idempotent, re-applying them is harmless. Leaving the grants committed is acceptable.
4. `featureUnlocks.unlock(tx, { playerId, featureKey: 'equipment', source: 'onboarding', sourceRef: EQUIPMENT_ONBOARDING_SOURCE_REF })`.
5. `equipment.equipForOnboarding(tx, playerId, …)` with the unremoved onboarding instances.

After commit, return the `complete` view: the equip report, and `calculateCombatStats(playerId)` for the real loadout.

`overview(playerId)`: read-only. Returns the active loadout plus `calculateCombatStats(playerId)`. Callers check the unlock.

Enforce the kill switch in `advance` and `complete`. When `!enabled`, return `{ kind: 'unavailable' }`. `overview` is not gated by it.

6. Level-35 label

- In `progressionService.ts`, add optional `extraLevelRewardLabels?: (level: number) => string[]` to `ProgressionServiceDeps`. `svc.describeLevelRewards(L)` appends its result. Pure `progressionMath.describeLevelRewards` stays unchanged.
- In `index.ts`, pass a closure that returns `[content.onboarding.equipment.levelUpLabel]` when `L === EQUIPMENT_ONBOARDING_MIN_LEVEL` and the flag is on, and `[]` otherwise. It reads content live. It must not depend on the onboarding service, to avoid a construction cycle.
- The label must reach every level-up screen through `LevelUpEvent.rewardLabels`. Verify this for hunt, capture, daily, expedition claim and the WE `player_xp` effect.

7. Config and wiring

- `src/config/config.ts`: `EQUIPMENT_ONBOARDING_ENABLED`, a boolean env var defaulting to false, following the `*_ENABLED` pattern.
- `src/index.ts`:
  - construct the onboarding service after the equipment services and add it to `AppServices`/`AppContext` (`src/discord/types.ts`);
  - after `seedEquipmentDefinitions`, log `isReady()` (ready or missing keys) with a stable tag;
  - a failure logs and continues, as the seeds do.

8. Discord

Create `src/discord/onboardingPresenter.ts`, a pure builder of view models into embeds and components, with World Encounter styling:

- Title, body and optional artwork come from content, plus a Patch author line (name, and portrait if set).
- Steps 1–3 show the item's name, description, slot emoji (⚔️ 🛡️ ❤️) and `×multiplier`.
- `explain` appends a code-rendered stat block, for example `Your Buddy **Name** has **280** Current SP.` followed by `Rusty Pipe: 280 × 0.45 = 126 ATK` (and the equivalent DEF and HP lines).
- `needs_buddy` uses `noBuddyBody` with [Open Collection] (`menu|collection`) and [Back to menu] (`menu|start`).
- `complete` and overview share one renderer: Buddy name and Current SP; each slot's item and `×multiplier`, or "Empty"; ATK/DEF/HP with `—` for null; any "kept your X" lines; a note that gear management is coming soon; and [Back to menu].
- `unavailable` shows a short "not available right now" message with [Back to menu].

Create `src/discord/commands/waifumonOnboarding.ts` with these handlers:

- `onb|open|equipment`
- `onb|adv|equipment|<fromStep>`
- `onb|done|equipment`
- `onb|view|equipment` (checks `isUnlocked` and refuses otherwise)

Each handler:

- recomputes server-side and validates `fromStep` against the step list;
- responds through `respondEphemeral`;
- turns `AppError`s into their `userMessage`.

Register them in `src/discord/client.ts`.

`src/discord/commands/waifumon.ts`:

- `renderMainMenu` fetches `getState` and passes the entry state to `menuComponents(care, questsEnabled, equipmentEntry)`.
- Bottom-row button:
  - `begin`/`resume`: Primary, with content `menu.beginLabel`/`resumeLabel`, → `onb|open|equipment`;
  - `available`: Secondary "Equipment", emoji ⚔️, → `onb|view|equipment`;
  - `hidden`: no button.
- While `begin`/`resume`, add a menu field using `menu.fieldName` and `beginText`/`resumeText`, and add Equipment to the Actions legend while visible.
- An onboarding failure must never break the menu. Log it and render as `hidden`.

9. Tests

Unit tests:

- `deriveEquipmentOnboardingState` / `equipmentEntryState`: a table covering every phase, including started-below-35, completed-while-disabled and not-ready.
- `onboardingGrantKey` and its stored form.
- Content schemas: a valid file, a missing or extra step, an unknown npc, `explain` without `noBuddyBody`, a bad artwork path, duplicate NPC keys.
- The seed contains exactly the three starters with the D2 values, and they parse with `EquipmentDefinitionInputSchema`.
- Presenter:
  - the explain block for 280 SP reads 126 / 98 / 560;
  - null stats render as `—`;
  - `needs_buddy` buttons;
  - `advance` buttons carry the right `fromStep`.
- `menuComponents`: hidden, begin, resume and available, with no row over 5 buttons.
- `describeLevelRewards`: the label appears only at 35 and only when the flag is on.

Integration tests (real Postgres), in `tests/integration/equipmentOnboarding*.test.ts`:

- Full lifecycle, level 35 through completion:
  - one instance per starter, `source_type 'onboarding'`, expected grant keys;
  - one unlock row with source `onboarding`;
  - three slots equipped with `equipped` events whose `reason` is `onboarding`;
  - final stats match `calculateCombatStats`.
- Stale or duplicate `advance`, including `Promise.all` of the same step: exactly one instance.
- Concurrent `complete`: one unlock row, exactly one `newlyUnlocked`, each slot filled once.
- Abandon after the defense step, then build a new service instance on the same DB: the state is `in_progress` with nextStep `health`, and finishing works.
- Admin-granted `rusty_pipe` (different key) before onboarding: onboarding grants and equips its own copy.
- A slot pre-filled (unlock, `equip`, revoke, then run onboarding): the slot is kept and reported, never overwritten.
- A starter instance removed by admin: the step counts as done, equip skips it with `removed`.
- A disabled starter definition: still granted.
- A missing starter definition: `ready=false` and not offered.
- No Buddy at completion: `needs_buddy`, no unlock row, no loadout slots written. Set a Buddy and completion succeeds.
- Buddy swapped between `explain` and `complete`: completion stats use the new Buddy. A released Buddy leads to `needs_buddy`.
- Level 34 is `not_eligible`. Lowering the level after the first grant stays `in_progress`.
- Admin unlock before onboarding: `completed`, and `advance` returns the overview without granting.
- Kill switch off: `advance`/`complete` return `unavailable` and write nothing. The overview still works for an unlocked player.
- `calculateCombatStats` with `slotOverrides` succeeds before the unlock and writes nothing (D9).
- `equipForOnboarding` before the unlock throws `FeatureLockedError`.
- Staging reset: afterwards the state is `pending` and a full replay succeeds with fresh instances.
- Normal `grantEquipment` still never creates loadout rows (existing tests stay green).

Boundary tests (`tests/unit/equipmentBoundary.test.ts`):

- Only `src/modules/onboarding/` calls `equipForOnboarding`.
- Only `src/modules/testControls/` calls `adminReleaseGrantKeys`.
- The existing table-writer rules still hold. The onboarding module writes no equipment or feature tables directly.

Discord handler tests: a stale `fromStep`, a malformed step arg, a foreign player's click (ids carry no player, so the handler must use `prov.playerId`), and `onb|view` before unlock is refused.

10. Staging test control

- In `src/modules/testControls/stagingTestControlsService.ts`, add `test_reset_equipment_onboarding`, following the existing `run(actor, playerId, …)` pattern. It:
  1. revokes the `equipment` unlock (with a reason);
  2. calls `adminRemove` on every instance holding one of the player's three onboarding grant keys (`overrideLock: true`);
  3. calls `adminReleaseGrantKeys` for those keys.
- Expose it in `src/api/routes/v1/admin/testControls.ts`, and in the Portal test-controls UI if that page lists actions from a static set.
- Include the onboarding state in the player snapshot the controls return.

Acceptance criteria

- `npm run typecheck` and `npm test` pass.
- No new migration. Startup on a fresh DB and on a Phase 1 DB seeds the three starters. A restart changes nothing, and the log reports onboarding ready.
- With the flag off: no player-visible change except that unlocked players (admin-unlocked only) see the read-only Equipment button.
- With the flag on:
  - a level-35+ player sees the CTA, completes onboarding with the gear equipped and the feature unlocked, and afterwards sees the read-only overview;
  - a level-34 player sees nothing;
  - reaching 35 shows the label on the level-up screen, and nothing opens automatically.
- `combatStatsService` is unchanged.
- World Encounter code, tables and packages are unchanged.
- The boundary tests enforce the new privileged methods.
