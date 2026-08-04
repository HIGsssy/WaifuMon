# Plan: Gameplay UX Redesign (Ephemeral hunts + activity feed + Trainer Profile)

Recommended path: keep every service (hunt, capture, care, progression, economy) untouched and rework only the Discord presentation layer plus a new activity-feed service, in four incremental phases. Phase 1 is shippable alone.

**Design decisions (confirmed with user):**
- Gameplay events flow through a central `GameEventBus`; the Activity Feed and Trainer Profile are subscribers, not direct writers. Services remain Discord-agnostic. Emissions happen post-commit at the coordinator layer so a broken subscriber can never break a game transaction. Later systems (statistics, achievements, analytics, website integration) drop in as additional subscribers.
- Every `GameEvent` carries a `visibility: 'minor' | 'normal' | 'major'` field describing how broadcast-worthy the event is. It's advisory for subscribers (and later admin config); gameplay logic never branches on it. No filtering UI now, but the field ships so filtering can be layered in without a redesign.
- Every `GameEvent` also carries a unique `eventId` (UUID v4, minted at emit time) alongside `occurredAt`, `kind`, `playerId`, and `payload`. Not consumed by any current subscriber; reserved for future debugging, analytics, replay, duplicate suppression, and audit trails.
- Event catalog is split into two scopes: **player-visible** (eligible for public narration and broadcast) and **internal** (subscriber-only signals that drive things like the Trainer Profile but must never surface in the public Activity Feed). Today `CARE_TICK_APPLIED` is internal; future examples include `ENERGY_REGENERATED`.
- Trainer Profile lifecycle is Care-Mode-only, split into **create / edit / remove**:
  - *Create* (new message at channel bottom): entering Care Mode; changing Buddy while in Care Mode; returning after extended inactivity (future); explicit refresh (future).
  - *Edit* (in-place, keep message id): energy changes; affection changes; buddy level changes; collection progress changes.
  - *Remove*: leaving Care Mode (voluntary, via Energy Drink, or via auto-stop on target released).
  - Recreate only when moving the message to the channel bottom is intentional.
- The existing `guilds.announceChannelId` is reused as the "Waifumon Log" channel. Narrated activity lines AND the existing SR+ rich embeds both go there.
- Activity Feed reads like a living world, not a debug log. Canonical wording table lives in Phase 1 §5; e.g. `❤️ Whistler is spending time with Luna.` rather than `Entered Care Mode`.
- A hunt session represents active player intent to hunt. `PLAYER_STARTED_HUNT` opens a session when a player explicitly begins hunting; `PLAYER_COMPLETED_HUNT` closes it when the player enters Care Mode, explicitly leaves hunting (future feature), or when housekeeping sweeps a long-abandoned session. The inactivity timer is a cleanup mechanism, not the primary lifecycle definition. Individual hunts within a session don't re-announce.
- The play channel publicly shows *only* Trainer Profiles. Everything else the player does is ephemeral.
- Rare-capture rich embeds (SR+) and `@here` mention rules stay exactly as today.
- Ephemeral navigation uses `interaction.update()` per-click on a fresh token — no follow-up-window juggling.

## Phase 1 — Game Event Bus + Activity Feed Subscriber *(shippable standalone)*

**Goal:** Introduce a central event abstraction for all gameplay-significant events. The Activity Feed is its first subscriber and narrates events to `announceChannelId`. Zero change to how the player interacts with the bot.

