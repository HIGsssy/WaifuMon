# Phase 4D2 — integrated verification and release readiness

Assessment date: 2026-10-15. Branch **Delve**, starting HEAD
`062424cf463e15a641d64ab7f13b6f63e42bb2d5`. The starting working tree was clean.
All P4D2 changes remain uncommitted. No global content, runtime economics,
acquisition semantics, Region Pools or deployment configuration was changed.
No subagents, commit, push, merge, deployment, staging migration or production
migration was used. PostgreSQL verification used disposable local databases only.

**Recommendation: Ready for staging testing.** Production consideration requires
the manual acceptance below, explicit acquisition-scope and activity-isolation
decisions, and an operational migration/rollback review. Automated passes alone
do not constitute production acceptance.

## Implementation status

| Phase | Implemented behavior | Evidence in this pass |
| --- | --- | --- |
| P4A | Approved architecture; several proposal-era statements are historical | Design compared with actual code, discrepancies below |
| P4B1 | Pure pool selection, capture/rescue states, seeded attempts/SP, routes and flags | Full dungeon units and legacy byte/hash fixtures |
| P4B2A | Capture-service extraction, pinned Buddy quotes and direct grants | Capture extraction, capture/charm and hunt regressions |
| P4B2B | Real transactional capture/rescue, live access, acquisition ledger, migration 0068 | Integrated gameplay, boundary failures, limits, migration rehearsal |
| P4B2C | Hunt-family player locking; bounded dungeon deadlock retry | Existing 10-case repeated real-PG race suite passes |
| P4C1 | Discord selection/buttons, post-commit receipts, artwork, safe dismissal | 25 real-service Discord integration cases; artwork regressions |
| P4C2A/B | Pools, encounter/rescue authoring, server odds, preview/sandbox, species drift | Portal/API, desktop/mobile browser and container build |
| P4D1 | v4 evidence/hashes, target dependency review, disabled repair drafts and receipts | v1–v4 regression, cross-database destination gameplay |
| P4D2 | Integrated fixtures, populated migration rehearsal, creator guide and acceptance plan | This report and new/extended tests |

Primary creator documentation: [Dungeon captures guide](dungeon-captures-guide.md).
Earlier handoffs: [B1](phase4b1-completion.md), [C2A](phase4c2a-completion.md),
[C2B](phase4c2b-completion.md), [D1](phase4d1-completion.md).
The [design](phase4-captures-design.md) remains a proposal-era reference;
current code and observed test results determine this assessment.

## Integrated scenarios and guarantees

`tests/helpers/dungeonCaptureFixtures.ts` supplies reusable weighted, named,
Event/capture/boss/direct-rescue scenarios and two isolated exclusive species.
It inserts test-only species into disposable databases; shipped JSON is untouched.

`tests/integration/dungeonCapturesLifecycle.test.ts` exercises:

- Create → save draft → validate → publish → enable → start with a deterministic
  seed. Event repair sets a run flag, then a weighted species is selected.
- Real charm quote/selection, ordinary successful capture and Microdose spend;
  ownership, XP, quests, acquisition ledger and run history commit together.
  Authored captured text/flag/forward routing skip an otherwise reachable reward.
- A flag-unlocked capture rescue, followed by the actual dungeon Boss fight.
  Victory routes to Remember something; completed boss room plus that run flag
  unlock a direct rescue in the next room. There is no external guild-boss hook.
- Direct rescue consumes no charm and gives no capture quest credit. Treasure
  is then banked by either completion or extraction. Inventory, collection,
  history, ledger, settlement and revision ID are asserted at the end.
- Event refusal skips a conditional rescue. Missing charms and missing charm
  selection refuse capture rescue. A failed final rescue capture grants nothing;
  declining direct rescue or revoking its central authorization grants nothing.
- Weighted intervals for N/SR/LR entries and Nothing agree with server analysis.
  Conditions remove entries; once-per-run excludes a species after presentation.
  Restarted service/resume retains the stored selection, Nothing and attempt state.
- Republish changes new-run weights while the old active run keeps its revision.
  A disabled species retains its probability and resolves safely unavailable.
  Drift reports distinguish the current publication from historical active runs.
- The same limited exclusive is acquired once in each of two authorized dungeons;
  repeat runs in one dungeon are blocked, unlimited remains repeatable, and
  another player's allowance is independent. A limit reached earlier in the
  same run prevents the next capture without spending another charm.
