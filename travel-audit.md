# WaifuMon — Locations, Travel, Regional Encounters & Expansion Content Packs

## Repository Audit & Implementation Plan

> **Status:** Audit only. No source files, migrations, generated artifacts, or content were modified during this pass. All paths and line numbers below were verified against the current worktree.

---

## Legend for classifying decisions

Throughout this document each recommendation is tagged:

- **[SETTLED]** — product decision already made by the user; treat as a requirement.
- **[RECOMMEND]** — a technical choice I recommend based on the audit; open to change.
- **[CLARIFY]** — a genuine open question that should be answered before implementation.

---

## 1. Current architecture findings

### 1.1 Content model is a JSON → Zod → Postgres hybrid

Species (and items, tables, bosses) are authored as JSON under [content/](/home/whistler/Projects/WaifuMon/content), validated with Zod at startup, then **seeded into Postgres**. Runtime gameplay reads exclusively from Postgres and never touches JSON again after boot.

- Loader: [loader.ts](/home/whistler/Projects/WaifuMon/src/modules/content/loader.ts)
  - `readContentFiles(contentDir)` ([loader.ts:477](/home/whistler/Projects/WaifuMon/src/modules/content/loader.ts:477)) assembles the in-memory `LoadedContent`.
  - `listSpeciesFiles(speciesDir)` ([loader.ts:517](/home/whistler/Projects/WaifuMon/src/modules/content/loader.ts:517)) globs **only** `content/species/*.json`.
  - `validateContentSet(content)` ([loader.ts:368](/home/whistler/Projects/WaifuMon/src/modules/content/loader.ts:368)) enforces cross-file invariants (unique IDs, referential integrity).
- Schemas: [schemas.ts](/home/whistler/Projects/WaifuMon/src/modules/content/schemas.ts) (Zod definitions for species, items, tables).
- Seeder: [seeder.ts](/home/whistler/Projects/WaifuMon/src/modules/content/seeder.ts) writes validated content into the `species`/`items`/etc. tables.
- Reload service: [reloadService.ts](/home/whistler/Projects/WaifuMon/src/modules/content/reloadService.ts) supports hot reload of content into the DB.

**Answer to audit question 14 (JSON vs DB vs hybrid):** Species are a **hybrid** — canonical source is JSON, load-bearing runtime store is Postgres. Therefore region/species relationships should be **authored in JSON** (region files + species tags) and **materialised into Postgres** at seed time so the hunt query can filter without reading files. This mirrors how the whole content pipeline already works.

### 1.2 The expansion folder is real but orphaned

- [content/expansions/flaccid_foothills/flaccid_foothills_species.json](/home/whistler/Projects/WaifuMon/content/expansions/flaccid_foothills/flaccid_foothills_species.json) is a valid, fully-authored species file (`tags: ["expansion"]`).
- [content/expansions/twin_peaks/](/home/whistler/Projects/WaifuMon/content/expansions/twin_peaks) exists but is **empty**.
- **Nothing loads either folder.** `listSpeciesFiles()` scans only `content/species/`, so every file under `content/expansions/` is dead content today. This is the single biggest gap the feature must close.

### 1.3 Region infrastructure already exists — for bosses only

- [regions.ts](/home/whistler/Projects/WaifuMon/src/modules/bosses/regions.ts) is the canonical region module:
  - `REGIONS = ['waifu-valley'] as const` and `type Region`.
  - `DEFAULT_REGION = 'waifu-valley'`.
  - `isRegion()` guard and `regionLabel()` formatter (`"waifu-valley"` → `"Waifu Valley"`).
  - Note the deliberate kebab-case region ids vs. snake_case item/species slugs.
- The boss subsystem already persists a region on guild state and validates boss content against `REGIONS`. **This is the template to extend** — not a parallel system to invent. The travel feature should promote `regions.ts` from a boss-local module to a shared location primitive (or re-export it) and add `'twin-peeks'` to `REGIONS`.

### 1.4 No player-facing regional state exists yet

Verified absent in [schema.ts](/home/whistler/Projects/WaifuMon/src/db/schema.ts):