1. Add `src/modules/events/gameEvents.ts`:
   - `GameEvent` discriminated union. Every event carries `eventId` (UUID v4, minted at emit time), `kind`, `guildId`, `playerId`, `occurredAt`, `visibility` (advisory field for subscribers), `scope: 'player-visible' | 'internal'`, and a kind-specific `payload`. Internal-scope events are never narrated to the Activity Feed regardless of visibility.
   - `GameEventBus` interface: `emit(event)`, `subscribe(handler)`, `unsubscribe(handler)`. Simple in-memory dispatcher. `emit()` invokes subscribers asynchronously and isolates each in its own try/catch so one broken subscriber cannot silence others or affect gameplay.
   - Event catalog. Player-visible events are eligible for narration; internal events are subscriber-only and are labeled below. Format: `KIND` (visibility — notes).
     - `PLAYER_STARTED_HUNT` (major — hunt-session boundary; see §3)
     - `PLAYER_COMPLETED_HUNT` (major — hunt-session boundary)
     - `PLAYER_ENCOUNTER` (normal)
     - `PLAYER_CAPTURE_SUCCESS` (normal for < SR, major for SR+)
     - `PLAYER_CAPTURE_FAILED` (minor)
     - `PLAYER_FOUND_ITEM` (minor)
     - `PLAYER_FOUND_WAIFUBUX` (minor)
     - `PLAYER_FOUND_ESSENCE` (minor)
     - `PLAYER_LEVEL_UP` (major)
     - `BUDDY_LEVEL_UP` (normal)
     - `AFFECTION_MILESTONE` (normal)
     - `PLAYER_ENTERED_CARE` (major)
     - `PLAYER_LEFT_CARE` (normal)
     - `CARE_TICK_APPLIED` (minor — **internal**; drives Trainer Profile edits; Activity Feed ignores)
     - `ENERGY_REGENERATED` (minor — **internal**, future; reserved for a passive energy-regen signal outside Care Mode; Trainer Profile subscribes when applicable)
     - `AWAKENING` (major — future, catalog reserved now)
     - `COLLECTION_COMPLETED` (major — future/milestone, catalog reserved now)
2. Emit from post-commit hooks at the coordinator layer (Discord handlers), so services remain Discord-agnostic. Preferred pattern: each service method returns a small `events: GameEventDescriptor[]` array in its result payload; the handler calls `bus.emit()` for each after commit. Alternative for services that already have complex results (e.g. `hunt.hunt`): the handler derives events from the result shape. Call sites:
   - `hunt.hunt()` → `PLAYER_STARTED_HUNT` (only when opening a session; §3), `PLAYER_ENCOUNTER`, `PLAYER_FOUND_ITEM` / `WAIFUBUX` / `ESSENCE` depending on outcome.
   - Idle-sweep on next hunt after long inactivity → `PLAYER_COMPLETED_HUNT` for the previous session, then `PLAYER_STARTED_HUNT` for the new one (§3).
   - `capture.attemptCapture()` → `PLAYER_CAPTURE_SUCCESS` (with rarity in payload; subscribers use rarity to decide narration vs. rich embed) or `PLAYER_CAPTURE_FAILED`.
   - `progression.grantXp` level-ups → `PLAYER_LEVEL_UP` per level crossed.
   - Buddy XP paths (capture / care-tick) → `BUDDY_LEVEL_UP`.
   - Affinity milestone crossings → `AFFECTION_MILESTONE`.
   - `care.start` / `care.leave` results → `PLAYER_ENTERED_CARE` / `PLAYER_LEFT_CARE`. Also emit `PLAYER_COMPLETED_HUNT` when Care Mode opens if a hunt session is active.
   - `care.applyPending` with `ticksProcessed > 0` → `CARE_TICK_APPLIED` (Trainer Profile subscriber, Phase 3).
   - `collection.markCaptured` when the last species is filled → `COLLECTION_COMPLETED`.
