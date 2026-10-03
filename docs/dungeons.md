# Dungeons — generation and authoring foundation

A dungeon run is a short generated graph of gameplay nodes. Admins author
**zones**; the generator turns an enabled zone and a seed into a legal run; the
run is stored as a snapshot.

```text
Admin-authored zone (rules + pools + rewards)
        ↓
seeded deterministic generator
        ↓
generated run graph
        ↓
snapshot (dungeon_runs)
```

This is the foundation only. Nothing player-facing starts, plays or pays a run
yet — see [Not built yet](#not-built-yet).

| Piece | Where |
| --- | --- |
| Zone shape and schema | `src/modules/dungeons/zoneDefinition.ts` |
| Generator and graph validator | `src/modules/dungeons/dungeonGenerator.ts` |
| Authoring validation | `src/modules/dungeons/zoneValidation.ts` |
| Simulation | `src/modules/dungeons/dungeonSimulation.ts` |
| Seeding shipped zones | `src/modules/dungeons/dungeonZoneStore.ts` |
| Admin service (CRUD, preview) | `src/modules/dungeons/dungeonZoneService.ts` |
| Run snapshots | `src/modules/dungeons/dungeonRunService.ts` |
| Events | `src/modules/dungeons/eventDefinitions.ts`, `content/dungeons/events.json` |
| Progression currency | `src/modules/progressionCurrency/progressionCurrencyService.ts` |
| Admin API | `src/api/routes/v1/admin/dungeons.ts` |
| Portal | `portal/src/features/adminDungeons/` |
| Tables | migration `0050_dungeon_foundation` |

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
| `pools` | `combat`, `elite`, `miniboss`, `boss` (enemy keys) and `event` (event keys). |
| `rewards` | Currency key, defeat retention, depth bands, completion and extraction bonuses. |

Zones are never deleted; they are disabled.

### Node types

`combat`, `elite`, `event`, `reward`, `rest`, `miniboss`, `boss`, `exit`.

The type is stored as text in zones and graphs, so adding one (a vendor, a
puzzle) is a new entry in `DUNGEON_NODE_TYPES` plus whatever the generator must
know about its role — no table changes.

This pass gives each type its structural role only. Nothing resolves a fight,
an event, a rest or a reward yet.

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
`artworkPath`, `tags`. Enough for the generator to place an `event` node;
choices and effects come with playable runs.

World Encounters were considered and not reused. They are spawned into a
channel, expire on a timer, carry per-guild cooldowns and history, and resolve
through an effect executor that pays the player immediately. A dungeon node has
none of that lifecycle, and its rewards stay unbanked until extraction.

Events are file content, like combat enemies. They are not editable in the
Portal yet.

## Rewards

Modelled now, paid later. Three kinds of reward are distinguished so the payout
code has somewhere to put each:

- **Secured rewards** — Equipment that has dropped, and anything else secured on
  the spot. Lives in `dungeon_runs.secured_rewards`.
- **Unbanked progression currency** — accumulates in
  `dungeon_runs.unbanked_currency` during the run.
- **Ordinary rewards** — WaifuBux and items, from a reward table.

| Field | |
| --- | --- |
| `rewards.currencyKey` | The stable key of the progression currency. Never a display name. |
| `rewards.defeatCurrencyRetentionBasisPoints` | Share of unbanked currency kept on defeat. `2500` = 25%. Extraction and completion are intended to bank all of it. |
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

Nothing calls `grant` or `spend` yet.

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
`generator_version`, `status`, `graph`, `zone_snapshot`, `started_at`,
`updated_at`, `completed_at`.

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

### Where later run state lives

Four columns exist and are initialised, and nothing advances them yet:

| Column | For |
| --- | --- |
| `current_node_id` | Where the player is. Set to the start node. |
| `current_hp` | HP carried between nodes. Null. |
| `unbanked_currency` | Progression currency earned and not yet banked. Zero. |
| `secured_rewards` | Rewards already secured. Empty. |

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
chance, defeat retention), and offers enemies, events, reward tables and
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
| GET | `/currencies` | progression currencies |
| PUT | `/currencies/:key` | edit display metadata (`expectedRevision`) |

## Not built yet

Playable navigation, carrying HP between nodes, extraction, defeat payout,
reward banking, Equipment drops to players, interactive combat, a player
dungeon UI in Discord or the Portal, Ascension and anything that spends the
currency, raid integration, and any physical map.

Also deferred within this area: tag-driven generation, editing events in the
Portal, an artwork picker for zone artwork (the fields are text, validated),
zone import and reset-to-shipped, and delete protection on reward tables that a
zone references.
