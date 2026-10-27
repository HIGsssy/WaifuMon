# Equipment 3.0 — E3-D Completion Report

**Phase E3-D: the Admin Equipment Catalogue.**

- Uncommitted, for review. E3-E and E3-F were not started.
- Design basis: [equipment-3-architecture.md](equipment-3-architecture.md), [e3-a](e3-a-completion.md), [e3-b](e3-b-completion.md) and [e3-c](e3-c-completion.md). Where they differ from the code, the code was followed; the differences are noted below.

> **What changes for players: nothing.** The Catalogue is Portal-only, behind two new permissions. Creating, importing or enabling SSR/UR/LR equipment reaches no reward source, because every selector, loot table and Workshop recipe stays on `EQUIPMENT_REWARD_RARITIES` (N/R/SR). Enabling **N/R/SR** equipment does reach existing automatic rewards, exactly as it always has. The Catalogue now shows which rewards first and requires an explicit confirmation.

---

## 1. Repository state

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `14142eb` — "Add integration and unit tests for equipment reward pinning and high-rarity roll mechanics" (E3-C, committed). Unchanged; nothing committed. |
| Prerequisites | E3-A (`0070`), E3-B (`0071`) and E3-C (`0072`, `highRarityRoll.ts`, pins) all present and committed. |
| Initial working tree | Clean. |
| Final working tree | 18 modified tracked files and 7 new paths. Every change is E3-D's own; there was no unrelated work to preserve. Listed in §2. |
| Migration added | `0073_equipment_catalogue_admin` (journal entry 73) |

Line endings:

- `EnvSessionProvider.tsx` and `DevLoginSessionProvider.tsx` gained two lines each.
- Git reports their working copies as LF; the index is LF, so committed content is unaffected.

---

## 2. Changes

**New:**

| Path | Role |
| --- | --- |
| `drizzle/0073_equipment_catalogue_admin.sql` | Definition `revision`; audit table widened for definitions (§3) |
| `src/modules/equipment/equipmentCatalogueService.ts` | The Catalogue service. It composes the existing definition, package, rules and selector services (§6–§10). |
| `src/api/routes/v1/admin/equipment.ts` | The Admin API routes (§4) |
| `portal/src/api/adminEquipment.ts` | The Portal API client |
| `portal/src/features/adminEquipment/` | Catalogue, editor and import pages; shared parts; form model; tests |
| `tests/integration/api/adminEquipmentCatalogue.test.ts` | 30 PostgreSQL-backed API tests |

**Modified (backend):**

| File | Change |
| --- | --- |
| `equipmentDefinitionService.ts` | Every write increments `revision` and appends an `equipment_admin_events` row (subject `definition`) in the same transaction. An optional `expectedRevision` makes stale writes fail with `EquipmentDefinitionStaleError`. `create` can record `duplicated`. `assertDefinitionRevision` was added. |
| `equipmentImportService.ts` | The `catalogueDefaults` option. The preview returns `planHash`, `statusNotes` and the adjusted package. `applyImport(expectedPlanHash)` raises `EquipmentImportStaleError`. Updates bump `revision`, and each touched key gets an `imported` audit row. |
| `equipmentPackage.ts` | `applyCatalogueImportDefaults` and `importPlanHash` (pure). |
| `seed.ts` | The reset seed bumps `revision`, so an editor holding an old revision cannot overwrite it. |
| `shared/errors.ts`, `api/errors.ts` | `EQUIPMENT_DEFINITION_STALE`, `EQUIPMENT_IMPORT_STALE` and `EQUIPMENT_ENABLE_CONFIRMATION_REQUIRED` (all 409). |
| `portalAuthService.ts` | `equipment.read` and `equipment.write` (§5). |
| `db/schema.ts` | `revision` column and check; admin-event kinds and actions. |
| `index.ts`, `discord/types.ts`, `routes/v1/index.ts` | Wiring `equipmentCatalogue` and registering the routes. |
| `tests/unit/equipmentPackage.test.ts` | The row fixture gained `revision: 1`. |

**Modified (Portal):** `app/navigation.ts` (an "Admin — Equipment" entry after Reward Tables), `app/router.tsx` (four routes), both session providers (dev permission lists) and `components/admin/artworkSources.ts` (`equipmentArtworkSource`).

---

## 3. Migration `0073_equipment_catalogue_admin`

```sql
ALTER TABLE equipment_definitions ADD COLUMN IF NOT EXISTS revision integer DEFAULT 1 NOT NULL;   -- CHECK revision >= 1
-- equipment_admin_events: subject_kind adds 'definition';
--   action adds 'enabled','disabled','duplicated','imported'
```

