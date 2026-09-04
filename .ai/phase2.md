# WaifuMon Encounter System — Phase 2 HANDOFF

**Status: complete, after a closure pass** (commit `aacc03d` + this session's
work, 2026-09-04).

Phase 2 delivered the Portal Admin authorization layer, chained encounter
Continue, the encounter Vendor system, the `encounter_check_bonus` Buddy
Bonus, the admin HTTP API, the Portal React encounter-manager UI, and
comprehensive tests.

## What the closure pass changed

The state inherited at takeover was substantially complete, but four items did
not meet the Phase 2 bar and three smaller defects sat alongside them. All are
fixed.

1. **`trigger_waifumon_encounter` was a marker, not a feature.** It pushed a
   follow-up that the Discord presenter painted as a line of text; no wild
   Waifumon ever appeared. There is now a canonical spawner —
   `src/modules/encounters/wildEncounterSpawner.ts`, `createWildEncounter` —
   which writes a real `encounters` row inside the resolution transaction, and
   an `enc:wild` button that opens the ordinary capture screen for it. See
   "Wild encounter spawning" below.

2. **The simulator was an expected-value calculator.** It computed
   `round(rolls * chance)` and aggregated effects by multiplication, so it
   could never disagree with the formula it was supposed to be testing. It now
   runs N independent `rollCheck` draws through a seeded RNG and reports
   observed successes, observed net, deviation from expectation, standard
   error, and the seed. Its unit test used to re-implement the same arithmetic
   inline — which is why the bug survived — and now tests the exported
   function.

3. **Bearer tokens bypassed every permission check.** `PLATFORM_API_TOKEN` is
   one process-wide shared secret, and before Phase 2 the API it opened was
   substantially read-only. The blanket bypass silently turned it into a
   content-authoring super-admin. The bypass is now opt-in via
   `PLATFORM_API_ADMIN_BEARER` (default `false`), and the trust boundary is
   documented in `docs/platform-api.md` and stated once in
   `src/api/plugins/portalPermissions.ts`.

4. **Admin mutations had no HTTP-level CSRF test.** There is one now
   (`tests/unit/api/adminEncounterAuth.test.ts`), driving the fully-registered
   server through `inject()` rather than unit-testing the permission helper.

Smaller fixes in the same pass:

- **Vendor IDOR.** `getForEncounter(activeEncounterId)` had no player scope, so
  `encv:open:<someone else's id>` repainted another player's shop. The
  signature now requires `playerId` and the ownership test is part of the same
  query.
- **Permission checks ran after body validation.** A caller with no admin
  rights got a `400` describing the route's Zod schema. The checks moved to
  `preValidation`, so the `403` comes first and the body is never parsed.
- **Portal dev permission grants were unguarded.** `EnvSessionProvider` and
  `DevLoginSessionProvider` granted every permission unconditionally. Both are
  now behind `import.meta.env.DEV`, and `portal/scripts/verify-bundle.mjs`
  fails the build if such a grant reaches a shipped bundle (canary:
  `encounters.history`, a permission no Portal screen reads).
- **The editor's vendor selector was hard-coded** to the Wandering Merchant; it
  now lists real definitions. `trigger_waifumon_encounter`'s species was a
  free-text slug; it is now a canonical selector fed by the reference endpoint.

## Gate results

```
npm run typecheck            # PASS (only the pre-existing trainerProfileCard
                             # test file, unrelated to encounters)
npm run build                # PASS
$env:TEST_DATABASE_URL="postgres://none"; npx vitest run tests/unit
                             # 1727 pass / 19 fail
                             # The 19 are the pre-existing content-drift
                             # failures listed at the bottom of this file —
                             # the identical set before and after this work.

Push-Location portal
  npm run typecheck          # PASS
  npm run lint               # PASS
  npm test                   # 400 tests PASS
  npm run build:e2e          # PASS
  node scripts/verify-bundle.mjs
                             # PASS — and verified to *fail* when a client-side
                             # permission grant is deliberately reintroduced
Pop-Location
```

