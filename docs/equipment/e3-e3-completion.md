# Equipment 3.0 — E3-E.3 completion

Completed 2026-10-27. Affix Library Management is implemented in the Admin Portal. E3-F was not started.

## Repository state

- Branch: `Delve`.
- HEAD before and after: `bbb3a066d531d8f4e83ce52a04663b2b0509c5d4`.
- E3-E.1 and E3-E.2 were already committed and intact before this work.
- Initial working tree: only untracked `.claude/`; preserved untouched.
- Final changes: six modified Portal files, nine new Portal files, and this report. All work remains uncommitted. No reset, stash, commit, push, merge or deployment.
- Backend services, API routes, schemas, migrations, roll algorithms, shipped N/R/SR content, reward eligibility, Workshop and production high-rarity content are unchanged. No backend extension was required.

## Navigation, pages and changed files

The Equipment area now links Catalogue, Rarity Rules and Affix Libraries. The sidebar adds Affix Libraries immediately below Rarity Rules, gated on `equipment.read`. Both existing Equipment pages link to it; library pages link back to both. The Rarity Rules assignment hint now points authors to the available library manager.

| Route | Page |
| --- | --- |
| `/admin/equipment/affix-libraries` | Searchable library catalogue |
| `/admin/equipment/affix-libraries/new` | Explicit creation form |
| `/admin/equipment/affix-libraries/import` | Upload/paste, file inspection and draft-only import |
| `/admin/equipment/affix-libraries/:libraryKey` | Managed editor or read-only legacy inspection |

Specific routes precede library keys and the existing generic equipment definition route. Each page checks independent permissions before fetching or exposing data, following E3-E.2. Existing session/authentication guards still apply.

**Modified files:**

- `portal/src/app/navigation.ts` and `portal/src/app/router.tsx`: navigation and lazy routes.
- `portal/src/features/adminEquipment/EquipmentCataloguePage.tsx` and `EquipmentRarityRulesPage.tsx`: cross-links.
- `portal/src/features/adminEquipment/RulesFields.tsx`: updated assignment guidance.
- `portal/src/api/adminEquipmentRules.ts`: export the existing library summary type for reuse; no behavior change.

**New files:**

- `portal/src/api/adminEquipmentAffixes.ts`: E3-E.1 HTTP client, matching wire contracts and Equipment query invalidation.
- `portal/src/features/adminEquipment/AffixLibrariesPage.tsx`: catalogue and creation form.
- `portal/src/features/adminEquipment/AffixLibraryEditorPage.tsx`: managed/legacy detail and draft/publication lifecycle.
- `portal/src/features/adminEquipment/AffixLibraryImportPage.tsx`: JSON inspection/import/results.
- `portal/src/features/adminEquipment/affixLibraryParts.tsx`: entry table/editor, readable preview, confirmation and unsaved-navigation UI, using existing Portal components.
- `portal/src/features/adminEquipment/affixLibraryModel.ts`: display-only entry comparisons and error/file inspection helpers.
- `portal/src/features/adminEquipment/__tests__/AffixLibraries.test.tsx`: focused component and workflow tests.
- `portal/src/features/adminEquipment/__tests__/affixLibraryApi.test.ts`: HTTP contracts and display-only comparisons.
- `portal/src/features/adminEquipment/__tests__/affixFixtures.ts`: realistic API fixtures; managed content is test-only, legacy entries come from the unchanged shipped file.

No UI dependencies or navigation framework were added. Cards, dialogs, fields, buttons, loading/error states, session permission hooks, QueryClient and the existing authenticated HTTP client are reused.

## Library catalogue and legacy inspection

The catalogue searches key, name and description, and filters managed/legacy source, published-or-shipped/unpublished status, and published SSR/UR/LR assignments. It shows keys, names, descriptions, source, draft revision/dirty state, published revision, draft/published entry counts, and active assignments.

Legacy N/R/SR libraries are labelled shipped, read-only and not revisioned. Their detail pages show entries in shipped order, suffixes, enabled status and slots, with search/filter/paging. No entry mutations, import, export in a managed format, publication or rollback controls are offered for legacy libraries. Nothing copies them into managed content.

Loading, error/retry, no-library and no-filter-match states are provided. Last editor/time are shown inside managed details because E3-E.1 list summaries do not contain modification metadata; the list does not invent those fields.

## Creation and entry editing

Creation takes a stable key, display name and description, and calls `POST /admin/equipment/affix-libraries` only on explicit submission. Success navigates to the editor. New libraries are empty, unpublished and unassigned. The backend validates identifiers and metadata, including its reserved legacy namespace.

Managed editors expose:

- Local draft metadata and entries, saved draft/published revisions, per-part unsaved status, last editor/time, entry counts and active assignments.
- Add, edit, duplicate with a new key, enable/disable and confirmed removal of entries. Existing keys remain read-only in the entry dialog; duplication requires a new key and a distinct suffix before the backend will accept it.
- Exact rendered suffix text and the existing Attack/Defense/Health eligibility values. Affixes remain names, with no stats or effects.
- Entry search, slot/status filters and pages of 25. Move-up/down operates on the full ordered array, including entries hidden by filters. Saves preserve this order.
- Separate draft and published entry views. Switching views does not discard local edits. Metadata is explicitly labelled as draft metadata; published metadata is available through export and change review.

