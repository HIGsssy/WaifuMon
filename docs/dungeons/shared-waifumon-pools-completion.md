# Shared Dungeon WaifuMon Pool Management — completion

Date: 2026-10-29. Scope ends at shared Dungeon WaifuMon pools; Content Portability CP-1 through CP-4 remains unimplemented.

## 1. Repository state and files changed

- Branch: `Delve`, tracking `origin/Delve`.
- HEAD before and after implementation: `d7c871a3ee6b48331a2b3fa36a8b415a1bf4285e`.
- Initial working tree: only untracked `docs/content-portability-audit.md`. That audit was read and preserved without edits.
- Work remains uncommitted. No subagents, commits, pushes, merges or deployments were used.
- Additional unrelated artwork changes appeared during the session: modified `assets/npc/patches.webp` and untracked `assets/equipment/` and `assets/onboarding/`. They were preserved; they are outside this implementation's source changes.

Feature files:

| Area | Added or changed paths |
|---|---|
| Persistence | `drizzle/0074_dungeon_species_pools.sql`, `drizzle/meta/_journal.json`, `src/db/schema.ts` |
| Catalogue | `src/modules/dungeons/sharedPools/sharedPoolDefinition.ts`, `sharedPoolService.ts` |
| Dungeon schema and validation | `src/modules/dungeons/content/dungeonEncounters.ts`, `validation/dungeonValidation.ts`, `validation/dungeonEncounterValidation.ts` |
| Dungeon services and portability | `src/modules/dungeons/dungeonSpeciesPolicy.ts`, `dungeonContentService.ts`, `dungeonRunService.ts`, `package/dungeonEncounterImport.ts`, `package/dungeonImportService.ts` |
| API and composition | `src/api/routes/v1/admin/dungeonSpeciesPools.ts`, `admin/dungeons.ts`, `src/api/routes/v1/index.ts`, `src/discord/types.ts`, `src/index.ts` |
| Portal API and navigation | `portal/src/api/adminDungeonSpeciesPools.ts`, `adminDungeons.ts`, `portal/src/app/navigation.ts`, `router.tsx` |
| Catalogue UI | `portal/src/features/adminDungeonSpeciesPools/SharedPoolsPage.tsx`, `SharedPoolPicker.tsx` |
| Dungeon UI | `portal/src/features/adminDungeons/DungeonSpeciesPicker.tsx`, `DungeonSpeciesPoolsPanel.tsx`, `SpeciesPoolSheet.tsx`, `EncounterActivity.tsx` |
| Tests | `tests/integration/dungeonSharedPools.test.ts`, `tests/unit/dungeons/sharedPools.test.ts`, `tests/integration/api/adminDungeons.test.ts`, `portal/src/features/adminDungeonSpeciesPools/__tests__/SharedPoolsPage.test.tsx` |
| Report | This file |

## 2. Database and API changes

Migration **0074** adds two independent tables:

- `dungeon_species_pools`: stable `pool_key`, JSON definition, integer revision starting at 1, timestamps and last actor. JSON contains the enabled state.
- `dungeon_species_pool_events`: transactional audit history with actor, action, revision and the resulting definition. Actions cover create, update, duplicate, import, enable and disable.

No existing dungeon, revision, run, species, acquisition-ledger or regional-hunting table is rewritten. The migration journal remains monotonic. No bootstrap creates or converts pools.

The service validates stable keys, entry identities, species references, integer weights, duplicate species and entry IDs, and the presence of at least one species. Enabled pools cannot contain disabled species. It retains existing engine entry fields: conditions, once-per-run, weighted Nothing outcomes and Nothing text. Entry removal and pool-level disabling provide the supported availability controls; no new per-entry enabled mechanic is introduced.

Updates require the current integer revision; stale writes return `409 DUNGEON_DRAFT_STALE` with the current revision. Duplicate checks the source revision and creates a disabled copy under a new key. Identical current-revision saves are no-ops. Key collisions return `409 DUNGEON_KEY_TAKEN`. Validation errors return `400 DUNGEON_INVALID`; missing catalogue keys return 404.

