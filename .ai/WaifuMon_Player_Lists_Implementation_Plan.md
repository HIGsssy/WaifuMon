# WaifuMon — Player-Created Waifumon Lists: Audit & Implementation Plan

Status: **planning only, nothing implemented.** Audited against branch `Encount` @ `3a447b2` (2026-09-18).

Players create private, named, manually ordered lists of **owned copies** (`player_waifus` rows, not species). A copy can be on many lists. Lists are an organisational tool. They are not a gameplay mechanic, and they never lock anything.

---

## 1. Current architecture findings

### 1.1 Database

| Fact | Where | Consequence for lists |
|---|---|---|
| `player_waifus` is one row per owned copy. PK `bigint GENERATED ALWAYS AS IDENTITY`, `player_id → players.id` (FK, `no action`), indexes `(player_id)` and `(player_id, species_id)` | `src/db/schema.ts:558` | Membership references `player_waifus.id`, so duplicates of the same species are kept apart. |
| **Release is a soft delete.** `softRelease()` sets `released_at = now()` and never deletes the row. Release and duplicate conversion both go through it (`releaseWaifu`, `convertDuplicateToEssence`). | `src/modules/collection/collectionService.ts:806-897, 1002-1036` | **An `ON DELETE CASCADE` FK alone would never fire on release.** Removing memberships on release has to happen in application code inside the release transaction. The cascade is still worth having as a safety net (see §7). |
| Released copies are hidden by `released_at IS NULL` on every read. | same file, `fetchActiveCopies`, `getOwned`, … | List reads must apply the same filter, as defence in depth. |
| Buddy (`players.buddy_waifu_id`) and Care target have **no FK**. The application enforces them and self-heals. Favourite is `player_waifus.is_favorite`. | `schema.ts:124-140` | Lists must not touch any of these. The release guard reads only `is_favorite` and `buddy_waifu_id`. |
| `players` is **per guild**: unique `(guild_id, discord_user_id)`. | `schema.ts:114-168` | Anything keyed on `player_id` is already scoped to one guild, so no `guild_id` column is needed. |
| FK conventions: FKs to `players` are `ON DELETE no action`, and nothing deletes players. Child tables of authored parents use `ON DELETE cascade` (`world_encounter_*`). Join tables use composite PKs (`player_achievements`, `player_unlocked_routes`, …). | schema / `drizzle/0024`, `0031` | Follow these conventions exactly. |
| Timestamps are `timestamp with time zone NOT NULL DEFAULT now()`. Writes set `updatedAt: sql\`now()\``. | e.g. `result_presentation_variants`, `currencyService.ts:72` | Same here. |
| Text columns are bounded by CHECK constraints whose limits come from TS constants via `sql.raw` (`btrim(x) <> '' and char_length(x) <= N`). | `result_presentation_variants_flavor_text_check` | Same pattern for list name and description. |
| No DB triggers anywhere. | `drizzle/*.sql` | Do not introduce the first one for this feature. |
| **Migrations have been hand-written since 0005.** Each is a `drizzle/NNNN_name.sql` plus a `_journal.json` entry with a monotonic `when`. Snapshots stop at 0010. `tests/unit/migrationJournal.test.ts` enforces journal/file agreement. Head is `0034_result_presentation_keys_v2`. | `drizzle/`, `src/db/migrate.ts` | New migration: `0035_player_waifu_lists.sql`, hand-written, with an explanatory header comment like 0031/0033. |
| Tests run real Postgres per file (`tests/helpers/testDb.ts`) and apply the real migrations. Several tests `db.delete(playerWaifus)` outright (`bossScheduler`, `essenceBatch`, …). | tests | The membership FK to `player_waifus` **must** cascade, or those cleanups break as soon as a membership exists. |

### 1.2 API (Fastify 5 + zod type provider)

- **Route organisation:** one file per resource in `src/api/routes/v1/*.ts`, a matching `src/api/schemas/*.ts`, and one `app.register(...)` line in `routes/v1/index.ts`. Player resources live under `/players/:playerId/...`.
- **Auth** (`src/api/auth.ts`, `onRequest`): either the shared bearer token (`apiAuth='bearer'`) or a Portal session cookie `wm_portal_session` (`apiAuth='portal'`, session row resolved by HMAC digest).
- **CSRF:** already global. Every non-GET/HEAD Portal request must carry `x-portal-csrf` **and** the `wm_portal_csrf` cookie, both equal to `session.csrfToken`, or the request fails with `403 PORTAL_CSRF_INVALID`. The Portal client (`portal/src/api/client.ts:255-263`) attaches the header automatically for every non-GET. **Lists need nothing new here.**
- **Player scope** (`src/api/plugins/playerScope.ts`, `preHandler` at the v1 root): resolves `:playerId` (404 `PLAYER_NOT_FOUND`). For Portal sessions it rejects any `playerId ≠ session.playerId` with `403 PORTAL_FORBIDDEN`, unless the route opts into `config.publicGuildProfile`. Handlers call `requirePlayer(req).id`. **This is the proof that the acting player is the path player.** `session.playerId` is set server-side by `selectGuild()` from `eligibleGuilds` and is never taken from the client.
- **Guild scope** (`plugins/guildScope.ts`) exists for guild-wide reads (directory, leaderboards). Lists don't need it because `player_id` already implies the guild.
- **Ownership pattern in services:** `WHERE id = :waifuId AND player_id = :playerId`, with `WaifuNotOwnedError` (404) for missing or foreign and `WaifuAlreadyReleasedError` (409) for released. Mutations wrap `db.transaction` and `.for('update')` the row being changed (`toggleFavorite`, `softRelease`, `investEssenceBatch`).
- **Errors:** `AppError(code, internalMsg, userMessage)`. `src/api/errors.ts` `STATUS_BY_CODE` maps code to status: 404 for an unknown resource, 409 for a state conflict, 422 for a rule refusal, 400 for validation. Unmapped codes become 500, and `tests/unit/api/errors.test.ts` asserts every exported `AppError` subclass is classified. `ApiFieldValidationError` carries per-field `details.issues`.
- **Envelope:** `ok(req, data)` / `okPage(...)` → `{ data, meta: { requestId } }`. Delete routes return `{ id, deleted: true }` (`admin/resultPresentations.ts:534`).
- **Validation:** zod bodies with `.strict()` on write routes (`admin/resultPresentations.ts:129-159`). Path ids use `idParam` (`z.coerce.number().int().positive()`).
- **CRUD precedent:** `admin/resultPresentations.ts` and `admin/access.ts` use POST create, PATCH edit, DELETE. The only player-scoped write today is `PUT /players/:playerId/collection/owned/:waifuId/appearance`. The API exposes it but the Portal never calls it (`AppearanceGallery.tsx:28`).
- **Services** are built in `src/index.ts`, typed in `AppServices` (`src/discord/types.ts`), and mirrored in `tests/helpers/fixtures.ts` `bootstrapApp`.
- **Ordering precedent:** `world_encounter_choices.sort_order integer`. It is rewritten wholesale inside one transaction on save (`adminService.ts:201-225`, `repo.replaceChildren`), and reads order by `sort_order, id`.
- **No existing unique-violation (23505) handling.** Lists will be the first route to translate one.

