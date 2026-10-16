# RP3.1 completion: Region Pool artwork access and UI polish

Status: **implemented, uncommitted, not deployed.** RP3.1 adds one read-only API route and
points the Region Pool thumbnails at it. It changes no validation, exclusivity rule,
hunting code, content, migration or Dungeon behaviour. Dynamic Region Management has not
started.

Inputs: [rp1-architecture.md](rp1-architecture.md), [rp2b-completion.md](rp2b-completion.md),
[rp3-completion.md](rp3-completion.md).

## 1. Branch, HEAD and working tree

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `f1ce01fc17ea3e9207e9f5fcfa9f1bf0b4bc50ee` (unchanged) |
| Starting state | The uncommitted RP3 Portal work (5 modified tracked files, RP3 report and new files). All of it was kept |
| Final state | RP3 work plus the RP3.1 changes in §7. Nothing staged or committed |

## 2. Artwork route and permission findings

Before RP3.1 the thumbnails took this path:
`RegionSpeciesThumb` → `ArtworkThumbnail` → `dungeonSpeciesArtworkBlob` →
`GET /api/v1/admin/dungeons/species/artwork?slug&width=256`. That route is gated by
`dungeons.read`. A reader with only `regions.read` never made the request; the component
checked `dungeons.read` and drew an `ImageOff` placeholder instead.

The Region Pools API already returned `imagePath` in `GET /admin/region-pools/species`,
but no URL. The Portal deliberately never turns a path into a URL.

Every existing species-artwork route was checked:

| Route | Gate | Why it does not fit |
| --- | --- | --- |
| `GET /assets/waifumon/:slug` (`routes/v1/artwork.ts`) | Player session plus `assertSpeciesVisible` | Player-facing. A portal session gets `403 SPECIES_NOT_DISCOVERED` for any species that player has not caught, so admins would see artwork depending on their own collection |
| `GET /admin/gallery/species/:slug/appearances/:id/artwork` | `gallery.read` | A content-QA surface for disabled, locked, unreleased and switched-off expansion artwork. Requiring it would grant far more than Region Pools needs, and it serves an exact appearance id with no default |
| `GET /admin/result-presentations/preview/species-artwork` | `presentations.read` | An unrelated feature permission |
| `GET /admin/dungeons/species/artwork` | `dungeons.read` | An unrelated feature permission; this is the route RP3 borrowed |
| `/admin/artwork/assets/*` | `artwork.read` | Uploaded managed artwork only. It never serves shipped species art, so `artwork.read` is not a species-artwork permission |

**No general admin species-artwork route exists.** Every one belongs to its feature and
is gated by that feature's permission. Reusing any of them would mean either granting
`regions.read` users an unrelated permission or widening that route's gate. The task
prohibits both.

## 3. Decision: a narrow Region Pools route

Added `GET /api/v1/admin/region-pools/species/artwork?slug=<slug>&width=<rendition>` in
[`regionPools.ts`](../../src/api/routes/v1/admin/regionPools.ts):

- **Gate:** `regions.read`, through the same `preValidation` gate as every other Region
  Pools read. The bearer rule is unchanged (`adminBearerAllowed`).
- **Addressing:** by slug only, with the same slug regex and the shared
  `artworkWidthQueryField` as the Dungeon route. No parameter names a path, asset id or
  appearance.
- **What it serves:** the loaded species' **ungated default appearance**:
  `appearance.speciesContent` → `appearance.currentAppearance(species, null)` →
  `resolveAppearanceAssetOrLegacyPath`. That is the same composition the Dungeon picker
  route uses, and the route streams through the shared `sendArtwork` (rendition choice,
  ETag/304, `private, max-age=300, must-revalidate`).
- **Otherwise:** `404 NOT_FOUND`, which the Portal shows as its placeholder. This covers
  an unknown slug, a species not in loaded content (a switched-off expansion) and a
  species with no resolvable file.

**Reuse:** there is no new storage, resolver, conversion, rendition or caching code.
The route is the Dungeon route's handler body under a different gate.

## 4. Security rationale

- **Scope matches what `regions.read` already shows.** `GET /admin/region-pools/species`
  already lists every species with its name, rarity, flags and `imagePath`, disabled
  species included. The thumbnail adds the default picture of a species the reader can
  already list. Content species are a subset of that catalogue, so the route cannot
  reach a species outside it.
- **Nothing private.** No level-gated appearance, alternative variant or uploaded managed
  asset is reachable. Gallery-only content (switched-off expansions, specific
  appearances) stays behind `gallery.read`.
- **No widening elsewhere.** `/admin/dungeons/species/artwork` is byte-for-byte unchanged
  and still requires `dungeons.read`. No role gains `dungeons.read`, `gallery.read` or
  `artwork.read`.