**Integration suites that need Docker/testcontainers.** Docker Desktop was not
running during the closure session, so these are typecheck-clean but
unexecuted:

- `tests/integration/worldEncounterVendorAndContinuation.test.ts` (8 tests)
- `tests/integration/worldEncounterBuddyBonus.test.ts` (3 tests)
- `tests/integration/api/adminEncounters.test.ts` (5 tests)
- `tests/integration/wildEncounterSpawn.test.ts` (21 tests, new)

Run with Docker Desktop up, or point `TEST_DATABASE_URL` at a reachable
Postgres.

## Wild encounter spawning

`createWildEncounter(...)` is the one way anything other than a hunt roll puts
a wild Waifumon in front of a player. World Encounters use it today; quests,
items, events, exploration and deity rewards are meant to reuse it unchanged.

```
resolveChoice (one transaction)
  |- apply effects
  |- open vendor instance          (open_vendor follow-up)
  |- insert continuation row       (trigger_encounter follow-up)
  |- createWildEncounter(...)      (trigger_waifumon_encounter follow-up)
  |    |- replay check on (origin.kind, origin.ref)
  |    |- one-active-encounter check, with lazy expiry
  |    |- resolve species server-side (slug -> row, or hunt's own pool draw)
  |    |- optional Hunt Energy spend (off by default)
  |    \- INSERT ... encounters
  |- upsert cooldown
  \- insert history
```

Design notes:

- **No duplicated capture math.** The spawner writes a row; charm selection,
  capture attempts and Let Her Go all run through the existing
  `CaptureService`. A spawned encounter is indistinguishable from a hunted one
  the moment it exists — `hunt.getActiveEncounterDetail` returns it.
- **No duplicated rarity math either.** When the author names no species, the
  spawner calls `hunt.pickSpeciesForSpawn`, which is the hunt's own
  region/rarity pool draw with Buddy Bonus weighting omitted (a bonus is
  earned by hunting, not by a script handing you an encounter).
- **Idempotency is a database constraint**, not a read-then-write check:
  `encounters_origin_uq` is a partial unique index on
  `(origin_kind, origin_ref)`, exempting hunted rows where both are null. A
  double Continue, a retried job or a replayed quest step returns the first
  encounter rather than creating a second.
- **Never silently swallows a reward.** A player already mid-encounter gets
  `blocked`, and the outcome embed says so instead of promising a Waifumon
  that does not exist.
- **Costs nothing unless asked.** `consumeHuntEnergy` defaults to false and no
  cooldown is stamped either way.

The Discord side is `enc:wild:<encounterId>` -> `handleWildEncounterOpen` in
`waifumonHunt.ts` — the module that already owns capture presentation, so the
canonical `buildEncounterView` is reused and there is no import cycle. The
handler takes nothing from the custom id but a lookup key, and the read is
scoped to the clicking player.

## Architecture at a glance

```
Discord OAuth
  → wm_portal_session cookie (httpOnly)
  → PortalSessionService.getSession(token)
  → PortalAuthorizationService.computePermissionsFor(session)
        └─→ GuildOwnershipService.getOwnerId(selectedDiscordGuildId)
              └─→ client.guilds.fetch(id).ownerId   (5-min TTL cache)
  → BrowserSession { authenticated, permissions: string[] }

API mutation request
  → auth hook (bearer OR portal session + CSRF dual-token)
  → requirePortalPermission(req, authService, 'encounters.write')
        └─→ bearer bypasses; portal session must hold the permission
  → route handler
        └─→ WorldEncounterAdminService.upsert/clone/setLifecycle/…
```

Portal frontend:

```
useSession() → PortalSession { permissions }
useHasPermission('admin.access')  → boolean gate for UI
<RequirePortalPermission permission="…"> in the router
NavList filters out items whose requiresPermission is not held
```