### 1.3 Portal (React 19, TanStack Query 5, react-router 7, Radix, Tailwind 4)

- **Collection pipeline** (`features/collection/CollectionPage.tsx`): `useEntireCollection` walks every API page (25 per page) into one cached array. `filterEntries(...)` (`content/species.ts:92`) runs on the complete set, then `sortEntries`, then a client-side slice per page. Filters are URL state (`useCollectionParams.ts`). Unknown values read as "all". Any filter change resets to page 1.
- **Toolbar** (`CollectionToolbar.tsx`) builds `FilterGroup[]` (Rarity, Type, Affinity, Zone, Show) plus active chips for `FilterToolbar`. Adding a "List" group is a local change.
- **Self and public collection share one renderer.** `mode='public'` disables self-only hooks by passing `enabled: false`. Any list query must do the same.
- **`WaifumonCard`** is a single `<Link>`. Nesting a button inside it would be invalid interactive content, and it has no action menu. Badges (favourite, buddy) float over the art.
- **`WaifumonDetail`** is a stack of `Card`s. Self-only sections are *omitted* in public mode, not disabled (the `AppearanceGallery` precedent), so their queries never mount.
- **The Portal is documented as read-only for players.** `CollectionPage.tsx` header comment, `package.json` description, and tests assert that no release/rename/set-buddy/favourite buttons exist (`WaifumonDetailPage.test.tsx:47`, `PublicCollection.test.tsx:267`). **Lists would be the first player-authored write in the Portal.** Those tests stay valid because lists are not game actions, but the comments need rewording (see §12).
- **Architecture test** (`portal/src/__tests__/architecture.test.ts`): only the explicit API helper modules may call `apiClient.post/put/patch/delete` directly, and everything else uses `postData/patchData/putData/deleteData` from `client.ts`. A new `api/lists.ts` built on those helpers passes unchanged.
- **Mutations** follow the admin precedent: `useMutation` plus `queryClient.invalidateQueries` (`AdminRoleAccessPage.tsx:92-120`).
- **Query keys** (`api/queryKeys.ts`): player keys start with `['player', playerId, …]`, and prefix invalidation is the idiom. The cache policy is `PLAYER_POLICY` (45 s stale, refetch on focus).
- **Navigation** (`app/navigation.ts`): a flat `NAV_ITEMS` list whose order is intentional. Routes are lazy chunks in `app/router.tsx`.
- **Reorder infrastructure:** no drag-and-drop library is installed. The only reorder UI is the admin `ChoiceEditor` Move-up/Move-down/Remove buttons (`ChoiceEditor.tsx:106-113`).
- **UI primitives available:** `dialog`, `sheet`, `popover`, `select`, `input`, `button`, `badge`, and `ArtworkThumbnail` for compact rows.
- **Portal tests:** vitest + RTL + msw (`portal/msw`, `test/renderWithProviders.tsx`), an axe helper, and Playwright e2e.

### 1.4 Ascension brief (for coupling only)
Ascension keeps the **same copy** past the Lv 50 cap. It may also *consume* duplicate copies (brief §11) and uses non-consumed "Resonance" copies (§10). If consumption reuses `softRelease` or the helper in §7, list cleanup is automatic. See §12 for the open questions.

---

## 2. Recommended data model

Two new tables, one new unique index on `player_waifus`, and one hand-written migration `drizzle/0035_player_waifu_lists.sql`.

### 2.1 `player_waifu_lists`

