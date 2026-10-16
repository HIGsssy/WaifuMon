# RP3 completion: Region Pool Management in the Admin Portal

Status: **implemented, uncommitted, not deployed.** RP3 is Portal-only. It adds no
backend code, migrations or content changes, and does not touch hunting, capture,
Dungeon Pools or region release state. Dynamic Region Management has not started.

Inputs: [rp1-architecture.md](rp1-architecture.md),
[rp2a-completion.md](rp2a-completion.md) and [rp2b-completion.md](rp2b-completion.md).
The RP2B routes in
[`src/api/routes/v1/admin/regionPools.ts`](../../src/api/routes/v1/admin/regionPools.ts)
were treated as the authoritative contract. The Portal client mirrors their response
schemas field for field and calls no other endpoint.

## 1. Branch, HEAD and working tree

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `f1ce01fc17ea3e9207e9f5fcfa9f1bf0b4bc50ee` (RP2B committed by the user before RP3) |
| Starting state | Clean |
| Final state | 5 tracked Portal files modified, 15 new files and this report (§10). Nothing staged or committed |
| Backend / migrations | **None changed** |

## 2. Portal pages and components

Route `/admin/region-pools` (overview) and `/admin/region-pools/:regionId` (editor). Both
are guarded by `regions.read` in [`router.tsx`](../../portal/src/app/router.tsx). The
sidebar entry **Admin — Region Pools** sits after Reward Tables and before Dungeons, so
the existing Dungeons → Scene Sprites → Enemies → Boss Management → Artwork ordering
tests still hold.

| File | Role |
| --- | --- |
| [`api/adminRegionPools.ts`](../../portal/src/api/adminRegionPools.ts) | Typed client for all 17 endpoints, query keys and invalidation. It is separate from `adminDungeons.ts` |
| [`RegionPoolsListPage.tsx`](../../portal/src/features/adminRegionPools/RegionPoolsListPage.tsx) | Overview: one card per region with name and id, Released/Unreleased, default-region badge, published and draft revisions, unpublished-changes badge, published species count, per-rarity coverage (N–LR plus EX, with empty hunted tiers marked), drift badge, and last publication time, actor and source |
| [`RegionPoolEditorPage.tsx`](../../portal/src/features/adminRegionPools/RegionPoolEditorPage.tsx) | Editor: status strip, action bar, tabs (Pool editor, Probability, Shipped content, History), rarity sections, drift card, confirmations, publish review |
| [`RegionSpeciesPicker.tsx`](../../portal/src/features/adminRegionPools/RegionSpeciesPicker.tsx) | Search plus rarity, race, affinity and availability filters |
| [`RegionPoolAnalysisPanel.tsx`](../../portal/src/features/adminRegionPools/RegionPoolAnalysisPanel.tsx) | Three analysis views, scenario controls, and the probability section of the publish review |
| [`RegionPoolReviewDialog.tsx`](../../portal/src/features/adminRegionPools/RegionPoolReviewDialog.tsx) | Shared publish/rollback review gate |
| [`RegionPoolShippedPanel.tsx`](../../portal/src/features/adminRegionPools/RegionPoolShippedPanel.tsx) | Shipped JSON compared with the published pool and the saved draft |
| [`RegionPoolHistoryPanel.tsx`](../../portal/src/features/adminRegionPools/RegionPoolHistoryPanel.tsx) | Revisions, per-revision changes, audit trail with paging, rollback |
| [`regionPoolModel.ts`](../../portal/src/features/adminRegionPools/regionPoolModel.ts) | Pure bookkeeping: rows, local diff, grouping, issue placement, labels and number formatting. **No probability arithmetic** |
| [`regionPoolParts.tsx`](../../portal/src/features/adminRegionPools/regionPoolParts.tsx) | Thumbnail, species flags, release badge, issue list (names conflicting regions and their release state), stale banner, diff list |

**Reuse.** The Portal reuses the shared presentational pieces `ArtworkThumbnail`,
`RarityBadge`, `Badge`, `Card`, `Dialog`, `Input` and `PageHeader`, and follows the
Dungeon picker's layout. Nothing in `features/adminDungeons` was edited or extracted, and
no persistence, model or odds code is shared with Dungeon Pools. Extracting a common
picker would have meant changing Dungeon files, which RP3 was not allowed to do.

## 3. Species editing workflow

- **Sections:** N, R, SR, SSR, UR, LR, then **EX — Not Huntable**. Species with an
  unknown slug get their own section at the end. Empty hunted sections stay visible and
  say "No X species in this pool".