Gameplay loop (unchanged shape, new capabilities):

```
Hunt / Travel
  → maybeTriggerHuntEncounter / maybeTriggerTravelEncounter (world encounter roll)
  → tryRollForHunt / tryRollForTravel
  → EncounterActivation → Discord present
  → button click → resolveChoice (one tx)
       ├─ mark parent resolved
       ├─ apply effects (currency / inventory / progression / collection)
       ├─ open vendor instance if open_vendor follow-up
       ├─ insert continuation row if trigger_encounter follow-up
       ├─ upsert cooldown
       └─ insert history
  → Discord: Result embed + optional Continue / Open shop buttons
```

## What was built

### 1. Guild ownership + portal authorization

- **`src/modules/portalAuth/guildOwnershipService.ts`** — in-memory TTL cache
  keyed on discord guild id, backed by a `FetchGuildOwnerId` closure. The bot
  primes the map on `ready` and updates on `guildCreate`/`guildUpdate`. No
  database persistence (per spec: ownership can be transferred at any time and
  a cached row would silently disagree with Discord).
- **`src/modules/portalAuth/portalAuthService.ts`** — the single answer to
  "what may this session do?". Guild-owner → every permission; everyone else →
  none. Designed for role-based extension: a Phase 3 rule just appends to
  `computePermissionsFor`.
- **`src/api/plugins/portalPermissions.ts`** — `requirePortalPermission(req,
  authService, permission)`. Bearer-auth bypasses; portal session must
  independently hold the permission or a `PortalPermissionError` (403) fires.

**Permissions vocabulary** (closed set in `ALL_PORTAL_PERMISSIONS`):

- `admin.access` — nav visibility + admin route entry
- `encounters.read` — GET admin encounter routes
- `encounters.write` — POST/PUT/DELETE/clone
- `encounters.publish` — draft→active lifecycle change
- `encounters.simulate` — N-roll admin simulation
- `encounters.history` — reserved for the next phase (history browser)

### 2. Portal session payload extension

- `BrowserSession.permissions?: string[]` added in `src/api/portalSession.ts`.
- `src/api/routes/auth.ts` — `enrichWithPermissions` helper is called for
  every `/auth/session` and `/auth/guild` response when
  `PortalAuthRouteDeps.authorization` is wired.
- `src/api/context.ts` — `ApiContext.portalAuthorization?` field so v1 routes
  reach the service without importing bot types.
- `src/api/server.ts` — `PlatformApiDeps.portalAuth.authorization?` threaded
  through to the auth-route registration.
- `src/api/errors.ts` — added `PORTAL_PERMISSION_DENIED: 403`.

### 3. Chained continuation

- **Schema (`activeWorldEncounters.continuationOfId`)** — nullable bigint
  self-reference. FK ON DELETE SET NULL so history cleanup never cascades a
  live pending row away.
- **`resolveChoice` extension** — after marking the parent resolved (which
  frees the `active_world_encounters_player_pending_uq` slot), the transaction
  inserts a new pending row with `continuation_of_id = parent.id`. This
  ordering is load-bearing: the partial unique index would reject the child
  otherwise.
- **`service.getActivationById(id, playerId)`** — cheap fetch used by the
  Discord Continue handler. Returns null if the row is missing, mismatched, or
  already consumed.
- **Discord**: `encw:continue` handler + the "Continue →" button that
  `buildEncounterResolved` places on the outcome embed when
  `resolution.continuationActiveId` is present.

### 4. Vendor system

- **Schema**:
  - `world_encounter_vendors (id, vendor_key UNIQUE, name, description,
    stock_template_json, created_at, updated_at)` — authored definition.
  - `world_encounter_vendor_instances (id, active_encounter_id FK,
    vendor_key, stock_json, opened_at, closed_at)` + unique
    `(active_encounter_id)` — the per-encounter shopper's view.
