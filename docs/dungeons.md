# Dungeons

A dungeon run is a short graph of gameplay nodes. Admins author **zones**; an
enabled zone becomes a legal run graph; the run is stored as a snapshot; the
player walks it node by node in Discord (**⛏️ Delve** on the main menu).

A zone's graph is made one of two ways — its [layout mode](#layout-modes):

```text
Procedural zone (rules + pools)          Authored zone (rooms built by hand)
        ↓                                        ↓
seeded deterministic generator           room-graph compiler
        ↓                                        ↓
        └──────────────→  run graph  ←───────────┘
                             ↓
        snapshot (dungeon_runs)  +  fighter snapshot (Buddy, ATK / DEF / max HP)
                             ↓
        enter node → resolve node → carry HP, rewards and currency forward
                             ↓
        extract · complete · defeated · abandon  →  bank the progression currency
```

Everything below the join is one implementation. There is no "authored play
service": after run start nothing knows which mode a run came from.

Authoring and generation are the first half of this document;
[Playing a run](#playing-a-run) is the second. To just make a dungeon, start
with the two how-to guides:
[authored](#how-to-create-a-simple-authored-dungeon) and
[procedural](#how-to-create-a-simple-procedural-dungeon).

| Piece | Where |
| --- | --- |
| Zone shape and schema | `src/modules/dungeons/zoneDefinition.ts` |
| Generator and graph validator | `src/modules/dungeons/dungeonGenerator.ts` |
| Authored layouts: rules, compiler, the one graph builder | `src/modules/dungeons/authoredLayout.ts` |
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
| `layoutMode` | `procedural` or `authored` — see [Layout modes](#layout-modes). Absent on a zone stored before the field existed, which is procedural. |
| `generation` | The generator's rules — below. Kept, unused, on an authored zone. |
| `authored` | The hand-built rooms: `{ startRoomId, rooms }`. Kept, unused, on a procedural zone. |
| `nodeSettings` | What a node type does when resolved. `rest.healBasisPoints`: the share of max HP a rest restores (3000 = 30%). |
| `pools` | `combat`, `elite`, `miniboss`, `boss` (enemy keys) and `event` (event keys). What the generator draws from; unused by an authored zone. |
| `rewards` | Currency key, defeat retention, depth bands, completion and extraction bonuses. |

Zones are never deleted; they are disabled.

## Layout modes

Every zone is explicitly one of two things.

| | Procedural | Authored (room by room) |
| --- | --- | --- |
| The graph comes from | the seeded generator, fresh per run | the rooms an admin laid out, the same every run |
| An admin edits | run length, pools, weights, rules | the rooms and the links between them |
| The seed decides | the layout, the content, the backgrounds, fights and reward rolls | fights and reward rolls only |
| Preview | one generated run per seed; simulation over many | the layout itself, plus a layout check |

The mode is chosen when the zone is created. Changing it later is possible but
deliberate: a save that changes `layoutMode` is refused unless it carries
`confirmLayoutChange` (the Portal asks first). **Nothing is deleted by a
change** — `generation` + `pools` and `authored` both stay in the document,
whichever is in use — so a zone can be changed back.

### One run graph

`buildDungeonGraph(zone, catalogue, seed)` in `authoredLayout.ts` is the only
place that chooses:

```text
layoutMode === 'procedural'  →  generateDungeon(zone, catalogue, seed)
layoutMode === 'authored'    →  compileAuthoredDungeon(zone, seed)
```

Both return the same `DungeonGraph` ([The graph](#the-graph)). A real run
(`dungeonRunService.startRun`), a reproduction, the Admin preview and the
balance playtest all call it. After that the graph is stored and
`dungeonPlayService` reads only the stored graph and snapshot: navigation,
combat, HP, rest, rewards, extraction, completion, defeat, artwork, run events
and settlement are the same code for both modes.

Three things a generated node reads off the *zone* — its reward band, how much
a rest heals, its background — an authored room may set for itself. Those
travel **on the node** (`reward`, `restHealBasisPoints`, plus `roomId` and
`name`) and in the run's scene snapshot, so the play code reads them off the
run and never asks which mode it is in. A room that sets none of them inherits
exactly what a generated node of its type and depth would get.

### The authored room model

`authored: { startRoomId, rooms }`. One room compiles to one node.

| Room field | |
| --- | --- |
| `id` | Stable within the zone, `lower_snake_case`. Other rooms point at it. |
| `name` | What the author calls it. Shown to players on rooms that have no enemy or event to name (`Rest — Repair Bay`). |
| `type` | `combat`, `elite`, `miniboss`, `boss`, `event`, `reward`, `rest` or `exit` — the same node types, with the same behaviour. |
| `next` | Ids of the rooms it leads to: up to 3. Empty on the final room only. |
| `enemyKey` | The enemy fought — fights only. Chosen, not drawn from a pool. |
| `eventKey` | The event met — event rooms only. |
| `reward` | `{ rewardTable, equipmentRewardTable, currency: { min, max } }`, in place of a reward band. Null uses the zone's band for the room's type and depth. |
| `healBasisPoints` | Rest rooms: its own heal. Null uses `nodeSettings.rest`. |
| `extraction` | Whether the player may leave from here once the room is done. An interior `exit` always may; the final room never does. |
| `backgroundAssetId`, `backgroundArtworkPath` | The room's own background. Null uses the zone's default. |
| `scene` | `{ spriteAssetId, artworkAssetId, spritePlacement }` — the room's own picture of its enemy. Each field alone: null uses the enemy's. |
| `notes` | For authors; never shown to a player. |

Fields that do not apply to a room's type are ignored. Rewards go through the
same reward tables, Equipment pools and currency rolls as a band — there is no
second reward engine.

**What makes a layout legal** (`validateAuthoredLayout`):

- exactly one start room, and every room reachable from it;
- every `next` names a room that exists, and no room leads to itself;
- no loops — an authored layout is a DAG, as a generated one is;
- exactly one final room (a room with no `next`), and it is a **Boss** or an
  **Exit**; a Boss is only ever the final room;
- every fight names an enemy and every event room names an event;
- the final room does not offer extraction — finishing it is completion.

A reference to something that does not exist (an enemy, an event, a reward
table, an image) is always an error. Everything else — a broken layout, a
disabled enemy — is an error on an **enabled** zone and a warning on a
**disabled** one, so a layout can be saved half-built while it is switched off
and cannot be switched on, or started, until it is whole.

**Compiling.** Nodes are numbered `n1…` in depth order, then the author's
order. A room's depth is the *longest* route to it from the start, so depth
only increases along any route even when one side of a fork is longer than the
other. Branches are just rooms with more than one `next`; a rejoin is two rooms
naming the same `next`. The compiler draws nothing: the same layout compiles to
the same graph for every seed.

**Snapshot.** An authored run stores its compiled graph and its zone exactly
as a generated run does. Editing the rooms afterwards reaches the next run
started and never one in progress.

**The shipped example.** `service_tunnel_example` in
`content/dungeons/zones.json` is an eight-room authored dungeon with a fork
that rejoins, built from the Scrapheap enemies and reward tables. It ships
**disabled** and tagged `authoring_example`, `initial_tuning`: it exists to be
opened in the editor and to exercise authored runs, and no player sees it
unless someone enables it. Scrapheap Gauntlet stays procedural.

### Fixed rooms on a procedural zone

A procedural zone can pin three rooms without becoming authored:

| Anchor | Field | |
| --- | --- | --- |
| First room | `generation.firstNodeType` | Every run opens on this type (its content still comes from the type's pool). Null leaves it to the weights. |
| Before the boss | `generation.rest.beforeBoss` | A Rest every route passes through — see [Rest rules](#rest-rules). |
| Final room | `generation.boss.required` | A Boss from the boss pool, or a closing Exit. |

`firstNodeType` is structural like the other two: nothing is drawn for it, so
a zone without one generates exactly as it did before the field existed, and a
type that cannot stand at depth 1 is refused by validation. That is the whole
of it — there is no placement scripting.

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
any other reservation: among the extraction types that are legal at the slot,
by weight (evenly when none has one).

**Extraction is not Rest.** Whether a node offers extraction is decided only by
`extraction.minDepth` and `extraction.nodeTypes`; whether and where rests are
placed is decided only by the [rest rules](#rest-rules). The two meet when
`rest` is one of the extraction types — then a rest deep enough is also a way
out — but neither implies the other:

| `extraction.nodeTypes` | Result |
| --- | --- |
| `["rest", "exit"]` | a rest (heal, then decide) or a bare exit, whichever is legal at the slot |
| `["exit"]` | rests never offer extraction; every way out is a bare `exit` |
| `["rest"]` | every way out is a rest |

A bare `exit` is a node of its own: no heal, no reward, just the door. A window
places one wherever a rest cannot go — next to another rest when rests may not
be consecutive, outside the rest depth range, or past the rest maximum.

### Rest rules

"Rest & Recovery" is two things: how much a rest heals
(`nodeSettings.rest.healBasisPoints`, 3000 = 30% of max HP, never above max),
and where the generator places rests (`generation.rest`):

| Field | Meaning | Default |
| --- | --- | --- |
| `minNodes` | at least this many rests on the **main path**, where no route can skip them | 0 |
| `maxNodes` | at most this many rests in the whole run; `null` for no limit | `null` |
| `minDepth` / `maxDepth` | the depths a rest may sit at (depth 1 is the first node) | 1 / `null` |
| `beforeBoss` | the node immediately before the final boss is always a rest | `false` |

Every default is "no rule", and the block draws nothing from the generator's
stream unless it has to place a rest, so a zone without it — including every
run snapshotted before it existed — generates exactly as before. It applies on
top of the generic `depthRanges.rest`, `required` and `limits`: a rest must
satisfy both. New zones should say everything about rests here and leave the
generic rules for other types.

**Rest before Boss.** With `beforeBoss: true`, every generated run ends

```text
… → Rest → Boss
```

on **every** route. The mechanism, not just the outcome:

- the depth before the final node is closed to forks when the layout is rolled,
  so it always holds exactly one node — the fork, if any, has rejoined before it;
- that node is reserved as a rest before anything is placed by weight (nothing
  is drawn for it);
- it is therefore the only node with an edge to the boss. No branch can bypass
  it, because there is no other way in.

It is an ordinary rest in every other respect. It **counts toward `minNodes`
and `maxNodes`** — `minNodes: 1, maxNodes: 1, beforeBoss: true` gives exactly
one rest, the one before the boss, never two. It must lie inside the rest depth
range. It may not sit next to another rest when rests are in `noConsecutive`.
And it offers extraction if rests do, so it can satisfy an extraction window by
itself rather than have a second point added beside it.

Closing that depth to forks shortens the room a fork has: a run needs one more
depth than it otherwise would to hold the same fork.

Validation refuses what cannot work, at the field that is wrong:

| Problem | Reported at |
| --- | --- |
| `minNodes` above `maxNodes`; inverted depth range | `generation.rest.minNodes` / `.maxDepth` |
| a rest depth range no run reaches | `generation.rest.minDepth` |
| more required rests than the shortest run has nodes | `generation.rest.minNodes` |
| `beforeBoss` with no boss required | `generation.rest.beforeBoss` |
| `beforeBoss` with `maxNodes: 0`, or a generic limit of 0 rests | `generation.rest.maxNodes` / `generation.limits[n].max` |
| `beforeBoss` where the rest depth range (either one) excludes a depth it must sit at — the message names the run's final depths and the excluded depths | `generation.rest.beforeBoss` |
| `beforeBoss` in a run too short for a start, a rest and a boss, or with required forks that leave no unforked depth before the boss | `generation.rest.beforeBoss` |
| rules that are each fine and jointly impossible | the trial runs (`generation`) |

### Region availability

A zone is not available everywhere. `availableRegions` lists the regions — by
stable id, as the region catalogue writes them (`flaccid-foothills`) — a player
must be standing in to see the zone and **start** a run:

```json
"availableRegions": ["flaccid-foothills"]
```

- One region or several. Order is the catalogue's; it has no meaning.
- **An empty list means nowhere**, not everywhere. There is no global option.
  An enabled zone must name at least one region; a disabled draft may be saved
  without one, with a warning.
- Each id must be a region the catalogue has (`content/regions/*.json` plus the
  enabled expansion packs). Unknown is an error, at `availableRegions[n]`; a
  region that exists but is not released is a warning. Duplicates are refused.
- No region id is written in dungeon code. The catalogue is the loaded region
  content, read through `dungeonRegionsFromContent`.

Region availability applies **only to starting a run** — see
[Region and travel](#region-and-travel).

**Zones stored before this field existed** are given a one-time compatibility
value so none silently disappears — see
[Region compatibility backfill](#region-compatibility-backfill).

### Artwork

A zone has two optional images, both paths relative to the assets root:

| Field | Convention | File on the server |
| --- | --- | --- |
| `artworkPath` | `dungeons/zones/<zone-key>.webp` | `assets/dungeons/zones/<zone-key>.webp` |
| `backgroundArtworkPath` | `dungeons/backgrounds/<zone-key>.webp` | `assets/dungeons/backgrounds/<zone-key>.webp` |

The stored value never includes `assets/`. Both go through the shared
`relativeArtworkPath` rules — relative, no `..`, no absolute path or URL, a
supported image extension — and a leading `assets/` is refused with a message
saying to drop it. A path whose file does not exist yet is **not** an error:
the zone saves, and every screen falls back to the next image or to text.
`.webp` is the convention; `.png` and the other supported formats work.

Those two paths are the **shipped** artwork. A zone can also use artwork
uploaded through the Portal, with no commit — see
[managed-artwork.md](managed-artwork.md):

| Field | |
| --- | --- |
| `artworkAssetId` | An uploaded image that overrides `artworkPath` while the asset is active. |
| `backgroundAssetId` | The same for `backgroundArtworkPath`. |
| `backgrounds` | The **background pool**: `{ id, assetId \| artworkPath, weight, enabled, minDepth, maxDepth }` entries. Each node of a run draws one by weight from those covering its depth, once, when the run is generated. Empty means every node uses the zone background. |

Precedence is always managed asset → shipped path → the next image. An asset
id must name an asset that exists (an error otherwise); a disabled one is a
warning and the shipped path shows instead.

In the Portal these are two pictures, not four fields: the **Zone cover**
(`artworkAssetId` over `artworkPath`) and the **Default background**
(`backgroundAssetId` over `backgroundArtworkPath`).

#### Artwork inheritance

What a room is drawn against — final precedence, first match wins.

**Background**

```text
authored:    room background  →  zone default background  →  zone cover  →  text only
procedural:  the background the node drew from the pool  →  zone cover  →  zone default background  →  text only
```

An authored room with no background of its own is *recorded* as using the zone
default when the run starts, so the default shows before the cover does. A
procedural zone keeps its existing order for a node that drew nothing from the
pool (zone cover, then zone background) — this work did not change it.

**A fight** (combat, elite, miniboss, boss) composes the enemy over that
background:

```text
sprite:     room sprite override  →  enemy's managed sprite  →  enemy's shipped sprite
            (no sprite at all)    →  full art: room override → enemy managed → enemy shipped
            (no art at all)       →  the background on its own  →  zone cover  →  text only

placement:  room placement override  →  enemy's managed placement  →  enemy's shipped placement  →  system default
```

Each of a room's three overrides stands alone: a room may move the sprite
without replacing it. Two limits worth knowing: an override asset that is
disabled or deleted falls through to the enemy's **shipped** file for that
slot (not to the enemy's managed asset), and a room's own background that
cannot be loaded on a non-fight room falls through to the zone cover.

All of it is snapshotted at run start, like the rest of a run. Clearing an
override restores what the room inherits — for the next run started.

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
| `depth`, `lane` | `lane` is the node's position among those at its depth. |
| `type` | A node type. |
| `outgoing` | Ids of the edges leaving it. `edges` is `[{ id, from, to }]`. |
| `content` | `{ kind: 'enemy' \| 'event', key }`, or null. |
| `source` | `{ pool, entryId }` — the pool entry the content came from. |
| `rewardBandId` | The band it pays from, or null. |
| `extraction` | Whether the player may extract here. |
| `terminal`, `boss` | |
| `roomId`, `name`, `reward`, `restHealBasisPoints` | Only on a node compiled from an authored room: which room, and what it chose for itself. |

The graph is plain JSON: no functions, no runtime objects.

An **authored** zone produces this same shape, with two differences that follow
from being hand-built: an edge may skip a depth (a room sits at the depth of
the longest route to it), and a depth may hold up to as many nodes as a room
has ways on. `source` is null — authored content is chosen, not drawn.

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
costs one of the day's Delve runs and nothing else — never Energy. The zone
must also be open in the region the player is standing in.

### Region and travel

`⛏️ Delve` shows where the player is and only the enabled zones available
there:

```text
Current location: Flaccid Foothills
Available Delves: Scrapheap Gauntlet
```

A zone that is not available here is not listed at all — no greyed-out entry.
With none: *There are no Delves available in this region.*

The listing is a convenience, never the rule. `start` checks again, inside its
transaction, against the player row it has locked:

1. the Equipment unlock;
2. no run already active (an active run is offered instead, whatever else is true);
3. the zone exists and is enabled;
4. the player's `current_region` is in the zone's `availableRegions`;
5. an active Buddy and a complete loadout;
6. a daily run left;
7. the zone validates and generates.

Any of these failing stores nothing and spends nothing. A wrong region is
`DUNGEON_ZONE_UNAVAILABLE` with reason `region` — *That Delve isn’t available
in Waifu Valley.* — and Discord lands on the home. Because the player row is
locked, travelling cannot slip between the check and the start. The zone screen
refuses the same way, so a stale button cannot even show Start.

**After the start, region stops mattering.** Nothing else reads it:

| The player… | The active run |
| --- | --- |
| travels to another region | unchanged: listed on the home there, resumable, playable to the end |
| is somewhere with no Delves at all | the same — the home shows the run instead of an empty list |
| extracts, completes or abandons from elsewhere | works; then only what is open *there* can be started |

| An admin… | The active run |
| --- | --- |
| moves the zone to other regions | unchanged; new runs follow the edit |
| disables the zone | unchanged; nobody can start a new one |

`run_started` records the region the run was started in, for audit. Nothing
reads it back. There are no per-region daily limits: the allowance is shared.

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
if a run is already active, check the zone is open where the player stands
([Region and travel](#region-and-travel)), snapshot the fighter, spend one daily run
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
| the background pool, an enemy's sprite or its placement is edited | none — each node's background and each enemy's artwork references and placement were snapshotted |
| the image behind an uploaded asset is **replaced** | the run shows the new image; its choice of asset does not change |
| an uploaded asset the run uses is disabled or deleted | the screen falls back to the next image |

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
| Home, no run | `Current location`, `Daily Runs: n / limit remaining`, then the zones open in that region with description, depth range, the currency and the player's balance — or *There are no Delves available in this region.* |
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

**Artwork precedence.** The large image is the first of these that is actually
available; a missing, disabled or unsafe image is skipped, never an error. Each
"artwork" is a managed asset while one is set and active, else the shipped
path (`src/discord/dungeonArtwork.ts`):

| Screen | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| Fight (combat, elite, miniboss, boss) | the node's background with the enemy's **sprite** composed over it | the enemy's full artwork | the node's background alone | zone artwork | zone background | text only |
| Event, Rest, Cache, Exit | the event's own artwork | the node's background alone | zone artwork | zone background | text only | |
| Zone screen (before Start) | zone artwork | zone background | text only | | | |
| Delve home, no run | the first listed zone's artwork, then its background, then the next zone's | | text only | | | |
| Delve home, active run | as the node the run is on | | | | | |

"The node's background" is the one that node drew from the zone's background
pool when the run was generated; for the composed scene, a node that drew none
uses the zone background. A zone with no pool and enemies with no sprites
behaves exactly as before: enemy artwork, zone artwork, zone background, text.
An enemy is never composed onto a node that is not a fight. Only events have
artwork of their own among the non-combat nodes.

The Buddy is the thumbnail on every screen: the run's **snapshotted** Buddy
during a run, the live active Buddy on the zone screen. The composed scene is
rendered once per distinct combination and cached
([managed-artwork.md](managed-artwork.md#sprites-backgrounds-and-scenes)).

**Which artwork an active run shows.** The run's own snapshot: the zone's
paths and asset ids, each enemy's and event's artwork, each node's background
and each enemy's sprite placement, as they were when the run started. Editing
any of them changes the zone screen and new runs at once and leaves runs in
progress showing what they started with; a repaint never re-rolls anything.
The *image* behind a path or an asset id is read live, so replacing it reaches
everything.

Gear Score is not shown anywhere. The player sees real ATK / DEF / HP and
depth.

### Scrapheap Gauntlet — initial tuning

Everything below is `initial_tuning`: a starting point for validating the loop,
not economy balance.

**Intended progression.** The first zone should let a newly eligible player
take part without letting them finish:

```text
depth 1–2   starter-friendly      Scrapyard Drones only
depth 3–4   the first way out     a rest that is also an extraction point (or a bare exit)
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
| Available in | Flaccid Foothills (`flaccid-foothills`) only |
| Extraction | from depth 3 (was 4), at `rest` and `exit` nodes |
| Guaranteed extraction | one at depth 3–4 in every run; a second at depth 6+ where the run has room |
| Rests | 1–2 per run, from depth 2, each healing 30% of max HP; **always one immediately before the boss** |
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
  Usually two, occasionally three (1% of runs); never on the final node.
- **Rest → Boss.** `rest: { minNodes: 1, maxNodes: 2, minDepth: 2, beforeBoss: true }`.
  Every run ends on a rest and then the Colossus. In a run of five depths that
  rest is also the early extraction (one rest doing both jobs, 17% of runs);
  otherwise there are two rests — the early way out and the one before the
  boss (83%). When the early window's only free slot is next to the pre-boss
  rest, it becomes a bare exit instead, since rests may not be consecutive.
  The rest before the boss is itself an extraction point, so in any run of
  seven depths or more it *is* the later way out: heal, then leave or fight.
- **Rest healing stays at 30%.** With the gating and the early rest, a starter
  reaches the first extraction 84% of the time; raising the heal was not needed
  and would mostly have helped builds that already finish.
- **What the rest before the boss costs.** It replaced a bare exit in the same
  place, so the boss is now met after a 30% heal. Nothing changed for a build
  that cannot reach it, and it is noticeably kinder to one that could: see
  the completion table below. No enemy, reward or healing number was retuned
  to offset it; that is a balance decision for its own pass.

The boss, `scrapheap_colossus`, is still tagged `temporary`. It was retuned for
V1 (ATK 190 → 170, DEF 120 → 110, HP 1500 → 1200) and not touched since. Note
that the boss is gated by Current SP at least as much as by gear: at SP 185 no
build beats it, including strong R / SR; at SP 240 strong R / SR wins 93% of
the time; at SP 300 mid-roll R wins 98%.

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

**Generation (5,000 seeds):**

| | |
| --- | --- |
| Invalid | 0 |
| Nodes per run | 7.50 average (6–9); depths 5–9, 7.20 average |
| Rests per run | one in 17.4%, two in 82.6% |
| Rest immediately before the boss | **100%** |
| Extraction points per run | one in 7.3%, two in 91.6%, three in 1.1% |
| First main-path extraction | depth 3 (46%) or 4 (54%) |
| Runs with a branch | 29.6% |

**Completion and reach, `aggressive` (5,000 runs per cell):**

| Current SP | Build | Completion: deterministic → variance pass → Rest → Boss | First-extraction reach | Avg depth |
| --- | --- | --- | --- | --- |
| 185 | Starter | 0% → 0% → 0% | 30% → **84%** | 5.1 |
| 185 | Improved N | 0% → 0% → 0% | 100% | 6.1 |
| 185 | R | 0% → 0% → 0% | 100% | 6.3 |
| 185 | Strong R / SR | 0% → 0% → 0% | 100% | 7.0 |
| 240 | Strong R / SR | 60% → 57% → **93%** | 100% | 7.2 |
| 300 | Starter | 0% → 0% → 0% | 100% | 6.3 |
| 300 | Improved N | 32% → 14% → **39%** | 100% | 7.2 |
| 300 | R | 88% → 79% → **98%** | 100% | 7.2 |
| 300 | Strong R / SR | 100% → 100% → 100% | 100% | 7.2 |
| 450 | Starter | 33% → 30% → **74%** | 100% | 7.2 |
| 450 | Improved N and up | 100% → 100% → 100% | 100% | 7.2 |

The third figure is the current zone. The jump in the bold cells is the rest
before the boss: a build that used to arrive at the Colossus worn down now
arrives 30% healthier. The starter's first-extraction reach (84%) and every
SP 185 completion (0%) are unchanged — the early game was not touched.

**Extraction as a decision (current zone):**

| SP · build | Strategy | Complete | Extract | Defeated | Banked / run | Gear / run |
| --- | --- | --- | --- | --- | --- | --- |
| 185 · Starter | aggressive | 0% | 0% | 100% | 0.9 | 0.12 |
| | cautious | 0% | 6% | 94% | 1.1 | 0.12 |
| | conservative | 0% | 35% | 65% | 2.0 | 0.10 |
| | first_exit | 0% | 84% | 16% | 3.2 | 0.08 |
| 185 · Improved N | aggressive | 0% | 0% | 100% | 1.3 | 0.14 |
| | cautious | 0% | 11% | 89% | 1.8 | 0.14 |
| | conservative | 0% | 30% | 70% | 2.9 | 0.13 |
| 185 · Strong R / SR | aggressive | 0% | 0% | 100% | 1.7 | 0.17 |
| | conservative | 0% | 21% | 79% | 3.7 | 0.17 |
| 300 · Improved N | aggressive | 39% | 0% | 61% | 13.0 | 0.36 |
| | conservative | 39% | 15% | 45% | 14.6 | 0.36 |
| 300 · R | aggressive | 98% | 0% | 2% | 30.9 | 0.67 |
| | conservative | 96% | 4% | 0% | 30.7 | 0.66 |

- Extraction still pays for a build that cannot finish: leaving banks 2–4× what
  dying does.
- The later way out is now a rest, so an HP-threshold player is healed past
  their threshold exactly where they would have left. The thresholds fire less
  than they did when it was a bare exit (SP 185 strong R / SR, conservative:
  29% → 21% extracted). The decision is still there; these simple policies
  just model it worse. A player who knows they cannot beat the boss should
  leave at that rest whatever their HP.
- The 50% threshold barely fires for a starter for the same reason at the
  early rest. `first_exit` is the honest measure of what the shallow loop pays.

**Per daily allowance (3 runs; current zone):**

| SP · build | Strategy | Currency / day | Gear / day |
| --- | --- | --- | --- |
| 185 · Starter | first_exit | 9.7 | 0.24 |
| 185 · Starter | aggressive | 2.6 | 0.37 |
| 185 · Improved N | conservative | 8.7 | 0.40 |
| 185 · R | conservative | 6.9 | 0.42 |
| 185 · Strong R / SR | conservative | 11.0 | 0.50 |
| 240 · Strong R / SR | aggressive | 87.4 | 1.93 |
| 300 · Improved N | conservative | 43.8 | 1.09 |
| 300 · R | aggressive | 92.6 | 2.01 |
| 300 · Strong R / SR and above | aggressive | 94.5 | 2.04 |

- A build that completes every run banks about **31.5 currency and 0.68 pieces
  of gear per run**, so the cap keeps the ceiling at about **95 currency and 2
  pieces of gear a day** — roughly one SR every 11 days.
- The ceiling did not move. What moved is how many builds reach it: mid builds
  at SP 240–300 now earn most of it.
- A new player banks about 10 a day.
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

**Layout mode needs no migration.** `layoutMode`, `authored` and
`generation.firstNodeType` default to procedural, no rooms and no fixed first
room, and are **left out of the content hash while they hold those defaults**.
So a zone that does not use them hashes exactly as it did before they existed:
no stored row looks edited, no shipped zone looks changed, and Scrapheap needs
no rewrite. (`tests/unit/dungeons/authoredLayout.test.ts` pins Scrapheap's
hash.)

**New fields and existing rows.** Region availability, rest rules, managed
artwork and the background pool live inside the zone document. A row written
before one of them still parses — `generation.rest` reads as "no rule",
`backgrounds` as empty, the asset ids as unset:

- A row still equal to what was last seeded (never edited in the Portal) is
  updated to the new shipped zone on the next start.
- A row **edited in the Portal is left alone**, as always, and simply has the
  defaults for the fields it predates.

### Region compatibility backfill

`availableRegions` is the one new field whose default is not harmless: missing
it reads as `[]`, which now means "nowhere". Left alone, a Portal-edited or
Portal-only zone stored before the field existed would drop off every player's
Delve list. So that one field gets a **one-time** compatibility value, without
weakening divergence protection:

1. **Migration `0053_dungeon_region_compat`** marks
   `dungeon_zones.region_compat = 'pending'` on every row whose stored document
   has no `availableRegions` key. Rows store the *parsed* zone, so any row a
   build that knows the field has written carries the key — an empty list
   included. Key absent therefore means, exactly, "written before the field
   existed".
2. **At startup, before the seed**, `backfillDungeonZoneRegions` resolves each
   `pending` row and adds **only that field**:

   | Row | Gets | `region_compat` |
   | --- | --- | --- |
   | a shipped zone (untouched or edited) whose shipped copy names regions | the shipped zone's regions — Scrapheap Gauntlet → `flaccid-foothills` | `shipped` |
   | a Portal-only zone, or one whose shipped copy names none | **every enabled region** — the old effective behaviour, with no thematic guess and never an unreleased region | `all_enabled_regions` |

   No history exists that records where a zone used to appear (it appeared
   everywhere), so there is nothing more specific to preserve.
3. Everything else in the document is untouched. `content_hash` is recomputed;
   an untouched shipped row's `seed_hash` follows it (it stays "shipped"), an
   edited row's `seed_hash` does not move (it stays "edited" and the seed still
   refuses to overwrite it). `revision` is bumped, so an editor opened before
   the restart cannot save over the result; `updated_by` / `updated_at` still
   name the last real author.
4. Each backfill is logged — `dungeon-zones/region-backfill`, at `info` for
   `shipped` and `warn` for `all_enabled_regions`, with the key, the regions
   and the row's origin. A marked row that cannot be parsed is logged
   (`dungeon-zones/region-backfill-failed`) and left marked.
5. A zone given `all_enabled_regions` shows **Review regions** in the zone
   list and a notice in its Availability section until an admin saves it,
   which clears the mark.

It cannot run twice: only `pending` rows are read, and nothing sets `pending`
after the migration. From then on the semantics are strict again —
`availableRegions: []` saved in the Portal is an explicit "nowhere" and is
never refilled, and an enabled zone with no region is still refused.

**Export** on the Dungeons page downloads every live zone in the file format.
Commit it over the shipped file and each server whose row matches adopts it.
There is no import and no "reset to shipped" yet.

After seeding, the server logs an error (`dungeon-zones/invalid`) for any
enabled zone that cannot generate on that server.

## Admin Portal

Permissions: `dungeons.read` (view, validate, preview, simulate, export) and
`dungeons.write` (create, edit, enable/disable, edit the currency, enemy
artwork). Picking or uploading managed artwork inside an editor additionally
needs `artwork.read` / `artwork.write`.

| Page | |
| --- | --- |
| `/admin/dungeons` | Every dungeon at a glance — a **Procedural** / **Authored** badge, where it is available, its size (`6–9 rooms` generated, `8 rooms` authored), its cover thumbnail, enabled state and shipped / edited status — with enable/disable, export, the Delve settings and the progression currency card. |
| `/admin/dungeons/new` | **Create dungeon** — the three-question wizard. |
| `/admin/dungeons/zones/:key` | The editor: shared basics, then the generator settings *or* the room editor, by layout mode. |
| `/admin/dungeons/preview` | **Preview dungeon** — a generated run per seed (and a 1,000-run simulation) for a procedural zone; the layout and a layout check for an authored one. |
| `/admin/dungeons/enemies` | Enemy Artwork — full artwork, sprite and default sprite placement per enemy, with a composed preview. |
| `/admin/artwork` | Artwork Assets — the library: browse all assets, replace, disable, delete safely, inspect references ([managed-artwork.md](managed-artwork.md)). Normal dungeon authoring should rarely need it. |

### Authoring principles

The editor is built around what an author is deciding, not around where a field
lives in the document. In practice:

- **Create first, configure after.** A dungeon exists after three answers;
  everything else is edited on something that already works.
- **Defaults do the work.** A room uses the dungeon's background, the enemy's
  own artwork and placement, the dungeon's reward for that kind of room, and
  the dungeon's rest heal, until the author asks for something different.
  "Use default" is the starting state, never a field to fill in.
- **Only what applies is shown.** A fight has no heal control; a rest has no
  enemy picker.
- **Artwork is chosen where it is used.** Every image field offers *Select…*,
  *Upload…* and *Clear* in place. Nobody types an asset id, and nobody has to
  know whether an image was uploaded or shipped.
- **Tuning is folded away, not removed.** Raw weights, depth bounds and
  generator rules live under *Advanced*, closed by default, opened
  automatically when a problem is inside.
- **Problems are sentences, shown where they are.** `Room "Repair Bay" points
  to a room that no longer exists.` — on that room's card.
- **Nothing saves behind the author's back.** Edits change a draft; **Save
  dungeon** writes it with the loaded revision; closing or reloading the tab
  with unsaved changes warns.

### Create dungeon

Name, **Available in** (one region; more can be ticked later), and **Layout**
(*Procedural* or *Build room-by-room* — neither preselected). The key is made
from the name and shown folded away; it can be overridden there and never
changed afterwards. **Create** saves a small working starter, **disabled**,
and opens the editor on it:

| Layout | Starter |
| --- | --- |
| Procedural | one combat pool, one boss, a Rest before the boss that is also the way out, default weights, 5–7 rooms |
| Room by room | Start → Combat → Rest (extraction) → Boss |

Both starters validate cleanly as created.

### The editor — shared

| Section | Holds |
| --- | --- |
| **Basics** | name, enabled, description, **Available in** (region checkboxes), tags. The daily run limit and the progression currency are global and live on the Dungeons page. |
| **Artwork** | **Zone cover** and **Default background**, each a preview with *Select…* / *Upload…* / *Clear*. When nothing is uploaded and a shipped image exists, that image is shown as what is in use. |
| *(layout-specific sections — below)* | |
| **Internal details** *(folded)* | the key, list order, shipped / edited status, the shipped artwork paths (path, *Browse…*, *Use convention*), and **Change layout…** |

### The editor — room by room

**Rooms** draws the layout as an outline walked from the start room: the trunk
at the left, each way of a fork indented under the room that offers it
(*Branch A*, *Branch B*…), and a `↳ continues to …` pointer where ways rejoin
a room, which is drawn once, back at the fork's level. Rooms nothing leads to
are listed last, marked *Not connected*. There is no canvas.

Each room card shows its type, name, what it holds (the enemy, the event, the
heal, the payout), a thumbnail of its background, *Start* / *Final room* /
*Extraction* badges, any problems with it, and:

| Action | Does |
| --- | --- |
| **Edit** | opens the room's editor inline |
| **Duplicate** | a copy slotted in right after it (a copied Boss becomes a Miniboss — only one room ends the dungeon) |
| **Delete** | removes it and closes the gap: whatever led to it now leads where it led |
| **Add next room** | a new room after it, taking over where it led (on the Boss: *Add room before*) |
| **Add branch** | another way on from it; the new room rejoins where the existing way leads next |

**+ Add room** at the bottom adds one just before the final room.

The room editor shows only what the type uses:

| Room | Controls |
| --- | --- |
| Combat / Elite / Miniboss / Boss | enemy · reward (dungeon default, or its own tables and currency range) · *Extraction after this fight* (not on the final room) · **Scene** |
| Rest | heal % (dungeon default, or its own) · extraction · label · background |
| Reward | reward table, Equipment reward table, currency range · extraction · background |
| Event | event · reward (when the event pays one) · extraction · background |
| Exit | what it does (a way out, or the final room) · label · background |

**Scene** starts as *Room background: the dungeon's default — Enemy artwork:
Use enemy default — Placement: Use enemy default*. **Override scene** reveals
the enemy sprite, full art and placement for this room only; **Use enemy
defaults** removes them. **Preview Scene** renders the room through the
production compositor from the unsaved draft.

*Connections & notes* (folded) holds the raw links for making paths rejoin
somewhere else — rooms that already lead to this one are not offered, so a
loop cannot be made there — plus *Make this the start room* and the notes.

Below the rooms: **Rest** (the default heal) and **Rewards & defaults**
(currency, defeat retention, completion and extraction bonuses, and the bands
that pay any room without a reward of its own).

### The editor — procedural

| | Basic (shown) | Advanced (folded) |
| --- | --- | --- |
| **Run length & branching** | min / max rooms, branch chance | min / max branches, max branch length |
| **Fixed rooms** | first room, ends on a Boss, always Rest before Boss — with a one-line summary of every run's shape | |
| **Pools** (combat, elite, miniboss, boss, event) | which enemies / events | per entry: weight, depth range, id, tags, enabled |
| **Rest & Recovery** | how much a Rest heals | minimum / maximum Rests, earliest / latest depth |
| **Extraction** | extraction depth, guaranteed points, a sentence describing the early / later ways out | which room types offer it, extraction windows |
| **Rewards** | currency, defeat retention, depth bands, bonuses | |
| **Backgrounds** | the background pool and a composed preview | how a scene is chosen (the precedence) |
| **Advanced generator rules** | | room type weights, depth ranges, "never twice in a row", guarantees and limits by type, same enemy in a row |

Every control that existed before still exists and saves the same document; a
procedural zone opened and saved without changes is written back exactly as it
was loaded. One convenience was added: the first entry put into an empty
elite, miniboss or event pool gives that room type a starting weight if it had
none, so adding an enemy is enough for it to appear.

Percentages are shown where the document stores basis points (branch chance,
defeat retention, rest healing). Enemies, events, reward tables, currencies and
regions are offered from the server rather than typed as keys.

### Inline artwork workflow

Every image field — zone cover, default background, a pool background, a
room's background, a room's enemy sprite and full art — is the same control:

1. **Upload…** opens the file picker;
2. the file is uploaded and validated, and an asset is created in the right
   category;
3. it is selected in the field straight away;
4. its preview is shown.

**Select…** opens the asset library filtered to that category; **Clear**
returns the field to what it inherits and says what that is. The author never
leaves the editor and never sees an asset id. The upload is immediate (the
asset exists in the library at once); *using* it is part of the draft and is
only saved with **Save dungeon**.

**Artwork picker.** The Portal's existing artwork browser
(`components/admin/ArtworkPicker`) is reused through its per-area source
mechanism: the dungeon routes expose `artwork`, `artwork/browse` and
`artwork/search` under `dungeons.read`, rooted by the server at `dungeons/` —
so the picker can list `dungeons/zones/` and `dungeons/backgrounds/` and
nothing else in the assets tree. It browses and selects **shipped** files only;
uploads are the managed-artwork fields beside it. The path can still be typed.
It reads `ASSETS_DIR` and nothing else — never the managed-upload store or the
scene cache. When `assets/dungeons/` does not exist (no dungeon art has been
committed yet) the browse route answers `200` with an empty listing and
`missing: true`, and the picker says *No shipped artwork exists under
dungeons/ yet*; a real failure reads *Could not load shipped artwork* with the
server's reason. The preview tells three states apart: no artwork
set, a path with no file behind it (saved anyway; screens fall back), and the
image.

### Validation

Every save is validated on the server, in the saving transaction, and the editor
runs the same checks as you type. Issues carry a path
(`pools.combat[2].enemyKey`, `authored.rooms[3].next`) that the editor uses to
place them — on the section, or on the room's card — and a message written for
the author. The path is never what is shown: a shape error reads
`Shortest run: …` or `Room "Repair Bay": …`, never `generation.minNodes`.

1. **Schema** — bounds, `minNodes ≤ maxNodes`, no negative weights, not every
   weight zero, depth ranges the right way round, unique pool entry and band
   ids, safe artwork paths (and no leading `assets/`), no duplicate region,
   rest minimum not above maximum.
2. **References** — every enemy, event, reward table, currency and region
   exists. Missing is an error; disabled (or an unreleased region) is a
   warning. An enabled zone names at least one region.
3. **Reachability** — an extraction depth past the end of a run, a depth range
   no node can fall in, a required type with nothing eligible, a final depth
   with no eligible boss, a limit below a requirement, and the
   [rest rules](#rest-rules) — above all whether a rest can sit before the
   boss in every run the zone can roll.
4. **Trial runs** — the real generator over 200 fixed seeds. Rules that are each
   plausible can still be jointly impossible; this is where that shows.

On an enabled zone a failed trial run is an error. On a disabled zone it is a
warning, so work in progress can be saved. Disabling always succeeds.

An **authored** zone skips 3 and 4 — there is no generator to reason about —
and is checked against [the layout rules](#the-authored-room-model) and each
room's references instead, with the same enabled-is-error, disabled-is-warning
split. Its pools and generator rules are not validated: they are not in use.

### Concurrency

Every zone and currency has a `revision`. A save sends the revision it loaded;
if someone saved first the server answers `409 DUNGEON_ZONE_STALE` with the
current revision and writes nothing. The editor then offers to reload.

### Preview

**Preview dungeon** adapts to the layout mode.

*Authored:* **Show layout** draws the compiled graph exactly as a run would
get it — room names, forks, the rejoin, each room's own reward and heal — with
a **Layout check** card listing the saved zone's problems (or saying there are
none). There is no seed field and no simulation: nothing is random, and no
generation metrics are invented for it.

*Procedural:* choose a zone and, optionally, a seed. Without one a seed is drawn and shown,
so the same run can be generated again. The preview shows the seed, every node
by depth with its type and its enemy or event, forks, the boss and the
extraction points. A zone that cannot generate shows the generator's reasons.

Above the graph, a structure summary says what *this* run did with the zone's
rules: the regions the zone is available in, its artwork path, the rest nodes
and their depths, the extraction points (and whether each is a rest or an
exit), the boss, and **Rest before Boss** — *guaranteed — satisfied*, *not
required*, or, in red, *guaranteed — NOT satisfied*. That last one is computed
by the server from the generated graph, not copied from the zone, so it would
show a generator bug rather than hide it. The same summary appears under
*Preview this draft* in the editor, for unsaved rules.

**Simulate** adds, over the whole sample: the share of runs with a rest
immediately before the boss, and how runs are spread by rest count and by
extraction-point count.

Nothing is persisted. No player run is created.

## Simulation

`simulateDungeonGeneration(zone, catalogue, { runs, firstSeed })` generates
seeds `firstSeed, firstSeed + 1, …` and reports node counts, node-type
distribution, branch rate, boss, rest and extraction occurrence, enemy and event
appearance rates, and the invalid-generation rate with reasons.

- Portal: **Simulate 1,000 runs** on the preview page (a live, procedural zone).
  An authored zone has no generation to simulate: the route answers `400`, and
  the page offers the layout check instead.
- CLI: `npm run dungeons:simulate -- --zone scrapheap_gauntlet --runs 5000`
  (the zone as shipped in Git; no database needed).

That is *generation* only. For how runs *play* — completion, defeat, currency
and gear — see [Balance simulation](#balance-simulation); the playtest builds
its graph through the same `buildDungeonGraph`, so
`npm run dungeons:playtest -- --zone service_tunnel_example` plays an authored
layout too.

## How to create a simple authored dungeon

1. **Dungeons → Create dungeon.** Type a name, choose where it is available,
   choose **Build room-by-room**, press **Create**. You land in the editor
   with four rooms: Start → Combat → Rest → Boss. It is switched off, so no
   player can see it.
2. **Set the two pictures** under *Artwork*: a **Zone cover** and a **Default
   background**. *Upload…* each one. Every room now has a background.
3. **Edit a room.** Press **Edit** on a card, pick its **Enemy**, give it a
   name if you like. Leave *Scene* and *Reward* alone — they already use the
   defaults.
4. **Make it longer.** **Add next room** on a card adds a room after it. Change
   the new room's **Room type** to what you want (Rest, Reward, Event…).
5. **Offer a choice.** **Add branch** on a room adds a second way on from it.
   The two ways rejoin by themselves at the next room.
6. **Give players a way out.** On a Rest (or any room), tick **Players may
   extract from this room**.
7. **Check a room's look.** Open a room and press **Preview Scene**.
8. **Save dungeon.** If something is wrong it is written on the room it is
   about, and Save waits until it is fixed.
9. **Preview dungeon** (top right) to see the whole layout, then tick
   **Enabled** and save when you want players in.

Only if you want to: give one room its own background, its own reward, a
different heal, or **Override scene** to change how its enemy looks there.

## How to create a simple procedural dungeon

1. **Dungeons → Create dungeon.** Type a name, choose where it is available,
   choose **Procedural**, press **Create**. You land in the editor with one
   combat pool, one boss, and a Rest before the boss. It is switched off.
2. **Set the two pictures** under *Artwork*: **Zone cover** and **Default
   background**.
3. **Choose who is fought.** In **Combat pool**, press **Add enemy** and pick
   one — repeat for as much variety as you want. Check the **Boss pool** names
   the boss you want.
4. **Set the length** under *Run length & branching*: the fewest and most
   rooms a run has, and how often the path forks.
5. **Check the fixed rooms**: *Ends on a Boss* and *Always Rest Before Boss*
   are on; **First room** can pin how every run opens.
6. **Optional variety.** Add entries to the Elite or Event pools and those
   rooms start appearing; add more images under *Backgrounds* and rooms start
   drawing them.
7. **Save dungeon**, then **Preview dungeon** → *Generate with a random seed*
   a few times to see what runs look like. *Simulate 1,000 runs* shows the
   spread.
8. Tick **Enabled** and save when you want players in.

You never need to open an *Advanced* section to do any of this. They are for
tuning afterwards: weights, depth limits, guarantees.

## API

All under `/api/v1/admin/dungeons`.

| Method | Path | |
| --- | --- | --- |
| GET | `/zones` | list |
| GET | `/zones/:key` | one zone, its revision and current issues |
| POST | `/zones` | create |
| PUT | `/zones/:key` | save (`expectedRevision`) |
| PUT | `/zones/:key/enabled` | enable/disable (`expectedRevision`) |
| GET | `/reference` | enemies, events, reward tables, currencies, regions |
| GET | `/artwork?path=` | bytes of one authored artwork path (404 when no file) |
| GET | `/artwork/browse?path=` | one folder under `dungeons/` for the picker |
| GET | `/artwork/search?q=` | search artwork under `dungeons/` |
| POST | `/validate` | dry run |
| POST | `/preview` | `{ key \| zone, seed? }` → one generated graph and its `structure` summary, including the background each node drew (`structure.scenes`) |
| POST | `/simulate` | `{ key \| zone, runs, firstSeed }` → report, with rest / extraction spread and the Rest → Boss rate |
| GET | `/export` | the file format |
| GET | `/settings` | Delve-wide settings: `dailyRunLimit` and its bounds |
| PUT | `/settings` | `{ dailyRunLimit }` — a whole number 0–50; `0` closes Delve to new runs |
| GET | `/currencies` | progression currencies |
| PUT | `/currencies/:key` | edit display metadata (`expectedRevision`) |
| GET | `/enemy-artwork` | every enemy's shipped and managed artwork |
| PUT | `/enemy-artwork/:key` | set an enemy's managed full artwork, sprite and placement (`expectedRevision`) |

Managed artwork itself is under `/api/v1/admin/artwork` — see
[managed-artwork.md](managed-artwork.md#api).

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
- tag-driven generation, editing events in the Portal, zone import and
  reset-to-shipped, a "global" availability option, per-region daily limits,
  structural rules beyond the three fixed rooms (first room, Rest → Boss,
  Boss), and delete protection on reward tables that a zone references;
- for authored dungeons: a drag-and-drop canvas, looping maps, more than one
  final room, more than three ways on from a room, room scripting, per-room
  shipped-path backgrounds in the Portal (the field exists; only uploads are
  offered), and a combat playtest in the Portal (the CLI playtest works);
- managed artwork for events, and promoting uploaded artwork between
  environments (per-room sprite and placement overrides exist for authored
  rooms; a procedural zone has none) — see
  [managed-artwork.md](managed-artwork.md#not-built-yet);
- an Admin view of a run and its history (the data is stored; nothing shows it).
