# Equipment Phase 2A — Onboarding & Starter Catalogue (plan)

Status: **implemented on branch `EquipmentPhase2A` (from `origin/Equipment` eafafe5), uncommitted, awaiting review.** Baseline: Phase 1 (migration 0045). The implementation task is [EquipmentPhase2ATask.md](EquipmentPhase2ATask.md).

Background: [EquipmentImplementationPlan.md](EquipmentImplementationPlan.md) §7.2 and §9 (on the Equipment branch). Where the two disagree, this document wins.

---

## 0. Decisions (signed off)

| # | Decision |
|---|---|
| D1 | A dedicated onboarding service owns the flow. It is **not** built on the World Encounter engine, its active-encounter rows, or DB-authored WE content. It is presented in the World Encounter visual style. |
| D2 | Starter catalogue, all rarity `N`, tags `["starter","onboarding"]`: `rusty_pipe` (Rusty Pipe, *Still hits. Still embarrassing.*, attack 4500 bp); `scrap_plate` (Scrap Plate, *Bolted together hope.*, defense 3500 bp); `dented_lunchbox` (Dented Lunchbox, *Keeps something alive.*, health 20000 bp). Keys are final and permanent. |
| D3 | Narrative lives in git-managed `content/onboarding/equipment.json`, validated at content load. It is not Portal-authored. |
| D4 | Delivery is a persistent main-menu CTA plus a level-35 level-up reward label. Onboarding is never opened automatically. |
| D5 | After unlock the Equipment button stays visible and opens a **read-only** Equipment / combat overview. Management (equip, unequip, gear bag) is Phase 2B. |
| D6 | Eligibility is `players.level >= 35`, evaluated when read. Every existing player at level 35 or above becomes eligible when the feature is enabled. No backfill. |
| D7 | No bespoke artwork is needed for launch. Artwork-path support stays. Generic slot visuals (⚔️ 🛡️ ❤️) and an optional NPC portrait are acceptable. |
| D8 | The onboarding character is **Patch**, a reusable equipment/scavenger NPC defined in a small NPC registry, not inside the onboarding file. Narrative copy is written and reviewed separately **before** implementation. |
| D9 | `combatStatsService.calculateCombatStats()` stays policy-free. It does **not** check the Equipment unlock and remains usable with `slotOverrides` before unlock. Feature access is the **caller's** job: onboarding may preview before unlock, and future equipment-based combat entry points must require the `equipment` unlock plus whatever loadout completeness they need. |
| D10 | Approved as proposed: the derived state machine (§2), fixed grant-key progression, Buddy required at completion, fill-empty-slots-only tutorial equip, `allowDisabled` onboarding grants, and resumability. |

Out of scope: full Equipment inventory UI, Portal Equipment pages, shops, Expedition/boss/generic World Encounter equipment rewards, Dungeon, Raid, affixes, crafting, upgrades.

---

## 1. Architecture

```
main menu CTA ──► onb:* Discord handlers ──► EquipmentOnboardingService
                                              │  getState / advance / complete / isReady
                                              ├─► equipmentService.grantEquipment        (steps 1–3)
                                              ├─► featureUnlocks.unlock                  (completion)
                                              ├─► equipmentService.equipForOnboarding    (completion)
                                              └─► combatStats.calculateCombatStats       (explain preview / overview)
content/onboarding/equipment.json + content/npcs.json ──► presenter (WE-style embed)
```

Why not a World Encounter chain (audit summary):

- `active_world_encounters.source` and history `source` are CHECKed to `hunt|travel`.
- Active rows expire after about 10 minutes and are swept.
- Only one encounter can be pending per player.
- WE content is DB-authoritative and Portal-editable, so a disabled node silently ends a chain (`followUpBlock`). A progression gate must not depend on that.
- A scripted root would fail the "unreachable" rule.
- WE text has no templating for real SP numbers.
- A generic `give_equipment` effect is out of scope.

**Reused:** the embed layout and Buddy line from `worldEncounterPresenter`, artwork resolution helpers, `respondEphemeral`, `buildCustomId`, the gift-reminder menu-field pattern, `recordDomainAdminAction`, and staging test controls.