- **`src/modules/worldEncounters/vendorService.ts`** — definition CRUD,
  idempotent `openForEncounter`, transactional `purchase` (`SELECT…FOR
  UPDATE` on instance + `CurrencyService.spendWaifubux/spendEssence` +
  `InventoryService.addItem`). Seeded `seedWorldEncounterVendors` for the
  Wandering Merchant.
- **`resolveChoice` extension** — when an `open_vendor` follow-up fires, the
  service opens the vendor instance in the same resolution transaction and
  returns `resolution.vendorInstance = { instanceId, vendorKey }`. `VENDOR_NOT_FOUND`
  is downgraded to a soft-failure so a misauthored vendor key never breaks
  the encounter.
- **Discord**: `encv:open` (repaint as vendor UI), `encv:buy` (transactional
  purchase, repaint on success). Presenter in
  `src/discord/worldEncounterVendorPresenter.ts` builds one button per
  in-stock line.

**Wandering Merchant seed** — `wandering_merchant`:
`[{basic_charm × 3 @ 150 WB}, {silk_charm × 1 @ 900 WB}]`.

### 5. `encounter_check_bonus` Buddy Bonus

- Added to `BUDDY_BONUS_EFFECT_IDS` in `src/modules/buddyBonus/buddyBonusEffects.ts`.
- Metadata in `BUDDY_BONUS_EFFECTS`: `percent_modifier`, `appliesTo:
  'world_encounter_check'`, `allowedTargetTypes: []`.
- Mirrored in `content/bonus.json` — the registry-mirror test in
  `tests/unit/buddyBonusEffects.test.ts` automatically validates parity.
- **Resolver integration**: `worldEncounterService.ts` calls
  `deps.buddyBonus.percentFor(tx, playerId, 'encounter_check_bonus')` at all
  three call sites (rolling, resolving, fetching pending). Fold-in via the
  existing `buddyBonusPercent` field in `EncounterCheckContext`; the
  breakdown surfaces it as `buddyBonusMod`.

### 6. Admin HTTP API (`/api/v1/admin/encounters/*`)

Registered in `src/api/routes/v1/index.ts`. Every route calls
`requireAuth(req, permission)` (bearer bypasses, portal session gated).
Registration short-circuits when `ctx.services.worldEncounterAdmin` is not
wired, so a deployment without the admin service simply exposes nothing.

| Verb | Path | Permission |
| --- | --- | --- |
| GET | `/admin/encounters` | `encounters.read` |
| GET | `/admin/encounters/reference` | `encounters.read` |
| GET | `/admin/encounters/:id` | `encounters.read` |
| POST | `/admin/encounters` | `encounters.write` |
| PUT | `/admin/encounters/:id` | `encounters.write` |
| POST | `/admin/encounters/:id/clone` | `encounters.write` |
| PATCH | `/admin/encounters/:id/lifecycle` | `encounters.publish` (when target=active) else `encounters.write` |
| DELETE | `/admin/encounters/:id` | `encounters.write` |
| POST | `/admin/encounters/:id/preview` | `encounters.read` |
| POST | `/admin/encounters/:id/simulate` | `encounters.simulate` |

Zod validates every payload. `EncounterInputSchema` reused from Phase 1 for
create/update bodies. Simulation is pure math over `computeChance` × N — no
DB mutations, no cooldown, no history.

### 7. Portal React admin UI

Files under `portal/src/features/adminEncounters/`:

- **`AdminEncountersListPage.tsx`** — filterable table (search, region,
  source, rarity, lifecycle) + row actions (Edit / Preview / Toggle /
  Clone / Delete). All actions permission-gated via `useHasPermission`.
- **`AdminEncounterEditorPage.tsx`** — structured form: general fields,
  region checkboxes, route builder, choices list (via `ChoiceEditor`),
  inline preview panel.