- Real PostgreSQL trigger failures at ownership insert, acquisition-ledger insert
  and final history insert roll the whole step back. Exact player/run/inventory/
  effect/ownership/XP/quest/ledger/history/currency rows remain unchanged.
  Two retrying service instances produce one commit and one stale refusal,
  with the original seeded ordinary capture roll and one Microdose/charm spend.
- Real environmental artwork is uploaded, catalogued, published, pinned and
  composed with the encounter/Buddy; the same dungeon proceeds to a boss enemy.
  Sprite-bearing export refuses with the exact actionable message below.

The new tests join actual services and transactions. Discord network transport
is unnecessary. Existing Discord tests stub transport/card delivery while using
real database gameplay; browser flows stub HTTP and complement real API tests.

## Transaction integrity and current concurrency boundary

Existing live/Discord/race suites additionally verify ordinary capture failures,
final escape, duplicates, stale step numbers, changing charm inventory/eligibility,
disabled/restricted species between offer and attempt, pinned Buddy quote/XP,
grant-key collisions, direct-grant replay and deterministic failed-attempt retry.

Observed: no duplicate copies, double charm spend, repeated XP/quest credit,
limit bypass or partial step commit in these cases. Ownership and ledger have
unique grant keys; the ledger also uniquely references each granted copy.
Dungeon attempts are recorded in dungeon state/history; they do not create
hunted `encounters` or `capture_attempts` rows.

Issue **#0111** was previously fixed for the hunt family and is demonstrated
again here, not assumed fixed. The 10-case concurrency suite repeats real races:
hunt versus hunted capture, hunt versus dungeon capture (including terminal
settlement), hunted versus dungeon capture, shared last charm, shared Microdose,
duplicate captures/rescues and a deliberately constructed deadlock victim.
The normal races assert no deadlock/retry; the constructed deadlock proves
whole-transaction rollback and deterministic retry.

The effective order is run → player currencies → player for dungeon grants;
hunt takes currencies → player; hunted capture takes player before encounter,
inventory/effects and ownership. The dungeon step retries SQLSTATE 40P01 up to
three attempts, then reports contention. The old 250ms lock timeout is absent.
This does **not** establish a universal player lock order: Energy Drink/Care
take player before currencies, and soft release starts with an owned copy.
Those wider races remain an operational concurrency risk outside P4D2's small
verification scope; no architecture change was attempted.

Grants are inside the transaction. The Discord handler receives capture receipts
only after `act()` commits, then emits rare announcements, feed/session updates,
appearance toasts and duplicate controls. Direct rescues do not emit rare-capture
announcements. Existing success/stale/resume/forced-failure tests prove no repeated
announcement on stale presses or resume and none for rolled-back actions.
There is no durable announcement outbox: a crash/transport failure after commit
may lose a notification while ownership remains correct. Restart tests recreate
services over persisted state, not a real Discord gateway/process crash.