All endpoints below are under `/api/v1/admin/dungeons/waifumon-pools`:

| Method/path | Purpose | Permission |
|---|---|---|
| `GET /` | List/search, including disabled pools | `dungeons.read` |
| `GET /:key` | Read definition/revision | `dungeons.read` |
| `POST /` | Create | `dungeons.write` |
| `PUT /:key` | Revision-checked update | `dungeons.write` |
| `POST /:key/enabled` | Revision-checked enable/disable | `dungeons.write` |
| `POST /:key/duplicate` | Revision-checked disabled copy | `dungeons.write` |
| `GET /:key/references` | Draft and current-publication references | `dungeons.read` |
| `GET /:key/history` | Audit history | `dungeons.read` |
| `GET /export[?key=...]` | All or one portable definition | `dungeons.read` |
| `POST /import` | Atomic additive JSON import | `dungeons.write` |

Permissions run at `onRequest`, before reading large bodies, using existing Portal sessions, CSRF checks and the existing explicitly enabled admin-bearer path. Actors come from the session. No authentication model or permission vocabulary was added. There is deliberately **no delete endpoint**, preventing accidental destruction or reuse of stable referenced identities; administrators disable pools instead. The audit FK also restricts deletion of pools with history.

## 3. Portal authoring workflow

Open **Admin — Dungeon WaifuMon Pools** at `/admin/dungeons/waifumon-pools`.

1. Search the catalogue by key, name or description; enabled status and revision are visible.
2. Create a pool with a stable key, name and description. New Portal-authored pools start disabled.
3. Add species with the existing searchable Dungeon species picker. It includes eligible dungeon-exclusive species without region assignments. Membership alone grants no acquisition permission.
4. Edit positive integer weights, once-per-run, weighted Nothing entries and optional text. Existing conditions can be edited as JSON; syntax errors block saving, and the backend validates their shape. Each referencing dungeon checks its own flag/room compatibility.
5. Save, then explicitly enable. Editing an enabled pool immediately affects future referencing runs. Disable and duplicate use the saved revision; duplicate creates a disabled copy.
6. Inspect **Where used**, linking to drafts and current publications. Read-only administrators can inspect and export but cannot author.
7. Download JSON, upload a JSON file or paste JSON. **Review import** lists destination revisions/new keys; **Apply reviewed import** performs the explicit replacement/create action.

The shared picker explains that each dungeon still supplies eligibility and acquisition terms. It does not use Region Pool rarity distributions or region assignment filters.

## 4. Dungeon Editor integration

The existing **WaifuMon Pools** panel retains **New WaifuMon pool** for local authoring and adds **Reference shared pool** with search and enabled/disabled indicators. The existing encounter pool selector labels each choice as dungeon-local or shared. The reference sheet links to catalogue management and permits selecting another enabled shared key.

The serialized reference retains the existing dungeon-local pool ID:

```json
{
  "id": "p",
  "name": "Shared encounter pool",
  "sharedPoolKey": "shared_encounters",
  "entries": []
}
```

Activities continue to reference `{ "kind": "pool", "poolId": "p" }`. `sharedPoolKey` is optional and absent from legacy local pools. Shared references **must** have empty entries; a hidden embedded fallback is rejected by the schema. No existing dungeon is converted automatically, and adding a shared reference preserves existing local pools.

Validation identifies missing or disabled shared keys at `speciesPools[i].sharedPoolKey`. With a live catalogue, the ordinary dungeon validator checks resolved entries, conditions, duplicate identities, species policy, capture-item compatibility and Direct Rescue rules. Publication and new-run start reject incompatible pools. Server probability analysis, encounter preview and sandbox resolve shared bodies while the authoring response retains the reference form.

## 5. Shared-pool resolution and run snapshots

