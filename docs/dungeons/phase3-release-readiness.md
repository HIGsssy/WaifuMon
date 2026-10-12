# Phase 3 Dungeon Events release readiness

Assessment: **Ready for staging testing.** Automated verification supports the
event runtime, authoring and v3 portability. Production consideration requires
the manual acceptance and operational rehearsal below. This is not a production
approval, and the repository's broader checks are not wholly green.

Assessed on 2026-10-12, branch `Delve`, HEAD
`0dc68a439d7d3b807548790f7673c55238305466`, with the existing uncommitted Phase 3
implementation preserved. C6 adds documentation and a focused integration test;
it changes no production gameplay, Portal code, package format or migration.
No agents, commits, pushes, merges, deployments or staging/production migrations
were used. PostgreSQL 16 ran in the disposable `waifumon-c6-pg` container.

## Coverage against the design

The [design](phase3-events-design.md) retains historical proposals and B/C
implementation notes. Its temporary export gate and read-only event cards were
superseded by C1–C5. Use the [creator guide](dungeon-events-guide.md) for current
authoring and this report for verification status.

| Task | Current implementation and verification |
| --- | --- |
| B1 | Optional event/pool schema, event action, bounded choices/effects/checks. Six Phase 3 compatibility goldens preserve old definitions, dependencies, validation ordering, v1 bytes and v2 hashes. |
| B2 | Shared reachable reward-site traversal, including both check branches; table copying maps every outcome. Reward and package unit/integration suites verify dependencies and unused libraries. |
| B3 | Event/routing/reference validation, unrestricted fallback, entrance safety and retreat constraints; 19 event validation and 26 general validation unit cases plus publication tests. |
| B4 | Pure deterministic pool selection and SP checks; persistent-instance state machine, availability, flags/health and sandbox. 25 engine-event cases and live parity. |
| B5 | Migration 0065, persisted selections, live inventory facts and transactional consumption/grants/history. Real pre-0065 upgrade, locking rehearsal, failed delivery and race tests. |
| B6 | Actual Discord choice handler, item consumption warnings, displayed probabilities, disabled explanations, artwork and result messages. 12 event Discord integration cases plus presenter coverage. |
| B7 | Reachable event outcome snapshots, required-item health, artwork references and dependency pinning. Event publication/export/import and reward health suites. Initial export refusal is replaced by C5 v3. |
| B8 | Portal type preservation and tolerance completed and expanded by C1–C4. **Small completeness gap:** the planned shipped three-example event package is absent; `content/dungeons/examples/` contains only legacy `service_tunnels.dungeon.json`. Test fixtures and this guide cover event scenarios; no new content package was added in C6. |
| C1 | Room Event selection, event activity/template and Events library with usage and deletion guards. Portal models/components and browser flows. |
| C2 | Narrative/artwork, requirements/items, SP control and certain/success/failure result editing; existing reward editor reused. Save/reload and read-only checks. |
| C3 | Pool shares, conditional eligibility, Nothing, once-per-run and server-derived base/scenario percentages; component/unit/browser cases. |
| C4 | Discord preview, validation checklist navigation, assumed scenarios and playable sandbox. Desktop/narrow screens and reader permissions tested. |
| C5 | Strict v3 package build/read, pinned publication export, target import planning/apply, required-item review and copy rewriting. 26 v3 unit, 17 v3 integration and Portal/browser import cases. |
| C6 | Creator guide, updated overview/design status, two-database event lifecycle, operational lock test, final verification and this assessment. |

Implemented effects remain run flags, percentage healing/non-lethal damage and
the existing reward system; inventory consumption is an explicit choice cost.
Only SP checks are supported. Persistent player flags, other stats/effects,
global event libraries, World Encounter changes and Phase 4 encounters/captures
remain out of scope. The one-entry-pool “attach directly instead” shortcut,
arbitrary SP entry in the Portal scenario controls, and event-specific navigation
from required-item health notices remain deferred as recorded in §20 of the design.

## Integrated lifecycle evidence

`tests/integration/dungeonEventsLifecycle.test.ts` reuses `dungeonWorld`, event
fixtures, the production content/run services, the shared sandbox and resolver.
Its two independently migrated databases have different connection strings.

The source validates and publishes a dungeon with a Scrapheap entrance pool,
the handcrafted Sealed Vault, consumed Vault Key, checked outcomes, flags,
health effects and rewards. A v3 publication export includes the required-item
manifest and reachable loot. A source table edit leaves the exported publication's
definition and reward snapshot unchanged.

