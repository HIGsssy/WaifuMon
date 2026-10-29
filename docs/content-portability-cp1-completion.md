# Content Portability CP-1 — Equipment Catalogue export/import hardening

Completion report — 2026-10-29

CP-1 only. CP-2 (affix libraries and rarity rules), CP-3 (enemies and artwork) and CP-4 (dungeon bundles) were not started. Everything here is **uncommitted on `Delve`** for review. No subagents, commits, pushes, merges or deployments.

## 1. Starting repository state

- Branch: `Delve`
- HEAD: `ca57684fbdbfc94c07e58e3b9b12d5429be92f6f` ("UX cleanup for dungeonpools")
- `git status --short`: clean (no modified, staged or untracked files). The earlier session snapshot showed uncommitted artwork and `dungeon_exclusives.json` changes. Those were already committed at `ca57684f` when work began.
- The audit (`docs/content-portability-audit.md`) was written against `d7c871a3`. Every CP-1 finding was re-checked against `ca57684f` before any change was made.

## 2. Audit findings, re-verified

| # | Audit finding | Status at `ca57684f` | Evidence |
|---|---|---|---|
| 1 | A zero-match filter exports the whole catalogue | **Confirmed** | `equipmentCatalogueService.ts:794` turned zero matches into `keys: []`. `equipmentImportService.ts:263` treated `keys.length === 0` as "no restriction". |
| 1b | Unknown selected keys are silently omitted | **Confirmed** | The `inArray` query just returned fewer rows. Nothing compared them with the request. |
| 1c | `?keys=` (present but empty) means everything | **Confirmed** (not in the audit) | The route dropped an empty list and fell through to a full export. |
| 2 | Import routes inherit the 64 KiB body limit | **Confirmed** | `src/api/server.ts:52` sets 64 KiB, and the preview/apply routes set no `bodyLimit`. nginx had no equipment location, so the 1 MB default applied too. |
| 2b | A valid package can exceed both limits | **Confirmed by measurement** | The largest valid definition with plain-text fields is 2,638 bytes compact JSON. 1,000 of them are about 2.52 MiB. The 30-definition seed is 10,169 bytes (about 339 B per definition), so 64 KiB is reached at about 190 typical definitions. |
| 3 | No check for destination artwork | **Confirmed** | `artworkPath` is checked for shape only. Nothing looked for the file on the importing server. |
| 4 | Export does not enforce the parser's 1,000-definition ceiling | **Confirmed** | `buildEquipmentPackage` had no count or size check. |
| — | Disabled and N–LR definitions are exportable | **Confirmed** | A full export reads every row. This was preserved. |
| — | A hand-inserted EX row is exported but fails import | **Confirmed** | The DB check allows `EX`, but `EQUIPMENT_AUTHORING_RARITIES` does not. Such a row now produces a clear export refusal (§3.1). |

## 3. Implementation changes

### 3.1 Export scope (`equipmentImportService.ts`, `equipmentCatalogueService.ts`, route)

The lower-level exporter, `EquipmentPromotionService.exportPackage`:

- **`keys` omitted** exports every definition. This is the only path to a full export.
- **`keys` given** exports exactly those keys, deduplicated and sorted as before. An empty list gives an empty package. It never falls through to the unrestricted query.
- **Missing keys:** if any requested key has no row, it throws `EquipmentExportKeysNotFoundError` with the missing keys sorted, and nothing is exported. The HTTP response is `404 EQUIPMENT_EXPORT_KEYS_NOT_FOUND` with `details.missingKeys`.
- **Capacity:** if the package exceeds `EQUIPMENT_PACKAGE_MAX_DEFINITIONS` (1,000) or `EQUIPMENT_PACKAGE_MAX_BYTES` (4 MiB, compact UTF-8 JSON), it throws `EquipmentExportRefusedError('too_large')`. The response is `422 EQUIPMENT_EXPORT_REFUSED`, `details.reason: "too_large"`. The package is never truncated.
- **Self-check:** every package is run through `parseEquipmentPackage`, the importer's own parser, before it is returned. A stored row the importer would refuse (for example a hand-inserted EX row) produces `422 EQUIPMENT_EXPORT_REFUSED` with `reason: "unportable"`. `details.issues` names each problem by key, for example `cp1_ex_row.rarity`. Export can therefore never produce a file its own import rejects.

The Catalogue layer, `EquipmentCatalogueService.exportPackage`:

- With no `keys` and no `query`, it calls the full export.
- With `keys`, it exports exactly those; `keys` wins over `query`, as before.
- With `query`, it exports the filter's matches.
- If the resolved scope is empty, it throws `EquipmentExportRefusedError('empty')`, with the message "No equipment matches these filters…" or "No equipment was selected…".

