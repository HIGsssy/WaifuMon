# Combat Trials (V1)

Combat Trials are the first game feature built on the combat engine
(`docs/combat-system.md`). A player picks a Trial, sees their active Buddy
beside the enemy, presses **Fight**, and gets a short result.

V1 combat is **automatic**. The auto simulator and a future interactive fight
both drive the same one-action resolver (`resolveCombatAction`), so V1 auto
combat is just one client of it. Replacing **Fight** with **Basic Attack /
Special / Defend** later changes the controller and the persistence. It does
not change the engine.

## Where things live

| Concern | Location |
| --- | --- |
| Trial content | `content/combat/trials.json` |
| Enemy content | `content/combat/enemies.json` |
| Trial schema and catalogue | `src/modules/combat/trialDefinitions.ts` |
| Service (gate, read models, fight, persistence, rewards) | `src/modules/combatTrials/combatTrialService.ts` |
| Discord presenter | `src/discord/combatTrialPresenter.ts` |
| Discord handlers (`ct:*`) | `src/discord/commands/waifumonCombatTrials.ts` |
| Persistence | `combat_trial_attempts` (migration `0048_combat_trial_attempts.sql`) |

The service lives outside `modules/combat/` on purpose. The combat module
stays free of the database, Discord and Equipment (`combatBoundary.test.ts`
enforces this). The Trial service is the game-side layer that wires the engine
to those things.

## Unlock rule

Combat Trials need the permanent **`equipment` feature unlock**. Without
Equipment a player has no ATK / DEF / HP to fight with. Level is never checked
directly.

- The main menu shows **⚔️ Combat Trials** only when the Equipment entry state
  is `available`, which means unlocked.
- `combatTrialService` checks the unlock on **every** list, detail and fight
  call. A stale or forged `ct:*` button from a locked player gets the locked
  screen and nothing is fought or recorded.
- Equipment onboarding is unchanged. Completing it still unlocks Equipment,
  and no Trial needs to be fought. The completion screen now also shows a
  "Your gear is ready. Try it out in Combat Trials." field and a **Combat
  Trials** button. This is presentation only.

## Trial content

```json
{
  "format": "waifumon-combat-trials",
  "version": 1,
  "trials": [
    {
      "key": "trial_scrapyard_drone",
      "name": "Trial 1 — Scrapyard Drone",
      "description": "…",
      "enemyKey": "scrapyard_drone",
      "enabled": true,
      "order": 10,
      "recommended": { "attack": 70, "defense": 55, "hp": 300 },
      "artworkPath": null,
      "backgroundArtworkPath": null,
      "firstClearRewards": { "waifubux": 100, "items": [{ "slug": "sticky_joystick", "quantity": 2 }] },
      "tags": ["starter", "initial_tuning"]
    }
  ]
}
```

Validation happens in two places.

The schema (`CombatTrialFileSchema`) checks:

- `.strict()`, so unknown keys are refused. A Trial **cannot** carry enemy
  stats; it only references an enemy by `enemyKey`.
- Keys are unique and `lower_snake_case`, at most 48 characters, because the
  key travels in a Discord custom id.
- `recommended` values are non-negative integers. Each one is optional.
- Artwork paths pass the shared `relativeArtworkPath` check.

The content loader (`validateCombatTrialContent`) checks:

- every `enemyKey` exists in `enemies.json`;
- every reward item slug exists in `items.json`;
- enabled Trials have distinct `order` values.

A file that fails any check stops the load, with the file and field in the
error. Both files are optional: with no Trial file, the list is empty.

**Availability at runtime.** A Trial can be fought when it is enabled and its
enemy exists and is enabled. Other Trials are left out of the list. Opening or
fighting one by id is refused with `CombatTrialUnavailableError`, whose reason
is `missing`, `disabled`, `enemy_missing` or `enemy_disabled`.

**Recommendations are authored, never derived.** The UI shows exactly what
`recommended` says, labelled as guidance. Nothing blocks entry when a player
is below it. There is no Gear Score.