- **`AdminEncounterPreviewPanel.tsx`** — configurable test buddy context,
  shows per-choice availability + chance + breakdown.
- **`AdminEncounterPreviewPage.tsx`** — full-page preview + N-roll
  simulator with aggregate distribution + currency + item frequency.
- **`ChoiceEditor.tsx`** — one row per choice with move-up/down/remove
  and structured fields (requirements, check, success/failure effects).
  Handles `exactOptionalPropertyTypes` via a `stripUndefined` helper.
- **`EffectEditor.tsx`** — discriminated-union control for all 15 effect
  types with canonical selectors populated from
  `/admin/encounters/reference`.

Portal auth:

- **`portal/src/auth/RequirePortalPermission.tsx`** — renders `<NotFoundPage/>`
  when the permission is absent.
- **`portal/src/auth/useSession.ts`** — added `useHasPermission(name)` hook.
- **`portal/src/auth/types.ts`** — `PortalSession.permissions: readonly
  string[]` field.
- Three session providers (`OAuthSessionProvider`, `EnvSessionProvider`,
  `dev/DevLoginSessionProvider`) populate `permissions`. Dev/Env providers
  grant every permission for local development; OAuth relies on the
  server-computed set.

API client:

- **`portal/src/api/adminEncounters.ts`** — typed clients for every admin
  endpoint (list/get/reference/create/update/clone/lifecycle/delete/preview/
  simulate).
- **`portal/src/api/client.ts`** — added `postData`, `putData`, `patchData`,
  `deleteData` helpers.

Routing / navigation:

- `portal/src/app/router.tsx` — 4 new admin routes, each wrapped in
  `<RequirePortalPermission>`.
- `portal/src/app/navigation.ts` — `NavItem.requiresPermission?` field +
  Admin nav entry.
- `portal/src/components/layout/NavList.tsx` — filters items by permission.

### 8. Discord button handlers

- **`encw:continue`** — `handleWorldEncounterContinue` presents the pending
  continuation row via `service.getActivationById`.
- **`encv:open`** — `handleWorldEncounterVendorOpen` repaints as vendor UI
  for an already-opened instance.
- **`encv:buy`** — `handleWorldEncounterVendorBuy` runs one transactional
  purchase and repaints the vendor UI with updated stock + balance.

All three registered in `src/discord/client.ts`.

### 9. Seed updates

- `tv_bandit_ambush.choices[Fight].successEffects` now includes
  `trigger_encounter → tv_bandit_aftermath`.
- New `tv_bandit_aftermath` encounter (discovery, weight=1, non-hunt/non-travel
  — only reachable via chain): "Pocket the loot" (WB + XP) or "Leave it"
  (Essence).
- Wandering Merchant vendor definition seeded via `seedWorldEncounterVendors`.

### 10. Migration

**`drizzle/0025_encounter_continuation_and_vendor.sql`** (hand-written,
convention since 0005):

- `ALTER TABLE active_world_encounters ADD COLUMN continuation_of_id bigint`
  + FK + index
- `CREATE TABLE world_encounter_vendors (...)` + unique on `vendor_key`
- `CREATE TABLE world_encounter_vendor_instances (...)` + unique on
  `active_encounter_id` + index on `vendor_key`

`drizzle/meta/_journal.json` extended with the `0025` entry. Timestamp
`1817935200000` (one day after `0024`).

## Files (final list)

**New backend modules (6):**

- `src/modules/portalAuth/guildOwnershipService.ts`
- `src/modules/portalAuth/portalAuthService.ts`
- `src/api/plugins/portalPermissions.ts`
- `src/api/routes/v1/admin/encounters.ts`
- `src/modules/worldEncounters/vendorService.ts`
- `src/modules/encounters/wildEncounterSpawner.ts` *(closure pass)*

**New Discord modules (1):**

- `src/discord/worldEncounterVendorPresenter.ts`

**New Portal modules (7):**

