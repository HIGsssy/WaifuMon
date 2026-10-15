# RP2B completion: Region Pool administration backend

Status: **implemented, uncommitted, not deployed.** It adds the backend only: no Portal
screens, no migrations, and no changes to hunting, species, region JSON, travel or
dungeons. RP3 has not started.

Inputs: [rp1-architecture.md](rp1-architecture.md) and
[rp2a-completion.md](rp2a-completion.md). The RP2A code at `9448068` was treated as
authoritative.

## 1. Branch, HEAD and working tree

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `9448068861e8828e106536cd8913ecbde7a0ee43` (RP2A, committed by the user before RP2B) |
| Starting state | Clean |
| Final state | 8 tracked files modified and 11 new files (§10). Nothing committed |
| Migrations | **None.** The RP2A schema was sufficient |

## 2. Services and API routes

New modules in `src/modules/regionPools/`:

| Module | Role |
| --- | --- |
| [`regionCatalogue.ts`](../../src/modules/regionPools/regionCatalogue.ts) | **The region-identity boundary.** `RegionCatalogue` (`list`, `get`, `defaultRegionId`). Today's implementation, `contentRegionCatalogue`, answers from `REGIONS` and the region files. Nothing else in Region Pools names `REGIONS`, `isRegion` or `content.regions`, so a database-backed catalogue is a new implementation of this interface |
| [`regionPoolValidation.ts`](../../src/modules/regionPools/regionPoolValidation.ts) | Pure draft and publish rules, with stable issue ids (§4) |
| [`regionPoolDistribution.ts`](../../src/modules/regionPools/regionPoolDistribution.ts) | Pure `describeRegionDistribution` and `diffDistributions` (§5) |
| [`regionPoolService.ts`](../../src/modules/regionPools/regionPoolService.ts) | `createRegionPoolService({ db, getContent, catalogue, huntTables })`: read, draft, shipped workflow, validate, publish, rollback, history, events, drift, species catalogue, analysis |
| [`regionPoolStore.ts`](../../src/modules/regionPools/regionPoolStore.ts) (RP2A) | Now exports `lockRegionPools`, `recordRegionPoolEvent` (with an actor) and `projectRegion` (with an actor), so the service reuses the exact RP2A projection. Bootstrap and sync behaviour is unchanged |

The service is wired in [`src/index.ts`](../../src/index.ts) as `services.regionPools`.
`huntTables` is the **same `content.tables` object the hunt was constructed with**,
so the odds always use the tables the running hunt uses (the hunt reads
`tables.json` once; a reload does not change it).

