# Plan: Waifumon Platform API v1

## TL;DR

Introduce a **versioned internal Platform REST API** (`/api/v1/…`) that exposes Waifumon's existing game services to non-Discord clients (admin panel, dev tools, future Player Portal). The API is a **thin HTTP adapter** over the existing service layer — it does not own gameplay logic, does not replace anything, and does not touch the Discord bot's code paths. Initial deployment is loopback + Tailscale only, gated by a shared bearer token. Implemented in **Fastify** (reusing the framework the admin panel already uses), running as a **second Fastify instance in the same Node process** as the bot, sharing `AppContext` in memory (services, DB pool, event bus, content). Discord's command pipeline continues to call services directly and is untouched. Rolled out in **5 phases**, each independently shippable and verifiable, with every phase preserving current gameplay exactly.

---

## 1. Overall Architecture

```
                           ┌────────────────────────────────────┐
                           │        Node.js Process (single)    │
                           │                                    │
   ┌────────────┐  gateway │  ┌──────────────────────────────┐  │
   │  Discord   │◄────────►│  │ Discord Client (discord.js)  │  │
   │  Gateway   │          │  │  ├─ Command Registry         │  │
   └────────────┘          │  │  ├─ Handlers (thin adapters) │  │
                           │  │  └─ Event Emitter/Subscriber │  │
                           │  └──────────┬───────────────────┘  │
                           │             │                      │
                           │             ▼                      │
                           │  ┌──────────────────────────────┐  │
   HTTP  ┌───────────┐     │  │       AppContext             │  │
   ─────►│  Platform │◄───►│  │  services, db, events,       │  │
   :3120 │  API      │     │  │  content, config, logger     │  │
         │ (Fastify) │     │  └──────────┬───────────────────┘  │
         └───────────┘     │             │                      │
                           │             ▼                      │
   HTTP  ┌───────────┐     │  ┌──────────────────────────────┐  │
   ─────►│  Admin    │◄───►│  │  Game Service Layer          │  │
   :3111 │  Panel    │     │  │  (authoritative gameplay)    │  │
         │ (Fastify) │     │  │  players, collection, hunt,  │  │
         └───────────┘     │  │  capture, care, currency,    │  │
                           │  │  daily, quests, shop, …      │  │
                           │  └──────────┬───────────────────┘  │
                           │             │                      │
                           │             ▼                      │
                           │  ┌──────────────────────────────┐  │
                           │  │  Drizzle + Postgres          │  │
                           │  └──────────────────────────────┘  │
                           └────────────────────────────────────┘
```

**Three HTTP-independent surfaces, one AppContext:**
- Discord client (unchanged) — reads/writes services, emits events
- Admin Panel (unchanged) — Fastify on `127.0.0.1:3111`, content CRUD via views
- **Platform API (new)** — Fastify on `127.0.0.1:3120` (default), JSON REST, exposes services

The Platform API is a **new Fastify instance**, not a plugin mounted into the admin panel. Same process, separate ports → clean auth boundary, independent enable flag, independent host bind, independent Docker port publish.

---

## 2. Project Goals

1. Establish a **versioned REST API** (`/api/v1/…`) that exposes existing Waifumon game services as HTTP resources.
2. Provide a stable foundation for **future clients** (Player Portal, migrated admin panel, mobile, external integrations) without changing gameplay code.
3. Preserve the **service layer as the single source of truth**: the API is a translation layer only.
4. **Zero disruption** to the Discord experience — every existing slash command, embed, ephemeral response, Care Mode flow, activity feed post, and Trainer Profile behavior remains bit-identical.
5. Bake in **versioning, error contracts, validation, and OpenAPI documentation** from day one so v2 (public, OAuth-authenticated) is an evolution, not a rewrite.
6. Keep the **surface small in v1**: gameplay resources + gameplay actions + read-only content catalog. Content mutations, leaderboards, and player auth explicitly deferred.
7. Match existing conventions (Zod, Pino, Fastify, `AppError`, error-code + user-message contract) so the API feels native to the codebase.

---

## 3. Explicit Non-Goals

- ❌ **No rewrite or migration of the Discord bot.** Command handlers continue to call services directly.
- ❌ **No public internet exposure.** No SSL, no public DNS, no CDN.
- ❌ **No player authentication.** No OAuth, no JWT, no cookies for players.
- ❌ **No gameplay changes.** No new mechanics, no rebalancing, no new events.
- ❌ **No new game services.** The API adapts to what exists. If a service needs a signature tweak (e.g., accept an optional pre-resolved `PlayerId` instead of Discord context), the plan will call it out explicitly.
- ❌ **No content mutation endpoints in v1.** Admin panel keeps content CRUD; API is read-only for `species`, `items`, `tables`, and the `quests` pool.
- ❌ **No admin-panel migration in v1.** Panel keeps its current HTML/Fastify implementation. Future phases may migrate views to consume the API.
- ❌ **No leaderboards, cross-player queries, or global aggregations** — these aren't in the service layer today.
- ❌ **No websocket / SSE / push channel.** The event bus stays in-process; polling suffices for v1 clients.
- ❌ **No rate limiting per player** beyond what services already enforce (energy, daily-once, encounter cooldowns).

---

## 4. API Philosophy

The API models **game resources**, not Discord commands or database rows.

Guidelines:

1. **Resources are nouns, actions are POSTs on subpaths.** `GET /api/v1/players/:playerId/collection/owned` lists Waifumon; `POST /api/v1/players/:playerId/hunt` performs a hunt; `POST /api/v1/players/:playerId/encounters/:encounterId/capture` attempts capture. No `/executeHuntCommand`-style endpoints.
2. **Ephemeral game entities are first-class.** Active encounters are represented as `/encounters/:id` — a real short-lived resource with state (`active | captured | escaped | released | expired`).
3. **Deterministic error contract.** Every 4xx returns JSON `{ error: { code, message, details? } }`. `code` is the machine-readable `AppError.code` (e.g., `INSUFFICIENT_ENERGY`, `ACTIVE_ENCOUNTER`); `message` is `userMessage` (safe to render). No stack traces, no raw SQL errors.
4. **Content-Type = `application/json`.** No form-encoded bodies. No HTML responses. No file uploads in v1 (assets stay in admin panel).
5. **Idempotency where the service is idempotent.** `POST .../players/ensure`, `POST .../guilds/ensure`, `POST .../quests/daily/ensure`, `POST .../session/ensure` are safely retryable. Non-idempotent (`hunt`, `capture`, `purchase`, `claim`) may only be retried if the client is certain the previous call failed before commit — same guarantee the services give today.
6. **Read-heavy endpoints support pagination** with `?page=&pageSize=` (1-based, `pageSize` capped at 100), matching `collectionService.listOwned` semantics already in place.
7. **Timestamps are ISO 8601 UTC.** Client formats/localizes. Calendar-day fields (daily claim date, quest date) are `YYYY-MM-DD` strings, matching how the DB stores them.
8. **No Discord-specific concepts leak into responses** by default. Guild is exposed as an internal `guildId` (DB id), with an optional lookup by `discordGuildId`. Discord snowflakes appear only in explicit `discordUserId` / `discordGuildId` fields and in fields that are inherently Discord-scoped (e.g., `channelId` on a session).
9. **Read-your-writes**: every mutation returns the full updated resource (or the operation result object), so clients don't need a second GET.