The target reviews missing, identical and conflicting tables. Import creates
the missing table, retains an identical table, copies one conflicting table under
a new key, and explicitly uses another target table. The original conflicting
table stays unchanged. Both success and failure branches reference the copied
key. Import starts disabled and unpublished; target validation, publication and
explicit enabling follow. Re-export passes the v3 reader and includes the
target's selected 99-WaifuBux table body.

A real player starts a seeded run. The selected crate is saved at the entrance
and a restarted run service displays the same event. Resolving it damages health
and accumulates 2 Shards. A later path is refused while `vault_opened` is unset.
At the vault, the choice consumes one key and performs an SP check with the
run's pinned 185 SP. The sandbox independently plays the same inputs. Target
loot is changed and republished while the event is offered; the active run pays
from its original publication snapshot.

The final affection grant is forced to fail **after** item consumption and
earlier secured currency/item/equipment writes. Exact before/after comparisons
prove rollback of the entire run row (flags, HP, claims and event selection),
history, wallet, required/reward inventory, Equipment and Buddy affection.
The original input is then retried concurrently: one applies and one is stale.
Its recorded check equals the seeded expected check, and selection, HP and flags
match the sandbox. There is one item-consumption history entry, one secured grant
receipt and two claims (the earlier Shards-only crate needs no secured receipt).
An additional stale press changes nothing.

Success heals HP, remembers `vault_opened`, secures 7 Essence, deterministic
salvage, one Equipment item and 3 affection, and adds 45 Shards plus 612 WaifuBux
at risk. Returning to the hall allows the previously locked exit. Completion
banks **47 Shards and 612 WaifuBux**, preserving secured loot; a repeated ending
is refused. Final inventory and currency balances are asserted.

The second new test executes the **actual DROP/ADD history-constraint statements**
from migration 0065 in temporary transactions. A held reader makes DDL fail with
`55P03` under a 100 ms lock timeout; retry holds `AccessExclusiveLock` and blocks
another reader until the transaction ends. Rollback leaves the history rows and
validated constraint unchanged. This establishes lock semantics, not the duration
of scanning a production-sized history table.

## Additional lifecycle and compatibility coverage

| Priority | Evidence exercised in C6 |
| --- | --- |
| Once per run across rooms | `dungeonEventsLive`: previously selected events leave subsequent pool eligibility across rooms; direct placement remains deliberate. |
| Retreat, disconnect, resume | Live instance persistence and restarted service tests; turn back/re-entry retains the original selection and history count. |
| Concurrent and duplicate choices | Live row-lock race cases; actual Discord stale/duplicate handlers; new integrated concurrent retry and repeated ending. |
| Offered event republication | Live definition pinning and the integrated reward republish case; snapshot suites separately test publication consistency. |
| Entrance safety | Event validation and actual Discord entrance checks; a fallback cannot rely solely on retreat. |
| Event-only/unused dependencies | Event reward traversal, publication and v3 manifest tests; unused library references do not pin missing reward/item/art dependencies, while structural errors still fail. |
| Artwork and item health | Event dependency validation, artwork integration/Discord fallbacks and required-item missing/disabled health notices. |
| Consumption warnings/disabled choices | Actual Discord embeds/buttons, item race recovery and failed-check consumption. |
| Sandbox parity | Live/sandbox draw, choice, flag and HP comparison; new integrated parity; API test proves sandbox writes no player state. |
| Import safety | V3 disabled/unpublished imports, replacement with active runs, exact receipts/retries, stale plans, audit rollback and concurrent table creation. |
| V1/v2/v3 compatibility | Six old-content goldens, normal v1/v2 importer suites, v3 tamper/disguised-version/manifest/body/snapshot checks, and both check-branch copy rewrites. |
| Portal permissions/mobile | Components and browser read-only scenarios; event/pool sheets, sandbox, workspace and v1/v2/v3 import on narrow screens. |
| Existing active runs | Real upgrade from 0064 retains row identity and old state; default `{}` event state, old live-run suites, old package/hash goldens. |

## Commands and results

All backend integration commands used
`TEST_DATABASE_URL=postgresql://postgres:c6_disposable@127.0.0.1:42363/postgres`
for the local disposable container. Helpers create and destroy separate test
databases. This URL is a disposable test credential, not an environment secret.
Logs and machine-readable results are under `/tmp/waifumon-c6-*`; they are local
verification artifacts, not tracked release assets.