- **No unauthenticated access.** Anonymous requests get `401`, and signed-in users
  without `regions.read` get `403 PORTAL_PERMISSION_DENIED` (tested).
- **Private cache policy**, as on the other admin artwork routes. A shared cache cannot
  hand the bytes to someone else.

Recorded as a projectmem decision (RP3.1 Region Pools species thumbnails).

## 5. Metadata label findings

`GET /admin/region-pools` returns, per region:

- `published`: `{number, source, rolledBackFrom, publishedAt, publishedBy, contentHash,
  entryCount}`, which is publication metadata;
- `draftRevision` and `unpublishedChanges`;
- **no draft editor or draft modification time.** Those exist only on the per-region view
  (`draft.updatedAt` / `draft.updatedBy`).

The overview ([`RegionPoolsListPage.tsx`](../../portal/src/features/adminRegionPools/RegionPoolsListPage.tsx))
already labels the field **"Last published"**. It shows `published.publishedAt`,
`published.publishedBy` and `published.source`, or "Never" when nothing is published.
Next to it are "Published revision" (`published.number`) and "Draft revision"
(`draftRevision`). The editor's status strip shows draft edits separately, as "Saved
<time> by <actor>" from `draft.updatedAt` / `draft.updatedBy`.

**The labels are already accurate, so nothing was changed and no test was added.** The
"Last modification in the overview" line in the RP3 report (§9) described this
limitation; it was not the on-screen text. No API field was added for draft edit metadata.

## 6. Tests and build results

All runs were local, against a podman Postgres 16 (`TEST_DATABASE_URL`). No staging or
production system was touched.

**New or updated coverage:**

| Requirement | Where |
| --- | --- |
| 1. `regions.read` without `dungeons.read` gets thumbnails | API: `adminRegionPools.test.ts` › *serves species thumbnails on regions.read alone* (reader holds only `admin.access` + `regions.read`; 200, exact bytes, `image/png`, private cache, 304 on ETag). Component: *loads artwork through the Region Pools route on regions.read alone*. Browser: read-only spec shows the Cafe Maid image and records the request |
| 2. No `regions.read`, no access | API: same test, `403` for a signed-in user without region permissions, `401` anonymous |
| 3. Existing artwork permission rules | API: path-like slug `400`, unsupported width `400`, unknown species `404`. Unchanged `adminDungeons.test.ts` (74/74) still asserts `403` on the Dungeon route without `dungeons.read` |
| 4. Missing artwork shows a placeholder | API: `404` before the file exists. Component: 404 → "Preview unavailable". Browser: fake backend has no artwork for Alley Catgirl and shows "Preview unavailable" |
| 5. Denied or unavailable artwork does not break the editor | Component: 404 and 403 thumbnails, then a reweight and a Save with the exact entry. Browser: every existing Region Pools flow now runs with one missing thumbnail on the page |
| 6. Dungeon species artwork unchanged | `adminDungeons.test.ts` 74/74; no Dungeon file changed |
| 7. Overview labels | Already correct (§5); no code change, no test added |
| 8. Publish and rollback controls unaffected | Existing component and browser publish/rollback cases pass unchanged |

