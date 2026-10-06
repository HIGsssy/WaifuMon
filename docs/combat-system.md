# Combat system — engine foundation (V1)

The reusable combat engine under `src/modules/combat/`. V1 is intentionally
small: one Buddy against one enemy, ATK / DEF / HP, basic attacks only,
alternating turns. There is no player-facing flow yet (no Combat Trial
commands, buttons, Portal UI, persistence or rewards). This doc covers the
engine those features will be built on.

## Modules

| File | Role |
| --- | --- |
| `combatTypes.ts` | State, actions, events, result, reserved ability shape. Pure JSON types. |
| `combatMath.ts` | Damage formula and the one rounding rule. |
| `combatState.ts` | `createCombatState`, invariant checks, `DEFAULT_MAX_ROUNDS`. |
| `combatEngine.ts` | **`resolveCombatAction`**, which is authoritative. Also `startCombat` and `endCombatAsDraw`. |
| `combatController.ts` | `CombatController` and the V1 `basicAttackController`. |
| `combatSimulator.ts` | `simulateCombat`, the auto-combat loop over the resolver. |
| `playerCombatant.ts` | Builds the player side from stats the caller already calculated. |
| `enemyDefinitions.ts` | Enemy content schema, catalogue, and enemy combatant builder. |
| `combatArtwork.ts` | Artwork path conventions and a never-throwing artwork lookup. |

The first six files are the **generic engine**. They import nothing outside
themselves except `shared/random` (the `Rng` type) and `shared/errors`. No file
in `modules/combat/` imports Discord, the database or Equipment.
`tests/unit/combat/combatBoundary.test.ts` enforces both rules.

## One-action resolver

```ts
resolveCombatAction(state, action, context) → { state, events }
```

This is the only place combat rules run. On each call it:

1. validates the state (stats are non-negative integers, `0 ≤ HP ≤ maxHp`,
   the turn and status are known values, and an active fight has nobody at 0 HP);
2. refuses the action if the fight is over (`combat_finished`), if the actor is
   unknown (`unknown_actor`), if it is not that actor's turn (`not_actor_turn`),
   or if the action type is not executable in V1 (`unsupported_action`);
3. applies the action, emits events, and then either ends the fight or passes
   the turn to the other side.

It never mutates its input; it returns a new state each time. A refusal throws
`CombatActionRejectedError` with a stable `reason` and leaves the state
untouched. A malformed state throws `CombatStateInvalidError`.

Nothing in the engine knows who chose an action. An auto-controller, a Discord
button and a dungeon client all submit the same `CombatAction`.

## Actions

```ts
type CombatAction =
  | { type: 'basic_attack'; actor: 'player' | 'enemy' }
  | { type: 'special'; actor; abilityKey: string }   // refused in V1
  | { type: 'defend'; actor }                        // refused in V1
```

## Damage

```
rawDamage = ATK × (DEFENSE_SCALING / (DEFENSE_SCALING + DEF))    DEFENSE_SCALING = 100
damage    = max(MIN_DAMAGE, round(rawDamage))                     MIN_DAMAGE = 1
HP        = max(0, HP − damage)
```

DEF has diminishing returns: 100 DEF halves damage and 300 DEF quarters it,
but damage never reaches zero. `round` is `Math.round`, so halves round up.
This rounding happens only in `combatMath.ts`. HP and damage are always
integers.

### Damage variance

That deterministic number is the **base** damage. Every hit then rolls a
factor, so a matchup is no longer always won or always lost at a stat
threshold:

```
base   = max(MIN_DAMAGE, round(rawDamage))                    exactly as above
roll   = rng.intInclusive(minBasisPoints, maxBasisPoints)     9000..11000 by default
damage = max(MIN_DAMAGE, floor((base × roll + 5000) / 10000))
```

The order is fixed: **round the base, roll, multiply the rounded base, round
the product half-up (in integer arithmetic), clamp to the minimum.** Base 7 at
×0.90 is 6.3 → 6; at ×1.10 it is 7.7 → 8; base 5 at ×0.90 is 4.5 → 5; base 1 is
never less than 1.

