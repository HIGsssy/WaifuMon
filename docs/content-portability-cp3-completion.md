# Content Portability CP-3 — Standalone Enemy Catalogue packages with artwork

Completion report — 2026-10-29

CP-3 only. CP-2, CP-4A and CP-4B were not started. Everything here is **uncommitted on `Delve`** for review. No subagents, commits, pushes, merges or deployments. No production system, database or asset was accessed.

## 1. Starting repository state

| | |
|---|---|
| Branch | `Delve` |
| HEAD | `753dcde4c8f4d44743b03cbfa1facd7971de9d81` ("Add integration tests for Shared Pool Encounter and Equipment Portability"), which already contains CP-1 |
| Working tree | Clean: no modified, staged or untracked files, and no prior uncommitted work to preserve |
| Latest migration | `0074_dungeon_species_pools` |
| Managed artwork | `artwork_assets` rows in PostgreSQL; bytes under `MANAGED_ASSETS_DIR` (Compose volume `waifumon-managed-assets` → `/data/waifumon-assets`). Keys are `<category>/<uuid>/<sha256>.<ext>`, written through `ArtworkStorage` (write-then-rename, root-contained). |
| Shipped artwork | `ASSETS_DIR` (Compose bind `./assets:/app/assets:ro`, read-only). The shipped enemy art is `assets/combat/enemies/{alley_bruiser,scrapyard_drone,security_automaton}.webp`, 0.2–0.5 MB each. No shipped enemy sprites exist. |
| Image acceptance | `inspectImage`: still PNG, WebP or JPEG only; at most 8 MiB; edges 8–4096 px; signature plus full decode |

## 2. Audit findings, re-verified

The audit was written against `d7c871a3`. Each CP-3 finding was re-checked against the code at `753dcde4`:

| Audit finding | Status | Evidence |
|---|---|---|
| Enemies are standalone; no dungeon is required | **Confirmed** | `enemyService.create/update` have no dungeon dependency; references are only counted. |
| Export is JSON only, lists local UUIDs, and carries no bytes | **Confirmed** | `enemyService.export()` returns the `waifumon-combat-enemies` document plus `environmentLocal.managedArtwork` UUIDs. |
| No selected export and no enemy import route | **Confirmed** | `admin/enemies.ts` had only `GET /admin/enemies/export`. |
| `upload` creates a new UUID every time; no deduplication by hash | **Confirmed** | `artworkAssetService.upload` uses `randomUUID()` with no hash lookup. |
| No multi-enemy, cross-database and filesystem transaction; no receipts; no orphan recovery | **Confirmed** | Upload cleans up only on a caught error. |
| Shipped and managed are separate layers; managed wins and shipped is the fallback | **Confirmed** | `resolveEnemyVisual`. |
| Runs freeze enemy definitions and managed asset IDs at start and read bytes by ID | **Confirmed** | `dungeonRunService.buildSnapshot`, which writes `enemyArtwork` into `dependency_snapshot`. |
| Dungeon import can create missing enemies but cannot update them or move their art | **Confirmed** | It takes per-enemy advisory locks `dungeon_import:enemy:<key>`, which CP-3 now shares. |

## 3. Package format and limits

```text
enemies-selected-20261029-120000.zip
├── manifest.json     waifumon-enemy-package v1, content type "enemy_catalogue"
├── enemies.json      the existing waifumon-combat-enemies v1 document (the Git/JSON export shape)
└── artwork/
    ├── asset-001.webp
    └── asset-002.png
```

`manifest.json` contains:

- format and version;
- `contentType`, `exportedAt` and `scope` (`all` or `selected`);
- `source.environment`, used for diagnostics only;
- `enemies[]`, one per enemy in the same order as `enemies.json`. Each has two slots, `artwork` (full art) and `sprite`, and each slot is `{ managed: asset-id | null, shipped: { path, asset: asset-id | null } | null }`;
- `assets[]`, one entry per distinct `(category, sha256)`, with `{ id, file, category, sha256, bytes, mimeType, width, height, name }`;
- `warnings[]`, for anything the exporter noted but did not carry.

**Identity rules:**

- Enemies are identified by key.
- Artwork is identified by a package-local `asset-NNN` together with its declared and verified `(category, sha256)`.
- No source asset UUID, storage key, URL or host path appears anywhere. A test checks this against the raw JSON.
- The existing JSON export is unchanged, so it keeps its Git-promotion value.

