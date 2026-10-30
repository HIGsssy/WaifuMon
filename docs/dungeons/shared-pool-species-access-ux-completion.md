# Shared pool Species Access authoring UX

Date: 2026-10-29. Branch: `Delve`. Starting and final HEAD:
`1b6fcf51f727fa3ae5102b715a89fcbda6cc9492`.

The starting tracked/untracked working tree was clean. Project memory records
CP-4A complete and CP-4B not started; no in-progress CP-4B changes were present.
No commit, push, merge or deployment was performed. Changes remain uncommitted.

## Root cause and investigation

The eight publication errors are correct missing authorization, not a pool
resolution failure. All eight checked-in definitions in
`content/species/dungeon_exclusives.json` are enabled, tagged
`dungeon_exclusive`, and have no central `dungeonAccess` entries:

- `recovery_wing_valkyrie`
- `ridge_wolf_girl`
- `showroom_demo_unit`
- `yukata_attendant`
- `glint_moth`
- `skyline_gondolier`
- `trailhead_marshal`
- `vent_diver`

Shared references deliberately contain `sharedPoolKey` and empty `entries`.
`validateDungeonDefinition` resolves those references against the live shared
catalogue before checking encounter species. Runtime selection uses the
resolved/frozen bodies and retains unavailable draws rather than moving their
weight to permitted species. Pool membership grants no acquisition permission.

The authoring bug was in `SpeciesAccessSheet`: it collected species from
embedded entries and specific-species encounters, omitting shared-reference
species. Publication provided individual repairs, without a bulk review.
No acquisition-policy or shared-resolution bug was found or changed.

## Authoring workflow

Dungeon settings and the publication checklist now offer **Review Species
Access from Encounters**, opening the existing Species access section.
Individual validation details and their original error severity remain.

The read-only `/admin/dungeons/validate` response now includes
`speciesAccessReview`, produced on the server using the existing policy
functions, shared resolver, and structural reachability warnings. It lists
potentially reachable Wild Encounters and both Rescue modes. It excludes unused
pools and structurally unreachable rooms/activities, deduplicates species, and
keeps every encounter/pool reference, including original shared keys.

The review shows species names and existing thumbnail fallbacks, central versus
dungeon-specific authorization, effective limits, and capture/Direct Rescue
restrictions. Resolved shared species also appear in the individual access
editor below, including usage information.

Administrators select missing species, enter an explicit positive finite integer
limit, acknowledge the proposed entries, and click **Add N access entries to
draft**. The limit starts blank. There is no unlimited bulk default. Reviewing,
changing selections, entering a limit or closing the sheet does not create
entries. A changed draft/review resets bulk inputs and approval; pending review
results cannot be applied.

Bulk creation appends only selected, eligible, absent entries. Existing entries,
their limits and Direct Rescue flags are retained; repeated species cannot
create duplicates. The existing 200-entry schema ceiling is respected without
partial application. Read-only editors cannot apply changes.

Direct Rescue has a separate unchecked opt-in for selected new entries used by
Direct Rescue activities. Without it, those rescues remain blocked. Central
Direct Rescue denials cannot be overridden. Missing/disabled species and
region-exclusive restrictions require their existing central/content remedies;
existing dungeon entries are edited individually rather than overwritten.

For `master dungeon pool N R`, an administrator can review all eight species,
choose a limit, approve eight draft entries, then save and explicitly publish.
The API regression verifies eight errors before approval, no missing-permission
errors afterwards, unchanged shared-pool entries/weights, an unchanged live
publication after saving the draft, and successful separate publication.
No staging data was modified during development.

## Security and isolation

The `speciesPolicies` and central `dungeonAccess` schemas and enforcement are
unchanged. The existing rule still takes the stricter finite limit and requires
both sources to permit Direct Rescue when both specify terms. Direct Rescue
still requires a finite limit. The acquisition ledger remains scoped by
player/species/dungeon across runs; releasing a copy does not restore allowance.

The helper has no server write endpoint. Applying it updates the editable
definition through the existing editor callback. Save/publish permissions,
optimistic revisions and publication revalidation remain authoritative. A saved
draft grants no live rights. Runs retain their frozen definition/pool draws;
acquisition continues checking the current published policy as before.

No species definitions, shared-pool persistence, engine selection/capture/grant,
regional hunting, migrations, content bundles, Equipment 3.0 or CP-3 artwork
transport were changed. Unused pool/access-entry warnings remain nonblocking.

## Verification

Backend focused suite: **212/212 passed**, comprising:

- `tests/integration/api/adminDungeons.test.ts`: 78, including the new real
  eight-species read-only review, draft approval and separate publication case.
- `tests/integration/dungeonOwnedSpeciesAccess.test.ts`: 17, covering ledger
  limits, central compatibility, Direct Rescue, drafts, rollback, live policy
  during runs and hunt exclusion.
- `tests/integration/dungeonSharedPools.test.ts`: 7, including frozen draws
  across edit/disable/restart and pool membership granting nothing.
- `tests/integration/dungeonImportLifecycle.test.ts`: 11, including published
  and active-run isolation and shared-pool draft-only import behavior.
- `tests/integration/regionalHunt.test.ts`: 14.
- Species terms, encounter authoring, engine encounters and new access-review
  unit tests: 85.

The access-review unit file was then expanded with an additional central
Direct Rescue/finite-limit case and nonblocking unused-entry assertions; its
final **7/7 passed**. This gives 213 distinct passing backend cases across the
focused runs.

Portal final focused suite: **62/62 passed** across access review (7), direct
shared-pool encounter integration (10), encounter authoring (13), workspace
(9), risk/publication (20) and species model (3). The seven new review tests
cover all eight species, names/thumbnails/provenance, explicit approval/limit,
no approval, stale draft review, central/dungeon distinctions, selection,
existing terms, deduplication, finite limits, capacity, Direct Rescue opt-in,
read-only behavior and grouped checklist navigation.

The broader Portal run also included `DungeonSpeciesPools.test.tsx`: **9/10**.
Its existing synchronous close/reopen assertion fails to find
`species-pool-editor`. The identical failure was reproduced in an isolated
archive of untouched HEAD `1b6fcf51` (Projectmem #0159); it was left unchanged.

Both backend and Portal typechecks passed. Backend TypeScript build passed.
The standard Portal production command correctly refused the existing
`portal/.env`. That file was preserved; Vite production build passed with an
empty `envDir`, the bearer-token environment variable removed in the build
process, and output under `/tmp`. The existing bundle verifier checked all 170
generated files and passed. Focused Portal ESLint and `git diff --check` passed.

Integration checks used a disposable local Podman PostgreSQL 16 container,
with isolated databases created by the existing harness. No application or
staging database was used.

## Remaining limits

Reachability follows the validator's structural graph and forward activity
routes. Locks and conditions are treated as potentially satisfiable; this is
not an exhaustive solver of flag combinations or player eligibility. Runtime
checks and full publication validation still apply, including errors in
unreachable encounters, whose validation severity was not changed.

Bulk approval creates entries only; it intentionally preserves existing terms.
Central-policy restrictions, missing/disabled dependencies, invalid capture
settings and unavailable capture items remain explicit repairs. Different
limits can be set in separate selected batches or edited individually. The
existing 200-entry maximum still applies. The new review needs the matching
backend response; older servers show an unavailable-review message.
