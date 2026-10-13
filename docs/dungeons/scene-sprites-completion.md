# Dungeon Scene Sprites — completion report

Completed on `Delve`, HEAD `1823c3a82af2cb2f2887d317bce11719fe3d85af`, starting from a clean working tree. Changes are uncommitted. No subagents, commits, pushes, merges, deployments, staging/production migrations, World Encounter work or Phase 4 work were performed.

1. **Enemy architecture findings.** Enemy Catalogue owns managed sprite artwork and a default `SpritePlacement`. Shared artwork storage validates uploads and maintains references/audits. `scenePlacement.ts` supplies the 1200×675 coordinates and aspect-preserving bounds. `sceneComposition.ts` composes cached rasters with `sharp`; `sceneLayers.ts` supplies actor/background fallbacks. Buddy placement is a reserved runtime actor, independent of authoring. Existing artwork replacement was mutable even for published scenes and removed old bytes, so publication needed an explicit protection policy for scene sprites.
2. **Managed catalogue.** Added Dungeon Scene Sprites storage/API/Portal management with unique identifiers, display names, optional categories, shared uploaded/selected artwork, default placement/scale/mirror/layer, active/archive lifecycle, search, previews, where-used references and authenticated audit history. Writes use optimistic revisions and existing dungeon permissions. Artwork retains existing upload/access/CSRF rules. Referenced entries cannot be deleted; archived entries can be restored.
3. **Room/activity placement.** Optional fields without defaults on rooms and every supported activity. Five independent instances per room and five per activity; repeated sprite keys are allowed. New Portal instances copy catalogue defaults. API instances can override any placement field, mirror or layer independently. Room and active-activity lists coexist. Empty lists are removed by the editor, and saves/reloads preserve placement.
4. **Rendering/layering.** Extended the existing compositor: background → background environmental sprites → Buddy → enemy → foreground environmental sprites. Same anchors, scaling, aspect ratio, clamp, transparency and mirror arithmetic. Old actor-only cache identities and pixels remain unchanged. Non-combat/Event scenes reuse this compositor. Missing/corrupt environmental art is omitted under a separate cache identity rather than failing the scene.
5. **Portal UX.** Room inspector and activity cards have catalogue selection, repeated placement, shared position/scale/offset controls, arrow movement, mirror/layer/removal and debounced production previews. Activity previews combine room and activity placements. Show me navigates to the affected room/activity. Desktop and narrow-screen browser flows verify saved/reloaded values and no horizontal overflow. Freeform drag placement was not added.
6. **Publication/active runs.** Nullable frozen visual metadata on existing dungeon revisions pins catalogue identities, artwork IDs/hashes/categories and defaults; instance overrides stay in revision content. Catalogue-only changes create a new revision when published and show Scene sprites changed in the Portal. Older/new runs on the earlier revision and restarted active runs retain its visuals; archival does not change them, and rollback reuses the target snapshot. Assets pinned by any revision are protected from replace/disable/category move/delete; upload another image and select it on the catalogue sprite. This extends existing reference guards without adding historical artwork storage.
7. **Packages.** Sprite-free v1/v2/v3 behavior, bytes and hashes remain compatible. Sprite-bearing package construction/export/inspection/import is explicitly blocked until a new dependency manifest/conflict workflow is designed. This is the temporary gate allowed by the request; no incomplete package is produced and destination sprite definitions are never overwritten.
8. **Migrations/files.** Created `0066_dungeon_scene_sprites.sql` and `0067_dungeon_scene_sprite_snapshots.sql`, registered after 0065. Migrations were exercised only in disposable local PostgreSQL databases. The exact file manifest is below.
9. **Verification.** Results and commands are recorded below. Pre-existing architecture failure reproduced separately on an untouched HEAD archive. Implementation regressions and new-fixture errors encountered during work were corrected.
10. **Limits/staging.** See [the authoring and staging guide](scene-sprites.md). Specific Event art becomes a cover-cropped 16:9 backdrop only when placements exist. Opaque enemy full art cannot provide true layering behind a character already painted into it. Pool/first-wave previews are representative of the selected activity; live draws select their actual images. Published sprite artwork is protected rather than versioned. Sprite package portability remains gated. Rehearse migration locks and verify DB → backend/bot → Portal order, permissions, Discord presentation, republishing/pinning/rollback, image guards and package gates before staging approval.

## Exact test and build results

| Check | Result |
| --- | --- |
| Stage A backend catalogue + renderer | 3 files, 40 passed |
| Stage A catalogue/API permission + upload | 1 file, 3 passed (later extended to 4) |
| Stage A Portal catalogue/artwork | 2 files, 23 passed |
| Final focused backend run | 52 files, 1,052 tests: 1,049 passed, 2 failed, 1 optional shipped-art skip |
| Affected backend rerun after correcting the new preview fixture | 2 files, 57 passed; fixes the new-fixture failure in the focused run |
| Effective unique backend result across that run and rerun | 1,050 passed, 1 pre-existing failure, 1 optional skip |
| Independent untouched-HEAD architecture baseline | Same 4 existing violations; 1 passed, 1 failed |
| Final focused Portal | 35 files, 382 passed, 0 failed |
| Final focused Playwright | 47 passed, 19 existing intentional mobile skips, 0 failed; new sprite flows pass on desktop and mobile |
| Backend `npm run typecheck` | Passed |
| Portal `npm run typecheck` | Passed |
| `git diff --check` | Passed |
| Production Portal Dockerfile build via Podman | Passed; build-env guard passed, 149 bundle files verified, no dev-only code |

