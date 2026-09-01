# Content authoring

How to add new artwork and card text for a Waifumon without reading any code.

Two things live here:

- **[Appearances](#the-30-second-version)** — the looks a species can wear.
- **[Card metadata](#card-metadata)** — `race` and the `card` block, which drive
  the rendered card image.

Neither touches gameplay, and neither needs a database migration.

## Appearances

An **appearance** is one look a species can wear. Every owned copy stores which
one she is currently wearing. Appearances are **cosmetic**: they change what
renders and nothing else — no stat, no XP, no affection, no evolution, no
capture odds. That is a hard rule enforced by tests, not a convention.

---

## The 30-second version

Adding a Level-20 look for `alley_catgirl`:

1. Drop the PNG at `assets/waifumon/alley_catgirl/level_20.png`.
2. Run `npm run appearances:sync` — it writes the JSON entry for you.
3. Restart the bot, or hit **Save + Reload** in the admin panel.

That is the whole pipeline. No migration, no re-seed, no deploy dance. Players
already past Level 20 have it unlocked the moment the loader sees it, and are
notified the next time they level up or open the gallery.

Step 2 is optional — the JSON is plain text and you can always write it by hand
(see [Authoring an appearance](#authoring-an-appearance)). Use the script when
you are shipping the standard milestone set; write it by hand when the look
deserves a real name and flavour text.

---

## Milestone appearances at scale

The standard set is `standard`, `level_10`, `level_20`, `level_30`, `level_40`,
`level_50`. Across fifty-plus species that is several hundred near-identical
JSON entries, which is exactly the kind of work that goes wrong quietly. The
synchroniser writes them from the artwork.

### The workflow

```text
Add/finalize artwork

  assets/waifumon/<slug>/level_10.png
  assets/waifumon/<slug>/level_20.png
  …
        ↓
Preview the metadata changes:

  npm run appearances:sync -- --dry-run
        ↓
Prepare content and web assets:

  npm run content:prepare
        ↓
Run validation/tests as appropriate:

  npm test
        ↓
Restart the bot, or hit Save + Reload in the admin panel
```

Everything runs from the repository root. `content:prepare` does two things, in
order:

1. **`appearances:sync`** — writes the appearance metadata into the species
   pack each species already lives in.
2. **`assets:thumbs`** — generates the web-ready renditions the Portal serves.

The order matters, and so does the failure behaviour: if synchronisation fails
— a duplicate slug, content that does not currently load — the pipeline stops
and rendition generation never runs, so a failed preparation can never look
like a successful one. Either stage failing exits non-zero.

You can still run the two halves separately (`npm run appearances:sync`,
`npm run assets:thumbs`) when you only want one of them.

> `assets:thumbs` at the root delegates to the Portal package. The Portal has
> its own lockfile and its own dependencies, and nothing here installs them for
> you — if they are missing, the command says so and names the exact command to
> run (`npm install --prefix portal`).

### The rule it follows: artwork leads, content follows

**An appearance is only ever added when its PNG already exists.** If
`cyber_shrine_maiden` has `standard.png`, `level_10.png` and `level_20.png`,
the script writes those three and nothing else. `level_30` appears in content
the run after `level_30.png` appears on disk.

That is deliberate. Pre-populating all five levels everywhere would be easier
and would produce hundreds of "appearance artwork missing" warnings at every
boot until the last PNG lands — and a warning channel everyone has learned to
ignore is worse than no warning channel.

### What it will not do

- **It never edits an appearance that already exists.** Custom `name`,
  `description`, `flavorText`, `cosmeticRarity`, `introducedVersion`,
  `unlockLabel`, `tags`, `sortOrder`, `assetId` — all preserved exactly. The
  script only ever *appends* entries whose `id` is missing.
- **It never adds a second `owned` entry.** If your species already has a
  default under some other id, that stays the default and no `standard` entry
  is created.
- **It never moves a species between packs.** A species is updated in the file
  it is already defined in.
- **It never writes an unreachable gate.** Milestones above
  `waifuProgression.maxLevel` in `tables.json` are skipped and reported, not
  written.

### A species with only `standard.png`

Nothing happens, on purpose. A species with no `appearances` array already
resolves to an implicit `standard` entry at read time, so writing the array out
would be churn with no behaviour change. The array is materialised — canonical
`standard` entry included — the first time a level milestone needs to go in it.

### Nothing to register in the Portal

Once the content record exists, the Portal shows the appearance. There is no
frontend step, and deliberately no place to add one — no appearance enum, no
allow-list, no image map, no route entry, no `switch` on appearance id. The
chain is:

```text
content JSON says the appearance exists
        ↓
API publishes it, with an abstract assetId { kind, slug, variant }
        ↓
Portal's image provider turns that assetId into a URL
        ↓
the rendition route serves the optimised file
```

Each link only knows about the next one. The Portal never scans
`assets/waifumon/` to work out which appearances exist — **content is the
authority for what exists; the filesystem is only consulted during authoring**,
by the two preparation commands. That separation is what lets artwork move to a
CDN later without touching content, and lets content add an appearance without
touching the Portal.

The practical consequence: an appearance id nobody has written code for — a
`winter_2026` from some future seasonal process — renders correctly the day it
is authored. `appearances:sync` is the only piece that knows what a "level
milestone" is; `assets:thumbs` optimises *any* appearance artwork, and the
Portal renders *any* appearance the API sends.

### Adding a new content pack

Drop `winterexpansion.json` (or anything else ending in `.json`) into
`content/species/` and it is picked up automatically. There is no file list to
update, in this script or anywhere else — it uses the same directory scan the
bot's loader uses at boot, so the two can never disagree about which packs
exist.

If the same species slug appears in two packs, the script **aborts before
writing anything** and names the slug and every file containing it.

### Output

```text
starter.json
  alley_catgirl
    + standard
    + level_10

Updated 1 file
Updated 1 species
Added 2 appearances
```

or, when the content already matches the artwork:

```text
No appearance changes needed.
```

Re-running is safe and idempotent. `--dry-run` performs the same discovery and
the same validation, reports the same thing, and writes nothing.

### Formatting

Entries are written in this repo's standard JSON shape — two-space indent,
one key per line — and each pack keeps its existing line endings. Expect a diff
that contains your additions and nothing else. `unlock` is written expanded
rather than on one line, which is what `JSON.stringify` produces and what every
other nested object in these files already looks like.

---

## Authoring an appearance

A species with **no** `appearances` array is completely fine — the loader gives
it one implicit `standard` entry pointing at
`assets/waifumon/<slug>/standard.png`. Every species shipped before this system
works exactly this way, and nothing needs to change.

The moment you want a second look, you must write the array out in full,
**including the default**:

```jsonc
{
  "slug": "alley_catgirl",
  "name": "Alley Catgirl",
  // … the usual species fields, including imagePath …
  "appearances": [
    {
      "id": "standard",
      "name": "Standard",
      "sortOrder": 0,
      "unlock": { "type": "owned" }
    },
    {
      "id": "level_20",
      "name": "Midnight Bloom",
      "description": "A darker cut of her usual silhouette.",
      "flavorText": "Prepared for the annual shrine celebration.",
      "cosmeticRarity": "seasonal",
      "introducedVersion": "v1.3",
      "sortOrder": 20,
      "unlock": { "type": "level", "atLevel": 20 }
    }
  ]
}
```

### Fields

| Field | Required | What it does |
| --- | --- | --- |
| `id` | ✅ | Unique within the species, `lowercase_snake_case`. Also the filename (`<id>.png`) and the value stored on the owned copy. |
| `name` | ✅ | Display name. Shown on the tile, in the select menu, and on the unlock toast. |
| `unlock` | ✅ | `{ "type": "owned" }` or `{ "type": "level", "atLevel": N }`. See below. |
| `description` | – | One-line subtitle in the detail panel. |
| `flavorText` | – | In-world caption, rendered in italic quotes. |
| `cosmeticRarity` | – | `standard` \| `common` \| `rare` \| `seasonal` \| `limited` \| `exclusive`. Defaults to `standard`. |
| `introducedVersion` | – | Free-form, e.g. `"v1.3"`. Shown as a small chip. Never parsed. |
| `sortOrder` | – | Gallery ordering, low to high. Defaults to `100`; ties break by `id`. |
| `contentRating` | – | Defaults to the species'. |
| `tags` | – | Free-form, for your own filtering. Unused by v1 rendering. |
| `assetId` | – | Almost never needed. Defaults to `{ kind: "waifumon", slug: <species slug>, variant: <id> }`. Set it only to point two appearances at the same file. |
| `unlockLabel` | – | Overrides the generated requirement text. Use it when the default reads badly. |

### `unlock` types available today

```jsonc
{ "type": "owned" }                    // she has it the moment you catch her
{ "type": "level", "atLevel": 20 }     // her *own* level, not the player's
```

`evolution`, `affection`, `event`, `seasonal`, `achievement`, `promotion`,
`admin_grant` and `special` are **reserved**. Authoring one is a validation
error today, deliberately: the clients already know how to render them, but
nothing resolves them yet. See `.ai/appearanceplan.md` for what each will need.

### `unlockLabel` — the thing players actually read

Every appearance shows its requirement on **every** surface, locked *and*
unlocked. That is what makes the gallery a progression journal rather than a
lock icon, so this string carries real weight.

Leave it out and you get a sensible default:

| `unlock` | Generated label |
| --- | --- |
| `{ "type": "owned" }` | `Owned` |
| `{ "type": "level", "atLevel": 20 }` | `Reach Level 20` |

Set it when the default is technically right but reads poorly:

```jsonc
"unlockLabel": "Train her to Level 40"
```

### Cosmetic rarity is not species rarity

`cosmeticRarity` (`seasonal`, `limited`, …) and `species.rarity`
(`N`/`R`/`SR`/…) are **independent**, deliberately named differently, and
styled differently on every surface. A Rare species can wear a Seasonal look;
those are two separate facts about her and must never read as one.

Cosmetic rarity is descriptive only. It affects no drop, no unlock, and no
gameplay — it is a badge.

---

## Artwork

The default resolver expects an appearance PNG to sit **beside the species'
own image**, named after the appearance id:

```
<directory of the species imagePath>/<appearance id>.png
```

For a core species — whose `imagePath` is `waifumon/<slug>/standard.png` — that
is:

```
assets/waifumon/<species slug>/<appearance id>.png
```

So `id: "level_20"` on `alley_catgirl` → `assets/waifumon/alley_catgirl/level_20.png`.

An **expansion pack** keeps its artwork organised under its own directory
instead of `waifumon/`. Because its species' `imagePath` points there, its
appearances resolve there too — one convention, no special case:

```
assets/expansions/<pack>/<slug>/<appearance id>.png
```

The loader, the runtime resolver, and `appearances:sync` all use this same
rule, so a pack that ships art beside its `imagePath` is picked up everywhere on
identical terms.

That layout is a **consumer** convention, not part of the data model. The
Platform API only ever emits an abstract `assetId`; the bot and the Portal each
resolve it independently. Moving artwork to a CDN or object store is a change
inside those resolvers and touches no content file and no API response.

### If a file is missing

| Situation | What happens |
| --- | --- |
| A non-default appearance's PNG is missing | Warning at load; **that appearance is dropped**. The species and everything else still work. |
| The default (`owned`) appearance's PNG is missing | Warning at load; the entry is kept and consumers fall back (Discord → the species card, Portal → a silhouette). |
| The species' own `imagePath` is missing | Warning at load; **the species is disabled**. Unchanged, long-standing behaviour. |

The rule: a content mistake should cost the smallest possible thing. Half-
shipped artwork costs one gallery tile, never a whole Waifumon.

---

## Validation

Run the test suite, or boot the bot — both apply the same rules.
`npm run appearances:sync` applies them too, before it writes: it refuses to
run against content that does not already load, and re-validates the whole
candidate set — every pack, plus `tables.json` — before a single file changes.
A run either updates every pack consistently or leaves them all alone.

Errors that fail the load, with the species named:

- two appearances with the same `id`;
- zero or two entries with `unlock.type: "owned"` (there must be exactly one:
  a freshly-caught copy needs exactly one thing to wear, unambiguously);
- `atLevel` above `waifuProgression.maxLevel` in `tables.json` — a tile no
  player could ever earn;
- an `assetId.slug` naming a different species;
- a reserved future `unlock.type`;
- an unknown `cosmeticRarity`.

The admin panel's warning list surfaces missing artwork before you save.

---

## What happens after you ship it

- **A player already past the gate** — unlocked immediately. They are notified
  the next time they level that copy or open her gallery, and an
  `appearance_unlock` audit row is written with `source: "content_add"`. There
  is no backfill job to run and none to forget.
- **A player below the gate** — sees a locked tile with your `unlockLabel` on
  it, and gets a toast with a one-click **Select Now** when they cross it.
- **Everyone** — can preview locked artwork on the Portal by opening the tile
  and choosing *Reveal artwork*. Discord keeps locked art hidden and shows the
  requirement instead.

---

# Card metadata

Two optional species fields feed the card renderer: a top-level `race`, and a
`card` block. Both are presentation only — **nothing here affects capture odds,
XP, affection, evolution, or any other game system.** Both live in the JSON
content and never in the database, so editing them is a content change, not a
migration.

Both are optional. Every species that predates them still loads and still
renders, unchanged.

## `race`

Which frame iconography the card wears. One of exactly seven values:

```text
angel   demon   demi-human   human   spirit   valkyrie   android
```

These are a closed set because each one maps to an icon file in
`assets/cardart/icons/races/`. Adding an eighth race means shipping an eighth
icon; it is not something content can invent.

### `race` is not `archetype`

`archetype` is her **narrative role**. It is free-form and always will be:

```json
"archetype": "paladin",
"race": "valkyrie"
```

That pairing is the whole reason the fields are separate. "Paladin" says what
she *does*; "valkyrie" says which frame she *wears*. A librarian can be a
spirit, a barista can be a demi-human, and an assassin can be an android.

Today's corpus happens to use archetype values that are all race words
(`"archetype": "demon"`), which is legacy overlap rather than the intended
model. Because of that overlap, a species with no `race` falls back to a race
derived from its archetype, which is why nothing needed editing when this field
shipped.

**Set `race` explicitly on new content.** The fallback only works while
archetypes happen to be race words. The moment you write
`"archetype": "paladin"`, nothing but an explicit `race` can say whether she is
an angel or a valkyrie — the renderer will log a warning and fall back to
`human`:

```text
species "moonlit_paladin": archetype "paladin" maps to no race — cards will
render as "human". Add an explicit "race" field to fix.
```

That warning is a nudge, never a failure. Content still loads.

## `card`

```json
"card": {
  "subtitle": "Fire-Escape Regular",
  "artist": "Someone Real",
  "ability": {
    "name": "Trade Secrets",
    "text": "Knows which windows are unlatched and who left them that way."
  },
  "flavorQuote": "Look up. She has been there the whole time.",
  "cardNumber": "012/100"
}
```

Every field is optional, and the whole block is optional.

| Field | Limit | Notes |
| --- | --- | --- |
| `subtitle` | ≤ 48 | Epithet under her name. |
| `artist` | ≤ 48 | **Only when a real attribution is known.** Omit it otherwise — do not invent a credit. |
| `ability.name` | 1–32 | Required *with* `ability.text`. |
| `ability.text` | 1–160 | Wrapped onto two lines; longer text truncates. |
| `flavorQuote` | ≤ 120 | Rendered in italic quotes. The renderer adds the quote marks. |
| `cardNumber` | ≤ 32 | Reserved. See below. |

Rules worth knowing:

- **`ability` is all-or-nothing.** A name with no text is a validation error,
  not a half-filled card. Omit the block if you have only one half.
- **Omit rather than blank.** `"subtitle": ""` and `"subtitle": "   "` are
  validation errors. An omitted field removes its element from the card
  entirely; it never renders as an empty box or a placeholder.
- **Unknown keys are rejected**, so `"flavourQuote"` fails loudly instead of
  being silently ignored.
- **Long text degrades, it does not break.** The renderer shrinks the name to
  fit, wraps ability text across two lines, and truncates with an ellipsis past
  that. Staying under the caps just means you choose where the cut lands.

### Generic affinity text is not authored here

The card shows a short blurb next to the affinity badge ("Takes the lead and
sets the pace…"). **Do not author that.** It describes what the affinity
*category* means and is identical on every card that shares it, so it lives in
the renderer (`AFFINITY_DESCRIPTIONS` in `src/modules/cards/affinity.ts`).
Fields like `affinityDescription` are rejected by the schema.

### `cardNumber` is reserved

There is no set-numbering system yet. `cardNumber` is free-form presentation
metadata held for a future one. **Do not invent numbering to fill it in** — a
made-up `012/100` implies a hundred-card set that does not exist. Leave it out.

## Buddy Bonus

A species may author a **Buddy Bonus** — a passive effect the player gets while
one of their copies of her is the equipped Buddy. It is entirely a content
decision: no code names a species, and a new species using an effect that
already exists works the moment it loads.

```json
"buddyBonus": {
  "name": "After Bell",
  "flavorText": "After Bell: +5% capture chance against SR and below Waifumon.",
  "effectId": "capture_chance",
  "value": 5,
  "target": { "type": "rarity_max", "value": "SR" }
}
```

`name` and `flavorText` are **display only** — nothing in the game reads them.
Behaviour is `effectId`, `value` and the optional `target`, and nothing else.
`value` is a percentage, and it is **relative**: `+10%` on a weight of 100 is
110, and `100` doubles whatever it applies to. For `energy_save_chance` it is
instead the probability of the proc.

| `effectId` | What it changes | Target |
| --- | --- | --- |
| `capture_chance` | The chance of capturing the Waifumon you are facing | optional — `race`, `affinity`, `rarity_min`, `rarity_max`, `ownership`. No target means every species |
| `encounter_weight` | How likely a Waifumon is to be the one you meet | **required** — `race`, `affinity`, `rarity`, `rarity_min`, `rarity_max`, `ownership` |
| `energy_save_chance` | Chance a hunt costs no Energy | none |
| `care_energy_gain` | Energy recovered in Care Mode | none |
| `player_xp_gain` | Player XP awards | none |
| `buddy_xp_gain` | XP awarded to the active Buddy | none |
| `essence_gain` | Essence awards | none |
| `hunt_item_find_chance` | How often a hunt finds an item | none |
| `affection_gain` | Affection awards | none |
| `boss_reward_gain` | The payout from a Boss Encounter | none |

A bonus is granted by the copy the player has **equipped as their Buddy**, with
one deliberate exception: `boss_reward_gain` is resolved from the copy that was
*committed* to that Boss Encounter. A participation snapshots the committed
Waifumon — her level, SP, rarity, affinity and race — and her bonus is part of
that snapshot, so swapping Buddy between committing and resolution changes
nothing about that encounter's payout, in either direction.

Bonuses are also **surfaced to the player at the moment they act**: the
encounter screen names a matching `capture_chance` bonus, a hunt result names
the Energy save that fired, the item-find bonus behind a find, and the Essence
or Affection uplift it produced, and the Care summary and Boss reward summary do
the same for theirs. A bonus that did not change the outcome — a failed proc, a
target the encountered species does not match — is never mentioned. Gameplay
screens print a short mechanical summary derived from `effectId`, `value` and
`target`; the authored `flavorText` appears only in Collection / Inspect.

`affection_gain` is the mirror case, also deliberate: it scales **any**
Affection award the player earns, including Affection earned by a different
Waifumon being cared for in Care Mode. `buddy_xp_gain` does not work that way —
it applies only to XP awarded to the active Buddy herself.

Target values are closed sets: races are the `race` codes above, affinities are
`dominant` / `submissive` / `switch` / `caregiver` / `primal`, rarities are
`N` … `EX`, and ownership is `owned` / `unowned`.

Anything outside those sets — a target on an effect that takes none, a missing
target on `encounter_weight`, an unknown `effectId` — **fails content
validation** rather than loading as a bonus that quietly never fires.
`content/bonus.json` is the same table in machine-readable form, and a test
keeps it in step with the code.

Adding a *new kind* of effect is the one case that needs code: the effect id
has to be added to `src/modules/buddyBonus/buddyBonusEffects.ts` and applied
wherever it belongs.

## Worked examples

Three shipped species demonstrate the range — copy whichever matches your case:

- **`alley_catgirl`** (`content/species/starter.json`) — explicit `race` plus a
  full `card` block with subtitle, ability, and flavour quote. No `artist`
  (none is known) and no `cardNumber`.
- **`chrome_valkyrie`** — explicit `race` plus a partial block: subtitle and
  flavour quote, no ability.
- **`the_first_waifu`** — explicit `race` and **no `card` block at all**. The
  two fields are independent; adding one does not oblige you to add the other.

## When card visuals change

The rendered card is cached by a content hash that includes the SVG kit's
version. If you change anything under `assets/cardart/` — a rarity overlay, an
icon, the base template, a font — **bump `assets/cardart/VERSION` to the next
integer**. That one edit invalidates every cached card; there is no purge
command to run and no cache directory to clear by hand.

Editing `race` or `card` in species JSON needs **no** VERSION bump. Content
changes are already part of the cache key, so a card re-renders on its own.

---

## Related documentation

- `docs/platform-api.md` — the `assetId` contract and the appearance endpoints.
- `docs/portal.md` — how the Portal resolves an `assetId` to a URL, and
  `npm run assets:thumbs` (run from `portal/`).
- `.ai/appearanceplan.md` — the approved design, including future unlock sources.
- `.ai/SVGPlan.md` — the card rendering system, including how `race` and `card`
  reach the renderer.
- `assets/cardart/README.md` — the SVG kit itself: layer order, element IDs, the
  geometry the base template must stay inside, and the `VERSION` workflow.

### Commands

All of these run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run appearances:sync -- --dry-run` | Reports which milestone appearances the artwork implies. Writes nothing. |
| `npm run appearances:sync` | Writes them into the pack each species already lives in. |
| `npm run assets:thumbs` | Generates the Portal's display renditions. Delegates to the `portal` package. |
| `npm run cards:warm` | Pre-renders the default card for every enabled species, so the first request is a cache hit. Safe to re-run; already-cached cards cost nothing. |
| `npm run cards:warm -- --player <id>` | Pre-renders the **owned** cards for one player's current collection — her real level, the look she is wearing — plus the `@256` and `@512` the Portal's collection grid draws. Needs `DATABASE_URL`. |
| `npm run cards:warm -- --all-players` | The same for every player who owns anything. One player at a time by default; `--player-concurrency N` raises it. |
| `npm run cards:gc -- --dry-run` | Reports which cached card renders would be reclaimed. Add nothing to actually remove them. |
| `npm run content:prepare` | Both of the above, in order, stopping if the first fails. |
| `npm test` | Full validation, including every appearance rule above. |

`assets:thumbs` optimises **any** appearance artwork it finds, not just the
level milestones — it walks the artwork tree rather than consulting a list, so
a seasonal or event appearance gets the same renditions with no change to it.