| Command | Result |
| --- | --- |
| `npm run typecheck` (backend) | exit 0 |
| `npx tsc --noEmit` (Portal) | exit 0 |
| `npx eslint` on changed Portal files | clean |
| `vitest run tests/integration/api/adminRegionPools.test.ts` | **13/13** (12 existing + 1 new) |
| `vitest run tests/integration/api/adminDungeons.test.ts` | **74/74** |
| `vitest run tests/integration/regionPools.test.ts tests/unit/regionPools*` | all pass (integration 19/19) |
| `vitest run tests/unit/api` (with the above, 27 files) | 662 pass, 3 fail, all baseline (below) |
| OpenAPI metadata rule (summary, tag, 400/401/500) for every region-pool route, run as a throwaway filtered copy of the `routes.test.ts` case | pass; copy deleted |
| `npx vitest run src/features/adminRegionPools` (Portal) | **32/32** (30 + 2 new) |
| `npx vitest run` (whole Portal) | 1805 tests: **1804 pass, 1 fail** (baseline #0069) |
| `npx playwright test playwright/regionPools.spec.ts` | **22/22** (desktop + mobile) |
| `npx playwright test` (whole suite) | **209 passed, 19 skipped, 0 failed** |
| `podman build -f portal/Dockerfile .` (includes `npm run build && npm run verify:bundle`) | success; local image removed |
| `git diff --check`, plus each untracked file | clean |

The full root backend suite was not rerun. The change is one route in one file, and the
route, API and region-pool suites cover it.

**Baseline failures, unrelated and reported separately:**

- `tests/unit/api/errors.test.ts` › *classifies every AppError subclass*: projectmem #0147,
  open before RP3.1.
- `tests/unit/api/routes.test.ts` › *registers no mutation verbs…*: 97 vs 92 routes, the 5
  Dungeon mutation routes noted in rp2b-completion. The new route is a GET and is not
  counted.
- `tests/unit/api/routes.test.ts` › *gives every operation a summary…*: stops at
  `GET /admin/dungeons/capture-items` (no summary), which is unchanged Dungeon code.
- Portal `src/__tests__/architecture.test.ts` › *only explicit API helpers issue
  browser-authenticated writes*: offenders are still only `api/adminArtworkAssets.ts`
  and `api/adminDungeons.ts` (#0069). The new client function is a GET.

**Found and fixed during RP3.1 (test fixtures only):**

- The first API test also asserted a 403 from the Dungeon route, but the Region Pools test
  server registers no Dungeon service, so that route is absent (404). The assertion was
  dropped; the Dungeon suite already covers it (#0150).
- The browser thumbnail assertion failed on mobile only. `ArtworkThumbnail` loads only
  near the viewport, and the row started below the fold. The spec now scrolls the row into
  view first (#0151).

## 7. Files changed

Changed by RP3.1:

- `src/api/routes/v1/admin/regionPools.ts`: new `GET /admin/region-pools/species/artwork`
  (+2 imports)
- `tests/integration/api/adminRegionPools.test.ts`: temp `assetsDir` in the test context,
  and the new artwork test
- `portal/src/api/adminRegionPools.ts`: `regionSpeciesArtworkBlob`, and header comment
- `portal/src/features/adminRegionPools/regionPoolParts.tsx`: `RegionSpeciesThumb` uses
  the new loader. The `dungeons.read` check, the `ImageOff` placeholder and the
  `adminDungeons` import are removed
- `portal/src/features/adminRegionPools/__tests__/RegionPoolPages.test.tsx`: artwork stub
  and 2 thumbnail tests
- `portal/src/features/adminRegionPools/__tests__/regionPoolRoutes.test.tsx`: artwork
  loader stub, so no stray network calls
- `portal/playwright/regionPoolBackend.ts`: serves the thumbnail route (PNG; 404 for
  `missingArtwork`, default Alley Catgirl) and records requests
- `portal/playwright/regionPools.spec.ts`: read-only test asserts an image and a
  placeholder
- `docs/region-pools/rp3-1-completion.md`: this file

Untouched: `regionPoolValidation.ts` and every other `src/modules` file, hunting, World
Encounters, `content/`, `drizzle/`, Dungeon routes and Portal Dungeon code, permission
catalogue and role presets. `rp3-completion.md` is left as the RP3 record; this report
supersedes its thumbnail limitation.

## 8. Remaining limitations

- **No region artwork.** Unchanged from RP3; the overview shows the region name and id.
- **Disabled species show artwork** to `regions.read` holders, as they do to
  `dungeons.read` holders on the Dungeon route. They are already listed in the Region Pools
  catalogue. If disabled species should look blank here, that is a separate product
  decision.
- **Draft edit metadata stays editor-only.** The list endpoint has no draft
  `updatedAt` / `updatedBy`, and RP3.1 adds none.
- **Region exclusivity is unchanged.** `region_exclusive_conflict` still blocks publication
  against any other published pool, released or not, as RP1 approved. The pending decision
  from RP3 §7 is not part of RP3.1.
- **Docs:** no other API or permission documentation lists the Region Pools routes
  individually, so none was updated. The route appears in the generated OpenAPI spec
  under "Admin — Region Pools".

## 9. Staging handoff

1. **Deploy together:** the backend (one new GET route, no migration) and the Portal.
   With a Portal-only deploy against an older backend, every thumbnail shows "Preview
   unavailable"; nothing breaks.
2. **Smoke test with a `regions.read`-only role** (no `dungeons.read`): open
   `/admin/region-pools/<region>`. Thumbnails render in the editor and the species
   picker, and the browser's network panel shows requests to
   `/api/v1/admin/region-pools/species/artwork`, not `/admin/dungeons/…`.
3. **Negative checks:**
   - With that same role, `GET /api/v1/admin/dungeons/species/artwork?slug=<slug>` is
     still `403`.
   - With a role lacking `regions.read`, the new route is `403`.
4. **Missing art:** a species without shipped artwork shows "Preview unavailable" and the
   row stays editable.
5. Everything in the RP3 staging handoff (§11 of rp3-completion.md) still applies. Its
   decision on a `regions.read`-gated artwork route is now resolved; the unreleased-region
   exclusivity question remains open.

**RP3.1 stops here. Deployment and Dynamic Region Management have not been started.**
