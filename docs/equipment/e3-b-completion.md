# Equipment 3.0 — E3-B Completion Report

**Phase E3-B: managed rarity rules and affix libraries.**

- Backend only, uncommitted, for review.
- E3-C was not started.
- Design basis: [equipment-3-architecture.md](equipment-3-architecture.md) and [e3-a-completion.md](e3-a-completion.md).

> **Nothing in this phase is reachable from the Portal or Discord.** The services are wired into the app (`AppServices.equipmentRollRules`, `AppServices.equipmentAffixLibraries`) and fully tested, but no route, page or command calls them. The admin routes, permissions and pages are E3-D/E3-E.

---

## 1. Repository state

| | |
| --- | --- |
| Branch | `Delve` |
| HEAD | `47c43a5` — "Equipment Rework Phase A" (E3-A, committed). Unchanged; nothing committed. |
| Initial working tree | Clean. E3-A present: migration `0070_equipment_three_bonuses`, journal entry 70, the golden fixture. |
| Final working tree | 11 modified files and 9 new files (listed in §2 and §3). No unrelated changes. |
| Migration added | `0071_equipment_managed_rules` (journal entry 71) |

---

## 2. Changes

**New modules (backend):**

| File | Role |
| --- | --- |
| `src/modules/equipment/rollRules.ts` | The `waifumon-equipment-roll-config` v2 document: Zod schema, `bootstrapRollRules`, the `legacyCombatBonusCatalogue` adapter, `validateRollRules`, canonical hashing, `diffRollRules`, `assignedLibraries`, and the export/import envelope. Pure. |
| `src/modules/equipment/affixLibraries.ts` | Managed affix entries: schema, global key/suffix namespace, the read-only `legacyAffixLibraries` view of the shipped catalogue, the suffix snapshot (`affixSuffix` / `affixLibrary`), and the export/import envelope. Pure. |
| `src/modules/equipment/equipmentRollRulesService.ts` | Bootstrap, drift detection, the draft/validate/preview/publish/history/rollback/export/import lifecycle, the advisory lock, the audit recorder, and `forGrant` — the one runtime read. |
| `src/modules/equipment/equipmentAffixLibraryService.ts` | Library lifecycle (create, meta, draft, upsert entry, validate, publish, history, rollback, export/import), `list` (managed plus read-only legacy), and `resolveAssignment`. |

**Modified:**

| File | Change |
| --- | --- |
| `src/db/schema.ts` | The five tables (§3). |
| `src/modules/equipment/equipmentService.ts` | Optional `rollRules` dependency. A random grant reads one published revision in its own transaction and passes its frozen legacy catalogue to the **unchanged** roll. Grant event metadata gains `rollRulesRevision`. `GrantKeyRecord.rolledProperties`. |
| `src/modules/equipment/equipmentRoll.ts` | `equipmentDisplayName` prefers a `rolled_properties.affixSuffix` snapshot when one exists. |
| `equipmentQueries.ts`, `equipmentService.ts`, `equipmentRewardService.ts` | Pass `rolledProperties` to the display name. `readUnknownAffixKeys` skips snapshotted copies. |
| `src/index.ts` | Builds both services. The equipment service gets `rollRules`; the content `getCombatBonuses` getter is no longer wired. `bootstrapRollRules` runs at startup (before Discord login) and after every content reload. |
| `src/discord/types.ts` | The two services on `AppServices` (backend only). |
| `src/shared/errors.ts`, `src/api/errors.ts` | See the error table below. |
| `drizzle/meta/_journal.json` | Entry 71. |

New errors and their HTTP mappings (ready for E3-D routes):

| Error | Code | Status |
| --- | --- | --- |
| `EquipmentConfigStaleError` | `EQUIPMENT_CONFIG_STALE` | 409 |
| `EquipmentConfigInvalidError` | `EQUIPMENT_CONFIG_INVALID` | 400 |
| `EquipmentConfigNotFoundError` | `EQUIPMENT_CONFIG_NOT_FOUND` | 404 |
| `EquipmentConfigConflictError` | `EQUIPMENT_CONFIG_CONFLICT` | 409 |
| `EquipmentRulesUnavailableError` | `EQUIPMENT_RULES_UNAVAILABLE` | 503 |