- `portal/src/auth/RequirePortalPermission.tsx`
- `portal/src/api/adminEncounters.ts`
- `portal/src/features/adminEncounters/AdminEncountersListPage.tsx`
- `portal/src/features/adminEncounters/AdminEncounterEditorPage.tsx`
- `portal/src/features/adminEncounters/AdminEncounterPreviewPage.tsx`
- `portal/src/features/adminEncounters/AdminEncounterPreviewPanel.tsx`
- `portal/src/features/adminEncounters/ChoiceEditor.tsx`
- `portal/src/features/adminEncounters/EffectEditor.tsx`

**Migration/schema:**

- `src/db/schema.ts` — 3 additions, plus `encounters.origin_kind` /
  `origin_ref` and `WILD_ENCOUNTER_ORIGIN_KINDS` in the closure pass
- `drizzle/0025_encounter_continuation_and_vendor.sql`
- `drizzle/0026_wild_encounter_origin.sql` *(closure pass)*
- `drizzle/meta/_journal.json`

**Tests (new, 8 files, 45 tests):**

- `tests/unit/portalAuth/guildOwnershipService.test.ts` (6)
- `tests/unit/portalAuth/portalAuthService.test.ts` (8)
- `tests/unit/portalAuth/portalPermissions.test.ts` (5)
- `tests/unit/worldEncounters/simulator.test.ts` (4)
- `tests/integration/worldEncounterVendorAndContinuation.test.ts` (8)
- `tests/integration/worldEncounterBuddyBonus.test.ts` (3)
- `tests/integration/api/adminEncounters.test.ts` (5)
- `portal/src/auth/__tests__/useHasPermission.test.tsx` (3)
- `tests/unit/api/routes.test.ts` — mutation-verb allowlist widened

**Tests added by the closure pass (6 files):**

- `tests/unit/api/adminEncounterAuth.test.ts` (14) — the whole admin
  authorization boundary over real HTTP: bearer default-denied, bearer
  opt-in, guild-scoped ownership, cross-guild denial, ownership lookup
  unavailable, no-oracle deployment, CSRF present/absent/mismatched, and
  guild switching returning an emptied permission set
- `tests/unit/worldEncounterInteractions.test.ts` (14) — Discord custom-id
  security: duplicate Continue, stale Continue, forged continuation id,
  forged vendor id, forged item slug, sold-out, duplicate Buy, malformed ids
- `tests/unit/worldEncounterResolvedView.test.ts` (7) — the outcome embed
  narrates the spawn *result*, and offers a button only when there is
  something to open
- `tests/unit/migrationJournal.test.ts` (8) — journal/file consistency, which
  is what the startup migrator actually reads
- `tests/integration/wildEncounterSpawn.test.ts` (21) — the spawner and the
  `trigger_waifumon_encounter` bridge against real Postgres *(needs Docker)*
- `tests/unit/worldEncounters/simulator.test.ts` — rewritten against the
  exported `simulateChoice` rather than an inline copy of it

**Files edited (major):**

- `src/api/portalSession.ts` — `BrowserSession.permissions`
- `src/api/routes/auth.ts` — enrichWithPermissions
- `src/api/server.ts` — portalAuth.authorization
- `src/api/context.ts` — portalAuthorization
- `src/api/errors.ts` — PORTAL_PERMISSION_DENIED
- `src/api/routes/v1/index.ts` — admin routes registration
- `src/modules/buddyBonus/buddyBonusEffects.ts` + `content/bonus.json` — encounter_check_bonus
- `src/modules/worldEncounters/worldEncounterService.ts` — vendor/continuation wiring, getActivationById, real percentFor
- `src/modules/worldEncounters/worldEncounterRepository.ts` — continuationOfId
- `src/modules/worldEncounters/seed.ts` — Bandit → Aftermath
- `src/discord/types.ts` — worldEncounter* on AppServices
- `src/discord/client.ts` — 3 new handlers
- `src/discord/commands/waifumonWorldEncounter.ts` — Continue + Vendor
- `src/discord/worldEncounterPresenter.ts` — Continue/Open shop buttons
- `src/index.ts` — full wiring (guildOwnership, portalAuthorization, vendor, seeds)
- `portal/src/auth/types.ts`, `useSession.ts`, three provider files
- `portal/src/api/client.ts` — mutation helpers
- `portal/src/app/router.tsx` — admin routes
- `portal/src/app/navigation.ts` — Admin nav item
- `portal/src/components/layout/NavList.tsx` — permission filter
- `tests/helpers/fixtures.ts` — bootstrapApp wires all encounter services + seeds

