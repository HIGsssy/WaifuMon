# Dungeons

A dungeon run is a short generated graph of gameplay nodes. Admins author
**zones**; the generator turns an enabled zone and a seed into a legal run; the
run is stored as a snapshot; the player walks it node by node in Discord
(**⛏️ Delve** on the main menu).

```text
Admin-authored zone (rules + pools + rewards)
        ↓
seeded deterministic generator
        ↓
generated run graph
        ↓
snapshot (dungeon_runs)  +  fighter snapshot (Buddy, ATK / DEF / max HP)
        ↓
enter node → resolve node → carry HP, rewards and currency forward
        ↓
extract · complete · defeated · abandon  →  bank the progression currency
```

Authoring and generation are the first half of this document;
[Playing a run](#playing-a-run) is the second.

| Piece | Where |
| --- | --- |
| Zone shape and schema | `src/modules/dungeons/zoneDefinition.ts` |
| Generator and graph validator | `src/modules/dungeons/dungeonGenerator.ts` |
| Authoring validation | `src/modules/dungeons/zoneValidation.ts` |
| Simulation | `src/modules/dungeons/dungeonSimulation.ts` |
| Seeding shipped zones | `src/modules/dungeons/dungeonZoneStore.ts` |
| Admin service (CRUD, preview) | `src/modules/dungeons/dungeonZoneService.ts` |
| Run snapshots | `src/modules/dungeons/dungeonRunService.ts` |
| Run rules (pure) | `src/modules/dungeons/dungeonRunState.ts` |
| Playing a run | `src/modules/dungeons/dungeonPlayService.ts` |
| Daily run allowance, Delve settings | `src/modules/dungeons/dungeonAllowanceService.ts` |
| Balance simulation | `src/modules/dungeons/dungeonPlaythrough.ts`, `src/tools/simulateDungeonPlay.ts` |
| Discord | `src/discord/dungeonPresenter.ts`, `src/discord/commands/waifumonDungeon.ts` |
| Events | `src/modules/dungeons/eventDefinitions.ts`, `content/dungeons/events.json` |
| Progression currency | `src/modules/progressionCurrency/progressionCurrencyService.ts` |
| Admin API | `src/api/routes/v1/admin/dungeons.ts` |
| Portal | `portal/src/features/adminDungeons/` |
| Tables | migrations `0050_dungeon_foundation`, `0051_dungeon_playable_runs`, `0052_dungeon_daily_runs` |

## Zones

A zone is one JSON document — the same shape in the shipped file
(`content/dungeons/zones.json`), in `dungeon_zones.definition`, in the editor
and in a run's snapshot.

| Field | |
| --- | --- |
| `key` | Stable, `lower_snake_case`. Chosen at creation and never changed: runs record it. |
| `name`, `description`, `order`, `tags` | Display and listing. |
| `enabled` | A disabled zone cannot start a run. It can still be previewed. |
| `artworkPath`, `backgroundArtworkPath` | Relative to the assets root; conventionally `dungeons/zones/<key>.webp` and `dungeons/backgrounds/<key>.webp`. The file does not have to exist for the zone to be saved or enabled. |
| `generation` | The rules — below. |
| `nodeSettings` | What a node type does when resolved. `rest.healBasisPoints`: the share of max HP a rest restores (3000 = 30%). |
| `pools` | `combat`, `elite`, `miniboss`, `boss` (enemy keys) and `event` (event keys). |
| `rewards` | Currency key, defeat retention, depth bands, completion and extraction bonuses. |

Zones are never deleted; they are disabled.

### Node types

`combat`, `elite`, `event`, `reward`, `rest`, `miniboss`, `boss`, `exit`.

The type is stored as text in zones and graphs, so adding one (a vendor, a
puzzle) is a new entry in `DUNGEON_NODE_TYPES` plus whatever the generator must
know about its role — no table changes.

What each type does when a player resolves it is in
[Resolving a node](#resolving-a-node).

### Weights and constraints

**Weights determine preference; constraints determine legality.** A weight
never overrides a constraint.

| Rule | Kind | Meaning |
| --- | --- | --- |
| `minNodes`, `maxNodes` | constraint | Total nodes, fork alternates included. |
| `branching` | both | `minBranches` forks are always placed; each further one up to `maxBranches` is rolled at `chanceBasisPoints`. A fork runs `1..maxLength` nodes. |
| `nodeWeights` | weight | Preference among the types legal at a slot. Zero means "never by chance". `boss` has no weight. |
| `boss.required` | constraint | `true`: the final node is the run's only boss. `false`: no boss, the final node is an `exit`. |
| `depthRanges` | constraint | The depths a type may appear at ("no elite as the first node" is `elite.minDepth: 2`). |
| `required` | constraint | "At least `min` nodes of these types" — a group, so "at least one reward *or* event" is one rule. |
| `limits` | constraint | "At most `max` nodes of these types." |
| `noConsecutive` | constraint | Types that may not follow themselves along an edge. |
| `maxConsecutiveSameEnemy` | constraint | The same enemy at most N times in a row along any route. A node with no enemy breaks the streak. |
| `extraction` | constraint | Below. |

`required` is counted on the **main path** only — the nodes every route passes
through. A rest on one side of a fork can be walked around, so it guarantees
nothing. `limits` count the whole graph.

### Depth

Depth is 1-based and every node knows its own. Pool entries, reward bands and
node types all carry `minDepth` / `maxDepth` (`null` = open-ended):

```text
Scrapyard Drone      depth 1–4
Alley Bruiser        depth 2–7
Security Automaton   depth 4+
```

Enemy stats are not scaled by depth. Difficulty comes from which authored
enemies are eligible where.

### Extraction

A node offers extraction when its depth is at least `extraction.minDepth` and
its type is in `extraction.nodeTypes`. The final node never does — finishing it
is completion. An `exit` node is itself only legal from `minDepth`.
`extraction.minPoints` guarantees that many extraction nodes on the main path.

`extraction.windows` says *where* guaranteed points go. Each window
(`minDepth`, `maxDepth`, `required`) holds one main-path extraction node
between its depths:

- `required: true` — placed in every run. Validation refuses a required window
  the shortest run cannot hold.
- `required: false` — placed when the run has a free main-path slot in the
  window that can legally be one of the extraction types, skipped otherwise. A
  short run simply has no later way out; it does not fail to generate.

Windows count toward `minPoints`. A zone with no windows generates exactly as
it did before they existed (they draw nothing from the generator's stream), so
`DUNGEON_GENERATOR_VERSION` is unchanged and a run snapshotted earlier still
reproduces.

Which type a guaranteed point becomes follows the node weights and limits like
any other reservation. Scrapheap allows one `rest` per run and gives `exit` no
weight, so its early window is always the rest (heal, then decide) and its
later one is always a bare `exit` (no heal: cash out or face the boss).

### Pools

Each entry: `id` (unique in its pool, recorded on every node drawn from it),
`enemyKey` or `eventKey`, `enabled`, `weight`, `minDepth`, `maxDepth`, `tags`.

Entries **reference** enemies (`content/combat/enemies.json`) by key. No stat is
copied into a zone.

An entry is eligible at a depth when it is enabled, has a weight above zero, is
in its depth range, and names content that exists and is enabled.

### Tags

Zones, pool entries, enemies and events all carry `tags`. They are stored and
round-tripped; **the generator does not read them yet**. Tag-based inclusion,
exclusion or preference is a later addition on the fields that already exist.

### Events

`content/dungeons/events.json` — `key`, `name`, `description`, `enabled`,
`artworkPath`, `tags`, and the V1 resolution:

| Field | |
| --- | --- |
| `hpChangeBasisPoints` | HP change as a share of max HP: positive heals (never above max), negative hurts (never below 1 HP — an event cannot end a run). Default 0. |
| `paysReward` | Whether resolving the event pays the node's reward band. Default false. |

Both default to nothing, which makes an event pure narrative. There are no
choices yet.

World Encounters were considered and not reused. They are spawned into a
channel, expire on a timer, carry per-guild cooldowns and history, and resolve
through an effect executor that pays the player immediately. A dungeon node has
none of that lifecycle, and its rewards stay unbanked until extraction.

Events are file content, like combat enemies. They are not editable in the
Portal yet.

## Rewards

Two kinds of reward, with different risk:

- **Secured** — Equipment, WaifuBux and items. Granted to the player in the
  transaction that resolves the node and kept whatever happens next. Listed in
  `dungeon_runs.secured_rewards`.
- **Unbanked progression currency** — accumulates in
  `dungeon_runs.unbanked_currency` and reaches the permanent balance only when
  the run ends. See [Ending a run](#ending-a-run).

| Field | |
| --- | --- |
| `rewards.currencyKey` | The stable key of the progression currency. Never a display name. |
| `rewards.defeatCurrencyRetentionBasisPoints` | Share of unbanked currency kept on defeat or abandon. `2500` = 25%. Extraction and completion bank all of it. |
| `rewards.bands[]` | Depth bands. |
| `rewards.completion`, `rewards.extraction` | One-off bonuses: a currency range and an optional reward table. |

A **band** has `minDepth`/`maxDepth`, optional `nodeTypes`, a `currency` range,
a `rewardTable` and an `equipmentRewardTable`. A node takes the first enabled
band in range that names its type, else the first that names no type — so
"elite" and "boss" bands sit beside the general depth tiers. Bands are numeric
ranges; "early / mid / deep" are just ids.

Reward tables are the existing **expedition-kind** rows in `reward_tables`
([`reward-tables.md`](reward-tables.md)), edited in Admin — Reward Tables. That
is how dungeons reach Equipment: a table's gear rows are the same selectors
(slot, N/R/SR rarity, definition pool) the Equipment reward system already
rolls. There is no dungeon-specific gear generator, and no SSR/UR random
generation.

A dungeon pays a table's **WaifuBux, items and gear**. `essence`, `waifuXp` and
`playerXp` on a table are expedition rewards and are not paid by a dungeon.

Which nodes pay their band: a **won** fight (combat, elite, miniboss, boss), a
**reward** node, and an **event** authored with `paysReward`. Rest and exit
nodes never pay, whatever band covers their depth.

## The progression currency

The resource dungeons pay toward Ascension. Ascension itself does not exist yet.

- **Metadata** — `progression_currencies`: a stable `currency_key`
  (`ascension_currency`) and editable `singular_name`, `plural_name`,
  `description`, `icon`, `enabled`. Renaming changes nothing that references it.
  The shipped names ("Ascension Token") are working names.
- **Balance** — `player_progression_balances`: one integer per player and
  currency, `CHECK (balance >= 0)`. No row means zero; the first grant creates
  it.
- **Ledger** — `progression_currency_ledger`: one row per change, with the
  delta, the balance after, a reason and an optional source reference.

It is deliberately not an inventory item and not a `player_currencies` column:
no shop, sale, gift, consumable or Workshop code can name it.
`progressionCurrencyService` is the only writer (a test scans `src/` for any
other file that mentions the tables).

`grant` and `spend` take a transaction, lock the balance row, and write the
ledger row in the same transaction. A spend is a conditional update
(`WHERE balance >= amount`). A change that carries a `requestKey` is idempotent:
repeating it replays the recorded result. A disabled currency refuses grants
and still allows spends.

Dungeon settlement is the only caller of `grant` so far. Nothing spends the
currency yet.

Every player-facing screen names the currency from this metadata (singular,
plural, icon), read live — a rename shows on the next paint, including in a run
already under way. No display name is written in code.

## The generator

`generateDungeon(zone, catalogue, seed)` — pure, no database, no Discord, no
Portal. The Admin preview and `dungeonRunService.startRun` call the same
function.

### Determinism

One `seededRng(seed)` (Mulberry32, `src/shared/random.ts`) drives every choice
in a fixed order. `Math.random` is never called. The same zone definition, the
same content catalogue and the same seed always produce the same graph —
layout, node types, branch placement, enemies and events. Seeds are unsigned
32-bit integers.

`DUNGEON_GENERATOR_VERSION` is stored on every run and must be bumped by any
change that alters what a seed produces.

### The graph

A layered DAG. Depths run `1..depthCount`. Most depths hold one node. A **fork**
makes `1..maxLength` consecutive depths hold two (lane 0 and lane 1): the node
before the fork leads to both lanes, each lane runs straight, and both rejoin at
the node after. Every edge goes from depth `d` to `d + 1`, so there are no
cycles. Forks never touch the first or final depth and never abut one another.

```text
n1 ── n2 ──┬── n3 ──┬── n5 ── n6 (boss)
           └── n4 ──┘
depth 1    2     3      4     5
```

Each node:

| Field | |
| --- | --- |
| `id` | `n1`, `n2`, … in depth order. |
| `depth`, `lane` | |
| `type` | A node type. |
| `outgoing` | Ids of the edges leaving it. `edges` is `[{ id, from, to }]`. |
| `content` | `{ kind: 'enemy' \| 'event', key }`, or null. |
| `source` | `{ pool, entryId }` — the pool entry the content came from. |
| `rewardBandId` | The band it pays from, or null. |
| `extraction` | Whether the player may extract here. |
| `terminal`, `boss` | |

The graph is plain JSON: no functions, no runtime objects.

### Algorithm

Each attempt:

1. **Length.** Roll the total node count in `minNodes..maxNodes`, the number of
   forks, and each fork's length. `depthCount` is the total minus the nodes
   spent on fork alternates. Optional forks that do not fit are dropped; a
   required one that does not fit fails the attempt.
2. **Layout.** Place the forks, build the slots and the edges.
3. **Reserve.** The final slot becomes the boss (or an `exit`). Then the
   guaranteed extraction points, then each `required` group, are placed on
   free main-path slots — a random legal slot, then a weighted pick among the
   group's legal types.
4. **Fill.** Each remaining slot, in depth order, takes a weighted pick among
   the types that are legal there: in its depth range, with something to hold
   (an eligible pool entry, or a reward band), within every limit, and not
   breaking `noConsecutive` against a neighbour already placed.
5. **Content.** Each enemy and event node takes a weighted pick from the
   eligible entries of its pool, minus any enemy that would break
   `maxConsecutiveSameEnemy`. Each node takes its reward band.
6. **Validate.** `validateDungeonGraph` checks the finished graph from scratch,
   sharing no state with steps 1–5.

### Failure

A step that cannot proceed fails the attempt with a named reason, and the next
attempt continues from the same RNG stream. After 64 attempts the generator
throws `DungeonGenerationError` (`DUNGEON_GENERATION_FAILED`, HTTP 422) with
the seed, the attempt count, a tally of the reasons and the last one. It never
returns a partial graph, and it cannot loop forever.

## Runs and snapshots

`dungeon_runs`: `id`, `player_id`, `zone_key`, `zone_revision`, `seed`,
`generator_version`, `status`, `graph`, `zone_snapshot`, `fighter`,
`current_node_id`, `current_hp`, `unbanked_currency`, `secured_rewards`,
`node_states`, `settlement`, `started_at`, `updated_at`, `completed_at`.

Statuses: `active`, `extracted`, `defeated`, `completed`, `abandoned`.

`startRun` loads the zone as it stands, refuses a missing or disabled one,
validates it, generates, and stores the graph together with a snapshot of:

- the zone definition, its revision and content hash;
- the full definition of every enemy and event the graph placed;
- the currency's display metadata;
- every reward table the run can pay from, with the Equipment definitions each
  gear selector could pay at that moment;
- the content catalogue the generator saw, so the graph can be reproduced.

From then on **the stored graph is authoritative** and the snapshot is the only
content the run reads:

| After a run is generated… | Effect on that run |
| --- | --- |
| the zone is edited or disabled | none |
| an enemy or event it placed is disabled or changed | none |
| a reward table it was promised is edited or disabled | none |
| a new run starts | uses the current zone, content and tables |

The seed is for debugging: `reproduceGraph(run)` regenerates the same graph
from the stored seed and snapshot.

**One active run per player** is a partial unique index
(`dungeon_runs_one_active_uq … WHERE status = 'active'`), not a UI rule.

## Playing a run

Discord first: **⛏️ Delve** on the main menu. There is no player dungeon UI in
the Portal yet; `dungeonPlayService` returns presenter-neutral read models
(`DungeonHomeView`, `DungeonRunView`) so one can be added without touching the
rules.

```text
Delve → zone → Start Run → [ node → resolve → path ahead ]* → extract / boss / defeat / abandon
```

### Eligibility

- the permanent `equipment` feature unlock;
- an active Buddy;
- a complete loadout — Attack, Defense and Health all equipped.

The same gate as Combat Trials. There is no level gate of its own. Entering
costs one of the day's Delve runs and nothing else — never Energy.

### Daily runs

Delve is not infinitely repeatable. A player may **start** a limited number of
runs per game day:

```text
⛏️ Delve
Daily Runs: 2 / 3 remaining
```

| | |
| --- | --- |
| Limit | `dungeon_settings.daily_run_limit` — one Delve-wide setting, edited in Portal Admin. Ships as **3**. |
| Scope | Shared by every zone. A run anywhere draws on the same allowance; a zone has none of its own. |
| Energy | Unrelated. Starting a run never reads or spends Energy. |
| Bounds | A whole number, 0–50. Anything else is refused (`400 DUNGEON_SETTINGS_INVALID`); nothing is rounded or clamped. |
| `0` | Legal, and means **Delve is closed to new runs**. Runs already active are unaffected. |

**Stored usage, not a refilled counter.** `dungeon_daily_usage` has one row per
player per game day on which they started a run: `(player_id, period_key,
runs_started)`. What is left is always computed —

```text
remaining = max(0, daily_run_limit − runs_started for today's period_key)
```

— so a new day has no row and therefore a full allowance. There is no midnight
job and nothing to refill. Changing the limit takes effect at once for
everyone, in both directions; lowering it below what a player has already
started leaves them with 0, never a negative, and takes nothing back.

**The game day** is the daily claim's: `period_key` is the calendar date
(`YYYY-MM-DD`) in `DAILY_TIMEZONE`, from the same `claimDateInTimezone` /
`nextResetAt` the daily claim uses. It rolls over at midnight in that zone
(UTC by default). Delve has no reset rule of its own.

**What consumes an attempt** — only the successful creation of a run:

| Action | Attempts |
| --- | --- |
| Start a new run | −1, in the transaction that creates the run |
| Resume, move, resolve a node | 0 |
| Extract, complete, be defeated, abandon | 0 — nothing is ever refunded |
| A start that is refused (locked, no Buddy, incomplete loadout, a run already active, zone unavailable) | 0 |
| A start that fails (the zone cannot generate, the database fails) | 0 — the transaction rolls back, attempt included |
| Start double-clicked or retried | −1 in total: one run, one attempt |

**Crossing the reset.** A run that is active when the day rolls over stays
active and plays on normally. It was paid for on the day it started and is
never charged to the new day. The new day's allowance exists, but the
one-active-run rule still stands: no new run until the old one ends.

```text
23:55  start a run          → day A: 1 used
00:10  resume it            → day A: 1 used · day B: 0 used · still one active run
```

**Concurrency.** `start` locks the player row, so a player's starts are
serialised; the second meets the active run and is refused as that. Beneath it,
consuming is a single conditional upsert —

```sql
INSERT … VALUES (player, period, 1)
ON CONFLICT (player_id, period_key)
DO UPDATE SET runs_started = runs_started + 1 WHERE runs_started < :limit
```

— so the check and the increment cannot be separated: with one attempt left
and two transactions racing, the second waits on the row, re-evaluates against
the committed count, and writes nothing. The count cannot pass the limit even
without the player lock, and `dungeon_runs_one_active_uq` still allows one
active run. Two requests that straddle midnight each count toward the day they
read, and still produce one run.

The `run_started` event records `{ periodKey, limit, used }` as they stood.

**Read model.** `DungeonHomeView.daily` and `DungeonZoneDetailView.daily` (and
`dungeonPlay.dailyAllowance(playerId)`) carry `limit`, `used`, `remaining`,
`periodKey` and `resetsAt`. Presenters never read the usage table.

**Bonus attempts — not built.** Event bonuses, achievement rewards, admin
grants, items and seasonal bonuses would add to the *limit* for a period, not
subtract from usage: effective limit = base limit + the grants that apply. That
is a grants table keyed by player (and, for a dated bonus, period) read beside
the settings row in `status` and `consume`; `runs_started` keeps its meaning. A
per-zone cap would be a second, zone-keyed usage row checked in the same
transaction. Neither needs the existing tables reshaped.

**Testing.** On a non-production deployment with `ENABLE_TEST_ADMIN_CONTROLS`,
Portal → Test Controls → *Reset Today’s Delve Runs* deletes the player's usage
row for the current period (audited as `test_reset_delve_usage`). By hand:

```sql
DELETE FROM dungeon_daily_usage WHERE player_id = :id AND period_key = :today;
```

### Starting, and what is snapshotted

`start` runs in one transaction: check the unlock, lock the player row, refuse
if a run is already active, snapshot the fighter, spend one daily run
([Daily runs](#daily-runs)), generate the run, store both, and record
`run_started`. Anything that throws rolls all of it back.

The **fighter** (`dungeon_runs.fighter`) is the active Buddy and her
Equipment-derived stats at that moment:

- Buddy: copy id, species, display name, level, Current SP;
- ATK, DEF, max HP — exactly what `combatStatsService` calculated;
- the three equipped items: instance id, definition, display name, rarity and
  multiplier.

The run starts at full HP on its first node. From then on the run fights with
that snapshot and nothing else:

| After a run starts… | Effect on that run |
| --- | --- |
| gear is equipped, unequipped, dismantled or fabricated | none |
| the active Buddy is changed | none — the run keeps its Buddy, name and artwork |
| the Buddy levels up | none |
| the zone, an enemy, an event or a reward table is edited | none (the content snapshot) |

Equipment management is **not** blocked while a run is active. It simply does
not reach the run. There is no swapping gear inside a run.

### Node lifecycle

| State | Meaning | How it is reached |
| --- | --- | --- |
| available | an outgoing node of the completed current node | read off the stored graph |
| entered | the player is on it; not resolved | `enterNode` (or `start`, for the first node) |
| completed | resolved exactly once; the resolution is stored | `resolveNode` |

`dungeon_runs.node_states` holds an entry per entered node:
`{ status, enteredAt, completedAt, resolution }`. V1 combat is automatic, so a
node goes from `entered` to `completed` in one step; `entered` is the state an
interactive fight will sit in between button presses.

Navigation never rerolls anything. The generated graph is authoritative: after
a node is completed the player sees its outgoing nodes — **Continue** when
there is one, a button each at a fork. Entering a node is permanent; the other
side of a fork is gone.

### Resolving a node

| Type | What resolving does |
| --- | --- |
| `combat`, `elite`, `miniboss`, `boss` | One fight through the existing combat engine. |
| `rest` | Heals `nodeSettings.rest.healBasisPoints` of max HP. |
| `event` | Applies the event's `hpChangeBasisPoints`; pays the band if `paysReward`. |
| `reward` | Pays the node's band. |
| `exit` | Nothing. An extraction point, or the end of a run with no boss. |

**Combat.** No dungeon-specific math. The fight is an ordinary `CombatState` —
the snapshotted ATK / DEF / max HP at the run's **current** HP, against the
snapshotted enemy at full HP — run by `simulateCombat` with the basic-attack
controllers. The engine's structured events are stored in the run history and
shown only as the short Combat Trials summary.

**Damage variance.** The engine rolls each hit between 90% and 110% of its
base damage (see `docs/combat-system.md` for the formula and rounding order).
Dungeons add nothing to that; they only choose where the dice come from:

```text
combatSeed = first 32 bits of md5("<run seed>:<node id>:combat:waifumon.dungeon.combat.v1")
rng        = seededRng(combatSeed)
```

- The seed is derived from **stable run data** — the stored run seed and the
  node id — and recorded on the `combat_resolved` event.
- It is a stream of its own. The layout generator's stream ends when the graph
  is built; combat never continues it, and reward draws stay on their own keyed
  draws.
- So a node's fight is a function of the run seed, the node and the HP the
  fighter arrived with. Computing it again gives the same fight.
- **There is no reroll.** A completed node is read back from its stored
  resolution — a double-click, a Discord retry or a stale button returns the
  original result and fights nothing. Even a recomputation could not differ.
  Abandoning to try again costs a daily run and gets a different run.

- Player victory: the node is completed, its band is paid, and the HP left is
  the run's new HP.
- Enemy victory: HP is 0 and the run is **defeated**.
- Round limit with both sides standing: also a defeat (`cause: stalemate`). A
  fight that cannot be won is not retried forever.

**HP persists.** Nothing heals after an ordinary fight.

```text
Start:          370 / 370
Fight 1 ends:   334 / 370
Fight 2 begins: 334 / 370
```

**Rounding.** One rule wherever a share is taken — rest healing, event HP
changes, defeat retention: multiply, divide by 10,000, round **toward zero**.
30% of 370 is 111; 25% of 3 is 0; 25% of 7 is 1.

### Rewards during a run

What a node pays comes from the **snapshotted** band and tables, drawn
deterministically from the run's seed and the node (the keyed draws and table
roller expeditions use). Asking again gives the same answer.

| Reward | When the player has it |
| --- | --- |
| Equipment | At once. A normal instance in the Gear Bag; can be equipped or dismantled at Patch. |
| WaifuBux, items | At once. |
| Progression currency | Not until the run ends. Shown as *unbanked*. |

Gear goes through the one Equipment reward path
(`equipmentRewards.grantChosenEquipmentReward`): the table picks the base
definition from the pool snapshotted at start; the Equipment service rolls the
multiplier and affix. Source type `dungeon`, source key the zone.

### Ending a run

| Outcome | How | Unbanked currency |
| --- | --- | --- |
| `extracted` | **Extract** on a completed extraction node, after a confirmation | 100%, plus the zone's `extraction` bonus |
| `completed` | resolving the final node — beating the boss needs no further click | 100%, plus the zone's `completion` bonus |
| `defeated` | a lost or stalemated fight | the zone's retention share |
| `abandoned` | **Abandon**, after a confirmation, from any active run | the zone's retention share |

```text
Unbanked: 40    Defeat retention: 25%    Banked: 10    Lost: 30
```

Secured gear, WaifuBux and items are kept in every case. A defeat is not a wipe.

Abandon keeps the same share as a defeat rather than nothing: it never beats
extracting (which banks everything), so there is nothing to abuse, and a player
who has to leave is not punished harder than one who loses.

The settlement is stored on the run (`dungeon_runs.settlement`): outcome, cause,
node and depth reached, final HP, what was earned, the bonus, the retention,
what was banked and lost, and the balance afterwards. `unbanked_currency` is
zero once a run is settled.

Banking is one `progressionCurrencyService.grant`, so the permanent balance
cannot go negative and every change has a ledger row (`dungeon_extraction`,
`dungeon_completion`, `dungeon_defeat`, `dungeon_abandon`, source
`dungeon_run:<id>`). If the zone's currency has been removed or disabled under
a run, the run still ends and the settlement records `bankingSkipped` and
nothing banked.

After any terminal state the player may start a new run.

### Idempotency and concurrency

Every mutation is one transaction that first takes `FOR UPDATE` on the run row.
Two actions on one run are serialised and exactly one legal transition wins;
the other changes nothing and returns the run as it now stands.

Each action reports `applied`, `replayed` or `refused`:

| Situation | Result |
| --- | --- |
| Fight / Rest / Open clicked twice | one resolution; the second is `replayed` with the stored result |
| Both fork buttons clicked together | one `applied`, the other `refused` |
| Extract and Continue racing | one wins; the loser is `refused` |
| Abandon racing a fight | one settlement, whichever lands first |
| Start clicked twice | one run and one daily run spent; the second is told a run is active and shown it |
| Start with one daily run left, twice at once | one run; the count stops at the limit |
| A button from a finished run | `refused` (`run_over`), painted with how the run ended |

The keys that make this safe:

- a node is resolved only while `entered`; a completed node is read back;
- a gear drop's grant key is `dungeon:<run>:<node>:<index>` — a retry returns
  the same instance, never a reroll;
- settlement happens only while the run is `active`, and the banking grant
  carries the request key `dungeon_run:<run>:settlement`;
- the partial unique index still allows one active run per player.

Buttons carry the run id and node id. No nonce is needed: those ids *are* the
transition.

### Run history

`dungeon_run_events` — append-only, one structured row per thing that happened,
written in the transaction that made it happen:

`run_started`, `node_entered`, `combat_resolved`, `rest_resolved`,
`event_resolved`, `reward_resolved`, `exit_resolved`, `extraction`, `defeat`,
`completion`, `abandon`, `currency_banked`.

Payloads are numbers and keys, never prose: HP before and after, the enemy's
and fighter's stats, the engine's combat events, what was paid, the settlement.

To understand a run: its row gives the seed, the graph and the zone snapshot
(`reproduceGraph` regenerates the graph from them, for comparison); its events
give everything that happened, in order. State is never derived by
regenerating — the stored graph and state are authoritative.

### Discord screens

| Screen | Shows |
| --- | --- |
| Home, no run | `Daily Runs: n / limit remaining`, then the open zones with description, depth range, the currency and the player's balance |
| Home, active run | the daily runs line, zone, depth and node, HP, unbanked currency, secured rewards; Resume, Abandon |
| Zone | the Buddy and stats a run would snapshot, the rules, the daily runs, Start Run |
| Node | zone, depth, node type and content, the Buddy's HP / ATK / DEF, unbanked currency, extraction availability |
| Result | victory or defeat, HP left, rounds, a short combat summary, rewards, the path ahead, Extract |
| End | depth reached, currency earned / kept / lost, what was secured |

The daily runs line always uses the configured limit — no number is written
into the presenter. With none left and no active run, the home and the zone
say so and when they come back (a relative Discord timestamp of the next
reset), Start Run is disabled, and a stale Start click is refused by the
service and lands on the home. With none left and a run in progress, Resume
and Abandon work as always: the allowance only gates a *new* run.

The large image is the first of: the event's artwork, the enemy's artwork, the
zone artwork, the zone background. The snapshotted Buddy is the thumbnail.
Nothing is composited.

Gear Score is not shown anywhere. The player sees real ATK / DEF / HP and
depth.

### Scrapheap Gauntlet — initial tuning

Everything below is `initial_tuning`: a starting point for validating the loop,
not economy balance.

**Intended progression.** The first zone should let a newly eligible player
take part without letting them finish:

```text
depth 1–2   starter-friendly      Scrapyard Drones only
depth 3–4   the first way out     a rest that is also an extraction point
depth 3–7   Improved N / strong   Alley Bruiser joins at 3
            starter challenge
depth 5+    R gear territory      Security Automaton, and the elite, from 5
boss        strong R / SR         Scrapheap Colossus
```

```text
starter → survive a shallow run → extract something → improve → return
```

Starter Equipment is **not** meant to complete the dungeon, and does not.

| | |
| --- | --- |
| Scrapyard Drone | depth 1–4 |
| Alley Bruiser | depth 3–7 (was 2–7) |
| Security Automaton | depth 5+ (was 4+); as the elite, depth 5+ (was 3+) |
| Extraction | from depth 3 (was 4), at `rest` and `exit` nodes |
| Guaranteed extraction | one at depth 3–4 in every run; a second at depth 6+ where the run has room (66% of runs) |
| Rests | exactly one per run (was 1–2), heals 30% of max HP — unchanged |
| Ordinary fight | 1–2 / 2–4 / 3–6 currency by depth; no gear |
| Elite | 4–6 currency; 15% gear (`dungeon-scrapheap-elite-v1`) |
| Reward node | 3–5 currency, 15–30 WaifuBux; 25% gear (`dungeon-scrapheap-cache-v1`) |
| Boss | 10–15 currency, 40–80 WaifuBux; 50% gear, up to SR (`dungeon-scrapheap-boss-v1`) |
| Completion bonus | 10 currency |
| Defeat / abandon | keep 25% |
| Events | Abandoned Cache pays its depth band; Flickering Terminal +10% HP; Unstable Catwalk −15% HP |

How it was tuned, and what was deliberately left alone:

- **Depth gating, not enemy nerfs.** A starter build (ATK 83 · DEF 65 · HP 370
  at Current SP 185) beats a Drone at a cost of about a third of its HP and
  cannot beat an Alley Bruiser at all. With the Bruiser eligible from depth 2
  and the first extraction at depth 4 or later, the usual run died before it
  could leave. The Bruiser now starts at 3 and the Automaton at 5. Every stat
  block is unchanged — they are shared with Combat Trials — and starter
  Equipment was not buffed.
- **Extraction placement.** One guaranteed point at a random depth from 4 put
  the first way out at depth 5 or deeper in 62% of runs. It is now always at
  depth 3 or 4 (half each), and longer runs get a second at depth 6 or deeper.
  Never more than two; never on the final node.
- **The early point is the rest; the later one is a bare exit.** Limiting rests
  to one per run makes the later extraction an `exit`: no heal, so the choice
  there is "bank it, or face the boss as I am". It also keeps the deep half as
  hard as it was — a second rest made the boss markedly easier for mid builds.
- **Rest healing stays at 30%.** With the gating and the early rest, a starter
  reaches the first extraction 84% of the time; raising the heal was not needed
  and would mostly have helped builds that already finish.

The boss, `scrapheap_colossus`, is still tagged `temporary`. It was retuned for
V1 (ATK 190 → 170, DEF 120 → 110, HP 1500 → 1200) and not touched since. Note
that the boss is gated by Current SP at least as much as by gear: at SP 185 no
build beats it, including strong R / SR; at SP 240 strong R / SR wins 57% of
the time; at SP 300 mid-roll R wins 79%.

### Balance simulation

`npm run dungeons:playtest` plays generated runs in memory with the same pure
rules a real run uses — the same engine, damage variance and per-node combat
seeds included — and reports, per build and extraction strategy: completion,
extraction and defeat rates, **first-extraction reach**, depth, HP left,
currency and gear per run, and both again **per full daily allowance**
(`--daily`, default the shipped limit). `--graphs` adds what the generator
lays out: run length and where the extraction points fall. No database.

```text
npm run dungeons:playtest -- --runs 5000 --sp 185,240,300,450 --graphs
```

A simulated player follows one strategy:

| Strategy | At an extraction point |
| --- | --- |
| `aggressive` | never leaves |
| `cautious` | leaves at ≤ 50% HP |
| `conservative` | leaves at ≤ 70% HP |
| `first_exit` | leaves at the first opportunity |

*Reaching the first extraction* means resolving a node that offers extraction
and still standing — the first moment the player could have cashed out,
whatever their strategy then did.

**Generation (5,000 seeds):** 0 invalid. Depths per run 5–9. Main-path
extraction points per run: one in 34%, two in 66%. First one at depth 3 (50%)
or 4 (50%).

**Completion and reach, `aggressive` (5,000 runs per cell; before → after this
pass):**

| Current SP | Build | Completion | First-extraction reach | Avg depth |
| --- | --- | --- | --- | --- |
| 185 | Starter | 0% → 0% | **30% → 84%** | 3.9 → 5.0 |
| 185 | Improved N | 0% → 0% | 59% → 100% | 5.3 → 6.1 |
| 185 | R | 0% → 0% | 68% → 100% | 5.7 → 6.3 |
| 185 | Strong R / SR | 0% → 0% | 87% → 100% | 6.8 → 7.0 |
| 300 | Starter | 0% → 0% | 67% → 100% | 5.8 → 6.3 |
| 300 | Improved N | 32% → 14% | 97% → 100% | 7.1 → 7.2 |
| 300 | R | 88% → 79% | 100% | 7.3 → 7.2 |
| 300 | Strong R / SR | 100% → 100% | 100% | 7.3 → 7.2 |
| 450 | Starter | 33% → 30% | 98% → 100% | 7.2 → 7.2 |
| 450 | Improved N and up | 100% → 100% | 100% | 7.3 → 7.2 |

("Before" completion is the fully deterministic engine; its reach column is the
old zone measured with variance on, since reach was not measured before.)

**Extraction as a decision (after):**

| SP · build | Strategy | Complete | Extract | Defeated | Banked / run | Gear / run |
| --- | --- | --- | --- | --- | --- | --- |
| 185 · Starter | aggressive | 0% | 0% | 100% | 0.9 | 0.12 |
| | cautious | 0% | 4% | 97% | 1.1 | 0.12 |
| | conservative | 0% | 36% | 64% | 2.1 | 0.10 |
| | first_exit | 0% | 84% | 16% | 3.2 | 0.07 |
| 185 · Improved N | aggressive | 0% | 0% | 100% | 1.4 | 0.14 |
| | cautious | 0% | 25% | 75% | 2.9 | 0.13 |
| | conservative | 0% | 32% | 68% | 3.2 | 0.13 |
| 240 · Strong R / SR | aggressive | 57% | 0% | 43% | 18.9 | 0.46 |
| | conservative | 57% | 26% | 18% | 20.9 | 0.45 |
| 300 · Improved N | aggressive | 14% | 0% | 86% | 6.2 | 0.25 |
| | conservative | 14% | 29% | 57% | 8.6 | 0.24 |
| 300 · R | aggressive | 79% | 0% | 21% | 25.8 | 0.57 |
| | conservative | 74% | 18% | 8% | 25.7 | 0.54 |

- Extraction now pays for a build that cannot finish: leaving banks 2–4× what
  dying does. For a build on the edge (SP 240 strong R / SR, SP 300 improved N)
  the later exit turns most defeats into extractions at no cost in completion.
- For a build that usually finishes (SP 300 R) leaving early costs completions
  for nothing — pushing on is right. That is the decision working.
- The 50% threshold barely fires for a starter, because the early extraction
  *is* the rest: after its 30% heal a starter stands at about 60% HP. A starter
  who pushes on from there meets an Alley Bruiser. `first_exit` is the honest
  measure of what the shallow loop pays.

**Per daily allowance (3 runs; after):**

| SP · build | Strategy | Currency / day | Gear / day |
| --- | --- | --- | --- |
| 185 · Starter | first_exit | 9.7 | 0.22 |
| 185 · Starter | aggressive | 2.8 | 0.36 |
| 185 · Improved N | conservative | 9.5 | 0.39 |
| 185 · R | conservative | 10.1 | 0.41 |
| 185 · Strong R / SR | conservative | 12.8 | 0.50 |
| 240 · Strong R / SR | conservative | 62.6 | 1.36 |
| 300 · Improved N | conservative | 25.7 | 0.73 |
| 300 · R | aggressive | 77.4 | 1.72 |
| 300 · Strong R / SR and above | aggressive | 97.8 | 2.05 |

- A build that completes every run banks about **33 currency and 0.68 pieces
  of gear per run** (N 0.44 / R 0.22 / SR 0.03), so the cap makes the ceiling
  about **98 currency and 2 pieces of gear a day** — roughly one SR every 11
  days. Before the cap this was unbounded.
- A new player banks about 10 a day. The spread between a new player and a
  finished build is about 10×.
- Nothing here was retuned for the economy: Ascension costs are not decided,
  so there is nothing to tune against. The daily limit is the lever, and it is
  one setting.

Assumptions baked into these numbers: builds are three multipliers applied to
Current SP (starter 0.45 / 0.35 / 2.00; improved N 0.70 / 0.60 / 2.40; R 0.85 /
0.75 / 2.60; strong R / SR 1.10 / 1.00 / 2.60); a fork is taken toward a rest
when hurt, otherwise away from a fight; gear is counted by the rarity of the
definition drawn, not a rolled instance.

## Future: interactive combat

V1 fights resolve in one step. The seams for interactive combat are already in
place:

- a node sits in `entered` between entering and resolving — where a fight in
  progress would live;
- the combat state is plain JSON and the engine resolves one action at a time,
  so a fight can be parked on the run between button presses;
- the **Fight** button is the one place Basic Attack / Defend / Special would
  replace;
- the settlement, rewards and history do not care how the fight was fought.

## Shipped zones, live edits and Git

Zones follow the reward-table model.

On every start the server reads `content/dungeons/zones.json` and, per zone:

| Database row | What happens |
| --- | --- |
| missing | inserted from the file |
| unchanged since it was last seeded | updated to the file if the file changed |
| edited in the Portal | **left alone**; the divergence is logged (`dungeon-zones/diverged`, a warning when Git also changed that zone) |
| edited, and the file now matches it exactly | adopted: counts as shipped again |

The decision uses content hashes: `content_hash` is the row as it stands,
`seed_hash` is the shipped zone last seeded into it. The hash is over the parsed
zone, so reformatting the file is not a change, but reordering pool entries or
bands is — order is part of every deterministic draw.

A zone created in the Portal is never touched by the seed.

**Export** on the Dungeons page downloads every live zone in the file format.
Commit it over the shipped file and each server whose row matches adopts it.
There is no import and no "reset to shipped" yet.

After seeding, the server logs an error (`dungeon-zones/invalid`) for any
enabled zone that cannot generate on that server.

## Admin Portal

Permissions: `dungeons.read` (view, validate, preview, simulate, export) and
`dungeons.write` (create, edit, enable/disable, edit the currency).

| Page | |
| --- | --- |
| `/admin/dungeons` | Zones — name, enabled, node range, pools, revision, last update — with enable/disable, export, and the progression currency card. |
| `/admin/dungeons/new`, `/admin/dungeons/zones/:key` | The zone editor. |
| `/admin/dungeons/preview` | Generate one run from a seed, or simulate 1,000. |

The editor shows percentages where the document stores basis points (branch
chance, defeat retention, rest healing under **Node behaviour**), and offers enemies, events, reward tables and
currencies from the server rather than asking for keys.

### Validation

Every save is validated on the server, in the saving transaction, and the editor
runs the same checks as you type. Issues carry a path
(`pools.combat[2].enemyKey`) and are shown on the part of the form they name.

1. **Schema** — bounds, `minNodes ≤ maxNodes`, no negative weights, not every
   weight zero, depth ranges the right way round, unique pool entry and band
   ids, safe artwork paths.
2. **References** — every enemy, event, reward table and currency exists.
   Missing is an error; disabled is a warning.
3. **Reachability** — an extraction depth past the end of a run, a depth range
   no node can fall in, a required type with nothing eligible, a final depth
   with no eligible boss, a limit below a requirement.
4. **Trial runs** — the real generator over 200 fixed seeds. Rules that are each
   plausible can still be jointly impossible; this is where that shows.

On an enabled zone a failed trial run is an error. On a disabled zone it is a
warning, so work in progress can be saved. Disabling always succeeds.

### Concurrency

Every zone and currency has a `revision`. A save sends the revision it loaded;
if someone saved first the server answers `409 DUNGEON_ZONE_STALE` with the
current revision and writes nothing. The editor then offers to reload.

### Preview

Choose a zone and, optionally, a seed. Without one a seed is drawn and shown,
so the same run can be generated again. The preview shows the seed, every node
by depth with its type and its enemy or event, forks, the boss and the
extraction points. A zone that cannot generate shows the generator's reasons.

Nothing is persisted. No player run is created.

## Simulation

`simulateDungeonGeneration(zone, catalogue, { runs, firstSeed })` generates
seeds `firstSeed, firstSeed + 1, …` and reports node counts, node-type
distribution, branch rate, boss, rest and extraction occurrence, enemy and event
appearance rates, and the invalid-generation rate with reasons.

- Portal: **Simulate 1,000 runs** on the preview page (a live zone).
- CLI: `npm run dungeons:simulate -- --zone scrapheap_gauntlet --runs 5000`
  (the zone as shipped in Git; no database needed).

That is *generation* only. For how runs *play* — completion, defeat, currency
and gear — see [Balance simulation](#balance-simulation).

## API

All under `/api/v1/admin/dungeons`.

| Method | Path | |
| --- | --- | --- |
| GET | `/zones` | list |
| GET | `/zones/:key` | one zone, its revision and current issues |
| POST | `/zones` | create |
| PUT | `/zones/:key` | save (`expectedRevision`) |
| PUT | `/zones/:key/enabled` | enable/disable (`expectedRevision`) |
| GET | `/reference` | enemies, events, reward tables, currencies |
| POST | `/validate` | dry run |
| POST | `/preview` | `{ key \| zone, seed? }` → one generated graph |
| POST | `/simulate` | `{ key \| zone, runs, firstSeed }` → report |
| GET | `/export` | the file format |
| GET | `/settings` | Delve-wide settings: `dailyRunLimit` and its bounds |
| PUT | `/settings` | `{ dailyRunLimit }` — a whole number 0–50; `0` closes Delve to new runs |
| GET | `/currencies` | progression currencies |
| PUT | `/currencies/:key` | edit display metadata (`expectedRevision`) |

## Not built yet

Interactive combat (Basic Attack / Defend), special attacks, abilities and
status effects; a player dungeon UI in the Portal; Ascension and anything that
spends the currency; raids; multiple Buddies in a run; swapping equipment
inside a run; a dungeon inventory; vendor nodes; dungeon crafting; any physical
map.

Also deferred within this area:

- bonus daily runs (events, achievements, admin grants, items, seasons),
  per-zone limits, and any entry cost — see [Daily runs](#daily-runs) for how
  they would layer on;
- crits, misses, dodge, accuracy and status RNG — damage variance is the only
  randomness in combat;
- event choices and richer event effects;
- paying a table's Essence and XP from a dungeon;
- tag-driven generation, editing events in the Portal, an artwork picker for
  zone artwork (the fields are text, validated), zone import and
  reset-to-shipped, and delete protection on reward tables that a zone
  references;
- an Admin view of a run and its history (the data is stored; nothing shows it).