V1 has no Trial admin editor. Trials are file-backed content, changed by
editing `trials.json` and redeploying or reloading content.

## Flow

1. **Main menu → ⚔️ Combat Trials** (`ct|home|0`). This is the list of
   fightable Trials in `order`, five per page. Each entry shows the Trial
   name, enemy, description, authored recommendation, and Cleared / Not
   Cleared with the last result.
2. **Trial → detail** (`ct|view|<trialKey>`). The pre-fight screen shows:
   - Buddy side: active Buddy name, Current SP, ATK · DEF · HP, and the
     equipped Attack, Defense and Health gear.
   - Enemy side: name and ATK · DEF · HP.
   - Trial: description, recommendation and status.

   Opening a Trial **never** starts a fight.
3. **Fight** (`ct|fight|<trialKey>|<nonce>`). The service:
   1. checks the unlock;
   2. locks the player row;
   3. replays any attempt that already used this request key;
   4. checks the Trial and enemy are still available;
   5. snapshots stats with `combatStatsService.snapshotCombatStats` inside the
      transaction;
   6. builds both combatants (`playerCombatantInput`, `enemyCombatantInput`)
      and calls `createCombatState`;
   7. runs `simulateCombat` with `basicAttackController` on both sides;
   8. writes the attempt and pays any first-clear reward.

   All of this is one transaction.
4. **Result.** The screen shows Victory, Defeat or Draw, both sides' HP as
   `remaining / max`, the round count, and a compact summary. It also shows a
   First Clear block with the rewards when there are any. The buttons are
   **Fight Again** (with a fresh nonce), **All Trials** and **Back to
   Waifumon**.

### Active Buddy requirement

Combat uses the active Buddy and nothing else. Another copy is never picked
silently.

With Equipment unlocked but no Buddy, Combat Trials still opens. The detail
screen says a Buddy is required, offers **Open Collection**, and shows
**Fight** disabled. A forged or stale Fight is refused with
`CombatBuddyRequiredError` and nothing is recorded.

An empty gear slot is handled the same way: the blocker is
`incomplete_loadout` and the error is `CombatLoadoutIncompleteError`.

### Stat source

The player's numbers come only from `combatStatsService`:
`calculateCombatStats` for the detail screen and `snapshotCombatStats` for
the fight. The Trial service never applies an Equipment multiplier, and the
presenter never builds stats. The engine only ever receives numbers.

## Result presentation

`summarizeCombatEvents` (in the presenter) turns the structured event list
into at most about six lines:

- the first three hits;
- `… N more hits …`;
- the final blow;
- either "X is defeated" or "Round limit reached".

Every name and number in it comes from the events. The event model itself
stays prose-free, and the whole event list is stored for debugging and future
replay. A 30-round draw still renders well under Discord's embed limits.

## Artwork

| Picture | Source | Placement |
| --- | --- | --- |
| Scene | Trial `artworkPath`, else enemy `artworkPath`, else Trial `backgroundArtworkPath` | Large embed image |
| Buddy | The active Buddy's existing owned artwork (`ownedArtworkImage`) | Thumbnail |

Conventional asset paths:

- `assets/combat/enemies/<enemy_key>.webp`, referenced in content as
  `combat/enemies/<enemy_key>.webp`;
- `assets/combat/backgrounds/<trial_or_scene_key>.webp`, referenced as
  `combat/backgrounds/<key>.webp`.

All lookups go through `locateCombatArtwork`, which handles shape and
containment checks and never throws. Missing or unsafe art is skipped, so the
screen renders text-only. A warning is logged once at content load.

Buddy art appears only when the Buddy is still the copy the stats or attempt
belong to. Buddy images are never copied under `assets/combat/`.

Discord shows one large image per embed. A composite battle scene is left to
a future dungeon or HTML5 client, which can use both pictures independently.

## Persistence — `combat_trial_attempts`

There is one row per resolved fight. It is written once, already finished.