- The range lives in the fight's rules — `rules.damageVariance:
  { minBasisPoints, maxBasisPoints }` — and is stored on the state, so a
  resumed fight keeps it. `createCombatState` fills in
  `DEFAULT_DAMAGE_VARIANCE` (90%–110%); `NO_DAMAGE_VARIANCE` (100%–100%) gives
  the old fixed numbers for tools and tests. A state whose range is missing or
  malformed is refused (`CombatStateInvalidError`), never defaulted.
- `rollBasicAttackDamage` in `combatMath.ts` is the one place a damage roll is
  made. Exactly one draw per hit; a refused action draws nothing.
- The `damage` event reports `baseAmount`, `varianceBasisPoints` and `amount`.
- There are no crits, misses, dodges, accuracy or status rolls. Variance is the
  only randomness in the engine.

## Round semantics

- Round 1 opens with the **player's** turn.
- The enemy's following turn is in the **same** round.
- The round number goes up when control returns to the player.
- If round `rules.maxRounds` (default **30**) finishes with both sides still
  standing, the fight ends as a **draw** (`reason: 'round_limit'`) in that
  round. A fight therefore lasts at most `maxRounds` rounds, or `2 × maxRounds`
  actions.
- A killing blow ends the fight immediately (`reason: 'defeat'`), even in the
  final round.

`rules` is stored on the state, so a resumed fight keeps the cap it started
with.

## State

```ts
CombatState { round, turn, status, rules: { maxRounds }, player, enemy }
CombatantState { id, name, currentHp, maxHp, attack, defense, statuses: [], cooldowns: {} }
```

`status` is `'active' | 'player_victory' | 'enemy_victory' | 'draw'`.
`statuses` and `cooldowns` are reserved fields and are always empty in V1.
The state is plain JSON: it survives `JSON.stringify` and `JSON.parse`
unchanged, and a restored state resumes the same way the original would. Tests
cover both properties.

## Events

The engine emits structured events and **no prose**. Every event includes its
round.

| Event | Fields |
| --- | --- |
| `combat_started` | `player`, `enemy` snapshots (`id, name, currentHp, maxHp`) |
| `turn_started` | `actor` |
| `action_started` | `actor`, `action` |
| `damage` | `actor`, `target`, `amount`, `baseAmount`, `varianceBasisPoints`, `targetHpBefore`, `targetHpAfter` |
| `combatant_defeated` | `actor` (the one who fell) |
| `combat_ended` | `result`, `reason` (`defeat` \| `round_limit`) |

Event order for one action is `action_started → damage →` either
`turn_started` or `combatant_defeated → combat_ended`. When the round cap ends
the fight, the order is `action_started → damage → combat_ended`.
`startCombat(state)` produces the opening `combat_started → turn_started`.

## Controllers

```ts
interface CombatController {
  chooseAction(state, actor, context): CombatAction;
}
```

In V1 both sides use `basicAttackController`. To make a fight interactive
later, replace the player's controller. The math and the engine stay the same.
Controllers are synchronous because an interactive fight does **not** run
inside the simulator. It stores the state, waits for input, and calls
`resolveCombatAction` directly with that input.

## Auto simulator

`simulateCombat(initialState, { player, enemy }, context, { maxActions? })`

1. runs `startCombat`;
2. asks the controller for `state.turn` to choose an action;
3. resolves the action and collects its events;
4. repeats until the status is terminal.

It returns
`CombatResult { result, reason, finalState, events, rounds, actions }`, which
is presenter-neutral and JSON-safe. `maxActions` (default `2 × maxRounds`) is a
backstop against bugs only and forces a draw through `endCombatAsDraw`. In
normal play the resolver's round cap ends the fight first.

## RNG

Combat code never calls `Math.random()` (the boundary test checks this). All
randomness comes from `context.rng`, which uses the shared `Rng` interface in
`src/shared/random.ts`. Tests pass `seededRng(seed)`, and production callers
pass their own. A basic attack draws exactly once, for its damage factor;
every entry point already takes the context, so crits, procs, AI choices and
status chances can be added without changing signatures.

**Reproducibility.** The same starting state, the same action sequence and the
same seed produce the same fight, event for event. Who supplies the seed:

| Caller | RNG | Consequence |
| --- | --- | --- |
| Dungeon fight | `seededRng(dungeonCombatSeed(run seed, node id))` | A node's fight is fixed by the run; it cannot be rerolled (`docs/dungeons.md`). |
| Combat Trial | `defaultRng()` | Each attempt is a fresh fight; the stored attempt is the record. |
| Tests, balance tools | `seededRng(seed)` | Deterministic. |

For an interactive fight parked between button presses, store the seed
together with the number of RNG draws so far. This is not built yet.

**Combat Trials under variance.** Trials use the same engine and the same
rules — there is no deterministic mode for them. The ladder keeps its shape:
across the 72 matchups the balance test covers (3 Trials × 3 builds × 8 SP
values), 71 are still decided the same way every time and one edge case
(Trial 2, improved N gear, Current SP 167) goes from an always-win to about
63%. A Trial can be retried freely, so the edge only costs a retry.

## Building combatants

The engine works with numbers only. Callers supply stats they have already
calculated:

- **Player:**
  `playerCombatantInput({ buddy, stats })` takes the `buddy` and `stats` from
  `combatStatsService.calculateCombatStats(...)` (or `snapshotCombatStats` for
  a fight frozen at entry). The parameter types match structurally, so Combat
  imports nothing from Equipment. It throws if there is no Buddy or the
  loadout is incomplete (any `null` stat). Combat entry must refuse those
  cases before a fight is created. Id: `buddy:<waifuId>`.
- **Enemy:** `enemyCombatantInput(definition)`. Id: `enemy:<key>`.

Then call `createCombatState({ player, enemy, rules? })`.

## Enemy content

Enemies live in the Enemy Catalogue (`combat_enemies`), authored in Portal
Admin — see [enemies.md](enemies.md). `content/combat/enemies.json` is the
shipped default: the content loader validates it into
`LoadedContent.combatEnemies`, and startup seeds it into the catalogue. The
combat systems read enemies from the catalogue, not from `LoadedContent`. The
file is optional; if it is absent no enemies are shipped.

```json
{
  "format": "waifumon-combat-enemies",
  "version": 1,
  "enemies": [
    {
      "key": "scrapyard_drone",
      "name": "Scrapyard Drone",
      "attack": 55,
      "defense": 30,
      "hp": 300,
      "artworkPath": null,
      "enabled": true,
      "tags": ["starter", "initial_tuning"]
    }
  ]
}
```

Validation rules:

- `.strict()`, so unknown fields are refused;
- `key` is unique and `lower_snake_case`;
- `name` is not blank;
- stats are integers with `attack ≥ 1`, `defense ≥ 0`, `hp ≥ 1`, each at most 1,000,000;
- `enabled` is a boolean;
- `tags` are keys;
- `artworkPath` must pass the shared `relativeArtworkPath` check, or be
  null/absent.

**Zero ATK is refused in V1.** Basic attack is the only action, and the
minimum-damage rule would make such an enemy hit for 1 anyway. Revisit this
when utility enemies that use only abilities exist.

The starter enemies (`scrapyard_drone`, `alley_bruiser`,
`security_automaton`) are the opponents of the three starter Combat Trials.
Their stats are **initial tuning values, not final balance**, and they are
tagged `initial_tuning`. See `docs/combat-trials.md` for the simulations behind
them.

## Artwork conventions

Artwork paths are **relative to the assets root** (`ASSETS_DIR`), the same
convention boss and encounter artwork use. Never write `/assets/...` or a URL.

| Asset location | Content path | Status |
| --- | --- | --- |
| `assets/combat/enemies/<enemy_key>.webp` | `combat/enemies/<enemy_key>.webp` | Used by `enemies.json` `artworkPath` |
| `assets/combat/backgrounds/<scene_key>.webp` | `combat/backgrounds/<scene_key>.webp` | Reserved for battle scenes |
| `assets/combat/abilities/<ability_key>.webp` | `combat/abilities/<ability_key>.webp` | Reserved for ability art |

`conventionalCombatArtworkPath(kind, key)` builds these paths. The shared
artwork rules check shape (relative path, no `..`, no backslash, no URL or
drive letter, a `.png/.webp/.jpg/.jpeg/.gif` extension) and containment
(`locateArtworkFile`, which resolves symlinks).

**Missing art never breaks combat.** `locateCombatArtwork` returns
`none` / `missing` / `unsafe` / `available` and never throws. Presenters render
text-only for anything other than `available`. At load time, an enemy whose
authored art is missing logs one warning. Enemies with `artworkPath: null` log
nothing.

**The player side reuses the Buddy's existing owned artwork.** Buddy images
are never copied into `assets/combat/`.

## Reserved for later (not implemented)

- `CombatAbilityDefinition { key, name, type: 'attack' | 'defense' | 'utility', artworkPath? }`
  is a type only. Nothing loads or executes abilities, and there are no DB tables
  for them.
- `special` and `defend` actions, statuses, cooldowns, crits, dodge, speed,
  elements and affinities, healing, items, party and raid combat, PvP.
- Persisted interactive fights and dungeon traversal.

Combat Trials (the first game feature on this engine: UI, persistence,
first-clear rewards, the starter ladder) are documented in
`docs/combat-trials.md`.
