# Release polish: Equipment → Combat Trials → Delve

Progression and navigation for the first dungeon release:

**Equipment onboarding → clear the Combat Trials curriculum → Delve.**

All changes are uncommitted on `Delve` for review.

## 1. Starting state

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `de1d65d8c275c7f944b24acc0060caef323ccc4c` ("Add unit tests for dungeon bundle and species access review") |
| Working tree | clean (no unrelated changes to preserve) |

## 2. Equipment onboarding (unchanged)

- Onboarding state is derived (`modules/onboarding/onboardingState.ts`). It is
  `completed` once the permanent `equipment` row exists in
  `player_feature_unlocks`. The onboarding writes that row in the same
  transaction as the starter gear.
- Before this change, Combat Trials **and** Delve were both gated only on that
  unlock (`COMBAT_TRIAL_FEATURE = DUNGEON_FEATURE = 'equipment'`). The main
  menu showed both buttons as soon as Equipment was `available`.
- Onboarding rules, rewards and screens are unchanged. The one exception is
  the completion screen's Combat Trials pointer: it now appears only while the
  player has Trials left to fight (§7).

## 3. Combat Trials curriculum and completion tracking

- **Catalogue.** `content/combat/trials.json` holds three Trials, all tagged
  `starter` and `initial_tuning`: `trial_scrapyard_drone`,
  `trial_alley_bruiser` and `trial_security_automaton`. There are no optional
  or advanced Trials today.
- **Authoritative record.** `combat_trial_attempts`. A Trial is cleared when
  its row with `first_clear = true` exists. That row is written once, in the
  same transaction as the first-clear reward, under a `FOR UPDATE` lock on the
  player row. It is backed by the partial unique index
  `(player_id, trial_key) WHERE first_clear`, so it persists across restarts
  and cannot be duplicated.
- **Mandatory curriculum.** `COMBAT_TRIAL_CURRICULUM` in the new
  `src/modules/combatTrials/trialCurriculum.ts` is a frozen list of those
  three keys. It is deliberately **not** "every Trial in the file" and not a
  content tag (§4).

## 4. Delve unlock

**One decision:** `createDelveAccess({ db, featureUnlocks }).isUnlocked(playerId, tx?)`
is true when `equipment` is unlocked **and** every curriculum key has a
`first_clear` row (`readCurriculumProgress`).

- **No new flag and no migration.** The existing completion records are
  enough. Players who had already cleared all three Trials are unlocked
  immediately on deploy.
- **Stable.**
  - A Trial added in a later release is not in the list, so it cannot block
    Delve or revoke an unlock already earned.
  - Disabling a cleared curriculum Trial in content does not undo the unlock.
  - The file comment and `docs/combat-trials.md` warn never to append to the
    list. Because the unlock is derived, a new required key would re-lock
    players. A real curriculum change would first need a durable
    `player_feature_unlocks` key plus a backfill. That is the only case where
    the current model is not enough, and it is not needed now.
- **Wiring.** `delveAccess` is a **required** dependency of
  `createDungeonRunService`, so no wiring can leave the check out. The Trial
  service reads the same `readCurriculumProgress` with the same default
  curriculum.
- **Automatic.** The final clear's transaction writes the `first_clear` row,
  and Delve is unlocked from the next read. No administrator action is
  needed.

## 5. Combat Trials visibility and replay

**Existing contract (conflict reported).** `docs/combat-trials.md` documented
that "Trials can be repeated freely" because repeat clears pay nothing. Two
options were open:

- remove replay outright;
- retire the curriculum only once it is complete.

Removing replay outright would have broken that documented contract
mid-curriculum. The minimum compatible change is the second option:

| Stage | Behaviour |
| --- | --- |
| Curriculum in progress | Unchanged. Every Trial, cleared or not, can be fought again; repeats pay nothing. The list now says "Clear all 3 Trials to unlock **Delve** — N / 3 cleared." |
| Curriculum complete | Curriculum Trials are retired for that player. `list` leaves them out (and throws `CombatTrialsCompletedError` when nothing is left); `detail` and `fight` refuse them with `CombatTrialsCompletedError`. Trials outside the curriculum remain available. |

- **Fight order.** The refusal is checked after the request-key replay and
  under the player lock. A Discord retry of the final Fight therefore
  re-shows its result (with the unlock notice) and pays nothing. Two racing
  Fights on the final Trial produce one clear, one refusal and one reward.
- **Final-clear result screen.** It adds a **⛏️ Delve unlocked!** field. It
  offers no **Fight Again**, and **All Trials** only if non-curriculum Trials
  remain. The outcome carries `canFightAgain`, `trialsOpen` and
  `completedCurriculum`.
- **Stale `ct:*` buttons** (list, detail, Fight, Fight Again) land on
  "✅ You have completed the Combat Trials. ⛏️ Delve is now unlocked …" with
  **Back to Waifumon**.
