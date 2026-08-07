# Waifumon Bot — Milestone 1: Standalone Postgres Foundation

Standalone Discord collection-game bot. This milestone ships the operational
spine: Docker Compose (bot + Postgres 16), Drizzle migrations, content
seeding, PlayChannelGuard, player provisioning, currency/inventory, daily
claim, and the MVP shop. No hunt/capture logic yet (Milestone 2).

## Run

```sh
cp .env.example .env   # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, POSTGRES_PASSWORD
docker compose up --build
```

The bot retries until Postgres is healthy, runs migrations, validates and
seeds content from `content/`, registers slash commands (guild-scoped when
`DISCORD_GUILD_ID` is set), then logs in. Card art mounts read-only from
`./assets` (`ASSETS_DIR`).

## Develop

```sh
npm install
npm run db:generate    # regenerate SQL migrations after editing src/db/schema.ts
npm run dev            # needs DATABASE_URL pointing at a local Postgres
npm test               # Vitest; DB tests use Testcontainers (Docker required),
                       # or set TEST_DATABASE_URL to an existing Postgres
```

## Commands

- `/waifumon menu | profile | daily | inventory | shop` — all ephemeral,
  NSFW-marked channels only (PlayChannelGuard).
- `/waifumon-admin allow-channel add|remove|list` — optional play-channel
  allowlist (empty = any NSFW channel).
- `/waifumon-admin set-announce-channel` — must target an NSFW text channel.

## Admin web panel

An optional internal web UI for editing species, items, drop-rate tables and
daily quests without hand-editing JSON. **Disabled by default.**

```sh
ADMIN_WEB_ENABLED=true
ADMIN_WEB_HOST=127.0.0.1
ADMIN_WEB_PORT=3111
ADMIN_WEB_TOKEN=$(openssl rand -hex 32)   # required when enabled
```

It binds to loopback, so reach it through a tunnel:

```sh
ssh -L 3111:127.0.0.1:3111 user@server    # then open http://127.0.0.1:3111/admin
```

Edits are schema-validated, backed up to `content/backups/` and written
atomically; species and items can be re-seeded into Postgres without a restart.
Do not expose it publicly. See [docs/admin-web.md](docs/admin-web.md).

## Platform API

An optional internal REST surface (`/api/v1/…`) over the game service layer,
with Swagger UI at `/api/v1/docs`. **Disabled by default.**

```sh
PLATFORM_API_ENABLED=true
PLATFORM_API_HOST=127.0.0.1                 # where the process listens
PLATFORM_API_PORT=3120
PLATFORM_API_TOKEN=$(openssl rand -hex 32)  # required when enabled
PLATFORM_API_PUBLIC_URL=http://127.0.0.1:3120   # how clients reach it
```

Three networking variables that are easy to confuse:

| Variable | Answers |
| --- | --- |
| `PLATFORM_API_HOST` | Where the process **listens** — `0.0.0.0` under Docker, loopback otherwise. |
| `PLATFORM_API_PUBLISH_HOST` | Where **Docker publishes** the port on the host. The real security boundary. |
| `PLATFORM_API_PUBLIC_URL` | How **clients reach** it — the URL advertised in the OpenAPI `servers` list, so Swagger UI's "Try it out" works. |

`PLATFORM_API_PUBLIC_URL` is optional; when unset the URL is derived from the
bind, and a wildcard bind falls back to `http://127.0.0.1:$PLATFORM_API_PORT`
(the API never advertises `0.0.0.0`, which no browser can route to). See
[docs/platform-api.md](docs/platform-api.md).

## Player Portal

A **read-only companion web app** over the Platform API — collection, buddy,
inventory, shop, encyclopedia and a game guide. It is a separate package in
`portal/` with its own dependencies; the bot neither knows nor cares that it
exists.

```sh
cd portal
cp .env.example .env.local    # set VITE_PLATFORM_API_TOKEN
npm install
npm run assets:thumbs         # generate artwork renditions (once)
npm run dev                   # http://127.0.0.1:5173
```

Requires the Platform API enabled above. On first load it asks which player to
show — paste a Discord user id and it resolves the internal player itself;
"Switch player" in the header changes testers without touching `.env.local`.

**Development only:** that screen is a picker, not a sign-in — the Portal has no
authentication and carries the shared API token in the browser bundle, so keep
it on loopback. It cannot change game state — every non-GET request is rejected
before it leaves the client. See [docs/portal.md](docs/portal.md).

## Layout

- `src/` — bot source (config, db, discord shell, service modules, shared)
- `src/admin/` — optional internal admin web panel (Fastify, server-rendered)
- `src/api/` — optional Platform API (Fastify, `/api/v1/…`)
- `portal/` — optional Player Portal SPA (Vite + React), own package and lockfile
- `content/` — species/items/tables JSON, validated with Zod at startup
- `assets/waifumon/<slug>/standard.png` — card art (placeholders for now)
- `drizzle/` — generated SQL migrations
- `tests/` — Vitest unit + integration suites