- `players` has **no** `current_region` column (grep for `current_region`/`currentRegion` → no matches).
- `species` has **no** `region` column.
- `encounters` has **no** region snapshot column.
- No pass / route-unlock tables exist.

### 1.5 Purchase transaction pattern is well established

[shopService.ts](/home/whistler/Projects/WaifuMon/src/modules/shop/shopService.ts) `purchase()` is the reference pattern: lock currency row → validate eligibility/capacity **before** charging → conditional deduct → grant atomically → write an audit row (`shop_transactions`) — all inside one `db.transaction`. Pass/route purchases should reuse this exact shape.

---

## 2. Encounter pipeline trace (button → completion)

Entry is the **Hunt button** in the embedded Waifumon menu (there is no free-standing behaviour outside the embed session), routed through [waifumon.ts](/home/whistler/Projects/WaifuMon/src/discord/commands/waifumon.ts) into [huntService.ts](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts).

`huntService.hunt(playerId, channelId, now)` ([huntService.ts:227](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:227)) runs one DB transaction:

1. **Lock player + currency rows.** Player fetched/locked ([:244](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:244)).
2. **One-active-encounter invariant.** Selects any `state='active'` encounter for the player ([:251](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:251)); expired ones are swept to a terminal state ([:257](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:257)). Backed by a unique partial index on `(playerId) WHERE state='active'`.
3. **Charge energy + cooldown.** Deduct energy from `player_currencies` ([:312](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:312)); set `lastHuntAt = now` ([:314](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:314)).
4. **Roll result kind** from `tables.hunt.resultTable` ([:347](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:347)) (encounter / flavor / item / etc.).
5. **Species selection** — `pickEncounterSpecies(tx, player.level)` ([:188](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:188)):
   - Build a level-adjusted rarity table via `rarityEntriesFor(level)` ([:170](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:170)) (level shifts weight between rarities).
   - Up to `MAX_RARITY_REROLLS = 6` ([:157](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:157)): roll a rarity, then
     ```
     SELECT * FROM species WHERE rarity = ? AND enabled = true
     ```
     ([:197–198](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:197)). **← the only species filter is `rarity` + `enabled`. No region filter exists. This is the exact seam for regional encounters.**
   - Weight the returned rows by `Math.max(1, s.perSpeciesWeight)` and `rollWeighted` ([:204](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:204)).
   - Absolute fallback: any `enabled` species at all ([:210](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:210)).
6. **Persist encounter.** Insert into `encounters` ([:369](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:369)) with `state='active'`, `expiresAt`, `speciesId`.
7. **Capture path.** On the follow-up capture interaction, active encounter is re-read and joined to `species` ([:488–491](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:488)), locked ([:502](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:502)), and resolved to a terminal `state` ([:516](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:516)). Capture math lives in [captureService.ts](/home/whistler/Projects/WaifuMon/src/modules/capture/captureService.ts) / [captureMath.ts](/home/whistler/Projects/WaifuMon/src/modules/capture/captureMath.ts) / [affinityMath.ts](/home/whistler/Projects/WaifuMon/src/modules/capture/affinityMath.ts).

**Ordering conclusions (audit questions 2–4):**

- Order of operations is: **lock → invariant → charge → roll kind → roll rarity → region-blind species query → weight → persist → (later) capture**.
- The *only* change needed for regional encounters is at step 5's `SELECT`. Everything upstream (energy, cooldown, invariant) and downstream (capture math) must remain untouched.
- **Capture calculations must stay region-agnostic** ([SETTLED]). The capture services read from `encounters`⋈`species` and player stats only — no region is threaded in today, and none should be. To keep it that way, region must **not** be added as a parameter to capture math; it should influence *which species row* is selected, never the capture formula, rarity, energy cost, or cooldown.

---

## 3. Recommended content-pack structure [RECOMMEND]

Adapt the conceptual `content/expansions/<name>/…` layout to the existing pipeline rather than inventing a parallel one. Target per-expansion layout:

```
content/
  species/                 # existing base (Waifu Valley) species — unchanged
  items.json, tables.json, bosses.json, bossRewards.json   # existing core files
  expansions/
    twin_peaks/
      expansion.json        # { id, name, enabled, regionId, order }
      region.json           # region def + encounter pool (species ids + weights)
      species/*.json        # canonical species schema, globally-unique ids
      shop.json             # regional shop inventory (reuses item schema/refs)
```