`dismiss_encounter` (#0114) emits no capture/grant effects. It resolves Unavailable
only under current unavailability; if eligibility returns before the press it
refuses with the encounter unchanged. Continue cannot accidentally grant a rescue.

## Acquisition policy and species exclusivity

**Actual enforcement: player + species + dungeon key, across runs.**
`dungeonAcquisitionCounts` groups the acquisition ledger within the player's
dungeon key, and the live grant rechecks that count and central access before
spending/granting. It is not global ownership and not a global all-dungeon cap.
Conversion/release does not remove an acquisition or replenish its allowance.

The two-dungeon test proves limit one permits two total copies when the same
player has limit one in each dungeon. Omitted ordinary-capture limits and explicit
`unlimited` both permit repeated captures. Direct rescue requires explicit
authorization and a positive finite limit; unlimited direct rescue is refused.
The ledger scope agrees with design §6.4 (“from this dungeon”) and §7.7's
per-dungeon ceiling. There is no evidence here of an implemented or approved
global all-dungeon counter. Design §5's old parenthetical “default 1” is also
historical: approved explicit finite direct-rescue limits are required in code.

Portal picker/pool labels explicitly say “per player, in this dungeon, across
runs.” Import review shortens that to “per-player limit,” which can be read too
broadly. The original design's example saying an already-owned Seraph is
unavailable is broader than the ledger implementation: ownership from another
source/key alone does not exhaust this dungeon's allowance. This guide documents
the actual behavior. No limit semantics or existing labels were silently changed.

**Production-readiness decision #0144:** record that acceptance uses the
implemented, design-described per-dungeon acquisition limits. If product instead
requires a global cap, that is a separately authorized change needing
migration/content/concurrency review; this pass does not infer such a rule.
Unlimited remains an explicit per-species policy either way.

The request referred to #0113 as a limit issue. Its actual record concerns
**player activity isolation**: one active run and reservation of its fighter,
but hunting, captured encounters and other systems remain usable during the run.
The P4B2C concurrency tests intentionally exercise that behavior. Decide whether
that narrower isolation is acceptable for production; P4D2 does not impose a
new global activity lock.

Dungeon-exclusive species are excluded from every hunt tier, pooled/global/
emergency fallbacks and scripted named/selector spawns; existing real-PG tests
exercise this. The content loader also rejects placing such a species in regional
pools. Restricted species need authorization for the exact dungeon key; region
coincidence and source package evidence do not authorize acquisition. No actual
shipped species or regional pool was changed in this pass.

## Package v4 and publication stability

The extended `dungeonPackageV4.test.ts` exports a published dungeon from a second
PostgreSQL database and inspects its actual v4 envelope. The destination initially
lacks both its isolated species and explicit charm. Complete import is refused
without writes; explicit incomplete acceptance saves a disabled unpublished
repair draft, and identical request replay returns one receipt.

Publication remains blocked after the species/charm are provisioned while
destination authorization names another dungeon. Repairing destination policy
allows publish/enable, actual charm capture, completion, destination ownership
and ledger verification. A second run reaches the destination limit, while a
different player can capture. Source ownership remains untouched.

Additional v4 cases cover missing/disabled/restricted species, finite direct
rescue policy, missing/disabled/wrong-category/incompatible/guaranteed-disallowed
charms, resealed tampering, stale plan hashes, explicit repair, distinct duplicate
imports, concurrent receipt replay, failed-import rollback, and replacement
isolation. An original pinned run can resume and attempt capture after import
replacement disables the current publication; its immutable revision survives.

V4 includes sorted actual-reference species/charm manifests and separate
definition, dependency and envelope hashes. It imports no species, items or
access configuration. Hashes detect corruption/coherence violations, not an
authenticated source identity. Unused pool content remains in the definition
without becoming an encounter dependency. Global eligible-charms rules do not
list the destination's entire capture catalogue as explicit dependencies.

V1/v2/v3, independent golden legacy bytes, reward snapshots and Events remain
compatible. Published encounter pools/rules are frozen; species enabled/access
remain live. Publication species evidence is informational and historical active
revisions are reported separately; older publications without evidence remain
unknown rather than acquiring fabricated history.

Environmental **Scene Sprite portability remains gated in every version**.
The service-facing refusal is:

> Packages with Scene Sprites are temporarily unavailable until sprite dependencies can be bundled safely. Remove placements from a copy to export it.

The pure package reader/builder separately rejects sprite-bearing packages.
V4 neither removes placements nor claims to carry their artwork. Ordinary
species encounter sprites do not activate that environmental-placement gate.

## Migration 0068 rehearsal and deployment order

`dungeonEncountersMigration.test.ts` creates a database through the real journal
ending at 0067, with an active run, a completed run and **2,000 existing history
rows**, including Phase 3 Event types. It then runs the actual migration runner
with session `lock_timeout=500ms` and `statement_timeout=30s`.

Verified:

- A reader of history causes 55P03 at the CHECK replacement. The migration
  transaction rolls back the earlier added run column, all DDL and tracking.
  Original run and history JSON remains identical.
- Migration DDL holds **AccessExclusiveLock on dungeon_runs and
  dungeon_run_events until transaction end**. A concurrent history reader times
  out while it is held. Schedule a quiet window and inspect long transactions.
- On an unblocked run, both existing runs survive, event state/history is
  unchanged, and `encounter_states` initializes to `{}`. The constant JSONB
  default caused no run-table heap rewrite on PostgreSQL 16 (same relfilenode).
- The history CHECK is replaced and validated: old types still work, the three
  new types work, and an unknown type is rejected. Validation scans existing
  history while the exclusive lock is held; the small rehearsal is not a
  production-scale duration estimate.
- Ledger has its primary key, unique grant/copy indexes, player/dungeon/species
  index, mode CHECK and four FKs. Invalid mode/orphan references are refused;
  live tests additionally exercise duplicate copy/grant constraints.
- Journal entry idx 68 follows 67 with a later timestamp. The actual SQL hash is
  tracked once, and a second runner invocation is idempotent. Full journal
  ordering/completeness unit tests also pass.

Deployment order, **documented only; not performed**:

1. Apply missing migrations in journal order. Environments behind 0065 need
   0065 Event state/history, 0066 Scene Sprite catalogue/category changes, and
   0067 revision sprite snapshots before **0068 Dungeon Encounters**. Earlier
   pending migrations must also run; do not manually mark journal entries applied.
2. Deploy the matching backend and Discord bot together. The startup migration
   runner must complete before either accepts gameplay. Ensure the operator's
   runner connection has a deliberate lock timeout; the application runner does
   not add the rehearsal's timeout by itself.
3. Deploy the matching Admin Portal; then validate/publish/enable test content.

0068's new table/indexes begin empty, but ALTERs and history CHECK validation
can block live traffic. 0065 has its own similar history CHECK lock; 0066 also
replaces the artwork category CHECK. Avoid mixed bot/backend versions while
encounter content is usable. Take the normal database backup and verify the
environment's actual migration journal before the maintenance window.

## Backward compatibility, rollback and recovery

Older builds with strict pre-Phase-4 schemas refuse species-pool/encounter
definitions and unknown v4 packages. A read-only archive of pre-Phase-4
`e7f8f0b` was exercised directly: its actual `DungeonDefinitionSchema` rejected
both `wild_encounter` actions and the `speciesPools` member of the new weighted
fixture. They cannot safely resume a pinned
encounter-bearing revision. A database-only additive migration is not a content
compatibility bridge. The legacy schema/bytes fixtures pass in the new build;
this pass did not boot an old bot against newly published content.

P4B1-era builds can parse the pure encounter schema but retain explicit live
publication/run gates; pre-P4D1 builds also retain the encounter package gate or
refuse v4. Parsing a definition is therefore insufficient evidence that an
intermediate old build supports the full published lifecycle.

Before encounter content is published or runs started, an application rollback
may be possible after checking that the old build tolerates additive schema and
any preceding sprite/Event features. Keep applied migrations and migration
tracking; do not drop the ledger or run column as an emergency rollback.

After encounter publication or active runs exist, **prefer roll forward**.
Disabling a dungeon prevents new starts; it does not rewrite published history,
settle active runs or make old code understand them. Keep a compatible backend
to let pinned runs finish/extract/abandon. An old application rollback requires
a reviewed plan for every encounter-bearing publication and active run.

If policy disables an offered species, restore the intended central policy or
republish corrected content for future runs. Existing runs retain their revision
and safely resolve Unavailable under live policy. Do not redistribute weights,
edit immutable revisions, delete acquisition rows or manually retry grant SQL.
Use the existing admin compensation process for exceptional recovery.

On a failed migration, let the transaction roll back, remove the lock blocker,
and rerun the normal runner. On a rolled-back capture, retry the same step: the
seeded outcome is unchanged. A committed duplicate press is stale and grants
nothing. Import retries must retain their request/plan identity to replay the
receipt; catalogue changes require a fresh review. Restore backups only through
the normal reviewed incident process, preserving ownership/ledger consistency.

## Manual staging acceptance — not yet executed

Run only after the authorized staging deployment. Record tester/date, dungeon
key/revisions, test players, run IDs, expected policy, receipts and screenshots.
**T** means isolated test-specific species/policy/item content is required;
do not retag shipped species. Keep finite, unlimited and direct-rescue fixtures
distinct. Use enough test inventory and allowance to repeat runs.

| Check | Action | Expected outcome | Fixture |
| --- | --- | --- | --- |
| Pool authoring | Create/rename/duplicate a multi-rarity pool; save/reload | Stable references; independent copy; deletion blocked while used | Ordinary permitted species |
| Named encounter | Specific WaifuMon with intro and charm subset | Correct species, text and eligible owned charms | Ordinary |
| Weighted encounter | Attach pool in two rooms, try fixed sandbox seeds/conditions | Server odds agree; stable selection; presented once-per-run species excluded later | Ordinary |
| Nothing | Add weighted Nothing and choose a seed that draws it | Authored text, next route, no charm/XP/ownership | Ordinary |
| Charm selection | Select another eligible charm | Selection persists; odds update; no spend until Capture | Multiple charms |
| Missing/ineligible charm | Spend selected charm elsewhere before pressing | Refusal; no negative inventory or grant | Ordinary |
| Failure/escape | Use non-guaranteed item with failed rolls through final attempt | One charm/ordinary effect charge each; escape advances, no copy | Low-chance test setup |
| Capture success | Capture with ordinary item and active Microdose | One charm/charge, copy, expected XP/quests/history | Ordinary |
| Duplicate/conversion | Capture same species again; Keep or Convert | Existing duplicate flow works; no second capture grant from stale press | Ordinary |
| Capture rescue | Event success sets run flag before charm rescue | Rescue appears only with flag; capture rules apply; failure/refusal grant nothing | Ordinary or T |
| Direct rescue | Authorized finite direct species; choose Rescue then retry button | One copy and ownership XP; no charm/capture quest or rare announcement | T |
| Decline rescue | Leave a direct/capture rescue | Left text/route, no ownership or spend | T for direct |
| Finite exclusive | Acquire limit-one species, end run, repeat | Second run Unavailable; another player has separate allowance | T |
| Cross-dungeon limit | Authorize same finite species in a second key | Current policy allows one per key; record explicit scope acceptance | T |
| Unlimited exclusive | Capture across repeated completed runs | Repeated captures allowed; no finite cap inferred | T |
| Hunt/spawn exclusion | Try named/scripted spawn and hunting for exclusive | Refused/excluded, including fallback; ordinary hunt still works | T |
| Disabled/offered | Disable species after offer, press Continue/Capture | Unavailable; no charm/XP/copy; other weights unchanged | T |
| Safe Continue race | Restore species after unavailable render, press Continue | Refused; no grant; eligible encounter still offered | T |
| Artwork | Encounter + Buddy + room/activity environmental sprites, then Fight | Correct placement/layers/mirror; enemy art preserved; fallback if absent | Managed scene assets |
| Event conditions | Repair success/failure/missing item/refusal paths | Only authored success remembers flag and unlocks rescue | Ordinary or T |
| Boss conditions | Win local Boss fight → flag → next room rescue; try losing | Only supported victory/completed-room conditions unlock | T for direct/exclusive |
| Resume/stale | Reopen command, restart compatible bot, press old buttons | Same species/attempts, stale notice, no duplicate grants/announcements | Ordinary |
| Revision pinning | Start run; edit pool/republish; start with second player | Old run keeps old weights; new run uses new revision | Ordinary |
| Live drift | Disable/change policy after republish with older run active | Current/historical active revisions separately identified | T |
| v4 portability | Export sprite-free encounters; review/import in another environment | Dependency review; disabled draft; publish/enable/play only after target repair | T for missing/restricted |
| Import retry/replacement | Retry request; replace draft with old run active | Same receipt on replay; one draft; active run continues pinned | Ordinary |
| Sprite export refusal | Export encounter dungeon with environmental placements | Clear refusal; no silently incomplete package; copy-without-sprites option | Managed scene assets |
| Existing dungeon smoke | Fight, Event, Treasure, rewards, rest, paths, completion/extraction | Existing progression, secured rewards and settlement unchanged | Existing sprite-free dungeon |
| Post-commit presentation | Successful SR+ capture; stale press/resume; forced failure if test tooling permits | One announcement/feed update after success; none on rollback/replay; owned card/duplicate choice correct | Ordinary SR+ |

## Exact verification commands and results

All root integration commands use only this disposable PostgreSQL 16 URL:

```sh
export TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/test
```

Each integration file creates/migrates/drops separate databases. The migration
rehearsal creates its own database and truncated journal under `/tmp`. Test
execution requires permission to access localhost outside this sandbox.

New/extended integration set:

```sh
npx vitest run tests/integration/dungeonCapturesLifecycle.test.ts \
  tests/integration/dungeonEncountersMigration.test.ts \
  tests/integration/dungeonPackageV4.test.ts --maxWorkers=2 --minWorkers=1
```

Result: **3 files, 45 passed**: 12 lifecycle, 4 migration, 29 v4 integration cases.
After strengthening the visual scenario to compose both an offered encounter
and a managed boss sprite with Buddy/environmental layers, reran
`npx vitest run tests/integration/dungeonCapturesLifecycle.test.ts --maxWorkers=1 --minWorkers=1`:
**12/12 passed**. Root typecheck was repeated afterwards: exit 0.

Capture/hunt and Phase 4 live/Discord regressions:

```sh
npx vitest run tests/integration/captureConcurrency.test.ts \
  tests/integration/captureExtraction.test.ts tests/integration/capture.test.ts \
  tests/integration/captureItems.test.ts tests/integration/hunt.test.ts \
  tests/integration/regionalHunt.test.ts tests/integration/assteroidBeltHunt.test.ts \
  tests/integration/dungeonEncountersLive.test.ts \
  tests/integration/dungeonEncountersDiscord.test.ts --maxWorkers=2 --minWorkers=1
```

Result: **9 files, 181 passed**, including all 10 concurrency cases.

Dungeon runtime, Events, rewards, Scene Sprites, packages and API:

```sh
npx vitest run tests/unit/dungeons tests/unit/api/dungeonImportPortalContract.test.ts \
  tests/unit/migrationJournal.test.ts tests/integration/dungeonContent.test.ts \
  tests/integration/dungeonEventsLifecycle.test.ts tests/integration/dungeonEventsLive.test.ts \
  tests/integration/dungeonEventsDiscord.test.ts tests/integration/dungeonRewardsLifecycle.test.ts \
  tests/integration/dungeonLiveRewards.test.ts tests/integration/dungeonRewardSnapshots.test.ts \
  tests/integration/dungeonBuddyRewards.test.ts tests/integration/dungeonRewardDiscord.test.ts \
  tests/integration/dungeonRewardValidation.test.ts tests/integration/dungeonSceneSprites.test.ts \
  tests/integration/dungeonSceneSpriteCatalogue.test.ts tests/integration/dungeonRuns.test.ts \
  tests/integration/dungeonImport.test.ts tests/integration/dungeonPackageV2.test.ts \
  tests/integration/dungeonImportV2.test.ts tests/integration/dungeonPackageV3.test.ts \
  tests/integration/api/adminDungeons.test.ts tests/integration/api/adminDungeonSceneSprites.test.ts \
  --maxWorkers=2 --minWorkers=1 --exclude tests/unit/dungeons/engineArchitecture.test.ts
```

Result: **51 files, 1,035 passed, 1 existing optional-artwork skip**. The known
architecture failure is run separately, not removed or weakened.

Portal commands (from root except Playwright):

```sh
npm --prefix portal test -- src/features/adminDungeons src/features/adminDungeonLoot \
  --maxWorkers=2 --minWorkers=1
npm --prefix portal run typecheck
npm run typecheck
podman build -f portal/Dockerfile -t localhost/waifumon-portal:p4d2 .
git diff --check
```

Portal tests: **36 files, 346 passed**. Both typechecks pass. Production container
build passes, including environment guards, TypeScript, Vite and bundle verification;
image `48dd9fe1c5221852124367809baec9b8d5c308e1d8b4304675b91444fb7b57e9`.
Final backend typecheck and `git diff --check`: **exit 0**.

From `portal/`:

```sh
npx playwright test playwright/dungeonEncounterAuthoring.spec.ts \
  playwright/dungeonSpeciesPools.spec.ts playwright/dungeonImport.spec.ts \
  playwright/dungeonImportV4.spec.ts playwright/dungeonSceneSprites.spec.ts \
  playwright/dungeonEvents.spec.ts playwright/dungeonLoot.spec.ts --workers=2
```

Result: **53 passed, 5 existing desktop-only flow skips on mobile**, against
the production Vite preview. No external Discord or staging connectivity used.

Baseline, separately in the working checkout and untouched HEAD archive
`/tmp/waifumon-p4d2-head` (archive with shared node_modules symlink):

```sh
TEST_DATABASE_URL=postgres://unused:unused@localhost/unused \
  npx vitest run tests/unit/dungeons/engineArchitecture.test.ts
```

Both produce **1 passed, 1 failed** with the identical four #0025 violations:
importer's `node:fs`, `drizzle-orm`, direct schema import, and enemy store's
`drizzle-orm`. No production source was modified to bypass this check.

The requested adjacent baseline reproduction was kept separate from the above:

```sh
npx vitest run tests/unit/bossRewards.test.ts tests/integration/affectionGifts.test.ts \
  tests/integration/buddy.test.ts tests/integration/buddyBonus.test.ts \
  --maxWorkers=2 --minWorkers=1
```

Run in both the working checkout and untouched `062424cf` archive with disposable
PostgreSQL: **105 passed, 27 failed, 4 failed files (132 tests)** in each.
The failed test names match exactly:

- #0085: two boss reward shipped-balance expectations (XP 70 versus 15 and
  documented reward quantities/weights).
