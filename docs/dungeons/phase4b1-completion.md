# Phase 4B1 completion — dungeon encounter core runtime

Completed locally on 2026-10-12. Branch `Delve`, unchanged HEAD
`e7f8f0ba2eb8baa94d69844de72629f94974dbaf`. All changes are uncommitted.
The pre-existing untracked `docs/dungeons/phase4-captures-design.md` was preserved
without modification. No subagents, commits, pushes, merges, deployments or
migrations were used.

## 1. Files changed

26 task files, including this report:

| File | Change |
| --- | --- |
| `src/modules/dungeons/content/dungeonEncounters.ts` | New pool/source/capture/result schemas, acquisition-policy boundary and content helpers |
| `src/modules/dungeons/content/dungeonDefinition.ts` | Optional species pools and the two encounter activities |
| `src/modules/dungeons/content/dungeonRewardSites.ts` | Structural source union accepts species sources; event traversal explicitly narrows to event sources |
| `src/modules/dungeons/engine/encounters.ts` | Pool analysis, selection, availability, charm filtering, attempt/rescue decisions and view |
| `src/modules/dungeons/engine/types.ts` | JSON-safe instances, facts, inputs, refusals, effects, simulated receipts and recent results |
| `src/modules/dungeons/engine/step.ts` | Arrival, input handling, terminal flags and routing, selection preservation |
| `src/modules/dungeons/engine/routing.ts` | Encounter outcomes use `next` unless explicitly routed |
| `src/modules/dungeons/engine/view.ts` | Optional encounter view on encounter actions only |
| `src/modules/dungeons/engine/sandbox.ts` | Simulated effect receipts, injected encounter facts and autoplay inputs |
| `src/modules/dungeons/engine/index.ts` | Exports the pure encounter module |
| `src/modules/dungeons/validation/dungeonEncounterValidation.ts` | Structural checks, pure policy predicate, future live adapter and temporary gate |
| `src/modules/dungeons/validation/dungeonValidation.ts` | Dedicated issues, encounter validation and flag producer integration |
| `src/modules/dungeons/dungeonContentService.ts` | Publication-readiness, publish, rollback and export gates |
| `src/modules/dungeons/dungeonRunService.ts` | Run start/action gates, explicit rejection of live capture/rescue effects and receipt narrowing |
| `src/modules/dungeons/package/dungeonPackage.ts` | Build/read refusal for encounter content in v1/v2/v3 |
| `src/discord/dungeonPresenter.ts` | Exhaustive label maps accept new action types for compilation; no encounter controls or presentation flow |
| `portal/src/api/adminDungeons.ts` | Tolerant species source union and optional pool DTO |
| `portal/src/features/adminDungeons/ActivityCard.tsx` | Read-only encounter/rescue cards, including stored configuration and referenced pool |
| `portal/src/features/adminDungeons/EventActivity.tsx` | Narrows event picker source |
| `portal/src/features/adminDungeons/dungeonEventModel.ts` | Narrows event-only activity sources |
| `portal/src/features/adminDungeons/dungeonText.ts` | Guards the event reader from species sources |
| `portal/src/features/adminDungeons/__tests__/DungeonEncounters.test.tsx` | Save/reload preservation and read-only/menu coverage |
| `tests/unit/dungeons/dungeonEncounters.test.ts` | 60 pure encounter, pool, policy, validation and sandbox cases |
| `tests/unit/dungeons/dungeonEncounterGates.test.ts` | 4 real service-boundary gate cases using read-only DB doubles |
| `tests/unit/dungeons/dungeonPhase4Compatibility.test.ts` | 2 untouched-HEAD package/engine golden comparisons |
| `docs/dungeons/phase4b1-completion.md` | This completion report |

## 2. Schema and runtime behaviour

`speciesPools` is optional with no default. Pools contain weighted species or
Nothing entries, optional conditions and species `oncePerRun` (default true on
new entries). Multiple pools and references are supported. Species are portable
slugs. No new fields are materialised on existing definitions or states.