3. Hunt Session boundaries (represent player intent to hunt; derived, not persisted separately):
   - A hunt session **opens** on explicit intent: `hunt.hunt()` is called and no session is currently open for the player. The coordinator emits `PLAYER_STARTED_HUNT` at that moment. Subsequent hunts inside the same session are silent.
   - A hunt session **closes** on any of:
     - (a) `care.start` succeeds while a session is open (Care Mode ends the hunt) — emits `PLAYER_COMPLETED_HUNT` with `payload.reason: 'care_mode'`.
     - (b) Future `/waifumon hunt leave` (or equivalent) command — emits `PLAYER_COMPLETED_HUNT` with `payload.reason: 'explicit'`.
     - (c) **Housekeeping only:** the next `hunt.hunt()` after `hunt.sessionIdleMinutes` (new config in `content/tables.json`, default 15) has elapsed with no activity → emits `PLAYER_COMPLETED_HUNT` for the abandoned session with `payload.reason: 'inactivity'` before opening the new one. This branch is a cleanup mechanism, not the primary lifecycle definition.
   - "Currently open" is derived from existing state (`players.lastHuntAt` + Care Mode flags + the `sessionIdleMinutes` window). No new DB column needed for MVP; a bot restart mid-session may cause one duplicate `PLAYER_STARTED_HUNT` (cosmetic only). If tighter crash safety becomes desirable later, add a nullable `players.hunt_session_started_at timestamptz` in a follow-up migration.
   - Location flavor for the started/completed lines: pick from `content/tables.json → hunt.locationFlavors: string[]` (new field, small seeded list). Choice is deterministic per session-open (hash of player id + open time) so opening and closing lines reference the same venue.
4. Add `src/modules/activity/activityFeedService.ts` as the first subscriber:
   - Subscribes to `GameEventBus` on bootstrap. Filters `scope === 'player-visible'` first — internal-scope events (`CARE_TICK_APPLIED`, `ENERGY_REGENERATED`, and future internal-only signals) never reach narration regardless of their `visibility`.
   - Suppresses `PLAYER_CAPTURE_SUCCESS` for SR+ (that path uses the existing rich embed; no double narration).
   - Pure formatter `formatActivityLine(event): { text: string; visibility }` (unit-testable, no Discord).
   - Discord side is injected as `PostFn: (channelId, text, visibility) => Promise<void>`. Bootstrap wires the discord.js implementation; tests inject a spy.
   - Failures logged and swallowed.
5. Narrative wording (canonical strings for tests):
   - `PLAYER_STARTED_HUNT` → `🌿 {player} ventured into {location}.`
   - `PLAYER_COMPLETED_HUNT` → `🏕️ {player} returned from {location}.`
   - `PLAYER_ENCOUNTER` → `👀 {player} spotted a {rarity} {species}…`
   - `PLAYER_CAPTURE_SUCCESS` (below SR) → `💫 {player} added {species} to their collection.`
   - `PLAYER_CAPTURE_FAILED` → `🌫️ {species} slipped away from {player}.`
   - `PLAYER_FOUND_ITEM` → `🎁 {player} pocketed {quantity} × {item}.`
   - `PLAYER_FOUND_WAIFUBUX` → `💰 {player} came across {amount} WaifuBux.`
   - `PLAYER_FOUND_ESSENCE` → `✨ {player} gathered {amount} Essence.`
   - `PLAYER_LEVEL_UP` → `⚡ {player} reached level {level}.`
   - `BUDDY_LEVEL_UP` → `💖 {buddy} grew stronger — now level {level}.`
   - `AFFECTION_MILESTONE` → `🌸 {player} and {buddy} grew closer ({stage}).`
   - `PLAYER_ENTERED_CARE` → `❤️ {player} is spending time with {buddy}.`
   - `PLAYER_LEFT_CARE` → `🌸 {player} finished spending time with {buddy}.`
   - `AWAKENING` (future) → `🌌 {buddy} awakened for {player}.`
   - `COLLECTION_COMPLETED` → `🌟 {player} completed the collection.`
6. Update `src/index.ts` bootstrap:
   - Build `gameEventBus`.
   - Build `activityFeed`, subscribe to bus.
   - Inject bus into handler context so post-commit emissions can happen.
