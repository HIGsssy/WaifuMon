# Equipment 3.0 — E3-E.2 completion

Completed 2026-10-27. This phase adds the Admin Portal rarity rules editor. E3-E.3 and E3-F were not started.

## Repository state

- Branch: `Delve`.
- HEAD before and after: `2207f363ea0b898129d4e069c35edf657cb41475`.
- E3-E.1 was already committed at the start, including its routes, Zod contracts, services and report.
- Initial working tree: only untracked `.claude/`, preserved untouched.
- Final working tree: three modified Portal files, nine new Portal source/test files, this report, and the pre-existing `.claude/` directory. Everything from this phase remains uncommitted. No commit, push, merge or deployment.
- No backend, roll engine, schema, production rules/content, reward eligibility, Workshop or artwork changes. No essential E3-E.1 contract correction was needed.

## Pages, navigation and files

The new page is `/admin/equipment/rarity-rules`. It has an entry immediately below Admin → Equipment in the existing sidebar and a **Rarity Rules** link in the Equipment Catalogue toolbar. The route precedes the generic equipment-key route. The page links back to the Catalogue and identifies its equipment sample previews as using published rules.

| File | Purpose |
| --- | --- |
| `portal/src/app/navigation.ts` | Read-permission-gated Rarity Rules navigation entry |
| `portal/src/app/router.tsx` | Lazy-loaded page route |
| `portal/src/features/adminEquipment/EquipmentCataloguePage.tsx` | Link to the rules editor |
| `portal/src/api/adminEquipmentRules.ts` | E3-E.1 HTTP client and matching Portal wire types; no server-source imports |
| `portal/src/features/adminEquipment/EquipmentRarityRulesPage.tsx` | Draft/publication state, workflow, permissions, conflict handling, history and rollback |
| `portal/src/features/adminEquipment/RulesFields.tsx` | Legacy inspection and grouped high-rarity controls, numeric fields and field-path issues |
| `portal/src/features/adminEquipment/RulesReview.tsx` | Readable configuration diffs, validation results, confirmation dialogs and JSON import |
| `portal/src/features/adminEquipment/rulesModel.ts` | Lossless percentages/whole-SP form conversion and numeric/probability-total input feedback |
| `portal/src/features/adminEquipment/__tests__/EquipmentRarityRules.test.tsx` | 27 Portal component/workflow/permission/route tests |
| `portal/src/features/adminEquipment/__tests__/rulesModel.test.ts` | Four precision and round-trip tests |
| `portal/src/features/adminEquipment/__tests__/rulesApi.test.ts` | Two HTTP contract and published-library eligibility tests |
| `portal/src/features/adminEquipment/__tests__/rulesFixtures.ts` | Mock API responses, shipped legacy fixture and explicitly test-only high-rarity values |
| `docs/equipment/e3-e2-completion.md` | This report |

The UI reuses the Portal's Card, Button, Input, Dialog, PageHeader, ErrorState, Skeleton, select styling, authentication context and QueryClient. There are no new UI dependencies or administration frameworks.

## API integrations

All requests use the existing authenticated HTTP client, including cookie credentials, CSRF headers and normalized errors. Paths below are relative to `/api/v1/admin/equipment`.

- Read `/rarity-rules/draft`, `/published`, `/revisions` and `/affix-libraries`.
- Read published managed-library details at `/affix-libraries/:key` to inspect **published** enabled entries and slot coverage. Library drafts never determine availability.
- Save through `PUT /rarity-rules/draft` with `{ rules, expectedDraftRevision }`.
- Validate through `POST /rarity-rules/validate` with proposed rules.
- Review through `POST /rarity-rules/preview` with proposed rules, showing backend validation and a diff against the published revision.
- Publish through `POST /rarity-rules/publish` with `expectedDraftRevision`.
- Roll back through `POST /rarity-rules/rollback` with the selected published revision and current `expectedDraftRevision`.
- Export with `/rarity-rules/export?kind=draft` or `kind=published`.
- Preview/apply rules files with `/rarity-rules/import/preview` and `/rarity-rules/import`, carrying `{ file, expectedDraftRevision }`.

No new API or client import format was created. The Portal's hand-authored wire types follow the existing HTTP-consumer boundary and match the E3-E.1 schemas. Server schemas and validation remain authoritative.

## Rarity controls

The header shows active published revision/time/actor, saved draft revision, dirty status, last editor/time, and unsaved local status. Authors can switch between Draft and a read-only Published view without losing local edits.

