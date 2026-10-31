# Release blocker: Enemy ZIP import could not be completed

**Status:** fixed and verified locally, uncommitted on `Delve`. Staging acceptance is still to do (see [section 8](#8-staging-acceptance-steps)).

## 1. Starting repository state

| | |
|---|---|
| Branch | `Delve` |
| HEAD | `44c8512d4b06fd51bc7b820919e9476fa4cf18cc` |
| Working tree | Clean |

## 2. Reproduction

The unmodified Portal production bundle ran in Chromium at 1280×720 and on Pixel 5 (393 px wide). Requests went through a real HTTP proxy to a real Platform API on disposable Postgres, with real session cookies and CSRF headers. The API was the only real backend involved: `/auth/session` and unrelated Portal routes were stubbed.

Packages were real ZIPs exported from a second isolated environment, each with full art and a sprite for every enemy. Between them they contained:

- new enemies
- identical existing enemies
- changed enemies
- conflicting enemies, used by a published dungeon

**Steps:**

1. Open `/admin/enemies/import`.
2. Upload a package and wait for the review.
3. Choose Update or Keep for each changed enemy.
4. Look for a way to finish.

**Results, unmodified code:**

| Scenario | Apply action | API |
|---|---|---|
| Identical enemies only | **Never rendered** ("Nothing to import") | Preview only |
| All conflicts kept, nothing new | **Never rendered** ("Nothing to import") | Preview only |
| Any decision outstanding | **Never rendered**; only a count at the bottom of the page, which reached 5,287 px on desktop and 7,279 px on mobile | Preview only |
| All decided, 1 new + 1 conflict (Update) on desktop | Rendered **disabled and off-screen** (y=763 in a 720 px viewport), behind a separate checkbox | Preview only until both are found |
| All decided, some writes, checkbox ticked | Works | Apply 200 |
| `enemies.write` without `artwork.write` | Full review, then a 403 showing only "Could not import" | Apply 403 |

**Questions asked in the brief:**

| Question | Finding |
|---|---|
| Does the Apply button exist? | Yes, conditionally. It was labelled "Import" |
| Hidden, disabled, off-screen or never rendered? | All but hidden, depending on the state (table above) |
| Unresolved conflicts miscounted? | No, with one edge case: an enemy keyed `constructor` counted as already decided, because decisions were held in a plain object |
| State resets after choosing? | No |
| Review tokens or plan hashes missing? | No. `planHash`, `requestId` and `decisions` were all correct whenever apply was sent |
| Apply API invoked? | Not in the dead-end states. It succeeded every time it was sent with permission |
| Permission failures? | Not the main cause, but a real secondary trap (`artwork.write`) |

The backend needed no change. It already accepts an apply that writes nothing.

## 3. Root cause

`EnemyImportPage` tied its only completion action to this condition:

```ts
plan.ok && writes > 0 && undecided.length === 0
```

`writes` counts new enemies plus those set to Update. That caused two failures:

1. **A true dead end.** Keeping every conflict in a package with no new enemies, or uploading an identical package, made `writes` zero. The page showed a passive "Nothing to import" with no action and no API call, so the administrator's decisions were never submitted and no receipt existed.
2. **An action that could not be discovered.** While any decision was outstanding, the action did not exist. The only hint was an unnamed count at the bottom of a long page. When the last decision was made, the button could appear below the fold, disabled, behind a separate checkbox. In that case nothing visibly changed on screen.

The local reproduction shows both failures. It cannot show which one the staging administrator hit, since I had no access to that session or package. The reported steps fit either.

## 4. Exact fix

The fix is in the Portal page only. The importer, routes, schemas, migrations and package format are unchanged.

- **The review always ends in Apply Import.** It sits in a bar that sticks to the bottom of the viewport on desktop and mobile, and stays visible (disabled with its reason) until the review is complete.
- **Blockers are named.** The bar lists the enemies still needing a decision (up to five names, then "and N more"). Each undecided row has a "Decision needed" badge, and **Go to next decision** scrolls to and focuses the next one.
- **Zero-write imports complete.** The decisions reach the existing apply endpoint and a receipt comes back. The confirmation says plainly that no enemy will change.
- **Explicit confirmation.** A dialog replaces the checkbox and lists what will be created, updated, kept and left unchanged, and how many images will be added. The image count covers only enemies actually being written.
- **Permission explained up front.** Without `artwork.write`, the page says so and does not attempt the apply. The server still enforces it.
- **No double submission.** A synchronous guard covers clicks that land before React re-renders. Decisions and the file input lock while an apply runs.
- **Correct retry identity.** `requestId` is now per preview and set of decisions. Retrying the same decisions replays safely. Changed decisions count as a new request; previously they would have hit `ENEMY_IMPORT_REQUEST_CONFLICT`.
- **Actionable errors.**
  - The server's reason and any issue list are shown.
  - An import still running says to wait.
  - A refused plan disables Apply Import until **Check again** produces a fresh review.
- **Receipt.** It lists created, updated, kept, unchanged and reused or added images, and links **Back to Enemy Catalogue**. Focus moves to it. **Import another** can now take the same file again.
- **Wording.** "Keep current" is now "Keep Existing", and "Import" is now "Apply Import".
- **Decision storage.** Decisions are held in a `Map`, which removes the `constructor` key bug.

**One behaviour to be aware of:** an apply that writes nothing now leaves an `applied` row in `enemy_package_imports`. This uses the existing journal and creates no enemies or assets.

## 5. Backend safety

All of these code paths are unchanged, and the tests in section 7 exercise them:

- New enemies start disabled, and existing activation states are kept.
- Update and Keep decisions stay explicit; missing decisions are refused with a 409.
- Revisions and optimistic concurrency.
- Stale review protection through the plan hash.
- Asset hash and category validation.
- Destination-local artwork rebinding.
- Atomic writes.
- Journal, retry and recovery.
- CSRF and permission enforcement. A direct apply without `artwork.write` still returned 403 in the real-stack run.

## 6. Files changed

| File | Change |
|---|---|
| `portal/src/features/adminEnemies/EnemyImportPage.tsx` | The fix |
| `portal/src/api/adminEnemies.ts` | Comment wording only |
| `portal/src/features/adminEnemies/__tests__/EnemyPackages.test.tsx` | Existing import tests updated, regression tests added |
| `portal/playwright/enemyImport.spec.ts` | New browser spec, desktop and mobile |
| `tests/integration/enemyPackages.test.ts` | New test pinning the zero-write apply and its receipt |
| `docs/content-portability-cp3-completion.md` | Updated to describe the new flow |
| `docs/release-blockers/enemy-import-apply-fix.md` | This report |

## 7. Test coverage and results

**Coverage:**

| Required case | Portal tests | Committed browser spec | Real-stack run |
|---|---|---|---|
| All-new package | ✓ | ✓ | ✓ |
| Mixed new, identical and conflicting | ✓ | ✓ | ✓ |
| One unresolved conflict | ✓ | ✓ | ✓ (several outstanding) |
| All conflicts resolved | ✓ | ✓ | ✓ |
| Update choice | ✓ | ✓ | ✓ persisted |
| Keep Existing choice | ✓ | ✓ | ✓ persisted |
| Visible, enabled Apply Import | ✓ | ✓ in viewport | ✓ in viewport |
| Correct apply payload | ✓ | ✓ query string | ✓ accepted by the API |
| Successful result | ✓ | ✓ | ✓ |
| Backend rejection | ✓ | Not covered | Not covered |
| Stale plan | ✓ | ✓ | ✓ real concurrent apply |
| No double submission | ✓ | ✓ double click | ✓ double click, one request |
| Desktop and mobile | Not applicable | ✓ both | ✓ both |

The real-stack run is a scratch harness and is not committed. The committed browser spec uses stubbed API responses, as the rest of the Playwright suite does.

**Results on the final code:**

| Check | Result |
|---|---|
| Portal `adminEnemies` tests | 71/71 |
| Full Portal suite | 2040/2041; the one failure is listed below |
| Committed `enemyImport.spec.ts` | 10/10 (5 tests × 2 viewports) |
| Real-stack browser run | 12/12 (6 scenarios × 2 viewports) |
| `tests/integration/enemyPackages.test.ts` | 30/30 |
| Focused API set (`enemyPackages`, `adminEnemies`, `enemyCatalogue`, `dungeonBundles`) | 93/94; the one failure is listed below |
| Portal typecheck, root typecheck | 0 errors |
| Portal ESLint on changed files | 0 errors, 1 existing warning (`describeSlot` export, fast refresh) |
| Portal production build | OK |
| `verify-bundle` | OK, 170 files, no dev-only code |

The focused API set last ran before the final Portal-only edit, and `enemyPackages` was rerun after it. `dungeonImport.spec.ts` passed 10/10 just before that same edit, which does not touch dungeon code.

**Pre-existing failures, both reproduced on an isolated checkout of untouched HEAD:**

- `portal/src/__tests__/architecture.test.ts`: "only explicit API helpers issue browser-authenticated writes" (open issue #0069).
- `tests/integration/api/adminEnemies.test.ts`: "editing a shipped enemy marks it edited and shows the shipped copy beside it".

**Not run:** the full root test suite and the rest of the Playwright suite. Only the import page changed, so the focused sets above were used.

## 8. Staging acceptance steps

Nothing here has been run on staging. Deploying needs only a Portal rebuild; there is no API change or migration.

1. Sign in as an administrator with both `enemies.write` and `artwork.write`.
2. Export a package from another environment, and upload it at **Admin → Enemies → Import package**.
3. Confirm that Apply Import is visible immediately and names any enemies still needing a decision.
4. **Keep-all case:** with a package of only conflicts, choose Keep Existing for all. Apply, confirm, and check the receipt lists them as kept and the enemies are unchanged.
5. **Mixed case:** with new, identical and conflicting enemies, Update one conflict and keep another. Then check:
   - New enemies are disabled.
   - Updated enemies keep their enabled state.
   - Kept enemies are unchanged.
   - Artwork renders on staging.
6. **Stale case:** open a review, change one of its enemies in another tab, then apply. It should refuse, and **Check again** should recover.
7. Repeat steps 3 to 5 on a phone.
8. Sign in with `enemies.write` but not `artwork.write`, and confirm the page explains the block.
9. Confirm staging is served over HTTPS. The page's `crypto.randomUUID()` only exists in secure contexts, so on plain HTTP the preview would fail. This is existing behaviour and does not match the reported symptom. It was not tested.
