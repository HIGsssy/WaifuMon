# WaifuMon SVG Card Kit

Modular card assets using a 1000 x 1400 SVG viewBox.

Composition:
1. Character artwork
2. `templates/card-base.svg`
3. One rarity overlay from `rarities/`
4. One race icon from `icons/races/`
5. One affinity icon from `icons/affinities/`
6. Replace text by element ID
7. Render to PNG/WebP

Rarities: N, R, SR, SSR, UR, LR.
Races: Angel, Demon, Demi-human, Human, Spirit, Valkyrie, Android.
Affinities: Dominant, Submissive, Switch, Caregiver, Primal.

Useful element IDs in the base template:
`character-art`, `character-name`, `character-subtitle`, `level`, `race-icon`,
`race-label`, `affinity-icon`, `affinity-label`, `affinity-description`,
`affinity-description-2`, `ability-name`, `ability-text`, `ability-text-2`,
`flavor-quote`, `artist-credit`, `card-number`.

The rarity SVGs are transparent overlays. Race and affinity icons use `currentColor`
so your renderer can recolor them. `sample-data.json` shows the intended data shape.

For Node rendering, `@resvg/resvg-js` plus `sharp` is a strong combination.