| Column | Type | Constraints |
|---|---|---|
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` | PK |
| `player_id` | `bigint NOT NULL` | FK → `players.id` `ON DELETE no action` (repo convention; players are never deleted) |
| `name` | `text NOT NULL` | `CHECK (btrim(name) <> '' AND char_length(name) <= 40)` |
| `description` | `text NULL` | `CHECK (description IS NULL OR (btrim(description) <> '' AND char_length(description) <= 200))` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | Bumped on metadata edits **and** on membership/order changes (the list row is locked for those anyway) |

Indexes:
- `player_waifu_lists_player_name_uq` UNIQUE on `(player_id, lower(name))`. Names are unique per player, case-insensitively. The index also serves "all lists for a player" through its leading column.
- `player_waifu_lists_id_player_uq` UNIQUE on `(id, player_id)`. This is the target of the composite FK below.

Limits in the CHECKs come from `src/modules/lists/limits.ts` through `sql.raw`, as `RESULT_PRESENTATION_FLAVOR_MAX_LENGTH` does.

### 2.2 `player_waifu_list_members`

| Column | Type | Constraints |
|---|---|---|
| `list_id` | `bigint NOT NULL` | |
| `player_id` | `bigint NOT NULL` | Denormalised owner, see below |
| `player_waifu_id` | `bigint NOT NULL` | |
| `sort_order` | `integer NOT NULL` | `CHECK (sort_order >= 0)` |
| `added_at` | `timestamptz NOT NULL DEFAULT now()` | |

- PK `(list_id, player_waifu_id)`. This gives the required `UNIQUE(list_id, player_waifu_id)` and follows the composite-PK convention for join tables.
- FK `(list_id, player_id)` → `player_waifu_lists(id, player_id)` `ON DELETE CASCADE`. Deleting a list removes its members.
- FK `(player_waifu_id, player_id)` → `player_waifus(id, player_id)` `ON DELETE CASCADE`. This is the safety net for hard deletes (test cleanup, future admin tooling).
- Index `player_waifu_list_members_list_order_idx` on `(list_id, sort_order)` for ordered member reads.
- Index `player_waifu_list_members_player_idx` on `(player_id)` for the Collection membership overlay (§6), with no join needed.
- Index `player_waifu_list_members_waifu_idx` on `(player_waifu_id)` for cascade lookups and release cleanup (Postgres does not index the referencing side automatically).

### 2.3 New index on `player_waifus`
- `player_waifus_id_player_uq` UNIQUE on `(id, player_id)`. It is trivially unique because `id` is the PK, but Postgres requires a unique constraint on exactly the referenced columns before a composite FK can point at them.

### 2.4 Why these choices

- **Denormalised `player_id` with composite FKs.** A membership row whose list and copy belong to different players is **impossible at the database level**, not just checked in the service. Your hard requirement ("never add another player's Waifumon") becomes a schema invariant. It also makes the membership overlay a single indexed scan by `player_id`. The cost is one extra btree on `player_waifus`, which is small at tens to hundreds of rows per player. If you don't want to touch `player_waifus`, drop the composite FKs and use plain single-column FKs. The service checks in §3 still enforce the rule, but only in application code.
- **No `guild_id`.** `player_id` is already guild-specific. A second scope column could only disagree with the first.
- **Composite PK, no surrogate id on members.** A membership has no identity beyond the pair, and every operation addresses it by `(list, copy)`.
- **Unique names, case-insensitive.** Duplicate names give no value in a filter dropdown ("Boss Team" vs "boss team" can't be told apart there), and the repo already treats human-facing labels as unique within scope (`guild_admin_role_grants (guild, role)`). The service normalises names before insert (NFC, trim, collapse internal whitespace runs, reject control characters), and the DB index is the race-proof backstop.
- **No `kind`, `visibility` or `rules` columns in V1.** Each can be added later as a defaulted column (`visibility text NOT NULL DEFAULT 'private'`, `kind text NOT NULL DEFAULT 'manual'`) without a backfill. Nothing here blocks sharing or smart lists (§12).
- **No list-level `sort_order` in V1.** My Lists sorts by name. A manual order of the lists themselves can be added later without a backfill (default by `created_at`).
- **Ascension needs no schema change.** "Ascension Candidates" is just a list name. Because Ascension keeps the same `player_waifus` row, memberships survive ascending.

---

## 3. Security model

Every route is under `/players/:playerId/lists…`. **None** sets `config.publicGuildProfile`, so every route is self-only by default.

| Proof needed | How it is proven | Reused mechanism |
|---|---|---|
| Caller is authenticated | `onRequest` auth hook (bearer or Portal cookie session) | `src/api/auth.ts` |
| Write is not cross-site | Global CSRF double-submit check on every non-GET Portal request | `src/api/auth.ts:95-111`, `portal/src/api/client.ts:255` |
| Acting player = path player | `preHandler` player-scope hook: a Portal session's `playerId ≠ :playerId` gets `403 PORTAL_FORBIDDEN`, and handlers read **only** `requirePlayer(req).id` | `plugins/playerScope.ts` |
| Guild cannot be crossed | `session.playerId` is set server-side by `selectGuild()` from the OAuth-derived `eligibleGuilds`. Player rows are per guild, so a guild-1 session holds a guild-1 `playerId` and every list query is filtered by it. The client never sends a guild. | `portalSession.ts:selectGuild` |
| List belongs to player | Every list lookup is `WHERE id = :listId AND player_id = :playerId` (with `FOR UPDATE` on writes). No row gives `404 LIST_NOT_FOUND`, the **same** response for "doesn't exist" and "someone else's", so ids can't be enumerated. | Same shape as `getOwned` / `softRelease` |
| Copy belongs to player | Adds select `WHERE id = ANY(:ids) AND player_id = :playerId AND released_at IS NULL` inside the transaction. Any missing id gives `404 WAIFU_NOT_OWNED`, any released one gives `409 WAIFU_ALREADY_RELEASED`, and a batch is **all or nothing**. | `WaifuNotOwnedError`, `WaifuAlreadyReleasedError` |
| No foreign copy can slip in | The composite FKs (§2.2) reject any membership whose list owner ≠ copy owner, even if a service bug skips the check. | Postgres |
| Reorder cannot smuggle ids | The request's id set must **equal** the list's current active member set exactly (no extras, no omissions, no duplicates), or `409 LIST_ORDER_STALE`. | New, in service |

Rules:
- The service API takes `playerId` as its first argument on every method, matching `collectionService`. Route handlers never read a `playerId` from a body. `.strict()` bodies reject a smuggled `playerId` key with 400.
- Bearer-token callers can address any player, as on every existing player route. That is the existing trust model for the bot and operator tooling. Nothing changes.
- Lists never appear in any public resource. Public schemas are explicit allowlists (`publicOwnedWaifuSchema`), so nothing leaks by accident. Add a regression test anyway (§10).

---

## 4. API design

New files: `src/modules/lists/{playerListService.ts, limits.ts, normalize.ts}`, `src/api/schemas/lists.ts`, `src/api/routes/v1/lists.ts` (registered in `routes/v1/index.ts` after `collectionRoutes`), and `playerLists` added to `AppServices`, `src/index.ts` and `tests/helpers/fixtures.ts`.

All responses use the `{ data, meta }` envelope. `:playerId`, `:listId` and `:waifuId` use `idParam`.

| Method & path | Purpose | Body | 200 `data` |
|---|---|---|---|
| `GET /players/:playerId/lists` | My Lists | – | `{ lists: ListSummary[], limits: ListLimits }` |
| `POST /players/:playerId/lists` | Create | `{ name, description? }` strict | `ListSummary` |
| `GET /players/:playerId/lists/memberships` | Collection overlay (§6) | – | `{ memberships: { waifuId, listIds: number[] }[] }` |
| `GET /players/:playerId/lists/:listId` | One list with ordered members | – | `ListDetail` |
| `PATCH /players/:playerId/lists/:listId` | Rename/describe | `{ name?, description?: string \| null }` strict, at least one key | `ListSummary` |
| `DELETE /players/:playerId/lists/:listId` | Delete list (members cascade; copies untouched) | – | `{ id, deleted: true }` |
| `POST /players/:playerId/lists/:listId/members` | Add one or more copies (appended in given order) | `{ waifuIds: number[] }` strict, 1–50, unique | `{ listId, added: number[], alreadyPresent: number[], memberCount }` |
| `DELETE /players/:playerId/lists/:listId/members/:waifuId` | Remove one copy | – | `{ listId, waifuId, removed: boolean, memberCount }` |
| `PUT /players/:playerId/lists/:listId/order` | Replace the full manual order | `{ waifuIds: number[] }` strict, unique | `ListDetail` |

Shapes:
```ts
ListSummary = { id, name, description: string|null, memberCount, createdAt, updatedAt }
ListLimits  = { maxLists, maxMembersPerList, nameMaxLength, descriptionMaxLength, maxAddBatch }
ListDetail  = ListSummary & { members: Array<{ position: number /* 1-based, dense */, addedAt, entry: OwnedEntry }> }
```
- `entry` reuses `ownedEntrySchema` and the collection route's `toEntry` mapping (waifu, species and progress, with embedded appearance). The Portal can then reuse `displayName`, `Artwork`/`ArtworkThumbnail`, rarity and affinity pills with no new resource type. Pull `toEntry` into a shared helper in `routes/v1/collection.ts` or `resources.ts` rather than duplicating it.
- `position` is **computed** as a dense 1..n from the ordered read. Stored `sort_order` gaps are never exposed.
- `memberCount` and `members` only count copies with `released_at IS NULL`.
- Static `/lists/memberships` beats parametric `/lists/:listId` in Fastify's router. The repo already relies on this for `/players/lookup`. Add a route test anyway.

Design notes:
- **Membership add/remove is idempotent.** Adding a copy that is already present reports it in `alreadyPresent`. Removing a non-member returns `removed: false` with 200. This departs slightly from the admin "delete missing → 404" precedent, deliberately: membership toggles come from checkboxes that two tabs can race, and "already in the state you asked for" is success. A **list** that isn't found is still a 404.
- **Batch add** exists so the "Add Waifumon" picker (§5) can commit several copies in one transaction. The per-copy "Manage lists" toggle uses the same route with one id. There is no bulk remove in V1.
- **No bulk "set this copy's lists" endpoint.** Per-toggle calls keep the model simple and match the checkbox UI.

New error codes (added to `STATUS_BY_CODE` and exported as `AppError` subclasses so the classification test covers them):

| Code | Status | When |
|---|---|---|
| `LIST_NOT_FOUND` | 404 | Missing **or** another player's list |
| `LIST_NAME_TAKEN` | 409 | Case-insensitive duplicate. The service also maps a Postgres `23505` on `player_waifu_lists_player_name_uq` to this, which covers concurrent creates |
| `LIST_ORDER_STALE` | 409 | Reorder set ≠ current member set. `details: { memberCount }` |
| `LIST_LIMIT_REACHED` | 422 | Creating past `maxLists` |
| `LIST_FULL` | 422 | Add would exceed `maxMembersPerList`. Nothing is added |
| (reuse) `WAIFU_NOT_OWNED` 404, `WAIFU_ALREADY_RELEASED` 409, `VALIDATION_ERROR` 400 | | Field problems (empty/too long name, etc.) use `ApiFieldValidationError` with `details.issues` so the dialog can show them inline |

### 4.1 Service transactions (all `db.transaction`)
- **create:** lock `players` row `FOR UPDATE` (serialises the count check for one player, as `softRelease` does), count lists, and fail with `LIST_LIMIT_REACHED` if at the cap. Then insert and translate `23505`.
- **update:** `UPDATE … WHERE id AND player_id RETURNING`, with `updated_at = now()`. No row gives `LIST_NOT_FOUND`, and `23505` gives `LIST_NAME_TAKEN`.
- **delete:** `DELETE … WHERE id AND player_id RETURNING id`. The cascade removes members.
- **addMembers:** lock list `FOR UPDATE` (by `id AND player_id`) → validate ownership and active state of all ids → count current active members → enforce cap on the *new* ids only → `max(sort_order)` → `INSERT … ON CONFLICT (list_id, player_waifu_id) DO NOTHING RETURNING player_waifu_id` with `sort_order = max+1+i` → bump `updated_at`.
- **removeMember:** lock list → `DELETE … WHERE list_id AND player_waifu_id RETURNING` → bump `updated_at` if a row was removed. The gap left behind is fine (§8).
- **reorder:** lock list → load active member ids → set equality check → one statement:
  `UPDATE player_waifu_list_members m SET sort_order = v.ord - 1 FROM unnest($ids::bigint[]) WITH ORDINALITY AS v(id, ord) WHERE m.list_id = $list AND m.player_waifu_id = v.id` → bump `updated_at` → return the detail.
- **memberships:** `SELECT m.player_waifu_id, m.list_id FROM members m JOIN player_waifus w ON w.id = m.player_waifu_id WHERE m.player_id = $1 AND w.released_at IS NULL`, grouped by waifu in TS.

---

## 5. Portal UX

### 5.1 Navigation
Add **"Lists"** (lucide `ListOrdered`) to `NAV_ITEMS` **directly after Collection**. Routes are `/lists` and `/lists/:listId` (lazy chunks). It is a collection companion, so it belongs next to Collection, not in the social or admin groups.

### 5.2 My Lists (`/lists`)
- `PageHeader` "Lists" with a **New list** primary action. The action is disabled with a tooltip at `maxLists`.
- A responsive grid of list tiles (1 column on phones, 2 at `sm`, 3 at `lg`). Each tile shows the name, a two-line clamped description, "12 Waifumon", and "Updated 3 days ago". The whole tile links to `/lists/:id`. Sort order is alphabetical.
- Empty state: "No lists yet. Make one to plan who to level, ascend or send to a boss", with a Create button.
- **Create/Edit dialog** (`ui/dialog`): name input with a live character counter against `limits.nameMaxLength`, optional description textarea with a counter, and inline errors from `details.issues` or `LIST_NAME_TAKEN`. The dialog is shared by create and edit.
- **Delete:** a confirm dialog that names the list and says plainly *"The Waifumon on it stay in your collection."* It is never one-click.

### 5.3 List detail (`/lists/:listId`)
- Header: name, description, member count, and a trailing overflow with Edit, Delete and **Reorder**, plus a primary **Add Waifumon** action.
- **Member presentation: a compact row component (`ListMemberRow`), not `WaifumonCard`.** The card is a 3:4 art tile with no room for a position, and wrapping it in a Link would conflict with row controls. A priority list reads as a ranked table. Each row shows:
  `#position` · `ArtworkThumbnail` · display name (nickname or species) and species subtitle · `Lv N` · `RarityBadge` · `AffinityPill` · favourite ★ and buddy ♥ icons (buddy from the existing `useBuddy`) · a trailing **Remove** icon button.
  The row body links to `/collection/:waifuId`. On phones the rarity and affinity drop to a second line, and the row stays one tap target plus one trailing control.
