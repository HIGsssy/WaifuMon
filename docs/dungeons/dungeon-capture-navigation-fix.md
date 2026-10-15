# Dungeon capture navigation and duplicate handling

Implemented on `Delve`, starting at HEAD
`b9ec06fd4cef0ee3b613e830d7dcb418378340b1` with a clean working tree.
All changes remain uncommitted. No subagents, commits, pushes, merges, deployment,
new migrations, staging/production migrations, probability/economy changes or
progression refactors were used. Existing integration migrations run only in
disposable local PostgreSQL test databases.

## Root cause and interaction flow

Dungeon acquisition results called `duplicatePromptComponents` without an
origin. That emitted ordinary `dup|keep|<copy>` and `dup|convert|<copy>` IDs.
The ordinary collection handlers always appended `withBackRow()`, which leads
to the normal WaifuMon menu. Independently, `buildRunScreen` always appended
Back to Waifumon, including active capture screens.

Before: dungeon capture → ordinary duplicate action → confirmation/conversion
with Back to menu → main game → manually open Delve and Resume.

After:

- New capture → acquired card/unchanged XP receipt → **Continue the Delve**.
- Duplicate capture → dungeon **Keep Duplicate** → kept confirmation →
  **Continue the Delve**.
- Duplicate capture → dungeon **Convert to Essence** → existing committed
  conversion presentation, payout and balance → **Continue the Delve**.
- Continue uses existing `dg|run|<runId>` and the existing run presenter. It
  reads the current state of that specific run without an `act()` call. If the
  next step is a pending encounter, Event, fight or path, it is still pending.
  The next authored path button (for example Off we go) appears on that screen.

The acquisition result temporarily presents Continue in place of actionable
next-step controls. It does not postpone or redo the engine's already committed
authored routing. Active run/home/detail screens keep Delve navigation instead
of offering a main-menu exit. Abandon still uses the existing confirmation.
Finished runs and pre-run menus keep their existing normal navigation.

## Context, authorization and transaction boundaries

New IDs are `dg|dk|<runId>|<resultStep>|<copyId>` and
`dg|dc|<runId>|<resultStep>|<copyId>`, within the existing versioned custom-ID
envelope. They stay under Discord's 100-character limit. The new rows remain
within component/row limits, checked against every rendered test screen.

The collection service validates the explicit dungeon context inside the same
transaction as conversion. It requires:

1. Valid integer identifiers and step.
2. A run belonging to the acting player, still active at the named result step.
3. An acquisition-ledger row for that player/run/copy.
4. A matching `waifu_acquired` history record at that step, with the same grant
   key and copy ID, a true duplicate result, and no replayed rescue.
5. The actual owned copy's matching grant key and dungeon provenance.

Run → player currencies → player → owned copy locks follow the dungeon capture
order for these scoped operations. Advancing/ending the run cannot race between
validation and conversion. Keep uses the same context validation and writes
nothing: ownership was already committed during capture.

Conversion still calls `convertDuplicateToEssence` and its existing `softRelease`
transaction. Rarity value, live Buddy Essence modifiers, favourite/Buddy/
expedition/dungeon reservations, duplicate count, currency award and quest credit
are unchanged. A released copy cannot be converted again; concurrent duplicate
presses award Essence and conversion-quest credit once.

Substituting a pre-existing copy, a foreign player's copy, a new copy with an old
result step, or an old copy with a new step fails without mutation. A non-duplicate
acquisition cannot use these controls. The original pinned fighter remains
protected by existing availability rules.

An ended run refuses the decision and offers Delve menu without an invalid
Continue button. Missing/foreign run context gets a safe not-found response.
An old Continue names its original run even if the player has since started
another: it cannot act on the new run. If the run ends after the decision commits
but before navigation is rendered, only ended-run navigation is shown.

## Normal world captures and existing isolation

World captures keep ordinary `dup` IDs, the existing Keep/Convert behavior and
Back to menu. Inspect/release/collection navigation is unchanged. Shared
conversion result rendering now accepts navigation from its caller; ordinary
callers continue supplying their original rows.

Older dungeon messages already carrying generic `dup` IDs are identified from
their persistent acquisition ledger, including copies already released. They
are not processed through the world conversion path. They explain that the old
button is out of date, leave ownership/currency unchanged and offer safe Delve
navigation. Conversion requires a current scoped prompt; an aged-out prompt
defaults to retaining the already-owned copy, which can be managed through the
existing collection workflow when appropriate.