- #0084: two affection gift shipped-content expectations (weight total 10,900
  versus 10,000; `cream_pie_slice` versus expected `fluffy_cuffs`).
- #0053: one Buddy hunt test exhausts its scripted RNG.
- #0052: one Buddy Bonus test sees a resolved encounter, followed by 21
  `capture_attempts` foreign-key cleanup failures (22 cases total).

These are unchanged baseline failures, not 27 independent Phase 4 defects. They
remain visible and unfixed; no assertions or balance content were weakened.
The known v2 receipt-order flake (#0092) and Portal LootCatalogue flake (#0093)
did not recur in the requested regressions. Existing Vite CJS/pg query deprecation
and Portal duplicate-request diagnostic warnings appeared without test failures.

The first sandboxed DB run failed before executing tests (localhost EPERM,
181 skipped); rerunning with local-network permission yielded the 181 passes
above. New fixture boundary expectations and two JSON assertion type errors
were corrected and verified (#0142/#0143); they required no production-code fix.

Final relevant backend evidence: **1,261 passed, 1 optional-artwork skip** across
the three nonoverlapping command sets, plus the separate baseline results above.
Portal: **346 passed**. Browsers: **53 passed, 5 skips**. Both typechecks,
production Portal container build and whitespace validation pass. Manual staging
acceptance remains pending.

## Production blockers and limitations

| Classification | Required action / limitation |
| --- | --- |
| Production-readiness sign-off | Record acceptance of design-described per-dungeon ledger scope (#0144); global limits would need separate approval |
| Production decision | Confirm narrower player activity isolation (#0113); global dungeon exclusivity is not implemented |
| Production acceptance | Complete and sign off the staging checklist, including real Discord delivery and duplicates |
| Operational gate | Review lock window/timeout, backups, pending 0065–0068 migrations and mixed-version/rollback restrictions |
| Known wider concurrency risk | No universal lock order for Care/item use/release; decide operational acceptance or separately scope remediation |
| Non-blocking scoped limitation | Environmental Scene Sprite packages are refused; use a sprite-free copy or keep content local |
| Non-blocking scoped limitation | Preview uses simulated neutral Buddy and standard success art; real owned-card delivery is a staging check |
| Non-blocking scoped limitation | No durable notification outbox; interrupted delivery may omit an announcement after a correct grant |
| Existing baseline | #0025 architecture failure remains, independently reproduced; no new violation |
| Historical limitation | Older publication species evidence stays unknown until republished |

No large Phase 4 architectural defect was found requiring a runtime repair in
the tested paths. P4D2 changes add tests and documentation only. Stop here;
Region Pool administration, Scene Sprite portability and deployment remain out
of scope.

## Files changed

- `tests/helpers/dungeonCaptureFixtures.ts` — new reusable isolated scenarios.
- `tests/integration/dungeonCapturesLifecycle.test.ts` — new integrated gameplay,
  policy, pinning, composition and SQL-failure tests.
- `tests/integration/dungeonEncountersMigration.test.ts` — new populated-0067
  migration, lock, tracking and constraint rehearsal.
- `tests/integration/dungeonPackageV4.test.ts` — destination gameplay, duplicate
  import, and continuation of a historical active run after replacement.
- `docs/dungeons/dungeon-captures-guide.md` — creator instructions and three examples.
- `docs/dungeons/phase4-release-readiness.md` — this report and staging checklist.

Project memory was updated only through its MCP tools; those updates may live
outside Git's tracked file list. Existing files were preserved. No work was committed.
Final branch and HEAD are unchanged. The final worktree contains **one modified
tracked file and five new files**, all listed above. Disposable PostgreSQL was
stopped after verification; no staging/production database was contacted.