- **Add Waifumon:** a `Sheet` on mobile or a `Dialog` on desktop over the cached `useEntireCollection` data (no extra request). It has a search box, rarity chips, and multi-select checkboxes. Current members are excluded or shown as "Already on list". **Add N** commits one `POST …/members`.
- Empty list state: "Nothing on this list yet", with an Add Waifumon action.

### 5.4 Manual ordering interaction (recommended: explicit Reorder mode, no drag-and-drop)
- **Reorder** switches the list into edit mode. Each row shows **↑ / ↓** buttons (44 px targets) and a small menu with *Move to top*, *Move to bottom* and *Move to position…* (number input, useful for long lists). Links and Remove are hidden while editing.
- Moves are **local only** until **Save order**, which sends one `PUT …/order` with the full id array. **Cancel** reverts. A sticky footer shows "Unsaved order changes · Cancel · Save".
- On `409 LIST_ORDER_STALE` (membership changed elsewhere), refetch and show "This list changed in another tab. Your order was not saved." The player can then redo the reorder on fresh data.
- **Why not drag-and-drop in V1:** no DnD library is installed; touch DnD fights page scroll on phones; and arrow buttons are accessible by keyboard and screen reader with no extra work. The only existing reorder UI (admin ChoiceEditor) already uses up/down buttons. DnD (e.g. `@dnd-kit`) can be layered on later over the same Save-order model without an API change.
- **Why not save per click:** one request per arrow press would mean N transactions for one intent, racing each other. One PUT with a full order is atomic, easy to reason about, and makes the stale check meaningful.
- Screen reader: `aria-live` announces "Nyx moved to position 3 of 12" on each local move.

