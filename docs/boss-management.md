# Boss Management

Boss definitions live in the database and are authored in **Portal Admin →
Boss Management**. The scheduler draws from those rows and from nothing else.

```text
content/bosses.json ──(first start: insert what is missing)──▶ boss_definitions
                                                                    │
Portal Admin → Boss Management ──(create / edit / schedule)────────▶│
                                                                    ▼
                                              boss scheduler draws an Active,
                                              in-region, in-schedule boss
                                                                    ▼
                                              boss_encounters (frozen copy)
```

What a boss encounter *is* — the window, damage, rewards, the two Discord
messages — is unchanged and described in
[boss-encounters.md](boss-encounters.md). This page covers definitions,
availability schedules, and the admin controls.

## Where things live

| Concern | Location |
| --- | --- |
| Bootstrap data | `content/bosses.json` |
| Tables | `boss_definitions`, `boss_definition_events`, `boss_encounters.boss_snapshot` (migration `0045_boss_definitions.sql`); `artwork_assets`, `artwork_asset_events`, `boss_definitions.artwork_asset_id`, `boss_encounters.boss_artwork_asset_id` (migration `0046_boss_artwork_assets.sql`) |
| Definition shape, bootstrap, runtime source | `src/modules/bosses/bossDefinitions.ts` |
| Availability schedules (pure) | `src/modules/bosses/bossSchedule.ts` |
| Authoring service | `src/modules/bosses/bossDefinitionService.ts` |
| Artwork library and uploads | `src/modules/bosses/bossArtworkService.ts` (over `src/modules/artworkAssets/`) |
| Artwork at announcement time | `src/discord/bossArtwork.ts` |
| Spawn conditions and diagnostics | `src/modules/bosses/bossEncounterService.ts` (`explainSpawn`) |
| Admin API | `src/api/routes/v1/admin/bosses.ts` |
| Portal pages | `portal/src/features/adminBosses/` |

## The database is the authority

`boss_definitions` holds one row per boss. `content/bosses.json` is **bootstrap
data**: at startup (and after an admin-panel content reload) every boss in the
file whose id has **no row** is inserted. A row that exists is never read,
compared or written by startup, whatever the file says now. So:

- a deploy cannot undo, re-enable or rename a boss an admin has edited;
- editing an existing boss in the file has **no effect** on a server that
  already has that boss. Change it in the Portal, or export / import.

The bootstrap behaves differently the first time:

- **Empty table — the migration.** The whole shipped roster is inserted in
  one transaction with the file's statuses (`enabled: true` → Active), so the
  pool the scheduler draws from is exactly the one it drew from before.
- **Table already populated — a boss added to the file later.** It is
  inserted **Disabled**, whatever the file says, and a warning
  (`boss-definitions/held-back`) names it. A deploy cannot put a new boss
  into rotation; an admin activates it in Boss Management.

A failed bootstrap is logged (`boss-definitions/bootstrap-failed`) and shown
in Diagnostics, which also lists any shipped boss that has no definition.

This is the same insert-missing rule World Encounters follow.

The file's fields map across directly. Two are reshaped:

| `bosses.json` | `boss_definitions` |
| --- | --- |
| `enabled: true` / `false` | `status`: `active` / `disabled` |
| `region` | `regions`: a one-element list |
| — | `schedule`: always available |

`id` keeps its meaning: lowercase snake_case, fixed at creation, never reused —
it is what every encounter row records as `boss_id`.

## Lifecycle

| Status | Spawns? | |
| --- | --- | --- |
| **Draft** | no | May be incomplete: no prose, no reward table, no region. |
| **Active** | yes | Validated in full before it is saved or activated. |
| **Disabled** | no | A finished boss switched off. Keeps its history. |

An **Active** boss must have a name, all four pieces of prose, at least one
region, a boss reward table that exists, and a schedule that can still produce
a window. The same gaps on a Draft or Disabled boss are warnings.

Disabling always works — even for a boss that no longer validates — so a broken
boss can always be switched off.

