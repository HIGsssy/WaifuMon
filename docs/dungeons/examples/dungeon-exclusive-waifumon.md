# Adding a dungeon-exclusive WaifuMon

[`dungeon-exclusive-waifumon.json`](dungeon-exclusive-waifumon.json) is a complete, valid
species file for a fictional SSR, **Forgotten Valkyrie**, who can only be met in the
fictional dungeon `forgotten_temple`. Copy it, change the values, and follow
[the workflow](#9-author-workflow) at the end of this page.

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
> nested objects (`card`, `appearances[]`, `buddyBonus`, `dungeonAccess[]`) are strict,
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
| `dungeonAccess` | see below | Optional, **needed here** | Which dungeons may offer her, and on what terms ([§3](#3-acquisition-configurations)) |

Capture rules for a particular encounter — attempt limit, permitted charms, guaranteed
items — are set on the dungeon activity in the editor, **not** on the species. Her
`rarity` decides which charms are eligible. A publish is refused
(`capture_no_usable_item`) if a capture encounter has no enabled charm usable on her.

The Buddy bonus applies when a player has her equipped as Buddy. In a dungeon the
Buddy is pinned at run start, so a capture bonus in a run comes from the Buddy
the player started with.

## 2. The `dungeon_exclusive` tag

`tags: ["dungeon_exclusive"]` means she is **never met in the wild** and may be offered
**only** by the dungeons listed in her `dungeonAccess`.

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

`dungeonAccess` is an array of entries:

```json
{ "dungeon": "<dungeon key>", "perPlayerLimit": <positive whole number> | "unlimited", "directRescue": true | false }
```

- `dungeon` must be the dungeon's **stable key** exactly (lower snake_case, ≤64 chars,
  e.g. `forgotten_temple`), not its display name. Nothing checks that the dungeon
  exists. A typo silently authorizes a dungeon that doesn't exist, and the real one
  shows her as *Not permitted in this dungeon*.
- Each dungeon may appear **once** per species; a duplicate fails the load.
- To authorize several dungeons, add one entry per dungeon. Each has its own limit and
  its own count.

### A. Limited dungeon capture

Obtainable through a **Wild Encounter** or a **capture-mode Rescue** (uses a charm), at
most once per player from this dungeon:

```json
"dungeonAccess": [
  { "dungeon": "forgotten_temple", "perPlayerLimit": 1 }
]
```

After a player's first successful acquisition from `forgotten_temple`, every later
offer of her there resolves **Unavailable** for that player (`player_limit`). Her draw
weight is not redistributed to other species.

### B. Unlimited dungeon capture

Obtainable again and again across runs:

```json
"dungeonAccess": [
  { "dungeon": "forgotten_temple", "perPlayerLimit": "unlimited" }
]
```

Omitting `perPlayerLimit` also means unlimited capture: `{ "dungeon": "forgotten_temple" }`.
The explicit `"unlimited"` is clearer, and the editor labels the two differently.
Neither allows direct rescue.

### C. Direct rescue

Granted outright by a **Direct rescue** activity (no charm, no capture roll):

```json
"dungeonAccess": [
  { "dungeon": "forgotten_temple", "perPlayerLimit": 1, "directRescue": true }
]
```

This is the configuration in the example file. It also allows A: the same entry
permits Wild Encounters and capture-mode Rescues, which share the same limit.

Direct rescue needs all three conditions:

1. **An entry for this exact dungeon.** A dungeon-exclusive species can only be offered
   by a listed dungeon. Even an untagged species needs an entry for direct rescue,
   because direct-rescue permission is per dungeon.
2. **`directRescue: true`.** A direct rescue hands out a copy with no charm spent and
   no roll. The content owner must opt in for each dungeon, separately from capture
   permission. Without it the editor reports *Direct rescue is not authorized*, and
   publication is refused (`rescue_direct_not_permitted`).
3. **A finite numeric `perPlayerLimit`.** A free grant with no limit would let a player
   farm copies run after run. `directRescue: true` with no limit, or with
   `"unlimited"`, **fails content loading**. If such a policy reached the database it
   would also be refused at publish and at runtime (`direct_limit_missing`).

A dungeon may contain at most three direct-rescue activities. An ungated direct rescue
produces a validation warning; use **Only happens if** to gate it behind a flag or a
completed room.

### Limits across runs vs within one run

These are two different controls:

| Control | Where | Scope |
| --- | --- | --- |
| `perPlayerLimit` | Species content (`dungeonAccess`) | **Across runs.** Successful acquisitions by this player of this species from this dungeon, over all time |
| **At most once per run…** (`oncePerRun`, on by default) | A species entry in a dungeon **WaifuMon pool**, in the editor | **Within one run.** After she has been *presented* anywhere in the run, that entry drops out of later draws in the same run. It does not need a capture and is not a per-player limit |

With `perPlayerLimit: 1` and `oncePerRun` on, a player meets her at most once per run
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
- **Live policy:** changing `perPlayerLimit` in content takes effect for new offers
  after the next deploy or content reload. Past acquisitions are kept.

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
2. `dungeonAccess` has no database column. Both dungeon services read it from the
   loaded content.
3. In the Dungeon Editor, **+ Add species** (in a WaifuMon pool, or **Choose WaifuMon**
   for a specific species) lists every species with labels for the dungeon being
   edited:
   - *Permitted here* only in `forgotten_temple`. In any other dungeon she is listed as
     *Not permitted in this dungeon* and cannot be selected.
   - Her limit, labelled *per player, in this dungeon, across runs*.
   - Whether direct rescue is authorized for this dungeon.
4. Validate and publish re-check her live policy and enabled state.

The dungeon's key must be exactly `forgotten_temple`. Packages and imports never carry
species authorization; it only comes from species content.

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
- [ ] `dungeonAccess` names the exact dungeon key or keys.

## 8. Validation

The example was validated on `Delve` at `488c6e0`:

1. **Schema:** `SpeciesFileSchema` parses it. Every top-level key is a real schema key;
   this is checked explicitly because unknown keys would be dropped silently.
2. **Loading with all shipped content:** with the file copied into a **temporary copy**
   of `content/` as `species/dungeon_exclusives.json`, `readContentFiles` and
   `validateContentSet` pass. `dungeonAccess` comes through intact, and no shipped
   region pool lists her.
3. **Artwork pre-flight:** `loadContent` keeps her enabled when
   `waifumon/forgotten_valkyrie/standard.png` exists, and disables her when it doesn't.
4. **Region pools:** adding her to a region `encounterPool` fails loading, whether the
   region is enabled or disabled. The Region Pools validator returns
   `species_dungeon_exclusive` as an error.
5. **Policy:** `forgotten_temple` is permitted for capture and direct rescue, any other
   dungeon is `not_permitted`, and after one acquisition both return `player_limit`.
   The documented variants behave as described: `"unlimited"` allows capture but not
   direct rescue, and direct rescue without a finite limit gives
   `direct_limit_missing`.
6. **Dungeon validation:** in a dungeon keyed `forgotten_temple`, a Wild Encounter, a
   capture-mode Rescue and a direct Rescue of her raise no species or rescue policy
   issues. The same dungeon under another key raises `species_not_permitted`.

Those checks ran as a temporary test (9/9 passed), which was then deleted. Nothing
under `content/` was modified. These existing suites cover the runtime exclusions and
also passed (217 tests including the temporary one):

```
TEST_DATABASE_URL=postgres://… npx vitest run \
  tests/unit/regionContent.test.ts \
  tests/unit/regionPools/regionPoolValidation.test.ts \
  tests/unit/regionPools/regionPoolDistribution.test.ts \
  tests/unit/dungeons/dungeonEncounters.test.ts \
  tests/integration/dungeonEncountersLive.test.ts
```

`dungeonEncountersLive.test.ts` › *exclusive species stay out of the wild* proves that
no hunt tier reaches a dungeon-exclusive species and that a scripted spawn cannot
name her. The artwork commands in [§6](#6-artwork-preparation) were also run against
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

1. **Copy and customize.** Copy the example. Change `slug`, `name`, `rarity`, `race`,
   `archetype`, `affinity`, `description`, `card` and `buddyBonus`. Set `imagePath` to
   `waifumon/<slug>/standard.png`. Pick the `dungeonAccess` configuration from
   [§3](#3-acquisition-configurations), using the real dungeon key.
2. **Place it.** Add it to `content/species/dungeon_exclusives.json`, creating the file
   as a JSON array if needed. Don't add her to any region pool.
3. **Prepare artwork.** Put `standard.png` (and any `level_NN.png`) in
   `assets/waifumon/<slug>/`. Run `npm run artwork:build -- --species <slug>`, and
   `npm run appearances:sync` if you add milestone art later. Optionally add
   `<slug>_sprite.webp`.
4. **Validate.** Run `npx vitest run tests/unit/content.test.ts
   tests/unit/regionContent.test.ts` and
   `npm run artwork:build -- --species <slug> --check`.
5. **Deploy** the species JSON and the artwork together (built WebPs, `.thumbnails/`
   and `.artwork-manifest.json`). Species content has no Portal editor, so it ships
   with the build.
6. **Open the Dungeon Editor** in the Admin Portal and open the dungeon whose key is in
   her `dungeonAccess`.
7. **Create or edit a WaifuMon pool:** Dungeon settings → **WaifuMon Pools** →
   **+ New WaifuMon pool**.
8. **Add the species** with **+ Add species**. Filter by availability: she should show
   as permitted, with her limit and direct-rescue status. Set a weight, and keep
   **At most once per run** on unless you want her to repeat within a run.
9. **Attach the pool**, or pick her directly with **Specific WaifuMon**:
   - a **Wild Encounter** (capture) or a **Rescue** in **Capture rescue** mode, with
     capture rules whose charms can be used at her rarity; or
   - a **Rescue** in **Direct rescue** mode, which needs the configuration in
     [§3 C](#c-direct-rescue). Gate it with **Only happens if**.
10. **Validate and publish** the dungeon. Fix any `species_*`, `rescue_direct_*` or
    `capture_no_usable_item` issues.

### Keeping her unavailable until release

Players can only obtain her through a **published, enabled** dungeon whose key is in
her `dungeonAccess`. Hunting, spawns and selectors never offer her. Until the dungeon is
released, she cannot be acquired if you:

- leave the `forgotten_temple` dungeon **unpublished or disabled**, or
- don't add her to any encounter in the live dungeon yet.

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
  changing `dungeonAccess` or `enabled` needs a deploy or content reload.
- **`dungeonAccess.dungeon` is not checked against real dungeons.** A typo silently
  authorizes the wrong key.
- **The species object isn't strict**, so misspelled top-level keys vanish without
  an error.
- **No global cap.** Limits are per dungeon; the same species with limit 1 in two
  dungeons can be acquired twice.
- **The dungeon sprite is manual.** No npm script creates or checks
  `<slug>_sprite.webp`.