Routes are in [`src/api/routes/v1/admin/regionPools.ts`](../../src/api/routes/v1/admin/regionPools.ts),
registered after the Enemy routes and tagged `Admin — Region Pools`:

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /admin/region-pools` | read | Every region: released state, published revision, unpublished changes, per-rarity counts, drift status |
| `GET /admin/region-pools/species` | read | Species picker: rarity, enabled, in content, huntable, region- and dungeon-exclusive, race, affinity, `imagePath`, regions that have published her |
| `GET /admin/region-pools/:regionId` | read | Draft (with draft-level issues) and published revision, both with per-entry species facts |
| `PUT /admin/region-pools/:regionId/draft` | write | Save the draft (`entries`, `expectedDraftRevision`) |
| `POST /admin/region-pools/:regionId/draft/discard` | write | Reset the draft to the published pool |
| `GET /admin/region-pools/:regionId/shipped` | read | The shipped pool as resolved, compared with the draft and with the published pool; merge candidates; weight conflicts |
| `POST /admin/region-pools/:regionId/draft/load-shipped` | write | Replace the draft with the shipped pool |
| `POST /admin/region-pools/:regionId/draft/merge-shipped` | write | Additive merge of shipped species into the draft |
| `POST /admin/region-pools/:regionId/validate` | read | With `entries`: draft-level issues for an unsaved list. Without: the publish review (issues, required acknowledgements, `reviewHash`, diff) |
| `POST /admin/region-pools/:regionId/publish` | publish | `expectedDraftRevision`, `reviewHash`, `acknowledgedWarnings` |
| `GET /admin/region-pools/:regionId/revisions` | read | History, newest first |
| `GET /admin/region-pools/:regionId/revisions/:revision` | read | Entries and the species manifest stored at publish time |
| `GET /admin/region-pools/:regionId/revisions/:revision/rollback-preview` | read | Rollback review against today's state |
| `POST /admin/region-pools/:regionId/rollback` | publish | `revision`, `expectedDraftRevision`, `reviewHash`, `acknowledgedWarnings` |
| `GET /admin/region-pools/:regionId/events?limit&before` | read | Audit trail, newest first, with cursor paging |
| `GET /admin/region-pools/:regionId/drift` | read | Structured drift (§4) |
| `POST /admin/region-pools/:regionId/analysis` | read | Probability analysis (§5). Writes nothing |

No write action is exposed through GET. `validate` and `analysis` are POST only
because they take a body; both are read-only and need `regions.read`.

**Identifiers.** Regions and species are addressed by slug. Revisions are
addressed by their per-region number. No numeric row id appears in any response.
Event details that RP2A wrote with row ids (`revisionId`, `publishedRevisionId`)
are translated to `revisionNumber` and `publishedRevisionNumber` on read. The one
opaque value is the events `cursor`.

## 3. Draft, publish and rollback transactions

Every write runs in one transaction:

1. take the Region Pool advisory lock (the one RP2A startup uses);
2. lock the region's `region_pools` row `FOR UPDATE`;
3. check `expectedDraftRevision`, refusing with `409 REGION_POOL_STALE` and
   `{ expectedDraftRevision, currentDraftRevision, updatedBy, updatedAt }`;
4. do the work.

| Operation | Writes |
| --- | --- |
| Save, discard, load shipped, merge shipped | `region_pools` draft (`draft_revision + 1`, hash, `updated_by`) and one audit event (`draft_saved`, `draft_discarded` or `draft_reset_to_shipped`). **Never the projection** (tested) |
| Publish | Under the lock: re-run the publish review against current species and every other region's published pool. Refuse if `reviewHash` differs (`409 REGION_POOL_REVIEW_STALE`, returning the fresh issues and hash), then if there are blocking errors (`422 REGION_POOL_PUBLISH_BLOCKED`), then if acknowledgements are missing (`422 REGION_POOL_ACKNOWLEDGEMENT_REQUIRED`, `details.missing`). Then insert revision N+1 (`source='editor'`) with entries and a species manifest, move the pointer, run `projectRegion` for this region only (only if released), and record `published` (plus `projection_rebuilt`). All of it commits or none of it does |
| Rollback | Same review gate for revision *k*, revalidated against **today's** state. Inserts revision N+1 (`source='rollback'`, `rolled_back_from = k`) holding *k*'s entries, **sets the draft to those entries** (`draft_revision + 1`), moves the pointer, re-projects, and records `rolled_back` with `fromRevisionNumber`, actor and acknowledgements. History rows are never changed |

**The review hash** is a SHA-256 fingerprint of: the purpose (`publish` or
`rollback:k`), the region, the draft revision, whether the region is released, the
entries, each entry species' rarity, enabled state, tags and in-content flag, the
hunted rarities, and the resulting issues (id, severity, acknowledgement flag and
conflicting regions). An approval therefore covers exactly what was reviewed.
Draft edits, species retags, disables and rarity changes, and a conflicting
publish in another region all invalidate it.

**Warnings that must be acknowledged at publish:**

- `species_disabled`
- `species_not_in_content`
- `species_not_huntable` (EX)
- `rarity_tier_empty`
- `draft_replaced_by_rollback` (rollback only)

**Errors that block publishing:**

- everything that blocks a draft save;
- `region_exclusive_conflict`;
- `pool_has_no_eligible_species` (released regions only);
- `draft_unchanged` and `revision_already_published`.

## 4. Species validation and drift

**Draft level** (`REGION_POOL_INVALID`, `details.issues`) refuses:

- unknown region;
- an entries list that is not an array, or an entry with the wrong shape (reported
  by index);
- more than 500 entries;
- unknown species slug;
- duplicate species;
- a weight that is not an integer from 1 to 1,000,000;
- **any `dungeon_exclusive` species**.

Disabled, not-in-content and EX species, empty rarity tiers, a region-exclusive
species published elsewhere, and an unreleased region are **warnings** at this
level, so drafts can hold work in progress. Every issue carries a stable `id`
(`code`, `code:species` or `code:rarity`) plus `species`, `rarity`, `index` and
`regions` where relevant, so RP3 can render it beside the entry or tier.

**Region exclusivity is checked against every other region's published pool,**
including unreleased regions. That is stricter than loader rule 6, which counts
only enabled regions. The aim is that releasing a region can never create a
conflict. See §11.

**Drift** (`GET …/drift`, and `driftStatus` in the list) compares the published
revision's `species_manifest` with current species:

- `disabled`, `enabled` and `missing_from_content`;
- `rarity_changed` with `from` and `to`;
- `tags_changed` with added and removed tags;
- `exclusiveConflicts` (a region-exclusive species also published in other
  regions);
- `emptyTiers`, with `causedByContent` true when the tier was non-empty at publish;
- the shipped file compared with the published pool, including the diff.

Drift is read-only and never rewrites a pool. Species stay content-owned: the
service has no code path that writes `species`.

## 5. Probability analysis and parity evidence

`describeRegionDistribution` restates the runtime step by step. It imports the
runtime's own pure arithmetic:

- `encounterRarityWeightPercent`;
- `encounterSpeciesWeightPercent`;
- `buddyBonusPercent`;
- `applyPercentModifier`;
- `rareEncounterShift`;
- `matchesSpeciesFilter`.

`huntService` and `speciesSelection` are unchanged, and no `ORDER BY` was added.

| Mode | Runtime it models |
| --- | --- |
| `hunt` | `hunt()`. Result table with the `hunt_item_find_chance` Buddy (gives `encounterShare` and `perHunt`). Rarity table with the rarity-scoped Buddy **then** the level-40 shift. Tiers: region, then default region (not when analysing the default region), then global (enabled, not region- or dungeon-exclusive, `max(1, per_species_weight)`). Species-scoped Buddy (race, affinity, ownership against a stated owned set). Six attempts: live rarity *k* resolves with probability `p_k·Σ_{i<6} dⁱ`; exhausted mass `d⁶` is reported against the fallback path (`default_pool_arbitrary`, `open_species_arbitrary`, `emergency_region_exclusive` or `nothing`), not against a species, because that row is `LIMIT 1` with no `ORDER BY` |
| `scripted_spawn` | `pickSpeciesForSpawn`: the same draw with no Buddy (a supplied Buddy is reported as `buddy_ignored`) |
| `filtered_selector` | `pickFilteredCandidate`. Region scope uses the pool at pool weight; global scope uses open species plus the pool at `per_species_weight`. Filter; level-adjusted table **conditioned** on the rarities present, uniform when none has weight. **No fallback tier** (`no_matching_species`) |

Unsafe scenarios are reported, not smoothed over. When a bonus drives a weight
negative, or a table total to zero, `rollWeighted` would throw. The analyser
reports `unsafe_rarity_table`, `unsafe_species_weights` or `unsafe_result_table`,
marks the rarity `unsafe`, adds the probability of reaching the throw to
`errorProbability`, and lists no invented species odds. A weight of exactly 0 is
legal: that rarity is simply never rolled, as at runtime.

Outputs:

- per rarity: base and effective weight, roll probability, resolved probability,
  resolving tier, candidate count;
- per species: tier, whether the species is in the pool, weight, effective weight,
  share of rarity, chance per encounter, chance per hunt;
- excluded pool members with reasons (`unknown_species`, `disabled`,
  `dungeon_exclusive`, `rarity_not_hunted` for EX, `rarity_never_rolled`,
  `filtered_out`);
- fallback, dead-tier and exhausted warnings;
- the analysed scenario's assumptions in plain text;
- with `compare: true`, the draft compared with the published pool (per-species
  deltas and changed tiers).

**Parity with the real runtime.** [`tests/integration/regionPoolOdds.test.ts`](../../tests/integration/regionPoolOdds.test.ts)
uses fixed seeds and Pearson chi-square with a requirement of p > 0.001:

| Case | Real code path | Draws |
| --- | --- | --- |
| Twin Peeks levels 1 and 40, Thirstlands level 1, Waifu Valley level 40 | `pickSpeciesForSpawn` | 8,000 each |
| Twin Peeks with SSR falling back to Waifu Valley and UR falling to the global table (published through the service) | `pickSpeciesForSpawn` | 40,000 |
| No N species anywhere: dead tier, rerolls, exhausted `LIMIT 1` row | `pickSpeciesForSpawn` | 8,000 |
| Rarity-scoped Buddy (+400% SR) at level 40 | full `hunt()` transaction | 4,000 |
| Race-scoped Buddy (+400% human) | full `hunt()` | 4,000 |
| Affinity-scoped Buddy (+400% dominant) | full `hunt()` | 4,000 |
| Ownership Buddy (+400% owned, with 4 owned pool species) | full `hunt()` | 4,000 |
| Item-find Buddy (+400%): per-hunt encounter share | full `hunt()` | 4,000 |
| Filtered selectors: region SR/LR, region dominant/primal at level 40, global demon | `createFilteredSpeciesPicker` | 6,000 each |
| Selector vs hunt where they differ (no fallback for selectors) | analysis | — |

All 15 pass. Buddies are real shipped species with their bonus values amplified in
the test's content snapshot, so a modelling error produces a large shift.

**Mutation check.** With the analyser changed to ignore species-scoped bonuses,
the race and ownership hunt cases **failed**. The file was restored and its
SHA-256 matched the original.

## 6. Shipped JSON workflow

- **`GET …/shipped`** resolves the region file exactly as the RP2A bootstrap does,
  then returns the entries, skipped slugs, the diff against the draft and the
  published pool, `mergeCandidates` (shipped species absent from the draft) and
  `weightConflicts`. It writes nothing.
- **`load-shipped`** replaces the draft only. It is validated at draft level, the
  revision is not published, and the projection is untouched (tested).
- **`merge-shipped`** is implemented, because it involves no product decision: it
  **appends** shipped species missing from the draft (all of them, or the named
  ones), at shipped weights in shipped order. Every existing member and weight is
  kept and nothing is removed. Naming a species that is not a merge candidate is
  refused.
- **Deferred to RP3 planning:** applying shipped removals (species the file
  dropped) and resolving weight conflicts. Both are reported (`diffFromDraft`,
  `weightConflicts`) but never applied, because each needs a product decision
  about whose change wins.
- A JSON reload never changes published membership. The RP2A sync reports drift
  only, and that is re-verified here through the real legacy reloader.

## 7. Authentication and permissions

`regions.read`, `regions.write` and `regions.publish` were added to
`ALL_PORTAL_PERMISSIONS`, with owner-facing descriptions. They are delegable, and
the guild owner holds them automatically. Every route checks its permission with
`requirePortalPermission` (bearer only when `PLATFORM_API_ADMIN_BEARER`). CSRF is
the global Portal hook for every non-GET request. The actor always comes from the
session, never the request body.

Tested:

- a signed-in user without these permissions gets 403 `PORTAL_PERMISSION_DENIED`;
- an anonymous request gets 401;
- read cannot write, write cannot publish or roll back, and publish cannot save,
  discard or load drafts. Each refused write left every Region Pool table
  byte-identical;
- a write without the CSRF header gets 403 `PORTAL_CSRF_INVALID`;
- a writer's save and a publisher's publish are each recorded with their own actor.

The Portal's dev-session permission lists (`portal/src/auth/*`) were **not**
changed. That belongs to RP3.

## 8. Concurrency and rollback tests

From [`regionPoolService.test.ts`](../../tests/integration/regionPoolService.test.ts),
24 cases:

- A stale save is refused with both revision numbers and the last editor.
- A review is invalidated by a species being disabled after review
  (`REVIEW_STALE`, with fresh issues) and by a draft edit after review (`STALE`).
- **Concurrent publications of one region-exclusive species** into two regions:
  both reviews are clean, and exactly one publish wins. The loser is refused
  (`REVIEW_STALE` or `PUBLISH_BLOCKED`), and the species is projected in exactly
  one region.
- **Injected SQL failure** (a trigger on the `published` audit insert): the
  projection, revisions, pools and events are identical before and after.
- Revisions are immutable (`UPDATE` and `DELETE` are refused by the trigger), and
  revision 1 still holds its 40 entries and manifest.
- Rollback to a valid revision creates revision 3 (`source='rollback'`,
  `rolledBackFrom` 1) and restores both the draft and the projection exactly.
  Rolling back to a missing revision gives 404.
- Rollback to a revision containing a species that has since been tagged
  `dungeon_exclusive`: the preview shows the error, and the rollback is refused
  with `PUBLISH_BLOCKED`.
- **Concurrent reader during a publish:** a loop reading the projection saw only
  the whole old pool, then only the whole new pool, never a mix.
- **Concurrent hunts during a publish** (`pickSpeciesForSpawn` in a loop): every
  draw came from the old or the new pool, and every draw that started after the
  commit came from the new pool.
- Restart (`applyContent`) and the legacy reloader keep the published pool, and
  report the shipped file as drift.
- Drift: a disabled species, a rarity change, and an LR tier emptied by content
  (`causedByContent: true`) are reported; the projection is unchanged; the region
  reads clean again once restored.

## 9. Verification

All runs used disposable podman `postgres:16-alpine` with
`TEST_DATABASE_URL=postgres://postgres:test@localhost:<port>/postgres`. No staging or
production database was touched.

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/regionPools` | 26/26 pass (analyser 17, validation 6, boundary 3) |
| `npx vitest run tests/integration/regionPoolService.test.ts` | 24/24 pass |
| `npx vitest run tests/integration/api/adminRegionPools.test.ts` | 12/12 pass |
| `npx vitest run tests/integration/regionPoolOdds.test.ts` | 15/15 pass (about 5.5 min) |
| `npx vitest run tests/integration/regionPools.test.ts` (RP2A) | 19/19 pass |
| **Full root suite** (`npx vitest run`) | 8731 tests: 8612 passed, 1 skipped, **118 failed in 30 files** |
| Same suite, RP2A baseline run on identical code minus RP2B | 8657 tests, 120 failed in 31 files |
| Failure diff, RP2B vs baseline | **No new failures.** Two baseline failures did not recur: `bossScheduler` "suspends with an actionable message…" and `questRewardPreview`, both documented flakes |
| `npm run typecheck` | exit 0 |
| `git diff --check` and a trailing-whitespace scan of every new file | clean |
| After the final `this.get` refactor | Typecheck clean; service, API, RP2A and unit suites rerun: **81/81**. The odds suite does not use write return values and was not rerun after that refactor; it passed in the full run before it |

Hunting, World Encounter, region content, seeding and Dungeon Encounter suites
(`hunt`, `regionalHunt`, `filteredWildEncounter`, `wildEncounterSpawn`,
`worldEncounter*`, `encounterPromotion*`, `selectorPreviewRoutes`,
`regionContent`, `migrateSeed`, `dexCompletion`, the expansion-region suites,
`dungeonEncounters*` and `dungeonCapturesLifecycle`) all ran inside the full suite.
None has a failure that is not in the baseline.

`tests/unit/api/routes.test.ts`: the 8 new mutation routes were added to the
allowlist with a comment. That test still fails exactly as at baseline, on 5
dungeon routes missing from its list. A one-off probe confirmed all 17 Region Pool
operations carry a summary, a tag and 400/401/500 responses; it was deleted after
use. The baseline-failing summary test stops at a dungeon route before reaching
them.

All 9 new error classes were constructed with junk arguments in a one-off probe
(deleted afterwards). They map to 400, 404, 409 and 422 as intended.

## 10. Files changed

Modified:

- `src/api/errors.ts` (status codes)
- `src/api/routes/v1/index.ts` (registration)
- `src/discord/types.ts` (`regionPools?` service)
- `src/index.ts` (wiring)
- `src/modules/portalAuth/portalAuthService.ts` (3 permissions)
- `src/modules/regionPools/regionPoolStore.ts` (exports the lock, the event
  recorder and `projectRegion`; actor parameter; behaviour unchanged)
- `src/shared/errors.ts` (9 error classes)
- `tests/unit/api/routes.test.ts` (allowlist)

New:

- `src/modules/regionPools/regionCatalogue.ts`
- `src/modules/regionPools/regionPoolValidation.ts`
- `src/modules/regionPools/regionPoolDistribution.ts`
- `src/modules/regionPools/regionPoolService.ts`
- `src/api/routes/v1/admin/regionPools.ts`
- `tests/unit/regionPools/regionPoolDistribution.test.ts`
- `tests/unit/regionPools/regionPoolValidation.test.ts`
- `tests/integration/regionPoolService.test.ts`
- `tests/integration/api/adminRegionPools.test.ts`
- `tests/integration/regionPoolOdds.test.ts`
- `docs/region-pools/rp2b-completion.md`

Untouched (verified with `git diff --quiet`): `src/modules/hunt`,
`src/modules/encounters`, `src/modules/dungeons`, `src/modules/travel`,
`src/modules/capture`, `content/` and `portal/`.

## 11. Known limitations

- **Rollback replaces the draft** with the restored pool. If the draft had
  unpublished work, the rollback requires the `draft_replaced_by_rollback`
  acknowledgement. This is a design choice, so that draft and published agree
  after a rollback.
- **Exclusive-conflict scope is stricter than the loader's:** all published pools
  count, including unreleased regions. If product prefers loader parity (enabled
  regions only), it is a one-line change in `validateEntries`.
- **Analysis scenarios are stated, not per-player.** Ownership comes from an
  explicit `ownedSpecies` list. The "Buddy" is a species slug whose authored bonus
  is read from content. Neither the live Buddy nor a player's real collection is
  read.
- **The exhausted-reroll mass is not attributed to a species**, because the
  runtime's `LIMIT 1` row depends on heap order. The odds test resolves that row
  with the same query.
- **The fallback pool in an analysis is the default region's current projection.**
  Analysing a draft of another region does not model an unpublished default-region
  draft.
- **Shipped removals and weight conflicts** are reported but not applied (§6).
- **`publishedIn` and conflicts use published pools**, not the projection. The two
  differ only for unreleased regions.
- **One global advisory lock** serialises all Region Pool writes and startup syncs.
  Hunts never take it.
- The events `cursor` is an opaque string, which is the audit row id.

## 12. RP3 handoff

- **Editor loop:**
  1. `GET /:regionId` (draft, published, draft issues).
  2. `PUT /draft` with `expectedDraftRevision`; re-render from the returned view.
  3. `POST /validate` with no body to get the review (issues,
     `requiredAcknowledgements`, `reviewHash`, `diffFromPublished`).
  4. Show the acknowledgement checkboxes keyed by issue `id`.
  5. `POST /publish` with the three review fields.

  On `409 REVIEW_STALE`, re-render from `details.issues` and `details.reviewHash`.
  On `409 STALE`, offer a reload, showing `details.updatedBy`.
- **Issue placement:** `species` (with `index`) maps to an entry row, `rarity` to
  a tier header, and `regions` to the conflicting regions.
- **Rarity vs species weights:** use `analysis.result.rarities[].probability` for
  the read-only rarity chance, and `species[].shareOfRarity`, `perEncounter` and
  `perHunt` for the columns. With `compare: true`, `comparison.diff` drives the
  draft-vs-published view.
- **Picker:** `GET /species` (`imagePath` for thumbnails through the existing
  artwork routes, `publishedIn`, flags). Show `dungeonExclusive` species as
  unselectable, and EX as `huntable: false`.
- **History and rollback:** `GET /revisions`, `GET /revisions/:n`,
  `GET /revisions/:n/rollback-preview`, then `POST /rollback`.
- **Shipped:** `GET /shipped`, then `load-shipped` or `merge-shipped`.
- **Drift:** `GET /drift` for the panel; `driftStatus` from `GET /region-pools` for
  list badges.
- **Portal permissions:** add the three `regions.*` permissions to the dev and env
  session providers and the router guards.
- **Product decisions needed:** shipped removals and weight-conflict resolution;
  the exclusive-conflict scope (§11); whether a rollback should keep the draft
  instead of replacing it.