- **Why:** E3-A–E3-C added no definition revision. The architecture requires integer optimistic concurrency, not `updated_at`.
- **Effect:** additive and widening only. Existing rows start at revision 1, existing audit rows still satisfy both checks, and no owned copy is touched.
- **Idempotent:** guarded with `IF NOT EXISTS`, and each constraint is dropped and re-created.
- **Tested:** every test database applies `0001…0073`. The API suite asserts existing definitions read revision 1 and that `revision = 0` is refused.
- **Rollback:** drop the column and check, delete `definition` audit rows, and restore the 0071 checks.

---

## 4. Admin API routes (`/api/v1/admin/equipment`)

| Method and route | Permission | Purpose |
| --- | --- | --- |
| `GET /definitions?q&rarity&slot&status&sort&direction&page&pageSize` | read | Search (key, name, description), filter, sort, page, with catalogue counts per rarity and status |
| `GET /definitions/:key` | read | Definition, revision, field locks, roll analysis, availability |
| `POST /definitions/validate` | read | Dry run of create or save |
| `POST /definitions` | write | Create. **Always disabled.** |
| `PUT /definitions/:key` | write | Save with `expectedRevision`. The enabled state is kept. |
| `PUT /definitions/:key/enabled` | write | Enable or disable with `expectedRevision`; `acknowledgeRewardImpact` where needed |
| `POST /definitions/:key/duplicate` | write | Create from a copy, through the normal create path. Disabled. |
| `GET /definitions/:key/impact` | read | Automatic reward sources it would join |
| `POST /roll-preview` | read | Analysis plus up to 20 seeded samples, for a key or an unsaved definition |
| `GET /export?keys=…` or a filter | read | A package v3 of everything, the named keys, or the filtered set |
| `POST /import/preview` | write | The plan, `planHash`, status overrides and reward impact |
| `POST /import/apply` | write | Atomic apply of the previewed plan |
| `GET /history?key` | read | Definition audit events and the package import log |
| `GET /artwork`, `/artwork/browse`, `/artwork/search` | read | The shared artwork picker, rooted at `equipment/` (§9) |

Conventions:

- The routes follow the Enemy Catalogue's conventions: `requirePortalPermission` (session or bearer), the CSRF double-submit on writes, the response envelope, and `ApiErrorWithDetails`.
- Validation errors are `400 EQUIPMENT_INVALID` with per-field `details.issues`.
- The actor always comes from the session, never the body.
- There is **no player-granting endpoint and no delete route.** Delete was not in scope; the service method exists and is not exposed.

---

## 5. Permissions and auditing

- **`equipment.read`:** list, view, validate, impact, roll previews, export, history and artwork browsing.
- **`equipment.write`:** create, edit, enable/disable, duplicate, import preview and import apply.
- Both are delegable to roles and described for the Role Access screen. `equipment.publish` is reserved for the E3-E rules editor and is **not** registered.
- **Enforcement** is server-side on every route. The Portal routes and controls are gated too, but only as a courtesy.

**Auditing.** `equipment_admin_events`, subject `definition`, keyed by the definition key:

| Action | Details |
| --- | --- |
| `created` / `duplicated` | revision, rarity, slot, enabled, `duplicatedFrom` |
| `updated` | revision, previous revision, changed field names |
| `enabled` / `disabled` | revision, previous revision, previous state |
| `imported` | create or update, import log id, revision, changed fields, package version and label |

- `equipment_import_log` still records each package.
- Rows are written in the same transaction as the change.
- Actor ids are the Portal session's Discord id, or null for a bearer or system action. No player data is recorded.

---

## 6. Portal Catalogue features

**Admin — Equipment** (`/admin/equipment`):

- Search by key, name or description; filters for rarity (all six), slot and status; sort by key, name, rarity, slot, last changed or copies owned, either direction; pages of 25.
- Counts: total, enabled, disabled, and per rarity.
- Each row shows its rarity and status badges, slot, multiplier range and owned count.
- **Actions:** Create equipment, Import JSON, Export all, Export filtered, Export *n* selected (checkboxes), and per-row Enable/Disable, Duplicate and Edit/View.
- It reuses the existing admin primitives (`PageHeader`, `Card`, `Badge`, `Dialog`, `selectClass`, `ErrorState`); no new framework was introduced.
- **Read-only** without `equipment.write`: no create, import, toggle or duplicate controls, and "View" in place of "Edit".

---

## 7. Manual authoring

`/admin/equipment/new` and `/admin/equipment/:key` share one editor.

**Fields and how they behave:**