**Tests:**

- New: `tests/unit/equipmentRollRules.test.ts` (34), `tests/unit/equipmentAffixLibraries.test.ts` (15), `tests/integration/equipmentManagedRules.test.ts` (26).
- `tests/unit/equipmentRollGolden.test.ts` gains a second 6,000-roll suite through the published-rules path (31 → 62 tests). The fixture is unchanged.

---

## 3. Migration `0071_equipment_managed_rules`

One coherent migration. It is additive only and writes no rows. No existing table, row or constraint changes.

| Table | Purpose | Integrity |
| --- | --- | --- |
| `equipment_roll_config` | The single configuration row (`id = 1`): `draft_body`, `draft_revision`, `draft_hash`, `published_revision_id`, updated by/at. | singleton CHECK; revision ≥ 1; `sha256:` hash format; object body; FK to the published revision (NOT NULL) |
| `equipment_roll_config_revisions` | Immutable published rule revisions: `number` (unique), `body`, `content_hash`, `source` (`bootstrap`/`editor`/`import`/`rollback`), `rolled_back_from`, `draft_revision`, published by/at. | **update/delete trigger** (`restrict_violation`); CHECKs; self-FK |
| `equipment_affix_libraries` | One row per managed library: key, name, description, draft entries, draft revision and hash, published pointer, created and updated by/at. | key pattern; ≤ 64 chars; **`legacy`/`legacy_*` reserved**; name CHECK; array entries |
| `equipment_affix_library_revisions` | Immutable published library revisions: `(library_key, number)` unique, name, description, entries, hash, source, rollback link. | **update/delete trigger**; CHECKs; FKs |
| `equipment_admin_events` | Append-only audit for both subjects: kind, key, action, actor, details, timestamp. | kind and action CHECKs; indexed by `(kind, key, id desc)` |

**Verified against PostgreSQL 16:**

- Every integration test database applies the full chain `0001…0071`.
- The new suite asserts both triggers refuse `UPDATE` and `DELETE`.
- It asserts that bootstrap, publish and rollback leave `player_equipment` byte-identical.
- The E3-A suite (`equipment3Foundations`, which re-runs `0070`) still passes.

**Rollback.**

