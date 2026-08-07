# Platform API — Phase 2 implementation notes

Read-only endpoints over the existing game services. This is a decisions record;
the operator/client guide (`docs/platform-api.md`) is written in Phase 4.

Nothing in this phase changes gameplay, and no Discord code path was touched.

---

## 1. Scope decisions that differ from the brief

Three items in the Phase 2 brief could not be implemented as written. Each is
recorded here rather than silently dropped.

### Leaderboards — not implemented

The approved plan lists leaderboards as an explicit non-goal (§3: *"No
leaderboards, cross-player queries, or global aggregations — these aren't in the
service layer today"*), and that is still true: every read service is scoped to a
single `playerId`. Exposing a leaderboard would mean writing new cross-player
aggregation logic in the API layer, which is exactly what §5 forbids
("MUST NOT: contain gameplay logic").

**To add one later:** it needs a service first — something like
`collectionService.topByDexProgress(guildDbId, limit)` — with the ranking rules,
tie-breaks and privacy decisions (does a player opt in? are released copies
counted?) settled in the service, plus an index on the sort column. The API route
is then trivial. That is a gameplay-design decision, not an adapter change.

### Regions — nothing to expose

There is no region system. The only trace in the codebase is a placeholder field
on the Trainer Profile dashboard:

```ts
/** Once the region system exists. */
currentRegion?: string | null;
```

The nearest shipped concept is `tables.hunt.locationFlavors`, which is cosmetic
flavour text for hunt sessions, not a modelled resource. It is already reachable
as part of `GET /api/v1/content/tables/hunt`. A `/regions` resource would be an
empty shell that clients would code against and then have to migrate.

### `POST /players/ensure` — deferred to Phase 3

The plan schedules this in Phase 2 marked *"idempotent — treated as safe here"*.
The Phase 2 brief overrides that: *"No mutation endpoints should be introduced
during this phase."* `ensurePlayer` inserts a player row and a currency row on
first call, so it is a mutation regardless of being idempotent. It is registered
in Phase 3 alongside the other `/ensure` endpoints.

The read-only bridge from Discord identity to internal id — `GET
/api/v1/players/lookup` — **is** implemented and never provisions anything.

---

## 2. Service-layer adjustments

### One addition

`huntService.getActiveEncounterDetail(playerId, now?)` — as
`getActiveEncounter`, but joined to the species row.

**Why:** an encounter row carries only `species_id`. The content endpoints are
slug-addressed and carry no internal ids (see §3 below), so a client holding a
bare `speciesId` had no way to resolve who the player had met. Returning the
species inline is one query instead of a lookup the client cannot perform.

**Impact:** purely additive. `getActiveEncounter` is untouched and remains what
the Discord handlers call; the new method repeats the same filter and the same
expiry rule, so the two surfaces agree on when an encounter has lapsed.

### Three planned additions that turned out to be unnecessary

The plan anticipated adding read variants to three services. All three already
existed, so nothing was written:

| Planned | Reality |
|---|---|
| `sessionService.getSession` | `findByPlayerAndChannel` already does exactly this |
| `dailyService.getStatus` | `status(playerId, now?)` already exists |
| `currencyService.getBalances` public wrapper | already public |

---

## 3. Architectural decisions

### Two species/item shapes, on purpose

Species and items exist twice: as the authored **content snapshot** (slug-keyed,
no ids) and as **seeded database rows** (id-bearing). The API exposes both,
deliberately:

- `/content/species`, `/content/items` serve the snapshot — no ids, no queries.
- Gameplay resources (owned waifu, inventory entry, encounter, care target, shop
  row) **embed** the id-bearing row they already joined.

This means a client never has to resolve an id against a slug-keyed catalog. It
also means the content endpoints stay a pure in-memory read.

### Player resolution happens once, in a hook

Most read services answer harmlessly for a `playerId` that does not exist —
`getInventory` returns `[]`, `getDexStats` returns zeros — which would make an
unknown player indistinguishable from an empty one. A single `preHandler`
(`src/api/plugins/playerScope.ts`) resolves `:playerId` for every player-scoped
route and 404s when it is unknown.

Cost is one indexed primary-key lookup, and it is not wasted: the row is stashed
on the request, so `GET /players/{id}` serves it with no further query and
`/profile` pairs it with one balance read. Phase 3's mutation routes inherit the
guard for free.

### Tuning tables are opaque

`GET /content/tables` returns the `tables.json` blob typed as an opaque object
rather than a mirrored schema. `tables.json` is balance tuning that is re-tuned
routinely; freezing its nested shape into the v1 contract would make every
balance patch a breaking API change and would churn the Phase 4 OpenAPI snapshot
for no client benefit. The endpoint documents this explicitly.

### Pagination is capped at 25, not 100

`collectionService.listOwned` clamps `pageSize` to 25 — it was written for
Discord select menus, which cap at 25 options. The API validates to that same
ceiling rather than the envelope's general 100, so a client asking for 100 gets a
clear `400` instead of a silently-truncated page. Raising the service clamp would
mean changing a gameplay service purely for the API's convenience; if a future
client genuinely needs larger pages, that should be a deliberate, tested service
change.

The response echoes the `page`/`pageSize` the **service** settled on, so a client
that requests page 99 of 2 can see where it actually landed.

### Enum narrowing lives in one file

Postgres enforces the enum-ish columns (`rarity`, `affinity`, `content_rating`,
`category`, `price_currency`, `encounter state`) with CHECK constraints, so
Drizzle types them as `text`. The API schemas declare them as real enums, which
is most of the documentation value in the spec. `src/api/resources.ts` is the one
place those two are narrowed together, so the casts stay visible and auditable
instead of scattering through handlers.

### Reads are proven not to write

Beyond per-endpoint assertions, `tests/integration/api/readEndpoints.test.ts`
snapshots player, currency, inventory, quest and dex state, sweeps every
endpoint, and asserts nothing moved. Two specific traps are covered:
`GET /quests/daily` must not assign quests, and `GET /care` must not bank pending
Care Mode ticks.

---

## 4. Endpoint organization

25 routes, one file per resource group under `src/api/routes/v1/`, each
registered with one line in `routes/v1/index.ts`.

| Group | Routes | Backing service |
|---|---|---|
| Players | `lookup`, `{id}`, `{id}/profile` | `players`, `currency` |
| Collection | `stats`, `owned`, `owned/{waifuId}`, `buddy` | `collection` |
| Currency | `currency` | `currency` |
| Inventory | `inventory` | `inventory` |
| Effects | `effects/capture-bonus` | `effects` |
| Care Mode | `care` | `care` |
| Encounters | `encounter` | `hunt` |
| Daily | `daily` | `daily` |
| Quests | `quests/daily` | `quests` |
| Shop | `shop/catalog` | `shop` |
| Sessions | `sessions/{channelId}` | `session` |
| Content | `species`, `species/{slug}`, `items`, `items/{slug}`, `tables`, `tables/{key}`, `quests` | content snapshot |
| Guilds | `guilds/{discordGuildId}`, `.../channels` | `guilds` |

One route is not in the plan's tree: `GET /players/{id}/collection/buddy`. The
plan lists only the Phase 3 `DELETE`, but the buddy is a first-class read
resource and a client would otherwise fetch the player, read `buddyWaifuId`, then
fetch that copy. It mirrors `collectionService.getBuddy` one-for-one.

`/api/v1/system` remains reserved and unregistered; a test asserts nothing is
mounted under it.

---

## 5. Performance notes

- **Content endpoints issue no queries.** They read the in-memory snapshot via
  `ctx.getContent()`, called per request so an admin-panel "Save + Reload" is
  visible immediately. No caching subsystem was added and none is needed. If HTTP
  caching is ever wanted, the natural move is an ETag derived from the snapshot's
  identity — noted, not built.
- **`waifuProgress` is pure arithmetic** over a row already in hand, so embedding
  progress in collection responses costs nothing.
- **`GET /quests/daily` runs its two reads concurrently** (`Promise.all`).
- **The player-scope lookup is the one added query**, discussed above.

---

## 6. Opportunities for later phases

- **Composite endpoints** (plan §17.2) now have all their building blocks. A
  `dashboard` composite would compose player + currencies + buddy + daily +
  quests + care — six service reads the API already performs individually.
- **A leaderboard service** would unlock the resource described in §1.
- **Cursor pagination** for the collection, if a client ever needs to page a very
  large collection consistently while captures are landing.
- **ETag / `If-None-Match` on content endpoints**, if a client polls them.
- **A species-by-id content route**, if the embed-the-row approach ever proves
  insufficient.