### 5.5 Membership from an owned copy (detail page)
- A new **"Lists"** `Card` in `WaifumonDetail`, **self mode only and omitted in public mode**, following the `AppearanceGallery` precedent. It shows chips for the lists this copy is on (each links to the list) and a **Manage lists** button.
- **Manage lists** opens a `Popover` on desktop or a `Sheet` on phones. It lists every list with a checkbox reflecting membership. Toggling fires `POST …/members {waifuIds:[id]}` or `DELETE …/members/:id` straight away, with an optimistic update and rollback on error. The bottom row, "+ New list…", creates a list inline and adds the copy to it.
- **Nothing is added to `WaifumonCard`.** The card is a single link (a nested button would be invalid), and a per-card control would clutter every tile. An optional **later** step is a small "on N lists" indicator in the metadata strip, fed from the overlay; it is not V1.
- **Buddy page:** no change in V1. It can reuse the same Lists card later.

### 5.6 Collection filtering
Add a **"List"** `FilterGroup` to `CollectionToolbar` (**self mode only**). The options are *All* followed by each list by name. There is a URL param `?list=<id>` and an active chip "List: Level Next". Details are in §6.

### 5.7 Responsive summary
| Surface | Desktop | Phone |
|---|---|---|
| My Lists | 3-column tile grid | 1-column stack |
| Create/Edit | Dialog | Dialog (full width) |
| Add picker | Dialog with grid of selectable thumbnails | Bottom `Sheet`, 2-column thumbnails |
| Manage lists (detail page) | Popover | Bottom `Sheet` |
| Reorder | Inline ↑/↓ plus menu, sticky save bar | Same, sticky bottom save bar, larger targets |

