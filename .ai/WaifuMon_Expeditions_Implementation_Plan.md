# WaifuMon Expeditions & Salvage — Implementation Plan

**Companion to** `.ai/WaifuMon_Expeditions_Salvage_Key_Items_Planning.md` (the design doc).
**This document** is the engineering plan: what to build, in what order, in which files, against
the code that exists today. No code has been changed; this is a planning pass only.

---

## 0. How this plan is grounded

Every claim below about current behaviour was read out of the repo. The load-bearing facts:

| Fact | Where |
| --- | --- |
| Items are content-seeded by slug (upsert, never delete; missing slugs get `enabled: false`) | [seeder.ts](src/modules/content/seeder.ts) |
| `items.category` is a **CHECK-constrained** closed set: `capture, material, cosmetic, consumable` | [schema.ts:306-360](src/db/schema.ts#L306-L360) |
| Shop buying is region-driven off `items.shop_regions` + `buy_price`; `SHOP_ITEM_CATEGORIES = capture, consumable` | [shopService.ts](src/modules/shop/shopService.ts), [schema.ts:46-55](src/db/schema.ts#L46-L55) |
| Inventory is a `(player_id, item_id)` quantity table; adds are upserts, consumes are conditional decrements with `CHECK (quantity >= 0)` | [inventoryService.ts](src/modules/inventory/inventoryService.ts) |
| Currency mutations take a `DbOrTx` so they compose into one transaction; spends are conditional `WHERE balance >= amount` | [currencyService.ts](src/modules/currency/currencyService.ts) |
| A weighted reward-table engine already exists (independent groups, `chanceBasisPoints` gate + weighted pick, deterministic hash RNG) | [bossRewards.ts](src/modules/bosses/bossRewards.ts), [bossRandom.ts](src/modules/bosses/bossRandom.ts), [content/bossRewards.json](content/bossRewards.json) |
| A "tick re-derives what is due from the database" scheduler pattern already exists and is documented as the anti-`setTimeout` stance | [bossScheduler.ts](src/modules/bosses/bossScheduler.ts) |
| Regions are a closed code-side list backed by CHECK constraints; adding one is a migration | [regions.ts](src/modules/locations/regions.ts) |
| Affinity wheel (`dominant→submissive→caregiver→primal→dominant`, `switch` neutral) is content config | [content/tables.json](content/tables.json) `buddyAffinity`, [affinityMath.ts](src/modules/capture/affinityMath.ts) |
| **Race is not a database column.** It is resolved from content (`species.race`, falling back to `archetype`) via an injected resolver | [race.ts](src/modules/cards/race.ts), [index.ts:317](src/index.ts#L317) |
| Waifu XP has one canonical award path | `collectionService.awardWaifuXp` ([collectionService.ts:1339](src/modules/collection/collectionService.ts#L1339)) |
| Player XP has one canonical award path with the Buddy Bonus already hooked in | `progression.grantXp` ([progressionService.ts](src/modules/progression/progressionService.ts)) |
| Discord custom ids are `wm|v|scope|action|...args` | [types.ts:259](src/discord/types.ts#L259) |
| Platform API v1 is currently **read-only**; mutations are a declared Phase 3 | [routes/v1/index.ts](src/api/routes/v1/index.ts) |
| Migrations are drizzle-kit SQL files run to head at boot; latest is `0034` | [drizzle/](drizzle/), [migrate.ts](src/db/migrate.ts) |
| Integration tests run against real Postgres (testcontainers) with shared fixtures | [tests/helpers/](tests/helpers/), [vitest.config.ts](vitest.config.ts) |

Two findings from the audit change the design and are worth reading before anything else:

1. **Race is content-only.** Race matching in expeditions must take the same injected
   `resolveRace` dependency the encounter, boss, buddy-bonus and API layers already take
   (`deps.resolveRace(speciesRow)`), *not* a new `species.race` column. Adding a column would
   create a second source of truth that drifts from `content/species/*.json` on the first reload.
2. **A reward-table engine already exists and is boss-shaped.** The design doc explicitly warns
   against a "premature global reward-system rewrite". The plan below therefore *copies the shape*
   of `bossRewards.ts` into an expedition-owned module rather than refactoring the boss path.
   Unifying them is a later, optional cleanup once both have shipped and the shape has proven
   itself twice.

---

## 1. Scope

**In scope for V1 (Phases 1–5):**
item categories `salvage` / `key` / `equipment`, `sellValue` semantics, shop selling, the
expedition domain engine, the Discord expedition UI, a starter content set, read-only Platform
API exposure.

**Explicitly out of scope for V1:**
equipment *mechanics* (slots, stats, equip/unequip), multi-Waifu teams, expedition-triggered
World Encounters, completion DMs, duration reduction, regional price modifiers, portal/Activity
UI beyond read-only endpoints.

**Non-negotiable invariants** (these are the acceptance criteria restated as engineering rules):

- An expedition's outcome and rewards are generated **exactly once**, and surviving a bot restart
  mid-flight is the normal case, not recovery.
- Timing lives in Postgres timestamps. No in-memory timer is ever the source of truth.
- Domain logic is Discord-free and callable from a service container.
- Key items cannot be sold unless a content author explicitly said so.
- Reward granting composes into one transaction with inventory and currency.

---

## 2. Decisions locked before Phase 1

The design doc left these open. These are the recommended defaults so implementation is not
blocked; each is a content/config value, so playtesting can move it without a code change.

| Question | Locked V1 answer | Why |
| --- | --- | --- |
| Where do expedition definitions live? | `content/expeditions/<region>.json`, validated by Zod, loaded into the content snapshot — **not** a database table | Matches bosses/regions. Definitions are content; only player state is state. |
| Board rotation | **Derived, not stored**: the visible set is a deterministic pick seeded by `hash(playerId, regionId, floor(now / 12h))` | No rotation table, no cron, no drift. Restart-proof by construction. Answers "same board for everyone?" with *per-player*, which is also the fairer default. |
| Resolution trigger | **Lazy on read**, with an optional worker tick added later behind a flag | The player cannot observe a result without a read. A worker is only needed for push notifications (Phase 7). |
| Resolve vs. claim | Two operations, two timestamps (`resolved_at`, `claimed_at`) | The design doc asks for it, and it is what makes "result exists before the player collects" safe. |
| Concurrency | One active expedition per player, enforced by a **partial unique index** | Database-enforced beats service-enforced. |
| Randomness | Deterministic hash RNG keyed on `(expedition_row_id, purpose)`, mirroring `bossRandom.ts` | A retried resolution reproduces the same outcome instead of rerolling. Idempotency then has a second, independent line of defence behind the conditional UPDATE. |
| Sell prices | Global `items.sell_value` | Regional modifiers are a later content-only change. |
| Displayed odds | Suitability band only (`EXCELLENT/GOOD/FAIR/RISKY/POOR`) | Per design doc §4. The numeric chance is persisted for audit, never rendered. |

---

## 3. Phase 1 — Item foundation

**Goal:** the canonical item model can describe salvage, key items and (inert) equipment, and can
express sellability. No gameplay changes.

### 3.1 Migration `0035_item_categories_and_sell_value.sql`

```sql
ALTER TABLE "items" DROP CONSTRAINT "items_category_check";
ALTER TABLE "items" ADD CONSTRAINT "items_category_check"
  CHECK ("category" in ('capture','material','cosmetic','consumable','salvage','key','equipment'));

ALTER TABLE "items" ADD COLUMN "sell_value" integer;
ALTER TABLE "items" ADD CONSTRAINT "items_sell_value_check"
  CHECK ("sell_value" is null or "sell_value" > 0);
```

Additive and backward compatible: every existing row keeps `sell_value = NULL`, which means
"not sellable", so nothing becomes sellable by accident. Note the CHECK deliberately forbids
storing `0` — the design doc treats `0`, `null` and missing as the same thing, and the database
should therefore only permit one spelling of it.

### 3.2 Code changes

| File | Change |
| --- | --- |
| [schema.ts](src/db/schema.ts) | Extend `ITEM_CATEGORIES`; add `sellValue: integer('sell_value')`; mirror the two CHECKs. Leave `SHOP_ITEM_CATEGORIES` **unchanged** — buying and selling are now different questions. |
| [schemas.ts](src/modules/content/schemas.ts) | Add `sellValue: z.number().int().positive().nullable().default(null)` to `ItemBaseSchema`; extend the category enum; add the superRefine rules in §3.3. |
| [seeder.ts](src/modules/content/seeder.ts) | Add `sellValue` to the `mutable` block so re-seeding updates it. |
| [loader.ts](src/modules/content/loader.ts) | Extend `validateContentSet` with the cross-file lints in §3.3. |
| [resources.ts](src/api/resources.ts), [schemas/inventory.ts](src/api/schemas/inventory.ts) | Surface `sellValue` and the new categories on the item resource. |

### 3.3 Content validation rules (the part that prevents the foot-guns)

1. `shopRegions` non-empty still requires `buyPrice` **and** a `SHOP_ITEM_CATEGORIES` category
   (existing rule — unchanged). Salvage is therefore never accidentally *buyable*.
2. `category: 'key'` with a non-null `sellValue` is a **validation error** unless the item also
   sets `explicitlySellable: true`. This is the literal acceptance criterion ("key items cannot
   accidentally be sold unless explicitly configured") expressed as a boot-time content check.
   *Alternative considered:* rely on `sellValue` alone as the explicit configuration. Rejected —
   a one-character typo in a JSON file should not be able to make a quest key vendor trash.
3. `category: 'equipment'` with `enabled: true` is a validation **warning** for V1 and equipment
   entries are refused in expedition reward tables (§5.3). The schema supports equipment; the
   game does not hand it out yet. This is the design doc's "reserve, don't ship inert rewards".
4. `captureModifier` / `captureBonus` / `captureRarities` / `isGuaranteedCapture` on a
   non-`capture` item stay errors (existing rule, now reachable by the new categories).

### 3.4 Inventory display

`inventoryService.getInventory` orders by `items.category, items.buyPrice, items.slug`. Salvage
has no `buyPrice`, so it sorts as `NULL` — currently last within its category, which is fine, but
the Discord inventory screen in [waifumon.ts](src/discord/commands/waifumon.ts) groups by category
and will need the three new groups added with emoji/labels. Order: capture → consumable →
salvage → key → equipment → material → cosmetic.

### 3.5 Tests (Phase 1)

- `tests/unit/itemContentSchema.test.ts` — each validation rule in §3.3, positive and negative.
- `tests/integration/itemCategories.test.ts` — seed a salvage item and a key item, assert the row
  round-trips, assert the CHECK rejects `sell_value = 0` and an unknown category.
- Extend `tests/integration/migrateSeed.test.ts` — an existing item keeps `sell_value = NULL`
  across the migration.

### 3.6 Exit criteria

Migration applied, content with all three new categories seeds cleanly, `npm run typecheck` and
`npm test` green, and no player-visible behaviour has changed.

---

## 4. Phase 2 — Shop selling

**Goal:** salvage has a purpose *before* anything produces it. This is the design doc's explicit
sequencing instruction and it is worth honouring: it means Phase 5 content tuning can be done
against a working sink.

### 4.1 Service layer — [shopService.ts](src/modules/shop/shopService.ts)

Add to `ShopService`:

```ts
/** Inventory rows the player could sell right now: quantity > 0 and sell_value > 0. */
getSellableInventory(playerId: number): Promise<SellableEntry[]>;

/**
 * Single transaction: resolve item → lock currency row → conditional inventory
 * decrement (WHERE quantity >= n) → grant waifubux → audit row. A failed
 * validation mutates nothing; a double-click cannot sell the same stack twice.
 */
sellItem(playerId: number, itemSlug: string, quantity: number): Promise<SellResult>;
```

```ts
export interface SellableEntry { item: ItemRow; quantity: number; unitValue: number; }
export interface SellResult {
  item: ItemRow; quantity: number; unitValue: number; totalValue: number;
  balanceAfter: number; ownedAfter: number;
}
```

Implementation notes:

- The eligibility filter (`sell_value IS NOT NULL AND sell_value > 0 AND items.enabled`) belongs
  **in the query**, matching the existing comment on `getCatalog` that sellability is filtered in
  the query "so every consumer sees the same rule".
- Order of operations inside the transaction: consume **first**, then grant. `consumeItem` already
  throws `InsufficientItemsError` on a conditional-decrement miss, which makes the revalidation
  the design doc asks for a property of the statement rather than a separate read.
- New error: `ItemNotSellableError` in [errors.ts](src/shared/errors.ts), following the existing
  `ItemNotPurchasableError` shape.
- Selling is **not** region-gated in V1 (global `sell_value`), but the method still runs from a
  region shop screen. Do not add a region check that content cannot express yet.

### 4.2 Audit trail

Reuse `shop_transactions` with a signed convention rather than a new table:

- Add `kind text NOT NULL DEFAULT 'purchase'` with `CHECK (kind in ('purchase','sale'))` in
  migration `0036_shop_sales.sql`.
- A sale writes `kind = 'sale'`, positive `quantity`, `unit_price = sell_value`, and
  `balance_after` as the post-credit balance.

*Alternative considered:* a separate `shop_sales` table. Rejected — every consumer of the
transaction log (admin tools, future economy dashboards) would need to union two tables forever to
answer "what happened to this player's money".

### 4.3 Discord UI — [waifumon.ts](src/discord/commands/waifumon.ts)

The shop screen (`menu|shop` → `handleShop`) gains a **Sell Items** button alongside the existing
Exchange button. New custom ids, following the existing `buildCustomId(scope, action, ...args)`
convention:

| Custom id | Meaning |
| --- | --- |
| `shop\|sell` | Open the sell screen |
| `shop\|sellqty\|<slug>\|1` / `\|5` / `\|all` | Execute a sale, refresh in place |

Screen contents: one row per sellable stack — emoji, name, `×qty`, `@ N WaifuBux each`, and a
running "total if you sold everything" line. Status line at the top after a sale, exactly like
`handleShopBuy` does today. Empty state: "Nothing here anyone would pay for. Yet."

`Sell All` sells the full stack of **one** item, not the whole inventory. A one-button
"liquidate everything" is a support ticket waiting to happen; if playtesting asks for it, add it
behind a confirmation step.

### 4.4 API

Read-only now, mutation later, respecting the declared Phase 2/3 split:

- `GET /api/v1/players/:playerId/shop/sellable` → `SellableEntry[]` (add now).
- `POST …/shop/sell` → deferred to the API's own Phase 3 mutation work. Note it in
  [routes/v1/index.ts](src/api/routes/v1/index.ts) alongside the other deferred mutations.

### 4.5 Tests (Phase 2)

`tests/integration/shopSelling.test.ts`:

- sells 1 / 5 / all and asserts inventory and balance move together;
- selling more than owned throws and mutates nothing (assert both balance *and* quantity);
- a `sell_value = NULL` item is absent from `getSellableInventory` and `sellItem` throws
  `ItemNotSellableError`;
- a key item without `explicitlySellable` is not listed;
- a disabled item is not listed;
- concurrent sells of the same stack: one succeeds, one throws, final quantity is correct;
- audit row is written with `kind = 'sale'` and the right `balance_after`.

`tests/integration/shopUi.test.ts` (or extend `locationsUi.test.ts`): the Sell button appears,
the screen renders, a sale refreshes in place.

### 4.6 Exit criteria

A player can convert a seeded test salvage item into WaifuBux from a region shop, and nothing else
in the shop changed.

---

## 5. Phase 3 — Expedition domain engine

**Goal:** a UI-agnostic engine that can be driven entirely from tests. Nothing Discord-shaped in
this phase.

### 5.1 Content model

`content/expeditions/<region-id>.json`, one file per region, scanned like
`content/regions/*.json`:

```json
{
  "region": "thirstlands",
  "expeditions": [
    {
      "key": "thirstlands_supply_run",
      "name": "Desert Supply Run",
      "description": "The caravan needs a second pair of hands and nobody asks why.",
      "emoji": "🏜️",
      "type": "supply_run",
      "durationMinutes": 360,
      "teamSize": 1,
      "recommendedLevel": 20,
      "preferredAffinities": ["dominant"],
      "preferredRaces": ["demon"],
      "baseSuccessChance": 0.40,
      "rewardTable": "thirstlands_supply_success",
      "exceptionalRewardTable": "thirstlands_supply_exceptional",
      "failureRewardTable": "expedition_failure_basic",
      "rewardPreview": ["waifubux", "salvage", "charms", "rare_find"],
      "enabled": true
    }
  ]
}
```

Schema rules (in [schemas.ts](src/modules/content/schemas.ts)):

- `key` unique across **all** region files (the loader lints it, like item/species slugs).
- `region` must be in `REGIONS` and must match the filename.
- `durationMinutes` ∈ the configured duration tiers (see §5.2) — free-form durations are how a
  board ends up with a 47-minute mission nobody balanced.
- `teamSize` must be `1` in V1 (schema keeps the field; validation pins the value).
- `preferredAffinities` ⊆ `AFFINITIES`, `preferredRaces` ⊆ `RACE_CODES`, both deduped.
- Every named reward table must exist and be enabled (cross-file lint in
  `validateContentSet`, mirroring the existing boss-reward lint).
- `rewardPreview` entries come from a closed list of display categories — this is what the player
  sees, deliberately decoupled from the actual table contents so a rare find stays a surprise.

### 5.2 Tunables — `content/tables.json` → new `expeditions` block

```jsonc
{
  "enabled": true,
  "durations": { "short": 120, "medium": 360, "long": 720 },   // minutes
  "boardSize": 4,                  // missions shown per region (3–5 per design doc)
  "rotationHours": 12,
  "maxConcurrent": 1,
  "buddyDeployable": false,
  "suitability": {
    "affinityStrong": 0.20,        // preferred-affinity match
    "affinityWeak": -0.15,         // opposed on the wheel
    "raceMatch": 0.10,
    "levelAtOrAbove": 0.10,
    "levelBelowPerLevel": -0.02,   // scaling penalty
    "levelAbovePerLevel": 0.01,
    "levelAboveCap": 0.10,         // bounded bonus
    "minChance": 0.05,
    "maxChance": 0.95
  },
  "exceptional": {
    "baseChance": 0.05,
    "perSuitabilityPoint": 0.25,   // applied to (successChance - baseSuccessChance)
    "maxChance": 0.30
  },
  "bands": { "excellent": 0.80, "good": 0.65, "fair": 0.50, "risky": 0.35 }
}
```

Every number the design doc called "intentionally provisional" is here, and nowhere else. No
balance constant is allowed to appear in a `.ts` file — that is what makes §20 of the design doc
("decisions to validate during playtesting") a content edit rather than a deploy.

### 5.3 Reward tables — `content/expeditionRewards.json`

Reuse the boss table *shape* (independent groups, `chanceBasisPoints` gate, weighted entries),
extended with the non-item reward kinds the design doc requires:

```json
[
  {
    "id": "thirstlands_supply_success",
    "enabled": true,
    "waifubux": { "min": 120, "max": 260 },
    "essence": { "min": 0, "max": 2 },
    "waifuXp": 80,
    "groups": [
      { "id": "salvage", "enabled": true, "rolls": 1, "chanceBasisPoints": 10000,
        "entries": [
          { "itemId": "sunbleached_scrap", "enabled": true, "weight": 6000, "quantity": 2 },
          { "itemId": "cracked_relic_shard", "enabled": true, "weight": 4000, "quantity": 1 }
        ] },
      { "id": "rare-find", "enabled": true, "rolls": 1, "chanceBasisPoints": 150,
        "entries": [ { "itemId": "weathered_treasure_map", "enabled": true, "weight": 1, "quantity": 1 } ] }
    ]
  }
]
```

Validation: every `itemId` exists; **equipment-category items are refused for V1** (§3.3 rule 3);
weights are normalized over *enabled* entries, so disabling one redistributes its share, exactly
as documented in `bossRewards.ts`.

New module `src/modules/expeditions/expeditionRewards.ts` — a pure `rollExpeditionRewards(...)`
that takes the table, a `Rng`, and returns `{ waifubux, essence, waifuXp, items[] }` plus the
warning list for misconfigured groups. Copy the boss module's structure and its comment discipline.

### 5.4 Suitability math — `src/modules/expeditions/expeditionMath.ts`

Pure, no DB, no clock, fully unit-testable:

```ts
export type SuitabilityBand = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'RISKY' | 'POOR';

export interface SuitabilityInput {
  definition: ExpeditionDefinition;
  waifu: { level: number; affinity: Affinity; race: RaceCode };
  config: ExpeditionConfig;
}

export interface SuitabilityResult {
  successChance: number;        // clamped, internal only
  band: SuitabilityBand;        // the only thing ever rendered
  exceptionalChance: number;
  factors: SuitabilityFactor[]; // { label, delta } — for tooltips and tests
}

export function evaluateSuitability(input: SuitabilityInput): SuitabilityResult;
```

Affinity resolution reuses the existing wheel semantics from
[affinityMath.ts](src/modules/capture/affinityMath.ts): a preferred affinity is a *strong* match;
an affinity the preferred one beats on the wheel is *weak*; `switch` and everything else is
neutral. Do not invent a second affinity comparison — extract or reuse `getAffinityMatchup`.

Race comes from the injected resolver, never a column: `deps.resolveRace(speciesRow)`.

`factors` exists so the tests assert *why* a chance is what it is, and so a future
"Affinity Read"-style flavour line has something to read. It is not rendered as numbers in V1.

### 5.5 State — migration `0037_expeditions.sql`

```sql
CREATE TABLE "player_expeditions" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (...),
  "player_id" bigint NOT NULL REFERENCES "players"("id"),
  "expedition_key" text NOT NULL,
  "region" text NOT NULL,
  "waifu_id" bigint NOT NULL,              -- no FK, matches buddy/care-mode precedent
  "status" text NOT NULL DEFAULT 'active',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completes_at" timestamptz NOT NULL,
  "success_chance" real NOT NULL,
  "exceptional_chance" real NOT NULL,
  "suitability_band" text NOT NULL,
  "resolution_roll" real,
  "outcome" text,                           -- failure | success | exceptional
  "rewards" jsonb,                          -- resolved payload, written once
  "resolved_at" timestamptz,
  "claimed_at" timestamptz,
  "logic_version" integer NOT NULL DEFAULT 1,
  CONSTRAINT "player_expeditions_status_check"
    CHECK ("status" in ('active','resolved','claimed','cancelled')),
  CONSTRAINT "player_expeditions_outcome_check"
    CHECK ("outcome" is null or "outcome" in ('failure','success','exceptional')),
  CONSTRAINT "player_expeditions_region_check" CHECK ("region" in (<REGION_SQL_LIST>)),
  CONSTRAINT "player_expeditions_resolved_shape_check"
    CHECK (("status" = 'active') = ("resolved_at" is null)),
  CONSTRAINT "player_expeditions_claimed_shape_check"
    CHECK (("claimed_at" is null) or ("resolved_at" is not null))
);

CREATE UNIQUE INDEX "player_expeditions_one_active_uq"
  ON "player_expeditions" ("player_id") WHERE "status" = 'active';

CREATE UNIQUE INDEX "player_expeditions_waifu_active_uq"
  ON "player_expeditions" ("waifu_id") WHERE "status" = 'active';

CREATE INDEX "player_expeditions_due_idx"
  ON "player_expeditions" ("completes_at") WHERE "status" = 'active';

CREATE INDEX "player_expeditions_player_history_idx"
  ON "player_expeditions" ("player_id", "started_at" DESC);
```

Why these shapes:

- **Two partial unique indexes** enforce "one active expedition per player" and "a deployed
  WaifuMon cannot be deployed twice" in the database. `maxConcurrent` in config remains the
  *player-facing* rule; if it ever rises above 1 the index becomes a migration, which is the right
  amount of friction for a change that large.
- `waifu_id` carries no FK, matching the documented precedent for `buddy_waifu_id` and
  `care_mode_waifu_id`. The service self-heals when the copy is soft-released mid-mission
  (see §5.7).
- `rewards` is a **resolved payload**, not a table reference. What the player won must survive a
  content edit that retunes the table they won it from.
- `logic_version` mirrors `BOSS_REWARD_LOGIC_VERSION`: it records which derivation produced a row,
  so a future change to the maths is auditable rather than retroactive.
- The two shape CHECKs make the state machine's illegal states unrepresentable rather than
  merely unreached.

### 5.6 Service — `src/modules/expeditions/expeditionService.ts`

```ts
export interface ExpeditionService {
  /** The player's current board for their current region. Deterministic per (player, region, window). */
  getBoard(playerId: number): Promise<ExpeditionBoard>;

  /** Owned, unreleased, not-deployed, not-buddy copies with a suitability band each. */
  getCandidates(playerId: number, expeditionKey: string): Promise<ExpeditionCandidate[]>;

  /** One transaction: validate → compute chances → insert ACTIVE. Unique index is the race guard. */
  deploy(playerId: number, expeditionKey: string, waifuId: number): Promise<ActiveExpedition>;

  /** The active/resolved row, resolving it in place if it is due. Safe to call on every screen open. */
  getActive(playerId: number): Promise<ExpeditionView | null>;

  /** Grant the resolved rewards exactly once and mark CLAIMED. */
  claim(playerId: number, expeditionId: number): Promise<ExpeditionClaimResult>;

  /** History for the profile/portal. */
  getHistory(playerId: number, limit?: number): Promise<ExpeditionView[]>;
}
```

**Resolution — the idempotency argument.** One statement claims the row:

```sql
UPDATE player_expeditions
   SET status = 'resolved', resolved_at = now(),
       outcome = $1, resolution_roll = $2, rewards = $3
 WHERE id = $4 AND status = 'active' AND completes_at <= now()
RETURNING *;
```

No row returned ⇒ somebody else already resolved it ⇒ re-read and return their result. The outcome
and rewards are computed *before* the UPDATE from the deterministic RNG seeded on
`(id, purpose)` — so even in the impossible case where two workers both computed, they computed
the *same* thing. Two independent guarantees, which is the right number for the one operation in
this feature that must never double-pay.

**Claiming** is the same shape: conditional `UPDATE … WHERE status = 'resolved' AND claimed_at IS
NULL RETURNING`, and the grants (currency, essence, waifu XP, inventory adds) happen inside that
same transaction, driven off the returned `rewards` payload. A claim that loses the race grants
nothing and reports the already-claimed result.

**Grant composition** — all inside one `db.transaction`:

| Reward | Path |
| --- | --- |
| WaifuBux | `currency.grantWaifubux(tx, …)` |
| Essence | `essenceAward` (so the Buddy Bonus applies consistently with every other Essence award) |
| WaifuMon XP | `collection.awardWaifuXp(tx, playerId, waifuId, xp)` — awarded to the **deployed** copy |
| Items | `inventory.addItem(tx, …)` per stack |
| Player XP | `progression.grantXp(tx, …)` if a table ever grants it |

No new grant primitives. The design doc's "integrate with existing reward services rather than
forcing a premature global reward-system rewrite" is satisfied by this table having five rows and
no sixth.

### 5.7 Edge cases to handle explicitly (each gets a test)

| Case | Behaviour |
| --- | --- |
| Deployed copy is released/converted mid-mission | Block the release (`WaifuReleaseBlockedError` already exists and is the established pattern) rather than orphaning the mission. |
| Deployed copy is set as Buddy mid-mission | Blocked, symmetric with the "buddy cannot deploy" rule. |
| Player travels regions while deployed | Allowed. The mission is already in flight; region only gates the *board*. |
| Player's current region has no expedition content | Board renders an empty state; nothing throws. |
| Expedition key disappears from content while active | Resolution uses the persisted chances and the persisted table name; a missing table resolves as `failure` with the `expedition_failure_basic` fallback and logs loudly. The player is never stranded. |
| `expeditions.enabled = false` in tables.json | Board and deploy are hidden/refused; **already-active missions still resolve and claim.** A kill switch must not eat someone's twelve hours. |
| Clock skew / `completes_at` in the future | `getActive` returns remaining time; resolution's `completes_at <= now()` is evaluated in Postgres, not Node. |

### 5.8 Tests (Phase 3)

Unit (`tests/unit/`):
- `expeditionMath.test.ts` — every factor in isolation, clamping at both ends, band boundaries,
  exceptional chance derivation, a table-driven matrix of affinity × race × level.
- `expeditionRewards.test.ts` — group independence, disabled-entry weight redistribution, a group
  that can produce nothing yields a warning not a crash, deterministic RNG reproducibility.
- `expeditionBoard.test.ts` — rotation determinism: same inputs ⇒ same board; the board changes at
  the window boundary and not before; two players in one region get different boards.

Integration (`tests/integration/expeditions.test.ts`):
- deploy → time-travel the row's `completes_at` → resolve → claim → balances and inventory move
  exactly once;
- **calling `getActive` five times resolves once** (assert `resolved_at` is stable and rewards
  identical);
- **two concurrent `claim` calls**: one grants, one reports already-claimed, balance moved once;
- second deploy while active is rejected by the unique index, surfaced as a clean error;
- deploying the active Buddy is rejected;
- deploying an already-deployed copy is rejected;
- failure outcome still grants the consolation table;
- a simulated restart (new service instance, same database) resolves a mission deployed by the old
  one — the acceptance criterion about bot restarts, tested directly.

### 5.9 Exit criteria

The full loop is exercisable from integration tests with no Discord code in the repo yet, and the
restart and double-claim tests pass.

---

## 6. Phase 4 — Discord gameplay

New command file `src/discord/commands/waifumonExpeditions.ts`, registered in
[commandRegistry.ts](src/discord/commandRegistry.ts), plus a menu entry on the main
`/waifumon` screen. Custom-id scope: `exp`.

| Screen | Entry | Contents |
| --- | --- | --- |
| Board | `menu\|expeditions` | Region banner, 3–5 missions: emoji, name, duration, recommended level, preferred affinity/race chips, `rewardPreview` icons. One button per mission (`exp\|view\|<key>`). Rotation countdown in the footer. |
| Mission detail | `exp\|view\|<key>` | Flavour text, full preview, and a candidate select menu (`exp\|pick\|<key>`) listing owned copies sorted by band, each labelled `EXCELLENT ✦ Lv.24 Lilith`. |
| Deploy confirm | `exp\|pick\|<key>` → `exp\|deploy\|<key>\|<waifuId>` | Restates duration, completion time as a Discord `<t:…:R>` timestamp, and the band. One confirm button. |
| Active | `menu\|expeditions` while deployed | Who is out, where, remaining time (`<t:…:R>`, so Discord renders the countdown and the bot never edits a message on a timer), and a disabled/enabled Collect button. |
| Results | `exp\|claim\|<id>` | Outcome banner (failure / success / exceptional), the deployed copy, the reward list formatted with the existing reward formatter in [waifumon.ts](src/discord/commands/waifumon.ts#L1350), and any level-up toasts the shared path already emits. |

UI rules:

- **Never render a percentage.** The band is the contract with the player.
- Remaining time uses Discord's relative timestamp, not a rendered string — no message editing
  loop, no drift, and it keeps working while the bot is down.
- Opening the board is what resolves a due mission (`getActive` first, always).
- Reuse `playChannelGuard`, the ephemeral session helpers, and `commandError` exactly as the
  existing commands do.

Tests: `tests/integration/expeditionUi.test.ts` following the shape of
`locationsUi.test.ts` / `bossUi.test.ts` — screens render, buttons carry parseable custom ids, the
deploy → collect path drives the service, and a stale custom id from a previous mission is
rejected cleanly.

---

## 7. Phase 5 — Content & economy

Only after the engine has survived playtesting.

1. **Salvage items**: 5–8 per region, themed per the design doc §12, all `category: 'salvage'` with
   a `sellValue` and no `shopRegions`. Sketch the value ladder first — common scrap ~25–40,
   regional trade good ~80–150, rare curio ~300+ — then write the items to fit it.
2. **Reward tables**: success / exceptional / failure per mission family; one shared
   `expedition_failure_basic`.
3. **Expedition pools**: 4–6 missions per region across the six types in design doc §15.
4. **Tuning pass**: instrument expected WaifuBux per active day against the Caravan Pass (1000) and
   route prices (1500 / 2000) in `content/tables.json` → `travel`, and against the daily claim.
   Target a deliberate ratio and write it down in this file when chosen.
5. A `tests/integration/expeditionContent.test.ts` that asserts the *shipped* content validates,
   every reward table resolves, and no expedition references a disabled item — the same guarantee
   the boss content lint already gives.

---

## 8. Phase 6 — Key item hooks

- Introduce 3–5 key items; at least one with no revealed purpose (the design doc's "Sealed Black
  Envelope" pattern).
- World Encounter integration: the `consume_item` effect already exists in
  [effectExecutor.ts](src/modules/worldEncounters/effectExecutor.ts#L386). Add a
  **requirement** counterpart — a choice-level `requires_item` gate — so key items are checked
  through the canonical item-requirement language rather than ad-hoc `has item?` code, exactly as
  design doc §8 asks. This is the one piece of Phase 6 that is new engine work rather than content.
- Special expeditions gated on a key item: add optional `requiresItem: { slug, quantity, consume }`
  to the expedition definition schema, checked in `deploy`.

---

## 9. Phase 7 — Expansion (not planned in detail here)

Multi-Waifu teams, expedition-triggered World Encounters, completion DMs (this is when the worker
tick from §2 earns its keep), achievements, equipment mechanics, portal and Activity UI. Each
deserves its own planning pass. The V1 state model supports all of them because `outcome` is an
enum rather than a boolean and `rewards` is an open payload.

---

## 10. Platform API surface

Read-only in V1, matching the current Phase 2/3 split in
[routes/v1/index.ts](src/api/routes/v1/index.ts):

| Route | Returns |
| --- | --- |
| `GET /players/:playerId/expeditions/board` | The board with per-mission preview (no candidate evaluation) |
| `GET /players/:playerId/expeditions/active` | Active/resolved view, including remaining seconds |
| `GET /players/:playerId/expeditions/history?limit=` | Recent resolved/claimed rows |
| `GET /players/:playerId/shop/sellable` | Phase 2 output |

New schema file `src/api/schemas/expeditions.ts`; resource mappers in
[resources.ts](src/api/resources.ts). `successChance` and `resolutionRoll` are **not** serialized —
band only, on every surface, so a portal client cannot leak what the Discord UI deliberately hides.

Deferred to the API's mutation phase: `POST …/expeditions/deploy`, `POST …/expeditions/:id/claim`.

---

## 11. File manifest

**New**

```
src/modules/expeditions/expeditionMath.ts          # pure suitability + bands
src/modules/expeditions/expeditionRewards.ts       # pure weighted roller
src/modules/expeditions/expeditionRandom.ts        # deterministic hash RNG (mirrors bossRandom)
src/modules/expeditions/expeditionBoard.ts         # deterministic rotation
src/modules/expeditions/expeditionService.ts       # state machine, transactions, idempotency
src/modules/expeditions/types.ts
src/discord/commands/waifumonExpeditions.ts
src/api/routes/v1/expeditions.ts
src/api/schemas/expeditions.ts
content/expeditions/<region>.json                  # one per region
content/expeditionRewards.json
drizzle/0035_item_categories_and_sell_value.sql
drizzle/0036_shop_sales.sql
drizzle/0037_expeditions.sql
```

**Modified**

```
src/db/schema.ts                    # categories, sell_value, player_expeditions, shop kind
src/modules/content/schemas.ts      # item fields, expedition + reward table schemas
src/modules/content/loader.ts       # read + cross-validate expedition content
src/modules/content/seeder.ts       # sell_value in the mutable block
src/modules/shop/shopService.ts     # getSellableInventory, sellItem
src/modules/collection/collectionService.ts  # release/buddy guards for a deployed copy
src/shared/errors.ts                # ItemNotSellableError, expedition errors
src/discord/commands/waifumon.ts    # Sell screen, inventory categories, menu entry
src/discord/commandRegistry.ts      # register the new command
src/index.ts                        # wire createExpeditionService (with resolveRace injected)
src/api/routes/v1/index.ts          # register expedition + sellable routes
src/api/resources.ts                # item resource gains sellValue/category
```

---

## 12. Sequencing and review gates

```
Phase 1 (item foundation)  ──►  Phase 2 (selling)  ──►  Phase 3 (engine)  ──►  Phase 4 (Discord)
        │                                                      │
        └── independently shippable ───────────────────────────┴── playtest gate before Phase 5
```

Phases 1 and 2 are shippable on their own and change nothing a player can see until content is
authored — they are safe to merge early. Phase 3 is the one worth reviewing hardest; the
idempotency argument in §5.6 is the review checklist. Do not begin Phase 5 content authoring until
Phase 4 has been played, per the design doc's "do not author dozens of missions before the
mechanics are proven".

---

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Double-granting rewards | Conditional-UPDATE claim + deterministic RNG + partial unique indexes. Three independent mechanisms, tested concurrently. |
| An idle currency printer | Salvage is the primary payout and must be *sold*, which is an active step; direct WaifuBux stays modest. Tune against travel costs in Phase 5 with a written target. |
| Race resolution drift | Use the injected `resolveRace`; do **not** add a `species.race` column. |
| Reward-table divergence from bosses | Accepted and deliberate for V1. Revisit unification only after both have shipped; the shapes are close enough that a later merge is mechanical. |
| Content lint gaps letting a broken mission reach players | Every cross-reference (expedition → table → item) is validated at boot, and a shipped-content test asserts it in CI. |
| A deployed copy being released | Blocked at the release path with the existing error type, tested. |
| Balance constants leaking into code | All tunables live in `content/tables.json`; a review rule, and cheap to spot. |

---

## 14. Open questions for the design owner

These do not block Phase 1 or 2, but should be answered before Phase 4 ships:

1. Should failure consolation rewards be flat, or scale with the suitability band the player
   accepted? (Scaling rewards risk-taking is more interesting; flat is easier to explain.)
2. Should an expedition be cancellable, and at what cost? The schema reserves `cancelled`; nothing
   currently sets it.
3. Should the deployed copy be visibly "away" on the collection screen, or only on the expedition
   screen? (Recommend visible — a missing favourite with no explanation reads as a bug.)
4. Does exceptional success replace the success table or roll *in addition to* it? The plan assumes
   replace; the boss engine's independent-groups model makes "in addition" trivial if preferred.