---

## 2. State machine (derived, nothing new persisted)

Inputs:

- `players.level`
- whether the `equipment` feature unlock row exists (any source)
- which of the three fixed onboarding grant keys exist (removed instances still count)
- `EQUIPMENT_ONBOARDING_ENABLED`
- `ready`, meaning all three definitions exist

| State | Condition | Menu |
|---|---|---|
| `not_eligible` | level < 35 ∧ no starter grant ∧ ¬unlocked | hidden |
| `eligible` (unavailable) | level ≥ 35 ∧ ¬unlocked ∧ (¬enabled ∨ ¬ready) | hidden (logged when ¬ready) |
| `pending` | eligible ∧ enabled ∧ ready ∧ 0 grants | **Begin** CTA |
| `in_progress` | ¬unlocked ∧ ≥1 grant ∧ enabled ∧ ready. `nextStep` = first missing of attack → defense → health, otherwise `explain` | **Resume** CTA |
| `interrupted` | Not a stored state. It is `in_progress` with no screen open, and resumes identically. | Resume CTA |
| `completed` | unlocked (onboarding, admin or migration) | **Equipment** → read-only overview (visible even when onboarding is disabled) |

Notes:

- Once any grant exists the flow counts as started even if level is later lowered (staging), so it never disappears midway.
- Passing the intro writes nothing. A player who leaves after the intro sees the intro again on resume.
- An admin unlock means completed. Onboarding does not run and grants nothing.
- An admin revoke after completion returns the player to `in_progress`/`explain`. Finishing again only fills empty slots.

---

## 3. Step structure

| # | Step | Primary button | Server action |
|---|---|---|---|
| 0 | `intro` — Patch introduces herself and Equipment in-world | content | none → render `attack` |
| 1 | `attack` — Rusty Pipe; "Attack gear converts your Buddy's SP into ATK" | content | grant `rusty_pipe` → render `defense` |
| 2 | `defense` — Scrap Plate; SP → DEF | content | grant `scrap_plate` → render `health` |
| 3 | `health` — Dented Lunchbox; SP → HP | content | grant `dented_lunchbox` → render `explain` |
| 4 | `explain` — real numbers from the current Buddy (below). Needs a Buddy. | content | completion transaction (§4) → render `complete` |
| 5 | `complete` — equipped loadout and final ATK/DEF/HP, "Equipment unlocked" | Back to menu | none |

- **Explain numbers** come from `calculateCombatStats(playerId, { slotOverrides: { attack, defense, health } })`, using the onboarding's own instances. For example, 280 SP gives 280 × 0.45 = **126 ATK**, 280 × 0.35 = **98 DEF** and 280 × 2.00 = **560 HP**. Code renders the stat block. Content supplies the prose only (no templating).
- **No Buddy at `explain`:** render the content's `noBuddy` text with [Open Collection] and [Back to menu]. Nothing is written, and the CTA stays `in_progress`.
- **Buddy changes or is released midway:** nothing about the Buddy is persisted. Every render and the completion transaction re-resolve it. A released Buddy self-heals to null, which takes the no-Buddy path.
- **Stale or double-clicked buttons:** every advance button carries `fromStep`. The server recomputes state. On a mismatch it repaints the current step and writes nothing.
- **The intro is never recorded.** A player whose derived step is still `intro` may be on the intro screen or on the attack hand-over, which is reached from the intro with no write. Both buttons are therefore live (`isCurrentStep`).
- **"Gear up"** is `onb|done|equipment`. It completes only when the derived step is `explain`; from anywhere earlier it repaints the current step.

---

## 4. Grant / equip / unlock sequence

**Grant key.** The base key is `onboarding:equipment:{playerId}:{slot}`. `grantEquipment` stores copy 0 as `…:{slot}:0`. The call is `source: { type: 'onboarding', key: 'equipment' }`, `quantity: 1`, `allowDisabled: true`.

**Steps 1–3.** Each is one transaction with one grant, and is idempotent through the key.

**Completion** (`complete(playerId)`) is one transaction:

1. If `isUnlocked(tx)` is true, commit nothing and render `complete`/overview.
2. Re-apply all three grants (idempotent; repairs any partial state).
3. `resolveActiveBuddy(tx)`. If it returns null, abort (no writes) and render the no-Buddy screen.
4. `featureUnlocks.unlock(tx, { featureKey: 'equipment', source: 'onboarding', sourceRef: 'equipment_onboarding:v1' })`.
5. `equipmentService.equipForOnboarding(tx, playerId, { attack, defense, health })`. It requires the unlock, read through `tx`. It fills **empty slots only**, and only with owned, unremoved instances whose `source_type` is `onboarding` (only the onboarding grants with that source, always under its fixed keys). Anything else is reported as skipped, never thrown. It writes an `equipped` event with `metadata.reason = 'onboarding'`. It returns the slots it equipped, kept or skipped.

Equipping happens only at completion, inside the unlock transaction. So no loadout is created by onboarding before the unlock, and normal rewards still never equip.

---

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Double-click or concurrent advance | Step check plus grant-key uniqueness give one instance per step |
| Concurrent completion | One unlock row, exactly one `newlyUnlocked`. The fill-empty rule makes equip idempotent. |
| Abandoned, restarted, or the bot restarts | All state is in the DB. The CTA resumes at the first missing grant. |
| Player already owns a starter (admin grant) | Onboarding grants and equips its own keyed copy. A duplicate starter is harmless. |
| Slot already filled | Kept. The complete screen reports "kept your X". |
| Better gear owned | No comparison, never replaced |
| Grant retried | `alreadyGranted`, nothing new |
| Starter instance removed by admin | Counts as granted. Skipped by equip. |
| Starter definition disabled | Still granted (`allowDisabled`) |
| Starter definition missing | `ready = false`: CTA hidden, startup and state warnings logged, player stays eligible |
| No Buddy at level 35 | Steps 0–3 run. `explain` prompts for a Buddy. Completion is refused until one is set. |
| Pending World Encounter | Unaffected. Onboarding never touches WE tables. |
| Feature disabled mid-flow | CTA hidden. `onb:*` handlers answer "not available right now". State is preserved. |

---

## 6. Schema

**No migration.** The `'onboarding'` value already exists in both `EQUIPMENT_SOURCE_TYPES` and `FEATURE_UNLOCK_SOURCES`, and all other state is derived.

---

## 7. Content

- **`content/equipment/equipment.seed.json`** gets the three definitions from D2 (`artworkPath: null`, `regionId: null`, no shop). The seed only inserts missing keys. Later edits to name, description or multiplier go through an equipment import package.
- **`content/npcs.json` (new).** A reusable NPC registry: `{ key, name, title?, description?, portraitPath? }`. Initial entry: `patch`.
- **`content/onboarding/equipment.json` (new)**, final copy, validated by `src/modules/content/onboardingSchemas.ts`:

```json
{
  "format": "waifumon-onboarding",
  "version": 1,
  "flow": "equipment",
  "npc": "patch",
  "menu": { "fieldName": "…", "beginText": "…", "resumeText": "…" },
  "levelUpLabel": "🔧 Equipment training available — check the Waifumon menu.",
  "unavailableText": "…",
  "steps": {
    "intro":    { "title": "…", "narration": "…", "say": "…", "button": "Hear her out", "artworkPath": null },
    "attack":   { "title": "…", "narration": "…", "say": "…", "button": "Take the Rusty Pipe", "artworkPath": null },
    "defense":  { "…": "…" },
    "health":   { "…": "…" },
    "explain":  { "title": "…", "say": "…", "sayAfter": "…", "button": "Gear up", "artworkPath": null,
                  "noBuddy": { "title": "…", "narration": "…", "say": "…" } },
    "complete": { "title": "Equipment Unlocked", "say": "…", "button": "Back to Waifumon", "artworkPath": null }
  }
}
```

Rules:

- `steps` is `.strict()` and every key is required, so it names exactly the six steps.
- Every step needs `narration`, `say` or both.
- Button labels are capped at 80 characters, Discord's limit.
- `npc` must exist in `content/npcs.json`, checked by `validateOnboardingContent`.
- Artwork paths go through `relativeArtworkPath`.
- Both files are optional on disk. Without the narrative, the onboarding is simply not ready.