**Limits.** Export and import use the same constants (`ENEMY_PACKAGE_LIMITS`), so anything that exports can also be imported:

| Limit | Value |
|---|---|
| Enemies per package | 250 |
| Images per package | 500 |
| Archive (compressed) | 48 MiB. This is also the route body limit; nginx allows 49m on `/api/v1/admin/enemies/import/` |
| Expanded total | 64 MiB |
| Each image | 8 MiB, plus `inspectImage` dimension and pixel limits |
| `manifest.json` / `enemies.json` | 2 MiB each, nesting depth at most 32 |
| Compression ratio (deflated entries) | at most 100:1 |

A full or selected export that exceeds any limit is refused with `422 ENEMY_EXPORT_REFUSED (too_large)`. It is never truncated.

**Archive security.** `src/modules/artworkAssets/package/zipArchive.ts` is a deliberately small reader and writer built on `node:zlib`. I did not add a dependency for untrusted-archive parsing. The reader refuses:

- multi-disk archives, ZIP64, encryption, archive comments, and data before or after the archive;
- compression methods other than STORE and DEFLATE;
- absolute paths, drive or stream names (`:`), backslashes, `.` or `..` segments, empty segments and control characters;
- non-ASCII names not flagged as UTF-8;
- duplicate names, including names that differ only in case;
- symlinks and any other non-regular Unix mode;
- unexpected files and directories (only `manifest.json`, `enemies.json`, `artwork/` and `artwork/<file>` are accepted);
- local headers that disagree with the central directory, and entries whose bytes overlap.

The checks run in a fixed order:

1. Sizes and compression ratios are checked from the declared values before anything is inflated, and inflation is capped at the declared size.
2. Overlap is checked before any inflation.
3. After inflation, the actual length and CRC-32 are verified.

The package parser then checks, collecting every issue:

- the manifest schema and that its bindings match `enemies.json`;
- that every archive entry is declared and every declared file is present;
- that no asset entry is unused, and that IDs, files and `(category, sha256)` are unique;
- that each file is at its canonical path;
- that each image's actual bytes pass `inspectImage` and match the declared sha256, size, MIME type and dimensions.

Nothing in the package is ever fetched or resolved from a URL. Nothing is extracted to disk.

## 4. Artwork identity and rebinding

**Export** (`enemyPackageService.exportPackage`), per enemy slot:

- **Managed override, active:** its bytes are read through `ArtworkAssetService.read`, re-inspected and checked against the recorded hash, then carried in the asset's own category. A missing or deleted asset, a missing stored file, or a hash mismatch refuses the export (`artwork_unavailable`), naming the enemy and slot.
- **Managed override, disabled:** not carried, with a warning. Here it already shows the shipped artwork instead, and the package reproduces that.
- **Shipped path that the enemy renders** (no active override): it must be readable under `ASSETS_DIR` and accepted by `inspectImage`. Otherwise the export is refused: `artwork_unavailable` if missing, `unsupported_artwork` for GIF or other formats. It is carried in the slot's category (`enemy_art` or `enemy_sprite`).
- **Shipped path behind an active override** (a fallback only): carried when possible. Otherwise it is a manifest warning, not a failure.
- Identical bytes in the same category are stored once.

**Import binding** (`artworkBundle.findReusableAsset` and `enemyPackageService.plan`), per slot:

1. **Reuse** an `active` destination asset of the **same category** with the exact sha256 whose stored file is present. The asset the slot already holds is preferred; otherwise the oldest qualifying asset is used, matching the existing `managedArtworkLookup` rule. Identical bytes in a different category are **not** reused (tested).
2. Otherwise **create** a new asset with a destination-generated UUID and storage key, through `insertManagedAssetRow`. `upload()` now uses this same function, so there is one way an asset row comes into being.
3. **Shipped slots:** if the destination's own file at the same path has the same bytes, nothing is created and the shipped file is used. If the file is missing or different, the packaged copy is bound as managed artwork in that slot. Nothing is ever written into `assets/` or the Git checkout. Rendering is unchanged, because the same bytes show through the existing managed-over-shipped precedence.
4. **Placement, scale and anchor** travel in the definition and are preserved. Full-art and sprite roles are preserved.

Existing assets are never written, re-categorised, disabled or deleted by an import, and that includes during failure cleanup. Active runs therefore keep the exact images they froze (tested with a real run, below).

## 5. Conflict classification and activation