- Dropping the five tables and the `equipment_revisions_immutable()` function undoes 0071. This loses all revisions and audit rows, and pre-E3-B code would read the shipped JSON again.
- The equipment service must then be wired back to `getCombatBonuses`.
- Once E3-C grants managed-library copies, their names survive even this, because the suffix is snapshotted on the copy (§7).
- The migration is idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS` before re-creating constraints and triggers).

---

## 4. Bootstrap and authoritative configuration

`bootstrapEquipmentRollRules(db, shipped)` runs under the equipment-configuration advisory lock (`pg_advisory_xact_lock(hashtextextended('equipment_config', 0))`):

| Situation | Behaviour |
| --- | --- |
| No configuration row, shipped file present | Creates revision 1 (`source: bootstrap`, `system:bootstrap`). The body is the shipped `combatBonuses.json` as the frozen `legacy` block, `rarities: {}`, and `flatSpLimits: {200, 400}` (E3-A's approved rails). The draft is set equal to it. Writes a `bootstrapped` event. |
| Row exists | **Never writes the configuration.** If the shipped legacy rules differ from the published ones, it reports `drift: true` and writes **one** `drift_detected` event per distinct shipped content (not one per restart). The bot logs a warning. |
| No row, no shipped file | Does nothing (`absent`). Random grants then fail closed. |

**When it runs:**

- At startup, before `client.login`, so no grant can precede it.
- After every Portal content reload (drift check only).
- Two processes starting at once serialise on the advisory lock.

**One live source.** In production, `grantEquipment` reads only the **published** revision. Neither the draft nor `content/equipment/combatBonuses.json` is read by gameplay any more. The content loader still validates the file, which remains the bootstrap source and the drift reference. The deployed JSON is unchanged.

**Never a silent switch.** If the database has no configuration (bootstrap failed or never ran), a random grant throws `EquipmentRulesUnavailableError` (503) rather than falling back to the file. Fixed grants (onboarding, restores) don't read rules and are unaffected. Both cases are tested.

---

## 5. Draft, validate, preview, publish, rollback

`EquipmentRollRulesService`:

| Method | Semantics |
| --- | --- |
| `published()` / `draft()` | Current published revision (number, hash, source, author, rules) and the working draft (`draftRevision`, `dirty`, …). |
| `saveDraft(rules, { expectedDraftRevision, actor })` | Integer-revision optimistic concurrency (stale → `EQUIPMENT_CONFIG_STALE`). Refuses a malformed document or **any change to the N/R/SR legacy block**. Feasibility and library rules are deliberately left to `validate`/`publish`, so an author can save work in progress. Never reaches live grants. |
| `validate(rules?)` | Full validation of a document, or of the saved draft, against the live libraries. Returns errors and warnings. |
| `preview()` | Validation plus a field-level diff from published to draft. |
| `publish({ expectedDraftRevision, actor })` | In one transaction: advisory lock, config row `FOR UPDATE`, stale check, refuse an unchanged draft, **re-validate under the lock**, insert an immutable revision, move the pointer, write an audit event (with change paths and warnings). |
| `revisions()` | History, newest first, with source, rollback origin and which one is current. |
| `rollback(n, { expectedDraftRevision, actor })` | Re-validates revision *n* against today's libraries, then publishes its body as a **new** revision (`source: rollback`, `rolled_back_from`). The draft becomes that body. Rolling back to the current revision is refused. |
| `export('published' \| 'draft')` / `importDraft(file, …)` | §10. |

**Validation.** The rules are in `rollRules.ts` and all integer arithmetic:

- Rarities: only SSR/UR/LR may appear in `rarities`, and N/R/SR are refused there. EX is refused.
- Count weights: exactly four integer basis-point weights (counts 0–3), each ≥ 0, totalling **exactly 10000**.
- Families: the five combat families plus `flat_sp`. No duplicates. Slots must be `attack`/`defense`/`health`, non-empty and unique.
- **Feasibility:** for every slot, the number of distinct enabled families must be at least the highest count with positive weight, because rolls draw without replacement.
- Ranges: `min ≤ max`, the step divides the span, and `max` stays within the family's combat cap (`maxCombatBonusValueBp`). For `flat_sp`, `max` stays within the configured per-copy SP cap.
- Primary SP: chance between 0 and 10000 bp, with a valid range. `primarySp.max` plus the largest `flat_sp` max must fit the per-copy cap, so a copy can never be rolled past it.
- `flatSpLimits`: per-copy 1–200 and per-loadout 1–400 (never above E3-A's code rails), with per-copy ≤ per-loadout.
- Affix assignment: `none`, or a managed library that exists, is published, and has an enabled entry for **every** slot. Library keys are identifiers only; paths are refused.
- **Warnings** (never errors, caps never raised): a full loadout of typical or max rolls would reach a family's combat cap, or three max-SP copies would reach the loadout SP cap.

**Concurrency.** Integer draft revisions guard every write. A publish naming a superseded draft revision is refused, so if a configuration changes between validation and publication, the author must review it again. This is tested.

---

## 6. Legacy N/R/SR compatibility

- **The N/R/SR rules are frozen in the document.** The `legacy` block is the shipped file, verbatim. Every draft save, publish, rollback and import refuses any change to it. Through the adapter it equals `combatBonusCatalogueFromFile(shipped)` exactly: N 65 % × 1, R 100 % × 1, SR 100 % × 2, and identical ranges and eligibility.
- **The roll algorithm is unchanged.** `rollEquipmentInstance` and `rollCombatBonuses` are untouched. The service only changes *where the catalogue comes from*, through an adapter.
- **Golden gate:**
  - 6,000 / 6,000 identical through the shipped path, before and after the change.
  - **6,000 / 6,000 identical through the new path**: shipped file → bootstrap document → JSON round-trip (as stored) → adapter.
  - Identical means multiplier, affix key, bonus families and magnitudes, and every RNG call's arguments, result and order.
- **The live grant path, in PostgreSQL.** All 30 shipped definitions × 3 seeds were granted through `grantEquipment` with the database rules and a `rollSeed`, as dungeons grant. They equal `rollEquipmentInstance` with the shipped catalogue, and store `rolled_properties = {}`.
- **Unchanged:** affix ordering and pools (the shipped `affixes.json` is still the only N/R/SR source), reward-selector eligibility, the Workshop, and the seeded dungeon rewards. The suites in §11 confirm this.

---

## 7. Managed affix libraries

`EquipmentAffixLibraryService`, keyed by stable identifiers:

- **Create** an empty library. `legacy`/`legacy_*` keys are reserved; a duplicate is a conflict.
- **Draft edits:** `updateMeta`, `saveDraft` (replace entries) and `upsertEntry`, each with `expectedDraftRevision`.
- **Entries** are `{ key, suffix, slots[], enabled }`. Slot eligibility uses the existing slots, and an entry can be active or inactive.
- **Validate:**
  - shape and duplicates;
  - **global uniqueness**: keys and (case-insensitive) suffixes must not collide with the shipped catalogue or any other library. Keys a library ever published stay reserved to it.
  - for a library the published rules use: every slot must keep an enabled entry.
- **Publish** writes an immutable revision; an unchanged draft is refused. **Rollback** publishes an earlier revision as a new one, re-validated. **History** lists revisions and audit events.
- **Assignment** is in the published rules, per rarity:
  - `none` (affixless — valid, and no affix draw);
  - a library shared by several rarities;
  - a dedicated library.

  `resolveAssignment(rarity)` returns `legacy` (N/R/SR), `none`, `library` (key, revision, enabled entries) or `unconfigured`. Disabling a library's last enabled entry for a slot, while a published rarity draws from it, is refused until the assignment changes.
- **Legacy view.** `list()` returns the managed libraries plus three read-only libraries (`legacy_n`, `legacy_r`, `legacy_sr`) built from the live shipped catalogue. Each pool appears in file order, which is exactly the list and order the legacy roll draws from (tested per pool). Nothing is copied or migrated.
- **Library versioning is per library** (architecture decision B10). What a library *does* is decided by the published rules, which carry their own revisions.
- No SSR/UR/LR affix content is authored.

---

## 8. Historical affix resolution

The snapshot field is `player_equipment.rolled_properties`:

```json
{ "affixSuffix": "of the Unbroken Oath", "affixLibrary": "high_rarity" }
```

It is alongside `affix_key` and any `flatSp`.

- **How E3-C populates it:** when a grant draws an entry from a managed library, it stores `affix_key = entry.key` and merges `affixSnapshotProperties(libraryKey, entry)` into `rolled_properties`.
- **Display:** `equipmentDisplayName` uses `affixSuffix` when present, otherwise the shipped catalogue key exactly as before. It is wired through every name path: instance views, combat slot items, gear groups, dismantle copies and reward replays.
- **Startup check:** `readUnknownAffixKeys` ignores snapshotted copies, so a managed key isn't reported as "[Unknown Affix]".
- **Tested:** a snapshotted copy keeps its name after its entry is renamed *and* disabled and the library republished. Legacy copies still resolve through `affixes.json`.
- **No existing row is modified.** Legacy N/R/SR copies have no snapshot and need none; their keys keep resolving through the unchanged shipped file.

---

## 9. Runtime consistency

- **One read per grant.** `forGrant(tx)` reads the configuration row `FOR SHARE` inside the grant's transaction and returns that revision's parsed rules and legacy catalogue. It is called once per `grantEquipment`, before any copy is rolled, so a multi-copy grant uses one revision.
- **Publish ordering.** Publish locks the row `FOR UPDATE`, so it waits for grants in flight, and grants after the commit see the new revision. **Tested:** a publish started while a grant transaction holds the revision stays blocked until the grant commits, and the grant reads the same revision throughout.
- **Cache.** Bodies are cached by revision id. That is safe because revisions are immutable, enforced by trigger.
- **Diagnostics.** Every random grant's `equipment_events` metadata records `rollRulesRevision`. `published()` names the active revision, hash and author.
- **SSR/UR/LR random rolling stays disabled.** The roll still fails closed at the affix-pool check before any draw. Published `rarities` rules are stored and validated but read by nothing yet.
- **Single process.** The API runs inside the bot process. The design also holds across processes, because every grant reads the pointer from Postgres.

---

## 10. Import/export

| Format | Content |
| --- | --- |
| `waifumon-equipment-roll-config-export` v1 | `{ kind: 'published' \| 'draft', revision, contentHash, exportedAt, config }` |
| `waifumon-equipment-affix-library` v1 | `{ kind, revision, exportedAt, library: { key, name, description }, affixes[] }` |

- **Strict envelopes.** Unknown fields, including any path-like field, are refused. Libraries are named by key only, and the server never reads a path from an import.
- **Imports always land in the draft** and are fully validated first. An invalid import changes nothing, and publication is a separate, explicit step.
- **Revision metadata is informational.** A rules import into an edited draft needs the current `expectedDraftRevision`. A hand-edited rules file (hash mismatch) is accepted as a draft and flagged `handEdited`.
- **Library imports:**
  - A new key creates the library only after its entries validate, so a refused file leaves nothing behind.
  - An existing key requires the current draft revision.

---

## 11. Dungeon and delayed grants

How a dungeon equipment drop resolves today, unchanged by E3-B:

| Moment | What is fixed |
| --- | --- |
| Dungeon publish / run start | The reward snapshot freezes candidate **definitions** (N/R/SR only; `EQUIPMENT_REWARD_RARITIES` schemas). |
| During the run (reward selection) | The loot resolver picks a `definitionKey` and derives a `rollSeed` from the run seed. |
| Completion / claim | `grantChosenEquipmentReward(rollSeed)` → `grantEquipment`, which reads the **published rules at claim time**, plus the live definition range and the live affix catalogue. |

**N/R/SR are unaffected by E3-B.** Every revision carries the identical, immutable legacy block, so any revision change between selection and claim produces the same roll. This is tested via the live seeded grant path and the existing `equipmentSeededRewards` suite.

**What E3-C must add for high-rarity rewards.** A rules change between selection and claim *would* change an SSR+ roll. The recommended pinning:

1. Record the published revision number in the promised drop (dungeon reward plan entry; expedition plan) when it is selected.
2. Pass it to `grantEquipment` as an optional `rollRulesRevision`.
3. Have `forGrant` read that revision row by number, not the pointer. Revisions are immutable and never deleted (trigger), so a pinned revision is always available.
4. Pin affix-library revisions the same way, via the library revision the pinned rules resolved.

This is a dependency on E3-C reward snapshots. Dungeon settlement was not redesigned here. Bosses and World Encounters grant immediately, so they need no pin.

---

## 12. Tests and builds

| Check | Result |
| --- | --- |
| Golden gate, shipped path | 6,000 / 6,000 identical, before and after |
| Golden gate, published-rules path (new) | 6,000 / 6,000 identical |
| `equipmentRollRules.test.ts` | 34 / 34 |
| `equipmentAffixLibraries.test.ts` | 15 / 15 |
| `equipmentManagedRules.test.ts` (PostgreSQL) | 26 / 26 |
| Backend typecheck / build | Clean |
| `git diff --check` + trailing-whitespace scan of new files | Clean |
| Portal | Not affected: no shared API type or route changed in E3-B |

**Managed-rule tests (the brief's checklist):**

1. bootstrap from shipped JSON;
2. the first bootstrap state;
3. restarts don't overwrite;
4. content reload (the same idempotent call) doesn't overwrite, and drift is reported once;
5. a draft never affects live reads;
6. publish produces an immutable revision;
7. stale writes and publishes are refused;
8. invalid probabilities are refused;
9. insufficient families are refused;
10. N/R/SR can't change;
11. rollback;
12. a grant resolves a single revision, including under a concurrent publish.

**Library tests (all 10):**

1. empty library;
2. slot-specific entries;
3. a shared assignment;
4. a dedicated assignment;
5. affixless;
6. invalid assignments are refused;
7. snapshotted names survive edits and disables;
8. legacy is unchanged;
9. publish and rollback;
10. import/export.

**Database safety:** migration application, immutability triggers, transactional publication, concurrency, audit rows, and unchanged `player_equipment` rows.

**Full root suite.** The baseline is the 172 failures recorded at `3fbb802` before Equipment 3.0. This run had 9,030 tests and 179 failures.

- **All 172 baseline failures are still present** (none fixed or changed).
- The 7 differences are all outside equipment, and each was checked in isolation:

| Test | Evidence |
| --- | --- |
| `bossScheduler` × 5 (channel suspension, two-message delivery) | Run alone twice, the file fails exactly its 5 baseline tests and these 5 pass. The same file showed this load-dependent behaviour during E3-A. |
| `shared/eventLoopMetrics` "can be restarted after stopping" | Run alone: passed once, failed once. Timing-dependent. It imports nothing E3-B touches. |
| `loadTest/runnerProcess` "exits when its parent disconnects" | The forked child exits with `3221226505` (`0xC0000409`, a native Windows fail-fast crash on disconnect), not an assertion about behaviour. The runner's import chain (`engine` → `profiles`/`stats` → `node:perf_hooks`, latency recorder, `zod`) contains no file E3-B changed. The same test also failed intermittently in the E3-A session's unit run. It is environmental, so it is reported, not fixed. |

- **No equipment, dungeon, Workshop, reward, onboarding or content-loading test regressed.**
- As in E3-A, every full run rewrites `tests/integration/__snapshots__/captureExtraction.test.ts.snap` with LF endings. It was restored with `git checkout`; its content is unchanged.

---

## 13. Remaining E3-C dependencies

1. **The distribution-mode roll** for SSR/UR/LR: renormalised count weights, families, magnitudes, primary SP and the library affix draw. It reads `forGrant(tx).rules.rarities`, and N/R/SR stay on the legacy branch. The golden gate is the regression test.
2. **Per-definition roll policy columns** (`primary_sp_eligible`, `max_additional_bonuses`) and package v3. These were not added in E3-B; they need a migration in E3-C (or E3-D).
3. **Revision pinning** for delayed grants (§11).
4. **Affix snapshot population** on managed-library grants (§8). Gear-bag search by suffix should also match `rolled_properties.affixSuffix`; it currently searches catalogue keys only.
5. **Widen `EQUIPMENT_RANDOM_ROLL_RARITIES`** only when the engine lands. Reward-selector rarities stay N/R/SR.
6. **E3-D/E3-E admin routes and pages.** Add `equipment.read`, `equipment.write` and `equipment.publish` to `ALL_PORTAL_PERMISSIONS` when the first route exists. No permission was added in E3-B, because nothing is reachable.

---

## 14. Risks and recommended staging checks

**Risks:**

- **Bootstrap failure is fail-closed.** If the startup bootstrap fails, every random equipment grant returns `EQUIPMENT_RULES_UNAVAILABLE` until a restart succeeds. That is intended (no silent fallback), but it is loud: watch for the `equipment/rules` error log.
- **Lock contention.** Grants take a `FOR SHARE` row lock on the single configuration row. A publish waits for in-flight grants and briefly blocks new ones while its short transaction commits. The validation work is in-memory and small.
- **Test coverage of the production wiring.** Test helpers (`buildEquipmentServices`) still inject `getCombatBonuses`, so most existing suites exercise the roll without the database rules. The production wiring is covered by `equipmentManagedRules` and by the golden gate's published-path suite.
- **Shipped-file drift.** Edits to `combatBonuses.json` after first boot are **not applied** (drift warning). That is intended; N/R/SR rules are frozen.

**Staging checks after deploy:**

1. Migration 0071 is applied, and `select count(*) from equipment_roll_config` returns 1 after the first start.
2. The startup log shows "equipment roll rules initialised from shipped content" on the first boot only, and no `equipment/rules-drift` warning.
3. `equipment_roll_config_revisions` contains exactly revision 1, `source = 'bootstrap'`, and the body's `legacy` equals the deployed `combatBonuses.json`.
4. A boss or World Encounter equipment payout records `rollRulesRevision: 1` in its `equipment_events` metadata. Its multiplier, affix and bonuses look as before.
5. Restart the bot: no new `bootstrapped` event and no revision 2.
6. Workshop fabrication and a dungeon equipment claim complete normally.