---

## 5. Service Boundaries

The Platform API sits **strictly above the service layer**. It:

**MUST:**
- Translate HTTP requests into service calls (with Zod-validated params/bodies).
- Translate service return values and thrown `AppError`s into JSON responses.
- Enforce request-level concerns: auth, size limits, content-type, request ID.
- Return event descriptors as part of action responses when relevant *(optional, see design decision below)*.

**MUST NOT:**
- Contain gameplay logic, math, or business rules.
- Touch the DB directly (no imports from `src/db/schema.ts` in API handler code).
- Emit `GameEvent`s from HTTP handlers in v1 (see below).
- Bypass any service invariant (e.g., cannot skip the FOR UPDATE lock inside currency spends).

**Event emission decision:**
- Services return `GameEventDescriptor[]` today; the Discord coordinator (`emitEvents` in [src/discord/gameEventEmitter.ts](src/discord/gameEventEmitter.ts)) turns those into full `GameEvent`s with Discord source metadata (`playerMention`, `channelId`, guild snowflake) *after* commit.
- **In v1, the Platform API does NOT emit `GameEvent`s.** This is an **intentional, temporary limitation** of the internal API — not a permanent architectural decision. v1 mutations are exercised only from admin/dev tools and localhost callers that do not need to appear in the Activity Feed or Trainer Profile.
- **Future gameplay clients (Player Portal, mobile app, external integrations) are expected to participate in the Game Event system.** The forward plan: introduce a `PlatformSource` variant of `GameEventSource` that carries `{ platform: 'api', clientId, playerId, guildDbId }` and no Discord mentions. Activity Feed and Trainer Profile subscribers already tolerate missing Discord fields; a small extension will let them format platform-sourced events (or skip them cleanly). This work is deferred until the first non-admin client lands, but the API layer is designed so that turning it on is an additive change — routes don't move, response shapes don't change.
- The gap is loudly documented in the OpenAPI description of each mutation endpoint so no client silently depends on side-effects that don't yet fire.

**Minor service-signature adjustments the API may require** (all preserve existing behavior):

| Service | Adjustment | Reason |
|---|---|---|
| `huntService.hunt(playerId, channelId)` | Accept an optional `channelId: string \| null`. Currently expects a real channel to attach to a session. | API callers may not have a channel. Session tally will only update when `channelId` is provided; if null, hunt still works, session isn't touched. **Backward compatible.** |
| `sessionService.recordEvent` | No change — API just doesn't call it when `channelId` is null. | — |
| `guildService.ensureGuild` | Add optional parameter to accept an already-known `guildDbId` to skip lookup. Optional optimization. | Not required; skip unless benchmarks show a hotspot. |
| `careService.startCare(tx, ...)` | Add non-transactional wrapper `startCareStandalone(playerId, waifuId)` that opens its own transaction. | Discord calls it from within a coordinator tx; API needs its own tx boundary. Existing tx-taking overload preserved. |
| Similar pattern for other `tx`-first services (`applyAndExit`, `changeCareTarget`) | Add standalone wrappers. | Same reason. |

Every such change is **additive** — old signatures untouched, Discord call sites unmodified.

---

## 6. Recommended Framework

**Fastify 5.x** (already at `5.11.0` in the codebase).

