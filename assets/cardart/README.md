# WaifuMon Card Kit

Production card assets on a **1500 x 2250** canvas. Composed server-side by
`src/modules/cards/`.

The kit is **raster-first**. The rarity frames, the icons and the ownership
badge are supplied artwork; nothing in the renderer redraws, recolours or
approximates them. SVG is used only as the composition layer — two small,
purely vector documents per card (dark plates, dynamic text) rasterized by
resvg and composited by sharp between the raster layers.

## Canvas

1500 x 2250 is exactly 2:3, which is the aspect the frames are drawn at. The
canvas is **derived from the frames**, not chosen first: the artwork window,
the information panel, the level shield and the three icon holders are all
holes punched in the frame artwork, so the frame defines the card's geometry.

Character art is authored at 1248 x 1824 (13:19) and is **not** full bleed. It
is cover-cropped into the frame's artwork window so the decorative border
visibly encloses it. Windows run 1314–1342 px wide, so the source is upscaled
only ~5–8% at master resolution before cropping. The vertical crop is biased
toward the face (`LAYOUT.artFocusY`), because these compositions put hair and
ears against the top edge.

> **Source artwork must be raw character art**, not an already-composed card.
> Some older entries in `assets/waifumon/` are pre-composed cards complete with
> their own border and title bar; those render as a card inside a card.

## Layers

Back to front:

1. Card background
2. Character artwork — cover-cropped into `art`
3. Dark plates — `panel` and `shield`, drawn *under* the frame so its ornament
   laps their edges
4. Rarity frame PNG
5. Race icon — top holder
6. Affinity icon — middle holder
7. Rarity icon — bottom holder
8. Dynamic text — name, description, level, artist, card number, branding
9. Ownership badge — only when the render context asks for it

Icons are never labelled; the artwork carries the meaning.

## `geometry.json`

Generated, committed, and **the only source of coordinates**. Every rect and
disc is in canvas pixels, derived from the frame PNGs' alpha channel by
connected-component analysis:

```
npm run cards:geometry
```

Re-run it whenever a frame PNG is added or replaced, or whenever
`CARD_MASTER_WIDTH`/`CARD_MASTER_HEIGHT` change — the manifest records the
canvas it was generated for, and the renderer refuses to start if they
disagree. Then bump `VERSION`.

Element sizes are *fractions of the box they sit in* (`LAYOUT` in
`composer/cardComposer.ts`), so the six frames — which differ by tens of pixels
in every dimension — all lay out from one table.

## Rarities

`N`, `R`, `SR`, `SSR`, `UR`, `LR`, `EX`.

**`EX` has no frame artwork yet.** It stays in the rarity ladder and keeps its
own roundel in `icons/rarity/ex.png`; only `frames/ex.png` is missing. Asking to
render an `EX` card raises `CardAssetMissingError` naming that exact path. It is
never aliased to another rarity — a card that advertises the wrong rarity is a
worse outcome than a card that fails to render. Drop `frames/ex.png` in, re-run
`cards:geometry`, bump `VERSION`, and it starts working with no code change.

Asset validation deliberately skips `EX` so the other six rarities keep serving.

## Files

| Path | What |
| --- | --- |
| `frames/{n,r,sr,ssr,ur,lr}.png` | Transparent rarity frames. 1024x1536 (2:3), except `n.png` at 1036x1519. |
| `icons/races/*.png` | 512x512. Angel, Demon, Demi-human, Human, Spirit, Valkyrie, Android. |
| `icons/affinities/*.png` | 512x512. Dominant, Submissive, Switch, Caregiver, Primal. |
| `icons/rarity/*.png` | 512x512, one per rarity including `ex`. |
| `badges/owned.png` | The "CAUGHT" overlay. Never baked into a species master. |
| `geometry.json` | Generated frame geometry. See above. |
| `fonts/` | Embedded Inter + Noto Serif Italic, so output never depends on host fonts. |

The `n.png` frame is 1036x1519 rather than 2:3 and takes a ~2.3% stretch to fit
the canvas. That is deliberate: cover-cropping it instead would cut the
decorative border that defines the card's edge.

Icons are drawn at `1.38 x` their holder's diameter, which puts their ~412 px
ring at ~1.11x the hole so it laps the rim rather than floating inside it.

## `VERSION`

A monotonically increasing integer that participates in the render cache key.
**Bump it whenever any file in this directory changes** — that alone invalidates
every cached card. Rendering also keys off `CARD_RENDERER_VERSION` in
`src/modules/cards/version.ts`, which is bumped when renderer code changes what
pixels come out.

## Text

All card text is dynamic and drawn at render time; nothing is baked into a
raster asset. The embedded font set is Latin-only, so **decorative symbols must
be vector paths, not characters** — a dingbat such as `✦` (U+2726) has no
coverage in Inter and renders as a missing-glyph box.

The information panel has four rows: name, two description lines, and a credit
row (artist / `WAIFUMON` / card number). `subtitle`, `ability` and `flavorQuote`
remain part of the authored content contract but have nowhere to appear on this
frame, so they are not drawn and not part of the render key.
