# WaifuMon SVG Card Kit

Modular card assets on a **1500 x 2200** SVG viewBox. Rendered server-side by
`src/modules/cards/` (see `.ai/SVGPlan.md`).

The canvas is derived from the source artwork, not chosen first. Character art
is authored at **1248 x 1824** (13:19, ~0.6842); 1500 x 2200 is ~0.6818, within
0.35% of it. The art is **full bleed** — it fills the whole card and the frame,
badges and text sit over it — which costs 1.5% of width and **0% of height**.
An inset art window on this canvas would instead discard ~11% of the height,
and these compositions put ears against the top edge and boots against the
bottom, so that 11% is anatomy.

Composition (layered raster — the renderer never merges two SVG documents):
1. Character artwork (resolved into `#character-art` by the renderer)
2. `templates/card-base.svg` — structurally mutated, then rasterized to the base PNG
3. One rarity overlay from `rarities/` — rasterized on its own, composited on top
4. One race icon from `icons/races/` — children injected into `<g id="race-icon">`
5. One affinity icon from `icons/affinities/` — children injected into `<g id="affinity-icon">`

Rarities: N, R, SR, SSR, UR, LR, EX. Every rarity owns its own overlay file;
the renderer never substitutes one rarity for another.
Races: Angel, Demon, Demi-human, Human, Spirit, Valkyrie, Android.
Affinities: Dominant, Submissive, Switch, Caregiver, Primal.

Useful element IDs in the base template:
`card-background`, `character-art`, `character-name`, `character-subtitle`,
`level`, `race-icon`, `race-label`, `affinity-icon`, `affinity-label`,
`affinity-description`, `affinity-description-2`, `ability-block`,
`ability-icon`, `ability-name`, `ability-text`, `ability-text-2`, `flavor-quote`,
`artist-credit`, `card-number`.

The rarity SVGs are transparent overlays. Race and affinity icons use `currentColor`
so the renderer can recolor them (it sets `color` on the destination group).
`sample-data.json` shows the intended data shape.

## Geometry constraints

The base and the overlays share one zone map, so a designer can replace any
rarity file without re-checking it against seven layouts.

**The base owns** (no overlay may draw here):

| Zone | Box |
| --- | --- |
| Level badge | `x 1244…1466`, `y 84…246` |
| Name + subtitle | `x 110…1390`, `y 1620…1730` |
| Classification panel | `x 60…1440`, `y 1742…1874` |
| Ability panel | `x 60…1440`, `y 1896…2036` |
| Flavour quote | `x 560…940`, `y 2046…2080` |
| Credit row | `x 250…1250`, `y 2090…2120` |

**Overlays own**:

| Zone | Box |
| --- | --- |
| Rarity badge | `x 76…344`, `y 88…204` |
| Border rings | the full perimeter |
| Top-centre crest | `x 400…1240`, `y 4…80` — between the two badges |
| Bottom-left pocket | `x 34…240`, `y 2044…2166` |
| Bottom-right pocket | `x 1260…1466`, `y 2044…2166` |

Two rules fall out of this and are worth stating plainly:

1. **Both badges sit inside the inner ring, not in the corners.** A corner badge
   and a corner flourish cannot share a corner; that collision is what the
   earlier geometry kept producing.
2. **Nothing decorative is drawn over the artwork** between `y 200` and
   `y 1740`. The character is the card.

A new overlay that wants to decorate outside its zones needs a matching
base-template change — and a `VERSION` bump.

## `VERSION`

`VERSION` is a monotonically increasing integer that participates in the render
cache key. **Bump it whenever any file in this directory changes** — that alone
invalidates every cached card. Rendering also keys off `CARD_RENDERER_VERSION`
in `src/modules/cards/version.ts`, which is bumped when renderer code changes
what pixels come out.

## `fonts/`

Embedded fonts so rendering never depends on host OS fonts. Inter (OFL) covers
the `sans-serif` stack, Noto Serif Italic (OFL) covers the `serif` stack used by
the flavor quote. Licenses ship alongside as `*-OFL.txt`.

Because the embedded set is Latin-only, **decorative symbols must be vector
paths, not characters.** A dingbat such as `✦` (U+2726) has no coverage in
Inter and renders as a missing-glyph box — see `ability-icon` in the base
template for the pattern to follow.
