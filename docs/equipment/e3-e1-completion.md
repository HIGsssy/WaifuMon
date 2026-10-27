# Equipment 3.0 — E3-E.1 completion

Completed 2026-10-27. Backend Admin API and tests only; E3-E.2/E3-E.3 have not been started.

## Repository state

- Branch: `Delve`.
- HEAD before and after: `138b1c5b1e9d52374e31e927eddf5bae7c06ddd7`.
- Initial working tree: only the untracked `.claude/` directory. E3-D was already committed. That directory was preserved.
- All E3-E.1 work is uncommitted. No push, merge, deployment, production content or migration.

## Files changed

| File | Change |
| --- | --- |
| `src/api/routes/v1/admin/equipmentManaged.ts` | Authenticated rarity-rule and affix-library endpoints over the E3-B services; structured validation/conflict errors |
| `src/api/schemas/equipmentManaged.ts` | Zod wire contracts, reusing domain rule/entry schemas, with inferred request/response types |
| `src/api/routes/v1/index.ts` | Register the new routes independently of the definition catalogue |
| `src/modules/portalAuth/portalAuthService.ts` | Register delegable `equipment.publish`; update permission descriptions |
| `src/modules/equipment/equipmentRollRulesService.ts` | Preview either proposed rules or the saved draft, using a consistent configuration snapshot under the existing advisory lock |
| `src/modules/equipment/equipmentAffixLibraryService.ts` | Saved-draft preview; make library import/create/save one atomic transaction; refuse a revision targeting a nonexistent library |
| `tests/integration/api/adminEquipmentManaged.test.ts` | 16 focused PostgreSQL API tests |
| `docs/equipment/e3-e1-completion.md` | This report |

## API endpoints and permissions

All routes below are relative to `/api/v1/admin/equipment`. Successes use the existing `{ data, meta }` envelope. Dates are ISO strings. Each route enforces its permission server-side through `requirePortalPermission`. Cookie writes, including POST previews, retain the existing CSRF double-submit requirement (`wm_portal_csrf`, `x-portal-csrf`). Administrative bearer access remains opt-in; the default bearer token cannot access these routes. Actors come from the session, never the request body.

`read`, `write` and `publish` below mean `equipment.read`, `equipment.write` and `equipment.publish`. Permissions are independent: write does not grant publication authority.

| Method | Route | Permission | Contract |
| --- | --- | --- | --- |
| GET | `/rarity-rules/published` | read | Active revision, rules, hash, source, author and timestamp |
| GET | `/rarity-rules/draft` | read | Rules, integer draft revision, active revision, dirty flag, hash and last editor |
| PUT | `/rarity-rules/draft` | write | `{ rules, expectedDraftRevision }` |
| POST | `/rarity-rules/validate` | write | `{}` for saved draft, or `{ rules }`; errors/warnings by field path |
| POST | `/rarity-rules/preview` | read | `{}` or `{ rules }`; validation and changes from published content, plus draft/published revisions |
| POST | `/rarity-rules/publish` | publish | `{ expectedDraftRevision }` |
| POST | `/rarity-rules/rollback` | publish | `{ revision, expectedDraftRevision }` |
| GET | `/rarity-rules/revisions` | read | Newest first, with current flag, source, author, time, hash and rollback origin |
| GET | `/rarity-rules/export?kind=draft\|published` | read | Existing rules export envelope; kind is required |
| POST | `/rarity-rules/import/preview` | write | `{ file, expectedDraftRevision }`; validates envelope and proposed rules, returns diff and `handEdited`, writes nothing |
| POST | `/rarity-rules/import` | write | `{ file, expectedDraftRevision }`; saves draft only, returns `handEdited` |
| GET | `/affix-libraries` | read | Managed summaries and read-only shipped N/R/SR libraries |
| POST | `/affix-libraries` | write | `{ key, name?, description? }`; empty unpublished managed library |
| GET | `/affix-libraries/:key` | read | Managed draft/published entries, revisions and active assignments; legacy keys return their read-only entries |
| PUT | `/affix-libraries/:key/draft` | write | `{ entries, expectedDraftRevision }`; replace draft entries, including removal |
| PUT | `/affix-libraries/:key/meta` | write | `{ meta: { name, description? }, expectedDraftRevision }` |
| PUT | `/affix-libraries/:key/entries` | write | `{ entry: { key, suffix, slots, enabled }, expectedDraftRevision }`; add/replace entry, change slot eligibility or enable/disable |
| POST | `/affix-libraries/:key/validate` | write | Validate saved draft against namespace and published assignments |
| POST | `/affix-libraries/:key/preview` | read | Saved-draft validation and metadata/entry changes from published content |
| POST | `/affix-libraries/:key/publish` | publish | `{ expectedDraftRevision }` |
| POST | `/affix-libraries/:key/rollback` | publish | `{ revision, expectedDraftRevision }` |
| GET | `/affix-libraries/:key/revisions` | read | Revision history with current flag and publication metadata |
| GET | `/affix-libraries/:key/export?kind=draft\|published` | read | Existing managed library export envelope; kind is required |
| POST | `/affix-libraries/import` | write | `{ file, expectedDraftRevision? }`; existing keys require revision, new keys require its omission; draft only |

Requests transport rule documents and entries to the E3-B validators so field refusals retain domain-specific messages. Responses reuse `RollRulesSchema` and `ManagedAffixEntrySchema`; request wrappers carry explicit integer revision fields. No alternate rules engine or generic authoring framework was added.

## Publication, concurrency and errors