Design rules (several are [SETTLED] product decisions):

- Expansion species **use the canonical species schema** — no per-expansion schema. [SETTLED]
- Species IDs remain **globally unique** across core + all expansions. [SETTLED] Enforced in `validateContentSet`.
- Runtime receives **one normalized species registry** (one `species` table). No per-region/per-expansion tables. [SETTLED]
- **Expansion origin ≠ encounter availability.** A species' home expansion is metadata; where it can be *encountered* is defined by region encounter pools. [SETTLED] → store origin as a species field/tag, and availability as region-pool membership.
- `expansion.json` carries an `enabled` flag so a whole pack can be disabled without deleting files. [SETTLED — "enabled/disabled expansion support"]
- The existing [flaccid_foothills](/home/whistler/Projects/WaifuMon/content/expansions/flaccid_foothills) folder should be brought under this schema (or explicitly marked disabled) as part of the work so it stops being silent dead content.

**Loader change:** add an expansion-discovery pass that walks `content/expansions/*/` for enabled packs and folds their `species/*.json` into the same species list `listSpeciesFiles()` produces, plus a new region/pool list. Species from disabled expansions are skipped entirely.

**[CLARIFY]** Base species filename convention: base lives in `content/species/`, expansion species in `content/expansions/<x>/species/`. Should the base Waifu Valley pool also be modelled as an implicit "core" region pool for symmetry, or remain the special "everything not region-exclusive" default? (See §4 region-pool semantics.)

---

## 4. Recommended database changes [RECOMMEND]

All via Drizzle: edit [schema.ts](/home/whistler/Projects/WaifuMon/src/db/schema.ts), then `npm run db:generate` to emit the next sequential migration under [drizzle/](/home/whistler/Projects/WaifuMon/drizzle).

### 4.1 `players.current_region`
```
current_region TEXT NOT NULL DEFAULT 'waifu-valley'
  CHECK (current_region IN (<REGIONS>))
```
- No backfill needed — default covers all existing players (everyone starts in Waifu Valley). [SETTLED]
- Mirrors the existing `guild_boss_state.region` column pattern.

### 4.2 Region → species availability

**[RECOMMEND] Option A (chosen): `region_encounter_pools` table** rather than a single `species.region` column, because the feature needs **per-region encounter weights** and **the same species appearing in multiple regions at different rates** — which a scalar column cannot express.

```
region_encounter_pools (
  region_id   TEXT NOT NULL,
  species_id  TEXT NOT NULL REFERENCES species(id),
  weight      INTEGER NOT NULL CHECK (weight > 0),
  PRIMARY KEY (region_id, species_id)
)
-- index on (region_id) for the hunt query
```
Plus a lightweight `species.region_exclusive BOOLEAN NOT NULL DEFAULT false` (or reuse a tag) so validation can enforce "a region-exclusive species must not appear in more than one permanent regional pool." [SETTLED validation requirement]

Waifu Valley's pool = the curated base set (today: all base species, expressed as a pool seeded from `content/species/`). Twin Peeks' pool = its 10 exclusives + selected base species at boosted weights. [SETTLED]

> **Option B (rejected):** `species.region` scalar column — simpler, but cannot represent shared-species-with-different-weights, which is an explicit product requirement. Recorded here as the main technical fork.

### 4.3 Pass ownership (separate from route unlocks) [SETTLED — track separately]

```
player_travel_passes (
  player_id  <fk> PRIMARY KEY,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source     TEXT NOT NULL DEFAULT 'purchase'   -- 'purchase' | 'admin'
)

player_unlocked_routes (
  player_id  <fk>,
  region_id  TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source     TEXT NOT NULL DEFAULT 'purchase',
  PRIMARY KEY (player_id, region_id)
)
```
- Pass = the container; routes = individual destinations. Owning the pass and owning a given route are independent facts. [SETTLED]
- Purchasing the initial pass grants the pass row **and** the Twin Peeks route row atomically. [SETTLED]
- Uniqueness on `(player_id)` / `(player_id, region_id)` makes "cannot buy twice" a DB-level guarantee, so a duplicate concurrent request fails cleanly instead of double-charging. [SETTLED]

