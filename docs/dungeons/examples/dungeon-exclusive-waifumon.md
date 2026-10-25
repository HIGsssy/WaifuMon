# Adding a dungeon-exclusive WaifuMon

[`dungeon-exclusive-waifumon.json`](dungeon-exclusive-waifumon.json) is a complete, valid
species file for a fictional SSR, **Forgotten Valkyrie**, who is never met in the wild.
Her JSON names **no dungeon**: any dungeon can offer her once an admin adds her to that
dungeon's pools or encounters and gives her terms in its **Species access**. Copy the
file, change the values, and follow [the workflow](#9-author-workflow) at the end of this
page.

> **You no longer preassign dungeon keys in JSON.** Leave `dungeonAccess` out. Which
> dungeons offer her, how often, and on what terms is decided in the Dungeon Editor
> and published with each dungeon. Adding her to a new dungeon needs no JSON edit and
> no redeploy. Older species that still carry `dungeonAccess` keep working
> ([§3, Legacy `dungeonAccess`](#legacy-dungeonaccess-in-species-json)).

The file was checked against the real schema, loader and dungeon policy code on `Delve`
(see [§8](#8-validation)). It is a sample only: it is **not** in `content/`, and no shipped
species is dungeon-exclusive yet.

Related reading: [Dungeon WaifuMon encounters and rescues](../dungeon-captures-guide.md)
(the Portal editor) and [Dungeon authoring reference](../dungeon-authoring-reference.md).

## 1. The species definition, field by field

A species file is a **JSON array** of species objects (`SpeciesFileSchema`). The
example holds one, so the file can be used as it is or its object pasted into an
existing array.

The schema is `SpeciesContentSchema` in
[`src/modules/content/schemas.ts`](../../../src/modules/content/schemas.ts).

> **The species object is not strict.** A misspelled top-level key (`dungeonacess`,
> `buddybonus`) is **silently dropped**, not rejected. Copy key names exactly. The
> nested objects (`card`, `appearances[]`, `buddyBonus`, legacy `dungeonAccess[]`) are strict,
> so a typo inside them fails the load.

| Field | Example | Required? | Notes |
| --- | --- | --- | --- |
| `slug` | `forgotten_valkyrie` | **Required** | Lowercase snake_case (`^[a-z0-9_]+$`). Must be unique across core content and every expansion, enabled or not. Names the artwork folder |
| `name` | `Forgotten Valkyrie` | **Required** | Display name |
| `rarity` | `SSR` | **Required** | `N`, `R`, `SR`, `SSR`, `UR`, `LR` or `EX`. Rarity sets the default capture rate and which charms can be used on her |
| `archetype` | `valkyrie` | **Required** | Free-form narrative role |
| `race` | `valkyrie` | Optional, **set it** | `angel`, `demon`, `demi-human`, `human`, `spirit`, `valkyrie` or `android`. Selects the card frame. If omitted, it is derived from `archetype`, which only works while the archetype is a race word |
| `contentRating` | `suggestive` | **Required** | `suggestive`, `mature` or `explicit` |
| `affinity` | `dominant` | Default `switch` | `dominant`, `submissive`, `caregiver`, `primal` or `switch`. Used in Buddy capture matchups |
| `description` | text | Default `""` | Shown in the encyclopedia and on cards |
| `tags` | `["dungeon_exclusive"]` | Default `[]` | See [§2](#2-the-dungeon_exclusive-tag). Only `dungeon_exclusive` and `region_exclusive` change behaviour; shipped species also carry informational tags such as `starter` or a region name |
| `baseCaptureRate` | `null` | Default `null` | `null` uses the rarity's base rate from `content/tables.json` → `capture.baseRatesByRarity` (SSR is `0.12`). A number in (0, 1] overrides it. Every shipped species uses `null` |
| `card` | subtitle, ability, quote | Optional | Card-face text only; no gameplay effect. `ability` needs both `name` (≤32) and `text` (≤160). Add `artist` only when the real credit is known |
| `imagePath` | `waifumon/forgotten_valkyrie/standard.png` | **Required** | Relative to `ASSETS_DIR`. The loader's last-resort check that default artwork exists. Every shipped species uses this exact pattern |
| `enabled` | `true` | Default `true` | See [§9](#keeping-her-unavailable-until-release) before setting this |
| `eventKey` | `null` | Default `null` | Not read by any gameplay code; it is only passed through to the content API, the Admin Gallery and the legacy admin panel. Leave `null` |
| `perSpeciesWeight` | `1` | Default `1` | A hunting weight. She is never hunted, so it has no effect; `1` keeps the file consistent with others |
| `appearances` | `standard` + `level_10`…`level_50` | Optional | Exactly one entry must have `unlock.type: "owned"`. Only `owned` and `level` unlocks are implemented. See [§6](#6-artwork-preparation) |
| `buddyBonus` | `capture_chance` +12% vs `race: valkyrie` | Optional | The `effectId` must be one of the closed set in [`buddyBonusEffects.ts`](../../../src/modules/buddyBonus/buddyBonusEffects.ts). Whether a `target` is required, and which types are allowed, depends on the effect. `flavorText` follows the `"<Name>: +N% …"` convention |
| `spriteFacing` | *(omitted)* | Optional | `left` or `right`, only if her dungeon sprite clearly faces one way |
| `dungeonAccess` | *(omitted)* | Optional, **legacy: leave it out** | Older per-species dungeon authorization. Still honoured, but new species are configured in each dungeon's Species access instead ([§3](#3-acquisition-configurations)) |

Capture rules for a particular encounter — attempt limit, permitted charms, guaranteed
items — are set on the dungeon activity in the editor, **not** on the species. Her
`rarity` decides which charms are eligible. A publish is refused
(`capture_no_usable_item`) if a capture encounter has no enabled charm usable on her.

The Buddy bonus applies when a player has her equipped as Buddy. In a dungeon the
Buddy is pinned at run start, so a capture bonus in a run comes from the Buddy
the player started with.

## 2. The `dungeon_exclusive` tag

`tags: ["dungeon_exclusive"]` means she is **never met in the wild**. It does **not** tie
her to one dungeon. She can be offered only by a dungeon whose **published** revision
both presents her (in a WaifuMon pool its encounters use, or as a specific WaifuMon)
and gives her terms in its **Species access**. Species no published dungeon offers stay
unobtainable.

- **Hunting:** every tier of the hunt draw excludes her: region pools, the default-region
  fallback, the global fallback and the emergency draw (`huntService.ts`,
  `notDungeonExclusive`).
- **Scripted spawns:** World Encounter or quest spawns that name her spawn nothing
  (`wildEncounterSpawner.ts`). A picker that somehow returned her is refused as a last
  check.
- **Filtered selectors:** World Encounter random-species selectors never include her
  (`speciesSelection.ts`).
- **Region pools:**
  - Content loading fails if any region file's `encounterPool` lists her, **including a
    disabled region**, since a disabled region is one flag away from live.
  - The Portal Region Pools editor refuses her (`species_dungeon_exclusive`, a blocking
    error). Its species picker lists her but does not let you select her.
- **Not allowed together:** `dungeon_exclusive` and `region_exclusive` on one species fail
  the load.

So: **never add her to any region's `encounterPool`**, in `content/regions/*.json` or in
an expansion's `region.json`, and never add her through Admin → Region Pools.

## 3. Acquisition configurations

Her terms belong to each dungeon, not to her JSON. In the Dungeon Editor, open
**Dungeon settings → WaifuMon Pools → Edit Species access** (or **Species access…** on
a pool entry or a specific-species encounter). There is **one entry per species per
dungeon**, however many pools and encounters in that dungeon present her. Each entry
has:

| Control in the editor | Meaning |
| --- | --- |
| **Maximum acquisitions per player from this dungeon**: *Limited to N* or *Unlimited captures* | Successful captures and rescues of her by one player from this dungeon, across all runs. Required: adding an entry starts at *Limited to 1* |
| **Allow Direct Rescue** | Lets a Direct Rescue grant her with no charm and no roll. Only available with a finite limit |

The same species can have different terms in different dungeons. Each dungeon keeps its
own count.

The entry is stored in the dungeon definition as `speciesPolicies`, which is what you
see in an exported package:

```json
"speciesPolicies": [
  { "species": "forgotten_valkyrie", "perPlayerLimit": 1, "directRescue": true }
]
```

### A. Limited dungeon capture

*Limited to 1*, Direct Rescue off. She can be obtained through a **Wild Encounter** or a
**capture-mode Rescue** (uses a charm), at most once per player from this dungeon. After
a player's first successful acquisition here, every later offer of her in this dungeon
resolves **Unavailable** for that player (`player_limit`). Her draw weight is not
redistributed to other species.

### B. Unlimited dungeon capture

*Unlimited captures*. She can be captured again and again across runs. Direct Rescue
cannot be allowed with this setting.

### C. Direct rescue

*Limited to N* with **Allow Direct Rescue** ticked. A **Direct rescue** activity grants her
outright. The same entry also permits Wild Encounters and capture-mode Rescues, which
share the same limit.

Direct rescue needs all three conditions:

1. **A Species access entry for her in this dungeon** (or a legacy `dungeonAccess` entry
   naming it).
2. **Allow Direct Rescue.** A direct rescue hands out a copy with no charm spent and no
   roll, so it is opted into separately from capture. Without it, publication is refused
   (`rescue_direct_not_permitted`).
3. **A finite limit.** A free grant with no limit would let a player farm copies run after
   run. Allowing Direct Rescue with no finite limit is refused at validation, publish and
   runtime (`rescue_direct_limit_missing` / `direct_limit_missing`).

A dungeon may contain at most three direct-rescue activities. An ungated direct rescue
produces a validation warning; use **Only happens if** to gate it behind a flag or a
completed room.

### Limits across runs vs within one run

These are two different controls:

| Control | Where | Scope |
| --- | --- | --- |
| **Maximum acquisitions per player from this dungeon** (`perPlayerLimit`) | The dungeon's **Species access** | **Across runs.** Successful acquisitions by this player of this species from this dungeon, over all time, through any pool or encounter |
| **At most once per run…** (`oncePerRun`, on by default) | A species entry in a dungeon **WaifuMon pool** | **Within one run.** After she has been *presented* anywhere in the run, that entry drops out of later draws in the same run. It does not need a capture and is not a per-player limit |
| **Weight** | A species entry in a dungeon **WaifuMon pool** | **Selection odds** within that pool, relative to the other entries. Never a limit |

With a limit of 1 and **At most once per run** on, a player meets her at most once per run
and can own at most one copy from this dungeon. If a run offers her and the player
fails or leaves, a later run can offer her again until she is acquired.

### What the acquisition count is, and is not

- **Scope:** player + species + dungeon. The count lives in the
  `dungeon_species_acquisitions` ledger, one row per successful capture,
  capture-mode rescue or direct rescue.
- **Not a global cap:** limit 1 in `forgotten_temple` and limit 1 in another dungeon
  allows one copy from each.
- **Not the collection:** copies from hunting or other dungeons don't count, and the
  number currently owned doesn't matter.
- **Releasing or converting a copy does not reset it.** Release only marks the copy
  released, and the ledger row stays (the foreign key does not cascade). A player
  who released their Forgotten Valkyrie cannot get another from `forgotten_temple`
  while the limit is 1.
- **One count per dungeon.** Several pools, a specific-species encounter and a later
  revision of the same dungeon all draw on the same count.

### When changes take effect

- **Draft edits change nothing live.** Validation judges the draft's own Species access;
  players are judged by the dungeon's **currently published** revision.
- **Publishing** new terms applies them to new offers and grants at once, **including runs
  already in progress**. A run keeps its pinned rooms and pools, but its next offer or
  capture is judged by the published terms. Tightening a limit, or withdrawing her, is
  never bypassed by a run that started earlier; the encounter resolves **Unavailable**
  with no charm spent.
- **Rollback** restores the terms of the revision rolled back to.
- **History is never reset.** Lowering a limit counts acquisitions already recorded: a
  player who has two copies from a dungeon whose limit becomes 1 gets no more.
- **Disabling** a dungeon keeps its published terms for runs already in progress.
- **Packages** carry `speciesPolicies` inside the dungeon definition. An imported
  dungeon's terms apply only once an admin publishes it. Species JSON (including legacy
  `dungeonAccess`) is never imported.

### Legacy `dungeonAccess` in species JSON

Older species may carry `dungeonAccess` entries naming dungeon keys. They still work:

- A `dungeonAccess` entry naming a dungeon admits her to that dungeon even without a
  Species access entry, on the entry's terms (omitted `perPlayerLimit` = unlimited).
- If **both** exist for the same dungeon, the **stricter** of each term applies: the lower
  finite limit, and Direct Rescue only if both allow it. Neither can loosen the other.
  Validation warns (`species_policy_content_overlap`) and states the combined terms.
- **`region_exclusive` species** can still be admitted to a dungeon **only** by
  `dungeonAccess` in their JSON. A Species access entry alone is refused
  (`species_policy_region_exclusive`); it can only tighten the terms JSON grants.
- Untagged species need no entry at all. An entry can still give one a limit or allow
  Direct Rescue in that dungeon.

New species should omit `dungeonAccess`.

## 4. Where the definition goes

The loader reads species from two places
([`src/modules/content/loader.ts`](../../../src/modules/content/loader.ts)):

1. **Core:** every `*.json` file in `content/species/`, in sorted order. Today that's
   only `starter.json`.
2. **Expansions:** every `*.json` in `content/expansions/<pack>/species/`, for packs
   whose `expansion.json` has `"enabled": true`.

There is no central catalogue file that must list every species, and nothing else
needs registering. Species slugs must be unique across all of these, including
disabled packs.

**Recommended placement:** a new core file, for example

```
content/species/dungeon_exclusives.json
```

containing the array from the example, with more dungeon-exclusive species appended
over time. This was validated alongside all shipped content ([§8](#8-validation)).

Alternatives the loader also supports:

- **Append to `content/species/starter.json`.** Valid, but it mixes her with the
  hunted starter roster.
- **Put her in an existing expansion's species file.** Valid. She belongs to that pack
  and disappears if the pack is ever disabled. The existing expansion files hold
  region-exclusive residents of their region, so this is a poor fit.
- **A new expansion pack** (`content/expansions/<pack>/expansion.json` +
  `species/*.json`, with `"regionId": null`) only makes sense if you need a whole
  bundle you can switch on and off. While the pack is disabled, its species are not
  loaded and cannot be used by any dungeon.

Don't touch `content/regions/*.json` or any `region.json` for her (see [§2](#2-the-dungeon_exclusive-tag)).

## 5. How she reaches the Dungeon Editor

1. At startup, and on a content reload, the loader validates her. The seeder then
   writes her row into the `species` table: `enabled`, `tags`, rarity and the rest.
2. In any dungeon, **+ Add species** (in a WaifuMon pool) or **Choose WaifuMon** (for a
   specific species) lists her with the label *Needs Species access in this dungeon
   before it can be offered*. Her button reads **Add to pool and set access** (or
   **Select WaifuMon and set access**).
3. After adding her, use **Species access…** on her pool entry or encounter (or **Edit
   Species access** under WaifuMon Pools). Choose **Add Species access**, then set her
   limit and Direct Rescue. Her labels change to *Permitted by this dungeon's Species
   access*.
4. Validate and publish re-check her enabled state and these terms.

Region-exclusive and disabled species are listed but cannot be selected.

## 6. Artwork preparation

Artwork lives under `ASSETS_DIR` (default `./assets`):

```
assets/waifumon/forgotten_valkyrie/
  standard.png                  ← master you provide (required)
  level_10.png … level_50.png   ← optional milestone masters
  forgotten_valkyrie_sprite.webp ← optional dungeon sprite you provide (WebP only)
```

**Inputs:**

- **PNG masters:** `waifumon/<slug>/<appearance id>.png`, one per appearance. The
  file name is the appearance `id` (`standard`, `level_10`, …). `standard.png` is the
  default look and must match `imagePath`. Other PNGs in the folder (backups, working
  files) are ignored by the build.
- **Dungeon sprite (optional):** `waifumon/<slug>/<slug>_sprite.webp`, a cut-out used
  when she is your Buddy in Delve fight scenes. It is placed bottom-left at 80% of
  scene height, at most 40% of scene width. Encounter scenes use it as the offered
  character when present, otherwise her standard artwork. **No npm script produces
  it**: author it as WebP by hand. If it faces a clear direction, set `spriteFacing`.

### npm scripts

All of these take `--content <dir>` and `--assets <dir>`, defaulting to `$CONTENT_DIR`
/ `./content` and `$ASSETS_DIR` / `./assets`.

| Command | What it does | Changes content files? |
| --- | --- | --- |
| `npm run appearances:sync` | Adds a missing appearance entry (`standard`, `level_10` … `level_50`) to a species **only when** its artwork already exists as `waifumon/<slug>/<id>.webp` or `.png`. Never edits or reorders existing entries; skips levels above `tables.json`'s max level. `-- --dry-run` reports only | **Yes**: writes the species JSON files (core and enabled packs). Reflows a file not in `JSON.stringify(_, null, 2)` format; the example file is already in that format |
| `npm run artwork:build -- --species forgotten_valkyrie` | For each runtime master of that species: full-size WebP (q90, native size) beside the PNG, plus 256/512/1024-wide renditions (q80). Updates `assets/.artwork-manifest.json`. Also `--asset forgotten_valkyrie/standard`, `--all`, `--only full\|thumbnails`, `--force`, `--dry-run`, `--check`, `--verbose`. A selection is required | No (writes assets only) |
| `npm run artwork:check` | `--all --only full --check`: exits 1 if any committed runtime WebP is stale or missing | No |
| `npm run assets:thumbs` | `--all --only thumbnails`: renditions only, no runtime switch | No |
| `npm run content:prepare` | `appearances:sync`, then `artwork:build -- --all` | **Yes** (via `appearances:sync`) |

Only masters the species content names are built. Add the JSON first, then run
`artwork:build`; a PNG for a species not in content is reported as ignored.

**Outputs** for `standard.png` (observed by running the build on scratch copies of
`content/` and `assets/`):

```
assets/waifumon/forgotten_valkyrie/standard.webp
assets/.thumbnails/256/waifumon/forgotten_valkyrie/standard.webp
assets/.thumbnails/512/waifumon/forgotten_valkyrie/standard.webp
assets/.thumbnails/1024/waifumon/forgotten_valkyrie/standard.webp
assets/.artwork-manifest.json   (updated)
```

and the same for each `level_NN.png`. Once `standard.webp` exists, the runtime serves it
in preference to the PNG.

**Appearances vs artwork.** The example lists all six appearances. If a non-default
appearance has no artwork, the loader **drops that appearance with a warning** on
every start; the species stays enabled. If you only have `standard.png` so far, author
only the `standard` entry. Then run `npm run appearances:sync` as each `level_NN.png`
arrives, and it adds the matching entry.

**Missing default art disables her.** If no default artwork resolves (owned
appearance, then `standard`, then `imagePath`), the loader sets `enabled: false` with a
warning. Every dungeon offering her then fails to publish (`species_disabled`). Deploy
the artwork together with the JSON.

**Verifying artwork:**

1. `npm run artwork:build -- --species forgotten_valkyrie --check` exits 0 when every
   output is current, and 1 if anything is stale or missing.
2. Check that the files above exist.
3. Run the content test ([§8](#8-validation)): it fails if any species was disabled for
   missing art.
4. After deploying: her standard art appears in **Admin → Waifumon Gallery**
   (`gallery.read`) and as a thumbnail in the Dungeon Editor picker. Use the editor's
   encounter preview to check the scene.

## 7. Keeping her out of hunting: checklist

- [ ] `tags` contains `dungeon_exclusive` and **not** `region_exclusive`.
- [ ] She is in no `encounterPool` in `content/regions/` or any `content/expansions/*/region.json`.
- [ ] She is not added in Admin → Region Pools. The editor refuses it anyway.
- [ ] Her JSON has no `dungeonAccess`; each dungeon that offers her has a Species access entry for her.

## 8. Validation

**Dungeon-owned Species access** is covered by:

```
TEST_DATABASE_URL=postgres://… npx vitest run \
  tests/unit/dungeons/dungeonSpeciesTerms.test.ts \
  tests/integration/dungeonOwnedSpeciesAccess.test.ts
```

These cover: the example species with empty `dungeonAccess`, publishing with and
without her Species access entry, capture from a newly configured pool, specific-species
Wild Encounters and capture-mode Rescues, Direct Rescue with and without permission and
with an unlimited limit, independent limits in two dungeons, one shared count across
pools, encounters, revisions and release, drafts not affecting live terms, rollback,
export/import, legacy `dungeonAccess` combined on the stricter terms, runs in progress
after a publish tightens or withdraws her, and her exclusion from hunting. The Portal
workflow is covered in
`portal/src/features/adminDungeons/__tests__/DungeonSpeciesPools.test.tsx`.

The species file itself was validated earlier on `Delve` at `488c6e0` (with a
`dungeonAccess` entry, since removed from the example):

1. **Schema:** `SpeciesFileSchema` parses it. Every top-level key is a real schema key;
   this is checked explicitly because unknown keys would be dropped silently.
2. **Loading with all shipped content:** with the file copied into a **temporary copy**
   of `content/` as `species/dungeon_exclusives.json`, `readContentFiles` and
   `validateContentSet` pass, and no shipped region pool lists her.
3. **Artwork pre-flight:** `loadContent` keeps her enabled when
   `waifumon/forgotten_valkyrie/standard.png` exists, and disables her when it doesn't.
4. **Region pools:** adding her to a region `encounterPool` fails loading, whether the
   region is enabled or disabled. The Region Pools validator returns
   `species_dungeon_exclusive` as an error.

`dungeonEncountersLive.test.ts` › *exclusive species stay out of the wild* proves that
no hunt tier reaches a dungeon-exclusive species and that a scripted spawn cannot
name her. The artwork commands in [§6](#6-artwork-preparation) were run against
scratch copies.

**When you add a real species**, run:

```
npx vitest run tests/unit/content.test.ts tests/unit/regionContent.test.ts
```

`content.test.ts` › *loads and validates, with every referenced image present* loads
the real `content/` and `assets/`, and fails if any species was disabled for missing
art. Vitest's global setup needs `TEST_DATABASE_URL` even for these unit tests.
Starting the bot (`npm run dev`) runs the same loader and refuses to start on a content
error.

## 9. Author workflow

1. **Create the catalogue entry.** Copy the example into
   `content/species/dungeon_exclusives.json` (a JSON array; create it if needed). Change
   `slug`, `name`, `rarity`, `race`, `archetype`, `affinity`, `description`, `card` and
   `buddyBonus`. Set `imagePath` to `waifumon/<slug>/standard.png`.
2. **Tag it, assign no dungeon.** Keep `"enabled": true` and `"tags": ["dungeon_exclusive"]`.
   Leave `dungeonAccess` out. Don't add her to any region pool.
3. **Prepare artwork.** Put `standard.png` (and any `level_NN.png`) in
   `assets/waifumon/<slug>/`. Run `npm run artwork:build -- --species <slug>`, and
   `npm run appearances:sync` if you add milestone art later. Optionally add
   `<slug>_sprite.webp`. Validate with `npx vitest run tests/unit/content.test.ts
   tests/unit/regionContent.test.ts` and `npm run artwork:build -- --species <slug> --check`.
4. **Deploy** the species JSON and the artwork together (built WebPs, `.thumbnails/`
   and `.artwork-manifest.json`). This is the only deploy she needs: every dungeon
   that later offers her is configured in the Portal.
5. **Create or open a dungeon** in the Admin Portal's Dungeon Editor.
6. **Create a WaifuMon pool:** Dungeon settings → **WaifuMon Pools** →
   **+ New WaifuMon pool**.
7. **Add her** with **+ Add species** → **Add to pool and set access**. Set her **Weight**,
   and keep **At most once per run** on unless she may repeat within a run.
8. **Configure her Species access:** **Species access…** on her entry →
   **Add Species access** → set **Maximum acquisitions per player from this dungeon**
   (*Limited to N* or *Unlimited captures*) and, if a Direct Rescue will grant her,
   **Allow Direct Rescue** (needs a finite limit).
9. **Use the pool**, or pick her directly with **Specific WaifuMon**, in:
   - a **Wild Encounter**, or a **Rescue** in **Capture rescue** mode, with capture
     rules whose charms can be used at her rarity; or
   - a **Rescue** in **Direct rescue** mode ([§3 C](#c-direct-rescue)). Gate it with
     **Only happens if**.
10. **Validate and publish** the dungeon. Fix any `species_*`, `rescue_direct_*` or
    `capture_no_usable_item` issues; **Show me** opens Species access for access problems.

To offer her in another dungeon, repeat steps 5–10 there. Each dungeon has its own
terms and its own count.

### Keeping her unavailable until release

Players can only obtain her through a **published, enabled** dungeon whose published
Species access includes her and whose encounters present her. Hunting, spawns and
selectors never offer her. Until release, she cannot be acquired if every dungeon that
includes her is **unpublished or disabled**, or no published dungeon includes her yet.

`enabled: true` alone does **not** hide her completely. The player Portal
encyclopedia lists every enabled loaded species, including dungeon-exclusive ones,
as an entry players haven't discovered. Her artwork is not served to a player who
doesn't own her. If she must not be visible at all before release:

- Ship her with `"enabled": false`. She is hidden from the encyclopedia, cannot be
  offered, and **cannot be selected** in the Dungeon Editor (*disabled*). A dungeon
  that offers her cannot be published until she is enabled.
- So build and test the dungeon on **staging** with her enabled. In production, keep
  her disabled, or hold back her content, until the release deploy turns her on. Then
  publish or import the dungeon.

## 10. Limitations

- **No Portal species management.** Species content is JSON shipped with the build;
  changing `enabled`, tags or artwork needs a deploy or content reload. Which dungeons
  offer her, and on what terms, does not.
- **Legacy `dungeonAccess.dungeon` is not checked against real dungeons.** A typo
  silently authorizes the wrong key. Prefer Species access.
- **The species object isn't strict**, so misspelled top-level keys vanish without
  an error.
- **No global cap.** Limits are per dungeon; the same species with limit 1 in two
  dungeons can be acquired twice.
- **The dungeon sprite is manual.** No npm script creates or checks
  `<slug>_sprite.webp`.