Namespace and entry validity are checked by the backend. Local dialogs do only basic required-field input assistance. Conflicts with other managed or shipped entries are surfaced from structured server issues, not treated as client-only uniqueness checks.

The editor and publication/rollback dialogs explain that newly rolled high-rarity equipment stores a suffix snapshot. Editing names, disabling/removing entries or publishing revisions never rewrites owned equipment or its displayed suffix.

## Draft management and conflicts

The smallest existing workflow is used:

- **Save metadata:** `PUT /affix-libraries/:key/meta`, with `{ meta, expectedDraftRevision }`.
- **Save entries:** `PUT /affix-libraries/:key/draft`, with `{ entries, expectedDraftRevision }` for the complete ordered array.

These are separate transactions, not a pretend atomic combined save. Each response advances the saved integer revision. Saving one part preserves local edits to the other part, with explicit per-part saved/unsaved status. The next save uses the returned revision. No save publishes.

In-flight locks and disabled controls prevent duplicate submissions. Changes invalidate earlier validation/review. Validation, review, publication and rollback require both metadata and entries to be saved first.

`409 EQUIPMENT_CONFIG_STALE` or a configuration conflict preserves local values, clears review/confirmation, disables further writes/publication and requires explicit reload. No guessed revision or automatic mutation retry is used. Reloading with unsaved values requires discard confirmation.

The actual data router blocks navigation away from unsaved library/create/import edits and asks whether to keep editing or discard. Browser/tab unload also prompts. Local edits are not durable browser storage; explicitly discarding or leaving after confirmation discards them.

## Validation, preview and publication

- `POST /affix-libraries/:key/validate` validates the saved draft for writers.
- `POST /affix-libraries/:key/preview` provides backend validation and draft/published revision numbers for readers, including readers with publication but no write permission.
- The preview must match the editor's loaded draft **and published** revision. A remote publication with an unchanged draft revision still invalidates the review.
- E3-E.1's whole-array preview is rendered as added, changed, disabled/enabled, removed and reordered entries, including suffix and slot changes; metadata changes show before/after values. This is a visual diff only, not another validator.
- Publication requires a valid reviewed saved draft, a dirty configuration, publication permission, and an explicit confirmation checkbox.
- `POST /affix-libraries/:key/publish` uses the reviewed `expectedDraftRevision`. It never saves local edits implicitly.
- Server namespace, suffix, slot, enabled coverage, assignment and concurrency checks remain unchanged. Assigned-library errors show the affected rarities and slots in the server's message. Unassigned libraries, including empty ones, can be published when the backend permits it.
- Success adopts the returned active state, refreshes history and invalidates the `['admin', 'equipment']` query prefix, including Rarity Rules and Catalogue status/preview queries.

## Rarity assignment visibility

Managed details show **Used by (published rules)** from the library response and separately fetch the saved rarity-rule draft to show **Draft rule assignments**. An unavailable draft-assignment read is labelled unavailable rather than treated as no assignments.

Assignments remain exclusively in Rarity Rules. Unpublished libraries are identified as unavailable for published dependency selection. Publishing a library does not automatically assign it to any rarity. No second assignment editor was built.

## JSON import/export

Import uses the existing `waifumon-equipment-affix-library` v1 package, via `POST /affix-libraries/import`. The page accepts a file under 900 KB or pasted JSON.

- **Inspect file contents** parses JSON and displays metadata and ordered entries locally. It explicitly states that this is not backend validation or an authorized preview. No nonexistent import-preview API is called.
- Existing destination keys are matched against the loaded catalogue and their draft revision is captured at inspection time. Replacement requires explicit confirmation and sends that exact `expectedDraftRevision`.
- A new key omits `expectedDraftRevision`, preserving the backend's atomic create/import semantics. The client does not pre-create an empty library.
- Importing from an existing editor locks inspection to that library key. A file for another key must use the general catalogue import page.
- Reserved/shipped legacy keys are blocked in the UI and still rejected by the backend. Invalid entries and namespace conflicts are reported from the backend without a success result.
- A stale import preserves the file and requires an explicit destination-revision reload, inspection and confirmation. Nothing retries automatically.
- Success shows the imported draft revision, entry count and unchanged published revision, then calls the existing validation endpoint and displays its result. If validation cannot finish after a successful import, the page distinguishes the saved import from that failed read and links to the editor to validate again.
- Import never publishes. Its result links to the editor for a separate saved-draft review/publication.

Exports use `GET /affix-libraries/:key/export?kind=draft|published` and download the unchanged backend envelope with metadata and affix entries. The UI states that exports contain definitions, not owned equipment or unsaved local edits. Published export is disabled until a published revision exists.

## History and rollback

History comes from `GET /affix-libraries/:key/revisions`, showing revision, timestamp, actor, entry count, current flag and rollback origin. No history exists for a newly created unpublished library.

A reader with publication permission can choose an earlier revision, review the rollback action and explicitly confirm. `POST /affix-libraries/:key/rollback` receives the selected revision and the loaded `expectedDraftRevision`.