### 4.4 Purchase audit
Reuse the existing `shop_transactions` audit pattern, or add a `travel_transactions` table with the same shape (`player_id, kind, region_id, amount, currency, created_at`). [RECOMMEND] Reuse the shop audit table if its `kind` column is open-ended; otherwise add a dedicated one.

### 4.5 Regional shop
**[RECOMMEND]** Do **not** duplicate the shop system. Add regional catalog membership via an `items.region_id TEXT NULL` (NULL = available everywhere / core) **or** a `region_shop_items(region_id, item_id)` junction if an item can appear in several regional shops. Given the same-item-multiple-regions concern that drove §4.2, the junction table is the consistent choice. [CLARIFY] whether any regional shop item is ever shared across regions; if never, the scalar column is cheaper.

### 4.6 Encounter region snapshot [RECOMMEND]
Add `encounters.region_id TEXT NULL` capturing the player's region at hunt time. Not strictly required (capture ignores region), but valuable for analytics and for making an encounter's origin auditable after a later travel. Low risk, additive.

### 4.7 Config table/content for prices & requirements [SETTLED — must be configurable]
Pass price (1,000 Waifubux), pass level requirement (15), and per-route unlock fees must be **content/config-driven**, not hard-coded. Put them in `tables.json` (or a new `travel` section there) so they load through the existing pipeline.

---

## 5. Recommended service boundaries [RECOMMEND]

New module `src/modules/travel/` (peer to `hunt/`, `shop/`, `bosses/`):

- **`regionService`** — read player's `current_region`; list released/eligible destinations; format region info. Pure reads.
- **`passService.purchasePass(playerId)`** — transactional: lock currency → assert level ≥ configured (15) → assert no existing pass → deduct configured price (1,000) → insert `player_travel_passes` → insert initial `player_unlocked_routes` (Twin Peeks) → audit. Insufficient funds or existing pass ⇒ no balance change. [SETTLED]
- **`routeService.unlockRoute(playerId, regionId)`** — transactional: lock currency → assert pass owned → assert route not already owned → deduct route fee → insert route → audit.
- **`travelService.travel(playerId, regionId)`** — assert route unlocked (or region is Waifu Valley, always free) → **block if an active hunt encounter exists** → update `players.current_region`. Care, scavenging origin, and boss participation are untouched. [SETTLED]
- **Regional encounter resolution** — a small change inside `huntService.pickEncounterSpecies`: read `player.current_region`, query `region_encounter_pools` joined to `species` (filtered by rarity + enabled) instead of the global `species` query, weighting by pool `weight`. Fall back to Waifu Valley pool if a region has no bucket at the rolled rarity, then to the existing global fallback.

Admin grant/revoke = thin functions on `passService`/`routeService` that insert/delete rows with `source='admin'`, bypassing currency. No admin UI required in v1. [SETTLED]

All services follow the shop `db.transaction` + row-lock discipline so concurrent/duplicate interactions are safe. [SETTLED]

---

## 6. UI / component integration plan [RECOMMEND, within SETTLED constraints]

Constraints: **no new `/location` or `/travel` slash commands**; reached via a **Locations button in the existing embed**, using the established embed/component-session patterns. [SETTLED]

- Add a **Locations** button to `menuComponents()` in [waifumon.ts](/home/whistler/Projects/WaifuMon/src/discord/commands/waifumon.ts) (the 3-row button layout builder), routed by the existing `buildCustomId(namespace, action, …)` scheme and `interaction.update()` in-place replacement.
- New ephemeral screens (via the existing `respondEphemeral()` / component-session helpers, with `withBackRow(components, 'menu:back')` for return-to-menu):
  1. **Locations home** — shows current region (marked), lists released destinations with per-destination state.
  2. **Destination detail** — region info, eligibility requirements, and the correct action for its state.
  3. **Purchase confirm** — required confirmation step before any pass/route purchase. [SETTLED]
  4. **Regional shop** — reuses the existing shop rendering with a region filter, not a new shop UI.