---

## 6. Collection integration

The existing pipeline is unchanged except for one extra predicate:

```
useEntireCollection(playerId)            ← all pages, cached (unchanged)
useListMemberships(playerId)             ← ONE request, self mode only
        │
filterEntries(entries, { …existing, listMemberIds }, buddyId)   ← full dataset
        │
sortEntries(filtered, params.sort)       ← global sort (unchanged)
        │
slice(page)                              ← client pagination (unchanged)
```

- `useCollectionParams` gains `list: number | null`, parsed as a positive integer. Writing it resets the page, as every filter does. It is included in `hasFilters` and cleared by `clearFilters`.
- In `CollectionPage`, `listMemberIds` is built as `new Set(memberships.filter(m => m.listIds.includes(params.list)).map(m => m.waifuId))` inside a `useMemo`. `filterEntries` adds `if (filters.listMemberIds && !filters.listMemberIds.has(entry.waifu.id)) return false`.
- **An unknown or deleted list id in the URL reads as no list filter**, matching how unrecognised `zone` values behave. The toolbar's list group then shows *All*.
- While the overlay is still loading and `?list` is set, show the **skeleton grid** rather than the unfiltered collection, so a filtered link never flashes the wrong result.
- Public mode calls `useListMemberships(…, { enabled: false })` and does not render the List group. The existing pattern keeps hook order stable.
- **No N+1:** membership data comes from exactly one `GET /lists/memberships` per player (≤ a few thousand small pairs worst case), cached under `['player', id, 'lists', 'memberships']` with `PLAYER_POLICY`. The detail page's Lists card reads **the same cached query**, so opening a copy costs no request if the Collection was visited first. Cards never ask.
- **Why an overlay and not a `listIds` field on `ownedEntry`:** it keeps the collection resource and service (shared with Discord) untouched; avoids a join on every page of the 25-row walk; and lets list mutations invalidate one small query instead of the expensive collection walk.
- **Optional, not V1:** when a list filter is active, offer a "List order" sort option that sorts by the overlay's position. That would need `position` in the overlay payload, which is cheap to add.

Query keys (all under the player prefix, invalidated by prefix on any list mutation):
```ts
lists:            (p) => ['player', p, 'lists']
listDetail:       (p, id) => ['player', p, 'lists', 'detail', id]
listMemberships:  (p) => ['player', p, 'lists', 'memberships']
```

---

## 7. Release behaviour

What happens when a listed copy is released or converted:

1. `softRelease()` runs its guards exactly as today: favourite and/or buddy give `WAIFU_RELEASE_BLOCKED`, and convert-duplicate rules are unchanged. **List membership is not read by any guard.** It never appears in `reasons` and never blocks.
2. In the same transaction, right after `UPDATE player_waifus SET released_at`, a new line runs:
   `DELETE FROM player_waifu_list_members WHERE player_waifu_id = $waifuId`.
   This goes in a small exported helper, `removeCopiesFromAllLists(tx, waifuIds)` in `src/modules/lists/`, so that any future path that retires a copy (Ascension duplicate consumption) calls the same function.
3. If the release rolls back (blocked, insufficient state, any error), the memberships roll back with it, because it is one transaction.
4. List `updated_at` is **not** bumped by a release. It records player edits, not side effects.

Defence in depth:
- **Hard deletes** of `player_waifus` (test cleanup, any future admin tool) cascade through the composite FK.
- **Every list read joins `released_at IS NULL`.** If some future soft-retire path forgets to call the helper, the copy still disappears from lists, counts and the overlay. It can't be un-released, so a leftover row is only dead weight.
- The Portal picks up a Discord-side release on its next `PLAYER_POLICY` refetch (on focus, or after 45 s). No push is needed.

The Buddy and Favourite code, error codes, messages and Discord confirmations are all unchanged.

---

## 8. Manual ordering

**Strategy: an integer `sort_order` per membership. Appends go to the end. Removals leave gaps. A reorder rewrites the whole list densely in one statement under a row lock on the list.**

- **Append:** `sort_order = COALESCE(max(sort_order), -1) + 1 + i`, computed under the list's `FOR UPDATE` lock, so two concurrent adds can't collide.
- **Remove:** delete the row and leave the gap. The order is relative, so reads use `ORDER BY sort_order, added_at, player_waifu_id` and the API reports a dense computed `position`.
- **Reorder:** the client sends the *complete* intended order. The server locks the list, checks the id set exactly, and rewrites `sort_order = 0..n-1` in one `UPDATE … FROM unnest(...) WITH ORDINALITY`. That also closes any gaps. At ≤ 250 members this is trivial.
- **Concurrency:**
  - Every membership write locks the list row, so add, remove and reorder on one list are serialised.
  - Membership changes between a client's read and its save are caught by the set-equality check (`409 LIST_ORDER_STALE`), so nothing is silently dropped or duplicated.
  - Two reorders of the *same* member set from two tabs: the last write wins. That is acceptable for a personal list, and an extra version column would cost more than it saves.