Rationale:
- Already installed and battle-tested in [src/admin/server.ts](src/admin/server.ts).
- First-class Zod support via `fastify-type-provider-zod` — request/response schemas double as OpenAPI generation and TS types.
- Native `@fastify/swagger` + `@fastify/swagger-ui` for auto-generated OpenAPI docs at `/api/v1/docs`.
- Pluggable auth (add a `preHandler` hook mirroring the admin panel's bearer check).
- No new framework introduces cognitive load.
- Consistent Pino logger integration.

New dependencies (small):
- `fastify-type-provider-zod` (Zod ↔ Fastify schema bridge)
- `@fastify/swagger` + `@fastify/swagger-ui` (OpenAPI docs)
- `@fastify/helmet` (basic security headers, even for private surfaces)
- (Reuse existing: `fastify`, `zod`, `pino`)

---

## 7. Versioning Strategy

**URL path versioning: `/api/v1/…`**

Chosen because:
- Cache-friendly, log-friendly, curl-friendly.
- Matches user's stated example (`/api/v1/`).
- Trivial to run v1 and v2 side-by-side during a deprecation window.

Rules:
- `/api/v1` is **stable** once shipped: no breaking changes to shapes, status codes, or auth semantics.
- **Additive changes are allowed within v1**: new optional fields, new optional query params, new endpoints, new error codes (documented).
- **Breaking changes require `/api/v2`** and a written deprecation date for v1.
- **Non-versioned routes**: `/health` (liveness), `/ready` (readiness — DB reachable, content loaded), `/api/v1/docs` (OpenAPI UI). `/health` and `/ready` are outside the versioned path deliberately so ops tooling has a stable target.
- **Response header**: every response includes `X-Waifumon-API-Version: 1` for logging correlation.
- **Deprecation signals** (future): when v2 exists, v1 responses gain `Deprecation: true` and `Sunset: <RFC 3339>` headers.

Semantics of "version" in this project:
- **API version** = the HTTP contract (path, shapes, codes).
- **Service version** = internal, unversioned; free to evolve as long as the v1 adapter continues to produce the same v1 responses.

---

## 8. Endpoint Organization

### 8.1 Route tree

```
GET    /health
GET    /ready
GET    /api/v1/docs                                  ← Swagger UI
GET    /api/v1/openapi.json                          ← spec

── Players ─────────────────────────────────────────
POST   /api/v1/players/ensure                        idempotent provision
GET    /api/v1/players/lookup?discordGuildId&discordUserId
GET    /api/v1/players/:playerId
GET    /api/v1/players/:playerId/profile             composite: player + currencies

── Collection ──────────────────────────────────────
GET    /api/v1/players/:playerId/collection/stats
GET    /api/v1/players/:playerId/collection/owned?page&pageSize&rarity
GET    /api/v1/players/:playerId/collection/owned/:waifuId
PATCH  /api/v1/players/:playerId/collection/owned/:waifuId
        body: { nickname?, isFavorite? }
DELETE /api/v1/players/:playerId/collection/owned/:waifuId
        query: force=true|false
POST   /api/v1/players/:playerId/collection/owned/:waifuId/convert
POST   /api/v1/players/:playerId/collection/owned/:waifuId/buddy
DELETE /api/v1/players/:playerId/collection/buddy

── Currency ────────────────────────────────────────
GET    /api/v1/players/:playerId/currency

── Inventory ───────────────────────────────────────
GET    /api/v1/players/:playerId/inventory
POST   /api/v1/players/:playerId/inventory/use
        body: { itemSlug }

── Effects ─────────────────────────────────────────
GET    /api/v1/players/:playerId/effects/capture-bonus

── Care Mode ───────────────────────────────────────
GET    /api/v1/players/:playerId/care
POST   /api/v1/players/:playerId/care/enter          body: { waifuId }
POST   /api/v1/players/:playerId/care/exit
PATCH  /api/v1/players/:playerId/care/target         body: { waifuId }

── Hunt / Encounter ────────────────────────────────
POST   /api/v1/players/:playerId/hunt                body: { channelId? }
GET    /api/v1/players/:playerId/encounter           active encounter or 404
POST   /api/v1/encounters/:encounterId/capture       body: { itemSlug }

── Daily ───────────────────────────────────────────
GET    /api/v1/players/:playerId/daily
POST   /api/v1/players/:playerId/daily/claim

── Quests ──────────────────────────────────────────
GET    /api/v1/players/:playerId/quests/daily
POST   /api/v1/players/:playerId/quests/daily/ensure
POST   /api/v1/players/:playerId/quests/daily/claim

── Shop ────────────────────────────────────────────
GET    /api/v1/shop/catalog
POST   /api/v1/players/:playerId/shop/purchases      body: { itemSlug, quantity }

── Session ─────────────────────────────────────────
GET    /api/v1/players/:playerId/sessions/:channelId
POST   /api/v1/players/:playerId/sessions/ensure     body: { channelId }

── Content (read-only) ─────────────────────────────
GET    /api/v1/content/species?rarity&archetype&enabled
GET    /api/v1/content/species/:slug
GET    /api/v1/content/items?category&enabled
GET    /api/v1/content/items/:slug
GET    /api/v1/content/tables                        all tables blob
GET    /api/v1/content/tables/:key                   single table (energy, hunt, capture, …)
GET    /api/v1/content/quests                        quest catalog (pool)

── Guilds (read-only in v1) ────────────────────────
GET    /api/v1/guilds/:discordGuildId
GET    /api/v1/guilds/:discordGuildId/channels

── System (reserved namespace, no v1 endpoints) ────
(reserved)  /api/v1/system/*
```

**`/api/v1/system` is reserved but empty in v1.** No endpoints are registered under it during this project. It is called out here so future platform/system endpoints — `version`, `feature-flags`, `platform-status`, `configuration`, `diagnostics` — have an obvious home that does not collide with gameplay resources or force a v2 bump. See §17 Future Extension Points.

### 8.2 Conventions

- **Path params** are always internal IDs (`playerId`, `waifuId`, `encounterId`, `guildDbId`) *except* for content slugs (`speciesSlug`, `itemSlug`, `tableKey`) and inherently-Discord ids (`discordGuildId`).
- **Query params** for filtering + pagination only, never for identity.
- **Bodies** required for all POST/PATCH; empty body allowed only for idempotent `/ensure`, `/exit`, etc.
- **204 No Content** for successful mutations that have no meaningful payload (e.g., `PATCH /collection/owned/:waifuId` returning the updated entry is preferred; DELETE returns 200 with the release result).
- **404** for unknown resources (unknown `playerId`, unknown `waifuId`, unknown `speciesSlug`).
- **409 Conflict** for state violations (`ACTIVE_ENCOUNTER`, `ALREADY_CLAIMED`, `WAIFU_IS_BUDDY`).
- **422 Unprocessable Entity** for business-rule failures with valid shape (`INSUFFICIENT_ENERGY`, `INSUFFICIENT_FUNDS`).
- **400** for schema/validation failures (Zod).
- **401** for missing/bad auth. **403** reserved for future role-based auth. Not used in v1.
- **429** reserved for future public rate limiting.
- **500** only for uncaught internal errors; always includes a `requestId` in the body.

### 8.3 Response shapes

Every success:
```json
{ "data": { … } }
{ "data": [ … ], "page": 1, "pageSize": 20, "total": 42 }
```
Every error:
```json
{ "error": { "code": "INSUFFICIENT_ENERGY", "message": "You don't have enough energy.", "details": { … } }, "requestId": "…" }
```
`code` values are drawn directly from `AppError.code` — a single source of truth already established in [src/shared/errors.ts](src/shared/errors.ts).

**Reserved `meta` field.** The success envelope reserves an optional top-level `meta` object for standard response metadata:

```json
{
  "data": { … },
  "meta": {
    "apiVersion": "1",
    "requestId": "01HXYZ…",
    "generatedAt": "2026-08-05T14:22:31.512Z"
  }
}
```

Rules for v1:
- Clients **must** tolerate `meta` being absent, present, or containing additional unknown fields — it is a forward-compatible extension slot.
- v1 responses **may** already populate `meta.requestId` (mirroring the `X-Request-Id` header) so clients can start relying on it opportunistically.
- `apiVersion` and `generatedAt` are documented but not required to be populated in v1; they are reserved for consistency with the future contract.
- Future additions (e.g., `meta.rateLimit`, `meta.deprecation`, `meta.serverTimeZone`) are additive within v1 and do not constitute a breaking change.
- The error envelope similarly reserves an optional `meta` object at the top level; `requestId` already lives at the top level and remains authoritative.

---

### 8.4 Future `/me` resource (design note)

**Not implemented in this project.** Documented here so route organization naturally accommodates a future Discord OAuth authentication model without endpoint redesign.

Once v2 introduces player authentication, every player-scoped endpoint gains a parallel `/me` alias that resolves the caller's `playerId` from a JWT claim instead of from the path:

```
GET    /api/v1/players/me
GET    /api/v1/players/me/profile
GET    /api/v1/players/me/collection/owned
GET    /api/v1/players/me/care
POST   /api/v1/players/me/hunt
POST   /api/v1/players/me/daily/claim
…
```

Design properties that make this a drop-in extension rather than a redesign:

1. **Handlers already receive a resolved `playerId`.** Whether that id comes from `request.params.playerId` (internal token flow) or from `request.user.playerId` (future JWT claim) is a `preHandler` concern. Route bodies never change.
2. **Path shape is preserved.** `/players/me/foo` and `/players/:playerId/foo` share the same sub-resource tree, same request/response shapes, same error codes. The Zod schemas for sub-resources are reused verbatim.
3. **v1 internal endpoints remain the primary implementation.** `/me` variants are added later as an alias layer, gated on the same auth `preHandler` that populates `request.user`. Internal clients keep using explicit `playerId`.
4. **No `/me` alias will be registered in v1.** Registering an unauthenticated `/me` route would create ambiguity about identity resolution. `/me` becomes real only when an authenticated identity source exists.
5. **Composite endpoints (see §17) are the natural first customers of `/me`.** A `GET /api/v1/players/me/dashboard` reads more naturally than `GET /api/v1/players/:playerId/dashboard` and reinforces that `/me` is player-scoped, not admin-scoped.

---

## 9. Authentication Roadmap

### v1 (this project)
- **Static shared secret** — `PLATFORM_API_TOKEN` env var, required when `PLATFORM_API_ENABLED=true`.
- Verified via `preHandler` hook checking `Authorization: Bearer <token>` header.
- No cookies, no CSRF. Public paths: `/health`, `/ready`, `/api/v1/docs`, `/api/v1/openapi.json`.
- Failed auth → 401 with `error.code = 'UNAUTHORIZED'`, no rate hint (avoid leaking to timing attackers).

### v1.x (near-future, additive)
- **Multiple named tokens** with per-token labels (e.g., "admin-panel", "dev-cli") to enable revocation and audit.
- Stored in a small `platform_api_tokens` table with `token_hash`, `label`, `created_at`, `revoked_at`. Bearer check compares SHA-256 digest to `token_hash`.
- No public exposure yet.

### v2 (public API — separate project)
- **Discord OAuth2 authorization-code flow** → exchange code for a **first-party session JWT** signed by the API. JWT carries `{ playerId, guildIds, issuedAt, expiresAt }`.
- **JWT refresh** via httpOnly refresh token (opaque, DB-backed, revocable).
- **Role-based authorization** — roles derive from `players` role column (added in that phase): `player`, `moderator`, `admin`. Fastify `preHandler` becomes a role guard.
- **Bearer tokens (for scripts/CI) coexist** — treated as a separate credential class (`Authorization: Bearer waifumon_pat_…`), gated behind an env flag.
- Rate limiting per identity, IP-based fallback for anonymous endpoints, CORS with an allow-list.

### Contract preservation
- All v1 endpoints continue to work with a JWT once v2 lands (JWT identifies the player, but the same handler runs).
- Handlers already receive a resolved `playerId` — the resolution source (path param vs JWT claim) is a `preHandler` concern, not a route concern.

---

## 10. Security Model

**Defence in depth for a private surface.**

1. **Network binding**
   - Bind to `127.0.0.1` by default (`PLATFORM_API_HOST=127.0.0.1`).
   - Docker mirrors admin panel pattern: container binds `0.0.0.0`, host publishes on `PLATFORM_API_PUBLISH_HOST` (default `127.0.0.1`, override to Tailscale IP `100.x.y.z` for tailnet access).
   - **Startup guard**: if the effective bind is non-loopback and non-Tailscale (heuristically: not in `127.0.0.0/8`, not in `100.64.0.0/10`), log a `WARN: platform API bound to public interface` message.
2. **Auth** (see §9): mandatory bearer token, constant-time comparison.
3. **Transport**: no TLS in v1 — Tailscale provides encryption for tailnet traffic; loopback is trivially safe. If a future v1.x needs LAN access, add TLS via a reverse proxy (Caddy/Nginx), never in-process.
4. **Input validation**: Zod schemas on every request (params, query, body). Reject unknown fields (`strict()`). Body size cap 64 KB — no endpoint needs more.
5. **Output sanitization**: responses are pure JSON derived from validated Zod types. No raw DB rows, no error `message`s ever include tokens, no headers ever logged.
6. **Error hygiene**: `AppError` → mapped code/status. Unknown errors → 500 + `INTERNAL_ERROR` + logged with `requestId`, no message details.
7. **Rate limiting**: skipped in v1 (private). Reserved status code 429 documented so v2 can add it without shape change.
8. **CORS**: **denied by default** in v1 — API is not intended for browser calls from origins other than `null` (curl/Node). Admin panel and dev tools use server-side or same-origin fetches. Explicit CORS config lands in v1.x if needed.
9. **Helmet**: enable `@fastify/helmet` with sensible defaults (no `Content-Security-Policy` since we serve JSON only; do set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, etc.).
10. **Logging**: request logs record `method`, `path`, `status`, `durationMs`, `requestId`, `remoteAddress`. **Never** headers, cookies, body, or query values that might be sensitive. Match admin panel policy.
11. **Startup fail-closed**: if `PLATFORM_API_ENABLED=true` and `PLATFORM_API_TOKEN` is empty, refuse to start (throw `ConfigError`).
12. **Prompt injection / SSRF / RCE**: not applicable — no LLM calls, no outbound HTTP, no dynamic evaluation.
13. **OWASP Top 10 hit-list**:
    - A01 Broken Access Control → single token, no user model in v1; mitigations documented for v2.
    - A02 Cryptographic Failures → token stored as env var; hash comparison for v1.x multi-token.
    - A03 Injection → Drizzle parameterizes; Zod validates.
    - A04 Insecure Design → path versioning, error contract, additive-change discipline.
    - A05 Security Misconfiguration → startup guards, fail-closed, non-loopback warning.
    - A06 Vulnerable/Outdated Components → keep Fastify major pinned; renovate config later.
    - A07 Identification/Auth → bearer + constant-time; JWT + refresh in v2.
    - A08 Data Integrity → response shapes are Zod-validated before send.
    - A09 Logging Failures → structured Pino, request IDs, error correlation.
    - A10 SSRF → no outbound calls.

---

## 11. Migration Strategy

There is **no migration** in the classical sense — no data moves, no schema changes.

What **does** migrate is the **admin panel's view layer**, gradually, in a future phase (not in this project):

**Current admin panel path:**
```
Browser → GET /admin/species → server-rendered HTML with data from db+content
```

**Future path (post-v1, opt-in):**
```
Browser → GET /admin/species (still HTML shell) → fetch /api/v1/content/species → render
```

Or, further out:
```
Browser → SPA served by admin panel → fetch /api/v1/… → full client-side rendering
```

**Rules for the migration:**
- **Both surfaces coexist** during transition. Admin panel keeps its own working endpoints; API is additive.
- Each admin view is migrated **one at a time**; a page either uses the old HTML flow or fully consumes the API.
- Content mutation stays in the admin panel until v1 proves stable.

**Data-model migrations required by this project: none.** The API is a read+action layer over the current schema.

**One optional additive migration** (not required for v1, but plan for it):
- Add `platform_api_tokens` table when multi-token support ships in v1.1. Deferred out of this project's Drizzle migrations.

---

## 12. Implementation Phases

Each phase is **independently shippable**, adds no gameplay changes, and can be reverted by toggling `PLATFORM_API_ENABLED=false` with zero side-effects.

### Phase 1 — Foundation (skeleton + auth + docs)

**Goal:** stand up a running API with zero endpoints beyond health, docs, and auth verification.

- Add config fields: `platformApi: { enabled, host, port, token }` in [src/config/config.ts](src/config/config.ts), Zod-validated, fail-closed if enabled without token.
- Create `src/api/` folder:
  - `server.ts` — creates and starts a Fastify instance, attaches Pino child logger, request-id hook, `@fastify/helmet`, `@fastify/swagger` + `@fastify/swagger-ui`, error handler mapping `AppError` → JSON.
  - `auth.ts` — `preHandler` that verifies `Authorization: Bearer <token>` (constant-time compare); allow-list for public paths.
  - `errors.ts` — `mapAppErrorToStatus(err)` returning HTTP status per error code (400/401/404/409/422/500).
  - `plugins/typeProvider.ts` — attaches `fastify-type-provider-zod`.
  - `plugins/responseEnvelope.ts` — helper for `{ data }` / `{ data, page, pageSize, total }` wrapping, with optional `meta` slot (see §8.3).
  - `routes/health.ts`:
    - `GET /health` — cheap liveness check. Returns `200 { "status": "ok" }` whenever the process is up. No dependencies checked.
    - `GET /ready` — component-level readiness for diagnostics and ops. Returns a structured report of each major platform component. HTTP status is `200` when every required component is `ok`, `503` when any required component is `degraded` or `down`. Body shape:
      ```json
      {
        "status": "ok",
        "components": {
          "database":       { "status": "ok",       "detail": "SELECT 1 succeeded", "checkedAt": "…" },
          "content":        { "status": "ok",       "detail": "snapshot loaded (N species, M items)", "checkedAt": "…" },
          "discordClient":  { "status": "ok",       "detail": "gateway connected", "checkedAt": "…" },
          "platformApi":    { "status": "ok",       "detail": "listening on 127.0.0.1:3120", "checkedAt": "…" }
        },
        "checkedAt": "2026-08-05T14:22:31.512Z"
      }
      ```
      Component statuses: `ok | degraded | down | unknown`. `database` and `content` are **required** (down → 503). `discordClient` is **advisory** in v1 (down does not fail readiness, because the API can still serve non-Discord data); status is reported for diagnostics. `platformApi` self-reports the effective bind.
  - `routes/v1/index.ts` — `fastify.register()` root for versioned routes, prefixed `/api/v1`.
- Update [src/index.ts](src/index.ts): after Discord client login, if `platformApi.enabled`, start API server. Log effective bind + warn on non-loopback/non-Tailscale.
- Update [docker-compose.yml](docker-compose.yml): expose `${PLATFORM_API_PUBLISH_HOST:-127.0.0.1}:${PLATFORM_API_PORT:-3120}:${PLATFORM_API_PORT:-3120}` conditionally documented in `.env.example`.
- Update [Dockerfile](Dockerfile): no changes needed (single process).
- Update `.env.example` (create/update): new vars.

**Verification:**
- `curl http://127.0.0.1:3120/health` → `200 {"status":"ok"}`.
- `curl http://127.0.0.1:3120/ready` → `200` with a structured component report when all required components are healthy; `503` with the same shape (marking the failed component) when the DB is unreachable or content is unloaded; `discordClient: down` alone does not fail readiness in v1.
- `curl http://127.0.0.1:3120/api/v1/docs` → Swagger UI loads.
- `curl -H "Authorization: Bearer wrong" http://127.0.0.1:3120/api/v1/foo` → `401 { error: { code: "UNAUTHORIZED", ... } }`.
- Startup with `PLATFORM_API_ENABLED=true` and empty `PLATFORM_API_TOKEN` → process exits with `ConfigError`.
- Bot behavior identical: run existing Discord smoke tests.

### Phase 2 — Read-only game surface

**Goal:** every GET endpoint from §8, no mutations. Safe to expose immediately for admin panel consumption.

- Route files (one per resource group, each `< 150 lines`):
  - `routes/v1/players.ts` — GET player, GET profile, GET lookup, POST ensure *(idempotent — treated as safe here)*.
  - `routes/v1/collection.ts` — GET stats, GET owned list, GET owned by id.
  - `routes/v1/currency.ts` — GET balances.
  - `routes/v1/inventory.ts` — GET inventory.
  - `routes/v1/effects.ts` — GET capture-bonus.
  - `routes/v1/care.ts` — GET state.
  - `routes/v1/encounter.ts` — GET active encounter for player.
  - `routes/v1/daily.ts` — GET daily status.
  - `routes/v1/quests.ts` — GET daily quests.
  - `routes/v1/shop.ts` — GET catalog.
  - `routes/v1/session.ts` — GET session by channel.
  - `routes/v1/content.ts` — species/items/tables/quests read-only.
  - `routes/v1/guilds.ts` — read-only guild + channels.
- Shared Zod schemas in `src/api/schemas/` (one file per domain), used both as request validators and as response serializers.
- Add `sessionService.getSession(playerId, channelId)` — currently only `ensureSession` exists; add a pure read variant. **Additive**, tiny.
- Add `dailyService.getStatus(playerId)` if not already present — read-only status endpoint. **Additive.**
- Add `currencyService.getBalances(playerId)` public wrapper if internal-only. **Additive.**

**Verification:**
- Unit tests per route in `tests/unit/api/` using Fastify's `inject()` — no live HTTP.
- Integration tests in `tests/integration/api/` using testcontainers-postgres pattern already in the repo, plus real Fastify listen — one per endpoint category, verifying happy path + one error path (404 unknown resource) + auth (401).
- Discord smoke test unchanged.
- OpenAPI schema drift check: snapshot of `/api/v1/openapi.json` — CI fails if changed unexpectedly.

### Phase 3 — Gameplay actions

**Goal:** POST/PATCH/DELETE endpoints that mutate state — the endpoints that make the API actually useful.

- Add API endpoints:
  - `POST /players/ensure` (already in Phase 2 as idempotent; formalize).
  - `PATCH /collection/owned/:waifuId` (nickname, isFavorite).
  - `DELETE /collection/owned/:waifuId` (release).
  - `POST /collection/owned/:waifuId/convert` (invest duplicate).
  - `POST /collection/owned/:waifuId/buddy`, `DELETE /collection/buddy`.
  - `POST /inventory/use`.
  - `POST /care/enter`, `POST /care/exit`, `PATCH /care/target`.
  - `POST /hunt` (accepts `channelId?`).
  - `POST /encounters/:encounterId/capture`.
  - `POST /daily/claim`.
  - `POST /quests/daily/ensure`, `POST /quests/daily/claim`.
  - `POST /shop/purchases`.
  - `POST /sessions/ensure`.
- Service adjustments (all additive, per §5):
  - `huntService.hunt(playerId, channelId | null)` — treat null as "no session recording".
  - Standalone (non-tx-argument) wrappers for `careService.startCare / applyAndExit / changeCareTarget`.
  - Verify each service that touches `waifumon_sessions` handles null channel gracefully; if not, callable API endpoints simply skip session recording when channelId absent (documented behavior).
- **Event bus behavior**: API mutations do **not** emit `GameEvent`s in v1. This is a deliberate, documented gap — no Activity Feed post, no Trainer Profile update on API-driven care changes. Loudly documented in the OpenAPI description of each mutation endpoint.

**Verification:**
- Integration tests per endpoint: setup player + guild + content, hit endpoint, verify DB state matches Discord-path equivalent.
- **Parity tests**: for each mutation endpoint, run the *equivalent Discord command handler flow* against the same fixture and diff the resulting DB state and service return values. Must be identical.
- Concurrency test: two simultaneous `POST /hunt` requests for the same player — one succeeds, one returns `409 ACTIVE_ENCOUNTER` or `422 INSUFFICIENT_ENERGY` depending on ordering; DB is consistent.
- Long-running Discord smoke test (30 min live session): hunt, capture, buy, use item, enter/exit care, claim daily, claim quest. All must be indistinguishable from a pre-change baseline.

### Phase 4 — API stabilization and production readiness

**Goal:** finalize the v1 contract, tighten consistency across endpoints, and prepare the API for real client consumption in future projects. **No coupling to the admin panel.** The existing admin panel continues to function exactly as it does today; migrating it to consume the Platform API is a separate future project, out of scope here.

- **Endpoint consistency sweep.** Read every route file end-to-end and enforce uniform patterns:
  - Response envelope shape (`data`, pagination fields, reserved `meta` slot per §8.3) identical across all endpoints.
  - Error mapping (`AppError.code` → HTTP status) covers every error thrown by every service touched. Any uncovered code becomes a defaulted `500 INTERNAL_ERROR`, which is a bug to fix — not to ship.
  - Zod schema naming, field casing (camelCase throughout), timestamp encoding (ISO 8601 UTC), and calendar-day encoding (`YYYY-MM-DD`) audited.
  - Path plurality, HTTP verb choice, and status codes reconciled against §8.2 Conventions. Any deviation is either corrected or documented with a written rationale.
- **OpenAPI review.**
  - Every endpoint has a human-readable `summary` and `description`, a list of possible error `code`s, and at least one request/response example.
  - Mutation endpoints carry an explicit note: *"v1 API mutations do not emit Game Events. See §5."*
  - The generated OpenAPI document is reviewed manually for accuracy against the running server; any drift is fixed.
  - The `openapi.json` snapshot is frozen at this phase and gated by the CI contract test (see §13).
- **Documentation.**
  - Write `docs/platform-api.md`: enabling, tokens, curl examples, security posture (loopback/Tailscale, non-loopback warning), versioning contract, complete error-code table, operator runbook (token rotation, disable in emergency).
  - Update the README with a one-paragraph pointer to the API and its docs.
  - `.env.example` gains fully commented Platform API entries with the same security warnings the admin panel uses.
- **Implementation cleanup.**
  - Remove any dead code, TODOs, or provisional helpers accumulated during Phases 1–3.
  - Confirm no `console.log`, no stray debug endpoints, no test-only paths registered on the live server.
  - Confirm the auth `preHandler` unit test asserting `Authorization` never appears in a log line (see §15 Risks).
- **Production readiness.**
  - Full test suite green: `npm run test && npm run typecheck`.
  - Fresh `docker compose up` with `PLATFORM_API_ENABLED=true`: clean startup, `/ready` reports all components ok, `/api/v1/docs` reachable via `PLATFORM_API_PUBLISH_HOST`, sample curl walkthrough from `docs/platform-api.md` succeeds end-to-end.
  - Fresh clone → `npm install && npm run dev` with `.env` from `.env.example`: API works out of the box.
  - Retro / lessons captured back into repo memory for future v2 planning.

**Verification:**
- OpenAPI review checklist signed off.
- OpenAPI snapshot frozen and CI-gated.
- Documentation reviewed for accuracy against the running server.
- Docker + fresh-clone smoke tests pass.
- Discord bot behaviour indistinguishable from Phase 0 baseline — full existing test suite green.

### Phase 5 — Release cutover (optional; may be folded into Phase 4)

If Phase 4 completes cleanly, no separate Phase 5 is required — the API is production-ready at the end of Phase 4. Retain this slot for a lightweight release checkpoint if the project stretches:

- Tag the release, publish changelog entry.
- Announce the API's availability to internal stakeholders with a link to `docs/platform-api.md`.
- Confirm operator-controlled `PLATFORM_API_ENABLED` flag matches the intended deployment posture for each environment.

**Verification:**
- Everything in Phase 4 verification still holds after a fresh deploy.

---

## 13. Testing Strategy

**Framework**: Vitest (existing).

**Layers:**

1. **Unit — handler shape (`tests/unit/api/`)**
   - Use `fastify.inject({ method, url, headers, payload })` — no listen, no network.
   - Mock services (existing `AppContext.services` is a plain object; substitute with test doubles).
   - Assert status, response envelope, error code mapping.
   - Fast, deterministic, exhaustive across endpoints.

2. **Integration — full stack (`tests/integration/api/`)**
   - Reuse the repo's testcontainers-postgres pattern.
   - Real Fastify `listen`, real Drizzle, real services, real content loaded from `content/`.
   - Cover: auth, one happy path per endpoint, one 404/409/422 per endpoint, pagination boundaries.

3. **Parity — API vs Discord (`tests/integration/parity/`)**
   - For each mutation endpoint, run:
     - Fixture setup (player + guild + starter data).
     - Path A: call `services.<foo>(...)` directly (simulating Discord command handler).
     - Path B: call the equivalent HTTP endpoint.
   - Assert final DB state, service return value, and any thrown `AppError` codes are identical.
   - This is the **critical guarantee** that the API doesn't drift from Discord semantics.

4. **Contract — OpenAPI snapshot (`tests/integration/openapi.test.ts`)**
   - Serialize `/api/v1/openapi.json`, compare to snapshot in `tests/snapshots/openapi.json`.
   - Diff on any additive change; PRs update snapshot deliberately.
   - Prevents accidental shape changes to `data`, `error`, or field types.

5. **Discord regression (existing)**
   - Full existing test suite must remain green — the API touches no Discord code paths.

6. **Manual smoke (per phase)**
   - `curl` walkthrough documented in `docs/platform-api.md`.
   - 30-minute Discord live session at Phase 3 close.

**Coverage target**: 100% of API handlers touched by at least one integration test; 100% of mutation endpoints covered by a parity test.

---

## 14. Deployment Strategy

**Local dev:**
- `PLATFORM_API_ENABLED=true`, `PLATFORM_API_HOST=127.0.0.1`, `PLATFORM_API_PORT=3120`, `PLATFORM_API_TOKEN=<generated>`.
- `npm run dev` starts bot + API together; visit `http://127.0.0.1:3120/api/v1/docs`.

**Docker (production-style):**
- Same single-container image (no split).
- `.env` sets bind + publish + token.
- Same host published only to `127.0.0.1` (SSH tunnel required) or Tailscale IP.
- Health check: `curl -f http://127.0.0.1:3120/health` in a compose healthcheck (optional).

**Rollback:**
- Set `PLATFORM_API_ENABLED=false` and restart. Bot is unaffected.
- No DB rollback needed — no schema changes.

**Gradual rollout:**
- Phases 1–4 ship with `PLATFORM_API_ENABLED=false` by default; operator opts in per environment.
- After Phase 4 close, dev environments may enable the API by default for tooling; production remains operator-controlled.
- Admin panel migration to consume the API is a separate future project and does not affect this rollout.

**Observability:**
- Reuse existing Pino logs.
- Every request gets an `X-Request-Id` (generated if not supplied); logged on request start + finish + error.
- Startup logs advertise the effective bind and public-interface warning if applicable.

**Ops runbook items** (to include in `docs/platform-api.md`):
- How to generate a new token (`openssl rand -hex 32`).
- How to rotate (env swap + restart).
- How to disable in emergency.
- Which endpoints are safe to hit during an incident (all `GET`s are safe; `POST /hunt` etc. have side effects).

---

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Accidental public exposure** (misconfigured bind, Docker port publish) | Medium | Critical | Loopback default, non-loopback startup warning, `.env.example` warnings, doc runbook. Same pattern that already works for admin panel. |
| **API drift from Discord semantics** (bug fix in service, forgotten in API test) | Medium | High | Parity tests (Phase 3). CI required to pass. |
| **Service signature changes break parity assumptions** | Low | Medium | All new services are additive wrappers, old signatures preserved. Type system catches breakage. |
| **Event bus expectations** (a client assumes API hunt triggers activity feed) | Medium | Low | Explicit doc + endpoint description: "v1 API mutations do not emit Game Events. See §5." Intentional temporary limitation, forward path documented. |
| **Content hot-reload race** — admin panel reloads content mid-API-request | Low | Low | Content snapshot is atomic per-request via `ctx.content.getSnapshot()`; already resilient. |
| **Zod schema drift between request and response** (validating input differently from serializing output) | Medium | Low | Single Zod schema per resource; used both directions. Contract test catches drift. |
| **Bearer token in logs** (someone adds header logging later) | Low | High | Explicit Pino serializer for the auth header; unit test asserts `Authorization` is never in a log line. |
| **Discord bot latency spike** from API traffic sharing the event loop | Low | Low | Both are I/O-bound; Node handles concurrent requests fine. Monitor `--inspect` if concerns arise. |
| **Fastify major version upgrade** breaks admin panel and API together | Low | Medium | Version pinned in `package.json`; upgrade via dedicated PR. |
| **Ephemeral encounter expiry during API capture** (encounter expired between GET and POST) | Medium | Low | Service already throws `EncounterExpiredError` → API returns `409 ENCOUNTER_EXPIRED`. Documented. |

---

## 16. Success Criteria

**Objectively verifiable:**

1. ✅ Discord bot behavior at project close is **bit-identical** to Phase 0 baseline. Every existing test passes.
2. ✅ `curl http://127.0.0.1:3120/api/v1/docs` shows a complete OpenAPI spec covering all endpoints in §8.
3. ✅ Every endpoint has at least one integration test.
4. ✅ Every mutation endpoint has a parity test asserting identical DB state vs the Discord path.
5. ✅ `PLATFORM_API_ENABLED=false` disables the API completely — no port bind, no plugin load, no runtime overhead.
6. ✅ Startup with mismatched config (enabled + no token) fails fast with `ConfigError`.
7. ✅ `/ready` reports component-level status (`database`, `content`, `discordClient`, `platformApi`) and returns 503 when a required component is down.
8. ✅ Docker deployment publishes the API port only on the configured `PLATFORM_API_PUBLISH_HOST` (loopback by default).
9. ✅ OpenAPI snapshot test protects the v1 contract in CI.
10. ✅ `docs/platform-api.md` exists and covers enabling, tokens, endpoints, security posture, and the versioning contract.
11. ✅ The response envelope reserves an optional `meta` object; `/api/v1/system` is documented as a reserved namespace; the `/me` resource design note is present — v2/OAuth work will not require redesigning any v1 endpoint.
12. ✅ Admin panel is functionally unchanged. No admin views were migrated to consume the API during this project.

**Subjective (architectural):**

- The service layer is untouched except for **additive** wrapper functions clearly documented in §5.
- No gameplay logic lives in `src/api/`. Reviewer scanning `src/api/routes/` sees only HTTP glue.
- Adding an endpoint takes **one new file plus one route registration** — the pattern is obvious.
- The Player Portal (a future project) can begin by consuming these endpoints without any change to Waifumon itself.
- `v2` (public + OAuth) can be added as a sibling directory `src/api/v2/` reusing `src/api/plugins/`, `src/api/errors.ts`, and the same service layer — no breaking change to v1.

---

## 17. Future Extension Points

The following are **explicitly out of scope for this project** but are called out here so v1's route organization, response envelope, service boundaries, and event model naturally accommodate them without breaking changes.

### 17.1 Authenticated `/me` resource

See §8.4 for the full design note. Summary: once Discord OAuth2 lands (v2), every player-scoped endpoint gains a `/players/me/...` alias resolved from a JWT claim instead of a path parameter. Route bodies and response shapes are unchanged; only the `preHandler` that populates `request.user` is new. No v1 endpoint needs to be redesigned or relocated.

### 17.2 Composite endpoints for client convenience

Future clients — particularly the Player Portal — will benefit from **composite endpoints** that aggregate several resources into a single response, saving round trips and providing a coherent snapshot. Examples:

```
GET /api/v1/players/me/dashboard
→ {
    "player":     { … },        // player summary
    "buddy":      { … } | null,  // current buddy waifu + species
    "currencies": { … },        // balances
    "daily":      { … },        // claim status + next reset
    "quests":     [ … ],        // active daily quests + progress
    "inventory":  { … },        // capacity summary + counts by category
    "care":       { … } | null   // care mode state, if active
  }
```

Other likely composites:
- `GET /api/v1/players/me/collection/summary` — dex progress + recent captures + buddy highlight.
- `GET /api/v1/players/me/hunt/context` — pre-hunt snapshot (energy, buddy affinity, active effects, encounter cooldowns).

**Design rules for future composites:**
- Composites are **read-only** and **derived** — they compose existing service reads, never introduce new gameplay logic.
- Each composite lives at a distinct URL; **existing granular endpoints are not modified** to serve composite data.
- The response envelope is unchanged (`{ data: { … }, meta?: { … } }`); the composite payload is a plain object.
- Composites are prime candidates for authenticated `/me` variants — they read most naturally when the identity is already known.

Not implemented in v1. The granular endpoints in §8.1 are the building blocks.

### 17.3 Platform / system endpoints (`/api/v1/system`)

The `/api/v1/system` namespace is reserved (see §8.1) for endpoints that describe the platform itself rather than game state. Anticipated future occupants:

- `GET /api/v1/system/version` — build tag, git SHA, deploy time.
- `GET /api/v1/system/feature-flags` — currently active feature gates, safe subset only.
- `GET /api/v1/system/status` — richer sibling of `/ready` intended for dashboards (uptime, connection counts, cache sizes).
- `GET /api/v1/system/configuration` — sanitized snapshot of runtime config (never secrets), for support tooling.
- `GET /api/v1/system/diagnostics` — deeper introspection (event bus subscriber list, content snapshot signature, migration state), gated behind an operator role in v2.

None of these ship in v1. The reservation ensures no future need collides with gameplay resources or forces a v2 bump.

### 17.4 API-level audit logging

When the API begins carrying **administrative actions** — content edits, configuration changes, economy adjustments, moderation actions — it becomes the natural place to enforce audit logging. Planned properties for a future audit layer:

- **Scope**: administrative mutations only. Gameplay actions (hunt, capture, purchase, claim) are captured by the existing progression/session/transaction tables and do not need duplicate audit records.
- **Storage**: a dedicated `platform_audit_log` table with `id`, `occurred_at`, `actor_kind` (`api-token | user | system`), `actor_id`, `route`, `method`, `resource_kind`, `resource_id`, `action`, `before_json`, `after_json`, `request_id`, `outcome` (`success | denied | error`), `error_code`.
- **Emission**: a Fastify `onResponse` hook wired to a small `auditService.record(...)` that only fires for routes tagged as auditable. Tagging is opt-in per route, preventing accidental capture of gameplay traffic.
- **Redaction**: request/response bodies are redacted through a per-route allowlist before being persisted. Bearer tokens, cookies, and any field named in a deny-list never touch the audit table.
- **Retention**: configurable (default 180 days), with a scheduled pruning job.
- **Read surface**: a future `GET /api/v1/system/audit` endpoint (see §17.3) exposes the log to authorized operator tooling.

Not implemented in v1. v1 has no administrative mutation endpoints — content editing stays in the admin panel where it is already audit-adjacent via file backups. The API becoming a natural audit-boundary is one of the strongest reasons to migrate admin mutations later.

### 17.5 API event source for the Game Event Bus

See §5. Future gameplay clients will emit `GameEvent`s through a new `PlatformSource` variant on `GameEventSource`. This is the mechanism by which a Player Portal hunt would appear in the Activity Feed and update the Trainer Profile without going through Discord. Additive, no v1 shape changes.

### 17.6 Meta envelope population

The reserved `meta` slot (see §8.3) is expected to accrue standard fields over time — `apiVersion`, `generatedAt`, `deprecation`, `rateLimit`, `serverTimeZone`. All additions are additive within v1; clients must tolerate absent and unknown fields.

---

## Relevant Files

**New (Phase 1):**
- `src/api/server.ts` — Fastify instance factory + start/stop
- `src/api/auth.ts` — bearer token `preHandler`
- `src/api/errors.ts` — `AppError` → HTTP status/JSON mapping
- `src/api/plugins/typeProvider.ts` — Zod provider registration
- `src/api/plugins/responseEnvelope.ts` — `{ data }` / paginated helpers
- `src/api/plugins/requestId.ts` — attach `X-Request-Id`
- `src/api/routes/health.ts` — `/health`, `/ready`
- `src/api/routes/v1/index.ts` — v1 route root

**New (Phase 2 — one file per resource group):**
- `src/api/routes/v1/{players,collection,currency,inventory,effects,care,encounter,daily,quests,shop,session,content,guilds}.ts`
- `src/api/schemas/{players,collection,currency,inventory,effects,care,encounter,daily,quests,shop,session,content,guilds,common}.ts`

**Modified (Phase 1):**
- [src/config/config.ts](src/config/config.ts) — add `platformApi` section (Zod-validated, fail-closed)
- [src/index.ts](src/index.ts) — start API server if enabled
- [docker-compose.yml](docker-compose.yml) — conditional port publish
- `.env.example` — new vars with security notes
- [package.json](package.json) — add `fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/helmet`

**Modified (Phase 3, additive):**
- [src/modules/hunt/huntService.ts](src/modules/hunt/huntService.ts) — accept `channelId: string | null`
- [src/modules/care/careService.ts](src/modules/care/careService.ts) — add standalone (non-tx-arg) wrappers
- [src/modules/session/sessionService.ts](src/modules/session/sessionService.ts) — add `getSession` read variant
- [src/modules/daily/dailyService.ts](src/modules/daily/dailyService.ts) — add `getStatus` if not present

**New tests:**
- `tests/unit/api/**` — one file per route group
- `tests/integration/api/**` — one file per route group
- `tests/integration/parity/**` — one file per mutation endpoint
- `tests/integration/openapi.test.ts` — contract snapshot
- `tests/snapshots/openapi.json` — versioned snapshot

**New docs:**
- `docs/platform-api.md` — operator + client guide

**Unchanged:**
- All of `src/discord/**`
- All of `src/admin/**` — the existing admin panel is **not touched** by this project.
- All of `src/modules/**` (except the additive wrappers noted above)
- All of `src/db/**`

---

## Decisions (Confirmed with User)

- **Framework**: Fastify (reuse existing)
- **Process topology**: Same Node process, second Fastify instance on its own port
- **Player identity**: Internal `playerId` in paths + lookup endpoint by `(discordGuildId, discordUserId)`
- **Scope**: Player gameplay resources + gameplay actions + read-only content catalog. Content mutation, leaderboards, guild admin writes deferred.
- **Auth v1**: Static bearer token via `PLATFORM_API_TOKEN` + loopback/Tailscale bind enforcement.

## Further Considerations

1. **OpenAPI snapshot as a hard CI gate vs. warning?** Option A: hard gate, force explicit updates. Option B: warning only. **Recommendation: A** — v1 contract stability is a stated goal.
2. **Should the guild lookup endpoint accept internal `guildDbId` too?** Option A: only `discordGuildId` (matches how bot uses it). Option B: both. **Recommendation: A** — YAGNI; add later if a client needs it.
3. **Should v1 populate `meta.requestId` immediately, or leave `meta` empty until a documented need arises?** Option A: populate `requestId` now for opportunistic client use. Option B: reserve the slot but ship v1 with no `meta` payload. **Recommendation: A** — trivial cost, immediate correlation benefit, and it exercises the envelope path so it's not dormant code.
