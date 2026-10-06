# Enemies

Combat enemies are shared content. One catalogue holds them; dungeons, Combat
Trials and anything built later reference an enemy **by key** and never own
its definition.

```text
Admin Enemy Catalogue  (/admin/enemies)
        ↓
Enemy definitions      (combat_enemies)
        ↓
Dungeons · Combat Trials · future systems reference them by key
```

## Where things live

| Concern | Location |
| --- | --- |
| Shipped defaults | `content/combat/enemies.json` |
| Definition shape and file schema | `src/modules/combat/enemyDefinitions.ts` |
| Table | `combat_enemies` (migration `0055_combat_enemies.sql`) |
| Seed, hashing, legacy artwork merge | `src/modules/enemies/enemyStore.ts` |
| Catalogue service (authoring and runtime) | `src/modules/enemies/enemyService.ts` |
| Usage lookup | `src/modules/enemies/enemyReferences.ts` |
| Admin API | `src/api/routes/v1/admin/enemies.ts` |
| Artwork precedence | `src/modules/artworkAssets/enemyArtworkService.ts` |
| Portal pages | `portal/src/features/adminEnemies/` |

## The catalogue

`combat_enemies` is authoritative. One row per enemy:

| Column | |
| --- | --- |
| `enemy_key` | The stable reference. Lower snake case, at most 64 characters, fixed at creation. |
| `name`, `description` | Display name; admin notes and flavour. |
| `enabled` | See [Disabling](#disabling-and-deleting). |
| `attack`, `defense`, `hp` | The numbers the combat engine fights with. |
| `tags` | Free labels (`boss`, `tier_2`, `internet_archetype`…). Tiers and classifications are tags; there is no separate rarity column. |
| `artwork_path`, `sprite_artwork_path` | Shipped image files under `assets/`. |
| `artwork_asset_id`, `sprite_asset_id` | Managed uploads. They win over the paths. |
| `sprite_placement` | Where the sprite stands in a composed scene. Null means the default. |
| `revision` | Goes up by one on every write. A save must name the revision it edited. |
| `content_hash`, `seed_hash` | See [Shipped and edited](#shipped-and-edited). |
| `position` | List order: the shipped file's order, then creation order. |
| `updated_at`, `updated_by` | The admin's Discord id, or `seed`. |

### Stats

- `attack` is at least 1. A 0-ATK enemy is refused: the only action is a basic
  attack and the minimum-damage rule would make it hit for 1 anyway.
- `defense` is at least 0.
- `hp` is at least 1.
- Each is at most 1,000,000. That ceiling catches typos. It is not a balance
  rule, and nothing else is: a strong boss is allowed.

## Shipped and edited

`content/combat/enemies.json` is the shipped default. At startup, and after a
content reload, `seedCombatEnemies` brings the table up to the file without
overwriting an admin's work. Per shipped enemy:

| State of the row | What the seed does |
| --- | --- |
| No row | Inserts it. |
| Untouched since its last seed (`content_hash = seed_hash`) | Updates it if the file changed. |
| Edited in the Portal (`content_hash ≠ seed_hash`) | Leaves it, and logs the divergence. |
| Edited, but now identical to the file | Adopts it as shipped again (`seed_hash` is set; nothing else changes). |

An enemy created in the Portal has no `seed_hash` and is never touched by the
seed. Removing an enemy from the file does not delete its row.

The Portal shows this as the enemy's **origin**: `shipped`, `edited` (a shipped
enemy changed here) or `custom` (created here).

**The hash covers the portable definition only**: key, name, description,
enabled, stats, tags, the two shipped paths and the placement. Managed artwork
ids are left out, because an id names an upload in one environment's store.
Two consequences:

- attaching an uploaded image to a shipped enemy does not make it `edited`,
  so it keeps following Git;
- a seed update never clears managed artwork.

Changing the placement *is* an edit. It is part of the file.

### Adding an enemy in Git

Add it to `enemies.json` and deploy. The seed runs before dungeon zones are
checked, so the enemy is a catalogue row, and selectable in the Dungeon
editor, as soon as the process is up. No reseed step, no cache to clear.

Before the catalogue existed the Dungeon editor read enemies from the content
snapshot loaded at process start, which is why a new enemy only appeared
after a restart.

### Startup log

| Tag | When |
| --- | --- |
| `combat-enemies/seed` | Enemies were inserted, updated from Git, or adopted. Lists the keys. |
| `combat-enemies/diverged` | An edited enemy was left alone. A warning when Git also changed it. |
| `combat-enemies/artwork-merged` | Legacy managed artwork was moved onto enemy rows. |
| `combat-enemies/artwork-orphaned` | Legacy artwork rows name enemies that do not exist. |
| `combat-enemies/seed-failed` | The seed threw. The rows are left as they were. |

Unchanged enemies are not logged. A file that does not validate stops the
content load, as it did before, with the field in the error.

## Authoring in the Portal

`/admin/enemies` is its own Admin area, with its own permissions:

| Permission | Allows |
| --- | --- |
| `enemies.read` | List, open, usage, validate, export. |
| `enemies.write` | Create, edit, enable/disable, duplicate, delete. |

Neither implies, or is implied by, `dungeons.*`. The Dungeon editor's enemy
pickers need only `dungeons.read`.

| Page | |
| --- | --- |
| `/admin/enemies` | The list: name, key, enabled, ATK / DEF / HP, tags, artwork and sprite thumbnails, usage count, origin. Search, enabled filter, tag filter. New, Duplicate, Disable, Export. |
| `/admin/enemies/new` | Name, key (derived from the name, editable until created), stats, enabled, tags. Opens the editor on success. |
| `/admin/enemies/:key` | The editor: Basics, Combat Stats, Artwork, Usage, Advanced. |

`/admin/dungeons/enemies` (the old Enemy Artwork page) redirects to
`/admin/enemies`.

**Create.** An enemy is made entirely in the Portal. No Git edit is needed.

**Duplicate.** A copy under a new key. It copies stats, tags and description,
and by default the artwork references and placement. The copy starts
**disabled** and is always `custom`, whatever the source was.

**Concurrency.** Every save sends `expectedRevision`. If someone else saved
first, the answer is `409 ENEMY_STALE` and nothing is written.

## Artwork

An enemy has two images, each optional:

| | Managed (uploaded in the Portal) | Shipped (Git) |
| --- | --- | --- |
| Full artwork | `artworkAssetId` | `artworkPath` |
| Transparent sprite | `spriteAssetId` | `spriteArtworkPath` |

The managed image wins while it is set. Clearing it falls back to the shipped
path, and to text when there is none. A managed asset that has been disabled
falls back the same way.

The enemy editor uploads, selects and clears both images in place, using the
managed asset system ([managed-artwork.md](managed-artwork.md)). The Artwork
Assets page stays the library and maintenance view.

**Placement** is one value on the enemy: `anchor`, `scaleBasisPoints`,
`offsetX`, `offsetY`. Null means bottom-right at 85% height. An authored room
may still override the sprite and its placement for that room only.

### The old overlay table

Managed enemy artwork used to live in `combat_enemy_artwork`, an overlay beside
the file-authored enemy. The enemy row owns it now. Migration 0055 adds
`merged_at` to the old table, and `mergeLegacyEnemyArtwork` runs at startup
after the seed:

- each unmerged row's asset ids fill the enemy's, where the enemy has none;
- its placement, if it set one, becomes the enemy's placement. The enemy then
  reads as `edited`, because its placement differs from the file;
- the row is stamped `merged_at` and kept. Nothing is deleted.

A row for an enemy that does not exist is left unstamped and logged. Nothing
writes `combat_enemy_artwork` any more, and the `/admin/dungeons/enemy-artwork`
routes are gone.

## Dungeons

**Dungeons reference the central Enemy Catalogue.** A zone's four enemy pools
and its authored fight rooms hold enemy keys. A zone owns membership, weights
and depth rules. It owns no stats.

The Dungeon editor is given the catalogue's own picker rows (key, name,
enabled, ATK / DEF / HP, tags, artwork) in `GET /admin/dungeons/reference`.
`GET /admin/enemies/reference` returns the same rows. Admins choose from a
searchable picker and never type a key. Stats are shown read-only, with a link
to the enemy.