| Exact command (repository root unless stated) | Result |
| --- | --- |
| `npm test -- tests/unit/dungeons tests/integration/dungeon tests/integration/api/adminDungeons.test.ts tests/integration/api/adminDungeonLootTables.test.ts tests/integration/api/dungeon --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=/tmp/waifumon-c6-backend.json` | Initial run: 44 files, 1,001 tests; 999 pass, 1 established architecture failure, 1 optional artwork-render skip. |
| Same command with `--outputFile=/tmp/waifumon-c6-backend-final.json` after adding C6 | 45 files, 1,003 tests: **1,001 pass, 1 established architecture failure, 1 optional artwork-render skip**. Includes all event/reward/import/export/publication/live/API suites and the new test. |
| `npm test -- tests/integration/dungeonEventsLifecycle.test.ts --reporter=verbose` | 2 pass: integrated lifecycle and constraint locking; final validation assertions verified separately. |
| `npm --prefix portal test -- src/features/adminDungeons src/features/adminDungeonLoot src/api/__tests__/adminDungeons.test.ts src/api/__tests__/adminDungeonLootTables.test.ts --maxWorkers=2 --minWorkers=1 --reporter=json --outputFile=/tmp/waifumon-c6-portal.json` | 31 files, 317 pass. |
| `npm --prefix portal test -- --maxWorkers=2 --minWorkers=1 --reporter=json --outputFile=/tmp/waifumon-c6-portal-full.json` | Broader sandbox run: 126 files, 1,729 pass / 5 failures out of 1,734: architecture plus four build-guard subprocess-output failures. See independent evidence below. |
| Same full Portal command outside sandbox, `--outputFile=/tmp/waifumon-c6-portal-full-unsandboxed.json` | 126 files, 1,734 tests: **1,733 pass, 1 established architecture failure**. All five build-guard cases pass. |
| `npm --prefix portal run e2e -- dungeonEvents.spec.ts dungeonAuthoring.spec.ts dungeonImport.spec.ts dungeonLoot.spec.ts dungeonArtwork.spec.ts dungeonWorkspace.spec.ts --workers=2 --reporter=json` | 43 pass, 19 explicit skips, 0 failures or flaky tests. Desktop/mobile projects; skips are redundant desktop-authoring variants, not skipped failures. |
| `npx tsc --noEmit` | Pass, including new integration test. |
| `npx --prefix portal tsc --noEmit -p portal/tsconfig.json` | Pass. |
| `VITE_PLATFORM_API_URL=/api npm run build`, cwd `/tmp/waifumon-c6-start/portal` | Pass: env guard, Portal TypeScript and production Vite build. Snapshot Portal source was byte-compared with the working tree: no differences. User `portal/.env` preserved. |
| `npm run verify:bundle`, same env-free Portal cwd | Pass: 145 public bundle files checked; no development-only code. |
| `podman build -f portal/Dockerfile -t localhost/waifumon-c6-portal:verification .` | Pass from **repository root**; production build and 145-file bundle verification executed. Image `58a42fdd7790a3712748eae58c1a6cd04bd828374cd55c4f34d4cbd641c8d5ad`; not run/deployed/pushed. |
| `git diff --check` | Pass. |

The first attempt at a local production build in the working Portal directory
correctly refused to read `portal/.env`. A subsequent bundle verifier on the
existing e2e output is **not** counted as production evidence; the successful
env-free production build above and container build are the release checks.

### Independent baseline and environment evidence

An isolated clean-HEAD source tree at `/tmp/waifumon-c5-head-baseline` was used
again in C6. The architecture test files were hash-compared to `git show HEAD`
and match. Baseline commands were executed in that tree with the same installed
dependencies, separately from the current tree; historical handoffs were not
accepted as proof. A fresh C6 `git archive HEAD` was also compared with every
tracked baseline file outside project-memory metadata: no source differences.

* Backend: `npm test -- tests/unit/dungeons/engineArchitecture.test.ts --reporter=verbose`
  with the test database environment, on clean HEAD and current source. Both
  produce exactly the same four violations: importer's `node:fs`, `drizzle-orm`
  and database schema imports, plus `enemyStore.ts` importing `drizzle-orm`.
  Both report 1 pass / 1 fail. Existing issue #0025; unchanged during C6.
* Portal: `npm test -- src/__tests__/architecture.test.ts --reporter=verbose`,
  cwd each Portal tree. Both report 9 pass / 1 fail and the same two offenders:
  `api/adminArtworkAssets.ts` and `api/adminDungeons.ts`. Existing issue #0069;
  unchanged during C6.
