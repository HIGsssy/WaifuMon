# Reward tables

Boss and expedition reward tables — what a boss pays its participants, and what
a mission pays on success, exceptional success or failure — are **live
database rows**, edited in **Portal → Admin — Reward Tables**.

The Git files are the shipped defaults:

| Kind | Shipped file | Referenced by |
| --- | --- | --- |
| `boss` | `content/bossRewards.json` | `content/bosses.json` → `rewardTable` |
| `expedition` | `content/expeditionRewards.json` | `content/expeditions/*.json` → `rewardTable`, `exceptionalRewardTable`, `failureRewardTable` |

Both kinds share one group and row shape (see
[`docs/boss-encounters.md`](boss-encounters.md#schema) for the fields). Item
rows name an item; Equipment rows name only a selector — optional slot,
optional N/R/SR rarity, optional list of definitions — and the Equipment system
rolls the instance's multiplier and affix.

## Why the database, not the files

Content files on a server are the host's Git working tree, bind-mounted into the
container. An edit made there is an uncommitted change: the next `git pull`
either refuses (when Git also changed the file) or quietly keeps the edit out of
Git forever. Neither is a safe place for live balance changes, so reward tables
moved to the database (migration `0047_reward_tables`), like World Encounters
and Equipment definitions before them.

## Startup seed

On every start the server reads both shipped files and, for each table:

| Database row | What happens |
| --- | --- |
| missing | inserted from the file |
| unchanged since it was last seeded | updated to the file if the file changed |
| edited in the Portal (or imported) | **left alone**; the divergence is logged (`reward-tables/diverged`, a warning when Git also changed that table) |
| edited, and the file now matches it exactly | adopted: counts as shipped again, and follows Git from then on |

The decision uses content hashes, not who saved last: `content_hash` is the
row as it stands, `seed_hash` is the shipped table last seeded into it. The
hash is over the *parsed* table, so reformatting a file or spelling out a
default is not a change, but reordering groups or rows is — order is part of
every deterministic draw.

A table that exists only in the database (created in the Portal or imported)
is never touched by the seed.

## Editing

The list shows each table's origin:

- **Shipped** — exactly what the file holds; Git changes reach it on deploy.
- **Edited — differs from Git** — a Portal edit; deploys will not overwrite it.
- **Portal only** — not in the shipped file.

Every save is validated on the server, in the saving transaction:

- the kind's schema (the same one the loader uses for the files);
- every item row names an item;
- every Equipment selector against the definitions **in this database** —
  a missing, disabled, slot- or rarity-mismatched, or SSR/UR definition, or a
  selector that matches nothing, is an error on an enabled row and a warning on
  a disabled one;
- the table id cannot change; a saved group's id cannot change either (it keys
  the deterministic draws).

The editor runs the same checks as you type and shows each problem on the row
it names. Each Equipment row also previews which definitions it can pay right
now, and each group summarises its chance, rolls and candidate count.

Disabling a table is always allowed — it is the emergency stop — and warns
which bosses will stop spawning or which missions cannot be deployed. A table
that content references, or that ships in Git, cannot be deleted.

### Concurrent edits

Every row has a `revision`. A save sends the revision it loaded; if someone
saved first, the server answers `409 REWARD_TABLE_STALE` with the current
revision and writes nothing. The editor then offers to reload.

### Reset to shipped

An edited table can be reset to the copy in this build's file. It then counts
as shipped again and follows Git on later deploys.

## When an edit takes effect

| | Effect of a save |
| --- | --- |
| Next boss spawn / next mission deploy | uses the edited table |
| A boss already announced, its participations, an unresolved or crash-retried payout | none — the boss snapshotted its table at spawn |
| A mission already deployed | none — the mission snapshotted its tables at deploy |

Both snapshots include the base definitions each Equipment entry could pay at
that moment, so a definition disabled afterwards is still paid to whoever was
promised it.

## Getting an edit into Git

**Export** on the list page downloads the live tables of one kind in the
shipped file format, in file order. Commit it over the shipped file. On the next
deploy every server whose row matches it adopts it as shipped.

## Moving tables between servers

**Import** takes an exported file. The server first shows a plan — which
tables would be created, changed, left unchanged, or are invalid — and records
the revision of each. Applying is all-or-nothing and refuses (409) if any of
those tables changed in between. Tables not in the file are left alone.

## API

All under `/api/v1/admin/reward-tables`; reads need `rewards.read`, writes
`rewards.write`.

| Method | Path | |
| --- | --- | --- |
| GET | `?kind=boss\|expedition` | list |
| GET | `/reference` | items and Equipment definitions for the editor |
| POST | `/equipment-preview` | eligible definitions per selector |
| GET | `/:kind/:id` | one table, its revision and current issues |
| POST | `/:kind/validate` | dry run |
| POST | `/:kind` | create |
| PUT | `/:kind/:id` | save (`expectedRevision`) |
| POST | `/:kind/:id/reset` | reset to shipped (`expectedRevision`) |
| DELETE | `/:kind/:id?expectedRevision=` | delete (unreferenced, not shipped) |
| GET | `/:kind/export` | the file format |
| POST | `/:kind/import/plan`, `/:kind/import/apply` | import (bodies up to 768 KiB) |