There are no reusable enemy pools. Each dungeon lists its own members.

## Combat Trials

Trials stay shipped content (`content/combat/trials.json`) and name an enemy by
key. At runtime the Trial catalogue is joined to the Enemy Catalogue on every
call, so:

- the stats a fight uses are the ones last saved;
- a Trial whose enemy is missing is unavailable (`enemy_missing`);
- a Trial whose enemy is disabled is unavailable (`enemy_disabled`) and leaves
  the list;
- a recorded attempt stores the enemy's name and stats as they were. Editing
  the enemy later changes no stored result, and a replayed request returns the
  stored one.

The content loader still checks that each shipped Trial names an enemy in the
shipped file.

Trials draw the enemy's shipped `artworkPath` only. Managed enemy artwork is
not used on Trial screens yet.

## Disabling and deleting

Prefer disable. A disabled enemy keeps its row and every reference to it.

| Where | What disabling does |
| --- | --- |
| Pickers | Shown as disabled; cannot be chosen. |
| Saving a zone | Adding a disabled enemy is refused. A zone that already names it still saves, with a warning. |
| Procedural pools | The generator stops drawing it. The entry stays in the pool. |
| Authored rooms | The room keeps fighting it, with a warning, until an admin picks another enemy. A hand-placed room has nothing to fall back to, and disabling an enemy must not stop a dungeon from starting. |
| Combat Trials | A Trial that names it becomes unavailable. |
| Runs in progress | Nothing. See below. |

