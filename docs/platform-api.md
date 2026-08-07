# Waifumon Platform API

An **internal** REST surface (`/api/v1/…`) over the game service layer, served
by a second Fastify instance inside the bot process. It owns no gameplay logic
and shares `AppContext` in memory with the Discord shell.

It is **disabled by default**, has no TLS, no CORS and no player
authentication — every request carries a shared bearer token. Implementation
notes for the endpoint set live in
[platform-api-phase2.md](platform-api-phase2.md).

> **v1 mutations do not emit Game Events.** Actions taken through this API do
> not appear in the Activity Feed and do not update Trainer Profiles.

---

## Enabling it

Add to `.env`:

```sh
PLATFORM_API_ENABLED=true
PLATFORM_API_PORT=3120
PLATFORM_API_TOKEN=<a long random secret>    # openssl rand -hex 32
```

| Variable | Default | Notes |
| --- | --- | --- |
| `PLATFORM_API_ENABLED` | `false` | `true`/`1` to start the API. Anything else keeps it off, at zero cost. |
| `PLATFORM_API_PORT` | `3120` | |
| `PLATFORM_API_TOKEN` | *(empty)* | **Required** when enabled — startup fails with a config error otherwise. Never logged. |

Every request needs `Authorization: Bearer $PLATFORM_API_TOKEN`, except
`/health`, `/ready`, `/api/v1/docs` and `/api/v1/openapi.json`.

---

## Networking: three different concepts

The three remaining variables look similar and are not interchangeable. They
answer three different questions:

| Variable | Question it answers | Default |
| --- | --- | --- |
| `PLATFORM_API_HOST` | Where does the process **listen**? | `127.0.0.1` |
| `PLATFORM_API_PUBLISH_HOST` | Where does **Docker publish** the port on the host? | `127.0.0.1` |
| `PLATFORM_API_PUBLIC_URL` | How do **clients reach** it? | *(derived)* |

### `PLATFORM_API_HOST` — the bind

An internal networking concern only. Use `127.0.0.1` when running the bot
directly on the host and reach it through a tunnel:

```sh
ssh -L 3120:127.0.0.1:3120 user@server
```

Under Docker it **must** be `0.0.0.0`: loopback inside a container is its own
network namespace and is unreachable from outside it. The process logs a
warning whenever the bind is neither loopback (`127.0.0.0/8`) nor Tailscale
(`100.64.0.0/10`) — expected and harmless under Docker.

### `PLATFORM_API_PUBLISH_HOST` — the Docker boundary

Docker only, consumed by `docker-compose.yml`, not by the app. This is the real
security boundary — not the bind above.

- `127.0.0.1` — host loopback only, reach it with an SSH tunnel (default)
- `100.x.y.z` — the host's own Tailscale IP, reachable across the tailnet
- `0.0.0.0` — **never**: published ports are inserted ahead of ufw/iptables, so
  a firewall will not protect it.

### `PLATFORM_API_PUBLIC_URL` — the advertised URL

The base URL clients are expected to call. It is what the OpenAPI document
lists under `servers`, and therefore the URL Swagger UI's **Try it out** builds
its requests from. Optional, and never a bind:

```sh
PLATFORM_API_PUBLIC_URL=http://127.0.0.1:3120      # local dev, Docker on loopback
PLATFORM_API_PUBLIC_URL=http://100.x.y.z:3120      # Tailscale
PLATFORM_API_PUBLIC_URL=https://api.waifumon.com   # behind a TLS reverse proxy
```

It must be an absolute `http(s)` URL; a wildcard host (`0.0.0.0`, `::`) is
rejected at startup, and a trailing slash is trimmed.

**When it is unset**, the URL is derived from the bind — `http://<host>:<port>`
— except for a wildcard bind, which falls back to
`http://127.0.0.1:$PLATFORM_API_PORT`. That fallback is the point of the
variable: `0.0.0.0` is a valid listening address but not a routable one, so a
Swagger UI that advertised it would fail every "Try it out" from the browser.
The derived value is a guess that matches the default Docker setup (published
to loopback); set `PLATFORM_API_PUBLIC_URL` whenever you publish anywhere else.

The startup log prints both, so a mismatch is visible at a glance:

```
platform API listening on 0.0.0.0:3120 — clients use http://127.0.0.1:3120/api/v1 (docs: http://127.0.0.1:3120/api/v1/docs)
```

---

## Docs and spec

| Path | Serves |
| --- | --- |
| `/api/v1/docs` | Swagger UI |
| `/api/v1/openapi.json` | The OpenAPI 3.1 document |
| `/health` | Liveness — never touches the database |
| `/ready` | Readiness — database, content and Discord client probes |

Both docs routes are public so an operator can read them without a token;
authorize in Swagger UI with the bearer token before calling any endpoint.

---

## Artwork: the `assetId` contract

**The API never says where artwork lives.** It has no notion of a filesystem
path, a static URL, a CDN origin, an object-storage key, a content hash, or a
file extension. It emits one thing:

```json
{ "kind": "waifumon", "slug": "alley_catgirl", "variant": "level_20" }
```

That is an *identity*, not a location: it names **what** to render. Every
consumer resolves it independently —

| Consumer | Resolver |
| --- | --- |
| Player Portal | `portal/src/images/` provider chain |
| Discord bot | `src/discord/assets/resolveAppearanceAsset.ts` |
| A future CDN, object store, or mobile client | its own, no API change |

