# Content Portability CP-4B — Complete Dungeon Deployment Bundles

Completion report — 2026-10-29

CP-4B only. Everything here is **uncommitted on `Delve`** for review. No subagents, commits, pushes, merges or deployments were used, and no staging or production system, database or asset was accessed.

## 1. Starting repository state

| | |
|---|---|
| Branch | `Delve` |
| HEAD | `1b6fcf51f727fa3ae5102b715a89fcbda6cc9492` ("Add comprehensive tests for ZIP archive handling") |
| CP-3 / CP-4A | Both present and committed in `1b6fcf51`: `enemyPackageService.ts`, migration `0075`, `dungeonImportLifecycle.test.ts`, both completion reports |
| Working tree | Not clean. It held the uncommitted Shared-pool Species Access UX work (projectmem #0167): 8 modified files and 7 untracked files. CP-4B edited none of them. |
| Latest migration | `0075_enemy_package_imports` |

The #0167 files left untouched are: `portal/src/api/adminDungeons.ts`, `portal/src/api/dungeonSpeciesTypes.ts`, `DungeonGraphView.tsx`, `DungeonSpeciesPoolsPanel.tsx`, `SpeciesAccessSheet.tsx`, `dungeonSpeciesModel.ts`, `src/api/routes/v1/admin/dungeons.ts`, `tests/integration/api/adminDungeons.test.ts`, and the untracked `SpeciesAccessReview*`, `dungeonSpeciesAccessReview*` and `shared-pool-species-access-ux-completion.md` files.

## 2. What was reused

CP-4B is a wrapper and an orchestrator. Every piece of content is still exported, validated and written by the system that already owns it.

| Concern | Reused as is | Small extension made for CP-4B |
|---|---|---|
| Dungeon definition, graph, events, puzzles, encounters, loot tables, species policies, reward evidence | Dungeon JSON package v1–v4 (`dungeonPackage.ts`) and its importer (`dungeonImportService.ts`): loot create/reuse/copy, encounter and species review, receipts, the CP-4A draft-only lifecycle | An opt-in `allowSceneSprites` flag on build/read (default unchanged). `planImportInTx` / `applyImportInTx` run the same plan and apply inside the bundle's transaction. A `DungeonBundleImportContext` lets the review see the bundle's dependencies. `isRepairableImportIssue` was extracted so preview and apply classify repair mode identically. |
| Dungeon export | `exportPackage` | Its body is now `buildExport`, shared with `exportBundleSource`. That function returns the revision's frozen sprite snapshot, inside the bundle's read-only transaction. |
| ZIP safety | CP-3 `zipArchive.ts` | None. Only bundle-specific limits and allow-lists are passed in. |
| Image identity, reuse and staging | CP-3 `artworkBundle.ts` (`createBundleAssetCollector`, `verifyBundleAsset`, `findReusableAsset`, staging, `insertStagedAssets`, `removeUnclaimedStagedFiles`) | None |
| Enemies with artwork | CP-3 `enemyPackageService` export collection, plan and write; `enemyPackage.ts` document validation | Exposed as `enemyPackages.bundle.{collect, plan, write}`. `readEnemyPackageDocuments` was split out of `parseEnemyPackage`; standalone issue paths and messages are unchanged. |
| Journal and crash recovery | CP-3 `enemy_package_imports` journal and its startup recovery | Generalised into `artworkAssets/package/importJournal.ts`. Rows now carry `kind` (migration 0076), and one recovery pass covers both importers. |
| Shared pools | `sharedPoolService` validation, revision check and audit | `applyImported(tx, …)`: the JSON pool import's rules, inside the caller's transaction |
| Scene Sprites | `sceneSpriteService` catalogue, audit and reference trail; `sceneSpriteSnapshot` | `applyImported(tx, …)`. It checks the asset row inside the transaction, because the bundle may have inserted that row in the same transaction. |
| Publication, validation, runs | Unchanged | — |

No new image pipeline, transaction framework or content registry was added.

## 3. Bundle format and limits

```text
cp4b_vault.<hash12>.bundle.zip
├── manifest.json            waifumon-dungeon-bundle v1, contentType "dungeon"
├── dungeon.json             the Dungeon JSON package (v1–v4), byte-for-byte what a JSON export writes
├── enemies/manifest.json    CP-3 enemy manifest (only if the dungeon fields enemies)
├── enemies/enemies.json     CP-3 waifumon-combat-enemies v1 document
├── pools.json               waifumon-dungeon-species-pools v1 (only for referenced shared pools)
└── artwork/asset-NNN.webp   one image per distinct (category, sha256)
```

The bundle is versioned separately from the JSON package. `dungeon.json` keeps its own version and meaning, and the JSON reader and JSON routes are unchanged.

### `manifest.json`

| Member | Contents |
|---|---|
| `source` | Diagnostics only: environment, dungeon key, origin (`draft` or `revision`), draft revision, published revision |
| `dungeonPackage` | The wrapped package's `schemaVersion`, `contentHash` and `packageHash`, all checked against `dungeon.json` |
| `artwork[]` | `{ ref, asset }`, one per artwork reference the dungeon makes, exactly `dungeonDependencies(definition).artwork` in order: cover, dungeon and room backgrounds, reachable event art. A managed reference's bytes must hash to its `contentHash` and use its category. A shipped reference is carried as `dungeon_zone` if it is only the cover, otherwise as `dungeon_background`. |
| `sceneSprites` | `evidence` (`catalogue` for a draft, `revision_snapshot` for a revision), the snapshot hash, and one definition per placed key (name, category, placement, mirror, layer, asset) |
| `enemies` / `sharedPools` | Present exactly when the dungeon needs them |
| `assets[]` | CP-3 `BundleAssetEntry`: `asset-NNN`, file, category, sha256, bytes, MIME type, width, height, name |
| `warnings[]` | Notes from the exporter, for example an enemy's uncarried fallback |

**Identity.** Dungeons, enemies, sprites and pools are identified by stable key. Images are identified by a package-local `asset-NNN` together with a declared and verified `(category, sha256)`. No source asset UUID, storage key, URL or host path appears anywhere. A test asserts this against every JSON member of a real export.

### Reading a bundle

`parseDungeonBundle` runs these checks, in this order, before the destination is consulted:

1. Archive safety, via CP-3's reader.
2. JSON members: strict UTF-8, size, depth and total-size limits.
3. The manifest schema.
4. `dungeon.json`, through the importer's own reader. That includes its nesting and node bounds, content, dependency, reward and v4 integrity hashes, and full definition validation. The Scene Sprite gate is lifted here only.
5. The manifest describes exactly what the dungeon references: artwork, placed sprites, fielded enemies and referenced pools.
6. The CP-3 enemy documents, validated by CP-3. Each enemy must match the hash recorded in `dungeon.json`.
7. Every archive entry is declared and used, and every declared file is present.
8. Every image is decoded once and checked against its declared hash, size, type and dimensions.

### Limits

Export and import share `DUNGEON_BUNDLE_LIMITS`.

| Limit | Value |
|---|---|
| Archive (compressed) | 64 MiB. This is also the route body limit. nginx allows `65m` on `/api/v1/admin/dungeons/import/bundle/`. |
| Expanded total | 96 MiB |
| Entries | 600 images plus the JSON members |
| Each image | 8 MiB, plus `inspectImage` checks: PNG, WebP or JPEG; edges 8–4096 px; pixel limit; full decode |
| Each JSON member | 2 MiB (`dungeon.json` matches the Dungeon JSON route's 2 MiB) |
| All JSON together | 6 MiB |
| Nesting | 64 for `dungeon.json` (the importer's own bound, plus its 200,000-node limit); 32 for the other members |
| Compression ratio | At most 100:1 |
| Enemies / Scene Sprites / shared pools | 250 / 200 / 100 |

**Refused archives:** path traversal, absolute or drive paths, backslashes, symlinks and other non-regular entries, duplicates (including case-insensitive ones), undeclared or missing files, hash, size, type or dimension mismatches, unsupported formats, corrupt or truncated ZIPs, ZIP64, encryption, comments and trailing data. An export that exceeds any limit is refused, never truncated. The archive is parsed back before it is returned, so this build never hands out a bundle its own importer would refuse.

## 4. Artwork and Scene Sprites

### Export

- **Managed reference.** The oldest active asset with exactly the named `(category, contentHash)` whose stored file reads back intact.
  - If none exists, the export is refused (`artwork_unavailable`). The refusal names where the image is used ("Room “Hall” background") and says what to do.
  - This includes the case where the image was *replaced* since it was chosen. Destination replacement history is never relied on: the editor chooses the image again and exports again.
- **Shipped reference.** The file under `ASSETS_DIR`. A missing file is refused (`artwork_unavailable`). An unsupported format such as GIF is refused (`unsupported_artwork`) with "Convert it to PNG, WebP or JPEG and choose it again". Nothing is re-encoded.
- **Enemies.** CP-3's rules: managed full art and sprite, plus every shipped file the enemy renders. A required file that is missing or unsupported refuses the export.
- **Scene Sprites, draft export.** The current catalogue definition and asset. An archived or missing sprite refuses the export.
- **Scene Sprites, revision export.** The revision's frozen `scene_sprite_snapshot`: asset id, recorded hash, placement, mirror and layer. The stored bytes must still hash to the frozen value.
  - A revision with placements but no usable snapshot is refused (`scene_sprite_snapshot_invalid`).
  - So is a frozen asset whose file no longer matches.
  - The current, mutable catalogue row is never read instead. Sprite `category` is catalogue grouping, not frozen visuals, so it is `null` for revision exports.

### Import binding, per image

1. **Reuse** an active asset of the same category with the exact bytes whose file is present (CP-3 `findReusableAsset`). Otherwise **create** one under a destination-generated id and storage key. One image used in several roles is created once.
2. **Managed dungeon references** resolve by `{category, contentHash}`. The managed lookup prefers the oldest exact active asset even when its file is missing. The review therefore refuses (`artwork_unverifiable`, blocking) when such an asset would win over the one the bundle binds.
3. **Shipped dungeon references.** If this server's own file at that path has the same bytes, nothing changes. Otherwise the draft is rewritten so that reference becomes the managed copy (`{kind:"managed", category, contentHash}`). The review lists this as "the bundled copy is used as managed artwork". Nothing is ever written into `assets/` or the Git checkout.
4. Existing assets are never written, re-categorised, disabled or deleted, and that includes failure cleanup.

### Scene Sprite decisions

| Here | Outcome | Decision |
|---|---|---|
| Missing | `create` | Created, not archived, with the destination-local asset |
| Same name, placement, mirror, layer and bytes; not archived | `identical` | Reused; nothing written |
| Anything differs (including archived here) | `conflict` | Required: **Keep** this server's sprite, **Copy** (a new key `…_imported` for this dungeon only; its instances are rewritten), or **Update** the shared sprite. Update warns, naming other dungeons that use it, that their drafts and next publications change. |

Every published revision keeps its own frozen visuals. Pinned assets stay protected by the existing guards, and an update writes a new revision of the sprite row only. Tests compare the frozen snapshot before and after both copy and update.

## 5. Enemy and shared-pool conflict policy

**Enemies follow CP-3 exactly.**

| Outcome | Behaviour |
|---|---|
| `create` | Arrives disabled |
| `update`, `conflict` | Needs **Update** (the bundled definition and artwork; the existing enabled state is kept) or **Keep** (the dungeon uses this server's enemy). A conflict also lists the dungeons and Combat Trials here that use the enemy. |
| `unchanged` | Nothing is written |
| `invalid` | Blocks the import |

- Fixed encounters, every weighted wave candidate and bosses are included, because bosses are ordinary waves.
- Unrelated enemies are never touched.
- The Dungeon JSON importer's own enemy step sees enemies that already exist and is told `use_existing`. It never creates enemies without artwork.

**Shared pools** are carried by stable key with name, description, entries, weights, conditions, Nothing outcomes and once-per-run flags.

| Here | Outcome | Decision |
|---|---|---|
| Missing | `create` | Created **disabled**, through the pool service's own validation. A pool naming a species this server lacks blocks the import. |
| Name, description and entries equal (enabled state ignored) | `identical` | Reused |
| Otherwise | `conflict` | Required: **Keep** (this server's body is used) or **Update** (the bundled body replaces it; the enabled state is kept). The review names every other dungeon here whose future runs change. |

- The review states which body will be used.
- Dungeon-local pool IDs and activity references are unchanged.
- The dungeon is reviewed against the pool body *as if enabled*, so content problems show now. Enabling stays separate, and publication still refuses a disabled pool (`species_pool_missing`). A test publishes only after enabling.
- Active runs keep their frozen pool bodies (existing `dependency_snapshot`).
- A pool import grants no acquisition permission.

**Loot tables** use the Dungeon JSON importer's create, reuse and copy decisions unchanged.

## 6. External prerequisites

These are never created or changed by a bundle. The review lists each one with its status here (available, missing or disabled):

- WaifuMon species, from named encounters and every pool body the dungeon may use;
- items (reward, event and capture items);
- equipment candidates;
- progression currencies;
- regions;
- legacy shared reward tables.

Dungeon-exclusive species carry a note that only the dungeon's own Species access, plus any central access, can grant them. A missing dungeon sprite or standard artwork is a warning, as it is at publication.

Whether a gap is fatal is decided by the importer's own validation, exactly as for JSON:

- missing species, items and capture items make the bundle **Incomplete** (a repair draft only);
- a missing species in a pool the bundle must create is **blocking**;
- different destination reward candidates show the existing equipment-change review.

Dungeon `speciesPolicies`, central `dungeonAccess`, Direct Rescue rules, the acquisition ledger and limits are unchanged and stay authoritative. Shared-pool membership grants nothing. A test captures a dungeon-exclusive species in B and then sees the per-player limit stop the next run's offer.

Equipment definitions and affix libraries (CP-1 and CP-2), species artwork and other Git-shipped content keep their existing release paths.

## 7. Import and publication lifecycle

CP-4A, unchanged: **importing writes the dungeon's draft only.**

- A new dungeon is created disabled and unpublished.
- An existing dungeon keeps its enabled flag and its published revision. New runs, active runs, frozen run snapshots and the published species policy stay on that revision until someone publishes.
- New enemies and new shared pools arrive disabled. Nothing is enabled or published by an import.

**Readiness** is reported by preview and stored with the result.

| Readiness | Meaning |
|---|---|
| `ready` | Complete |
| `needs_enabling` | Complete, but a shared pool the dungeon needs will be disabled |
| `incomplete` | Only repairable missing prerequisites remain. Import needs explicit `allowIncomplete`, and the draft cannot be published until repaired. |
| `blocked` | Bundle-level problems: artwork that cannot be verified, an invalid enemy, a pool that cannot be created, an invalid decision. Repair mode never bypasses these, or archive integrity, or acquisition rules. |

Unanswered decisions are listed in `decisionsRequired`, separately from readiness.

After import, the operator enables what `remainsDisabled` lists, opens the draft, validates and publishes with the existing tools.

## 8. Freshness, transactions, retries and recovery

**`planHash` is decision-independent.** It covers:

- the bundle hash;
- the Dungeon JSON plan as reviewed without decisions: the target draft revision, its published revision and enabled flag, loot rows, items, equipment, species and capture-item policy, enemy rows, legacy tables, currencies, regions and managed assets;
- CP-3's enemy plan hash;
- every image's reuse or create destination and lookup resolution;
- shipped file hashes;
- the carried sprites' rows, revisions, archive state and asset state, plus the full sprite key set;
- the carried pools' rows and revisions;
- pool species rows;
- the prerequisite statuses.

Preview can be re-run with decisions to show their effect; apply sends the decisions it chose. A change to any of these between preview and apply returns `409 DUNGEON_BUNDLE_STALE` with no writes. Tests cover a pool edit, a concurrent import and the CP-4A target-state cases.

**Apply order.** Files and database rows cannot commit together, so apply follows CP-3's journal order:

1. Parse and verify the whole archive. Replay an applied receipt for the same `requestId`. Run the shared recovery. Re-review (stale, undecided or blocked fails here, before any write).
2. Commit a journal row (`kind = dungeon_bundle`, `status = staged`, with the storage keys about to be written).
3. Write the new images under fresh ids.
4. Run one transaction:
   - take the locks every importer shares: dungeon key, then each enemy key, then CP-3's asset lock, the shared-pool lock and the Scene Sprite table lock;
   - re-review under lock and compare `planHash`;
   - insert the asset rows;
   - write enemies (CP-3), Scene Sprites, shared pools, then the draft through the Dungeon JSON importer (`dungeon_import_history` receipt, `imported` audit event);
   - mark the journal row `applied` with the result.

**Retries and failures:**

- **Same `requestId` after success:** the stored result is replayed (`replayed: true`) with no writes.
- **Same `requestId` with a different bundle, plan, decisions or actor:** `409 DUNGEON_BUNDLE_REQUEST_CONFLICT`.
- **Same `requestId` while still staged:** 409 with `inProgress: true`.
- **Caught failure:** the transaction rolls back, staged files that no asset row names are removed, and the journal row becomes `failed`. The same `requestId` may then be retried. Reused assets are never removed; a test checks their bytes after an injected failure.
- **Crash between steps 2 and 4:** the row stays `staged`. `recoverInterruptedImports` runs at startup (it never blocks boot) and before every enemy or bundle apply. It removes such files once the row is 10 minutes old and marks the row `abandoned`. The recovery is shared with CP-3; there is one mechanism.
- **Concurrent imports:** two different requests for the same new dungeon produce one apply and one `DUNGEON_BUNDLE_STALE`. Nothing is duplicated (tested).

## 9. API and Portal changes

### API

A new plugin, `src/api/routes/v1/admin/dungeonBundles.ts`. The Dungeon JSON routes are unchanged.

| Route | Permission | Notes |
|---|---|---|
| `POST /admin/dungeons/definitions/:key/export/bundle` | `dungeons.read` + `enemies.read` + `artwork.read` | Body `{}`, `{origin:"published"}` or `{revision:n}`. Returns `application/zip` with count headers. `422 DUNGEON_BUNDLE_EXPORT_REFUSED` (`reason`, `issues`). |
| `POST /admin/dungeons/import/bundle/preview` | `dungeons.write` | ZIP body, 64 MiB route limit, permission checked at `onRequest`. Optional `decisions`. Writes nothing. |
| `POST /admin/dungeons/import/bundle/apply` | `dungeons.write` + `enemies.write` + `artwork.write` | ZIP body plus query `expectedPlanHash`, `requestId` and `decisions` (base64url JSON, at most 6,000 characters) |

New error codes, mapped in `src/api/errors.ts`:

- `DUNGEON_BUNDLE_INVALID` (400)
- `DUNGEON_BUNDLE_EXPORT_REFUSED` (422)
- `DUNGEON_BUNDLE_REJECTED` (400)
- `DUNGEON_BUNDLE_STALE`, `DUNGEON_BUNDLE_DECISIONS_REQUIRED`, `DUNGEON_BUNDLE_REQUEST_CONFLICT` (all 409)

The actor always comes from the session. CSRF uses the existing hook. Upload limits are route-scoped; no global limit changed.

### Portal

- **Dungeons list.** **Import Dungeon** (Dungeon JSON) now sits beside **Import Complete Dungeon Bundle (ZIP)**. Each button's tooltip, and each panel's text, says what the format includes.
- **Bundle import panel** (`DungeonBundleImportPanel.tsx`):
  - shows the draft change, the current state and what stays live;
  - shows readiness and problems;
  - lists enemies, Scene Sprites and shared pools with outcome, differences, where they are used here, and a decision select;
  - reuses the existing loot-table review;
  - summarises artwork as "images to add / already here" and notes rebound shipped images;
  - lists required content on this server and what remains disabled after import;
  - puts warnings in a collapsible list, and ids and hashes under "Technical details" only;
  - requires **Review choices** before a changed choice can be imported, then confirmation, then **Import bundle**;
  - shows the result with **Open imported draft** and a link to Dungeon WaifuMon Pools when one stays disabled;
  - offers **Review again** after a stale refusal;
  - lists every problem when a bundle is invalid.

  Reviewing needs only `dungeons.write`. Importing also needs `enemies.write` and `artwork.write`, and the panel says so.
- **Editor → History & export.** The two formats are explained. New buttons export the draft, the published revision and each revision as a Complete Bundle; refusals list each issue. They appear only with `enemies.read` and `artwork.read`.
- `portal/src/api/adminDungeonBundles.ts` is the typed client. It uses `postData` and `postDownload` from `client.ts`, so the architecture boundary holds.

## 10. Migrations

- **`drizzle/0076_import_journal_kind.sql`** plus its journal entry. It adds `kind text NOT NULL DEFAULT 'enemy_package'` and a check (`enemy_package` or `dungeon_bundle`) to CP-3's `enemy_package_imports`. It is additive: existing rows become `enemy_package`, and no other table changes. `src/db/schema.ts` mirrors it.
- The migration was applied only to disposable test databases.
- No dungeon, revision, run, sprite, pool or asset schema changed. Sprite audit rows reuse the existing `created` and `updated` actions with `source: "dungeon_bundle_import"` in their details.

## 11. Tests and results

All runs used a disposable `postgres:16-alpine` Podman container (`cp4b-pg`, test-only `TEST_DATABASE_URL`). Every test file gets its own random database, and every environment has its own shipped, managed and cache roots.

### New suites

**`tests/integration/dungeonBundles.test.ts`: 25/25**, 3 of 3 consecutive runs (23/23 three times before the last two cases were added). It uses two isolated `createDungeonWorld` environments, A and B, each with its own Admin API server; every request goes over a real socket.

The primary scenario's dungeon in A has:

- two rooms and a flag-gated connection;
- a managed cover, a managed room background and a shipped room background;
- an event with shipped art;
- a text puzzle whose answer is `"0042"`;
- weighted combat waves with three new enemies, all with full art and sprites (one of them with shipped full art only);
- a boss;
- a loot-table chest paying waifubux, an item and equipment;
- a Scene Sprite on the room and on the chest;
- a shared pool of a dungeon-exclusive species, with its `speciesPolicies`.

The draft and the published revision are exported, then A's artwork root is renamed away and the bundle is imported into B. It checks:

1. Export carries every dependency, with no source ids, keys, URLs or paths.
2. The published export carries the frozen sprite visuals rather than the edited catalogue sprite.
3. Preview in B writes nothing and shows creates, rebound shipped images, available prerequisites, what remains disabled, and `needs_enabling`.
4. Apply creates a disabled, unpublished draft equal to A's (with shipped references rebound). Every managed reference resolves to a B-local asset with exact bytes. Enemies and the sprite use B-local ids. The pool is created disabled. Nothing is written into B's `assets/`.
5. Publication is refused until the pool is enabled. After enabling, publishing and enabling the dungeon, a run completes in B. The capture is recorded on the ledger, and the limit of 1 stops the next run's offer.
6. An identical reimport writes nothing (same assets, files, enemies, sprites and pools), and an exact retry replays.

**Published update in B.** An active run sits on revision 1. An updated bundle is imported, and revision 1 stays live:

- the run row is byte-identical;
- the policy is unchanged;
- new runs still get revision 1.

After an explicit publish, new runs get revision 2. The old run still restarts on revision 1.

**Further cases:**

- an enemy conflict used by another B dungeon (decision required; keep vs update with the enabled state kept);
- a shared-pool conflict naming the other dungeon (keep leaves the body unchanged);
- a Scene Sprite **copy** and a Scene Sprite **update**, each with the frozen snapshot unchanged;
- different reward candidates (disabled equipment);
- a stale review after a pool edit (409, no writes);
- an injected failure before commit (no rows, no files, reused bytes intact; the journal row is `failed`; the same request then succeeds);
- crash recovery of a staged orphan;
- concurrent imports (200 + 409, no duplicates);
- export refusals for a missing managed file, a frozen sprite file that is gone, and a revision with no snapshot;
- the Dungeon JSON gate still refusing sprites;
- seven hostile or malformed archives, each refused at preview and at apply with no writes;
- a species missing in B: blocked for a pool, incomplete for a named encounter (refused without repair mode, imported with it, publication refused);
- a v1 bundle with no enemies, sprites or pools;
- the permission matrix;
- a 413 for oversize bodies, all error codes mapped, and OpenAPI summaries, tags and shared error responses.

**`tests/unit/dungeons/dungeonBundle.test.ts`: 3/3.** Covers shipped-art category, rebinding and sprite re-keying.

**`portal/.../DungeonBundleImport.test.tsx`: 9/9.** Covers:

- both formats named on the list;
- the review in editor words, with no ids or hashes outside Technical details;
- required decisions, "Review choices", and apply sending exactly the reviewed decisions;
- the result link;
- stale handling with "Review again";
- repair-mode gating;
- an invalid bundle;
- the permission note;
- the editor's three bundle exports and refusal list, and that they are hidden without permission;
- decision encoding.

### Regression

**Refactor check** (before the new suites): CP-3 enemy packages, Dungeon JSON imports v1, v2, v3 and v4, CP-4A lifecycle, shared pools, Scene Sprites and the ZIP reader — **158/158**.

**Focused backend run** (80 files, 1,728 tests): every suite above plus API admin dungeons, sprites, artwork and enemies, the enemy catalogue, dungeon content, runs, owned species access, `tests/unit/dungeons`, `tests/unit/api` and `tests/unit/artworkAssets`. Result: **1,721 passed, 1 skipped, 6 failed.** All 6 reproduce identically on an isolated untouched-HEAD `1b6fcf51` worktree (6 failed, 165 passed across the same 5 files):

| Failure | Classification |
|---|---|
| `unit/api/errors` reflection sweep | Baseline: `EquipmentConfigInvalidError` throws on junk input before the sweep reaches the new classes. The CP-4B classes were checked separately with the same junk arguments and are mapped. |
| `unit/api/routes` ×2 | Baseline drift (scene-sprites, waifumon-pools, equipment, capture-items). The bundle routes are in the allow-list and do not appear in the diff. Their OpenAPI shape is asserted in the new suite. |
| `unit/dungeons/engineArchitecture` | Baseline #0025, with the same 4 offenders. The bundle code lives in `dungeons/bundle/`, outside the pure roots. |
| `api/adminEnemies` "editing a shipped enemy…" | Known baseline |
| `dungeonContent` table list | Baseline: predates migration 0074. 0076 adds no table. |

**Portal focused run** (`adminDungeons`, `adminEnemies`, `adminDungeonSpeciesPools`, `adminDungeonSceneSprites`, `src/api`, `src/__tests__`; 54 files): **518/521.**

| Failure | Classification |
|---|---|
| `architecture.test` | Baseline #0069: flags `adminArtworkAssets.ts` and `adminDungeons.ts`; `adminDungeonBundles.ts` is not flagged |
| `DungeonSpeciesPools` ×2 | Alone it is 9/10, with the known #0159 failure; the second failure was load-only |

### Typechecks and builds

| Check | Result |
|---|---|
| Backend `tsc --noEmit` | Exit 0 |
| Backend `npm run build` | Exit 0 |
| Portal `tsc --noEmit` | Exit 0 |
| Portal production build | Vite's `build()` with an empty `envDir`, into the scratchpad: OK. `npm run build` deliberately refuses while `portal/.env` exists, and that file was not touched. |
| `verify-bundle` on that output | OK, 170 files, no dev-only code |
| `git diff --check` | Clean |

**Not run:** the full root suite, Playwright specs, and nginx itself (its config is covered by the structural tests, including the new location).

## 12. Remaining limitations

- **Revisions do not freeze enemies or shared pools** (pre-existing design). A revision export carries the *current* catalogue enemies and pools, beside the revision's frozen sprite visuals and reward snapshot. Active runs keep their own frozen copies.
- **Ordinary managed artwork in runs is pinned by asset id, not bytes** (pre-existing; audit §7). Bundles never replace assets in place, so an import cannot change what a live run shows.
- **Stateless, in-memory flow.** Apply re-uploads the bundle (up to 64 MiB), and each request holds it in memory. Images are decoded once per preview and once per apply; export also parses its own output.
- **Decisions travel in the query string,** at most 6,000 base64url characters. That is far beyond any authored dungeon, but a dungeon with hundreds of conflicting tables would exceed it.
- **Disabled enemies still only warn at publication** (existing validation). The review lists them under "remains disabled" with `requiredForPublication: false`. Disabled shared pools block publication.
- **Where-used lists in the review** (sprite and pool references) are display-only, read outside the review transaction and not part of `planHash`.
- **No deletion or synchronisation.** Content removed from a dungeon in A is not removed from B's catalogues.
- **Shipped substitution is one-way,** as in CP-3. Once rebound to a managed copy, a later assets release does not undo it. The bytes are identical.
- **A sprite kept while archived here** fails validation. Choose Copy, or restore the sprite first.
- **Recovery delay.** A crashed import's request id stays "in progress" for up to 10 minutes.
- **Large exports** are subject to the proxy's default 60 s read timeout.
- **Unchanged policy questions.** The acquisition ledger's per-dungeon scope (#0144) is unchanged and still needs product sign-off.

## 13. Required staging deployment steps

1. **Run migration `0076`** at startup. It is additive, on `enemy_package_imports` only.
2. **Rebuild and restart both images together.** The bot/API image carries the service, routes, error mappings and shared recovery. The Portal image carries the new panel, export buttons and nginx's `65m` location. Without the Portal rebuild, nginx's `2m` Dungeon JSON limit refuses every bundle import.
3. **Raise the limit on any upstream proxy** in front of the Portal to request bodies of at least **64 MiB** on `/api/v1/admin/dungeons/import/bundle/*`. CP-3 already needs 48 MiB on `/api/v1/admin/enemies/import/*`. The repository cannot verify either.
4. **Mounts.** `MANAGED_ASSETS_DIR` is the persistent, writable volume, backed up with PostgreSQL. `ASSETS_DIR` stays read-only; bundles never write to it.
5. **Permissions:**
   - export: `dungeons.read` + `enemies.read` + `artwork.read`;
   - review: `dungeons.write`;
   - import: `dungeons.write` + `enemies.write` + `artwork.write`;
   - enabling and publishing: the existing `dungeons.write` / `dungeons.publish` and `enemies.write`.
6. **Rehearse first.** On staging, run one bundle export → import → enable → publish → run cycle against a copy of the production database before relying on it.

## 14. Staging-to-production dungeon deployment checklist

**Before exporting (staging):**

1. Deploy, through the normal Git content release, every species (including dungeon-exclusive ones and their artwork), item, equipment definition, currency, region and legacy reward table the dungeon needs. Also deploy equipment and affix changes through CP-1 and CP-2.
2. In staging, **validate** the dungeon. Publish it if you want to export the exact live revision.
3. Export from **Dungeons → (dungeon) → History & export**: **Export draft as Complete Bundle (ZIP)** or **Export published revision as Complete Bundle (ZIP)**. If it is refused, fix each listed item (re-choose replaced images, restore archived sprites, convert unsupported formats) and export again.

**Import (production):**

4. Open **Dungeons → Import Complete Dungeon Bundle (ZIP)** and choose the file.
5. Read the review:
   - **Draft change and current state.** An existing dungeon's published revision stays live.
   - **Required content on this server.** Everything should be available. If it is not, stop and deploy the content release; do not use repair mode for a deployment.
   - **Enemies, Scene Sprites, shared pools and loot tables.** For each difference choose Keep, Update or Copy. Prefer **Keep** or **Copy** when the review names other dungeons that use the item.
   - **Artwork.** Note any shipped images used as managed copies.
6. Press **Review choices**, check that readiness is **Complete** or **Complete — enable dependencies before publishing**, confirm, and press **Import bundle**. On **Review again**, something changed here: re-read the review before importing.

**After import (production):**

7. Enable each item under "Still disabled": shared pools in **Dungeon WaifuMon Pools**, new enemies in **Enemies**.
8. **Open imported draft**, run **Validate**, and fix any warnings you do not accept.
9. **Publish**. For a new dungeon, **enable** it. Existing runs keep their revision.
10. Start one run as a test player, then confirm with the Discord or Portal run view that the scene, enemy and sprite artwork show correctly.
11. Keep the bundle file with the release notes. Re-importing the same bundle later writes nothing.