**Delete** is for a mistake that never spawned. It is refused for a boss that
has any encounter history and for one that ships in `bosses.json` (the
bootstrap would re-insert it). Disable those instead.

Every write names the revision it edited. A save, status change, delete or
import overwrite against a revision someone else has replaced is refused with
`409 BOSS_DEFINITION_STALE`; nothing is overwritten.

## What can and cannot be configured per boss

The editor exposes what the runtime actually reads:

- identity — id, name, description, status;
- artwork — a shipped path and/or an uploaded image ([Artwork](#artwork));
- regions the boss may appear in (today only `waifu-valley` hosts bosses);
- affinity (the only per-boss combat attribute);
- the boss reward table it pays from (a table in `content/bossRewards.json`;
  the tables themselves are edited there, not here);
- the scouting, repelled and unchallenged text;
- the availability schedule.

These are **global**, in `tables.json` → `bossEncounters`, shared by every boss
and shown read-only in the editor: the encounter window (`scoutingMinutes`),
the respawn cooldown (`downtimeMinutesMin` / `Max`), and
`attacksPerParticipation`. Bosses have no HP pool. Boss selection is the
shuffle bag — there are no per-boss spawn weights.

## Availability schedules

A schedule answers one question: *may this boss be drawn right now?*

```jsonc
{
  "timezone": "America/Toronto",          // IANA zone; the default
  "weekly": [                              // null = every day
    { "day": "fri", "allDay": false, "windows": [{ "start": "18:00", "end": "23:59" }] },
    { "day": "sat", "allDay": true,  "windows": [] },
    { "day": "sun", "allDay": false, "windows": [{ "start": "12:00", "end": "22:00" }] }
  ],
  "dateRange": null                        // null = no date limit
}
```

| Mode | `weekly` | `dateRange` |
| --- | --- | --- |
| Always available | `null` | `null` |
| Weekly | set | `null` |
| Date range | `null` | set |
| Weekly within a date range | set | set |

**Weekly.** Any combination of `mon`…`sun`. Each day is all day or one or more
`HH:MM` windows. A start is inclusive and an end exclusive; `24:00` is a legal
end. A window whose end is at or before its start **crosses midnight** and
belongs to the day it starts on. Overlapping windows are merged (and flagged
with a warning).

**Date range.** Whole calendar days, inclusive at both ends:

- `{ "kind": "fixed", "start": "2026-10-25", "end": "2026-10-31" }` — these
  dates in this year only. It does **not** recur. Either end may be `null`.
- `{ "kind": "yearly", "start": "12-20", "end": "01-05" }` — every year. A
  range whose end is earlier than its start crosses New Year.

**Combined.** A moment must fall on a date inside the range *and* inside that
day's weekly rule. Because a window belongs to its start day, "Oct 31,
22:00–02:00" runs until 02:00 on Nov 1.

**Timezones and daylight saving.** Every wall-clock value is read in the
schedule's own timezone; the server's zone is never consulted. Windows are
built by converting their local endpoints to UTC instants one at a time, so a
23- or 25-hour day is simply a shorter or longer window. A local time that
does not exist (spring forward) is moved later by the size of the gap; one
that happens twice (fall back) means its first occurrence.

**Validation.** Refused: an unknown timezone, a weekly schedule with no day or
a day with no window, a zero-length window, a day listed twice, a date that
does not exist, a fixed range that ends before it starts. An Active boss is
also refused a schedule that can never open again (a fixed range in the past,
or weekdays that never fall inside the range) — the editor and the list show
the reason.

### What a schedule does not do

Automatic spawning needs **all three**:

1. the definition is **Active**;
2. the boss is inside its **availability window** (and assigned to the guild's
   region);
3. the existing spawn conditions hold — the guild's respawn cooldown has run
   out, it is not paused or suspended, no encounter is active, and the boss's
   reward table can pay.

A window makes a boss *eligible*; it does not make it spawn. And:

- **A live encounter is never ended by its window closing.** It runs to its
  own deadline and pays as usual.
- **Cooldowns are untouched by window boundaries.** A window opening does not
  shorten a running cooldown. When a guild is due but no boss is available,
  nothing is written — so the first boss to become available spawns on the
  next pass, not after a fresh cooldown.
- A boss that goes out of season simply drops out of the shuffle bag's draw
  until it is available again.

## Editing never reaches a live encounter

An encounter freezes its boss at spawn: name, affinity, artwork (the shipped
path and the uploaded image's id) and the reward table it names (as before),
and now also the four pieces of prose
(`boss_encounters.boss_snapshot`). Editing, disabling or rescheduling a boss
affects the **next** encounter only. Encounters spawned before migration 0045
have no prose snapshot and read the live definition, as they always did.

## Artwork

A boss has two artwork fields, and both are supported side by side:

| | Shipped | Uploaded (managed) |
| --- | --- | --- |
| Field | `artwork` — a path under `assets/`, e.g. `bosses/iron-matron_boss.webp` | `artworkAssetId` — the id of a managed artwork asset |
| Lives in | Git (`assets/bosses/`) | the managed artwork store (`MANAGED_ASSETS_DIR`), outside Git |
| Arrives by | commit → deploy | **Upload new artwork** in the boss editor |
| Deleted by | a commit | the artwork library, when no boss uses it |

Nothing shipped was migrated and nothing needs to be: a boss that only has
`artwork` behaves exactly as it did. Resolution, wherever a boss is shown:

```
the uploaded image, while it is set, active and its file is readable
→ the shipped path
→ no picture (a text/embed-only announcement)
```

So an upload *overrides* the shipped file and the shipped path stays behind it
as the fallback; **Clear uploaded artwork** goes back to it.

**Storage.** An upload is a managed artwork asset in the `boss_art` category:
the row is in `artwork_assets` (its audit trail in `artwork_asset_events`),
and the bytes are in `MANAGED_ASSETS_DIR` under a server-generated key
(`boss_art/<asset id>/<sha256>.webp`). See
[Storage, Docker and backups](#storage-docker-and-backups). Asset ids belong to one environment —
an export carries `artworkAssetId`, and a server that does not have that asset
refuses the boss at that field. Clear it (or keep a shipped `artwork` path)
for bosses that travel between environments.

**Uploads.** WebP, PNG or JPEG, up to 8 MiB and 4096 px per edge, validated
from the bytes by the shared `inspectImage` (signature, decode, dimensions; no
SVG, GIF or animation). The client's file name and `Content-Type` are never
trusted; the name is reduced to a label. Boss uploads are additionally
**normalised**: stored as WebP, scaled down to at most 2048 px on the longest
edge (`BOSS_ARTWORK_MAX_EDGE`). A WebP already within that is stored untouched.

**The editor's Artwork section** shows what players will see (a preview, and
the path or the upload's name and id), the shipped-file picker, **Upload new
artwork**, **Clear uploaded artwork**, and the **artwork library**: every
upload and every shipped file with the bosses that use it. Choosing or
uploading changes the form only — the boss changes when it is saved. With
`bosses.read` alone the section and the library are visible and nothing in
them can be changed.

**Safe deletion.** An upload cannot be deleted while a boss names it, or while
an encounter still open froze it: `409 ARTWORK_ASSET_IN_USE` with the
references, and the library disables Delete and names the bosses. Reassign
those bosses first. Deleting removes the file and keeps the row and its
history. Shipped files are never deleted from the Portal.

**In Discord.** `resolveBossArtwork` reads the encounter's frozen references
at every render (announcement, participant-count edits, completion, results):
the upload's bytes are attached as `boss-<id>.webp`, else the shipped file as
before. Replacing or disabling an asset reaches an open encounter's next
render; reassigning the boss does not — the encounter keeps the image it
froze.

| Method | Path | Permission | |
| --- | --- | --- | --- |
| GET | `/admin/bosses/artwork?path=` | `bosses.read` | bytes of a shipped file (unchanged) |
| GET | `/admin/bosses/artwork/library` | `bosses.read` | shipped files and uploads with their users, and the upload limits |
| GET | `/admin/bosses/artwork/assets/:assetId` | `bosses.read` | one upload: metadata, users, references, history |
| GET | `/admin/bosses/artwork/assets/:assetId/file?v=` | `bosses.read` | the bytes |
| POST | `/admin/bosses/artwork/assets?filename=&name=` | `bosses.write` | upload — the body is the image |
| DELETE | `/admin/bosses/artwork/assets/:assetId` | `bosses.write` | 409 while in use |
| PUT | `/admin/bosses/:id` | `bosses.write` | a boss save carries `artwork` and `artworkAssetId` |

These routes reach `boss_art` assets only. `reference.managedArtwork` tells
the editor whether the server has a managed artwork store at all.

### Storage, Docker and backups

| Setting | Docker (compose) | Outside Docker (default) | |
| --- | --- | --- | --- |
| `MANAGED_ASSETS_DIR` | `/data/waifumon-assets` — named volume `waifumon-managed-assets`, mounted into `waifumon-bot` | `~/.waifumon/managed-assets` | **Stateful. Persistent. Back it up.** |

Only `waifumon-bot` reads or writes uploads: it runs both the Discord client
(which attaches the image) and the Platform API (which stores and serves it).
The Portal container is Nginx and proxies to that API; it needs no mount. The
`waifumon-card-cache-init` one-shot chowns the volume to
`WAIFUMON_UID:WAIFUMON_GID` before the bot starts, as it does the card cache,
and the bot logs `artwork-assets/storage` (or `…/storage-unwritable`) at
startup.

Because it is a named volume, uploads survive a container restart, an image
rebuild (`docker compose up --build`), a deploy, and `docker compose down`.
`docker compose down -v` or `docker volume rm` **destroys them** while the
database still references them. The directory must never be inside the Git
checkout.

**Backups.** Uploads are application data and must be backed up and restored
**together** with the database — the rows describe the files.

```sh
# the database
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > waifumon.sql
# the uploads (the volume's full name carries the compose project prefix; `docker volume ls` shows it)
docker run --rm -v waifumon_waifumon-managed-assets:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/waifumon-managed-assets.tgz -C /data .
```

**Restore**, with the bot stopped (`docker compose stop waifumon-bot`):

```sh
docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" < waifumon.sql
docker run --rm -v waifumon_waifumon-managed-assets:/data -v "$PWD":/backup alpine \
  sh -c 'cd /data && tar xzf /backup/waifumon-managed-assets.tgz'
docker compose up -d waifumon-card-cache-init waifumon-bot
```

A database restored without its artwork volume is safe but bare: every boss
with an upload falls back to its shipped file (or to text), the bot logs
`artwork-assets/missing-file` per asset it tries to read, and the library
tile reads "File missing". Upload the image again and select it.

Each environment (production, staging) has its own database and its own
volume; one environment's backup must never be restored over the other.

## Migration history: two lines that must converge

Boss Management and boss artwork exist on two branches with **different
migration histories**. `Assteroid` is production; `Delve` is staging and
carries Equipment, Reward Tables, Dungeons and Enemies, which production does
not have yet. The same schema was therefore shipped twice, under different
numbers:

| What | Assteroid (production) | Delve (staging) |
| --- | --- | --- |
| Boss definitions | `0045_boss_definitions` — `when` 1819620000000 | `0057_boss_definitions` — 1820700000000 |
| Managed artwork tables | `0046_boss_artwork_assets` — 1819640000000 | `0054_artwork_assets` — 1820440800000 (also creates `combat_enemy_artwork`) |
| Boss artwork columns, `boss_art` category | the same `0046_boss_artwork_assets` | `0058_boss_artwork_assets` — 1820786400000 |
| First migration only Delve has | — | `0045_equipment_foundation` — 1819663200000 |

**A migration's number says nothing about what it is.** Assteroid's `0045` and
`0046` are not Delve's `0045` (`equipment_foundation`) and `0046`
(`equipment_rolled_instances`). A migration is identified by its **tag** (the
file name) and ordered by its journal **`when`**, never by its number.

Why the timestamps are what they are: drizzle's migrator reads the newest
applied migration's `when` once, then applies every journal entry whose `when`
is greater. Both Assteroid backports were given a `when` *after* production's
last migration and *before* Delve's first own one, so on production every Delve
migration is still "newer" and still runs when Delve arrives. Had Delve's
`0054` / `0058` been copied to production under their own timestamps,
production would have treated Delve's `0045`–`0057` as already applied and
skipped them for good (measured on a throwaway database: 22 tables never
created).

When the branches are merged, all of this must hold:

1. **Keep every migration file from both branches.** Two files share the
   prefix `0045` and two share `0046`; they have different tags, so there is
   no file conflict and none may be dropped or renamed.
2. **Keep every `when` exactly as it is.** Do not renumber, re-timestamp or
   regenerate.
3. **Order `drizzle/meta/_journal.json` by `when`**, which puts Assteroid's
   `0045_boss_definitions` and `0046_boss_artwork_assets` directly after
   `0044_retire_teleporter_wreck` and before Delve's `0045_equipment_foundation`.
   `idx` is then simply the position.
4. **Leave the SQL idempotent.** Convergence relies on it: on production,
   Delve's `0054`, `0057` and `0058` find the tables, columns, foreign key
   (`boss_definitions_artwork_asset_id_artwork_assets_id_fk`), check constraint
   and index already there and change nothing, while `0054` still creates
   `combat_enemy_artwork`. On staging, the two Assteroid entries are older
   than what is applied and are skipped — the same objects already exist from
   `0054`, `0057` and `0058`.
5. **Take Delve's application code** for the managed artwork service, the
   artwork category list and the asset reference type: Assteroid's copies are
   the same code trimmed to bosses.

Verified on disposable databases, comparing every column, constraint and index
with a database that only ever knew Delve: production path (Assteroid →
`0046` → merged history), staging path (Delve at `0058` → merged history, a
no-op) and a fresh database on the merged history all end identical, with
existing rows intact. Re-run that check against the real merged journal before
the merge is deployed anywhere.

Until the merge, each environment runs its own branch: never deploy an
Assteroid-line build onto the staging database or a Delve-line build onto
production.

## Activity

**Boss Management → Activity** shows the selected server's active encounter
and recent history, straight from `boss_encounters`: boss, region, spawn and
expiry time, status, participant count, combined damage and how it ended.

**Spawn Now** spawns an Active boss through the normal spawn service — a real
encounter paid from its reward table, subject to the one-active-encounter rule.
Like `/waifumon-admin boss spawn` it is marked `forced` and leaves the shuffle
bag and the cooldown alone. A boss outside its schedule is refused
(`BOSS_SPAWN_REFUSED`, reason `outside_schedule`) unless the admin confirms an
explicit override; status, region and the reward table cannot be overridden.

**End Encounter** closes the active encounter exactly as
`/waifumon-admin boss end` does: everyone who committed is paid in full from
the encounter's reward table, and an encounter nobody joined is cancelled.

There is no control that edits a live encounter's numbers.

`/waifumon-admin boss spawn <boss>` with a boss named also spawns it outside
its schedule (naming it is the deliberate act); with no boss named it picks
among the bosses available right now. Spawns and ends made from Discord are
written to the same audit trail as the Portal's, marked `via: discord`.

### Running the scheduler and the API in separate processes

Nothing here assumes one process. A Spawn Now from an API process inserts a
`scheduled` encounter; the process that runs the scheduler announces it on
its next pass (within a minute), re-checking that it is still scheduled first.
An End Encounter resolves and pays in the API process, and the scheduler
process publishes the results. The response says which happened
(`announcement: requested | no_scheduler`).

## Diagnostics

A compact answer to "why isn't a boss spawning?", for the selected server:

- **Scheduler** — what *this process* has recorded about its own scheduler:
  whether it is armed, when the last pass started and completed, how long it
  took, how many guilds it covered, and the last pass-level error. The health
  verdict (`ok`, `stalled`, `failing`, `starting`, `stopped`) is derived only
  from those facts. If this API process runs no scheduler the section says so
  and reports no health at all.
- **Guild** — boss channel configured, paused, suspended (with the reason),
  when the cooldown ends, and how much of the shuffle bag is left.
- **Definitions** — how many are in the database, any shipped boss that has
  none (read from the database, so it is true whichever process ran the
  bootstrap), and what this process's last startup import reported.
- **Bosses** — every definition with exactly one verdict: `eligible`,
  `not_active` (Draft/Disabled), `other_region`, `outside_schedule` (with the
  next window) or `reward_table_unavailable` (with the reason). Eligible
  bosses are flagged when they are only waiting on the guild's cooldown.

## Export and import

**Export** returns every definition, schedules included:

```jsonc
{ "format": "waifumon-boss-definitions", "version": 1, "bosses": [ /* … */ ] }
```

**Import** is planned first, then applied. The plan lists each boss as
`create`, `conflict` (an existing boss that differs, with the fields that
differ), `unchanged` or `invalid`. Applying:

- inserts new ids;
- with `conflicts: "skip"`, leaves every existing boss untouched;
- with `conflicts: "overwrite"`, replaces the conflicting bosses — and only at
  the revisions the plan showed (`expectedRevisions`). A boss edited since
  makes the import stale and nothing is written.

A package with any invalid boss is refused whole.

The two import routes accept a body of up to 2 MiB
(`BOSS_IMPORT_BODY_LIMIT_BYTES`); every other boss route keeps the API's 64 KB
default. A whole-roster export is every boss's prose and schedule in one
document and outgrows 64 KB at a few dozen bosses, so an import must be able
to take back what an export produced. Over the limit is `413
PAYLOAD_TOO_LARGE` with `details.maxBytes`. The Portal's Nginx allows 3 MB on
`/api/v1/admin/bosses/import/` and 9 MB on `/api/v1/admin/bosses/artwork/` (its
default is 1 MB), so the API's own limits are the ones a caller meets. These
routes, and the artwork upload, check permission before the body is read.

A boss in a package that names managed artwork (`artworkAssetId`) is checked
like a save: an id this server does not have — another environment's, or a
deleted upload — makes that boss `invalid` with an issue at `artworkAssetId`.
Clear the field in the package (the shipped `artwork` path is kept) or upload
the image here and select it after importing.

## Audit trail

`boss_definition_events` is append-only: `bootstrap`, `create`, `update` (with
the changed fields), `status` (from → to), `duplicate`, `delete`, `import`,
`manual_spawn`, `schedule_override` and `manual_end`, each with the acting
admin's Discord id and a timestamp. The trail outlives a deleted boss. It is
shown per boss in the editor and is available at `GET /admin/bosses/events`.

Artwork is audited on both sides. Assigning, reassigning or clearing a boss's
upload is an `update` here with `artworkAssetId` among the changed fields, and
a `reference_added` / `reference_removed` row (entity `boss:<id>`) in the
asset's own trail, `artwork_asset_events` — which is also where an image's
`upload` and `delete` are recorded, with the admin's Discord id.

## Permissions

| Permission | Allows |
| --- | --- |
| `bosses.read` | The list, editor (read-only), schedule previews, export, the audit trail, Activity and Diagnostics. |
| `bosses.write` | Create, edit, lifecycle, duplicate, delete and import definitions — including assigning artwork — and upload or delete boss artwork. Reaches future encounters only. |
| `bosses.operate` | **Spawn Now** and **End Encounter** — the controls that act on a server's players immediately. |

`write` and `operate` are independent: neither implies the other, so being
able to spawn or end encounters does not allow uploading, deleting or
assigning artwork. The guild owner holds both.

Boss reward tables are content (`content/bossRewards.json`); no permission
here edits them.