| Column | Meaning |
| --- | --- |
| `id`, `player_id` | |
| `trial_key`, `enemy_key` | What was fought |
| `request_key` | Idempotency key, unique per player |
| `result`, `end_reason` | `player_victory` / `enemy_victory` / `draw`, and `defeat` / `round_limit` |
| `rounds`, `actions` | Engine counts |
| `buddy_waifu_id`, `player_name`, `player_attack/defense/max_hp/remaining_hp` | Player side, snapshotted |
| `enemy_name`, `enemy_attack/defense/max_hp/remaining_hp` | Enemy side, snapshotted |
| `initial_state` | The engine's serialisable `CombatState` at the start |
| `events` | The engine's structured event list |
| `first_clear` | True on exactly the attempt that first cleared the Trial |
| `rewards` | JSON snapshot of what that attempt paid; null otherwise |
| `started_at`, `completed_at` | |

The table has these indexes and checks:

- `UNIQUE (player_id, request_key)`;
- partial `UNIQUE (player_id, trial_key) WHERE first_clear`;
- an index on `(player_id, trial_key, id DESC)`;
- CHECKs on the result and reason vocabularies, on HP within max, and that
  `first_clear` rows are victories.

**Snapshot semantics.** Every stat and name in a row is a copy. Retuning an
enemy, renaming a Trial or swapping Buddy afterwards never changes a stored
attempt. The result screen for a replayed request is built from the row,
except for the Trial's display name, which is read live.

There is no history browser yet. The table already supports one: it records
every attempt, in order, with full events.

## First clear

A clear is a `player_victory`. Draws and losses never count.

The first victory per (player, Trial) is stored with `first_clear = true`.
"Cleared" and "first cleared at" are read from that row, and the Trial list
shows them. Later victories are ordinary attempts.

## Rewards

| Clear | Reward |
| --- | --- |
| First clear | The Trial's `firstClearRewards`: WaifuBux and fixed salvage items, through the existing `currency.grantWaifubux` and `inventory.addItem` |
| Repeat clear | Nothing |

Because repeat clears pay nothing, Trials can be repeated freely: no Energy
cost, cooldown or daily cap. That keeps testing and balancing easy without
creating a farm. There is no Equipment reward in V1.

Shipped first-clear rewards:

| Trial | WaifuBux | Items |
| --- | --- | --- |
| 1 | 100 | 2× Sticky Joystick |
| 2 | 200 | 2× Crusted Magazine, 1× Cracked Butt Plug |
| 3 | 350 | 1× Still-Buzzing Wand, 1× Glory Hole Ticket |

**Idempotency.** The reward is paid in the same transaction that writes the
`first_clear` row, and that transaction holds a `FOR UPDATE` lock on the
player row. The partial unique index backs this up: two first clears cannot
both commit. Presenter state never decides a payout. A replayed request
returns the stored attempt, with its stored `rewards`, and pays nothing.

## Idempotency and concurrency

Every rendered Fight button (on the detail screen and as Fight Again) carries
a fresh random nonce. The handler passes `discord:<nonce>` to the service as
the request key.

- A **double-click** or a **Discord retry** of the same button uses the same
  key. The first request fights and records. The others read that attempt back
  (`replayed: true`) and repaint it with "That fight was already resolved."
- **Fight Again** has a new nonce, so it is a genuine new fight.
- A failed fight (locked, no Buddy, Trial gone) writes nothing. The same key
  works once the problem is fixed, and a stale row never blocks future fights.
- Reusing a key for a *different* Trial is refused with
  `CombatTrialRequestConflictError`. The original attempt is left untouched.

## Errors

| Situation | Error / behaviour |
| --- | --- |
| Equipment not unlocked | `FeatureLockedError` → locked screen |
| No active Buddy | `CombatBuddyRequiredError`; detail shows the blocker and Fight disabled |
| Empty gear slot | `CombatLoadoutIncompleteError`; detail shows the blocker |
| Trial missing or disabled, enemy missing or disabled | `CombatTrialUnavailableError` → list with a note |
| Invalid combat stats | `CombatStateInvalidError` from the engine; the transaction rolls back |
| Duplicate or replayed Fight | Replays the stored attempt |

