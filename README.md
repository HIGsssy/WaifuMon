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

## Layout

- `src/` — bot source (config, db, discord shell, service modules, shared)
- `content/` — species/items/tables JSON, validated with Zod at startup
- `assets/waifumon/<slug>/standard.png` — card art (placeholders for now)
- `drizzle/` — generated SQL migrations
- `tests/` — Vitest unit + integration suites