`wild_encounter` and `rescue` support named species or pool sources, intro,
conditions, existing `SpritePlacement`, mirror, environmental sprite placements,
result text, declared run-flag writes and outcome routes. Wild encounters require
capture rules. Rescue mode is `capture` or `direct`; capture rules are required in
capture mode and forbidden in direct mode. Capture rules default to three
attempts and permit guaranteed items, with optional allowed-item restrictions.

A selection is stored separately from action records under
`state.encounters["room:action"]`. Charm selection is its own step. Each capture
attempt records its number, chosen item, quoted chance, roll, success and step.
Failure below the limit leaves the encounter offered; the final failure escapes.
Success resolves `captured` or `rescued`; Leave, Nothing and unavailable all
resolve and route. Terminal result flags apply once. Resolved encounters survive
retreat elsewhere in the sequence without granting or applying flags again.

`capture_attempt` and `rescue_grant` describe work for a port. They carry stable
attempt/grant keys and deterministic SP draws. They do not spend charms,
Microdose, inventory, or create ownership/XP/quest writes. Capture quotes are
injected facts, intended to come from the existing formula using the pinned
Buddy in P4B2. The engine validates quote ranges and applies authored restrictions;
it implements no duplicate capture formula.

The approved acquisition policy is represented by
`DungeonSpeciesAccessSchema`: positive safe integer or explicit `"unlimited"`,
with no default when missing. Ordinary capture has no finite limit when omitted.
Direct rescue needs explicit authorization and a finite limit. The pure policy
predicate accepts a cross-run acquisition count; the future live adapter must
read and enforce it transactionally. Policy is not yet added to species loading,
hunting, spawning or database storage. Direct-rescue availability is a separate,
explicit fact and is rechecked before emitting the grant effect.

## 3. Deterministic selection guarantees

Streams are derived from the existing dungeon run seed and the site:

- Pool: `('encounter', roomId, actionId, 'pool')`.
- Attempt n: `('encounter', roomId, actionId, 'attempt', n)`.
- Granted SP: `('encounter', roomId, actionId, 'sp')`.

Analysis and selection share the same integer-weight eligibility calculation.
Only conditions and once-per-run history alter eligibility. Live disabled,
missing, restricted or limit-reached species retain their weights and resolve
`unavailable` when selected; their probability is never redistributed.

Stored instances are reused on re-entry even if selection conditions change.
`expectedStep` rejects stale inputs without mutation or effects. JSON state
round-trips, retries from the same input state and unrelated random streams retain
the selection and attempt/SP draws. These are pure guarantees; production
concurrent-write and transaction guarantees remain P4B2 work.

## 4. Validation and sandbox coverage

Structural validation checks pool references and identities, duplicate species,
invalid weights, species-free pools, unused/impossible pools, capture settings,
duplicate allowed items, incompatible outcomes, retreat routing, optional
encounters, undeclared/player-scoped result flags and configured ceilings:
30 pools, 50 entries each, 40 encounters, three direct rescues, three attempts,
four flag writes per result. Existing graph validation continues checking routes
and unreachable actions/rooms. Ungated direct rescues produce a warning.

`DungeonEncounterValidationSource` defines current species policy, item status
and usable-item checks. Pure validation can consume it, but no live DB adapter is
wired in P4B1. Live rarity-share/sprite diagnostics and catalogue-policy wiring
remain follow-up work.

The sandbox receives simulated species/item facts and records the new effects.
Receipts explicitly say `simulated: true`. It has no path to player inventory,
ownership, progression or quests. Injected inventory and facts stay unchanged;
quantities are scenario assumptions, not a simulated transactional ledger.

Tests cover pool odds/draw agreement, conditions, Nothing and empty eligibility,
once-per-run exclusion, named encounters, multiple pools/references, stream
isolation, state replay/re-entry, max attempts, all outcomes and explicit routes,
flags, stale/wrong inputs, invalid/stale item facts, guaranteed/Microdose rules,
availability changes, direct authorization, cross-run policy-count predicates,
validation, sandbox isolation and temporary gates.