- **Entry points removed.** All three now follow
  `combatTrialService.entryVisible`: the main-menu button, the Actions legend
  line, and the onboarding completion CTA (field and button). A stale `onb|done`
  click after completion no longer offers a dead Trials button.
- **Unchanged:** rewards, difficulty, recommendations, equipment calculations,
  existing attempts and first-clear rows.

## 6. Region-based Delve visibility

`dungeonRunService.entryVisible(playerId)` is true when either:

- the player has an **active run** (so nobody is stranded); or
- Delve is unlocked **and** `content.openDungeons()` has a dungeon whose
  `availableRegions` includes `players.current_region`.

`openDungeons` is the existing "open to players" query:

- `enabled = true`;
- joined to its published revision;
- an unreadable published revision is logged and hidden.

Drafts never count. A dungeon assigned to several regions matches in each.
No dungeon or region names are hard-coded.

- Temporary personal restrictions never hide the entry: no Buddy, incomplete
  loadout, daily limit spent, or a run already active. The home and detail
  screens and `start` keep their existing blockers and messages.
- The main menu reads `entryVisible` on every paint, together with the Trials
  entry. Travelling, clearing the last Trial, or an admin enabling or
  disabling a dungeon shows on the next menu. A failing read logs a warning
  and hides only that entry.
- With no eligible dungeon the button is **omitted**, never shown disabled.
  Rows are still chunked at five and never left empty.

## 7. Backend entry paths

| Path | Enforcement |
| --- | --- |
| `dg\|start\|<key>` (current or stale) → `dungeonRunService.start` | `DelveLockedError` inside the start transaction, after the player `FOR UPDATE` lock and the one-active-run check; nothing is spent. Then the existing `published(tx, key)` (missing / disabled / unpublished) and the region check off the locked player row. |
| `dg\|home` → `home` | Without an active run: `DelveLockedError`. With one: the run screen as before. Dungeons are listed only when Delve is unlocked. |
| `dg\|zone\|<key>` → `dungeon` | Without an active run: `DelveLockedError`. Then the existing published and region checks. |
| Discord handler (`waifumonDungeon.run`) | Maps `DelveLockedError`, including from recovery screens, to "🔒 Delve unlocks once you have cleared the Combat Trials." with **Combat Trials** and **Back to Waifumon**. |
| Collection capture-origin "Delve" button | Routes to `dg\|run` or `dg\|home`, so it is covered above. |
| HTTP API | No player route starts, lists or plays runs (checked `src/api/routes/**`). Admin sandbox is simulation only. Both new error codes are mapped: `DELVE_LOCKED` 422, `COMBAT_TRIALS_COMPLETED` 409. |
| Staging test controls / load testing | Neither starts dungeon runs. |
| `ct\|*` → `combatTrialService` | `requireUnlocked` as before, plus the curriculum retirement (§5). |

Unchanged:

- the `equipment` gate;
- the Buddy and loadout blockers;
- the shared daily allowance;
- the one-active-run lock (`players FOR UPDATE` + `dungeon_runs_one_active_uq`);
- the fighter reservation.

## 8. Active-run safeguards

The prerequisite applies only to **starting**. None of these check it:

- `activeRun` and `run`;
- `act` (every step, extraction, abandon — abandon also skips the `equipment`
  gate, as before);
- restart recovery (a new service over the same rows);
- `home` and `dungeon` while a run is active;
- `entryVisible` (true while a run is active).

Run snapshots, settlement, reward claims and the dungeon-exclusive acquisition
policy and ledger are untouched. Once a legacy run settles, the next start
needs the Trials. This is covered by tests that simulate a run holder whose
curriculum records are absent.

## 9. Files changed

New:

- `src/modules/combatTrials/trialCurriculum.ts`: curriculum, progress read,
  `createDelveAccess`.
- `tests/helpers/trialFixtures.ts`: writes real `first_clear` rows for test
  players.
- `tests/integration/trialsDelveProgression.test.ts`: 28 DB tests.
- `tests/unit/trialsDelveNavigation.test.ts`: 15 tests.
- `docs/release-polish-trials-delve-navigation.md`: this report.

Modified:

- `src/modules/combatTrials/combatTrialService.ts`: `entryVisible`, curriculum
  retirement, list progress, outcome flags.
- `src/modules/dungeons/dungeonRunService.ts`: required `delveAccess`,
  `entryVisible`, start/home/dungeon gating.
- `src/index.ts`: wires `createDelveAccess`.
- `src/shared/errors.ts`: `CombatTrialsCompletedError`, `DelveLockedError`.
- `src/api/errors.ts`: status mappings.
- `src/discord/commands/waifumon.ts`: per-player menu visibility via
  `entryVisible`.
- `src/discord/combatTrialPresenter.ts`: progress line, final-clear notice and
  buttons, `completedTrialsView`.