7. Tests:
   - New `tests/unit/gameEvents.test.ts` — bus semantics: multiple subscribers each receive events; a throwing subscriber does not affect others; event payload shapes typed correctly per kind.
   - New `tests/unit/activityFeed.test.ts` — formatter output per event kind matches canonical wording; SR+ capture success is suppressed; `visibility` propagates to `PostFn`; internal-scope events (e.g. `CARE_TICK_APPLIED`, `ENERGY_REGENERATED`) never produce a line.
   - Extend `tests/integration/hunt.test.ts` — hunt session boundary events emitted at the right times; location string matches across the paired open/close events for the same session; idle threshold rolls the boundary correctly.
   - Extend `tests/integration/capture.test.ts` — success/failed events emitted with rarity; below-SR produces an activity line; SR+ produces the existing rich embed only.
   - Extend `tests/integration/care.test.ts` — care enter/leave emissions; `PLAYER_COMPLETED_HUNT` fires when Care Mode opens during an active hunt session; `CARE_TICK_APPLIED` fires on `applyPending` with credited ticks.

**No user-visible interaction change in this phase.** Rich embeds for SR+ captures continue exactly as today. The event bus is a new internal seam; the Activity Feed subscriber produces the narrated log lines.

## Phase 2 — Ephemeral Gameplay

**Goal:** All player-facing gameplay UI becomes private. The persistent public "session board" concept goes away.

1. Add `src/discord/ephemeralSession.ts`:
   - `respondEphemeral(interaction, view)` — reply for slash commands with `flags: MessageFlags.Ephemeral`; `interaction.update(view)` for buttons/selects; `interaction.editReply(view)` fallback within-token; safely no-ops on `isStaleInteractionError`.
   - A single ergonomic entrypoint that handlers use in place of `paintSession`.
2. Convert every handler currently going through `sessionUi.ts:paintSession` to `respondEphemeral`:
   - `waifumon.ts`: `handleMenu`, `handleHunt`, `handleDaily`, `handleShop`, `handleInventory`, `handleItemUse`, `handleCollection`, `handleProfile`, `handleCareOpen`, `handleCareChangeMenu`, `handleCarePick`, `handleCareLeave`
   - `waifumonHunt.ts`: `handleEncounterPick`, `handleEncounterCharm`, `handleEncounterRelease`
   - `waifumonCollection.ts`: `handleCollectionPage`, `handleCollectionInspect`, `handleDuplicateKeep`, `handleDuplicateConvert`, favorites, release, nickname flows
3. Strip owner-decoration from ephemeral embeds:
   - Remove "Hunter: @mention" line and "Only $name can use these controls" footer additions — ephemeral views are inherently private.
   - Session ownership rejection (`respondEphemeral(interaction, "this is X's session")`) becomes dead code — remove call sites.
4. Retire the public session board path:
   - Delete `sessionUi.ts:paintSession` public-message write path (channel.send + channel.messages.edit).
   - Delete the inactivity-timeout "stale board" branch — no shared board to go stale.
   - `SessionService.setMessageId`, `findByMessageId`, `isExpired` no longer used for gameplay; keep them but unused until the Phase 4 cleanup.
5. Update the encounter public-message flow:
   - `waifumonHunt.ts` currently edits `encounters.publicMessageId` on rare captures with the outcome. In the new model the ephemeral shows the outcome to the player and the activity feed / rare-capture embed handles the public side. Remove the `capture.setPublicMessageId` / edit-in-place path; keep `encounters.publicMessageId` column dormant until Phase 4.
6. Tests:
   - `tests/integration/session.test.ts` — expect ephemeral replies, no `channel.send` for menu/hunt/encounter navigation.
   - `tests/integration/uiNavigation.test.ts` — `interaction.update` used for button navigation instead of `channel.messages.edit`.
   - `tests/integration/hunt.test.ts`, `capture.test.ts` — outcome delivered via ephemeral; assert no owner-decoration.
   - `tests/integration/splash.test.ts` — splash view is ephemeral.
   - Existing "wrong owner rejection" tests deleted.

## Phase 3 — Trainer Profile (Care Mode)

**Goal:** Entering Care Mode posts a public Trainer Profile message; leaving deletes it.