so migrating a storage backend is a per-consumer change with **zero** contract
impact. Content hashing, size negotiation, WebP fallbacks and edge routing all
belong inside a resolver and never appear here.

This is enforced, not merely intended: an integration test walks every v1
response body and fails on any image extension or `assets/` substring
(`tests/integration/api/appearanceEndpoints.test.ts`). Re-adding a path field
breaks CI.

> The seeded species row still has an internal `image_path` column. It is the
> content loader's private pre-flight existence probe and is **not** part of any
> response. It was removed from the species resource when appearances shipped.

---

## Appearances

Every species has an appearance catalog and every owned copy wears one of them.
Appearances are **cosmetic**: selecting one writes a single column and cannot
affect stats, XP, affection, evolution, or capture odds. An integration test
diffs the row to prove it.

A species that predates the system carries exactly one implicit `standard`
entry, so this is additive for every existing client.

### Where appearance data appears

| Endpoint | Carries |
| --- | --- |
| `GET /content/species`, `/content/species/{slug}` | `appearances[]` — the authored catalog, no per-player state |
| `GET …/collection/owned`, `/owned/{id}`, `/buddy`, `GET …/care` | `waifu.selectedAppearance` — the resolved look she is wearing |
| `GET …/collection/owned/{waifuId}/appearances` | the full per-copy gallery, locked entries included |
| `PUT …/collection/owned/{waifuId}/appearance` | selection |

### `GET /v1/players/{id}/collection/owned/{waifuId}/appearances`

Returns `{ appearances, selected }`. **Locked entries are included** — each
carries `unlockLabel` (`"Owned"`, `"Reach Level 20"`), which is what turns the
gallery into a progression journal rather than a lock indicator. Clients are
expected to render that label in both states.

```json
{
  "id": "level_20",
  "name": "Midnight Bloom",
  "description": "A darker cut of her usual silhouette.",
  "flavorText": "Prepared for the annual shrine celebration.",
  "cosmeticRarity": "seasonal",
  "introducedVersion": "v1.3",
  "assetId": { "kind": "waifumon", "slug": "alley_catgirl", "variant": "level_20" },
  "unlock": { "type": "level", "atLevel": 20 },
  "unlockLabel": "Reach Level 20",
  "isUnlocked": false,
  "isSelected": false
}
```

**This read has one deliberate side effect.** Appearances the copy already
qualifies for but has never been notified about are acknowledged now, and an
`appearance_unlock` audit row is written with `source: "content_add"`. That is
what makes retroactively-added artwork unlock itself: ship Level-20 art today
and every copy already past Level 20 has it, with no backfill job.

### `PUT /v1/players/{id}/collection/owned/{waifuId}/appearance`

Body `{ "appearanceId": "level_20" }`; returns the updated owned entry.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `APPEARANCE_NOT_FOUND` | The species has no appearance with that id |
| 404 | `WAIFU_NOT_OWNED` | Not this player's copy |
| 409 | `APPEARANCE_LOCKED` | Exists, but this copy has not earned it |

This is the **only** non-GET verb in v1, and a contract test pins that as an
explicit allowlist so a second one cannot appear unnoticed. Gameplay mutations
(hunt, capture, purchase, claim) remain out of scope.

Note that the [Player Portal](portal.md) does **not** call this endpoint — it
is strictly read-only and defers selection to Discord until authenticated writes
exist. Exposing the capability is the API's job; whether a given client uses it
is that client's decision. Today the caller is the Discord bot, via the service
layer directly.

### Cosmetic rarity

`appearance.cosmeticRarity` (`standard` \| `common` \| `rare` \| `seasonal` \|
`limited` \| `exclusive`) is **independent from `species.rarity`**
(`N`/`R`/`SR`/…). The two are separate signals with separate field names and are
expected to be styled differently. Cosmetic rarity is descriptive: it drives no
drop, no unlock, and no gameplay. Render an unrecognised future value as
`common`.

### Reserved unlock types

`unlock.type` is documented as an open enum. v1 emits only `owned` and `level`;
`evolution`, `affection`, `event`, `seasonal`, `achievement`, `promotion`,
`admin_grant` and `special` are published so a client can implement its renderer
once. Always prefer `unlockLabel` for display — it is populated for every type,
present and future.

---

## Player identity (`identity` on the player resource)

`GET /api/v1/players/{id}` and `/profile` carry a presentation-only `identity`
block alongside the player's game state:

```json
{
  "identity": {
    "displayName": "Alice",
    "avatarUrl": "https://cdn.discordapp.com/avatars/…/….png"
  }
}
```

It exists because HTTP clients have no gateway of their own to render from —
the Discord handlers resolve names and avatars at send time, so nothing was
ever stored. The [Player Portal](portal.md) was the first client to need it.

**`identity` is always nullable and clients must treat it that way.** It is
`null` when the gateway is reconnecting, when the user cannot be resolved, and
in any process wired without a Discord client at all. No endpoint's behaviour
depends on it, and no gameplay value is derived from it.

Mechanically it is not a column. The API layer holds no Discord types, so the
host injects a resolver (`ApiContext.resolveIdentity`) exactly as it injects
`ReadinessProbes`. `src/api/identity.ts` wraps that resolver with a 5-minute
TTL, a 60-second negative TTL, in-flight de-duplication and a 500 ms timeout,
so a slow or broken gateway costs a `null` rather than a slow request. The
resolver never rejects.

`displayName` is the Discord **global** display name (falling back to the
username), not a per-guild nickname — a nickname would need a guild-member
fetch, and the player resource carries only the internal guild id.