The existing architecture already freezes mutable enemies and other dependencies in `dungeon_runs.dependency_snapshot`; no publication framework or run-table migration was needed.

- At run start, shared rows are read in stable key order under `FOR SHARE` in the run transaction. Missing, disabled or unreadable pools refuse the start before any daily allowance/run write is committed.
- Resolved entries are checked against that dungeon's current eligibility and authored conditions. The snapshot stores `sharedSpeciesPools`, keyed by catalogue key, with the selected catalogue revision and complete pool definition.
- Runtime receives a copied, resolved definition using the original local pool IDs. Neither the stored dungeon revision nor the catalogue body is mutated.
- Every reload, step and restart reconstructs membership from the **saved run snapshot**, never the mutable shared catalogue. A missing frozen body fails closed; it never reads a replacement from the catalogue.
- Pool edits/disabling change subsequent starts. They do not change saved run rows, create dungeon revisions, move published pointers or alter draft revisions.
- Old runs with embedded pools require no new snapshot field and keep their previous behavior.

The current publication species-evidence manifest and v4 `requiredSpecies` evidence continue to describe named/embedded species. Shared pools are an external stable-key dependency in this phase, with destination/live resolved validation and per-run frozen bodies; they are not claimed to be pinned inside a dungeon publication or bundled v4 species manifest.

## 6. Acquisition-policy compatibility

The pool catalogue only supplies encounter membership and relative weights. It contains no `speciesPolicies`, acquisition grants, rarity rules or region memberships.

Existing dungeon-owned `speciesPolicies`, loaded species-content `dungeonAccess`, enabled/exclusivity flags, Direct Rescue authorization and the stricter combined terms remain authoritative. Runtime offer/grant checks still consult the dungeon's **currently published** policies and the acquisition ledger. Counts remain per player, per species, per dungeon across runs. Policy tightening continues to reach active runs; frozen membership does not freeze or broaden acquisition permission.

Adding an unauthorized dungeon-exclusive species can make a referencing dungeon incompatible; it never adds a dungeon policy automatically. Region hunting remains separate, including its projection, seeding, rarity selection and exclusivity rules. No species, capture formula, player limit or content JSON was added or changed.

## 7. JSON import/export and future CP-4 compatibility

Pool packages use `format: "waifumon-dungeon-species-pools"`, `schemaVersion: 1`, and `pools`. They contain stable key, name, description, enabled status and complete engine entries. Database IDs, destination revisions, timestamps and audit/player history are excluded.

Imports validate the whole package and all species references transactionally. Duplicate keys and malformed/duplicate entries fail. The separately supplied `expectedRevisions` authorizes each changed destination key (`null` means create); omitted/mismatched revisions reject the transaction. Omitted pools remain untouched. Concurrent/exact identical retries return existing rows without new revisions/events. A failed multi-pool import leaves no partial pool creations.

New imported pools always start disabled; existing pools retain the destination enabled state. Explicit enabling remains a separate administrative choice. This is intentionally not a copy of source activation. Imports accept at most 200 pools and 2 MiB HTTP bodies. Export refuses more than 200 pools or more than 1.9 MB of JSON, leaving space for the import wrapper/revision map; use individual exports for larger catalogues. Empty backend packages are safe no-ops; the Portal requires a nonempty import for review.

Existing dungeon v1–v4 readers/exporters preserve `sharedPoolKey` in definition JSON and hash it normally. A missing/disabled destination shared key produces a dependency error; apply cannot substitute embedded entries. Successful pool transfer followed by explicit enabling and a fresh dungeon-import plan preserves the reference and creates an ordinary disabled, unpublished dungeon draft. Existing package activation/publication behavior remains intact. The import review hash binds **sorted referenced shared keys and their destination bodies**, so a relevant edit invalidates review while an unrelated pool edit does not.

For a future complete CP-4 bundle:

1. Collect referenced shared stable keys from `speciesPools[].sharedPoolKey`.
2. Include/declare their portable definitions and species dependencies with explicit reuse/update/copy decisions.
3. Resolve target catalogue identities by key, never by source database IDs or revision numbers.
4. Preserve local activity/pool IDs, install only approved pool changes and validate the dungeon against destination policy before publication.

This phase implements none of that full bundle machinery, artwork transport, generic registry or CP-1–CP-4 work. Until then, transfer pool JSON separately before planning the dungeon import. Scene Sprite package gates remain intact.

## 8. Tests and builds

PostgreSQL tests used a newly created disposable `postgres:16-alpine` Podman container exposed only on local port 55437, with random databases created by the existing test harness. No application/production database was used. Default Testcontainers could not discover a runtime in the sandbox; the explicitly test-only URL used the disposable container instead.

| Check | Result |
|---|---|
| Backend `npm run typecheck` | Pass |
| Backend `npm run build` | Pass |
| Portal `npm --prefix portal run typecheck` | Pass |
| Portal production `npm run build` and `verify:bundle` | Pass in an isolated copy excluding development `.env*`, using the normal environment guard; development configuration preserved |
| Initial shared-pool/API/policy/engine run | 162/163 passed; corrected the new limit-test assertion to inspect auto-resolved persisted encounter state |
| API `adminDungeons` including new pool auth/CRUD/import cases | 76/76 |
| Existing dungeon-owned species access | 17/17 |
| Existing encounter engine | 64/64 |
| Dungeon runs, v4 package, legacy import, legacy package bytes, Region Pool service, shared-pool tests | 106/106 across 7 files |
| Final shared pool + v4 package + pure pool checks | 38/38 |
| Final shared-pool cases after import/export hardening | 7/7, including concurrent safe retries, referenced dependency drift, unaffected unrelated changes and export capacity |
| New Portal catalogue/picker/dungeon-reference tests plus existing v4 import and encounter authoring | 22/22 |
| Existing Portal dungeon routes | 6/6 |
| Existing local-pool Portal suite | 9/10; same close/reopen failure at line 113 reproduced on untouched `d7c871a3` in an isolated `git archive` copy (projectmem #0159) |
| `git diff --check` | Pass |

The new integration coverage verifies two dungeons referencing one pool, edits reaching future runs, unchanged saved snapshots and dungeon revisions, restart after disable, local-pool compatibility, missing/disabled/incompatible dependencies, policy refusal and ledger limits, portable cross-database round trips, atomic conflict handling and unchanged regional-hunting rows. Existing focused acquisition/region suites provide adjacent regression coverage. No full-root comparison or full-root test run was launched.

## 9. Limitations and deployment dependencies

- Apply migration **0074** before running this backend, then build/restart the compatible backend and Portal. No migration was run against staging or production, and nothing was deployed.
- The catalogue starts empty. Administrators create/import, review and explicitly enable pools; no automatic conversion or new dungeon/species content is provided.
- Pool edits need no dungeon republication. An edit incompatible with one dungeon is allowed in the shared catalogue but blocks that dungeon's validation/new starts until repaired; it never broadens the dungeon's acquisition policy. Disabling a referenced pool intentionally blocks future starts while active runs continue.
- Where-used reports current drafts and current published definitions. Historical runs carry their own frozen pool bodies; this is not a historical run browser. No delete operation is exposed.
- Shared condition authoring is JSON-based because standalone pools have no owning room/flag vocabulary. Compatibility is checked separately for each referencing dungeon. There is no new rarity mechanic or entry-enable field.
- Pool JSON is separate from dungeon JSON. Full shared-pool bundle transport and a complete shared-species export manifest are future CP-4 work.
- The existing local-pool Portal test failure remains documented, with a matching untouched-HEAD reproduction. No unrelated sheet refactor or expensive root baseline comparison was performed.
- Unrelated audit/artwork work was preserved. Project memory was updated via MCP; its files were not edited directly.