| Outcome | Meaning | Applied? |
|---|---|---|
| `create` | The key does not exist here | Yes, **disabled**, whatever the package says |
| `update` | Exists here and differs (definition fields or artwork binding) | Only with an explicit **Update** decision; **Keep Existing** skips it |
| `conflict` | Like `update`, but this server's dungeons or Combat Trials already use the enemy; the preview lists where | Only with an explicit **Update** decision |
| `unchanged` | Same definition (with this server's enabled state) and the intended artwork already bound | Nothing is written |
| `invalid` | For example a reserved key on create, or duplicate tags | The whole package is refused |

- Existing enemies **keep their enabled state**. The preview shows every activation override (`new_enemies_start_disabled`, `existing_status_kept`).
- No import publishes a dungeon, changes Combat Trial availability or enables anything.
- Unrelated destination enemies are untouched: there is no delete and no synchronisation.
- Missing decisions return `409 ENEMY_IMPORT_DECISIONS_REQUIRED` with `details.keys`.
- The preview's `planHash` covers:
  - the package hash;
  - each target enemy's revision and enabled state;
  - each slot's resolved destination (reused asset ID, create, or shipped file).

  Apply re-plans under lock. Any difference returns `409 ENEMY_IMPORT_STALE` and nothing is applied.

## 6. Transactions, retries and recovery

Filesystem writes and PostgreSQL commits are not atomic together. The design does **not** claim otherwise. Instead it makes every interruption recoverable:

1. **Journal first.** An `enemy_package_imports` row (`status='staged'`, containing the storage keys of every file about to be written) is committed **before** any file is written. This is migration `0075`.
2. **Stage.** New assets' bytes are written under freshly generated UUIDs, so they can never collide with an existing asset's key.
3. **One transaction.** It takes:
   - the per-enemy advisory locks shared with the dungeon importer;
   - an `enemy_package_import:assets` lock, which serialises reuse-or-create decisions.

   Inside it, it re-plans with `FOR UPDATE` and compares the plan hash, inserts the asset rows and their `upload` events, writes each enemy through `enemyService.applyImported` (the same validation, revision bump and artwork reference trail as an edit), and sets the journal row to `applied` with its result.
4. **Caught failure.** Staged files that no `artwork_assets` row names are removed, and the row becomes `failed`. Files that some row names, including every reused asset, are never removed. The same request ID can be retried.
5. **Crash between steps 2 and 3.** The row stays `staged`. `recoverInterruptedImports()` runs at startup (best effort; it never blocks boot) and before every apply. It removes the staged files of any `staged` row older than **10 minutes** that no asset row names, and marks the row `abandoned`. The age threshold keeps it away from an import that is still running.
6. **Retries and concurrency:**
   - The same `requestId` after success replays the stored receipt (`replayed: true`).
   - The same `requestId` with a different package, plan, decisions or actor returns `409 ENEMY_IMPORT_REQUEST_CONFLICT`.
   - The same `requestId` while still staged returns 409 with `inProgress: true`.
   - Two different requests importing the same new package: one applies and the other is refused as stale. No duplicate asset or enemy results (tested).

## 7. API and Portal changes

**API** — a new plugin, `src/api/routes/v1/admin/enemyPackages.ts`. Ordinary enemy CRUD is unchanged.

| Route | Permission | Notes |
|---|---|---|
| `POST /admin/enemies/export/package` | `enemies.read` + `artwork.read` | Body `{scope:"all"}` or `{scope:"selected", keys}`. Returns `application/zip`. A POST, so a large selection never rides in a URL. 404 `ENEMY_EXPORT_KEYS_NOT_FOUND` (`missingKeys`); 422 `ENEMY_EXPORT_REFUSED` (`reason`, `issues`). |
| `POST /admin/enemies/import/preview` | `enemies.write` | ZIP body, 48 MiB route limit, permission checked at `onRequest` (before the body is read). Writes nothing. |
| `POST /admin/enemies/import/apply` | `enemies.write` + `artwork.write` | ZIP body plus query `expectedPlanHash`, `requestId`, `decisions` (one `u` or `s` per `decisionKeys` entry, in order; at most 250 characters, so it always fits in a URL). |

Session callers get CSRF through the existing global hook. The actor is recorded from the session, never from the body. The new error codes are mapped in `src/api/errors.ts`.

**Portal:**

- The **Enemies list** gets per-row selection checkboxes, **Export all with artwork**, **Export N selected with artwork** (only with `artwork.read`) and **Import package** (only with `enemies.write`). Refused exports list each enemy's problem. The existing JSON **Export** for Git is unchanged.
- The new **Import enemies** page (`/admin/enemies/import`, `enemies.write`) works like this:
  1. Choose a `.zip`; it is checked immediately.
  2. The page shows counts, then each enemy's outcome in plain words, changed fields, activation note, and where each image comes from ("new image added" / "uses an image this server already has" / "already on this server"). Shipped-substitution and fallback notes, and conflict uses ("Used here by The Hall…"), are shown too.
  3. Each changed enemy needs an Update or Keep Existing choice.
  4. **Apply Import** stays on screen throughout the review and says what still blocks it. Once every decision is made it opens a confirmation, then imports. A review with nothing to write still applies, so the decisions are recorded.
  5. The page shows the result, with links to each imported enemy, what was kept, and a link back to the Enemy Catalogue.
  6. If the preview went stale, the page offers **Check again**.

  Hashes and IDs are only under "Technical details". `requestId` is generated per preview and set of decisions, so retrying the same import never applies twice.
- A new `postDownload` helper in `portal/src/api/client.ts` handles binary downloads whose refusals arrive as JSON. Direct `apiClient` writes are allowed only in `client.ts`, per the architecture test.

## 8. Migrations

- **`drizzle/0075_enemy_package_imports.sql`** plus a journal entry. It creates the `enemy_package_imports` receipt and journal table (unique `request_id`, status check, `applied ⇔ result` check, and a partial index on stale `staged` rows).
- The Drizzle table is in `src/db/schema.ts`.
- The migration is additive and touches no existing table. It was applied only to disposable test databases.

## 9. Files changed

**New**

| File | What it is |
|---|---|
| `src/modules/artworkAssets/package/zipArchive.ts` | Bounded ZIP reader and writer |
| `src/modules/artworkAssets/package/artworkBundle.ts` | Asset entries, byte verification, export collector, reuse lookup, staging, insert, unclaimed-file cleanup |
| `src/modules/enemies/enemyPackage.ts` | Format, limits, manifest schema, parse/build |
| `src/modules/enemies/enemyPackageService.ts` | Export, preview/plan, apply, recovery |
| `src/api/routes/v1/admin/enemyPackages.ts` | The three routes |
| `drizzle/0075_enemy_package_imports.sql` | Migration |
| `portal/src/features/adminEnemies/EnemyImportPage.tsx` | Import page |
| `tests/unit/zipArchive.test.ts` | Archive-security unit tests |
| `tests/integration/enemyPackages.test.ts` | Two-environment integration suite |
| `portal/src/features/adminEnemies/__tests__/EnemyPackages.test.tsx` | Portal workflow tests |
| `docs/content-portability-cp3-completion.md` | This report |

**Modified**

| File | Change |
|---|---|
| `src/modules/artworkAssets/artworkAssetService.ts` | Extracted `insertManagedAssetRow`; `upload` uses it, with behaviour unchanged |
| `src/modules/enemies/enemyService.ts` | Added `applyImported` |
| `src/db/schema.ts` | `enemyPackageImports` table |
| `drizzle/meta/_journal.json` | Entry for 0075 |
| `src/shared/errors.ts` | 7 error classes, tolerant of junk constructor input |
| `src/api/errors.ts` | Status mappings for the new codes |
| `src/api/routes/v1/index.ts` | Registers the new plugin |
| `src/discord/types.ts` | `enemyPackages` service |
| `src/index.ts` | Wiring plus startup recovery |
| `portal/nginx.conf.template` | Location `/api/v1/admin/enemies/import/` at 49m |
| `portal/src/api/client.ts` | `postDownload` |
| `portal/src/api/adminEnemies.ts` | Package types and calls |
| `portal/src/app/router.tsx` | Import route, declared before `:key` |
| `portal/src/features/adminEnemies/EnemiesListPage.tsx` | Selection, export and import controls |
| `portal/src/__tests__/nginxHeaders.test.ts`, `portal/src/features/adminEnemies/__tests__/enemyRoutes.test.tsx`, `tests/unit/api/routes.test.ts` | Pin the new location, route and mutation verbs |

## 10. Tests and results

Disposable PostgreSQL 16 in Podman (`cp3-pg`, test-only `TEST_DATABASE_URL`). Each test file uses its own random database, and each environment uses its own temporary shipped and managed roots.

**Typechecks and builds:** backend `tsc --noEmit` exits 0, and `npm run build` succeeds. Portal `tsc --noEmit` exits 0, and `npm run build` succeeds.

**New suites**

- `tests/unit/zipArchive.test.ts`: **22/22**. Covers round trip and determinism, the 8 traversal, absolute, drive, backslash and control-name cases, duplicate and case-duplicate names, unexpected file and directory, non-UTF-8 name, symlink and FIFO modes, encryption, unknown method, archive and entry-count limits, per-entry and total expanded limits, deflate-ratio bomb, inflate-past-declared, CRC failure, local/central mismatch, overlapping-entry bomb, not-a-ZIP, trailing data, comment, ZIP64 and truncation.
- `tests/integration/enemyPackages.test.ts`: **29/29**, stable 3 of 3 repeated runs. It uses two isolated `createDungeonWorld` environments, each with a real listening API server; all requests go over a real socket with `fetch`.

  **Central scenario:** ten enemies with full art and transparent sprites are created in A; A's artwork root is renamed away; the package is imported into B, which has no dungeons. Results for the 15 required checks:

  1. All ten definitions are present.
  2. No dungeon reference exists or is needed.
  3. Full art and sprite are present for every enemy.
  4. Every image resolves through B-local IDs that differ from A's.
  5. Bytes match the exported sha256 values.
  6. Placement, scale and anchor are preserved.
  7. New enemies arrive disabled.
  8. An approved update keeps B's enabled state.
  9. The other nine enemies are byte-identical after one is updated.
  10. Reimport: 10 unchanged, with no new asset row or file and no revision change.
  11. A stale preview returns 409 and changes nothing.
  12. A conflict (enemy used by a published B dungeon) names the use and needs an explicit decision.
  13. A failure injected after every write leaves no definition, no new asset row and no staged file; the journal row is `failed`.
  14. A reused asset survives that failure byte-identical.
  15. A real active run keeps its row and sprite while a new run gets the imported version.

  **Also covered:**
  - export: empty selection (422), unknown keys (404), exact selection with duplicates collapsed, no source IDs or paths in the JSON, full-catalogue export, missing shipped file, unsupported GIF, and a deleted managed file;
  - package integrity: hash mismatch, missing image, undeclared extra file, non-image bytes with an honest hash, traversal entry, symlink, duplicate entry, deflate bomb, and a manifest that disagrees with the definitions;
  - artwork binding: same bytes in another category not reused, and a shipped file present on B used as is;
  - concurrency and retries: two concurrent applies (one 200, one 409 stale, exactly one asset), receipt replay, and request-ID conflict;
  - crash recovery: a stale journal's orphan file removed, a claimed file and a live import kept;
  - HTTP: an over-limit body gets a JSON 413 with nothing written; unauthenticated oversize gets 401; the permission matrix (player, enemies-only, reader, editor) and the CSRF refusal hold; the actor is recorded; all routes are documented in OpenAPI; all codes are mapped.
- `portal/.../EnemyPackages.test.tsx`: **7/7**. Covers selection export, refusal details, permission-gated controls, the review wording, required decisions in `decisionKeys` order, confirm and apply, the result, stale handling with **Check again**, unsafe-package issues, and invalid-entry refusal.

**Focused regression run.** Backend, 21 files: **438/444**. The 6 failures:

| Test | Classification |
|---|---|
| `unit/api/errors.test` reflection sweep | Baseline: `EquipmentConfigInvalidError` throws on junk input |
| `unit/api/routes.test` (2) | Baseline: dungeon `scene-sprites` / `waifumon-pools` / `capture-items` drift. The CP-3 routes were added to the allowlist and no longer appear in the diff. |
| `unit/dungeons/engineArchitecture` | Baseline #0025: exactly the same 4 offenders |
| `api/adminEnemies` "editing a shipped enemy marks it edited" | Known baseline failure on Delve, recorded in project memory |
| `dungeonPackageV4` "replacement disables publication…" | Failed once under the 21-file load, at a capture attempt after a run resumes; passed 3 of 3 alone. CP-3 does not touch the capture flow. |

These suites passed in full: enemy catalogue 22, artwork assets 29, boss artwork 46, artwork replacement 7, Scene Sprite catalogue 4, dungeon imports v1/v2/v3/v4 (16/22/8/17/29), and the artwork unit suites.

Portal focused run (`adminEnemies`, `src/__tests__`, `src/api`; 17 files): **168/169**. The one failure is #0069 baseline: `architecture.test` flags `adminArtworkAssets.ts` and `adminDungeons.ts`. `adminEnemies.ts` is not flagged.

No full-root comparison was run. nginx itself was not executed; its config is covered by the existing structural tests plus the new assertions.

## 11. Known limitations

- **Stateless two-step flow.** Apply re-uploads the package, up to 48 MiB. Preview and apply each decode every image once.
- **Bounded by memory.** The whole package is held in memory per request (at most 48 MiB compressed, 64 MiB expanded).
- **Narrow archive acceptance.** The reader accepts what this exporter writes, plus ordinary STORE/DEFLATE ZIPs. Archives with comments, ZIP64, self-extracting prefixes or encryption are refused. Re-zipping a package with an unusual tool may therefore be rejected.
- **Recovery delay.** An import interrupted by a crash leaves its request ID "in progress" until the row is older than 10 minutes. Recovery then runs at startup or before the next apply.
- **Disabled managed overrides are not carried.** The destination then shows the shipped fallback (as the source did) or nothing. A fallback-only shipped file that cannot be carried is reported, not blocking.
- **Shipped substitution is one-way.** Once a missing shipped file is bound as managed artwork, a later assets release that ships the same file does not unbind it. The bytes are identical, so rendering is unaffected.
- **Asset replacement history** (the old-hash aliases dungeons use) plays no part. Enemy slots bind by asset ID, and reuse needs the asset's current bytes.
- **No deletion.** Enemies are never deleted or disabled by import, so there is no synchronisation of removals.
- **Conflict means "used here now".** The check uses current references. There is no common-ancestor detection of edits made on both sides; every change to an existing enemy needs a decision anyway.
- **Large exports through nginx.** Export responses are not size-limited, but very large packages are bound by the default 60 s proxy read timeout. Current catalogues are far smaller.

## 12. Staging deployment prerequisites

1. **Migration `0075` runs at startup.** It is additive.
2. **Rebuild the bot image** for the routes, services and startup recovery, and **rebuild the Portal image** for nginx's 49m location and the new pages. Without the Portal rebuild, nginx's 1 MB default blocks every non-trivial import.
3. **Any proxy in front of the Portal** must allow request bodies of at least 48 MiB on `/api/v1/admin/enemies/import/*`. The repository cannot verify this.
4. **Mounts:**
   - `MANAGED_ASSETS_DIR` must be the persistent, writable `waifumon-managed-assets` volume, backed up together with PostgreSQL.
   - `ASSETS_DIR` stays read-only; imports never write to it.
5. **Permissions:**
   - export needs `enemies.read` + `artwork.read`;
   - preview needs `enemies.write`;
   - apply needs `enemies.write` + `artwork.write`.

   Grant them to the operators who will move content.
6. After importing, review the new enemies, which arrive disabled, and enable them with the existing enable action.

## 13. What CP-4 can reuse

CP-4 work is not started, and nothing in dungeon packages, versions or publication changed. These pieces are ready for it:

- **`zipArchive.ts`:** the reader with caller-supplied limits and name and directory allow-lists, plus a deterministic writer. A dungeon bundle only needs its own `maxEntryBytes` and `allowDirectory` callbacks.
- **`artworkBundle.ts`:** `BundleAssetEntrySchema` and `bundleEntryIssues` for manifest assets, `verifyBundleAsset` for byte checks, `createBundleAssetCollector` for export-side `(category, sha256)` deduplication, `findReusableAsset` (same category, active, file present, preferred current), and `planStagedAssets`, `writeStagedAssets`, `insertStagedAssets` and `removeUnclaimedStagedFiles` for staging, commit and cleanup. Dungeon backgrounds, event art and Scene Sprites can be carried as entries in their own categories. Dungeons that reference managed art by `{category, contentHash}` need no ID rebinding at all: a reused or created asset with those bytes satisfies the existing lookup.
- **Journal, then stage, then transaction, then recover:** the pattern in `enemyPackageService.apply` and `recoverInterruptedImports`. CP-4 would add its own receipt table, as CP-3 did, rather than share `enemy_package_imports`.
- **`enemyPackageService` plan and apply for embedded enemies:** a dungeon bundle can embed an enemy package's manifest slots and call the same planning, or `enemyService.applyImported` directly, inside its own transaction. It must keep taking the shared `dungeon_import:enemy:<key>` locks.
- **`insertManagedAssetRow`:** the single row-creation path for any importer.