The route `GET /admin/equipment/export` now treats a `keys` parameter as a selection even when it lists nothing, so `?keys=` and `?keys=%20,%20` are refused as empty. It also translates the new errors with structured `details`.

**Compatibility:** the package format stays `waifumon-equipment` v3 and is byte-for-byte unchanged. The request shapes are unchanged. Successful responses are unchanged. The only behaviour change is that some requests that used to return a misleading package now return a refusal.

### 3.2 Import request-size limits

- `EQUIPMENT_PACKAGE_MAX_BYTES = 4 MiB` (`equipmentPackage.ts`) is the export ceiling. It is measured as compact UTF-8 JSON, which is what the Portal sends; axios re-serialises the parsed file.
- `EQUIPMENT_IMPORT_BODY_LIMIT_BYTES = EQUIPMENT_PACKAGE_MAX_BYTES + 64 KiB` (`routes/v1/admin/equipment.ts`) is a route-scoped `bodyLimit` on `POST /admin/equipment/import/preview` and `/import/apply` only. The 64 KiB margin covers the `{ package, expectedPlanHash ≤ 200, sourceFilename ≤ 255 }` wrapper with a wide margin. The global 64 KiB limit is unchanged for every other route.
- Both routes now check permission at **`onRequest`** instead of `preValidation`. This is the existing encounter-import pattern: a caller without `equipment.write` is refused before any of the larger body is read. This is tested with an oversize unauthenticated request, which gets 401, not 413.
- `portal/nginx.conf.template` gets a new `location ^~ /api/v1/admin/equipment/import/` with `client_max_body_size 5m`. It is otherwise identical to the `/api` proxy. Setting it slightly above the API cap means callers see the API's JSON 413, which names the limit, rather than nginx's HTML page. The general `/api` location is unchanged.
- In the Portal, `EquipmentImportPage` raises its local pre-check on file size from 2,000,000 bytes to 8 MiB. Exported files are pretty-printed (about 1.2–1.5× the compact size), and the server enforces the real limit.
- Oversized requests get Fastify's existing structured 413 (`PAYLOAD_TOO_LARGE`, `details.maxBytes`) before any parsing, planning or transaction. Packages over 1,000 definitions that fit within the byte limit still get the existing `400 EQUIPMENT_INVALID` (`definitions: at most 1000…`). In both cases nothing is written.

**Why these sizes:** 4 MiB is about 1.6× the measured worst case for plain text, which leaves room for multi-byte names and descriptions. It is still a cheap `JSON.parse`, and it sits between the existing 2 MiB (dungeon, boss) and 8 MiB (encounter) import caps. Export and import use the same constant, so whatever exports successfully can be imported. A test pins this.

### 3.3 Artwork prerequisite visibility

- Equipment artwork **remains an external content-release prerequisite**. The definition format, `artworkPath` semantics and package contents are unchanged. No binary packaging or asset subsystem was added.
- `EquipmentCatalogueServiceDeps.artworkStatus?(path)` is a new optional dependency. `src/index.ts` wires it to the existing `locateArtworkFile(config.assetsDir, path).status`, which applies the same shape, containment and symlink checks the Discord resolver and admin artwork routes use.
- The import **preview** response gains `artwork: { checked, warnings: [{ key, artworkPath, status: 'missing' | 'unsafe' }] }`. It covers every package definition with an `artworkPath`, whatever its plan action, and looks up each distinct path once.
- The warnings **do not block anything**. They are not in `plan.issues`, they do not change `plan.ok`, and they are not part of `planHash`, so adding or removing a file between preview and apply does not make the preview stale. The test proves the hash is identical either way.
- `checked: false` means the service was built without a probe. Production always passes one; the existing test harness does not.
- The Portal import page shows an "Artwork not on this server" section listing key, path and reason, with a note that the import is not blocked.

## 4. Files modified

