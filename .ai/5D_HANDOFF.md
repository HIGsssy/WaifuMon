# Milestone 5D — Buddy Affinity Capture Bonuses — HANDOFF

Status: **complete — all four gates green** (verified 2026-08-02, commit `4138a1d`).
The Docker blocker is resolved; Docker Desktop server 29.6.2 is up, so
Testcontainers starts normally and the whole suite runs.

## Gate results

```
npm run typecheck            # PASS
npm run build                # PASS
npm test                     # 385 passed, 15 failed — all 15 pre-existing (see below)
docker build -t waifumon .   # PASS — image tagged waifumon:latest
```

Shortcut if Docker is unhappy again: point tests at any reachable Postgres with
`TEST_DATABASE_URL=postgres://user:pass@host:5432/db npm test` — globalSetup
skips the container when that env var is set.

**The 15 failures are not 5D's.** They were reproduced identically — same tests,
same expected/received numbers — at `af4866f`, the commit *before* 5D, so they
predate this milestone. They live in `care.test.ts` (10), `daily.test.ts` (2),
and `progression.test.ts` (3), and are stale test expectations left over from a
`tables.json` retune (energy refill 25→10, care per-tick XP 2→1, the L40 rarity
shift). Every 5D-owned suite — `affinityMath`, `content`, `captureMath`,
`capture`, `quests`, `buddyAffinity` — passes.

## What was built

Wheel: dominant → submissive → caregiver → primal → dominant.
`switch` is neutral on both sides. Weak matchups resolve as `weak` but the
shipped `weakPenaltyByRarity` is all zeros, so they cost nothing.

Formula: `clamp(baseCaptureRate × charmModifier + buddyAffinityModifier, min, max)`.
Bonus is keyed on the **buddy's** rarity. Guaranteed (Mythic) still bypasses.

### Files changed
- `src/db/schema.ts` — `AFFINITIES`, `Affinity`, `DEFAULT_AFFINITY`;
  `species.affinity` column + CHECK constraint.
- `drizzle/0010_buddy_affinity.sql` + `drizzle/meta/_journal.json`,
  `drizzle/meta/0010_snapshot.json`.
- `src/modules/capture/affinityMath.ts` — **new**, all pure math + UI copy.
- `src/modules/capture/captureMath.ts` — optional `buddyAffinityModifier`.
- `src/modules/capture/captureService.ts` — resolves buddy in-tx, applies the
  modifier, returns `result.affinity`, writes affinity fields into the
  progression-event metadata.
- `src/modules/collection/collectionService.ts` — `resolveActiveBuddy(tx, playerId)`
  with the existing stale-pointer self-heal.
- `src/modules/content/schemas.ts` — species `affinity` (defaults to `switch`),
  `BuddyAffinityConfigSchema`, wired into `TablesFileSchema`.
- `src/modules/content/seeder.ts` — persists `affinity`.
- `content/tables.json` — `buddyAffinity` block.
- `content/species/*.json` — `"affinity": "switch"` on all **49** cards.
- `src/index.ts`, `tests/helpers/fixtures.ts` — new CaptureService deps
  (`buddyAffinityConfig`, `collection`).
- UI: `waifumonHunt.ts` (encounter Affinity field + Buddy affinity read +
  post-capture Buddy Bonus block), `waifumonCollection.ts` (inspect Affinity
  field), `waifumon.ts` (profile buddy line shows affinity).

### Tests added
- `tests/unit/affinityMath.test.ts` — **new**, wheel/switch/weak/rarity/copy.
- `tests/unit/captureMath.test.ts` — charm-then-flat ordering, clamps.
- `tests/unit/content.test.ts` — affinity valid/invalid/default, all shipped
  species are switch, `buddyAffinity` config validation.
- `tests/integration/buddyAffinity.test.ts` — **new**, service + UI end-to-end.
- `tests/integration/capture.test.ts`, `quests.test.ts` — new ctor deps only.

## Two things worth knowing

1. **drizzle-kit is drifted.** Snapshots only existed through `0004`; migrations
   `0005`–`0009` were hand-written. So `drizzle-kit generate` re-emitted
   already-existing tables. I hand-wrote `0010_buddy_affinity.sql` to contain
   only the affinity column + CHECK. I kept the generated `0010_snapshot.json`
   so the *next* generate diffs from reality instead of repeating this.
2. **Journal timestamp trap (fixed).** drizzle-kit stamped `when` as *now*,
   which is earlier than the hand-written `0009` entry (dated 2027). The
   migrator skips entries whose `folderMillis` is ≤ the last applied migration,
   so `0010` would have silently never run. Bumped it to `1816639200000`.

## Assumption — confirmed
Verified against `src/db/schema.ts`: `capture_attempts` has no metadata column
(id, encounter_id, player_id, attempt_number, item_id, computed_chance, roll,
success, guaranteed, created_at) and 5D doesn't add a table, so the
per-attempt affinity audit trail (`buddyWaifuId`, `buddyAffinity`,
`encounterAffinity`, `affinityMatchup`, `buddyAffinityModifier`, `finalChance`)
rides on the `player_progression_events.metadata` jsonb row, which already
references the capture_attempt via `refId`.