1. Migration `drizzle/0012_trainer_profile.sql`:
   - `ALTER TABLE waifumon_sessions RENAME COLUMN message_id TO profile_message_id;`
   - `DROP INDEX waifumon_sessions_message_id_uq;` (no longer needed — no public-button ownership lookup).
   - `UPDATE waifumon_sessions SET profile_message_id = NULL;` (any pre-migration values are orphaned session-board ids, not profile ids).
   - Update `src/db/schema.ts` accordingly.
2. Add `src/discord/trainerProfile.ts`. The Trainer Profile is the player's **persistent dashboard while in Care Mode** — the MVP renders a subset of the dashboard, and the layout is deliberately built so future dashboard elements land without a reshuffle.
   - `buildTrainerProfileView({ player, currencies, buddy, careState, collectionProgress, progression, dashboard? })` → `{ embeds }` (no components).
   - MVP fields (implemented in Phase 3):
     - Title: `🌸 [Player]'s Trainer Profile`
     - Trainer: level (+ prestige title), Hunt Energy `current / max`
     - Buddy: nickname (fallback species name), species + rarity, level, affinity + affection score
     - Collection: `X / Y unique species (Z %)`
     - Activity: `Currently caring for {buddy}` + `Next tick in {mm:ss}` + per-tick breakdown from `CareState`
     - Footer: `Trainer since {createdAt date}`
   - Reserved dashboard slots (design layout now; wire real data in follow-up work). The optional `dashboard` input carries these; each slot is skipped when `null`:
     - `currentRegion` — once the region system exists
     - `todaysHunts` — daily session summary (available now via `summary_json`, wire later)
     - `todaysCaptures` — daily session summary
     - `nextLevelProgress` — `xpIntoLevel` / `xpToNext` (data ready today; slot reserved in the embed grid so wiring it later is one line)
     - `currentDailyObjective` — one-line summary from the `quests` module
   - Wiring a reserved slot in the future is a one-line change per slot with no layout churn.
   - `create(channel, sessionService, playerId, view)` — deletes the existing `profile_message_id` message if any (silently ignore 10008 Unknown Message), sends a fresh one via `channel.send` so it lands at the channel bottom, stores new id via `sessionService.setProfileMessageId`. Used for entering Care Mode, buddy change while in Care, future inactivity return, and future explicit refresh.
   - `edit(channel, sessionService, playerId, view)` — fetches stored `profile_message_id`; if present, calls `channel.messages.edit(id, payload)`. On 10008 Unknown Message (deleted by hand), falls back to `create`. Used for energy / affection / buddy level / collection progress changes.
   - `remove(channel, sessionService, playerId)` — deletes stored message id if any (ignore 10008), clears the column.
3. Data helpers: add `SessionService.setProfileMessageId(playerId, channelId, messageId | null)` and `getProfileMessageId(playerId, channelId)`. Rename internal helpers accordingly. Update `CollectionService` (or add a `getCollectionProgress(playerId)`) if that metric isn't already exposed — audit found it missing.
4. Trainer Profile subscribes to `GameEventBus` in bootstrap:
   - `PLAYER_ENTERED_CARE` → `create`
   - Buddy change while in Care Mode → `create` (coordinator emits a synthetic `CARE_BUDDY_CHANGED` event that the profile subscriber maps to `create`; catalog reserved alongside the Phase 1 events)
   - `PLAYER_LEFT_CARE` → `remove`
   - `CARE_TICK_APPLIED` (Care Mode still active) → `edit` — reflects the new energy / affection / waifu XP
   - `BUDDY_LEVEL_UP` (Care Mode active) → `edit`
   - `AFFECTION_MILESTONE` (Care Mode active) → `edit`
   - `PLAYER_LEVEL_UP` (Care Mode active) → `edit`
   - `COLLECTION_COMPLETED` (Care Mode active) → `edit` (rare interleave; conservative to include)
   - Future hook: `PLAYER_RETURNED_FROM_INACTIVITY` → `create` (catalog reserved, no producer yet)
   - Future hook: `TRAINER_PROFILE_REFRESH_REQUESTED` → `create` (catalog reserved, no producer yet)
   - Subscriber filters `careState.active` before editing so events fired outside Care Mode are ignored.
   - The Discord handler that starts / stops Care Mode still sends the ephemeral confirmation to the player ("Care Mode active — your Trainer Profile is posted below.").
