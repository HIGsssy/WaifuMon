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
| Tables | `boss_definitions`, `boss_definition_events`, `boss_encounters.boss_snapshot` (migration `0057_boss_definitions.sql`) |
| Definition shape, bootstrap, runtime source | `src/modules/bosses/bossDefinitions.ts` |
| Availability schedules (pure) | `src/modules/bosses/bossSchedule.ts` |
| Authoring service | `src/modules/bosses/bossDefinitionService.ts` |
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

This is deliberately simpler than the reward-table and enemy seeds, which
keep following Git while a row is untouched. Bosses do not.

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

- identity — id, name, description, artwork path, status;
- regions the boss may appear in (today only `waifu-valley` hosts bosses);
- affinity (the only per-boss combat attribute);
- the boss reward table it pays from (edited in **Reward Tables**, not here);
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

An encounter freezes its boss at spawn: name, affinity, artwork, reward table
and reward snapshot (as before), and now also the four pieces of prose
(`boss_encounters.boss_snapshot`). Editing, disabling or rescheduling a boss
affects the **next** encounter only. Encounters spawned before migration 0057
have no prose snapshot and read the live definition, as they always did.

## Activity

**Boss Management → Activity** shows the selected server's active encounter
and recent history, straight from `boss_encounters`: boss, region, spawn and
expiry time, status, participant count, combined damage and how it ended.

**Spawn Now** spawns an Active boss through the normal spawn service — a real
encounter with its reward snapshot, subject to the one-active-encounter rule.
Like `/waifumon-admin boss spawn` it is marked `forced` and leaves the shuffle
bag and the cooldown alone. A boss outside its schedule is refused
(`BOSS_SPAWN_REFUSED`, reason `outside_schedule`) unless the admin confirms an
explicit override; status, region and the reward table cannot be overridden.

**End Encounter** closes the active encounter exactly as
`/waifumon-admin boss end` does: everyone who committed is paid in full from
the encounter's snapshot, and an encounter nobody joined is cancelled.

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

## Audit trail

`boss_definition_events` is append-only: `bootstrap`, `create`, `update` (with
the changed fields), `status` (from → to), `duplicate`, `delete`, `import`,
`manual_spawn`, `schedule_override` and `manual_end`, each with the acting
admin's Discord id and a timestamp. The trail outlives a deleted boss. It is
shown per boss in the editor and is available at `GET /admin/bosses/events`.

## Permissions

| Permission | Allows |
| --- | --- |
| `bosses.read` | The list, editor (read-only), schedule previews, export, the audit trail, Activity and Diagnostics. |
| `bosses.write` | Create, edit, lifecycle, duplicate, delete and import definitions. Reaches future encounters only. |
| `bosses.operate` | **Spawn Now** and **End Encounter** — the controls that act on a server's players immediately. |

`write` and `operate` are independent: neither implies the other. The guild
owner holds both.

Reward tables remain under `rewards.read` / `rewards.write`.