- **Identity.** Display name; key (made from the name, editable at creation, permanent afterwards); description.
- **Rarity** (N…LR) and **slot.** Both are disabled once copies exist, and the notice gives the number ("5 copies exist").
- **Strength.** The minimum and maximum multiplier and the step, entered as decimals (`1.25` means ×1.25) and converted to basis points.
- **SSR/UR/LR roll settings.** The "Can roll primary SP" toggle. The **maximum additional bonuses** select: "the rarity's own maximum", or at most 0–3. It is explained as *a ceiling, not a guarantee*, and the chances and ranges are said to come from the published rules.
- **N/R/SR.** Those controls are not offered. A notice says the standard roll applies and the policy is SSR/UR/LR-only. Switching a draft back to N/R/SR sends the default policy, so the server never sees an invalid one.
- **Artwork and labels.** Artwork is picked from the equipment folder, or typed, previewed and cleared. Tags and region id are also here.
- **Field effects** are labelled: *future rolls only*, *changes how existing copies are shown*, and *fixed once copies exist*.

**Validation.** The server is the authority, through the shared `EquipmentDefinitionInputSchema` and the definition service. The Portal does only a key-shape hint before the round trip. Refusals are shown at the fields they name, with the basis-point paths mapped to the decimal fields. "Check for problems" runs the dry-run route.

**Creation is always disabled.** The service overwrites `enabled` on create, duplicate and import (create), so no request can bypass it (tested).

**Integrity:**

- **Kept unchanged:** key immutability, the slot and rarity locks (removed copies included), the roll-policy feasibility checks, and E3-C's grant idempotency.
- **Owned copies:** a policy edit leaves every owned copy byte-identical (tested).
- **Enabled state:** an edit never changes it.

**Concurrency.**

- Every save and toggle sends `expectedRevision`.
- A stale write is a 409 with `expectedRevision`, `currentRevision` and `updatedBy`. The editor shows a banner and offers a reload; it never overwrites.
- There are no `Date` round-trips.

**History.** The editor lists the definition's audit events.

---

## 8. Import, export, and enable/disable safety

**Export:**

- Package **v3** (`waifumon-equipment`): every definition, named keys, or the current filter.
- **Definitions only:** never owned copies, rolls, revisions or counts. The output round-trips as "unchanged" (tested).

**Import** (`/admin/equipment/import`):

1. Upload a JSON file (2 MB ceiling) or paste. JSON syntax is checked in the browser.
2. **Preview** (`previewImport`):
   - schema refusals by path;
   - the create, update and unchanged plan, with changed fields;
   - the locked-slot, locked-rarity and infeasible-policy refusals (the existing planner);
   - **status overrides:** new definitions arrive disabled even when the file says enabled, and updated ones keep their current enabled state;
   - **reward impact** of each new N/R/SR definition once enabled.
3. **Explicit confirmation:** a checkbox, then Import.
4. **Atomic apply** with the preview's `planHash`. The hash covers the adjusted definitions and each key's revision and copy count. If anything moved, the result is `409 EQUIPMENT_IMPORT_STALE` and nothing is applied (tested).
5. The **result** links each changed definition and names the import log id.

v2 and v3 are both read. All six rarities validate. Nothing creates reward entries.

**Enable/disable.** Each case is tested end to end:

- **N/R/SR.** The dialog fetches `GET …/impact`. This resolves every live automatic selector with the real `eligibleRewardDefinitions` (enabled boss and expedition reward tables, active World Encounter `give_equipment` choices, enabled Workshop recipes, and dungeon loot tables), comparing the result with the definition switched on. Nothing is inferred from rarity alone.
  - Each source is labelled immediately, next mission deployed, or next dungeon publish.
  - If any source pays it immediately, the server refuses the enable until `acknowledgeRewardImpact` is sent. The Portal requires a tick first.
  - Example: enabling any N definition joins the `standard_rebuild` Workshop recipe at once.
- **SSR/UR/LR.**
  - Impact is always empty, because no selector can name these rarities.
  - The dialog says enabling does not make the item obtainable.
  - The detail page separates **(1) definition enabled**, **(2) roll configuration published / unconfigured / invalid, and rollable or not**, and **(3) reward sources: none for this rarity yet**.
  - E3-C's feasibility check still refuses enabling a definition whose bonus maximum leaves no rollable count.

---

## 9. Artwork integration

**Finding.**

- Equipment artwork is a **shipped path** (`artworkPath`, relative to `ASSETS_DIR`, convention `equipment/…`).
- Today only the onboarding hand-over renders it. No definition sets one, and `assets/equipment/` does not exist yet.
- The managed category `equipment_art` exists, but nothing reads it.