5. Care Mode auto-stop guard: `CareService.applyPending` result exposes `stopped`; the coordinator, on seeing `stopped === true`, emits `PLAYER_LEFT_CARE` so the profile subscriber removes the message. No service changes.
6. Tests:
   - New `tests/integration/trainerProfile.test.ts`:
     - Entering Care Mode calls `channel.send` (create) and stores the returned message id.
     - `CARE_TICK_APPLIED` while active calls `channel.messages.edit(id, ...)` (edit), does NOT call `channel.send`.
     - `BUDDY_LEVEL_UP` / `AFFECTION_MILESTONE` / `PLAYER_LEVEL_UP` in Care Mode → `edit`.
     - Buddy change while active → old message deleted, new one sent (assert call order).
     - `PLAYER_LEFT_CARE` → `channel.messages.delete(id)` and column cleared.
     - Auto-stop on released waifu → same as leave.
     - Edit falls back to create when the stored message is 404 (10008).
     - Events fired outside Care Mode are ignored by the subscriber.
   - Extend `tests/integration/care.test.ts` — activity-feed lines fire on care enter/leave (Phase 1 covers but re-assert with the bus in place).
   - Extend `tests/unit/ui.test.ts` — `buildTrainerProfileView` renders the expected fields for active / at-cap states (view is only used while active).

## Phase 4 — Cleanup *(optional, defer if pressed)*

Only after phases 1–3 are green in production.

1. Migration `drizzle/0013_session_cleanup.sql`:
   - `ALTER TABLE waifumon_sessions DROP COLUMN current_screen;`
   - `ALTER TABLE waifumon_sessions DROP COLUMN owner_display_name;`
   - `ALTER TABLE encounters DROP COLUMN public_message_id;`
2. Remove now-dead code: `SessionService.setMessageId` / `findByMessageId` / `isExpired`, `CaptureService.setPublicMessageId`, owner-display cache updates.
3. Regenerate drizzle snapshot.

---

**Relevant files (all four phases combined)**

*New:*
- `src/modules/events/gameEvents.ts` — `GameEvent` union, `GameEventBus` interface + in-memory implementation
- `src/modules/activity/activityFeedService.ts` — event-bus subscriber that narrates lines
- `src/discord/ephemeralSession.ts` — ephemeral response helper
- `src/discord/trainerProfile.ts` — profile view + create/edit/remove; event-bus subscriber
- `drizzle/0012_trainer_profile.sql` (+ meta) — column rename, index drop
- `drizzle/0013_session_cleanup.sql` (Phase 4) — drop unused columns
- `tests/unit/gameEvents.test.ts` — bus semantics + subscriber isolation
- `tests/unit/activityFeed.test.ts` — canonical narration per event kind
- `tests/integration/trainerProfile.test.ts` — create/edit/remove wiring via events