The dialog explains future unpinned-roll effects, immutable owned suffix snapshots, replacement of the saved draft, and revalidation against **current** published assignments. Rollback never rolls back or edits rarity-rule assignments. Backend dependency failures and stale conflicts are displayed, and success refreshes active state/history and invalidates Equipment queries. The confirmation closes immediately after a successful rollback mutation, so a subsequent history-refresh failure cannot accidentally resubmit it.

## Permissions

| Permissions | Available behavior |
| --- | --- |
| `equipment.read` | Catalogue, legacy/managed inspection, saved draft/published entries, assignment visibility, history, review and exports |
| read + `equipment.write` | Create, local metadata/entry editing, draft saves, imports and validation; no publish/rollback |
| read + `equipment.publish` | Review and publish saved drafts and roll back; no draft editing/import/validate endpoint |
| All three | Full workflow |
| Write/publish without read | Permission explanation; no library or assignment data fetch |

The permissions never imply one another. Read-only mutation controls are disabled or absent. The server remains the authorization boundary; HTTP authentication, CSRF and error normalization are not duplicated.

## Verification

| Check | Result |
| --- | --- |
| Portal `npm run typecheck` | Passed |
| ESLint on all changed/new Portal TS/TSX files | Passed |
| Prettier on new files and changed feature/API files | Passed; unrelated navigation/router formatting was preserved |
| New Affix Library component/workflow tests | 39 distinct tests passed across focused runs |
| New HTTP contract / diff / local-inspection tests | 4/4 |
| Existing Rarity Rules component tests | 27/27 |
| Existing Rarity Rules precision/API tests | 6/6 |
| Existing Equipment Catalogue tests | 26/26 |
| Existing AppShell/navigation tests | 5/5 |
| Existing permission hook/guard tests | 6/6 |
| Existing Region Pool routes | 4/4 |
| Existing Enemy routes | 6/6 |
| Focused Portal batch | 119/119 across 10 files before final added regressions; final component additions and affected rollback cases passed in scoped reruns; **123 distinct Portal tests verified** |
| Golden equipment-roll gate | 62/62: 6,000/6,000 identical on both shipped and published-rule paths |
| Existing backend affix unit compatibility suite | 15/15, including historical suffix snapshots, unchanged legacy resolution/order and import namespace protection |
| Ordinary Portal production build | Guard refused it because `portal/.env.local` exists; file left untouched |
| Approved local build | `npx vite build --mode e2e --outDir .e3-e3-build --logLevel warn` passed, including all new library chunks; scratch output removed |
| `git diff --check` and whitespace scan of new files | Passed |

The golden fixture is unchanged: SHA256 `308b5a81d86106d06604045b05971a62cb8ca086b993c45d6b45d74cc569ee13`.

The new tests cover catalogue search/filtering/empty/errors, legacy inspection, explicit creation, entry editing/duplication/removal/slots/enabling/order, independent partial saves, double submissions, unsaved navigation, stale saves/reviews/publications/imports, namespaces and assigned-slot coverage, readable metadata/entry diffs, unassigned publication, confirmations, query invalidation, upload/paste, draft-only import/results, legacy protection, saved exports, history/rollback and independent permissions/routes. Mocks use E3-E.1 response fields; no invented warning/preview/import fields are tested.

Data-router component tests use a test-local Request adapter for the repository's documented jsdom AbortSignal/Node Request mismatch. This allows real router-blocker/navigation coverage without changing application networking. The existing Catalogue export tests emit jsdom unsupported-navigation messages, and AppShell emits duplicate-request diagnostics; those suites passed.

Not run: full-root comparison, full Portal suite, Playwright/browser E2E, live-server manual acceptance, or backend integration tests. Backend code did not change, so those integration suites were not needed for this phase. The additional backend checks were the requested golden gate and the small existing affix/suffix compatibility unit suite.

## Remaining limitations and E3-F handoff

- Catalogue modification metadata is unavailable from the list contract; it is shown inside managed details.
- E3-E.1 supplies draft metadata plus published entries in detail responses, and revision metadata rather than historical bodies. Published metadata is inspectable through export/review; rollback reviews the selected action and current dependency errors, without inventing a historical-body API.
- Imports have local inspection, not a pre-import server preview. Namespace/schema validation happens during atomic draft import, with publishability validation immediately afterward. A separately published revision is always required to change live unpinned rolls.
- Rarity Rules remains the sole assignment editor. Publishing/rollback invalidates its queries; returning to that page loads current library availability. No draft roll simulator was added.
- Local unsaved edits are not persisted beyond leaving/discard confirmation. Save metadata and entries before navigating away.
- This completes the planned Equipment 3.0 Admin Portal surfaces. It does not make high-rarity equipment obtainable: default reward eligibility and Workshop remain N/R/SR. Production high-rarity rules, libraries, affixes and balance were not authored or published.
- E3-F still requires a deliberate high-rarity reward-authoring integration. Existing grant consistency, suffix snapshots and revision pinning from E3-B/E3-C are preserved; no E3-F implementation began here.