**Smallest compatible integration.**

- `GET /admin/equipment/artwork[/browse|/search]` reuse the shared `browseAdminArtwork` and `searchAdminArtwork` helpers (path shape, containment, symlink-safe roots).
- The roots are fixed server-side to `equipment/`. The bytes route refuses any path outside it (400), so these routes cannot reach another area's artwork (tested).
- The editor uses the existing `ArtworkPickerDialog` through a new `equipmentArtworkSource`, and `AuthoredArtwork` for the preview.
- Existing references are unchanged, and no schema change was needed.

**Not done:**

- managed uploads by asset id;
- an `artwork_asset_id` column;
- player-facing rendering of item art.

These need a display decision and a column (§12).

---

## 10. Roll preview

- **Backend-authoritative.** `previewRoll` reads the published rules (`forGrant`, inside a read-only transaction) and the assigned library. It calls E3-C's `planHighRarityRoll` and `analyseHighRarityRoll` and the real `rollEquipmentInstance`. The Portal formats the answers; it never rolls.
- **High rarity:**
  - published, unconfigured or invalid status, and the rules revision;
  - primary SP eligibility, and its probability and range;
  - the bonus maximum, and the reachable counts with exact renormalised probabilities;
  - the eligible families and their ranges;
  - the possible flat SP range on one copy;
  - the affix library and revision, or affixless;
  - every planner issue.
- **N/R/SR (read-only):** the legacy chance and count, the families and ranges for the rarity, and the affix pool size.
- **Seeded samples:**
  - Up to 20 rolls on a **private** `seededRng(seed)`; the same seed gives the same samples.
  - Each shows the display name, multiplier, bonuses, primary SP and total flat SP.
  - It works for an unsaved form too.
- **Writes nothing.** The PostgreSQL test asserts the counts of `player_equipment` and `equipment_events` are unchanged. The grant RNG is never touched and the published configuration is only read.
- **When samples cannot be drawn**, `sampleError` explains why. This is the case for an unconfigured SSR today.

---

## 11. Tests and build results

| Check | Result |
| --- | --- |
| Backend typecheck (`npm run typecheck`) | Clean |
| Backend build (`npm run build`) | Clean |
| Portal typecheck (`tsc --noEmit`) | Clean |
| Portal build | `npm run build` is refused by the repository's `verify-build-env` guard because a local `portal/.env.local` exists (as in E3-A; left alone). It was verified with `vite build --mode e2e` into a scratch folder: **built**, including the three Equipment page chunks. The output was deleted afterwards. |
| Portal ESLint (new and changed files) | Clean |
| Portal Prettier | New files clean. `navigation.ts`, `router.tsx` and `artworkSources.ts` were already flagged at HEAD (checked in a clean worktree); they were not reformatted. |
| `git diff --check`, plus a trailing-whitespace scan of new files | Clean |
| Golden gate (6,000 rolls) | **62 / 62** — 6,000 / 6,000 identical on both paths. Fixture sha256 `308b5a81…69ee13` unchanged. |
| New API suite (`adminEquipmentCatalogue`, PostgreSQL) | **30 / 30** |
| New Portal suite (`EquipmentCatalogue.test.tsx`) | **26 / 26** |

**What the new suites cover.**

- **API:** list, filter, sort and page; create of all six rarities, forced disabled; policy storage and legacy refusal; key-taken and dry run; revision conflicts and audit details; enabled kept on edit; immutable key; slot and rarity locks with owned copies untouched; impact from live selectors; the confirmation-required enable; SSR enable without impact or eligibility; stale toggle; duplicate (fields only, disabled, audited); roll previews (legacy, seeded determinism, no inventory or events written, unsaved and unconfigured SSR); export v3 (all, keys, filter); round trip; import preview and apply with status overrides, impact, log and audit; stale import; atomic refusal; v2 compatibility and path issues; history; artwork root confinement; permissions (none, player, reader, writer, CSRF, actor recording); migration 0073.
- **Portal:** list, counts and all six rarity options; filters reaching the server; export of all and of a selection; read-only list; enable with impact and a required tick; SSR enable needing no tick but carrying the "not obtainable" note; disable without an impact call; duplicate with a key check; the legacy restriction display; the SSR create path (toggle, ceiling hint, decimal-to-basis-point conversion, disabled); switching back to legacy sending defaults; server issues at fields; the stale banner; lock display; the three-way availability card; seeded preview; artwork picker filling the path; the read-only editor; import (bad JSON, preview with overrides and impact, confirm-then-apply, refused plan, stale apply, package issues); route gating and the navigation entry.