Code renders the item card (name, gear type, multiplier, description) and the stat lines. Content supplies only prose. The menu button labels (`🔧 Equipment ✨`, `⚔️ Equipment`) are code constants.

---

## 8. Services

- **`modules/onboarding/`** (new):
  - `equipmentOnboardingService`: `getState`, `open` (Begin/Resume, no writes), `advance(playerId, fromStep)`, `complete(playerId)`, `isReady()`, `content()`, and `overview(playerId)`, a read-only view built on `calculateCombatStats` that requires the unlock but not the switch.
  - `onboardingState.ts`: the pure derivation.
  - `vocabulary.ts`: steps, starter keys per slot, `EQUIPMENT_ONBOARDING_MIN_LEVEL = 35`, and the grant-key builder.
- **`equipmentService`:**
  - `equipForOnboarding(tx, …)`
  - `findByGrantKeys(tx, playerId, keys)`, which includes removed rows
  - `adminReleaseGrantKeys(tx, …)`: staging reset only. It nulls `grant_key` on already **removed** instances and is audited.
- **`combatStatsService`:** **unchanged** (D9).
- **`progressionService`:** an optional `extraLevelRewardLabels(level)` dependency, appended in `describeLevelRewards`. `index.ts` wires a closure that returns the content `levelUpLabel` at level 35 while onboarding is enabled.
- **`config.ts`:** `EQUIPMENT_ONBOARDING_ENABLED` (default `false`).
- **Staging test controls:** "Reset Equipment onboarding" (`test_reset_equipment_onboarding`, Portal button plus `POST …/reset-equipment-onboarding`). It revokes the unlock (only when one exists, so a no-op reset writes just its own audit row), calls `adminRemove` on the live onboarding starters found by their grant keys, and releases those keys, so the flow replays from `pending`. Other equipment is untouched.

---

## 9. Discord

- `equipmentEntryState` maps to `hidden | begin | resume | available` and is the only thing the menu consults.
- **Menu:**
  - a menu field (content `menu.*`) while `begin`/`resume`, following the gift-reminder pattern;
  - a bottom-row button: Primary **🔧 Equipment ✨** for both `begin` and `resume` (→ `onb|open|equipment`), or Secondary **⚔️ Equipment** once `available` (→ `onb|view|equipment`). Labels are code constants. The row holds at most 4 of 5.
  - an Actions-legend mention while visible.
- **Custom ids:** `onb|open|equipment`, `onb|adv|equipment|<fromStep>`, `onb|done|equipment`, `onb|view|equipment`. They are registered in `client.ts`, and every handler recomputes state.
- **Overview (read-only)**, shared with the `complete` step:
  - Buddy name and Current SP;
  - each slot's item and `×multiplier`, or "Empty";
  - ATK/DEF/HP, with `—` for null;
  - a [Back to menu] button;
  - a note that management is coming (Phase 2B).

---

## 10. Deployment

- Branch from `origin/Equipment` (0045). `Assteroid` and `V2Encounter` are at 0044, so there is no migration-number conflict.
- There is no WE package and no Portal step. Definitions arrive through the startup seed, and narrative and NPC content ship with the code.
- **Rollout:**
  1. Deploy with `EQUIPMENT_ONBOARDING_ENABLED=false`.
  2. Confirm the startup log reports the three starter definitions present (`onboarding ready`).
  3. Set the flag to `true`.

  All players at level 35 or above then see the CTA (D6).
- **Name or copy fixes after launch.** Definitions need an equipment import package. Narrative needs a normal deploy.

---

## 11. Tests

See the task file §9 for the full list. It covers:

- the pure state derivation;
- content schemas;
- menu shape;
- the level-35 label;
- the full lifecycle, concurrency, resumption, every §5 edge case and staging reset against real Postgres;
- boundary tests for the two new privileged equipment methods;
- `calculateCombatStats` with overrides before unlock (the D9 guarantee).
