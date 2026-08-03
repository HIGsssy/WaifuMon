# Waifumon Admin Web Panel

An **internal** content-management panel for the Waifumon bot. It lets a trusted
operator add and edit Waifumon species, items, drop rates, tables and daily
quests through a browser instead of hand-editing JSON — with schema validation,
timestamped backups and atomic writes on every save.

It is **not** a player-facing feature, it has no player moderation tools, and it
is **disabled by default**.

---

## What it manages

The JSON files under `CONTENT_DIR` remain the source of truth. The panel is the
only writer, and every write goes through the bot's own Zod schemas.

| Page | Path | Manages |
| --- | --- | --- |
| Dashboard | `/admin` | Counts, config highlights, validation status, Validate / Reload |
| Species | `/admin/species` | `content/species/*.json` — search, filter, sort, edit, enable/disable |
| Items | `/admin/items` | `content/items.json` — create, edit, enable/disable, reference map |
| Tables & rates | `/admin/tables` | Every top-level block of `content/tables.json` |
| Quests | `/admin/quests` | `tables.json → dailyQuests.pool` |

`/admin/tables` exposes one editor per top-level key: `energy` (incl. care
mode), `inventory`, `dailyPackage`, `hunt` (result table, rarity table, item
find, rare item find, currency ranges, flavor), `capture`, `buddyAffinity`,
`duplicate`, `progression`, `waifuProgression`, `dailyQuests`, `uiFlavor`,
`uiSplash` and `session`. Each block is edited as validated JSON and comes with
computed diagnostics — total weights, per-entry share, empty-rarity warnings,
unknown/disabled item references, and the buddy-affinity wheel and bonus table.

---

## Enabling it

Add to `.env`:

```sh
ADMIN_WEB_ENABLED=true
ADMIN_WEB_HOST=127.0.0.1
ADMIN_WEB_PORT=3111
ADMIN_WEB_TOKEN=<a long random secret>
```

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_WEB_ENABLED` | `false` | `true`/`1` to start the panel. Anything else keeps it off. |
| `ADMIN_WEB_HOST` | `127.0.0.1` | Loopback. Binding elsewhere logs a warning at startup. |
| `ADMIN_WEB_PORT` | `3111` | |
| `ADMIN_WEB_TOKEN` | *(empty)* | **Required** when enabled — startup fails with a config error otherwise. Never logged, never rendered, never stored in a cookie. |

Generate a token with `openssl rand -hex 32`.

When the panel starts, the bot logs the bind address:

```
admin web panel listening on http://127.0.0.1:3111/admin
```

With `ADMIN_WEB_ENABLED=false` (the default) no server is created, no port is
bound, and nothing about the bot's behaviour changes.

### Reaching it

The panel binds to loopback, so from your workstation:

```sh
ssh -L 3111:127.0.0.1:3111 user@server
```

then open <http://127.0.0.1:3111/admin> and sign in with the token.

### Under Docker

Two things differ:

1. `content/` is baked into the image, so uncomment the `./content:/app/content`
   bind mount in `docker-compose.yml` — otherwise saves are lost on the next
   rebuild (and may fail outright, since the image runs as the `node` user).
2. A loopback bind inside a container is unreachable from outside it. Set
   `ADMIN_WEB_HOST=0.0.0.0` **and** publish the port to the host's loopback
   only:

   ```yaml
   ports:
     - '127.0.0.1:3111:3111'
   ```

   Publishing as `3111:3111` would expose the panel on every host interface. Do
   not do that.

> **Security warning.** There is one shared token and no TLS. Do not expose the
> panel on a public interface. If you must reach it without a tunnel, put it
> behind a reverse proxy that terminates TLS and adds its own authentication
> (OAuth / SSO / mTLS), and keep the app itself bound to loopback.

---

## Authentication

Every page, API route and asset-preview route requires auth. Two ways in:

- **Browser** — `POST /admin/login` with the token sets an `httpOnly`,
  `SameSite=Strict` session cookie containing a SHA-256 digest of the token (the
  secret itself never travels back to the client). `POST /admin/logout` clears
  it. Sessions last 12 hours.
- **Scripts** — `Authorization: Bearer <ADMIN_WEB_TOKEN>` on each request.

Unauthenticated browser navigations redirect to `/admin/login`; everything else
gets a `401`. Failed logins are rate-limited per IP (10 per 5 minutes).

**CSRF:** cookie-authenticated writes must echo the non-httpOnly
`wm_admin_csrf` cookie in an `x-admin-csrf` header (double-submit); a mismatch
is a `403`. The page script does this automatically. Bearer requests are exempt
— a browser cannot be tricked into attaching an `Authorization` header.

---

## How saving works

Every mutation follows the same path, and **nothing is written unless the whole
content set validates**:

1. Read the current JSON from disk.
2. Apply the edit in memory.
3. Validate the edited file against its Zod schema.
4. Validate the **entire** candidate content set — slug uniqueness plus every
   cross-reference (daily package, hunt find tables, progression bonuses, quest
   rewards) — using the same `validateContentSet` the bot runs at startup.
5. Copy the original to `content/backups/<label>-YYYYMMDD-HHMMSS.json`.
6. Write a temp file next to the target, re-read and re-validate what actually
   landed on disk, then `rename()` it into place.

A rejected edit leaves the original file untouched and removes the temp file.
Validation errors come back with field paths (`rarity: Invalid enum value…`)
and are shown inline above the form.

### Backups

| Edited | Backup |
| --- | --- |
| `content/species/starter.json` | `content/backups/species-starter-20260802-194500.json` |
| `content/items.json` | `content/backups/items-20260802-194500.json` |
| `content/tables.json` | `content/backups/tables-20260802-194500.json` |

Backups accumulate and are never pruned — sweep `content/backups/` periodically.
Restoring is a plain file copy back over the original, followed by *Reload
Content*.

### Validate and reload

- **Validate Content** (`POST /admin/validate-content`) — re-reads everything
  and returns pass/fail, errors, warnings and a summary (species totals, enabled
  counts per rarity, item counts, quest counts, missing-art warnings).
- **Reload Content** (`POST /admin/reload-content`) — refuses to run while
  content is invalid; otherwise calls the same `createContentReloader` the bot
  uses at startup, so species and items are re-seeded into Postgres and the
  counts (inserted/updated/disabled) are returned. Existing rows are never
  deleted — slugs missing from JSON are flagged `enabled = false`.

If a reload fails after a save (e.g. Postgres is down), the JSON on disk is
still valid and already saved. Fix the database and press Reload again, or
restart the bot — startup runs the identical path.

**Scope of a live reload:** species and item rows go live immediately. Tuning
inside `tables.json` (hunt rates, capture math, care mode, quests, session
timeout, splash text) is read into the services once at startup, so those
changes need a bot restart.

---

## Working with species

`/admin/species` lists every card with an art thumbnail, and supports search
(slug, name, archetype, tags), filters (rarity, affinity, enabled/disabled) and
sorting (rarity, name, slug).

Fields map 1:1 onto `SpeciesContentSchema`: `slug`, `name`, `rarity`,
`archetype`, `affinity`, `contentRating`, `baseCaptureRate`, `perSpeciesWeight`,
`eventKey`, `imagePath`, `description`, `tags` (comma or newline separated) and
`enabled`.

Rules enforced on save:

- `slug` must be `lowercase_snake_case` and unique across **all** species files.
- `rarity`, `affinity` and `contentRating` must be valid enum values.
- `baseCaptureRate` must be `0 < x ≤ 1`, or blank for the rarity default.
- `imagePath` must be a **relative** path inside `ASSETS_DIR`: no absolute
  paths, no drive letters, no `..` segments, no backslashes, no URLs.

New species are written to `content/species/custom.json` by default; the form
lets you pick any existing species file instead. Editing keeps a card in the
file it already lives in.

**Art.** Drop the file at `assets/waifumon/<slug>/standard.png` and point
`imagePath` at `waifumon/<slug>/standard.png`. A species whose art is missing
still saves — it is reported as a warning and the loader auto-disables it at
startup so a broken card never renders.

### Typical flow

1. `/admin/species/new` → fill in the card → **Save**.
2. **Validate Content** on the dashboard — confirm no errors.
3. **Reload Content** — the species is seeded into Postgres.
4. To retire a card, **Disable** it and reload; disabled species are excluded
   from hunts. Species are never deleted (owned Waifumon must keep their row).

---

## Working with items

Item fields follow `ItemContentSchema`: `slug`, `name`, `category`, `emoji`,
`captureModifier`, `purchasable`, `buyPrice`, `dailyStockLimit`, `description`,
`isGuaranteedCapture`, `enabled`. The schema's own invariants apply — a
guaranteed-capture item can't be purchasable, and a purchasable item needs a
price.

The list shows a **Referenced by** column: every config location pointing at the
slug (`dailyPackage.items`, `hunt.itemFind`, `hunt.rareItemFind`,
`progression.dailyBonusItems`, `progression.dailyRareItemChance`, and each
`dailyQuests` reward). Renaming a referenced slug is blocked; disable the item
instead. **There is no delete route** — disabling is the supported path, so
player inventories and shop history stay intact.

---

## Known limitations / deferred

- **Image upload is deferred.** Copy art onto the server yourself and set
  `imagePath`. The authenticated preview route (`/admin/assets/*`, confined to
  `ASSETS_DIR`, images only) is implemented.
- **`tables.json` changes need a bot restart** to affect a running session; only
  species and items reload live.
- **Complex table blocks are edited as JSON**, not as generated forms. They are
  schema-validated before anything is written, and each block shows computed
  diagnostics. A dedicated field-by-field editor is future work.
- **Quests** support create / edit / remove from the pool. There is no per-quest
  enable flag because the content schema has none; `dailyQuests.enabled`,
  `questsPerDay` and `allCompleteBonus` are edited on the Tables page. Removing
  a quest does not disturb copies already assigned to players — assignment
  freezes title, target and rewards onto the player's row.
- **Single shared token, no per-user accounts, no audit log** of who changed
  what. Backups record *what* changed and when, not *who*.
- **No TLS.** Loopback plus SSH tunnel, or a reverse proxy.
- **Backups are never pruned.**
- **No concurrent-edit protection.** Two admins saving the same file at once
  will have the last write win (the earlier version survives as a backup).

---

## Safety properties

- Admin routes never read arbitrary files. The only file-serving route is
  `/admin/assets/*`, which resolves under `ASSETS_DIR`, rejects traversal and
  serves image types only — and requires auth like everything else.
- Content writes are confined to `CONTENT_DIR`; species filenames are
  pattern-checked and resolved inside `content/species/`.
- `.env`, logs and the database are not reachable from the panel.
- The bot token and admin token never appear in the UI or in logs. Request
  logging records method, path and remote address only.
- The panel is disabled by default and binds loopback by default.