**Focused backend comparison.** The baseline is a clean worktree of `14142eb`, run with the identical file set: the equipment, dungeon, expedition, boss, Workshop, World Encounter, combat, API, Portal-auth, and API and Portal integration suites.

| | Tests | Failed |
| --- | --- | --- |
| Baseline (`14142eb`) | 5,342 | 55 |
| After | 5,372 (30 new) | 52 |

- **No new failures:** every failure after the change also fails at baseline.
- Three tests failed only at baseline and passed after:
  - `bossScheduler` › "suspends with an actionable message…";
  - `dungeonImportV2` › "serializes same-request retries…";
  - `dungeonPackageV4` › "replacement disables publication…".
- These are the load- and timing-dependent tests earlier phases documented. None touches equipment definitions.
- The existing equipment suites pass unchanged, apart from their baseline failures (`equipmentBaseCatalogue` ×1, `equipmentWorkshopConfig` ×1, and the pre-existing `api/errors` classification test). That includes:
  - `equipmentContent`, `equipmentRewards`, `equipmentWorkshop`, `equipmentManagedRules`, `equipmentHighRarity` and `equipmentRewardPins`;
  - the reward-selector and rarity-capability suites;
  - the migration suites.

**Portal suite comparison.** The full Portal suite ran at baseline and after.

| | Tests | Failed |
| --- | --- | --- |
| Baseline (`14142eb`) | 1,843 | 9 |
| After | 1,869 (26 new) | 4 |

- The failing set moves between runs.
- The one test failing only after was `adminDungeonLoot/LootEditor` › "Test Roll rolls the unsaved table…", which asserts the last call of a spy. Run alone twice, it passed both times (22 / 22). It imports nothing from the Equipment Catalogue.
- The five baseline-only failures (collection and species-tag pages) are untouched by this change; they pass here by the same load variance.

**Not run:** the full root suite (deliberately; the brief asks not to run it automatically). Portal E2E (Playwright) was also not run.

---

## 12. Known limitations

1. **Managed artwork uploads.**
   - **Current state:** the editor picks shipped files under `equipment/` only; uploads (the `equipment_art` category) are not wired.
   - **Why:** there is no `artwork_asset_id` column, and no player surface renders item art except onboarding.
2. **Delete** is not exposed. Disable is the supported withdrawal.
3. **Region** is a free-text id. The server validates it, but there is no picker.
4. **Shop fields** (`shopRegions`, `buyPrice`, `priceCurrency`) and `secondaryEffects` are carried through unchanged but not shown. No shop reads them.
5. **Impact timing.** The reward-impact check is a point-in-time read. A reward source changed after the dialog loads is caught only by the server's re-check at enable time, which reruns the same impact. Dungeons' inline reward bundles are not listed: they snapshot their pools at publish, and the next publish validates them.
6. **Import preview** needs `equipment.write`, because it is part of the import workflow. Export needs only `equipment.read`.
7. **Paging is in memory.** The list filters and pages on the server, over the whole catalogue (≤ 1,000 definitions by the package ceiling). There is no database-level paging.

**Not accessible through the Portal:**

- rarity-rule editing and publishing (E3-E);
- affix-library editing (E3-E);
- managed artwork upload (above);
- delete;
- authoring an SSR/UR/LR reward source (E3-F).

---

## 13. E3-E dependencies

- **Rules editor:** the draft, validate, publish and rollback screens over `EquipmentRollRulesService`; register `equipment.publish` with it. Until then, the SSR/UR/LR roll preview correctly reports "unconfigured" in production.
- **Affix-library editor** over `EquipmentAffixLibraryService`.
- **Previews:** the analytic and sampled preview here reuses the engine directly. E3-E can call `POST /admin/equipment/roll-preview` with a draft rule set by extending the service to accept draft rules, a small change. Today it reads published rules only.
- **Audit:** the E3-B rule and library events already share `equipment_admin_events`; definition events use the same table.

---

## 14. E3-F integration dependencies

- **No reward schema can name SSR/UR/LR.** Reward selectors, dungeon loot snapshots, Workshop recipes and World Encounter effects all stay on `EQUIPMENT_REWARD_RARITIES`.
- An explicit high-rarity reward needs a deliberate schema addition. When it lands:
  - extend the Catalogue's impact sources so SSR/UR/LR show their explicit sources;
  - update the third line of the availability card.
- Delayed sources must pass E3-C's roll pin; the dungeon and expedition paths already do.
- **Workshop:** SSR+ salvage and fabrication remain undefined.