- **No `UNIQUE(list_id, sort_order)`.** It would force `DEFERRABLE` constraints for the wholesale rewrite, and ties are harmless given the deterministic tie-break.
- **Rejected alternatives:**
  - Fractional or lexorank keys: clever, need rebalancing, and give no benefit at this size.
  - Linked-list pointers: fragile.
  - Per-move "swap" endpoints: N transactions per intent, and racy.

---

## 9. Limits

| Limit | Value | Enforced | Rationale |
|---|---|---|---|
| Lists per player | **50** | Service (count under `players` row lock) | Enough for real categorisation (priority, team, rarity, zone, event plans). It keeps the Collection filter group and the Manage-lists popover usable, and bounds the overlay. |
| Name length | **40 chars** (after normalisation, ≥ 1 non-space) | zod + DB CHECK | Fits a filter chip and a nav-width tile with truncation. "Ascension Candidates" is 20. |
| Description length | **200 chars**, optional | zod + DB CHECK | A sentence or two. Tiles clamp to 2 lines. |
| Members per list | **250** | Service (count under list lock) | Collections run from tens to low hundreds of active copies (per the comment on `fetchActiveCopies`), so this lets "Need Duplicates"-style lists cover a large share of a collection. It bounds the detail payload (~250 × one owned entry) and the reorder request, and the worst case is 50 × 250 = 12.5k membership rows per player. |
| Batch add size | **50 ids per request** | zod | Bounds one transaction. The picker chunks if needed. |

All values live in `src/modules/lists/limits.ts`. The two length limits are mirrored into the CHECKs via `sql.raw`, and all of them are returned in `GET /lists` → `limits`, so the Portal never hard-codes them.

---

## 10. Test plan

### Backend: integration (`tests/integration/api/playerLists.test.ts`, real Postgres, stub Portal sessions as in `achievementsLeaderboards.test.ts`)
**CRUD and behaviour**
- Create, list, get, patch (name, description, `description: null` clears), delete. Deleting a list leaves the copies owned and unchanged.
- Duplicate name is case- and space-insensitive → 409. Two concurrent creates with the same name → exactly one 201-equivalent, and the other gets 409 (the `23505` path).
- Add batch appends in order, reports already-present ids idempotently, and bumps `updated_at`. Remove is idempotent and leaves a gap. Detail positions come back dense 1..n.
- Reorder happy path. Reorder with an id missing, an extra id, or a duplicate id → 409 or 400, with the order unchanged in the DB.
- Limits: the 51st list → 422 `LIST_LIMIT_REACHED`. A batch crossing 250 → 422 `LIST_FULL` with **nothing** inserted. Name and description bounds → 400 with `details.issues`.

**Authorization and security**
- Portal session A calling `/players/{B}/lists` (GET and every write) → 403 `PORTAL_FORBIDDEN`.
- A addressing B's list id through A's own path (GET, PATCH, DELETE, add, remove, order) → 404 `LIST_NOT_FOUND`, and B's data is unchanged.
- A adding B's copy to A's list → 404 `WAIFU_NOT_OWNED`. A mixed batch (own + foreign) → 404 with **zero** rows inserted.
- A reordering with one of B's copy ids swapped in → 409, unchanged.
- The same Discord user in guilds G1 and G2: a session selecting G1 cannot read or modify the G2 player's lists.
- Portal POST/PATCH/PUT/DELETE without `x-portal-csrf`, or with a mismatched one → 403 `PORTAL_CSRF_INVALID`, nothing written. GET works without it.
- A body containing `playerId` → 400 (strict).
- Public routes (`/players/:id/public`, public collection) contain no list data. Walk the response bodies for `lists`/`listIds` keys.

**Release and DB integrity**
- A listed copy releases successfully and its memberships in every list are gone. Other copies of the same species stay listed.
- A favourite listed copy is still blocked with `reasons: ['favorite']` exactly (lists add nothing). The same holds for buddy.
- Duplicate conversion of a listed copy also detaches it.
- Released copies never appear in `memberCount`, `members`, or `/memberships`. Force the case with a raw `released_at` update that bypasses the helper, to prove the defensive join.
- Raw SQL: a membership insert whose `player_id` mismatches the list's or the copy's owner fails with an FK violation. A hard `DELETE FROM player_waifus` cascades. `DELETE` of a list cascades.
- Concurrency: parallel adds to a list at 249 members → the cap holds. A parallel reorder and add → one of them gets `LIST_ORDER_STALE`.

### Backend: unit
- Name normalisation (NFC, trim, whitespace collapse, control-character rejection).
- `errors.test.ts` covers the new codes automatically once they are added. Add explicit cases for each status.
- The route and OpenAPI contract test (`tests/unit/api/routes.test.ts`) lists the new routes. `/lists/memberships` resolves as a static route, not as `:listId`.
- `migrationJournal.test.ts` passes with 0035 (no change needed).

### Portal (vitest + RTL + msw)
- `api/lists.ts` helpers and `queryKeys` test for the new keys.
- **Lists page:** empty state; create dialog validation (counter, inline `LIST_NAME_TAKEN`); edit; delete confirm copy; limit-reached disabling.
- **List detail:** ordered rows with positions. In Reorder mode, ↑/↓/top/bottom/position change only local state, and **Save issues exactly one PUT with the full array**. Cancel reverts. A 409 stale → refetch and message. Remove calls DELETE. The Add picker excludes current members and commits one POST.
- **Collection:** with 30 entries where the list's members are all on UI page 2 of the unfiltered sort, `?list=` shows them on page 1 (proving filter-before-paginate). **Exactly one** `/lists/memberships` request per render, however many cards (proving no N+1). An unknown list id reads as All. The skeleton shows while the overlay loads with `?list` set. The chip and clear-all work.
- **Public mode:** no List filter group, and **no request** to any `/lists` path (the `PublicCollection.test.tsx` request-recording pattern).
- **Detail page:** the Lists card shows chips; toggles fire the right POST/DELETE with an optimistic update and rollback on error; the card is absent in public mode. The existing "offers no gameplay actions" assertions still pass.
- `architecture.test.ts` passes unchanged. The axe accessibility check covers `/lists`, `/lists/:id` and reorder mode.
- Playwright (optional): create list → add from detail page → filter Collection → reorder → save.