## 5. Compatibility and temporary gates

Pure validation and sandbox execution can inspect encounter drafts. Production
publication readiness reports `encounters_not_live`. Publish, rollback, live run
start and live action execution refuse encounter-bearing definitions. The live
port also explicitly throws if handed a capture/rescue effect. Definitions with
a species-pool member are gated even when that library is unused.

Package construction/export/reading refuse encounter content pending package v4.
The reader reports `package_encounters_unsupported`, so inspection/import cannot
accept disguised v1/v2/v3 encounters. The existing Scene Sprites refusal keeps its
precedence. No package v4 implementation is included.

The Portal retains the new optional content through unrelated edits and saves.
Encounter cards offer read-only inspection; no encounter authoring, duplicate,
remove, advanced-options or sprite-edit controls are exposed on those cards.
The activity add menu remains unchanged. Event-only readers are narrowed so
species sources are not mistaken for event pools.

Legacy package bytes, definition hashes and full legacy engine state/effects/log
are compared against goldens generated from an isolated archive of untouched
HEAD `e7f8f0b`. Existing Phase 3 goldens also pass. Database schema, event-type
constants, migrations, `captureService`, hunting behaviour, rarity weights,
regional pools and species content were not modified.

## 6. Exact verification results

| Check | Result |
| --- | --- |
| `TEST_DATABASE_URL=postgres://unused:unused@localhost/unused npx vitest run tests/unit/dungeons tests/unit/captureMath.test.ts` | 27 files, 638 tests: **636 passed, 1 baseline failure, 1 existing optional-artwork skip** |
| New encounter suite | **60/60 passed** |
| New service gates | **4/4 passed**, exercising publish/rollback/export/start before writes |
| New untouched-HEAD compatibility suite | **2/2 passed**, checking v1/v2/v3 bytes/hashes and legacy engine output |
| `npm --prefix portal test -- src/features/adminDungeons src/features/adminDungeonLoot --maxWorkers=4 --minWorkers=1` | **32 files, 320/320 passed**, including 3 new encounter cases |
| `npm run typecheck` | Passed |
| `npm --prefix portal run typecheck` | Passed |
| `git diff --check` | Passed |
| Untouched HEAD architecture reproduction | 2 tests: 1 passed, **same 1 baseline failure** |

Baseline failure, separately: `engineArchitecture.test.ts` reports four existing
offenders: the dungeon importer imports `node:fs`, `drizzle-orm` and the DB schema;
`enemyStore.ts` imports `drizzle-orm`. This is recorded project issue #0025 and
reproduces identically on the isolated untouched HEAD. It was not changed.

The unused database URL bypasses global container setup for these unit suites;
no DB connection, integration migration or live database operation was performed.
No browser/build/deployment checks were needed for this pure runtime and
read-only Portal change. Initial source-union compile failures and new fixture
errors were corrected and recorded in projectmem; final checks above are current.

## 7. Remaining P4B2 work

- Extract `quoteSpecies`, `resolveCaptureAttempt` and `grantSpeciesCopy` from
  `captureService` with hunted-capture behaviour/breakdowns preserved.
- Wire species `dungeonAccess`/exclusive tags into content loading and policy;
  protect hunt fallbacks and scripted spawns without changing ordinary selection.
- Add and apply the separately reviewed encounter-state/acquisition-ledger/history
  migration. Persist the existing JSON-safe instance shape.
- Supply current species, allowed-charm, pinned-Buddy and Microdose facts inside
  the step transaction. Wire the live validation adapter at publication/rollback.
- Enforce finite acquisition limits across runs under appropriate locks; consume
  charms/Microdose and grant ownership, ledger, XP and quests atomically, using
  the effect keys and existing ownership grant-key uniqueness.
- Verify rollback/retry equivalence, concurrent duplicate presses, inventory races,
  cross-run limits, availability changes and hunt/dungeon lock ordering against
  disposable PostgreSQL before removing the live gates.

Discord encounter flows and full Portal authoring remain P4C1/P4C2; package v4
remains P4D. P4B1 stops here.
