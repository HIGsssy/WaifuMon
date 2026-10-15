# Phase 4D1 completion — Dungeon Encounter Package v4

Implemented on `Delve`, starting and ending at HEAD
`4799c61ca89439017c0c0ae36bced9fcbca22572`.
The starting working tree was clean. All work remains uncommitted: 15 modified
tracked files and eight new files, including this report. No commit, push,
merge, deployment, subagents, Region Pool administration or P4D2 work occurred.
No migration files or staging/production database changes were made.

## Envelope and dependency evidence

V4 extends the existing V3 package schema and uses the existing builder,
reader, inspector, importer, canonical JSON, conflicts and transactional
receipts. Definitions with any species-pool library, Wild Encounter or Rescue
export as V4. Other definitions keep their existing V1/V2/V3 selection.
The gameplay definition schema remains version 1.

V4 adds:

- `dependencies.requiredSpecies`: sorted unique species evidence with stable
  `slug`, export-time `rarity`, `enabled`, `regionExclusive`, `dungeonExclusive`,
  sorted `dungeonAccess`, and sorted unique `modes` (`capture`, `direct`).
- `dependencies.captureItems`: sorted unique slugs explicitly named in reachable
  capture activities' `allowedItems`.
- `dependenciesHash`: SHA-256 of canonical dependencies.
- `integrityHash`: SHA-256 of the entire canonical envelope, excluding only
  `integrityHash` itself. This binds definitions, dependencies, source metadata,
  editor layout, assets, bundles and reward evidence.

`contentHash` continues to mean the definition alone. Existing reward items,
Event `requiredItems`, equipment selectors, loot manifests and snapshot evidence
keep their meanings. Reward-free V4 packages have null reward evidence and empty
reward manifests. The reserved legacy `dependencies.species` stays empty.
No new portable reference contains a database ID.

The existing validator determines potentially reachable rooms and action
sequences. Only encounters that pass that reachability analysis contribute
species and explicit capture items. Only referenced pools contribute species;
unused libraries and unreachable activity definitions are retained intact in
`dungeon`. Dynamic conditions are not guessed away. Existing structural and live
validation still checks authored activities, including those outside the new
manifest's reachable set; portability does not relax authoring validation.

Species evidence is read at export from the current database rarity/enabled/tags
and a snapshot of loaded content access rules. It is distinct from publication's
existing audit-based species manifest. Export does not grant authorization or
bundle species/item definitions. Numbered/published export verifies the stored
definition hash even when an attempted corruption removes all encounter content.
Published rewards continue to use their existing frozen snapshot.

## Destination validation and repair

Read-only review loads current destination species and items. It reports:

- Missing/disabled species and unavailable dungeon/region-exclusive species.
- Direct-rescue authorization and required finite per-player limits.
- Rarity and availability/access policy drift, as warnings when live rules still
  permit the content. Rarity changes can independently cause a capture-item
  compatibility blocker.
- Missing, disabled, non-capture or incompatible explicit charms. Compatibility
  uses the existing capture eligibility function, destination rarity and each
  referring encounter's guaranteed-item rules.
- Existing reward and Event item dependencies and conflicts separately.

Destination `definition.key` controls access; source environment and exported
access evidence never authorize acquisition. No package creates or updates
species, global items, exclusivity, access entries, ownership or acquisition
limits. An encounter allowing all globally eligible charms does not enumerate
those charms in the package; the existing live usable-charm validation remains.

Valid imports create disabled, unpublished drafts. Replacement preserves the
existing conflict workflow and clears the destination's current publication,
without rewriting any immutable revision or active run. A supported dependency
blocker can be accepted only with explicit `allowMissingDependencies`; invalid
package structure, hashes, references and conflicts cannot use that escape hatch.
Imported pools and references are retained for repair.

Validation/publication rechecks current species policy and capture eligibility.
Explicit charm permissions also require each named item to exist, be enabled and
be compatible, so another working charm cannot mask a disabled or incompatible
entry. Diagnostics use indexed activity/item paths for editor repair. This is an
authoring/publication check; capture probability, economics, runtime filtering,
grants and acquisition enforcement were not changed.

Apply re-plans under existing catalogue/dungeon/receipt locks, additionally taking
a species-table SHARE lock. Its plan hash includes the captured species policy
and capture-item catalogue. Species enabled/rarity/tags, access or item changes
invalidate a reviewed plan. Loaded content configuration is not SQL-lockable;
imports remain disabled drafts and publication/acquisition revalidate live
policy. Existing receipt replay and atomic writes are reused.