The backend failure is `tests/unit/dungeons/engineArchitecture.test.ts`: the existing package importer imports `node:fs`, `drizzle-orm` and the DB schema, and reaches the enemy store's `drizzle-orm` import. The current implementation adds no violations. The final focused run's other failure was a new test fixture omitting `progressionCurrency`, so the existing dungeon route group did not register; its corrected API rerun passes all 57 tests, including production preview pixels.

Final focused commands (using the disposable local PostgreSQL URL for backend suites):

```sh
npx vitest run tests/unit/dungeons tests/unit/artworkAssets tests/integration/dungeon*.test.ts tests/integration/api/adminDungeons.test.ts tests/integration/api/adminArtworkAssets.test.ts tests/integration/api/adminDungeonSceneSprites.test.ts tests/integration/enemyCatalogue.test.ts --maxWorkers=4 --minWorkers=1
npx vitest run tests/integration/api/adminDungeonSceneSprites.test.ts tests/integration/api/adminDungeons.test.ts --maxWorkers=2 --minWorkers=1
# in portal/
npx vitest run src/features/adminDungeons src/features/adminDungeonSceneSprites src/features/adminArtwork src/features/adminEnemies src/features/adminDungeonLoot --maxWorkers=4
npx playwright test dungeonAuthoring.spec.ts dungeonArtwork.spec.ts dungeonEvents.spec.ts dungeonWorkspace.spec.ts dungeonImport.spec.ts dungeonLoot.spec.ts dungeonSceneSprites.spec.ts --workers=3
# root and portal/ respectively
npm run typecheck
npm --prefix portal run typecheck
git diff --check
podman build -f portal/Dockerfile -t waifumon-scene-sprites-portal .
```

Initial no-cache container verification caught browser-only static imports outside the Portal build context. These were replaced with the existing computed dynamic-import convention. The corrected final production image is `700c84c6eb22cc3117900859c9c29d73de21aaa0a800de199987a46754646085` (`localhost/waifumon-scene-sprites-portal:latest`). It was built, never deployed. Browser screenshots of representative desktop/mobile catalogue and combined placement scenes were saved under `/tmp/waifumon-scene-{catalogue,placement}-{desktop,mobile}.png`.

## Changed files

56 files, including this report. No species content was changed.

- `docs/dungeons/scene-sprites-completion.md`
- `docs/dungeons/scene-sprites.md`
- `drizzle/0066_dungeon_scene_sprites.sql`
- `drizzle/0067_dungeon_scene_sprite_snapshots.sql`
- `drizzle/meta/_journal.json`
- `portal/msw/handlers.ts`
- `portal/playwright/dungeonBackend.ts`
- `portal/playwright/dungeonSceneSprites.spec.ts`
- `portal/src/api/adminArtworkAssets.ts`
- `portal/src/api/adminDungeonSceneSprites.ts`
- `portal/src/api/adminDungeons.ts`
- `portal/src/app/navigation.ts`
- `portal/src/app/router.tsx`
- `portal/src/features/adminArtwork/ArtworkAssetsPage.tsx`
- `portal/src/features/adminArtwork/ScenePreview.tsx`
- `portal/src/features/adminDungeonSceneSprites/SceneSpritesPage.tsx`
- `portal/src/features/adminDungeonSceneSprites/__tests__/SceneSpritesPage.test.tsx`
- `portal/src/features/adminDungeons/ActivityCard.tsx`
- `portal/src/features/adminDungeons/RoomInspector.tsx`
- `portal/src/features/adminDungeons/SceneSpritesEditor.tsx`
- `portal/src/features/adminDungeons/__tests__/DungeonArtwork.test.tsx`
- `portal/src/features/adminDungeons/__tests__/SceneSpritesEditor.test.tsx`
- `portal/src/features/adminDungeons/dungeonPublicationModel.ts`
- `portal/src/features/adminDungeons/dungeonText.ts`
- `portal/src/features/adminEnemies/__tests__/enemyRoutes.test.tsx`
- `src/api/errors.ts`
- `src/api/routes/v1/admin/artworkAssets.ts`
- `src/api/routes/v1/admin/bosses.ts`
- `src/api/routes/v1/admin/dungeonSceneSprites.ts`
- `src/api/routes/v1/admin/dungeons.ts`
- `src/api/routes/v1/index.ts`
- `src/db/schema.ts`
- `src/discord/dungeonArtwork.ts`
- `src/discord/types.ts`
- `src/index.ts`
- `src/modules/artworkAssets/artworkAssetService.ts`
- `src/modules/artworkAssets/sceneComposition.ts`
- `src/modules/artworkAssets/sceneLayers.ts`
- `src/modules/dungeons/content/dungeonDefinition.ts`
- `src/modules/dungeons/dungeonContentService.ts`
- `src/modules/dungeons/dungeonRunService.ts`
- `src/modules/dungeons/package/dungeonPackage.ts`
- `src/modules/dungeons/sceneSprites/sceneSpriteDefinition.ts`
- `src/modules/dungeons/sceneSprites/sceneSpriteService.ts`
- `src/modules/dungeons/sceneSprites/sceneSpriteSnapshot.ts`
- `src/modules/dungeons/validation/dungeonValidation.ts`
- `src/shared/errors.ts`
- `tests/integration/api/adminDungeonSceneSprites.test.ts`
- `tests/integration/dungeonContent.test.ts`
- `tests/integration/dungeonLootTables.test.ts`
- `tests/integration/dungeonRewardSnapshots.test.ts`
- `tests/integration/dungeonSceneSpriteCatalogue.test.ts`
- `tests/integration/dungeonSceneSprites.test.ts`
- `tests/unit/artworkAssets/sceneComposition.test.ts`
- `tests/unit/artworkAssets/sceneEnvironmentalSprites.test.ts`
- `tests/unit/dungeons/dungeonSceneSprites.test.ts`