*Modified:*
- `src/db/schema.ts` — rename `messageId` → `profileMessageId`; drop index; Phase 4 drops obsolete columns
- `src/modules/session/sessionService.ts` — replace `setMessageId` with `setProfileMessageId` + `getProfileMessageId`; drop owner-cache write; keep summary/lastActivity logic
- `src/discord/sessionUi.ts` — heavy refactor; delete `paintSession` public-board path
- `src/discord/ui.ts` — extend `respondScreen` / stale-interaction handling for the ephemeral update flow
- `src/discord/commands/waifumon.ts` — all handlers switched to `respondEphemeral`; post-commit event emissions (start/stop hunt session, care enter/leave, item use, daily claim, level-up)
- `src/discord/commands/waifumonHunt.ts` — encounter render / charm / release / capture outcome go ephemeral; strip `setPublicMessageId` edit path; post-commit event emissions (encounter, capture success/failed, item/WB/essence find)
- `src/discord/commands/waifumonCollection.ts` — pages / inspect / release / duplicate flows go ephemeral; emit `COLLECTION_COMPLETED` on the boundary
- `src/discord/userDisplay.ts` — remove now-unused owner-caching for public boards; keep for rare-capture embeds
- `src/modules/hunt/huntService.ts` — return descriptor for whether this call opened or (via idle sweep) closed a hunt session (pure, no Discord)
- `src/modules/care/careService.ts` — no math change; ensure `ticksProcessed` and `stopped` surface for the coordinator's event emissions; report whether `start` closed an active hunt session so the coordinator can emit `PLAYER_COMPLETED_HUNT` with `reason: 'care_mode'`
- `content/tables.json` — new `hunt.sessionIdleMinutes` (default 15) and `hunt.locationFlavors: string[]`; `src/modules/content/schemas.ts` updated to validate
- `src/index.ts` — bootstrap `gameEventBus`, `activityFeed` subscriber, `trainerProfile` subscriber; inject into handlers/context

*Unchanged (services & content — spec §5 preserved):*
- `src/modules/capture/*`, `src/modules/hunt/*`, `src/modules/care/*`, `src/modules/collection/*`, `src/modules/content/*`, `src/modules/currency/*`, `src/modules/daily/*`, `src/modules/guilds/*`, `src/modules/inventory/*`, `src/modules/items/*`, `src/modules/players/*`, `src/modules/progression/*`, `src/modules/quests/*`, `src/modules/shop/*`, `src/modules/effects/*`
- `content/*.json`
- `src/discord/playChannelGuard.ts` (NSFW/allowlist enforcement is orthogonal)
- Existing rare-capture rich-embed formatting + `@here` mention rules
- Daily summary tally logic

**Verification**
1. Per-phase: `npm run typecheck` clean, `npm run build` clean.
2. Per-phase: `npm test` full suite (currently 544 tests passing) — each phase adds tests, none deleted without replacement.
3. Phase 2 target tests: `session.test.ts`, `uiNavigation.test.ts`, `hunt.test.ts`, `capture.test.ts`, `splash.test.ts` all expect ephemeral replies; no public `channel.send` for gameplay.
4. Phase 3 target tests: `trainerProfile.test.ts` covers enter/leave/change-buddy/auto-stop; `care.test.ts` still green.
5. Manual smoke via `docker-compose up`: run `/waifumon`, hunt, capture below-SR, capture SR+ (verify rich embed still posts), enter Care Mode (verify profile posts), change buddy (verify old profile deleted + new one at bottom), leave Care Mode (verify profile deleted), use Energy Drink from Care Mode (verify profile deleted).
6. Fresh Postgres verification: apply migration `0012` on a copy of production; confirm rename + index drop succeed with no data loss beyond the intended orphaning.

**Decisions & non-goals**
- **Kept intact:** hunt math, capture math (incl. Microdose modifier), economy, inventory, daily rewards, progression, care mode math, rarity tables, buddy affinity math, quests, admin panel, content schemas (extended non-destructively), NSFW/allowlist guard, rare-capture embed format & mentions.
- **Excluded:** interaction buttons on Trainer Profile (spec §3 says informational-only); background timers refreshing the profile (edits are event-driven instead); per-guild activity-feed opt-out UI (importance field ships now, admin UI later); activity-feed rate limiting; cross-channel Trainer Profile duplication; persistent hunt-session storage (session boundaries are derived from `players.lastHuntAt` + config, no new table).
- **Assumption:** `collectionService.getCollectionProgress(playerId)` will be added if not present (audit flagged this data as missing). Cheap query against `player_waifus` distinct on `species_id`.
- **Ordering:** phase 1 first because it's independently deployable and lays the event-bus foundation; phase 2 breaks the current UX so ship it once tests green; phase 3 layers the Trainer Profile subscriber on top; phase 4 is pure cleanup.