- **Destination state → rendering** [SETTLED semantics]:
  - Unreleased/disabled ⇒ hidden.
  - Released but ineligible ⇒ visible, requirements shown, no buy action.
  - Eligible but locked ⇒ price + purchase action.
  - Unlocked ⇒ travel action.
  - Current location ⇒ clearly marked, travel action disabled.
- Reuse the existing interaction-locking so a player can't fire concurrent travel/purchase actions from stale components. [SETTLED — concurrency safety]

---

## 7. Validation changes in content preparation [SETTLED requirements]

Extend `validateContentSet()` ([loader.ts:368](/home/whistler/Projects/WaifuMon/src/modules/content/loader.ts:368)) and add Zod schemas in [schemas.ts](/home/whistler/Projects/WaifuMon/src/modules/content/schemas.ts) for `expansion.json`, `region.json`, and the travel/pass config. Validation must reject:

1. **Unknown IDs** — encounter-pool `species_id` not present in the merged species registry.
2. **Duplicate IDs** — a species id defined in more than one file (core or expansion).
3. **Invalid weights** — non-positive or non-integer encounter weights.
4. **Invalid pass references** — route/pass config referencing a region id not in `REGIONS`.
5. **Missing starting region** — Waifu Valley must exist and be the default; error if absent.
6. **Region-exclusive species in multiple permanent regional pools** — a species flagged region-exclusive must appear in at most one permanent regional pool.
7. **[RECOMMEND add]** Disabled-expansion references — a region pool must not reference species from a disabled expansion.

These run at load time (fail fast at boot) and in the content-validation test suite.

---

## 8. Testing plan [RECOMMEND]

Existing infra: Testcontainers Postgres + Drizzle migrations, `fixtures.ts` (`bootstrapApp()`, `provisionPlayer()`, `scriptedRng()`), 121 test files, deterministic RNG scripting (e.g. [hunt.test.ts](/home/whistler/Projects/WaifuMon/tests/integration/hunt.test.ts)).

- **Unit**
  - `pickEncounterSpecies` returns only species in the current region's pool; weighting honours pool weights (scripted RNG).
  - Pass/route eligibility predicates (level gate, pass-owned gate, already-owned gate).
  - Region-blind capture math unchanged (regression: same inputs ⇒ same capture outcome regardless of region).
- **Integration (real DB, atomicity)**
  - Purchase pass: success deducts exactly 1,000 and grants pass + Twin Peeks route; insufficient funds leaves balance untouched; second purchase rejected with no charge; two concurrent purchases ⇒ exactly one succeeds.
  - Route unlock: requires pass; charges once; idempotent under duplicates.
  - Travel: blocked with an active encounter; succeeds otherwise; updates `current_region`; care/boss/scavenging rows preserved.
  - Regional hunt: Twin Peeks exclusives are unreachable from Waifu Valley and reachable from Twin Peeks; shared species appear in both at configured weights.
- **Content validation** — one test per §7 rule, each with a crafted bad fixture asserting a specific error.
- **Migration** — apply new migrations over a seeded pre-feature DB; assert existing players default to `waifu-valley`, no data loss, indexes present.
- **Component/interaction** — Locations button routes correctly; each destination state renders the right action; current location disables travel; purchase confirmation required; stale-component concurrency is locked out.

Extend fixtures with `grantPass()`, `unlockRoute()`, and a Twin Peeks content fixture.

---

## 9. Implementation phases (dependency order) [RECOMMEND]

**Phase 0 — Shared region primitive**
- Promote/re-export [regions.ts](/home/whistler/Projects/WaifuMon/src/modules/bosses/regions.ts) as a shared location module; add `'twin-peeks'` to `REGIONS`.
- Files: `src/modules/bosses/regions.ts` (+ possible new `src/modules/travel/regions.ts` re-export).

**Phase 1 — Schema & migrations**
- Add `players.current_region`, `region_encounter_pools`, `player_travel_passes`, `player_unlocked_routes`, (opt.) `encounters.region_id`, regional-shop membership, travel config.
- Files: [schema.ts](/home/whistler/Projects/WaifuMon/src/db/schema.ts); generated migration under [drizzle/](/home/whistler/Projects/WaifuMon/drizzle) via `npm run db:generate`.