- `src/discord/commands/waifumonCombatTrials.ts`: completed-error mapping;
  Fight Again only when `canFightAgain`.
- `src/discord/dungeonPresenter.ts`: `delveLockedView`.
- `src/discord/commands/waifumonDungeon.ts`: `DelveLockedError` mapping.
- `src/discord/onboardingPresenter.ts`, `src/discord/commands/waifumonOnboarding.ts`:
  the completion CTA follows `entryVisible`.
- `docs/combat-trials.md`, `docs/dungeons.md`: curriculum, replay change and
  Delve unlock.
- `tests/helpers/dungeonWorld.ts`: wires `delveAccess`; `player()` defaults
  `trials: true`.
- `tests/integration/dungeonDiscord.test.ts`: restart wiring.
- `tests/integration/enemyCatalogue.test.ts`: `trials: false` for the two
  Trial-fighting players.
- `tests/unit/combatTrialsDiscord.test.ts`,
  `tests/unit/equipmentCombatBonusesDiscord.test.ts`: fixtures gain the new
  view fields.

No Portal, migration, content, reward, combat, equipment, dungeon-authoring,
packaging or species-policy change.

## 10. Tests

**New tests, mapped to the acceptance list:**

| # | Covered by |
| --- | --- |
| 1 | Stage A |
| 2, 12 | Stage B: no Trial cleared |
| 3, 11 | Stage B: some cleared (re-fight pays nothing, Delve locked) |
| 4, 5, 23 | Stage C: final Trial |
| 6 | Stale open/Fight refused; stale Discord `ct` buttons |
| 7, 8 | Restart test; retried final Fight; concurrent final clears |
| 9 | Optional Trial (both tests) |
| 10 | "added to the catalogue later"; disabled-after-clear |
| 13–17 | `it.each` over six regions (none, draft, disabled, live, two shared regions) |
| 18 | Travel test |
| 19 | No Buddy, ungeared and active-run restrictions |
| 20, 21 | Direct start/home/dungeon; stale Discord `dg` home/zone/start |
| 22 | Disable then unpublish after the menu was drawn |
| 24 | Legacy run holder: resume, step, extract after restart; abandon |
| 25 | Region and publication checks after unlock |
| Menu / Discord rows | Unit: menu permutations with row validity, real `handleMenuStart` with stub services (including a failing read), result-screen buttons, list progress, completed and locked views, onboarding CTA, shipped `trials.json` carries every curriculum key enabled, error mappings |

A mutation check (start-transaction check removed) fails 4 of the new
integration tests. The file was restored afterwards.

**Runs** (podman Postgres 16, `TEST_DATABASE_URL`):

- `npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run build`: OK.
- New files: 28/28 and 15/15.
- Focused regression (117 files: every dungeon, Trial, onboarding, menu,
  travel and combat suite, plus `unit/api/errors`): **2453 passed, 1 skipped,
  10 failed**.
- **All 10 failures reproduce identically on an isolated untouched-HEAD
  worktree** (`de1d65d8`, same 9 files, 10/10). They are baseline:
  - `api/adminEnemies` shipped-edit;
  - `dungeonContent` table list;
  - `giftAndCaptureUi` ×2 (#0149);
  - `travel` regional shop stock;
  - `unit/api/errors` (`EquipmentConfigInvalidError` junk-argument crash);
  - `combatEnemyContent` descriptions;
  - `engineArchitecture` (#0025);
  - `equipmentOnboardingContent` Patch portrait;
  - `onboardingArtwork` shipped intro art.
- Because `unit/api/errors` aborts before reaching the new classes, their
  mapping is asserted in `trialsDelveNavigation.test.ts`.
- One existing Trial-list test failed during development: the new progress
  field shifted the embed field indexes. The line was moved into the
  description; that suite passes 39/39.
- Not run: the full root suite (the focused results did not call for it) and
  Portal checks (no Portal code changed).

## 11. Migration and deployment

- **No migration.** Rebuild and redeploy the bot only.
- On deploy, a player with Equipment but without all three first clears loses
  the Delve entry until they finish the Trials. A run already active is
  unaffected. Players who already cleared all three keep Delve without action.
- QA and staging accounts must actually clear the three Trials. There is
  deliberately no admin grant path.

## 12. Limitations and follow-ups

- **The curriculum is a code constant.** If a curriculum Trial were removed or
  disabled in `trials.json`, players who have not yet cleared it could not
  unlock Delve. Its stale buttons still refuse safely, and the Stage B list
  says "No Trials are available". A unit test guards the shipped file.
- **Future curriculum changes need a durable unlock first** (see §4).
- **Revoking `equipment`** (staging control only) also re-locks starting a
  Delve, because both are required. Existing runs are unaffected.
- **#0113 still applies.** Apart from the one-active-run lock there is no
  cross-system "activity lock"; this task did not add one.
- **No release blockers found** in this scope.