| File | Change |
|---|---|
| `src/modules/equipment/equipmentPackage.ts` | `EQUIPMENT_PACKAGE_MAX_BYTES`; pure `exportCapacityIssue()` |
| `src/modules/equipment/equipmentImportService.ts` | Explicit `keys` scope, missing-key report, capacity check and self-parse check in `exportPackage` |
| `src/modules/equipment/equipmentCatalogueService.ts` | Empty-scope refusal; `artworkStatus` dependency; `artwork` field on the preview |
| `src/shared/errors.ts` | `EquipmentExportKeysNotFoundError`, `EquipmentExportRefusedError` (constructors tolerate junk input) |
| `src/api/errors.ts` | Status mappings: `EQUIPMENT_EXPORT_KEYS_NOT_FOUND` 404, `EQUIPMENT_EXPORT_REFUSED` 422 |
| `src/api/routes/v1/admin/equipment.ts` | `EQUIPMENT_IMPORT_BODY_LIMIT_BYTES`; `onRequest` gate and `bodyLimit` on preview/apply; export scope and error details; `artwork` added to the preview schema |
| `src/index.ts` | Wires `artworkStatus` to `locateArtworkFile(config.assetsDir, …)` |
| `portal/nginx.conf.template` | `location ^~ /api/v1/admin/equipment/import/` with `client_max_body_size 5m` |
| `portal/src/api/adminEquipment.ts` | `ImportPreview.artwork`, `ImportArtworkWarning`; `ImportResult.plan` excludes `artwork` |
| `portal/src/features/adminEquipment/EquipmentImportPage.tsx` | Artwork warnings section; 8 MiB file pre-check |
| `tests/integration/api/adminEquipmentPortability.test.ts` | **New** — 19 A→B tests over two isolated databases (§6) |
| `tests/unit/equipmentPackage.test.ts` | Capacity and export-error unit tests (+4) |
| `portal/src/features/adminEquipment/__tests__/EquipmentCatalogue.test.tsx` | Fixture gains `artwork`; two artwork-warning tests |
| `portal/src/__tests__/nginxHeaders.test.ts` | Adds the new location to the pinned proxy list; new body-size assertion |
| `docs/content-portability-cp1-completion.md` | This report |

There are no migrations, schema changes, content changes or asset changes.

## 5. Safety guarantees preserved

Untouched code paths: `planEquipmentImport`, `applyCatalogueImportDefaults`, `importPlanHash`, `applyInTransaction` (locks, re-planning, stale/conflict errors, single transaction, import log and audit), definition CRUD, roll rules, rewards, crafting and dismantling, and high-rarity drop eligibility.

| Guarantee | Evidence |
|---|---|
| N/R/SR roll outcomes | `equipmentRollGolden` 62/62 (6,000 rolls on both the shipped and published-rules paths) |
| SSR/UR/LR rules | `equipmentHighRarity` 25/25; the A→B round trip compares every authoring field |
| Owned copies and rolled properties | New test: an owned SR's `player_equipment` row, loadout slots and equipment events are deep-equal before and after a name, description and range update |
| Definition IDs kept on update | New test: `id` unchanged and `revision` +1 |
| Slot/rarity locks for owned definitions | New test: a slot change on owned SR gear refuses the whole package, and the companion create is absent |
| Plan-hash and revision checks, atomicity | `adminEquipmentCatalogue` (stale, locked), `equipmentAtomicity` 5/5, `equipmentConcurrency` 7/7 |
| New definitions start disabled; destination enabled state kept | New test: B's enabled `combat_knife` stays enabled against a package that says disabled, and a new definition marked enabled arrives disabled |
| No destructive synchronisation | Import code unchanged; it never deletes |
| v2 import compatibility | `adminEquipmentCatalogue` "reads package v2"; `equipmentContent` (the v2 seed) 19/19 |

## 6. Tests run and results

Disposable PostgreSQL 16 in Podman (`cp1-pg`, test-only `TEST_DATABASE_URL`). Each test file creates its own random database. Production was never contacted.

**Backend typecheck and build:** `npx tsc --noEmit -p tsconfig.json` exits 0. `npm run build` succeeds.

**Focused backend run (13 files): 356 / 359 passed**

| Suite | Result |
|---|---|
| `tests/unit/equipmentRollGolden.test.ts` (6,000-roll gate) | 62 / 62 |
| `tests/integration/api/adminEquipmentPortability.test.ts` (**new**) | 19 / 19 |
| `tests/unit/equipmentPackage.test.ts` | 19 / 19 |
| `tests/integration/api/adminEquipmentCatalogue.test.ts` | 30 / 30 |
| `tests/integration/api/adminEquipmentManaged.test.ts` | 16 / 16 |
| `tests/integration/equipmentContent.test.ts` | 19 / 19 |
| `tests/integration/equipmentManagedRules.test.ts` | 26 / 26 |
| `tests/integration/equipmentHighRarity.test.ts` | 25 / 25 |
| `tests/integration/equipmentAtomicity.test.ts` | 5 / 5 |
| `tests/integration/equipmentConcurrency.test.ts` | 7 / 7 |
| `tests/integration/equipment3Foundations.test.ts` | 19 / 19 |
| `tests/unit/api/errors.test.ts` | 8 / 9 — **baseline** |
| `tests/unit/api/routes.test.ts` | 101 / 103 — **baseline** |

The three failures reproduce identically on an isolated `git archive` of untouched `ca57684f` (3 failed / 109 there too):

