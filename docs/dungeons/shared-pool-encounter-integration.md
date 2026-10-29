# Shared pool encounter integration fix

Completed 2026-10-29 on `Delve`, HEAD
`ca57684fbdbfc94c07e58e3b9b12d5429be92f6f`. Changes remain uncommitted.

## Root cause and investigation

This was a Portal integration defect, not a shared-catalogue loading failure or
backend restriction:

- `DungeonSpeciesPoolsPanel.tsx` offered a shared picker that attached a
  `speciesPools` reference to the draft. `SpeciesPoolSheet.tsx` could replace its
  shared key after attachment.
- `EncounterActivity.tsx` only listed `definition.speciesPools`, so a Wild
  Encounter could see shared pools only after that manual attachment step.
- `SharedPoolPicker.tsx` and the existing `listSharedPools` API already provided
  searchable catalogue data, including enabled status and complete entries.
  No reference endpoint or backend metadata extension was needed.
- `ActivityCard.tsx` already received a whole-definition edit callback, but did
  not pass it to the encounter controls. Editing only the activity could not
  atomically attach the reference and select its local ID.
- Save/reopen testing exposed a second existing defect:
  `incompleteSpeciesIssues` treated required shared-reference `entries: []` as an
  unfinished local pool, disabling Save draft. Client preflight now distinguishes
  shared references from embedded pools and agrees with the existing backend
  shape rules.

The backend already accepts local pool definitions or references containing
`sharedPoolKey` and empty entries. Validation resolves enabled catalogue bodies;
run start freezes them in the dependency snapshot. That architecture is
sufficient and remains unchanged.

## Resulting author workflow

1. Add/open a **Wild Encounter** and choose **WaifuMon pool** as its Encounter
   source. Specific WaifuMon selection remains available as before.
2. Search **local and shared pools** directly in the activity. Options are
   grouped as Dungeon-local pools and Shared Dungeon WaifuMon pools. Labels show
   names, shared enabled/disabled status and distinct species counts; Nothing
   entries do not inflate those counts.
3. Selecting a local pool keeps the existing action-to-local-ID behavior.
   Selecting an enabled shared pool atomically attaches or reuses a local
   reference and sets the action's `poolId` to it. No settings-panel detour is
   required.
4. Review the existing server validation and **Species access…** control. The
   activity identifies currently known candidates needing access review using
   the existing policy-view helper. Selecting a pool never adds or changes an
   acquisition policy.
5. Save and reopen normally. The saved reference ID is retained, and multiple
   encounters selecting the same shared key reuse the same reference.

The same controls are shared with existing Rescue activities, retaining their
capture/Direct Rescue restrictions and specific-species support.

## Reference and availability behavior

The serialized representation is unchanged:

```json
{
  "speciesPools": [
    {
      "id": "sp_example",
      "name": "Shared Angels",
      "sharedPoolKey": "shared_angels",
      "entries": []
    }
  ]
}
```

The activity still contains `{ "kind": "pool", "poolId": "sp_example" }`.
Search option values such as `shared:shared_angels` are UI values only; they are
never stored as encounter sources or pool IDs.

Reference selection prefers the encounter's current reference when it already
matches, otherwise reuses the first attached reference with the same shared
key. It creates an ID through the existing pool ID generator only when needed.
Legacy duplicate references are not rewritten or removed, preserving other
activities' stable IDs. Existing local entries, weights, conditions and dungeon
policies remain intact.

- Disabled shared pools are visible for diagnosis but cannot be newly selected.
- Existing disabled/missing dependencies retain their current selection and
  reference, with an explicit warning; no replacement is selected automatically.
- Loading failures show an availability-verification error and Retry control,
  rather than claiming a pool is missing. Local pool selection still works.
- Searching retains the current selection even when it does not match the
  search. Filtering never rewrites the activity.
- At the existing 30-pool limit, another attached shared key can be reused, but
  attaching a new one is disabled with an explanation.
- Client save preflight accepts a valid shared key with empty entries, rejects
  invalid shared keys and embedded fallbacks, and keeps local pool entry checks.
  Backend validation remains authoritative for live dependency availability,
  compatibility and acquisition permissions.

## Files changed by this fix

| File | Change |
|---|---|
| `portal/src/features/adminDungeons/EncounterPoolPicker.tsx` | New searchable grouped selector, availability warnings, counts and Species access entry point |
| `portal/src/features/adminDungeons/EncounterActivity.tsx` | Uses the selector and commits atomic shared-reference selection through definition updates |
| `portal/src/features/adminDungeons/ActivityCard.tsx` | Passes its existing definition-edit callback to encounter controls |
| `portal/src/features/adminDungeons/dungeonSpeciesModel.ts` | Attach/reuse helper; correct shared-reference client preflight |
| `portal/src/features/adminDungeons/__tests__/SharedPoolEncounterIntegration.test.tsx` | New focused interaction, model, preflight and save/reopen coverage |
| `portal/src/features/adminDungeons/__tests__/EncounterAuthoring.test.tsx` | Supplies the definition callback in its harness and stubs catalogue reads |
| This document | Completion report |

## Compatibility and scope

No backend code, API format, database schema, migration (including `0074`),
catalogue persistence, published revision, run snapshot, RNG, probability
calculation, species content, acquisition rule/limit or Region Pool behavior was
changed. Existing probability analysis and validation requests continue through
their original endpoints. Shared catalogue reads use the existing
`dungeons.read` endpoint/query key; the editor retains its existing write and
read-only controls.

The existing panel/sheet attachment workflow remains available. Direct activity
selection adds no competing reference format and performs no automatic
publication, policy creation, pool enabling or content import.

The working tree already contained unrelated CP-1 equipment/import/nginx/error
changes, its tests and `docs/content-portability-cp1-completion.md`. They were
preserved. This fix did not implement or extend Content Portability. No
subagents, commits, pushes, merges or deployments were used.

## Verification

| Check | Result |
|---|---|
| New integration/preflight tests | **10/10 pass**: direct shared choice, local choice/search, automatic attachment, multiple-encounter reuse, disabled/missing/offline states, unchanged policy with Species access feedback, legacy reference identities/limit, and real editor draft save/reopen |
| Focused Portal compatibility run | **64/64 pass** across 8 files: new integration, existing encounter authoring, species model, v4 import, dungeon routes and shared-pool catalogue UX tests |
| Existing local-pool Portal suite | **9/10 pass**; only the documented pre-existing close/reopen failure at `DungeonSpeciesPools.test.tsx:113` remains (projectmem #0159). Its sheet and test were not changed. |
| Portal typecheck | **Pass** |
| Portal production build | **Pass**, including TypeScript, environment guard and Vite |
| Production bundle verification | **Pass**, 168 bundle files checked |
| `git diff --check` | **Pass** |

The production build used an isolated copy without development `.env*` files;
development configuration was preserved. The saved/reopened editor test verifies
both the local reference ID and the activity source and retains the existing
API validation issue feedback. No backend tests were required because backend
code is unchanged. No full-root suite or expensive root comparison was run.

## Limitations

Shared selection requires a successful catalogue read. Unknown/disabled/missing
dependencies cannot be silently repaired. An administrator must explicitly
repair the key or availability and resolve any dungeon-specific policy or
condition incompatibility through existing controls. Catalogue changes after an
editor read remain subject to the unchanged backend validation at publish and
new-run start.

Switching sources does not automatically delete unused pool definitions or
references. Historical duplicate reference IDs are retained intentionally;
new direct selections reuse existing references instead of creating more.

Only this integration fix is complete. All changes are left uncommitted for
review.