Re-enabling restores all of it. Nothing needs repairing.

Delete is refused with `409 ENEMY_IN_USE` when:

- a dungeon zone or a Combat Trial names the enemy (the references are in
  `details.references`); or
- this build ships the enemy, because the next seed would insert it again.

An unused enemy created in the Portal can be deleted.

### Usage

`enemyReferences.ts` answers "where is this enemy used?" for the editor, the
list's usage count and the delete guard. Each system contributes an
`EnemyReferenceSource`. Two exist: stored dungeon zones (pools and rooms) and
Combat Trials.

```text
Scrapheap Gauntlet
- combat pool
- boss pool

Combat Trial 2
- primary enemy
```

A new system adds its own source where the service is built (`src/index.ts`).

## Snapshots

A dungeon run reads the catalogue once, inside the transaction that starts it,
and stores what it read on the run:

- each placed enemy's key, name, stats and placement (`snapshot.enemies`);
- its managed artwork ids (`snapshot.enemyArtwork`);
- the scene choices made from the run's seed (`snapshot.scenes`).

```text
Run starts:   Alley Bruiser ATK 100
Admin edits:  ATK 120
Existing run: still ATK 100
New run:      ATK 120
```

Nothing the catalogue does later changes a run in progress: not an edit, not a
disable, not a delete. Regenerating a run's graph from its seed and snapshot
gives the same graph.

Artwork ids are logical references. Replacing the image behind an asset id
shows the new image in a run already in progress. The run's choice of which
asset, which background and where the sprite stands does not change.

## Export

`GET /admin/enemies/export` returns:

- `document`: a complete `waifumon-combat-enemies` file, valid as
  `content/combat/enemies.json`;
- `environmentLocal.managedArtwork`: the enemies that have uploaded artwork,
  and the asset ids, **listed beside the document and not in it**.

Committing the document is the import path. On the next deploy the seed
adopts matching rows as shipped. Managed artwork does not travel: upload and
attach it again in the other environment. There is no import endpoint and no
asset promotion between environments.

## Admin API

All under `/api/v1/admin`.

| | | Permission | |
| --- | --- | --- | --- |
| GET | `/enemies` | `enemies.read` | Every enemy, with usage count and origin. |
| GET | `/enemies/reference` | `enemies.read` | Picker rows. |
| GET | `/enemies/export` | `enemies.read` | The file, and the managed artwork it leaves out. |
| POST | `/enemies/validate` | `enemies.read` | `{ key, enemy, creating }` → issues. Writes nothing. |
| POST | `/enemies` | `enemies.write` | `{ key, enemy }`. `409 ENEMY_KEY_TAKEN`. |
| GET | `/enemies/:key` | `enemies.read` | One enemy, with references, issues and the shipped copy. |
| GET | `/enemies/:key/references` | `enemies.read` | Where it is used. |
| PUT | `/enemies/:key` | `enemies.write` | `{ enemy, expectedRevision }`. Artwork fields left out are kept. |
| PUT | `/enemies/:key/enabled` | `enemies.write` | `{ enabled, expectedRevision }`. |
| POST | `/enemies/:key/duplicate` | `enemies.write` | `{ key, name?, copyArtwork? }`. |
| DELETE | `/enemies/:key?expectedRevision=` | `enemies.write` | `409 ENEMY_IN_USE` when referenced or shipped. |

Errors use the shared envelope. `400 ENEMY_INVALID` carries
`details.issues` (`path`, `message`, `severity`). `409 ENEMY_STALE` carries
`expectedRevision`, `currentRevision`, `updatedBy` and `updatedAt`.

Player routes return none of the administrative fields. The combat systems
receive plain validated definitions from the service.

## Not built

Enemy abilities, behaviour trees, attack patterns, loot owned by enemies,
reusable enemy pools, level scaling, raid mechanics, resistances and status
effects. An enemy is a name, three stats, tags and artwork.
