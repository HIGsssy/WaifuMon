# Patch's Workshop (V1)

Patch's Workshop gives spare Equipment somewhere to go. It is a sink for gear
and a sink for WaifuBux.

```text
find Equipment → keep the good rolls → dismantle the rest with Patch
  → Salvaged Components → spend Components + WaifuBux
  → Patch fabricates a new randomized piece
```

Dismantling pays Salvaged Components and never pays WaifuBux. Every way of
fabricating and then dismantling loses Components, and the config validation
enforces that.

## Where things live

| Concern | Location |
| --- | --- |
| Yields and recipes | `content/equipment/workshop.json` |
| Config schema and rules | `src/modules/equipment/workshopConfig.ts` |
| Service (gate, read models, dismantle, fabricate, idempotency) | `src/modules/equipment/equipmentWorkshopService.ts` |
| Dismantle checks and soft-removal (the single writer of owned gear) | `equipmentService.dismantle` / `assessDismantle` |
| Fabrication roll | the shared random-reward path, `equipmentRewards.grantRandomEquipmentReward` |
| Balance | `player_currencies.salvaged_components`, moved only by `currencyService.{grant,spend}SalvagedComponents` |
| Ledger and idempotency | `equipment_workshop_operations` (migration `0049_equipment_workshop.sql`) |
| Discord (`pw:*`) | `src/discord/workshopPresenter.ts`, `src/discord/commands/waifumonWorkshop.ts` |
| API | `src/api/routes/v1/equipment.ts` (`…/equipment/workshop*`) |
| Portal | `portal/src/features/equipment/` (`WorkshopPanel`, `DismantleReviewDialog`, `FabricateDialog`) |

## Configuration

```json
{
  "format": "waifumon-equipment-workshop",
  "version": 1,
  "salvageYields": { "N": 1, "R": 4, "SR": 12 },
  "recipes": [
    { "key": "standard_rebuild", "name": "Standard Rebuild", "rarity": "N",
      "componentCost": 5, "waifubuxCost": 250, "enabled": true }
  ]
}
```

- Yields depend on **rarity only**. Roll quality does not change them.
- A rarity with no yield **cannot be dismantled**. There is no default value,
  so an SSR copy is refused rather than being valued as SR.
- A recipe's rarity must be one random Equipment can roll (`N` / `R` / `SR`).
- A recipe's `componentCost` must be greater than its rarity's salvage yield.
- The file is optional. Without it nothing can be dismantled or fabricated.
- Retuning is a deploy. There is no admin editor in V1.

## Artwork

`artworkPath` is optional. When set, it is a path relative to `ASSETS_DIR`,
validated with the shared `relativeArtworkPath` rules. By convention it lives at
`assets/equipment/workshop/<name>.webp`. The shipped value is `null` until a
real file exists.

Every Workshop screen uses one fallback order, defined in
`workshopArtworkCandidates`:

1. the Workshop artwork;
2. Patch's NPC portrait (`content/npcs.json`);
3. text only.

If a file is missing or its path is unsafe, the screen logs it and moves to the
next option. Workshop access never fails because of artwork.

- **Discord** shows one large image on the home screen, the dismantle review
  and result, and the fabrication review and result. The dismantle list and
  recipe list have no image.
- **The API** includes `artwork: { source: 'workshop' | 'patch' } | null` in
  the overview. It never includes a path. The bytes come from
  `GET …/equipment/workshop/artwork`, which is self-only, needs the unlock,
  supports ETag/304, uses `private` caching, and returns 404 when no image
  exists.
- **The Portal** passes a logical asset to `<Artwork>`. The `artworkApi`
  provider turns that asset into the route above.

## Rules

- **Gate:** every read and action needs the permanent `equipment` unlock. The
  Patch onboarding that grants the unlock does not use the Workshop.
- **Dismantle** is all or nothing over an explicit list of up to 50 instance
  ids. It refuses the whole batch if any copy is missing, foreign, removed,
  listed twice, equipped in any loadout, favourite, locked or unsalvageable.
  The refusal names each problem copy. There is no force option; admin removal
  stays separate. A dismantled copy is soft-removed with
  `removed_reason = 'dismantled'` and gets a `dismantled` equipment event.
- **Fabricate** guarantees the recipe's rarity. The player picks Attack,
  Defense, Health or Any. The base definition is drawn uniformly from the
  enabled definitions that match. The multiplier and affix are the normal
  roll. If no definition matches, the request is refused before any charge,
  and another slot is never substituted. The instance records
  `source_type = 'fabrication'` and `source_key = <recipe key>`, and the
  Portal shows it as "Fabricated by Patch".

## Transactions, idempotency, concurrency

Each action runs in one transaction. The transaction first locks the player row
`FOR UPDATE`, then checks for the request key, validates, writes, and finally
records an `equipment_workshop_operations` row. If anything fails, nothing is
destroyed, charged or granted.

- `request_key` is unique per player. Discord mints a nonce for each rendered
  Confirm button and sends `discord:<nonce>`. The Portal mints one key for each
  review or confirm step and sends `portal:<uuid>`. A retry with the same key
  replays the original result (`replayed: true`). A key reused for a different
  request returns `409 WORKSHOP_REQUEST_CONFLICT`.
- A fabrication's instance is stored under the grant key
  `workshop:<playerId>:<requestKey>:0`, so a replay returns the same roll.
- Locks are always taken in the order player, loadouts, instances, currencies.
  That order is compatible with equip, admin removal and Combat Trials.
- A dismantle confirmation that has gone stale, because a copy was favourited,
  locked or equipped since the review, fails the re-check under lock.
  `expectedComponents` refuses a review whose total changed.

## Tuning notes (V1)

All three recipes price a Component at 50 WaifuBux (250/5, 750/15, 2000/40).
With shipped content, baseline WaifuBux income is roughly 240 a day: the daily
package, daily quests and hunt finds. That makes an N craft about 1 day of
baseline income, R about 3 days and SR about 8.