- **Section header:** the read-only base rarity chance (`rarities[].rollProbability`
  from the analysis at level 1 with no Buddy). If the server says the rarity resolves
  from another tier, the header shows "Drawn from: Fallback …". The EX section explains
  that hunts never roll EX, so its species have no odds.
- **Row:** thumbnail, name, slug, race and affinity, plus badges for Region-exclusive,
  Dungeon-exclusive, Enabled/Disabled/Not in content and Not huntable. Rows also show
  "Also published in …", the Weight input, the server's issues for that species, and
  three odds columns: **Share of rarity**, **Per encounter** and **Per Hunt**.
- **"How a hunt picks a Waifumon"** explains that rarity is rolled first and species
  are drawn within the rarity. It says plainly that a weight is relative and is not a
  probability.
- **Picker:** search and filters. Availability can be filtered to Huntable and enabled;
  Disabled, EX or not in content; Published in another region; or In no published
  pool.
  - Dungeon-exclusive species are listed but **cannot be selected**.
  - A region-exclusive species that is published elsewhere is flagged as a conflict.
  - Disabled, EX and not-in-content species can still be added. The server accepts them
    as warnings, and the picker labels them.
  - New rows start at weight 1.
- **Removing the last species of a hunted rarity** opens a confirmation. It explains
  that rolls of that rarity fall back to the default region and then to open species.
  Once the row is removed, live validation shows the server's exact `rarity_tier_empty`
  message.
- **Live validation:** unsaved rows are sent to `POST /validate` with `entries` after
  400 ms of inactivity. Issues are placed by species and by rarity. A weight outside
  1 to 1,000,000 disables Save before any request is sent.

## 4. Probability analysis

Every share and chance on screen is a field of `POST /analysis`. The editor columns use
`{source: 'draft', mode: 'hunt', level: 1}` for the **saved** draft. The Portal does not
estimate unsaved edits. Any rarity with unsaved changes says "Save to recalculate", and
its rows show the same instead of stale numbers.

The **Probability** tab has three separate views:

- **Normal hunting**
- **Scripted spawns**
- **Filtered World Encounter selectors**: pool scope, plus rarity, race and affinity
  checkboxes. Race and affinity values come from the species catalogue.

Scenario controls:

- Published or saved draft.
- Player level, with presets 1, 39 and 40.
- Compare draft with published.
- Buddy species (hunting only).
- Owned-species assumption (hunting only; checkboxes over the pool's species).

Each view shows:

- the server's assumptions;
- the encounter share of Hunt actions;
- the rarity table: weight before and after modifiers, one-roll chance, resolved chance,
  and the tier it is drawn from, with a dead-tier marker and the previous tier when
  comparing;
- species rows: source tier, weight before and after modifiers, share of rarity, per
  encounter, per Hunt, and the change against the other source when comparing;
- species that would no longer be met;
- excluded pool members with reasons;
- the analysis issues: falls back, dead, exhausted and buddy ignored.

When `errorProbability > 0`, the view says that the draw would fail and shows
**"Unsafe — no odds"** for the affected rarity. A `400 REGION_POOL_SCENARIO_INVALID`
response is shown with the server's reason, without any estimate.

## 5. Draft, publish and rollback

The **status strip** always separates three states:

1. **Unsaved edits on this page:** counts of added, removed and reweighted species.
2. **The saved draft:** its revision, species count, whether it has unpublished
   changes, and when and by whom it was last saved.
3. **The published pool:** its revision, time and actor, release state, and whether it
   is live for hunting.

Draft actions (`regions.write`):

| Action | Behaviour |
| --- | --- |
| Save draft | `PUT /draft` with the loaded `expectedDraftRevision`. Afterwards the page shows "Hunting is unchanged until it is published" |
| Discard unsaved edits | Confirmation, then the page's rows go back to the saved draft. No request is made |
| Reset draft to published | Confirmation (warns that other administrators' unpublished draft work is lost too), then `POST /draft/discard` |
| Load shipped / merge shipped | See §6 |

**Leaving the page** with unsaved edits triggers a router blocker and a
`beforeunload` prompt.

**Stale draft revisions:**

- **On a write:** a `409 REGION_POOL_STALE` shows who saved, at which revision and
  when. It offers **Reload latest draft** and keeps the local rows until the reload is
  chosen.
- **On a background refetch:** if a refetch sees a newer draft revision, a notice says a
  save will be refused.

**Publishing** (`regions.publish`) works only from a saved draft; the button is disabled
while there are unsaved edits. The review dialog shows:

- species additions, removals and weight changes (`diffFromPublished`);
- a before/after rarity coverage table, which flags tiers that become empty;
- probability changes from `analysis {source: 'draft', compare: true}`, labelled as
  normal hunting at level 1 with no Buddy;
- blocking errors;
- warnings to acknowledge, each with its id and a checkbox;
- other warnings;
- the **review fingerprint** (`reviewHash`) and the draft revision.

Publish sends exactly `{expectedDraftRevision, reviewHash, acknowledgedWarnings}` from
that review. The review query never refetches on focus, reconnect or retry, so the
fingerprint on screen is the one that is sent.

| Refusal | Portal response |
| --- | --- |
| `409 REGION_POOL_REVIEW_STALE` | Clears the acknowledgements, shows the current issues, disables Publish and asks for **Start a fresh review**. The hash in the refusal is not used, and nothing is retried automatically (tested) |
| `422 PUBLISH_BLOCKED` | Shows the issues |
| `422 ACKNOWLEDGEMENT_REQUIRED` | Lists the missing ids |
| `409 STALE` | Closes the dialog and shows the stale banner |

After a successful publish, the page takes the returned view and invalidates the list,
the species picker and every query for that region, including analysis, drift, history
and events.

**Rollback** (History tab, `regions.publish`) uses the same review dialog, driven by
`GET …/rollback-preview`. The dialog explains that a rollback:

- creates a new published revision;
- updates the live hunting pool (once the region is released);
- **replaces the saved draft**, warning when it has unpublished changes;
- does not erase any historical revision.

The backend's `draft_replaced_by_rollback` acknowledgement is required as returned. If
the page also has unsaved edits, an extra "Discard the unsaved edits on this page"
checkbox is required. The analysis API covers only the draft and the published pool,
so the dialog says it cannot price an earlier revision, instead of estimating.

## 6. Shipped-content comparison

The **Shipped content** tab (`GET …/shipped`) shows:

- **Shipped vs published (live):** species added in the file, species removed from it,
  and weight differences.
- **Shipped vs saved draft:**
  - **Newly shipped species:** *Merge selected into draft* or *Merge all* calls
    `merge-shipped`. It appends at shipped weights and keeps every existing entry and
    custom weight (tested). If the page has unsaved edits, it asks for confirmation
    first, because the server's new draft replaces them.
  - **Only in the Portal-managed draft:** tick species to remove them as **unsaved
    edits**.
  - **Weight differences:** tick conflicts to adopt shipped weights as **unsaved
    edits**. Custom weights are never replaced automatically.
  - **Load shipped pool into draft** replaces the whole draft after a confirmation.
- Skipped (unknown) shipped slugs and the shipped fingerprint.

Nothing on this tab publishes. The comparison says it is against the saved draft when
the page has unsaved edits.

## 7. Permission enforcement

| Permission set | UI |
| --- | --- |
| `regions.read` only | Every view, odds, shipped comparison, history and audit. Weight inputs are disabled. No Save, Discard, Reset, Add, Remove, Merge, Load-shipped, Publish or Rollback controls are rendered, and a "Read only" note says what is missing |
| `+ regions.write` | Draft editing and shipped operations. Publish is absent, with a note that it needs `regions.publish` |
| `+ regions.publish` (without write) | Review & publish and rollback. Draft controls are absent and weights stay read-only |
| none of them | The routes render the not-found page and the sidebar entry is hidden |

The three permissions were added to the dev-login and env session permission lists
(`DevLoginSessionProvider.tsx`, `EnvSessionProvider.tsx`) and to the Playwright owner
profile (`stubApi.ts`). Role Access already lists them, because it reads the grantable
permissions from the API. The API still checks every request; the Portal gating is for
presentation only.

**Region exclusivity (§10 of the brief).** RP2B does **not** implement the intended
distinction:

- **Intended:** a conflict between enabled regions blocks; a conflict that involves an
  unreleased region only warns.
- **Implemented:** `validateRegionPool` counts every other region's *published* pool
  whatever its release state. `region_exclusive_conflict` is a warning on a draft and a
  **blocking error at publish** in every case.

The backend policy was **not changed**; that needs approval. The Portal displays exactly
what the API returns. Next to each conflict it lists the conflicting regions and whether
each is released or unreleased, for information only. A browser test confirms that a
conflict with the unreleased Assteroid Belt is labelled "(unreleased)" and still blocks
publication, as the API decides. The discrepancy is also recorded in projectmem.

## 8. Tests and build results

All runs were local. No staging or production system was touched.

| Command | Result |
| --- | --- |
| `npx vitest run src/features/adminRegionPools` | **30/30 pass**: pages 21, model 5, routes 4 |
| `npx vitest run` (whole Portal) | 1803 tests: **1802 pass, 1 fail** (baseline, below) |
| `npx playwright test playwright/regionPools.spec.ts` | **22/22 pass**: 11 tests × desktop and mobile |
| `npx playwright test` (whole suite) | **209 passed, 19 skipped, 0 failed** |
| `npx tsc --noEmit` (Portal) | exit 0 |
| `npm run typecheck` (backend; no backend change) | exit 0 |
| `npx eslint` on all new and changed files | clean |
| `podman build -f portal/Dockerfile .` (production image: `npm ci`, `verify-build-env`, `tsc`, `vite build`, `verify:bundle`) | **success**, "155 bundle files checked, no dev-only code present". The local test image was removed afterwards |
| `git diff --check` (including the new files) | clean |

**Component coverage** ([`RegionPoolPages.test.tsx`](../../portal/src/features/adminRegionPools/__tests__/RegionPoolPages.test.tsx)):

- the overview's badges, coverage, drift and links, with axe;
- read-only, write-only and publish-only permissions;
- rarity sections, their order and the EX explanation, using server odds, with axe;
- add, reweight and remove followed by a save with the exact entries and revision;
- the invalid-weight guard and live server validation;
- the last-species-in-rarity confirmation;
- the discard and reset confirmations;
- the stale draft banner and reload;
- an exclusive conflict annotated "(unreleased)";
- publishing with the exact fingerprint and acknowledgements;
- **a stale fingerprint is never retried**: the server's fresh hash is never sent, and
  the fresh review needs new acknowledgements;
- blocking errors;
- the shipped comparison, merge of selected species, and conflicts applied as edits;
- load-shipped confirmation;
- history changes and the audit trail;
- rollback explanation, plus confirmation of losing unsaved edits;
- analysis requests for each mode and scenario, scenario-invalid reasons, the unsafe
  display, and comparison deltas.

The **routes test** runs against the real route table: `regions.read` gating,
not-found without it, and the navigation entry.

**Browser coverage** ([`regionPools.spec.ts`](../../portal/playwright/regionPools.spec.ts))
runs against [`regionPoolBackend.ts`](../../portal/playwright/regionPoolBackend.ts). That
fake backend uses the **server's own `validateRegionPool`, `describeRegionDistribution`
and `diffDistributions`** over the shipped `content/tables.json`, and imports them only
at test runtime. Its draft revisions, review fingerprint, acknowledgement gate and
rollback follow `regionPoolService.ts`. The cases are:

- sidebar navigation, including the mobile drawer;
- read-only use;
- the real analyser's odds: SR 10.0%; a 3:1 SR pair gives 75.0% of SR, 7.50% per
  encounter and 5.55% per Hunt;
- add, reweight, remove and save, recalculated by the server, with no revision
  published;
- discard, and a stale draft caused by another administrator;
- shipped merge that keeps custom weights;
- publishing with acknowledgements, where a species is disabled after review →
  `REVIEW_STALE` → fresh review → publish with a new hash and the new acknowledgement;
- rollback with the replaced-draft acknowledgement, creating revision 3 as a rollback
  of #1;
- an unreleased-region exclusive conflict that blocks;
- level 40 shifting N from 60.0% to 59.0%, scripted spawns, and a filtered SR selector;
- no horizontal overflow, and axe with colour contrast, in both projects.

**Baseline failure, reported separately.**
`src/__tests__/architecture.test.ts › only explicit API helpers issue
browser-authenticated writes` fails on `api/adminArtworkAssets.ts` and
`api/adminDungeons.ts`. Neither file was changed. This is projectmem issue #0069, open
before RP3. The new `adminRegionPools.ts` writes only through the `postData` and
`putData` helpers.

**Fixed during RP3:**

- The first axe pass found that the shared `RarityBadge variant="full"` label fails
  colour contrast for LR and EX. Rarity headings now use the code badge plus normal
  text. The shared badge itself was not changed.
- The first full run showed that inserting the nav entry between Enemies and Boss
  Management broke two existing nav-order tests. The entry was moved.

No backend tests were run, because no backend code changed.

## 9. Known limitations

- **No region artwork.** The Region Pools API has no region image, and RP3 adds no
  endpoint. The overview shows the name and id only.
- **Species thumbnails** reuse the existing `GET /admin/dungeons/species/artwork` route,
  which needs `dungeons.read`. A Region Pools reader without it sees a labelled
  placeholder. Region Pools has no artwork route of its own, and the Portal never turns
  `imagePath` into a URL.
- **Last modification in the overview** is the last *publication*, because the list
  endpoint returns no draft `updatedAt` or `updatedBy`. The editor shows both.
- **Odds cover the saved draft only.** The analysis API takes `draft` or `published`
  and no ad-hoc entries, so unsaved edits show "Save to recalculate". The rollback
  review cannot price an earlier revision.
- **Exclusive-conflict policy differs from the brief** (§7). The backend blocks every
  published conflict, including those with unreleased regions. This needs a decision.
- **Buddy scenarios** read the selected species' authored bonus on the server. The
  Playwright fake models "no bonus"; the request wiring is covered by unit tests, and
  the RP2B odds tests cover the bonus maths.
- **Shipped removals and weight conflicts** are applied as ordinary edits, as RP2B
  deferred them. There is no bulk "apply all shipped changes", by design.
- **Mobile action bar:** on narrow screens the draft actions stick to the bottom of the
  viewport. The page reserves space for the bar.

## 10. Files changed

Modified:

- `portal/src/app/router.tsx` (two lazy routes guarded by `regions.read`)
- `portal/src/app/navigation.ts` (Admin — Region Pools entry)
- `portal/src/auth/dev/DevLoginSessionProvider.tsx` (3 permissions)
- `portal/src/auth/EnvSessionProvider.tsx` (3 permissions)
- `portal/playwright/stubApi.ts` (owner profile gains the 3 permissions)

New:

- `portal/src/api/adminRegionPools.ts`
- `portal/src/features/adminRegionPools/RegionPoolsListPage.tsx`
- `portal/src/features/adminRegionPools/RegionPoolEditorPage.tsx`
- `portal/src/features/adminRegionPools/RegionSpeciesPicker.tsx`
- `portal/src/features/adminRegionPools/RegionPoolAnalysisPanel.tsx`
- `portal/src/features/adminRegionPools/RegionPoolReviewDialog.tsx`
- `portal/src/features/adminRegionPools/RegionPoolShippedPanel.tsx`
- `portal/src/features/adminRegionPools/RegionPoolHistoryPanel.tsx`
- `portal/src/features/adminRegionPools/regionPoolModel.ts`
- `portal/src/features/adminRegionPools/regionPoolParts.tsx`
- `portal/src/features/adminRegionPools/__tests__/regionPoolFixtures.tsx`
- `portal/src/features/adminRegionPools/__tests__/RegionPoolPages.test.tsx`
- `portal/src/features/adminRegionPools/__tests__/regionPoolModel.test.ts`
- `portal/src/features/adminRegionPools/__tests__/regionPoolRoutes.test.tsx`
- `portal/playwright/regionPoolBackend.ts`
- `portal/playwright/regionPools.spec.ts`
- `docs/region-pools/rp3-completion.md` (this file)

Untouched: `src/` (backend), `drizzle/`, `content/`, `portal/src/features/adminDungeons`,
and every hunting, capture and dungeon module.

## 11. Staging handoff

1. **Deploy order:** the RP2A and RP2B backend (migration 0069 and the admin routes)
   must already be on staging. The Portal calls only those routes.
2. **Grant permissions:** in **Admin — Role Access**, give the reviewers' roles
   `regions.read`, and `regions.write` / `regions.publish` as appropriate. Guild owners
   hold them automatically.
3. **Smoke test, read-only role:** the overview lists all six regions. Released and
   coverage match the published pools (compare with `rp2a-parity.sql` Query D). Editor
   controls are absent.
4. **Smoke test, writer role:** edit a non-default released region, save, and confirm
   that `region_encounter_pools` is unchanged (`rp2a-parity.sql` Query B returns no
   rows against the *published* revision), then discard.
5. **Publish once** with a publisher role. Check that Query B is clean against the new
   revision, that the Probability tab matches expectations at levels 1 and 40, then
   **roll back** and confirm the projection is restored and history shows both
   revisions.
6. **Stale paths:** open the same region in two browsers and save in both. The second
   save must show the stale banner. Review in one, publish from the other, then publish
   the first: it must ask for a fresh review.
7. **Decisions needed before production:**
   - the exclusivity policy for unreleased regions (§7, §9);
   - whether a region artwork or a `regions.read`-gated species artwork route is
     wanted, so thumbnails do not depend on `dungeons.read`.
8. **Release notes:** unchanged from RP2A. A code rollback below RP2A reverts published
   edits while the old release runs.

**RP3 stops here. Dynamic Region Management has not been started.**