* Build guard: `npm test -- src/__tests__/buildEnvGuard.test.ts --reporter=verbose`
  reproduces 1 pass / 4 empty-output failures in both sandboxed trees. The same
  current suite outside sandbox passes 5/5. These are an execution-environment
  limitation, not a new event defect. Production guard behavior is also directly
  verified by both builds. Investigation #0099 records this evidence.

The general backend suite outside the dungeon filters was not rerun. Other
historical failures mentioned in the Phase 2 report are not established as C6
results and are not included in these counts. Browser tests stub the Platform
API: they establish UX/permissions/responsiveness, while backend integration
tests establish real PostgreSQL effects. Real Discord/Portal/API deployment
acceptance remains manual.

## Migration 0065 and deployment

Journal entry `idx: 65`, tag `0065_dungeon_events`, version `7`,
`when: 1821391200000`, breakpoints enabled, follows 0064's
`when: 1821304800000`; indices and ordering are tested. Deploy the complete
migration history. `event_states jsonb NOT NULL DEFAULT '{}'::jsonb` gives old
runs an empty event map. The real 0064→0065 test checks unchanged row `xmin`,
status/flags/history, new log-type acceptance, rejection of unknown types and
idempotent migration replay. Existing reward-claim and currency columns are unchanged.

The history CHECK adds `event_selected` and `items_consumed` to the existing
allowed types. PostgreSQL takes an `ACCESS EXCLUSIVE` lock for this constraint
replacement and verifies existing rows. A constant column default avoids a full
row rewrite, but does not eliminate DDL locking. These semantics are documented
by [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)
and [Modifying Tables](https://www.postgresql.org/docs/16/ddl-alter.html), and the
new local locking test verifies the constraint behavior.

**A maintenance window is advisable.** Drizzle executes pending migrations in
a transaction; the exclusive lock remains until it commits. Rehearse on a recent
sanitized copy with representative history volume. Record row counts, relation
size, DDL/scan duration and lock wait against the approved outage budget. A small
disposable fixture's timing is not a production estimate.

Specific mitigation for a large history table:

1. Pause API/bot run interactions and authoring writes, then drain existing
   transactions. Inspect `pg_stat_activity` and `pg_locks` for long readers/writers.
2. Run the coordinated migrator with bounded connection settings, for example
   `PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s'`, **after verifying
   those bounds cover the full rehearsal**. Confirm the driver applies them.
   Startup migration must inherit the same bounds; stop/retry on timeout rather
   than leaving waiting DDL to queue all gameplay behind it.
3. Monitor locks and scan progress/duration; if the rehearsal cannot fit the
   window, postpone the release and review a migration strategy separately.
   A CHECK added `NOT VALID`, committed, then validated in a **separate
   transaction** can reduce scan blocking; changing it and validating inside
   the same transaction still retains the earlier exclusive lock. Any split
   strategy must preserve Drizzle journal/provenance and be reviewed before use.
   Migration 0065 was not changed based on hypothetical table size.

Deployment order:

1. Back up and verify restore procedure, rehearse migration and choose the
   maintenance window. Freeze event publishing/import until all readers match.
2. Apply migrations through 0065 in the coordinated database step. Backend
   startup also migrates before services: prevent multiple old/new application
   instances from racing rollout and authoring during this step.
3. Deploy the matching backend/API and Discord bot to every instance. Confirm
   migration head, start/resume/choice/settlement and v1/v2/v3 inspect/import.
4. Deploy the matching Portal image. Preserve the import ingress's 2 MiB limit,
   authentication/permissions, production build guard and managed-asset paths.
5. Complete staging acceptance before enabling event dungeons for wider use.

Rollback should retain the additive database migration. Prefer rolling forward
with the last verified event-aware backend and Portal. A pre-event backend cannot
read definitions or active runs pinned to event revisions. A pre-v3 backend also
cannot provide the new portability flows. Disabling/unpublishing a dungeon only
stops new starts; it does **not** rewrite the draft, archived revisions, selected
events or active-run snapshots. Republishing an old event-free revision likewise
does not migrate existing runs. Do not delete event state or pretend this makes
an old backend safe. Application rollback requires a separately rehearsed plan
for all content and active runs it must read; restore from backup entails player
data loss after that backup and must be an explicit operational decision.

## Findings and proposed follow-up

| Severity | Finding | Action / release impact |
| --- | --- | --- |
| Blocker | No new functional blocker found in the tested event paths. | Staging can proceed with coordinated migration and matched readers. Production approval remains pending acceptance. |
| High | 0065's exclusive history lock/scan and mixed-version or pre-event rollback can interrupt gameplay or make runs unreadable. | Rehearse at representative scale, use maintenance window/timeouts, deploy DB→backend/bot→Portal, retain event-aware roll-forward path. No migration rewrite without evidence. |
| Medium | Backend #0025 and Portal #0069 architecture checks remain red on clean HEAD. | Focused follow-up: restore pure import boundaries and reconcile explicit Portal API helper policy. Do not weaken tests or repair unrelated architecture inside C6. Resolve/accept these explicitly before production release. |
| Medium | Real deployed API+Portal+Discord behavior and representative migration duration remain unverified. | Execute the staging checklist and retain evidence. Browser stubs and local test databases cannot establish these. |
| Low | B8 downloadable three-example event package missing (#0098). | Follow-up authoring/content task: export a validated v3 example package using shipped or clearly documented required items/art. The new guide provides all three recipes today. |
| Low | Required-item health notices do not navigate to the individual event; one-entry conversion shortcut remains deferred. | Documented usability limits, not play blockers. |
| Low | Managed artwork replacement can affect active-run pictures; portability carries references, not bytes. | Transfer matching assets and include an active-run art replacement check in staging. Gameplay/reward pinning remains verified. |
| Low | Sandbox suppresses output for build-guard subprocess tests (#0099, resolved as environment-specific). | Run those tests outside sandbox; no production or test-source patch needed. |

Minor C6 fixes are limited to correcting assumptions in the new test (required
item manifest strings and Shards-only receipt counts) and replacing stale status
claims in documentation. No unrelated baseline tests or production code were changed.

## Manual staging acceptance checklist

- [ ] Record deployed backend/API/bot and Portal revisions, migration journal
  through 0065, backup/restore rehearsal and production-scale lock/scan timing.
- [ ] Create Sealed Vault, Scrapheap and Dead Generator from the guide without
  JSON. Save, reload, validate and publish. Check event-only loot dependencies,
  unused library ideas, artwork and missing/disabled item notices.
- [ ] Use real Discord with an actual player: show story, art, owned quantities,
  consuming-item warning, SP probability and disabled/hidden choices. Commit both
  a successful and failed check; verify the item is spent in either case once.
- [ ] Disconnect/resume, turn back/re-enter, repeat old buttons and race two
  devices/instances. Confirm saved draw, one resolved choice and one payout.
- [ ] Visit two rooms sharing a pool. Confirm once-per-run exclusion and Nothing
  handling, including all entries ineligible and a flag changing after selection.
- [ ] Repair the generator and use the unlocked lift. Check failure/no-parts
  alternative exit, health rounding/non-lethal damage, secured loot and completion,
  extraction/defeat/abandon currency settlement according to dungeon settings.
- [ ] Republish while an event is offered; resume the old run and start a new one.
  Verify old/new definitions and reward snapshots, plus pinned SP after equipment edits.
- [ ] Export a published v3 package, import on the other environment, review
  missing/identical/conflicting tables, copy and use-existing choices, both branch
  references and required item/art notices. Import stays disabled/unpublished;
  enable only after review and publication. Retry uncertain requests safely.
- [ ] Import old v1 and v2 packages and resume an event-free run created before
  rollout. Confirm no false dependency drift or historical currency changes.
- [ ] Exercise real browser authoring, sandbox and import at narrow widths, with
  editor and read-only accounts; verify read-only API enforcement as well as controls.
- [ ] Transfer managed art by matching category/hash; inspect fallback and an
  active run when art is replaced. Confirm no Buddy composition on event art.
- [ ] Verify multi-instance deployment order, migration timeout recovery and
  event-aware roll-forward rehearsal. Explicitly resolve/accept known architecture
  baseline checks before a production decision.

## C6 files and conclusion

Updated `docs/dungeons.md` and the design's status pointer; created
`docs/dungeons/dungeon-events-guide.md`, this report, and
`tests/integration/dungeonEventsLifecycle.test.ts`. All prior uncommitted Phase 3
work remains in place. Project memory was updated through MCP logging only.
The disposable C6 PostgreSQL container was removed after verification.

**Ready for staging testing**, subject to the documented migration coordination.
Production consideration awaits real-environment acceptance and review of the
known architecture checks and operational risks. C6 stops here; no Phase 4 work.
