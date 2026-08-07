# Content authoring — appearances

How to add new artwork for a Waifumon without reading any code.

An **appearance** is one look a species can wear. Every owned copy stores which
one she is currently wearing. Appearances are **cosmetic**: they change what
renders and nothing else — no stat, no XP, no affection, no evolution, no
capture odds. That is a hard rule enforced by tests, not a convention.

---

## The 30-second version

Adding a Level-20 look for `alley_catgirl`:

1. Drop the PNG at `assets/waifumon/alley_catgirl/level_20.png`.
2. Add one entry to her `appearances` array in `content/species/starter.json`
   (see below).
3. Restart the bot, or hit **Save + Reload** in the admin panel.

That is the whole pipeline. No migration, no re-seed, no deploy dance. Players
already past Level 20 have it unlocked the moment the loader sees it, and are
notified the next time they level up or open the gallery.

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

The default resolver expects:

```
assets/waifumon/<species slug>/<appearance id>.png
```

So `id: "level_20"` on `alley_catgirl` → `assets/waifumon/alley_catgirl/level_20.png`.

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

Run the test suite, or boot the bot — both apply the same rules. Errors that
fail the load, with the species named:

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

## Related documentation

- `docs/platform-api.md` — the `assetId` contract and the appearance endpoints.
- `docs/portal.md` — how the Portal resolves an `assetId` to a URL.
- `.ai/appearanceplan.md` — the approved design, including future unlock sources.