---

## 11. Implementation phases

Each phase ships green tests on its own.

**Phase 1: Schema, service and release hook (backend only)**
- `drizzle/0035_player_waifu_lists.sql` (hand-written, with a header comment) and the journal entry; `schema.ts` tables, `player_waifus_id_player_uq`, and row types.
- `src/modules/lists/` with `limits.ts`, `normalize.ts`, `playerListService.ts` (all operations in §4.1) and `removeCopiesFromAllLists`.
- Call the helper from `softRelease`. Wire the service into `AppServices`, `src/index.ts` and `bootstrapApp`.
- Error classes in `src/shared/errors.ts`.
- *Verify:* service-level integration tests (CRUD, ownership, limits, ordering, release detach, FK and cascade, concurrency).

**Phase 2: API routes**
- `src/api/schemas/lists.ts`, `src/api/routes/v1/lists.ts`, registration, `STATUS_BY_CODE` entries, and the shared `toEntry` helper.
- *Verify:* the API integration suite in §10, including every authorization and CSRF case, plus the errors and routes unit tests.

**Phase 3: Portal, My Lists**
- `api/lists.ts`, `api/hooks/useLists.ts` (queries and mutations with prefix invalidation), and query keys.
- Nav entry, routes, `ListsPage`, create/edit/delete dialogs, `ListDetailPage` with `ListMemberRow`, Remove, the Add picker, and Reorder mode with Save/Cancel.
- Reword the Portal "read-only" comments (see §12.1).
- *Verify:* the Portal tests for the pages, plus axe.

**Phase 4: Collection and detail integration**
- The `list` URL param, the toolbar group and chip, and the `filterEntries` predicate. The memberships overlay hook in `CollectionPage` (self only).
- The Lists card and Manage-lists popover/sheet in `WaifumonDetail` (self only).
- *Verify:* the Collection filter-before-paginate, no-N+1 and public-mode tests, and the detail-page toggle tests.

---

## 12. Risks and open questions

**Decisions needed before implementation**
1. **The Portal becomes player-writable.** This is the first player-authored state the Portal writes. It stays within the stated rule (no *game* actions in the Portal), but the "read-only companion" wording in `portal/package.json`, the `CollectionPage.tsx` header and `AppearanceGallery.tsx` should become "no gameplay actions". Please confirm that framing.
2. **Lists belong to a guild profile, not a Discord account.** Because collections are per guild, a player in two servers has two independent sets of lists. I recommend this, since it is the only option consistent with the data. Please confirm.
3. **Unique list names**, case-insensitive per player. I recommend yes.
4. **Limits:** 50 lists, 40-char name, 200-char description, 250 members, 50 per add batch. Please adjust if you want them different.
5. **The composite FK needs a new unique index on `player_waifus (id, player_id)`.** It gives a DB-level guarantee against cross-player membership. The alternative is plain FKs with application-only enforcement. I recommend the composite FK.
6. **Ordering of the lists themselves** on My Lists and in the filter: alphabetical in V1 (recommended), or most recently updated? Manual ordering of lists is deferred.

**Deferred or optional (not V1 unless you say so)**
- A "List order" sort in the Collection when a list filter is active.
- An "on N lists" indicator on `WaifumonCard`.
- Multi-select "add to list" from the Collection grid.
- A Lists card on the Buddy page.
- Drag-and-drop on top of Reorder mode.

**Risks**
- **Future retire paths.** Ascension duplicate consumption, or any new way a copy stops being owned, must call `removeCopiesFromAllLists` (or `softRelease`). The defensive `released_at IS NULL` join means forgetting it leaves only harmless dead rows, not visible bugs. Note this in the Ascension plan.
- **Ascension must ascend in place,** keeping the same `player_waifus.id`. If it ever created a new row, memberships (and buddy/favourite) would be lost. The Ascension brief already implies in-place.
- **Ascension consumption UX:** when a consumed duplicate is on a list, the Ascension confirm screen could note "also removes it from *Need Duplicates*" as information, **never a block**. Decide in the Ascension plan.
- **Discord release confirmation** does not mention list membership. Discord list features are out of scope, and release deliberately ignores lists. Acceptable, but worth knowing.
- **Detail payload size** at 250 embedded owned entries is a few hundred KB worst case. Acceptable. If it ever matters, add pagination to the list detail later (additive).
- **Stale overlay after a Discord-side release:** the overlay may briefly hold a released copy's id until the next refetch. It is harmless because the filter intersects with the collection data, which drops the copy too.

**Future smart lists (brief assessment)**
Nothing here blocks them. A smart list (`Level ≥ 40, Rarity ≥ SSR, not ascended`) is a stored predicate evaluated against the collection, with no member rows. It can live either as a `kind`/`rules jsonb` pair added to `player_waifu_lists` (members routes refuse `kind='smart'`) or in its own table. The Collection overlay could then also return smart-list matches computed server-side. The one V1 choice that matters is already made: membership is an overlay that the Collection filters against, so a filter source that is computed rather than stored plugs into the same `listMemberIds` predicate.