**Migration issues to be aware of**
- Orphaned old session-board messages: any `message_id` in the current `waifumon_sessions` table points to a public gameplay board that will no longer be edited. They sit in channel history harmlessly. Migration nulls the column.
- The `waifumon_sessions_message_id_uq` unique partial index is dropped in phase 3 (safe — public button ownership lookup is no longer needed once gameplay is ephemeral).
- `encounters.public_message_id` becomes dormant in phase 2 and is dropped in phase 4. In-flight rare-capture "edit-in-place" public messages from before deployment become orphaned; the new interaction posts a fresh embed if a capture completes across the boundary.
- No content-file migration needed. `announceMinRarity` / `hereMentionMinRarity` semantics unchanged.

**Discord API considerations**
- Ephemeral messages: last until user dismisses; only the invoking user sees them. Each component interaction on an ephemeral gets its own fresh 15-minute token. Since navigation uses `interaction.update()` per-click (chosen model), the token window is never a limit in practice — every click restarts it.
- Ephemeral messages **cannot be deleted by the bot** — user dismisses. Not a problem here since ephemeral views are cheap and self-limiting.
- Trainer Profile messages are regular channel messages: `channel.send()` to create, `channel.messages.edit(id, payload)` to edit in place, `channel.messages.delete(id)` to remove. Requires `Manage Messages` permission on the bot — same as today's rare-capture edit flow. Edits to a bot's own message have no token-expiry window, so Care Mode sessions can run indefinitely without profile churn.
- Ephemeral messages support embeds + files but no thread pinning. Encounter card images continue to work.
- `MessageFlags.Ephemeral` is set on the initial reply; component interactions inherit the ephemeral flag automatically when using `interaction.update()`.
- Rare-capture `allowedMentions: { parse: ['everyone'] }` behavior with `@here` is unchanged.
- Activity-feed lines are plain `content` sends (no embed) so they cost one message per event. Volume is bounded by hunt cadence; the `visibility` field is the escape valve if per-guild filtering becomes needed.

**Further considerations**
1. **Trainer Profile refresh cadence:** *Resolved* — the profile edits in place on `CARE_TICK_APPLIED` / `BUDDY_LEVEL_UP` / `AFFECTION_MILESTONE` / `PLAYER_LEVEL_UP` / `COLLECTION_COMPLETED` events while in Care Mode. No timer. No poll. Editing a bot-authored message has no token-expiry window, so this stays reliable across long Care Mode sessions.
2. **Activity-line rate-limit:** with many active players a busy log channel could get spammy. Option A (recommended): ship as-is and observe; Discord's 5 msg/5 sec channel limit is a soft ceiling but activity-feed volume in practice is low. Option B: batch identical events across a short window (e.g. "3 trainers started hunting"). Option C: use the shipped `visibility` field to gate `minor` events behind a per-guild `activityFeedMinVisibility` config once we have data.
3. **Rich-embed threshold vs. activity line:** *Resolved* — below-SR captures → narrated line only; SR+ → existing rich embed only (Activity Feed subscriber suppresses `PLAYER_CAPTURE_SUCCESS` for SR+ so there's no double narration).
4. **Hunt session idle threshold (housekeeping):** default `hunt.sessionIdleMinutes: 15` — the *cleanup* threshold, not the primary session lifecycle. Sweeps abandoned sessions on the next hunt. Tunable per-guild via the admin panel once `content/tables.json` is guild-editable (already possible via the existing content-admin flow).
5. **Location flavor pool:** ship a small seeded list in `content/tables.json → hunt.locationFlavors` (e.g. `Whispering Forest`, `Neon Boardwalk`, `Velvet Grove`, `Moonlit Docks`). Deterministic per session-open so open/close lines match. Empty pool = fallback wording (`{player} started hunting.` / `{player} finished hunting.`).