- Draft saves/imports never activate anything. Publication is a separate operation guarded by `equipment.publish`.
- All writes retain the shared PostgreSQL advisory lock and integer revision checks. Stale saves/imports and publication naming an outdated draft return `409 EQUIPMENT_CONFIG_STALE` with `details.expectedRevision` and `details.currentRevision`.
- Publish revalidates inside the lock against published libraries and enabled definitions. Invalid drafts return `400 EQUIPMENT_CONFIG_INVALID` with `details.issues`. There is no partial publication.
- Unchanged publications, conflicting library keys and imports without an existing library's revision return `409 EQUIPMENT_CONFIG_CONFLICT`. Missing libraries/revisions return `404 EQUIPMENT_CONFIG_NOT_FOUND`.
- Probability totals, magnitude ranges, slot coverage, affix assignment, missing/unpublished libraries and unsupported rarity changes are checked by the existing validators. N/R/SR rule changes are rejected. Reserved legacy library keys cannot be created/imported; legacy libraries have no mutable DB row, so attempted edits return not found and cannot change shipped entries.
- Concurrent identical publications yield one success and one conflict. Published revisions remain protected by PostgreSQL update/delete triggers. Existing grant locks, immutable caches and delayed-reward pins are unchanged.
- Rollback revalidates the historical body against current dependencies and creates a new publication revision and audit event; it never mutates history. Rollback also replaces the draft and advances its revision.
- Create/edit/import/publish/rollback audit events remain in `equipment_admin_events`, in the same transaction as each change. Publication history exposes session author ids. No new audit store was introduced.
- No roll algorithm, probability, eligibility, Workshop code or deployed equipment content changed. Drafts do not affect live rolls; owned copies remain unchanged even after publication.

## Import/export details

JSON is passed directly in `file`, using E3-B's existing formats:

- Rules: `waifumon-equipment-roll-config-export`, version 1, wrapping `config` (`waifumon-equipment-roll-config`, version 2).
- Libraries: `waifumon-equipment-affix-library`, version 1, with `library` metadata and `affixes`.
- Both exports distinguish `kind: draft | published` and the corresponding revision. Source revision/kind are informational during import; concurrency always uses `expectedDraftRevision` against the destination.
- A changed rules hash is allowed and reported as `handEdited`; it does not bypass validation or publication.
- Rules import preview does not change any draft or publication. An outdated preview/import revision is refused. Preview does not grant an authorization token: import checks the revision again, and publish always revalidates.
- Library import follows the existing service contract: validate/import into a draft, then inspect its preview before explicitly publishing. There is no proposed-library-file preview service or endpoint in this phase. New-library creation and draft import now share one transaction, including namespace validation, so a rejected import leaves no empty library or partial audit rows.
- No filenames, paths or arbitrary filesystem access are accepted. The server's existing request body limit applies.

## Verification

All checks below passed. PostgreSQL tests used a throwaway PostgreSQL 16 Testcontainers container and real migrations. The first sandboxed attempt could not access Docker's named pipe; the authorized elevated test runs succeeded.

| Suite/check | Result |
| --- | --- |
| `tests/integration/api/adminEquipmentManaged.test.ts` | 16/16 |
| `tests/integration/api/adminEquipmentCatalogue.test.ts` | 30/30 |
| `tests/integration/equipmentManagedRules.test.ts` | 26/26 |
| `tests/integration/equipmentHighRarity.test.ts` | 25/25 |
| `tests/integration/api/adminRoleAccess.test.ts` | 19/19 |
| `tests/unit/equipmentRollGolden.test.ts` | 62/62; 6,000/6,000 identical on each of the shipped and published paths |
| `tests/unit/equipmentRollRules.test.ts` | 34/34 |
| `tests/unit/equipmentAffixLibraries.test.ts` | 15/15 |
| `tests/unit/equipmentHighRarityRoll.test.ts` | 34/34 |
| `tests/unit/portalAuth/portalAuthService.test.ts` | 8/8 |
| `tests/unit/portalAuth/portalPermissions.test.ts` | 7/7 |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `git diff --check`, plus whitespace check on new files | Passed |

276 distinct focused tests across these suites, run in focused batches (the new API suite was rerun as its coverage expanded). No full-root test comparison was run.

The golden fixture is unchanged: SHA256 `308b5a81d86106d06604045b05971a62cb8ca086b993c45d6b45d74cc569ee13`.

The new API suite covers authentication, default/opted-in bearer behavior, every route's independent read/write/publish boundary, CSRF, session audit actors, draft/validate/preview/publish/rollback, stale and concurrent edits/publications, invalid probabilities/ranges/rarities/assignments, legacy immutability, JSON round trips and stale imports, shared libraries, slot-specific entries, enabling/disabling entries, required-slot publication refusal, immutable revision triggers, atomic rejected imports and absence of inventory/event writes from configuration operations. Its live SSR grant test proves that seeded rolls remain identical while rules and affix drafts change, and that publishing affects a subsequent grant without changing existing copies. The existing managed/high-rarity suites also retain their compatibility and live-grant consistency coverage.

## E3-E.2 / E3-E.3 handoff

- Build editors against these contracts and the backend schemas; no Portal pages were changed here.
- Use explicit draft revisions for every edit/import/publish/rollback; show conflicts and reload rather than retrying with a guessed revision.
- Library entries are replaced by key through `/entries`, or removed through replacement of the whole draft; no separate deletion framework is needed.
- Library preview currently compares the whole entries array, plus name/description. Entry-level visual diffs can be displayed by the future editor. Rules previews are field-level diffs, not sampled draft rolls; E3-D's seeded roll-preview endpoint still uses published configuration.
- If a pre-import preview for library files is desired, extend the same service's read-only validation/preview contract; do not create a second namespace validator in the Portal.
- Production SSR/UR/LR balance and content remain unauthored. Reward eligibility and E3-F remain outside this phase.