- `errors.test` "classifies every AppError subclass": the existing `EquipmentConfigInvalidError` throws on the sweep's junk arguments, so the sweep stops early. This is the same family as #0147. Because of this, the new codes are checked directly: the portability suite asserts that both codes are in `MAPPED_ERROR_CODES`, and the unit test confirms both new constructors tolerate junk input.
- `routes.test` mutation allowlist and missing summary: dungeon `scene-sprites` / `capture-items` routes. No equipment routes appear in the diff.

**What the new portability suite covers** (two isolated databases, A as source and B as destination, each with its own temporary assets root and its own listening API server):

1. A full export contains every row and all six N–LR rarities, disabled rows included, sorted by key.
2. A zero-match filter (`q`, `rarity`+`slot`), `?keys=` and `?keys=%20,%20` all return 422 `empty`. The lower-level `exportPackage({ keys: [] })` returns an empty package.
3. Unknown selected keys return 404 with `missingKeys` sorted, and nothing is exported.
4. A five-key selection (with a duplicate) returns exactly those five keys. Filters export only their matches.
5. Disabled SSR, UR and LR definitions go A→B through preview and apply. Authoring fields are equal, they arrive disabled, and re-exporting from B gives identical definitions.
6. **1,000 maximal definitions (more than 2 MiB of request body) preview and apply over a real TCP socket** with `fetch`: 1,000 creates, all disabled.
7. A body over the route limit returns a JSON 413 `PAYLOAD_TOO_LARGE` with `maxBytes` on both routes. 1,001 definitions return 400 at path `definitions`. Definition and import-log counts are unchanged in both cases. An unauthenticated oversize request gets 401 before the body is read.
8. Capacity alignment: the route limit is at least the export ceiling plus the wrapper, and 1,000 maximal definitions fit under the export ceiling. A full export from B (now holding more than 1,000 rows) returns 422 `too_large` and is never truncated. A smaller filtered export from B previews back into B as all unchanged.
9. Owned SR survives an update unchanged, keeps its ID and gets `revision` +1. A slot change on owned gear refuses the whole package.
10. Enabled-state protection holds in both directions.
11. Artwork: missing paths are warned about (two keys sharing one path both appear), present files are not, `ok` stays true, the plan hash is identical with and without the file, and apply succeeds. A hand-inserted EX row returns `unportable` with an issue keyed `cp1_ex_row.rarity`.

**Portal:** `npx tsc --noEmit` exits 0. `npm run build` succeeds. Focused vitest (`src/features/adminEquipment`, `src/__tests__`, `src/api`; 20 files): **216 / 217 passed**. The one failure is `architecture.test` "only explicit API helpers…", which flags `api/adminArtworkAssets.ts` and `api/adminDungeons.ts`. That is the existing #0069 baseline and involves no file touched here.

No full root suite was run, since the focused runs gave no reason to. nginx itself was not executed; the template is covered by the existing structural tests plus the new assertion.

## 7. Known limitations

- **Selected-export URL length.** Selected keys travel as `?keys=a,b,…`, bounded by the route's existing 10,000-character query limit and nginx's default 8 KB request-line buffer. That is roughly 120–150 long keys, or several hundred typical ones. Going over fails clearly (400 or 414), never as a silent partial export. A POST selection endpoint would lift this but is a larger API change, so it was left out.
- **Artwork checks look at existence only.** The check confirms that the file exists and is contained in the assets root. It does not check content, format or a checksum, and it does not compare against the source environment's bytes. That stays CP-3 territory.
- **The preview's freshness still does not pin the rules revision.** This is unchanged from the audit: apply re-validates the roll rules, but the plan hash does not include the rules revision.
- **Pathological byte sizes.** Definitions packed with multi-byte or escaped characters could, in theory, make a package of 1,000 or fewer definitions exceed 4 MiB. The export then refuses with `too_large` and asks for a smaller scope. It never writes a package that import would reject.
- **Repeat imports.** Importing an identical package again still writes an import-log row. This is existing behaviour, noted in the audit.

## 8. Deployment configuration changes

- **Portal image:** rebuild it so it picks up the new `portal/nginx.conf.template` location (`/api/v1/admin/equipment/import/`, 5m) and the updated import page. Without the rebuild, nginx's 1 MB default still blocks large imports even though the API accepts them.
- **Bot image:** rebuild it for the API route limits, export guards and artwork probe.
- **Anything in front of the Portal** (another reverse proxy, load balancer or CDN) must allow request bodies of at least 4 MiB + 64 KiB on `/api/v1/admin/equipment/import/*`. The repository cannot verify this.
- **Environment variables, migrations and volumes:** no changes. The artwork check reads the existing `ASSETS_DIR` mount, so deploy equipment artwork with the assets release **before** importing definitions that reference it, then confirm the preview shows no artwork warnings.