Portal review shows named species/slugs, availability, export/target rarity,
policy changes, direct permission/limit and separate capture-item requirements.
It retains draft approval, warning acknowledgment, incomplete acceptance,
loot conflict previews, stale-plan review and receipt retry behavior.

## Integrity and compatibility evidence

V4 reading verifies both new hashes, independently reconstructs required species,
modes and explicit charms from content, and requires canonical duplicate-free
manifests and access arrays. Resealing an omitted/extra/duplicate/reordered manifest
cannot bypass actual-reference checks. Existing reward/Event integrity checks
remain in place. Invalid rules, broken pool references, unsupported versions and
Phase 4 content disguised as V1/V2/V3 are refused.

Hashes provide integrity, not source authentication: a party able to rewrite and
rehash a complete coherent package can forge export evidence. Destination policy
and independent reference checks remain authoritative regardless of that evidence.

Fixed-metadata legacy fixtures were independently generated from a read-only
archive of the untouched starting HEAD and compared using `cmp` with current
exports. Bytes and hashes match exactly; permanent golden tests pin:

| Version | Bytes | SHA-256 of serialized package |
| --- | ---: | --- |
| V1 | 1808 | `e89c726dd27131cf2632c147816df4fe19f6c76872c38675aa13f135e620a037` |
| V2 | 2818 | `43707b5b089c95a6db778e4df264d9de1a0f10dc3b350701c5509eded88ce90c` |
| V3 | 14479 | `1fd06eaf6f2eced7b17576689de79d744b86987e91359c586e002defe0551309` |

V1/V2/V3 schemas have no new serialization defaults. Their established import,
reward conflicts, Event requirements and snapshots pass regression coverage.

## Scene Sprites and cross-environment behavior

The independent Scene Sprite export/import gate remains. The builder and reader
refuse placements before choosing/accepting an encounter package version; the
content-service gate precedes encounter catalogue export. Portal export explains
that packages with managed Scene Sprite placements are unavailable until their
frozen dependencies can be bundled, and suggests exporting a copy without them.
No placements, sprite identities or artwork dependencies are silently removed.

A future sprite portability extension could bind stable sprite identities,
visual hashes and frozen artwork evidence in a versioned manifest, resolve those
against the destination and reuse atomic conflict review. It also needs explicit
rules for revision snapshots, artwork bytes/storage and missing visuals. That
extension was not implemented.

A real second PostgreSQL database exports a restricted-species package; the target
refuses complete import without its own authorization, permits an explicit repair
draft, and publishes after destination policy is repaired. Re-keying that package
requires authorization for the new destination key. Source policy is never copied.
Other real-database tests verify published species audit evidence, frozen pools,
active-run/revision isolation, failed-import rollback and concurrent exact retries.
The full gameplay lifecycle remains for P4D2.

## Exact verification

Backend commands ran with `TEST_DATABASE_URL` pointing exclusively at a disposable
local PostgreSQL 16 container. Each integration file creates/migrates its own test
database. The container is removed after verification.

```sh
npx vitest run tests/unit/dungeons tests/unit/api/dungeonImportPortalContract.test.ts \
  tests/integration/dungeonPackageV4.test.ts tests/integration/dungeonPackageV3.test.ts \
  tests/integration/dungeonImportV2.test.ts tests/integration/dungeonPackageV2.test.ts \
  tests/integration/dungeonImport.test.ts tests/integration/dungeonContent.test.ts \
  tests/integration/dungeonEncountersLive.test.ts tests/integration/dungeonEncountersDiscord.test.ts \
  --maxWorkers=2 --minWorkers=1 --exclude tests/unit/dungeons/engineArchitecture.test.ts
```

Result: **39 files passed, 847 tests passed, one skipped**. This broad run preceded
additional final audit cases; the final affected suites were checked separately:

```sh
npx vitest run tests/unit/dungeons/dungeonPackageV4.test.ts \
  tests/unit/dungeons/dungeonPackageLegacyBytes.test.ts \
  tests/integration/dungeonPackageV4.test.ts tests/integration/dungeonContent.test.ts \
  tests/integration/dungeonEncountersLive.test.ts --maxWorkers=2 --minWorkers=1
```

Result: **5 files passed, 142 tests passed**, including 27 V4 PostgreSQL cases.
A subsequent canonical inherited-manifest case increased V4 units from 39 to 40:

```sh
npx vitest run tests/unit/dungeons/dungeonPackageV4.test.ts \
  tests/unit/dungeons/dungeonPackageLegacyBytes.test.ts \
  tests/integration/api/adminDungeons.test.ts --maxWorkers=2 --minWorkers=1
```

Final result: **3 files passed, 117 tests passed** (40 V4 units, three legacy byte
fixtures, 74 API cases, including real V4 export/review/apply). The separate Scene
Sprite API suite passed **4/4** in the earlier 77-test API regression run.

From `portal/`:

```sh
npx vitest run src/features/adminDungeons --maxWorkers=2 --minWorkers=1
npx playwright test playwright/dungeonImport.spec.ts playwright/dungeonImportV4.spec.ts \
  playwright/dungeonEncounterAuthoring.spec.ts --workers=2
```

Results: **30 files / 284 tests passed**; **26 browser tests passed**, across desktop
and mobile, against the production preview. Browser APIs are stubbed; they verify
review and approval behavior, while database/API suites verify actual importing.

Other checks:

- Root `npm run typecheck`: exit 0 after final backend/test changes.
- Portal `npm run typecheck`: exit 0.
- `git diff --check`: exit 0.
- `podman build -f portal/Dockerfile -t waifumon-portal:p4d1 .`: exit 0, including
  production TypeScript/Vite build, environment guard and bundle verification.
  Final image ID: `48dd9fe1c5221852124367809baec9b8d5c308e1d8b4304675b91444fb7b57e9`.

Known baseline: the architecture test still fails one of its two assertions with
exactly four existing violations (importer's `node:fs`, `drizzle-orm`, direct schema
import; enemy store's `drizzle-orm`). It was reproduced against untouched HEAD in
`/tmp/waifumon-p4d1-head` and matches the working tree. No new violation was added.
The known V2 receipt-order flake did not recur. Initial new fixture/type/expectation
failures were corrected and rerun; no P4D1 failure remains. Ordinary existing
Vite CJS and PostgreSQL query deprecation notices appeared.

## Files changed

Backend:

- `src/modules/dungeons/package/dungeonPackage.ts`
- `src/modules/dungeons/package/dungeonEncounterDependencies.ts` (new)
- `src/modules/dungeons/package/dungeonEncounterImport.ts` (new)
- `src/modules/dungeons/package/dungeonImportService.ts`
- `src/modules/dungeons/package/dungeonLootImport.ts`
- `src/modules/dungeons/dungeonContentService.ts`
- `src/modules/dungeons/validation/dungeonEncounterValidation.ts`
- `src/modules/dungeons/validation/dungeonValidation.ts`

Portal:

- `portal/src/api/dungeonImportTypes.ts`
- `portal/src/features/adminDungeons/dungeonImportModel.ts`
- `portal/src/features/adminDungeons/DungeonImportPanel.tsx`
- `portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx`

Tests:

- `tests/unit/dungeons/dungeonPackageV4.test.ts` (new)
- `tests/unit/dungeons/dungeonPackageLegacyBytes.test.ts` (new)
- `tests/unit/dungeons/dungeonPackage.test.ts`
- `tests/unit/dungeons/dungeonEncounterGates.test.ts`
- `tests/unit/dungeons/dungeonEncounters.test.ts`
- `tests/integration/dungeonPackageV4.test.ts` (new)
- `tests/integration/dungeonEncountersLive.test.ts`
- `tests/integration/api/adminDungeons.test.ts`
- `portal/src/features/adminDungeons/__tests__/DungeonImportV4.test.tsx` (new)
- `portal/playwright/dungeonImportV4.spec.ts` (new)

Documentation: `docs/dungeons/phase4d1-completion.md` (new).
Project memory was updated exclusively through MCP logging tools.

## Remaining limits and P4D2 handoff

Scene Sprite portability remains gated. Shared species/items, policy and artwork
must be deployed or repaired separately. Import never grants dungeon access.
Catalogue-wide plan hashing conservatively invalidates V4 reviews on unrelated
catalogue changes too. The existing architecture baseline remains outside scope.

P4D2 can use the real cross-database fixture and V4 import helper as the basis for
an export → inspect → repair → publish → play lifecycle, verifying live capture
receipts, ownership limits and previously active revisions. P4D1 deliberately
stops at portability, validation, publication and isolation coverage.