**N/R/SR:** read-only chance and count, every family and magnitude range/step, enabled status, slot eligibility, and shipped affix source. The protected legacy block is carried through unchanged on structured draft saves. Backend import/save validation continues to reject legacy changes.

**SSR/UR/LR:** each can be absent (unconfigured/fail-closed) or configured. Enabling a previously absent rule creates blank authoring fields, not illustrative balance defaults. A section selector keeps the following groups separate:

- Zero/one/two/three additional-bonus chances, displayed in percentages. The current total is explicit and must equal exactly 100%. Individual definitions' bonus maximum and proportional rescaling of the remaining outcomes are explained.
- Optional primary SP chance, minimum, maximum and step. Ranges are whole SP. The UI explains definition opt-in, no additional-bonus slot usage, stacking with additional Flat SP, and effective versus natural SP.
- The six supported families only: critical chance, critical damage bonus, double attack chance, armor penetration, lifesteal and Flat SP. Authors can include/remove a family, enable/disable it, edit ranges/step, and select Attack/Defense/Health eligibility. Existing family order is preserved.
- Affixless or an existing published library. Shared and dedicated assignments use the same existing backend contract. Unpublished libraries and published libraries lacking an enabled entry for any required slot are disabled in the picker. Missing/currently unavailable assignments are shown explicitly, never silently replaced. The selected library's published revision is shown. With zero libraries, affixless authoring remains available.

Global equipment-SP safety limits are in a collapsible section, with both per-copy and per-loadout values and the code ceilings of +200/+400 stated explicitly. These limits concern equipment bonuses, never natural SP. The UI also explains the existing live per-loadout clamp: changing that published limit can affect current combat calculations while owned item rolls stay unchanged.

Percentages are stored as input strings and converted to integers using decimal digits, without rounding. Up to two percentage decimal places preserve basis-point precision. Whole-SP fields accept whole numbers only. Invalid precision, blanks and non-integer SP inputs are reported; values are never silently normalized or clamped. Exact probability totals block malformed draft saves/publication. Range, family feasibility, assignments, code caps and enabled-definition compatibility are validated by the backend.

## Draft, validation and publication

1. Load a snapshot of draft, published configuration, history and library availability.
2. Edit locally; show unsaved status. Switching rarity, section or draft/published view preserves edits.
3. Save the draft using the loaded integer revision. Saving never publishes and clears previous validation/review.
4. Validate proposed rules through the backend, or request Review Changes. Both display field-specific structured errors and warnings. Issues are mapped to readable field labels; exact source paths remain available as titles. Numeric field errors are also associated with their inputs.
5. Review displays the backend's draft/published revision numbers and readable before/after changes, with percentages, SP units, family names, slots and affix assignments.
6. Publish opens the same review dialog. Confirmation is disabled for unsaved values, stale state, failed validation, unchanged rules or missing publication permission. A successful review validates the saved configuration before confirmation. Read-plus-publish users can use this read-permission preview without needing write permission.
7. The author must explicitly tick confirmation and submit. The request uses the reviewed saved draft revision; it never saves local values implicitly.
8. On success, refresh draft/publication/history/dependencies and invalidate Equipment queries so Catalogue previews can refresh too.

Busy states disable edits/actions, and immediate in-flight locks prevent duplicate mutation submission. Browser/tab unload prompts while local edits are unsaved. Local values are not persisted across a completed page navigation.

## Revision conflicts

`409 EQUIPMENT_CONFIG_STALE` preserves the local form, clears review/confirmation, disables further writes/publication and explains that nothing was retried. Conflicts requiring a new snapshot are handled the same way. A review whose draft revision **or published revision** differs from the loaded snapshot is also refused, including a remote publication that leaves the integer draft revision unchanged.

Reload fetches the current snapshot. If local changes exist, a separate discard confirmation is required. Reload/save/import clear prior validation, so another publication must obtain a new backend review. No guessed revision or automatic mutation retry is used.

## Import/export

- Both explicit exports download the server's existing `waifumon-equipment-roll-config-export` v1 envelope, wrapping the v2 configuration. Draft export means the saved draft; the UI warns that local changes must be saved to include them.
- Import accepts upload (under 900 KB) or pasted JSON. The browser checks JSON syntax only; the backend checks the envelope, legacy immutability, rules and dependencies.
- Preview displays validation, warnings, changes and the `handEdited` indicator. Applying requires successful validation and explicit confirmation to replace the saved draft.
- Applying names the original destination draft revision. Stale refusals invalidate the import preview rather than retrying it.
- Import cannot begin while unsaved local edits would be discarded. Editing import text clears the old preview/confirmation.
- Apply modifies the draft only. Publication remains a separate reviewed action.