No failure records an attempt or pays anything.

## Initial balance

Damage is `round(ATK × 100 / (100 + DEF))`, with a minimum of 1. The player
attacks first.

The tuning used Level 35 Buddies at representative base SP (N 90 to EX 185).
That gives Current SP of 167, 185, 204, 231, 259, 287, 315 and 342.

Three builds were tested:

- **starter**: Rusty Pipe ×0.45 · Scrap Plate ×0.35 · Dented Lunchbox ×2.00,
  the onboarding grants;
- **improved N**: ×0.65 / ×0.55 / ×2.20;
- **R**: ×0.85 / ×0.75 / ×2.60.

The original enemy stats (25/10/120, 45/25/220 and 60/60/320) lost to starter
gear at every SP, including Trial 3. They were raised to these **initial
tuning** values:

| Enemy | ATK | DEF | HP |
| --- | --- | --- | --- |
| Scrapyard Drone | 55 | 30 | 300 |
| Alley Bruiser | 100 | 55 | 520 |
| Security Automaton | 140 | 90 | 800 |

The result tables below are by Current SP. `W48%` means a win with 48% HP
left.

**Trial 1**

| Build | 167 | 185 | 204 | 231 | 259 | 287 | 315 | 342 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| starter | W48% | W64% | W69% | W81% | W83% | W85% | W92% | W93% |

**Trial 2**

| Build | 167 | 185 | 204 | 231 | 259 | 287 | 315 | 342 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| starter | L | L | L | W17% | W40% | W48% | W62% | W67% |
| improved N | W1% | W26% | W37% | W57% | W71% | W75% | W84% | W86% |

**Trial 3**

| Build | 167 | 185 | 204 | 231 | 259 | 287 | 315 | 342 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| starter | L | L | L | L | L | L | L | W16% |
| improved N | L | L | L | L | W8% | W32% | W48% | W61% |
| R | L | L | W17% | W41% | W57% | W65% | W74% | W78% |

What this means:

- **Trial 1**: starter gear always wins, with at least about half HP left.
- **Trial 2**: starter gear needs a strong Buddy (Current SP 231 or more).
  Improved N gear wins at every SP tested.
- **Trial 3**: starter gear wins only at the very top of the range. Improved N
  gear needs a strong Buddy, and R gear opens it up from Current SP 204.

The authored recommendations follow from these results. Trial 1's matches
starter gear around SP 167. Trial 2's matches starter gear around SP 231.
Trial 3's matches improved N gear around SP 259, or R gear around SP 204.

`tests/unit/combat/combatTrialBalance.test.ts` guards the *shape* of these
results without pinning exact round counts. All of these values are tagged
`initial_tuning` and are expected to change.

## Future interactive combat

V1 deliberately stops at the **Fight** button. To make fights interactive:

1. Add an active-fight row, for example `combat_trial_fights (id, player_id,
   trial_key, request_key, state jsonb, status, started_at, updated_at)`. The
   `state` column holds the engine's JSON-safe `CombatState`, which
   `createCombatState` already produces and `assertValidCombatState` already
   re-validates on load.
2. Replace **Fight** with **Basic Attack / Special / Defend**. Each press
   submits one `CombatAction` to `resolveCombatAction` and saves the new state.
   The enemy's turn is resolved by its controller.
3. When the state becomes terminal, write the same `combat_trial_attempts` row
   that V1 writes, with its first-clear and reward logic unchanged.

None of this is built yet. There is no active-fight table, and `special` and
`defend` are still refused by the engine.

## Non-goals in V1

Interactive actions, specials, defend, abilities, cooldowns, statuses and
healing are not in V1. Neither are PvP, raids, parties, dungeon traversal,
Portal combat UI and a Trial admin editor. There is also no Gear Score, Energy
cost or daily limit.

The service returns plain read models with no embeds, so the Portal can use
it later.