## Runtime invariants

1. `active_world_encounters_player_pending_uq` — one pending encounter per
   player at a time; double-clicks race on the insert.
2. `world_encounter_vendor_instances_active_encounter_uq` — re-opening a
   vendor from the same encounter picks up the existing row.
3. Vendor purchase is `SELECT…FOR UPDATE` on the instance row +
   `CurrencyService.spendWaifubux/spendEssence` (which is itself a
   `WHERE balance >= amount` conditional update). No oversell is possible.
4. Chained continuation is inserted **after** the parent flips to
   `resolved` — parent then no longer occupies the partial unique index
   slot, so the child insert succeeds.
5. Guild ownership is fetched live from Discord.js; the cache TTL is 5 min
   (aligns with the Portal session identity policy) and events invalidate
   on transfer.
6. Permissions are re-computed on every `/auth/session` and `/auth/guild`
   response. UI hides admin surfaces via `useHasPermission`; API
   independently re-checks on every route.
7. Bearer-token API requests do **not** bypass permission checks. The shared
   `PLATFORM_API_TOKEN` is a read credential; `PLATFORM_API_ADMIN_BEARER=true`
   is the operator's explicit decision to make it administrative.
8. `resolveBuddyBonusPercent` is no longer a stub — the encounter check
   resolver reads through
   `deps.buddyBonus.percentFor(tx, playerId, 'encounter_check_bonus')`
   at all three call sites.

## Deployment steps

1. Merge branch into main.
2. `npm run db:generate` — optional; the hand-written `0025` migration is
   committed and passes the runtime migrator.
3. Deploy backend. `node-postgres` picks up
   `0025_encounter_continuation_and_vendor.sql` and
   `0026_wild_encounter_origin.sql` automatically, in journal order.
   Both are additive: two nullable columns, one partial unique index, two
   new tables. No backfill, no rewrite, nothing to run by hand.
4. Startup seeds run:
   - `seedWorldEncounters(db)` — upserts `tv_bandit_aftermath` and updates
     `tv_bandit_ambush.Fight` with the chain effect.
   - `seedWorldEncounterVendors(db)` — upserts the Wandering Merchant
     definition.
5. Bot startup: after `client.ready`, ownership cache primes from
   `client.guilds.cache`; `guildCreate`/`guildUpdate` handlers sync on
   future changes.
6. **Decide `PLATFORM_API_ADMIN_BEARER`.** It defaults to `false`, which is
   almost certainly what you want: Portal Admin is then reachable only
   through a Discord-OAuth cookie session belonging to the owner of the
   selected guild. Set it to `true` only if you intend scripts holding
   `PLATFORM_API_TOKEN` to be administrators.
7. Portal: production build honours the `verify-build-env.mjs` guard, and
   `verify-bundle.mjs` now also refuses a bundle that grants Portal
   permissions client-side.
   Admin routes and the "Admin — Encounters" nav item light up
   automatically for any session whose `/auth/session` payload carries the
   permissions.

## Known limitations (carried forward)

1. **Percentage-loss cap in the simulator** — no live player balance to read
   against, so it treats `maxAmount` (or `percent × 500` as a default) as the
   full loss. Upper-bound guidance, and the only figure in the simulation
   report that is an approximation rather than an observation.