Existing isolation is the implemented narrower policy (#0113): one active run
and reservation of its pinned fighter, rather than a global ban on every other
player activity. This fix does not create or relax global activity rules. Its
new conversion path is explicitly limited to the newly acquired duplicate;
it grants no general collection access or exemption from protected-copy checks.

Restart/resume uses persisted run, acquisition and history state, not process
memory or message appearance. Repaint does not replay acquisition receipts,
announcements, grants, XP, charm use or dungeon actions. Keep is a harmless
repeatable confirmation; it does not persist an irreversible decision flag.
After the run moves, the old decision is stale. No schema change is needed.

## Verification

All integration commands below use only:

```sh
export TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/test
```

Each integration file creates/migrates/drops its own disposable database.
No Discord connectivity is required; network transport/card artwork are stubbed
while the handlers, run/capture/collection services, transactions and database
are real.

Focused commands:

```sh
npx vitest run tests/integration/dungeonEncountersDiscord.test.ts \
  tests/integration/dungeonDiscord.test.ts tests/integration/collection.test.ts \
  tests/unit/dungeons/dungeonPresenter.test.ts tests/unit/collectionUxPass.test.ts \
  tests/unit/resultPresentationExtraKeys.test.ts --maxWorkers=2 --minWorkers=1
```

**160/160 passed**, including **40 dungeon encounter Discord cases** (15 new).
New cases cover all requested navigation, replay, ownership, stale-copy, ended-run,
restart, read-only resume and isolation scenarios, plus old generic prompts.

Additional regression command:

```sh
npx vitest run tests/integration/capture.test.ts tests/integration/captureItems.test.ts \
  tests/integration/captureExtraction.test.ts tests/integration/captureConcurrency.test.ts \
  tests/integration/dungeonEncountersLive.test.ts tests/integration/dungeonCapturesLifecycle.test.ts \
  tests/integration/collectionBrowser.test.ts tests/unit/collectionGrouping.test.ts \
  tests/unit/collectionFilterTracker.test.ts tests/unit/encounterDuplicateCard.test.ts \
  tests/unit/dungeons/dungeonEncounters.test.ts tests/unit/dungeons/dungeonEncounterArtwork.test.ts \
  tests/integration/dungeonRuns.test.ts tests/integration/dungeonEventsDiscord.test.ts \
  tests/integration/dungeonRewardDiscord.test.ts --maxWorkers=2 --minWorkers=1
```

Initial result: 332 passed, one Event navigation assertion still expected Back to
Waifumon. Updated it to Delve menu while retaining every Event-choice assertion.
The affected suites were then rerun:

```sh
npx vitest run tests/integration/dungeonEventsDiscord.test.ts \
  tests/integration/dungeonEncountersDiscord.test.ts tests/integration/collection.test.ts \
  --maxWorkers=2 --minWorkers=1
```

Final affected result: **80/80 passed** (40 encounter Discord, 28 collection,
12 Event Discord). Other 14 regression files passed,
including all 10 existing capture-concurrency cases.

Ordinary world capture presentation regressions:

```sh
npx vitest run tests/unit/huntResultScreens.test.ts tests/unit/huntResultPresentation.test.ts \
  tests/integration/giftAndCaptureUi.test.ts --maxWorkers=2 --minWorkers=1
npm run typecheck
git diff --check
```

Result: **54 passed, 2 baseline failures**. Both pure hunt presentation suites
pass. The two `giftAndCaptureUi` main-menu cases omit the travel service in their
fixture and throw at `renderMainMenu`'s `getCurrentRegion` call; untouched HEAD
reproduction is recorded below. Backend typecheck and `git diff --check` pass.

Baseline separately, in both this checkout and the untouched HEAD archive
`/tmp/waifumon-dungeon-nav-head`:

```sh
TEST_DATABASE_URL=postgres://unused:unused@localhost/unused \
  npx vitest run tests/unit/api/errors.test.ts
```

**8 passed, 1 existing failure** in each: the reflection fixture constructs
`DungeonImportError` with a Date in place of its issues array and throws
`issues.map is not a function` (#0147). It was not weakened or fixed as part of
this navigation change. The new dungeon-decision error has an explicit HTTP409
mapping. Initial import/test-fixture errors in this patch were corrected and
logged (#0146/#0148).

Untouched HEAD also reproduces the world-menu fixture failures:

```sh
npx vitest run tests/integration/giftAndCaptureUi.test.ts --maxWorkers=1 --minWorkers=1
```

**16 passed, the same 2 failed** (#0149). No main-menu code or these fixtures
were changed. Both pure hunt presentation files pass **38/38**.

Final maximum-ID/Discord-limit verification:

```sh
npx vitest run tests/integration/dungeonEncountersDiscord.test.ts --maxWorkers=1 --minWorkers=1
```

**40/40 passed**. Final backend typecheck and tracked/new-file whitespace checks
pass. The six-file focused set and the corrected 15-file regression set account
for **493 passing cases** across their verification runs; shared world UI adds
54 passes and the 2 independently reproduced baseline failures. The API error
baseline separately adds 8 passes and its 1 reproduced failure.

## Changed files

- `src/discord/dungeonPresenter.ts` — Continue and Delve navigation; scoped IDs.
- `src/discord/commands/waifumonDungeon.ts` — dungeon decision handlers and rows.
- `src/discord/commands/waifumonCollection.ts` — origin-aware prompt IDs, shared
  committed conversion rendering, safe legacy dungeon-button handling.
- `src/discord/client.ts` — register new routes; pass legacy Keep arguments.
- `src/modules/collection/collectionService.ts` — atomic scoped validation and
  Keep/origin reads, reusing the existing conversion transaction.
- `src/shared/errors.ts`, `src/api/errors.ts` — safe stale-context error/mapping.
- `tests/integration/dungeonEncountersDiscord.test.ts` — 15 new scenarios and
  updated capture-result expectations.
- `tests/integration/dungeonDiscord.test.ts`,
  `tests/integration/dungeonEventsDiscord.test.ts` — active navigation assertions.
- `tests/unit/resultPresentationExtraKeys.test.ts` — world-origin mock contract.
- `docs/dungeons/dungeon-capture-navigation-fix.md` — this report.

Manual staging validation remains necessary after an independently authorized
deployment, particularly the real ephemeral-message Keep/Convert → Continue
flow. This task does not deploy the fix.
