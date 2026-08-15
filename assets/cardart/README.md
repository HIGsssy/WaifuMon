# WaifuMon SVG Card Kit

Modular card assets using a 1000 x 1400 SVG viewBox. Rendered server-side by
`src/modules/cards/` (see `.ai/SVGPlan.md`).

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

Rarity overlays draw on top of the base, so the base must keep its content
inside the band the overlays leave free:

- **Innermost frame line** sits at `y = 1360` (EX: `y = 1358`). Nothing in the
  base should have ink below `y ≈ 1354`.
- **Bottom-centre flourish** (SSR, UR, LR, EX) occupies `y 1360…1392`,
  `x 450…550`.
- **Corner flourishes** (SR, SSR, UR, LR) sweep inward from the card edge to
  `x ≈ 175` on the left and `x ≈ 825` on the right below about `y = 1300`; EX's
  chevrons run along `y = 1372` from `x 60…210` and `x 790…940`. The footer
  credit row is therefore inset to `x 190…810`.

A new rarity overlay that wants to decorate further inside must come with a
matching base-template adjustment — and a `VERSION` bump.

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
