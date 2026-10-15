# RP1: Region Encounter Pool Management Architecture

Status: **design only, not implemented.** Nothing in this document has been built.
Audited at `Delve` `90456c4e3f48ff04433c85ef00a35a1d9f72c7da` with a clean working
tree, on 2026-10-15.

Scope: normal regional hunting pools. Dungeon WaifuMon Pools are a separate,
already-shipped system. This design does not change them, and they must not depend
on anything here.

Each section labels its content:

- **Verified** means read in the current source, schema, migrations or shipped
  content at the audited commit.
- **Recommendation** means proposed design that is not yet approved.

An earlier version of this design is in
[phase4-captures-design.md §13](../dungeons/phase4-captures-design.md). Every claim
in that section was checked again against today's code. Where this document
disagrees with it or goes further, this document is the newer one.

---

## 0. Read this first: critical findings before implementation

There is no blocker. Region Pool Management can be built without touching the
hunt. However, five findings change the work, and each needs to be accepted before
RP2 starts.

| # | Finding (Verified) | Consequence |
| --- | --- | --- |
| C1 | **Shipped JSON owns `region_encounter_pools` today.** On every content seed, [`seedContent`](../../src/modules/content/seeder.ts#L122) runs `DELETE FROM region_encounter_pools` and rebuilds the table from the region files. That seed runs at every startup ([index.ts:209](../../src/index.ts#L209)) and on every legacy admin panel **Reload Content** ([index.ts:1220](../../src/index.ts#L1220)). | Any database edit to a pool is lost at the next restart or reload. The seeder's ownership must change **before** any editor is exposed. This is the single most important change. |
| C2 | The same seeder transaction upserts the `species` rows from JSON. Rarity, `enabled`, `tags` and `per_species_weight` are therefore content-owned and rewritten on every seed. | Region Pools may own **membership and region-local weight only**. A pool cannot change a species' rarity, enabled state or exclusivity tags. Because the species table can change under a published pool, drift detection is required (§8). |
| C3 | Region ids are a **closed code list** ([`REGIONS`](../../src/modules/locations/regions.ts#L27)). CHECK constraints on `region_encounter_pools.region_id` and on several player and boss tables enforce it. Whether a region is released is the JSON `enabled` flag, and the seeder skips disabled regions. | Region Pools cannot create or release regions. Adding a region is still a code change plus a migration. The pool system must keep "disabled region ⇒ no projected rows". |
| C4 | Two consumers read region pools from **in-memory JSON**, not from the database: World Encounter import/selector planning ([encounterImportService.ts:172](../../src/modules/worldEncounters/encounterImportService.ts#L172)) and the startup "unobtainable species" warning ([loader.ts:1532](../../src/modules/content/loader.ts#L1532)). | Once the database owns pools, both would read stale data without warning. Both must be moved to the database in RP2. |
| C5 | The shared integration fixture [`tests/helpers/fixtures.ts:261`](../../tests/helpers/fixtures.ts#L261) calls `seedContent`. 158 test files import that helper, so **almost every integration test gets its region pools from the seeder.** 8 more suites call `seedContent` directly and rely on it rebuilding pools (for example, `dexCompletion` re-seeds with different content), and 9 suites insert into or delete from the table directly. | If the seeder stops writing pools and nothing replaces it, every hunt-dependent test changes behaviour. RP2 must call the same bootstrap-and-project step from the shared fixture, which matches production startup. A few suites also need an explicit "project pools from this content" helper. Assertions must not be weakened. |

Unexpected database ownership: **none.** No production code path writes pools
except the seeder, so no database-authoritative pool state exists today that a
migration could destroy. Any manual SQL hotfix to pools would have been wiped at
the next restart. §4.2 adds a pre-deploy check that confirms this on the real
databases.

---

## 1. Current implementation findings (Verified)

### 1.1 Where pools come from

| Source | Contents |
| --- | --- |
| [`content/regions/waifu-valley.json`](../../content/regions/waifu-valley.json) | Starting region, 100 entries, **no explicit weights** (all inherit `perSpeciesWeight` = 1) |
| `content/expansions/<pack>/region.json` × 5 | `twin-peeks`, `flaccid-foothills`, `thirstlands` (40 entries each), `base-80085`, `assteroid-belt` (30 each). Every entry sets an explicit weight |
| [`RegionEncounterEntrySchema`](../../src/modules/content/schemas.ts#L1969) | `{ species: slug, weight?: positive int }`, strict |

Shipped corpus: 175 species, all `enabled`, all `perSpeciesWeight: 1`. Rarities are
N 58, R 45, SR 33, SSR 20, UR 10 and LR 9. 75 species are tagged `region_exclusive`
and none are tagged `dungeon_exclusive`. There are 280 pool rows. 90 species are
pooled in more than one region (at most 3). Every enabled species is pooled
somewhere.

**Every region covers every hunted rarity today**, so the fallback tiers in §3.3 are
dormant in production:

| Region | N (entries / total weight) | R | SR | SSR | UR | LR |
| --- | --- | --- | --- | --- | --- | --- |
| waifu-valley | 36 / 36 | 27 / 27 | 18 / 18 | 10 / 10 | 5 / 5 | 4 / 4 |
| twin-peeks | 13 / 110 | 11 / 59 | 6 / 34 | 5 / 18 | 3 / 7 | 2 / 2 |
| flaccid-foothills | 16 / 118 | 8 / 56 | 7 / 33 | 3 / 12 | 3 / 5 | 3 / 3 |
| thirstlands | 12 / 93 | 12 / 71 | 8 / 41 | 5 / 20 | 1 / 6 | 2 / 2 |
| base-80085 | 9 / 98 | 8 / 72 | 7 / 48 | 4 / 20 | 1 / 3 | 1 / 1 |
| assteroid-belt | 7 / 80 | 8 / 70 | 5 / 36 | 5 / 25 | 3 / 9 | 2 / 2 |

### 1.2 Content validation (load time, fatal)

[`validateRegionContent`](../../src/modules/content/loader.ts#L456) enforces:

- exactly one `starting` region, equal to `DEFAULT_REGION` (`waifu-valley`), and enabled;
- an enabled region must have a non-empty `encounterPool`;
- no duplicate species within a single pool;
- weights must be positive integers;
- an unknown species slug is fatal, with a separate message when the species
  belongs to a disabled expansion;
- a `dungeon_exclusive` species in **any** pool, enabled or disabled, is fatal;
- a `region_exclusive` species in more than one **enabled** region pool is fatal.

[`warnOnUnpooledSpecies`](../../src/modules/content/loader.ts#L1532) logs enabled
species that appear in no enabled pool as "UNOBTAINABLE". See §5.3 for why that
label is not strictly true.

### 1.3 Database

[`region_encounter_pools`](../../src/db/schema.ts#L1387) was created in
[`0019_locations_travel.sql`](../../drizzle/0019_locations_travel.sql). Its region
CHECK was widened in 0020 and 0042.

| Column | Notes |
| --- | --- |
| `region_id text` | CHECK against the six `REGIONS` |
| `species_id bigint` | FK to `species.id`. Species rows are never deleted, only disabled |
| `weight integer default 1` | CHECK `> 0` |
| PK `(region_id, species_id)`, index on `region_id` | |

The table has no rarity column. A pool row's rarity is always the **current**
`species.rarity`. It also has no revision, audit or author columns.

### 1.4 Every writer of region pool data

| Writer | When | Behaviour |
| --- | --- | --- |
| [`seedContent`](../../src/modules/content/seeder.ts) via [`createContentReloader`](../../src/modules/content/reloadService.ts) | Every startup, after migrations | One transaction: upsert items, disable missing items, upsert species, disable missing species, `DELETE` all pools, then insert pools for **enabled** regions only. A missing weight resolves to `max(1, species.perSpeciesWeight)` ([seeder.ts:136](../../src/modules/content/seeder.ts#L136)) |
| Legacy admin panel **Reload Content** ([adminContentService.ts:943](../../src/modules/content/adminContentService.ts#L943)) | On demand, when `ADMIN_WEB_ENABLED` | The same reloader. The panel can also rewrite species JSON, which is bind-mounted read-write in `docker-compose.yml` |
| Tests | Fixtures | `seedContent`, or direct `insert`/`delete` on the table |

Nothing else writes the table. There is no Portal route, no repair script (the
repository has no `scripts/` directory), and no test control.

### 1.5 Every reader

| Reader | What it reads |
| --- | --- |
| [`huntService.regionBucket`](../../src/modules/hunt/huntService.ts#L313) | Region bucket at one rarity (tier 1, and tier 2 with the valley) |
| [`huntService` valley row](../../src/modules/hunt/huntService.ts#L467) | Reroll-exhausted fallback |
| `huntService.pickSpeciesForSpawn` ([L936](../../src/modules/hunt/huntService.ts#L936)) | The same draw with no Buddy. Used by `WildEncounterSpawner` for unfiltered scripted spawns ([index.ts:795](../../src/index.ts#L795)) |
| [`speciesSelection.regionPool` / `globalPool`](../../src/modules/encounters/speciesSelection.ts#L245) | Filtered World Encounter spawns and Portal selector previews |
| World Encounter import planner | **JSON** `content.regions` (C4) |
| Loader unpooled-species warning | **JSON** (C4) |
| `collectionService.getDexStats` | Deliberately **does not** read pools; the denominator is enabled species |

Systems that do **not** touch pools: travel ([travelCatalog.ts:89](../../src/modules/travel/travelCatalog.ts#L89) reads region metadata only), capture (region-agnostic; `encounters.region_id` is a snapshot only), progression, Buddy, staging test controls, the load-test fixture (slug-ordered species), and dungeons ([`dungeonSpeciesPolicy`](../../src/modules/dungeons/dungeonSpeciesPolicy.ts) reads tags and `dungeonAccess` from content).

---

## 2. Existing seeding and startup behaviour (Verified)

Startup order in [`src/index.ts`](../../src/index.ts):

1. `runMigrations`
2. `reloadContent()`: `loadContent` (Zod + cross-reference validation, fatal on error), then `seedContent`
3. Service construction. `createHuntService` captures `content.tables` **once**: rarity and result tables change only on restart, never on reload.
4. Enemy catalogue seed and boss insert-missing bootstrap. These are DB-authoritative systems that follow the pattern recommended below.

Properties:

- **Idempotent, but JSON-authoritative.** Repeated startups with the same JSON produce
  the same row set.
- **Not order-stable.** Rows are reinserted in JSON order after a full `DELETE`, but
  the hunt query has no `ORDER BY` (see §3.5).
- **A disabled region gets no rows.** A player whose `current_region` is a canonical
  but disabled region would hit the valley fallback on every rarity. Today that
  cannot happen, because all six regions are enabled.

---

## 3. Exact rarity-selection rules (Verified)

### 3.1 Hunt flow, from pressing Hunt to presentation

All steps below run inside one database transaction in `huntService.hunt`:

1. `care.applyPending` (before the transaction).
2. Lock `player_currencies`, then `players` `FOR UPDATE` ([L550](../../src/modules/hunt/huntService.ts#L550)).
3. One active encounter per player. A stale row is expired lazily.
4. Cooldown: `tables.hunt.cooldownSeconds` = 2.
5. Energy ≥ 1.
6. Resolve the active Buddy Bonus **once** ([L596](../../src/modules/hunt/huntService.ts#L596)).
7. `energy_save_chance` proc. The RNG is drawn only when the bonus exists.
8. Spend energy, stamp `lastHuntAt`, grant hunt XP, give the Buddy award, record quest events.
9. **Result roll** ([L694](../../src/modules/hunt/huntService.ts#L694)) over `tables.hunt.resultTable`: encounter 74, item_find 8, waifubux_find 8, essence_find 5, rare_item_find 3, flavor 2. A `hunt_item_find_chance` Buddy scales the two item weights relatively, which changes the encounter share.
10. If the result is `encounter`, take the region from the **locked** player row: `toRegion(player.currentRegion)`. An unknown id becomes `waifu-valley`.
11. `pickEncounterSpecies(tx, playerId, level, region, bonus)` (§3.2–3.3).
12. Insert the `encounters` row (`maxAttempts` 3, expiry 120 s, `region_id` snapshot).
13. The Discord presenter renders the encounter. Capture is a separate later action and is region-agnostic.

### 3.2 Rarity first, then species: confirmed

**Rarity is rolled first, and the species is then drawn only from candidates of that
rarity.** The rarity table is
[`tables.json`](../../content/tables.json) `hunt.rarityTable`:

| N | R | SR | SSR | UR | LR | EX |
| --- | --- | --- | --- | --- | --- | --- |
| 60 | 25 | 10 | 4 | 0.9 | 0.1 | not in the table, so never hunted |

The weights total 100. `EX` is a valid `species.rarity` value but has no hunt weight.

[`rarityEntriesFor(level, bonus)`](../../src/modules/hunt/huntService.ts#L255) builds the table in this exact order:

1. A rarity-scoped `encounter_weight` Buddy (target `rarity`, `rarity_min` or
   `rarity_max`) gives each matching rarity `w × (1 + v/100)`.
2. **Then** the level shift ([`rareEncounterShift`](../../src/modules/progression/progressionMath.ts#L76)): at level ≥ 40, move 1 weight unit from N to R. N is floored at 0, and the total is preserved only when N ≥ 1.

Inside the chosen bucket, each species' weight is its **region-local** pool weight
(`max(1, weight)`). A species-scoped `encounter_weight` Buddy (target `race`,
`affinity` or `ownership`) then multiplies the weight of every matching candidate.
Ownership is resolved for the player with a single query. A bonus with no target
does nothing to encounters.

### 3.3 Tiers and fallbacks (`pickEncounterSpecies`)

For up to `MAX_RARITY_REROLLS` = 6 attempts:

1. Roll a rarity *k*.
2. **Tier 1:** pool rows for the player's region at rarity *k*, where `species.enabled` is true and the species is not `dungeon_exclusive`.
3. **Tier 2:** if tier 1 is empty and the region is not the valley, use **Waifu Valley's pool** at *k* (logged as a warning).
4. **Tier 3:** if still empty, the **global table**: every enabled species at *k* that is not `region_exclusive` and not `dungeon_exclusive`, weighted by `species.per_species_weight`. This ignores region pools entirely (warning).
5. If still empty, **reroll the rarity**, with the same rarity table and the same Buddy.

After 6 empty attempts:

- an arbitrary valley pool row (`LIMIT 1` with no `ORDER BY`);
- otherwise an arbitrary open species;
- otherwise an arbitrary enabled species, **including region exclusives** (logged at error level as an emergency);
- otherwise `null`, and the hunt degrades to `flavor`.

`dungeon_exclusive` species are excluded at every tier.

### 3.4 What a region changes and what it does not

Region changes only *who* is in each rarity bucket and their relative weights.
It does not change the rarity table, the result table, capture chance, energy,
cooldowns, XP, or World Encounter and dungeon probabilities.

### 3.5 Surprising behaviour: documented, deliberately not fixed

| # | Behaviour | Why it matters here |
| --- | --- | --- |
| S1 | An empty rarity tier in a region silently draws **Waifu Valley** species at that rarity. It does not reroll, and it does not stay in the region | Removing a region's last LR species would make every LR roll there produce a valley LR. The editor must warn about this (§8) |
| S2 | Tier 3 can reach enabled species that are in no pool. The loader's "UNOBTAINABLE" warning is therefore only true while every rarity is covered | The warning text overstates the case. Keep it as a coverage warning only |
| S3 | `regionBucket`, the valley `LIMIT 1` row and the global query have **no `ORDER BY`**. `rollWeighted` walks entries in the order returned, so the species chosen by a given random number depends on heap order | The distribution is unaffected. Draw-for-draw reproduction across a reseed is **not** guaranteed today. Parity must be verified as a distribution, not as a seeded sequence (§12) |
| S4 | The Buddy `value` is only `z.number().finite()`. A value ≤ −100 on `encounter_weight` produces a zero or negative weight, which makes `rollWeighted` throw `RangeError` and fails the hunt | No shipped species is affected (all 35 `encounter_weight` bonuses are positive). Out of scope |
| S5 | `EX` species are never hunted, because EX has no row in `rarityTable` | Show EX as "not huntable" in the editor rather than letting it be added silently |
| S6 | The filtered selector's `region` scope uses the region pool **only**: no valley fallback and no global tier. Its `global` scope uses `per_species_weight`, not pool weights | This is a different rule from the hunt. The preview must show which rule applies (§10) |
| S7 | Rarity and result tables are fixed when the service is constructed. Reloading content does not change them | Unchanged, and out of scope |

---

## 4. Proposed tables and data ownership (Recommendation)

### 4.1 Ownership after RP2

| Data | Owner |
| --- | --- |
| Region identity, name, banner, release (`enabled`) | Code list plus region JSON (unchanged) |
| Species rarity, enabled state, tags, `dungeonAccess` | Species JSON via the seeder (unchanged) |
| Rarity table, result table, Buddy rules, cooldowns, energy | `tables.json` and code (unchanged) |
| **Pool membership and region-local weight** | **Database:** published Region Pool revisions |
| `region_encounter_pools` | A **derived runtime projection** of each enabled region's published revision. Its schema is unchanged. Only the projector writes it |
| Region JSON `encounterPool` | **Bootstrap seed and reference only**, never applied automatically after bootstrap |

Keeping `region_encounter_pools` as the projection is the key simplification:
**`huntService`, `speciesSelection` and the spawner need no code changes**, and the
hunt keeps reading exactly the table and columns it reads today.

### 4.2 One pool per region

**Recommendation: one published pool per region**, not several purpose-specific
pools. The runtime has exactly one regional draw, and its scripted-spawn variants
reuse the same pool. Splitting pools by purpose (for example "hunt" and "event")
would be a new gameplay feature, not an administrative one.

### 4.3 Example schema (illustrative SQL, not a migration)

```sql
-- One row per canonical region. Holds the mutable draft and the published pointer.
CREATE TABLE region_pools (
  region_id             text PRIMARY KEY
                        CHECK (region_id IN (/* REGION_SQL_LIST */)),
  draft_entries         jsonb   NOT NULL,          -- [{ "species": slug, "weight": int }], canonical order
  draft_revision        integer NOT NULL DEFAULT 1 CHECK (draft_revision >= 1),
  draft_hash            text    NOT NULL,          -- sha256 of canonical draft entries
  published_revision_id bigint,                    -- FK added below; null only transiently during bootstrap
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text                       -- Discord id or 'system:bootstrap'
);

-- Immutable published revisions.
CREATE TABLE region_pool_revisions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id        text    NOT NULL REFERENCES region_pools(region_id),
  number           integer NOT NULL CHECK (number >= 1),
  content_hash     text    NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  source           text    NOT NULL CHECK (source IN ('bootstrap','editor','rollback','import')),
  rolled_back_from bigint  REFERENCES region_pool_revisions(id),
  draft_revision   integer NOT NULL,
  -- Evidence only, never read by the hunt: slug/rarity/enabled/tags of every
  -- entry at publish time, for drift reports (§8.4).
  species_manifest jsonb   NOT NULL,
  published_by     text,
  published_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region_id, number)
);

CREATE TABLE region_pool_revision_entries (
  revision_id bigint  NOT NULL REFERENCES region_pool_revisions(id),
  species_id  bigint  NOT NULL REFERENCES species(id),     -- species rows are never deleted
  weight      integer NOT NULL CHECK (weight > 0 AND weight <= 1000000),
  position    integer NOT NULL,                             -- authored order, preserved into the projection
  PRIMARY KEY (revision_id, species_id),
  UNIQUE (revision_id, position)
);

ALTER TABLE region_pools ADD CONSTRAINT region_pools_published_fk
  FOREIGN KEY (published_revision_id) REFERENCES region_pool_revisions(id);

-- Immutability, mirroring dungeon_revisions_immutable (0059).
CREATE FUNCTION region_pool_revisions_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'region pool revisions are immutable'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER region_pool_revisions_immutable_trg
  BEFORE UPDATE OR DELETE ON region_pool_revisions
  FOR EACH ROW EXECUTE FUNCTION region_pool_revisions_immutable();
CREATE TRIGGER region_pool_revision_entries_immutable_trg
  BEFORE UPDATE OR DELETE ON region_pool_revision_entries
  FOR EACH ROW EXECUTE FUNCTION region_pool_revisions_immutable();

-- Append-only audit, shaped like dungeon_content_events. No FK, so it outlives anything.
CREATE TABLE region_pool_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id  text NOT NULL,
  action     text NOT NULL CHECK (action IN
             ('bootstrapped','draft_saved','draft_discarded','draft_reset_to_shipped',
              'published','rolled_back','projection_rebuilt','drift_detected')),
  actor      text,
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX region_pool_events_region_idx ON region_pool_events (region_id, id DESC);
```

Design notes:

- **Entries are normalised for published revisions**, with an FK to `species`, so a
  published revision can never point at a species row that does not exist. The
  **draft** stays as slug-keyed JSON, which can hold incomplete work.
- **Enabled/disabled state: no separate pool toggle (recommendation).** A region's
  pool is live exactly when the region JSON is `enabled` and a published revision
  exists. A pool-level "disable" switch would leave the region with no rows, which
  sends every hunt there to Waifu Valley through S1. That is a gameplay change
  disguised as an admin switch. See open decision D1.
- **Optimistic concurrency** uses `draft_revision`: every save and publish names the
  draft revision it was based on, as dungeons do.
- **Region identity is preserved:** the same canonical ids, and the same CHECK
  source (`REGION_SQL_LIST`).

---

## 5. Migration and bootstrap strategy (Recommendation)

### 5.1 Order of operations in RP2

1. **Migration `0069_region_pools`** (next journal index after `0068_dungeon_encounters`)
   creates the four tables and the triggers. It **does not modify
   `region_encounter_pools`** and writes no data. Schema and data stay separate,
   following the boss/enemy pattern.
2. **The seeder stops touching pools.** Remove the `DELETE` and the insert loop from
   `seedContent`. `SeedSummary.regionPoolEntries` moves to the bootstrap result.
3. **New startup step, `bootstrapRegionPools(content)`**, runs after `seedContent`
   (species rows must exist first) inside one transaction holding
   `pg_advisory_xact_lock(<region-pools key>)`:
   - For each region in the content set whose id is in `REGIONS` and that has **no
     `region_pools` row**, resolve its JSON entries exactly as the seeder does
     today (`weight ?? max(1, perSpeciesWeight)`, skipping slugs with no species
     row), then insert the draft, revision 1 (`source='bootstrap'`), its entries
     and a `bootstrapped` event.
   - The event `details` records the shipped JSON hash, the resolved entries, and a
     **diff against the projection rows that existed before**. Those rows were
     written by the previous release from its JSON, so any difference is exactly
     the region JSON change in this release. It is visible for review and never
     silent.
   - A region that already has a row is **never** modified. A JSON pool that now
     differs from the published revision is reported as shipped-content drift
     (§8.4) and is not applied.
4. **`projectRegionPools(tx)`** runs in the same transaction. For every region
   whose JSON is `enabled` and that has a published revision, replace that region's
   projection rows with the revision's entries **in `position` order**. Delete
   projection rows for regions that are disabled or have no revision. This
   preserves today's "disabled region ⇒ no rows" rule.
5. The legacy panel's **Reload Content** runs steps 2–4. Its only pool effects are
   bootstrapping a newly listed region and re-projecting, so it can never overwrite
   an edited pool.

**Repeated startup is idempotent:** the bootstrap is insert-missing, and the
projection is a pure function of the published pointers plus region `enabled`.

**Why bootstrap from JSON at application start rather than from the existing table
in SQL:** it reproduces exactly what the old seeder would have done with this
release's content. It also works on empty, test and fresh staging databases. The
pre-existing rows are still captured as evidence (the diff in step 3).

### 5.2 Existing data in production and staging

- The only existing data is the JSON projection from the last restart (C1). There
  is no admin-edited pool state to preserve.
- **Pre-deploy check (required)** on each environment. Run it before deploying,
  against the *current* release:

  ```sql
  -- Snapshot live pools in a stable order.
  SELECT p.region_id, s.slug, s.rarity, s.enabled, p.weight
  FROM region_encounter_pools p JOIN species s ON s.id = p.species_id
  ORDER BY p.region_id, s.slug;
  ```

  Compare the snapshot with the JSON resolved by the current release. Any
  difference means someone hand-edited the table since the last restart. Stop and
  decide whether that edit should be kept (by authoring it into JSON before the
  deploy, or publishing it after) before the bootstrap freezes the JSON state.
- **Recommended rule: the release that ships RP2 makes no region JSON changes.**
  The bootstrap diff is then empty, and parity is exact (§12.3).

### 5.3 Missing or inconsistent content

| Case | Handling |
| --- | --- |
| A region JSON entry names a slug with no species row | Impossible after a successful `loadContent` (fatal). The bootstrap skips it like the seeder does, and records it in the event details |
| Region in JSON but not in `REGIONS` | Impossible: the schema enum is closed |
| Region in `REGIONS` with no region file | No bootstrap. If a player stands there, the hunt uses the valley fallback, which is today's behaviour |
| Disabled region | Bootstrapped (so it is editable before release) but **not projected** until JSON `enabled` is true |
| Species disabled or removed from content after publish | The seeder disables the row. The revision keeps its FK. The runtime already filters `enabled`. The Portal shows drift |
| JSON changed later for an already-bootstrapped region | Not applied. Shown as **"Shipped content differs"** with an explicit **Load shipped pool into draft** action, which goes through normal publish |

### 5.4 Deployment sequencing and rollback restrictions

1. Deploy to staging with the pre-deploy snapshot, then run the parity check (§12.3).
2. Production deploy: migrations, then seed, bootstrap and project in one startup. No downtime is needed beyond the restart.
3. **Rolling back code to a pre-RP2 release is safe but lossy.** The old seeder deletes
   and rebuilds the projection from JSON, so published edits stop applying. The new
   tables are ignored, not dropped. Re-deploying RP2 re-projects the published
   revisions and restores the edits. Drizzle migrations are forward-only, so
   `0069` is not reverted.
4. Once admins have published edits, a code rollback **changes live encounter
   distributions**. Say this explicitly in the release notes.

---

## 6. Publication lifecycle (Recommendation)

```
JSON ──bootstrap(once)──▶ revision 1 (published) ──projection──▶ region_encounter_pools ──▶ hunt
                               ▲
draft ──save(expectedDraftRevision)──▶ draft' ──publish(expectedDraftRevision)──▶ revision N+1
                                                    rollback(revision k) ──▶ revision N+1 (copy of k)
```

| Operation | Permission | Transaction contents |
| --- | --- | --- |
| Save draft | `regions.write` | Lock the `region_pools` row, check `draft_revision`, run draft validation (§8.1), write the draft, `draft_revision + 1`, `draft_saved` event |
| Discard draft | `regions.write` | Reset the draft to the published entries; event |
| Load shipped pool into draft | `regions.write` | Replace the draft with the resolved JSON; event. Not published |
| Publish | `regions.publish` | Advisory lock (serialises **all** region publishes, which the cross-region exclusive check needs), lock the row, check `expectedDraftRevision`, run publish validation (§8.2) against *current* species and *other regions' published* pools, refuse if `draft_hash` equals the published hash, insert the revision and entries, move the pointer, **re-project this region**, `published` event with a before/after summary |
| Roll back to revision *k* | `regions.publish` | As Publish, but the entries are copied from *k* (`source='rollback'`, `rolled_back_from=k`) and revalidated under today's rules. A revision that would now be invalid (for example, it contains a species since tagged `dungeon_exclusive`) is refused with a reason |
| History | `regions.read` | Revisions, events, actor, time, entry counts, per-rarity totals |

Atomicity: revision, pointer, projection and event all commit together or not at
all. A concurrent hunt sees either the old rows or the new ones, never a mix,
because the hunt reads the projection inside its own transaction.

**Revision pinning: not needed.** A hunt resolves its species in one transaction
and stores `species_id` on the encounter. No long-lived run depends on a pool
revision, unlike dungeons (#0029). Encounters already in progress are unaffected by
a publish.

Deleted or disabled regions: a region cannot be deleted (it is a code list). JSON
`enabled: false` keeps the pool and history but removes the projection.
Re-enabling it re-projects the last published revision.

---

## 7. Runtime integration design (Recommendation)

- **No changes** to `huntService`, `speciesSelection`, `WildEncounterSpawner`,
  `captureService`, travel, progression or Buddy code.
- **Changes:**
  - `seeder.ts`: remove the pool rebuild.
  - New `modules/regionPools/`, containing:
    - `regionPoolStore`: bootstrap, project and the advisory lock;
    - `regionPoolService`: draft, publish, rollback, history and drift;
    - `regionPoolValidation`: pure validation;
    - `regionPoolDistribution`: the pure analyser (§10).
  - `index.ts` and the legacy reload: call bootstrap and project.
  - `encounterImportService`: build `regionPools` from the **projection** in the
    database, not from JSON (C4).
  - Loader: keep `validateRegionContent` as validation of the shipped JSON
    (bootstrap input). Replace `warnOnUnpooledSpecies` with a post-projection
    database check that reports per-region tier coverage.

---

## 8. Species policy and validation rules (Recommendation)

### 8.1 Draft save (permissive enough to hold work in progress)

Errors (save refused):

- region not in `REGIONS`;
- an entry slug that has no `species` row;
- the same species listed twice;
- a weight that is not an integer in 1..1,000,000;
- more than 500 entries;
- **a `dungeon_exclusive` species**. This is refused even in a draft, so that the
  editor can never be used to stage a dungeon-exclusive species for a region.

Warnings (save allowed): disabled species, EX species, empty rarity tiers, and an
exclusive species that appears in another region's published pool.

### 8.2 Publish (strict, evaluated against live state under lock)

Errors:

- everything in §8.1;
- the draft revision does not match the expected revision;
- the draft is unchanged from the published revision;
- the region JSON is `enabled` and the pool has **no runtime-eligible entry**
  (eligible means enabled and not `dungeon_exclusive`);
- **a `region_exclusive` species is present in another region's published pool.**
  This is the database form of loader rule 6, checked across all regions under the
  advisory lock.

Warnings that must be acknowledged before publishing:

- a hunted rarity tier with no eligible species. The warning names the actual
  consequence (S1/S2): for example, "LR rolls here will draw Waifu Valley LRs".
  Today no region has an empty tier, so this is new territory.
- disabled species included, which the runtime ignores until they are re-enabled;
- EX species included, which are never hunted.

### 8.3 Runtime eligibility: unchanged, already safe

The hunt and selectors already re-check `species.enabled` and exclude
`dungeon_exclusive` at every tier, on every draw. Because of that, **a published
pool cannot become unsafe** when a species is later disabled or retagged:

- disabled species: skipped;
- `dungeon_exclusive` retag: skipped;
- `region_exclusive` retag while she is in two pools: this violates policy but is
  not unsafe. She is still met only where a pool lists her, never through the
  global fallback. It is reported as drift, and the next publish of either region
  is blocked until it is resolved.

Region Pool editing **cannot grant** dungeon access: `dungeonAccess` and tags stay
species content read by [`dungeonSpeciesPolicy`](../../src/modules/dungeons/dungeonSpeciesPolicy.ts).
Pool membership has no effect on whether a dungeon may offer a species.

### 8.4 Drift detection (read-only, never auto-corrected)

| Drift | Detected by |
| --- | --- |
| Species disabled, removed or retagged since publish | `species_manifest` compared with the current `species` rows |
| Rarity changed since publish (the species moves tier) | Same comparison; also recompute tier coverage |
| A rarity tier became empty through drift | Coverage check at startup and in the editor (`drift_detected` event, de-duplicated) |
| Exclusive species now in two published pools | Cross-region check |
| Shipped JSON differs from the published pool | Hash comparison against the resolved JSON |

Startup **logs** drift and never fails because of it. Admin-published state was
valid when it was published, and the runtime is already safe.

### 8.5 Species case matrix

| Case | Draft | Publish | Runtime |
| --- | --- | --- | --- |
| Enabled, untagged | ok | ok | drawn |
| In several regions at different weights | ok | ok | each region uses its own weight |
| `region_exclusive`, only here | ok | ok | drawn here only |
| `region_exclusive`, in another published pool | warn | **error** | (cannot arise from the editor) |
| `dungeon_exclusive` | **error** | **error** | never drawn |
| Disabled or removed from the catalogue | warn | acknowledged warning | skipped |
| Future species (pack disabled, so not in content) | not pickable; an existing disabled row shows as disabled | as disabled | skipped |
| EX rarity | warn | acknowledged warning | never rolled |
| Duplicate entry | **error** | **error** | (PK prevents it) |

---

## 9. Portal UI requirements (Recommendation)

Route: `/admin/region-pools`, with permissions `regions.read`, `regions.write` and
`regions.publish`. The split follows `dungeons.*` and `encounters.*`. These are new
permission names, so existing role grants do not include them, and owners receive
them automatically.

**Region list:** name, banner thumbnail, release state (JSON `enabled`), published
revision number and date, a "draft has unpublished changes" badge, drift badges,
and per-rarity coverage pips.

**Region editor:**

- **Header:** region, release state (read-only, with a link explaining that it is
  content-owned), published revision, draft revision, last editor, and the actions
  Save / Discard / Publish / History.
- **Rarity sections** (N → LR, then a collapsed "Not huntable (EX)" section). Each
  section shows:
  - a **Rarity chance** label (for example "SR: 10% of encounters"). This is
    read-only and visually distinct, because it comes from the game tables and not
    from this pool;
  - one row per species: thumbnail (reusing gallery artwork), name, slug, race,
    affinity, badges (`region_exclusive`, disabled, drift), and a **Weight** input;
  - computed columns: **Share of rarity** (`w / Σw` in the section) and
    **Chance per encounter** (rarity chance × share). Overall chance per hunt is
    available in a tooltip.
  - Worked explanation shown in the UI: Twin Peeks LR has 2 species of weight 1
    each, so each has **50% share of rarity** but only **0.05% per encounter**
    (0.1% × 50%), and about 0.037% per hunt (× 74%).
- **Add species:** the shared species picker (search; filters for rarity, race,
  affinity, "pooled elsewhere" and exclusivity). `dungeon_exclusive` species are
  shown disabled with a reason, never selectable.
- **Validation panel:** errors and warnings keyed to entries, with the empty-tier
  consequence spelled out.
- **Diff and publish dialog:** added, removed and reweighted species; a per-rarity
  before/after table; the distribution delta (§10); and checkboxes to acknowledge
  warnings.
- **History:** revisions with source (bootstrap/editor/rollback), actor, time, and a
  diff against the previous revision. Includes **Roll back to this revision** and
  the audit event list.
- **Drift panel:** current species state compared with publish time; shipped JSON
  compared with published, with **Load shipped pool into draft**.

**Reuse without coupling.** Share the presentational components proposed in
[phase4 §14](../dungeons/phase4-captures-design.md): species picker, thumbnail,
rarity badge, weight field, share bar and issue list. Candidates to extract them
from are `DungeonSpeciesPicker`, `ArtThumb` and the gallery tiles. **Do not share**
API clients, models or odds calculations with
`portal/src/features/adminDungeons`. Dungeon odds are flat-weight with conditions
and "Nothing" outcomes. Region odds are rarity-first with fallbacks. Each is
computed by its own server endpoint, and the Portal computes neither.

---

## 10. Probability preview design (Recommendation)

A pure server function, `describeRegionDistribution(input)`, in `modules/regionPools/`. Inputs:

- `rarityTable` and `rareEncounterShift` (from the running service's tables, the same
  values the hunt captured);
- player level (default 1; a selector covers 1–39 and ≥ 40);
- an optional **Buddy scenario**: a chosen Buddy species whose `buddyBonus` is read
  from content, plus, for `ownership` targets, an explicit "owned set" assumption
  (default: owns none). The assumption is stated in the UI;
- the candidate pools for the region (draft or published), Waifu Valley's
  **published** pool, and the global tier-3 set, all filtered by today's runtime
  eligibility.

Output, mirroring §3.2–3.3 exactly:

1. Base and modified rarity probabilities, `p_k`, with the bonus applied before the
   level shift.
2. For each rarity, the **resolving tier**: region, valley fallback, global, or dead.
3. Dead-tier mass `d = Σ p_k` over dead tiers. The probability of resolving at live
   tier *k* is `p_k · Σ_{i=0..5} dⁱ`. The residual `d⁶` goes to the
   reroll-exhausted path, which is reported as "arbitrary species" and **not**
   attributed to any one species, because it depends on heap order (S3).
4. Per species: share of rarity (after any species-scoped Buddy multiplier),
   probability per encounter, and probability per hunt (× the encounter share of
   the result table, including any `hunt_item_find_chance` Buddy).
5. Excluded entries (disabled, `dungeon_exclusive`, EX), each with its reason.
6. **Draft compared with published:** per-species and per-rarity deltas, and
   newly dead or fallback tiers.
7. A separate panel for **scripted spawns** (`pickSpeciesForSpawn`: same rules,
   never a Buddy) and **filtered World Encounter selectors** (region-only scope, no
   fallback; S6). These are labelled so admins do not read hunt odds as event odds.

The analyser must not be a simplified formula. It is proved equal to the runtime
by the tests in §12.1, which drive the real `huntService.pickSpeciesForSpawn` and
`hunt` with seeded RNGs.

Simulation endpoint (optional, `regions.read`): run N seeded draws through the real
`pickSpeciesForSpawn` against a **read-only transaction that is always rolled
back**, with the draft projected into it, and return the empirical frequencies next
to the analytical ones. This is the same isolation idea as the dungeon sandbox,
using a separate implementation.

---

## 11. Integration boundaries (Recommendation, based on Verified readers and writers)

| System | Reads or writes pools? | RP change |
| --- | --- | --- |
| Hunt (`huntService`) | Reads the projection | **None** |
| Scripted spawns (`WildEncounterSpawner` → `pickSpeciesForSpawn`) | Reads the projection | **None** |
| Filtered selectors / Portal selector preview | Reads the projection | **None** |
| World Encounter import/planner | Reads **JSON** | Read the projection instead (C4) |
| World Encounter probabilities and outcomes | No | None |
| Regional travel (`travelCatalog`, `travelService`) | No (region metadata only) | None |
| Species discovery / dex (`collectionService`) | No (counts `species`) | None |
| Player progression (`rareEncounterShift`) | Feeds the rarity table | None; displayed by the preview |
| Buddy capture and encounter bonuses | Hunt-time modifiers | None; displayed by the preview |
| Capture (`captureService`) | No | None |
| Staging test controls | No | None (an optional future "reset to bootstrap" is not proposed) |
| Seeder / legacy panel reload | **Writes** | Stop writing pools; call bootstrap and project |
| Content loader validation | JSON | Keep it as bootstrap validation; replace the unpooled warning with a DB coverage check |
| Content import/export | None exists for pools | Optional later: pool export as JSON in the region-file shape (RP3) |
| Dungeon WaifuMon Pools and `dungeonSpeciesPolicy` | **No** | **None.** Covered by an architecture test: `modules/dungeons/**` must not import `modules/regionPools/**`, and the reverse |

---

## 12. Test and rollout plan (Recommendation)

### 12.1 Focused coverage

| Area | Test |
| --- | --- |
| Legacy hunting parity | After bootstrap from the shipped content, the projection's `(region, slug, weight)` set equals the old seeder's output for the same content (compare with a frozen copy of the old resolve function) |
| Rarity-first parity | The analyser's per-species probabilities match `pickSpeciesForSpawn` with a seeded RNG at N = 200k per region: chi-square p > 0.001, plus exact rarity marginals |
| Hunt path (with Buddy) | The same comparison through `hunt()` with rarity-scoped and species-scoped `encounter_weight` buddies, and with `hunt_item_find_chance` |
| Empty tiers | A fixture region with no LR: the analyser reports a valley fallback, and empirical draws come from the valley LR set. With no valley LR either, it reports the global tier. With nothing anywhere, it reports dead-tier reroll mass |
| Region-specific weights | The same species at different weights in two regions gives different shares |
| Disabled species | Disabled after publish: never drawn, drift reported, publish shows the acknowledgement warning |
| Dungeon-exclusive exclusion | Refused at draft save, publish and rollback. Never drawn when stale. Dungeon policy is unaffected by pool edits (existing `dungeonEncountersLive` cases still pass) |
| Region exclusives | A cross-region publish conflict is refused under concurrency (two regions publishing the same exclusive simultaneously: exactly one succeeds) |
| Concurrent edits | A stale `expectedDraftRevision` on save and on publish returns 409 |
| Publication atomicity | Fault injection after the revision insert rolls back the revision, pointer, projection and event together. A concurrent hunt never sees a mixed set |
| Immutability | UPDATE or DELETE on revisions or entries raises an error |
| Startup idempotency | Two startups give identical tables and no new events. An edited pool survives a restart and a legacy reload |
| Bootstrap | A new region is bootstrapped once. A JSON change after bootstrap only reports drift. A disabled region is bootstrapped but not projected, and re-enabling it projects it |
| Rollback | Rolling back to *k* creates revision N+1 with *k*'s entries. Rolling back to a now-invalid revision is refused |
| Missing catalogue dependency | A species removed from content becomes a disabled row. Revision FKs hold. Drift is reported |
| Schema migration | `0069` applies on a populated pre-RP2 database (fixture from `migrateSeed`) without touching `region_encounter_pools` |
| Fixture migration (C5) | The shared `fixtures.ts` runs seed, bootstrap and project, exactly as startup does. Suites that re-seed changed content use an explicit `projectPoolsFromContent` helper. Assertions are unchanged, and the before/after pass/fail set is compared with the known baseline failures |
| Architecture | No import edges between dungeon and region-pool modules. The hunt module diff is empty |

### 12.2 Staging rollout

1. Take the pre-deploy snapshot SQL (§5.2) on staging and save it.
2. Deploy RP2 (backend only, with no Portal screens and no permissions granted).
3. Check the `bootstrapped` events: six regions, revision 1 each, empty diffs.
4. Re-run the snapshot SQL. It must be **set-identical** to step 1.
5. Run the analyser for every region at levels 1 and 40, with no Buddy. Compare it
   with the same analyser run against the step-1 snapshot. The results must be
   identical.
6. Run the seeded simulation endpoint per region and compare it with the analyser.
7. Restart twice, and use legacy Reload once. No changes and no new events.
8. Only then grant `regions.*` to staging testers, and exercise edit, publish and
   rollback on staging.

### 12.3 Before/after distribution comparison

Because the hunt code is byte-identical and the projection is set-identical,
distributions are identical **by construction**. Steps 4–6 prove the construction
held on real data. Draw-for-draw comparison with a fixed seed is **not** a valid
check, because of the heap-order effect (S3). This is an existing property and is
not introduced by RP2.

Production uses the same sequence, with step 8 limited to named admins.

---

## 13. Open decisions and risks

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Pool-level enabled/disabled switch? | **No.** Release stays with region JSON `enabled`. A pool "off" switch would reroute every hunt in the region to Waifu Valley (S1) |
| D2 | Should empty rarity tiers block publishing? | Warning with acknowledgement, with the consequence spelled out. Alternative: block for enabled regions |
| D3 | Can disabled species stay in a published pool? | Yes, with acknowledgement. They are ignored at runtime and return if re-enabled |
| D4 | Bootstrap disabled regions? | Yes, without projecting them. Revisit if unreleased packs need JSON iteration (use "Load shipped pool into draft") |
| D5 | Permission names | `regions.read` / `regions.write` / `regions.publish` |
| D6 | Keep the legacy admin panel's Reload? | Keep it, with no pool writes. Its species edits can still cause drift, which the drift panel shows |
| D7 | Freeze region JSON in the RP2 release? | Yes, for exact parity (§5.2) |
| D8 | Weight cap | 1,000,000 (today's maximum authored weight is 12) |
| D9 | Should RP2 add `ORDER BY` to pool reads for reproducibility? | **No.** It would change the hunt. Track it separately if it is wanted (S3) |
| D10 | Fix S4 (a negative Buddy value can crash a hunt)? | Out of scope. Log a separate issue if wanted |

| Risk | Mitigation |
| --- | --- |
| A code rollback to before RP2 silently reverts published pool edits | Release note. The edits return when RP2 is redeployed |
| Content-side rarity or tag changes create empty tiers or exclusive conflicts without any pool edit | Startup drift and coverage checks, plus Portal badges. The runtime is already safe |
| Admins read "share of rarity" as overall odds | Separate labelled columns and the worked example in the UI |
| Fixture churn (C5) hides a real regression | Change fixtures to an explicit helper. Do not delete or relax assertions |
| A single global advisory lock for publishes | Publishes are rare admin actions. Hunts do not take it |

---

## 14. Suggested implementation breakdown

**RP2A: ownership flip, no admin surface.** Migration `0069`; `regionPoolStore`
(bootstrap, project, lock); seeder change; startup and legacy-reload wiring; the
World Encounter planner reading the database; the database coverage warning; the
test helper and fixture migration; parity, idempotency, immutability and
architecture tests; the staging rollout steps 1–7. Exit criterion: a set-identical
projection on staging.

**RP2B: backend authoring.** `regionPoolService` (draft, publish, rollback,
history, drift, load shipped); `regionPoolValidation`; `describeRegionDistribution`
with hunt-parity statistical tests; admin API routes and permissions; the optional
rollback-only simulation endpoint; API and integration tests for concurrency and
atomicity.

**RP3: Portal.** Shared species components extracted without moving dungeon
logic; the region list, editor, preview, diff/publish, history/rollback and drift
panels; Portal unit and browser tests; an authoring guide in `docs/region-pools/`.
Optional later: pool export in the region-file shape.

**RP1 stops here. RP2 needs approval, including decisions D1–D10 and acceptance of
the critical findings C1–C5.**