2. **Drizzle snapshot drift (pre-existing)** — `drizzle/meta/` holds snapshots
   only up to `0010`. Migrations have been hand-written since `0005`, which
   the runtime migrator is perfectly happy with (it reads `_journal.json` and
   the `.sql` files, not the snapshots), but `drizzle-kit generate` cannot
   diff against a snapshot that is sixteen migrations stale. Left alone
   deliberately: rebuilding snapshot history is a risky change to make during
   a closure pass, and it blocks nothing today.
   `tests/unit/migrationJournal.test.ts` pins the journal-to-file consistency
   the migrator actually depends on.
3. **Vendor variety** — Phase 2 ships only the Wandering Merchant. Schema
   supports randomised inventories and region-scoped stock (via the JSONB
   template), but only fixed stock is implemented today.
4. **History browser** — `encounters.history` permission is reserved but no
   route or UI reads it yet. It doubles as the `verify-bundle` canary for
   exactly that reason: nothing in the Portal reads it.
5. **Bot-less API deployments** — `portalAuthorization` is optional; a
   deployment without a Discord bot cannot compute permissions and every
   admin endpoint returns 403. This is the intentional safe default.
6. **Docker/testcontainers required for integration tests** — the three new
   `tests/integration/**` files are typecheck-clean and follow existing
   `bootstrapApp` fixtures. Bring Docker Desktop up or point
   `TEST_DATABASE_URL` at a reachable Postgres.

## Pre-existing test failures (not Phase 2)

Nineteen tests in the following files fail on this branch and on the
`origin/Encount` parent alike — reproducible by checking out the parent
commit and running `npm test`:

- `tests/unit/bossContent.test.ts` — 7
- `tests/unit/bossPresenter.test.ts` — 5
- `tests/unit/bossRewards.test.ts` — 2
- `tests/unit/bossShuffleBag.test.ts` — 1
- `tests/unit/content.test.ts` — 4

All are content-drift failures ("ships exactly ten definitions", "every
shipped species is affinity switch", etc.) predating Phase 1 and
independent of the encounter system. They are called out here so a future
handoff run does not misattribute them.

## Phase 1 items corrected rather than extended

- **`resolveBuddyBonusPercent()`** — Phase 1 was a stub returning `0` with
  a comment saying "the swap is a one-line change once the effect id is
  added". Phase 2 added the effect id and made the swap. The three call
  sites now read through the real service.
- **`resolveChoice`** — Phase 1 emitted follow-up markers for
  `trigger_encounter` and `open_vendor` but did nothing else. Phase 2
  rewrote it to atomically insert continuation rows and open vendor
  instances inside the same transaction. Return type gained
  `continuationActiveId` and `vendorInstance` fields.
- **`tests/unit/api/routes.test.ts` mutation-verb allowlist** — widened
  from 1 to 8 entries to acknowledge the seven new admin encounter
  mutation verbs. Not a bug fix, but a required pin update.

## Recommended next phase (Phase 3)

1. **Discord role → WaifuMon permission mapping** — configurable role
   allowlists (Moderator, Content Editor) in
   `content/portalRoles.json`. The `PortalAuthorizationService`
   `PermissionReason` union already supports the extension; the new rule
   just appends to `computePermissionsFor`.
2. **Reuse `createWildEncounter` from quests, items and events** — the
   spawner already accepts an `origin` for each of them; only the callers
   are missing.
3. **Randomised vendor inventory** — replace `instantiateStock` with a
   seed-based selector; add `stockGeneration: 'fixed' | 'random'` on the
   definition. Schema already accommodates it via the JSONB template.
4. **History browser** — `GET /v1/admin/encounters/:id/history` +
   `encounters.history`-gated Portal timeline view.
5. **Portal encounter history for players** — read-only "recent adventures"
   surface that reuses the existing `world_encounter_history` table.