**Phase 2 — Content pipeline & validation**
- Expansion schemas; expansion discovery in the loader; merge expansion species into the registry; region-pool loading; seed pools; §7 validation.
- Files: [schemas.ts](/home/whistler/Projects/WaifuMon/src/modules/content/schemas.ts), [loader.ts](/home/whistler/Projects/WaifuMon/src/modules/content/loader.ts), [seeder.ts](/home/whistler/Projects/WaifuMon/src/modules/content/seeder.ts), [reloadService.ts](/home/whistler/Projects/WaifuMon/src/modules/content/reloadService.ts); content under [content/expansions/twin_peaks/](/home/whistler/Projects/WaifuMon/content/expansions/twin_peaks).

**Phase 3 — Travel services**
- New `src/modules/travel/`: `regionService`, `passService`, `routeService`, `travelService` (+ admin grant/revoke).
- Files: new module dir; wire into app bootstrap.

**Phase 4 — Regional encounter resolution**
- Thread `current_region` into `pickEncounterSpecies`; query region pool; fallbacks.
- Files: [huntService.ts](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts) (~[:188–216](/home/whistler/Projects/WaifuMon/src/modules/hunt/huntService.ts:188)) only. Capture services untouched.

**Phase 5 — UI**
- Locations button + ephemeral screens (home, detail, confirm, regional shop) reusing existing patterns.
- Files: [waifumon.ts](/home/whistler/Projects/WaifuMon/src/discord/commands/waifumon.ts); shop rendering reuse in [shopService.ts](/home/whistler/Projects/WaifuMon/src/modules/shop/shopService.ts) (add `getRegionalCatalog(regionId)`).

**Phase 6 — Tests & content finalisation**
- All §8 suites; author Twin Peeks' 10 species + shared-species weights; reconcile the orphaned [flaccid_foothills](/home/whistler/Projects/WaifuMon/content/expansions/flaccid_foothills) pack (adopt schema or mark disabled).

---

## 10. Risks & genuine unresolved decisions

- **[CLARIFY] Region-pool vs. scalar column** — I recommend the `region_encounter_pools` table (§4.2) because shared-species-with-different-weights is an explicit requirement a scalar column can't meet. Confirm before building; it shapes migrations, seeder, hunt query, and validation.
- **[CLARIFY] Base pool modelling** — is Waifu Valley an explicit pool row-set, or the implicit default? Affects whether the hunt fallback is "global species" or "Waifu Valley pool" (§3, §5).
- **[CLARIFY] Regional shop sharing** — can one item appear in multiple regional shops? If yes, junction table; if never, `items.region_id` scalar (§4.5).
- **[CLARIFY] Orphaned `flaccid_foothills` pack** — adopt into the new schema now, or explicitly mark disabled? It currently loads nowhere; leaving it ambiguous risks accidental activation once expansion discovery lands.
- **[RISK] Region enum as CHECK vs. runtime set** — bosses already use a CHECK constraint against `REGIONS`. Adding regions then requires a migration to widen the CHECK. Acceptable and consistent, but note the coupling: content adding a region needs a matching migration.
- **[RISK] Empty `twin_peaks` folder** — content is not authored yet; the exact 10 species, shared species, and weights are deferred by the user and must stay content-configurable. Build the plumbing to be data-driven so no code change is needed when that content arrives. [SETTLED that content comes later]
- **[RISK] Concurrency correctness** — all money/grant paths must stay inside the shop-style locked transaction; the unique constraints on pass/route tables are the real backstop against double-purchase races. Tests in §8 must include the concurrent case explicitly.
- **[NON-RISK, confirmed] Capture, rarity, energy, cooldown, player stats** are structurally isolated from region — region only selects the species row. Keep it that way; do not thread region into capture math. [SETTLED]

---

### One-line summary

The codebase already has the two hooks this feature needs — a JSON→Postgres content pipeline and a boss-side `regions.ts` primitive — but nothing loads `content/expansions/` and no player/species/encounter carries a region. The work is: promote regions to a shared primitive, add region-scoped encounter pools + pass/route tables, teach the loader to ingest expansions, filter exactly one line of the hunt query by region, and surface it all through a Locations button on the existing embed — leaving capture, rarity, energy, cooldown, care, scavenging, and boss state untouched.