## Revision history and rollback

History shows revision numbers, current indicator, publication time, actor, source and rollback origin. A noncurrent revision can be selected by a reader with publication permission. The dialog identifies the selected revision and explains that rollback publishes a new revision, replaces the saved draft, changes future unpinned grants, and leaves owned item rolls unchanged. It separately notes the live per-loadout SP clamp.

Rollback requires explicit confirmation and the loaded draft revision. Unsaved or stale state blocks it. Backend dependency errors are displayed in the dialog; history is never assumed safe merely because a revision was once valid. Success refreshes active/draft state and history.

The E3-E.1 history endpoint provides metadata, not historical bodies. This page therefore reviews the selected rollback action/metadata rather than inventing a historical-body preview API.

## Permissions

| Permissions held | Behavior |
| --- | --- |
| `equipment.read` | Inspect draft/published/legacy rules and history, preview changes, export; editing and publication disabled |
| read + `equipment.write` | Edit, save, validate and import drafts; publish and rollback disabled |
| read + `equipment.publish` | Review and publish a saved draft and roll back; no editing, save, validate endpoint or import |
| all three | Full editor workflow |
| write and/or publish without read | Clear read-permission explanation; no read requests, editor data or mutations |

Navigation requires read. The page independently checks read before fetching, with an explanation for direct visits. The three permission checks never imply each other. Backend checks remain the security boundary.

## Verification results

| Check | Result |
| --- | --- |
| Portal typecheck, `npm run typecheck` | Passed |
| ESLint on all changed/new Portal TS/TSX files | Passed |
| Prettier on new files and modified Catalogue page | Passed; unrelated formatting in navigation/router was not rewritten |
| New editor component tests | 27/27 |
| New precision/form model tests | 4/4 |
| New HTTP/library-eligibility tests | 2/2 |
| Existing Equipment Catalogue tests | 26/26 |
| Existing AppShell/navigation tests | 5/5 |
| Existing permission hook/guard tests | 6/6 |
| Existing Region Pool route/permission tests | 4/4 |
| Existing Enemy route/permission tests | 6/6 |
| Focused Portal batch total | 80/80 across 8 files |
| Final focused rerun after fixture/accessibility refinements | 33/33 across 3 new test files |
| Golden equipment-roll gate | 62/62; 6,000/6,000 identical on both shipped and published-rule paths |
| Ordinary Portal production build | Refused by the existing guard because `portal/.env.local` exists; left untouched |
| Approved local alternative | `npx vite build --mode e2e --outDir .e3-e2-build` passed; new lazy editor chunk built, scratch output removed |
| `git diff --check` and whitespace scan of new files | Passed |

The golden fixture SHA256 remains `308b5a81d86106d06604045b05971a62cb8ca086b993c45d6b45d74cc569ee13`.

The tests cover legacy display, blank UR/LR authoring, SSR editing, exact percentages and totals, primary/Flat SP and slots, safety-limit refusals, affixless and published/unavailable libraries, draft/published inspection, unsaved edits, save and validation/warnings, diff and confirmed publication, independent permission combinations, stale save/review/publication/import, upload/paste/export, draft-only import, history and rollback confirmation/dependency errors. Precision tests exhaustively round-trip all 10,001 probability basis-point values and preserve complete documents/family ordering.

The initial sandboxed Portal test attempt was blocked from creating Vitest's temporary worker directory. Authorized elevated focused runs succeeded. Existing Catalogue export tests emitted jsdom's unsupported-navigation messages, and AppShell emitted duplicate-request diagnostics; all tests passed.

Not run: full-root comparison, full Portal suite, Playwright/browser E2E, live-server manual acceptance, or backend integration suites beyond the requested golden gate. No backend modifications required those integration suites.

## Limitations and E3-E.3 dependencies

- This is the rarity rules editor only. Library creation, entry editing and library publication are absent and remain E3-E.3.
- Library labels use the metadata available from E3-E.1; actor IDs are shown where no display name is supplied by that API.
- Configuration previews show backend validation and changes; there is no draft roll simulator. Equipment Catalogue sample rolls still use published rules.
- Local edits survive view changes and revision refusals but are not durable browser storage. A completed intra-Portal navigation leaves the page's local edits behind; save drafts before navigating away.
- Rollback metadata is available; historical-body inspection would require a deliberate additional read contract if desired later.
- E3-E.3 should reuse the same existing library API, integer-revision workflow and independent publication permission. Newly published slot-complete libraries appear when this page is reloaded.
- No production high-rarity balance or affix content was authored. Gameplay reward availability and E3-F remain unchanged.
