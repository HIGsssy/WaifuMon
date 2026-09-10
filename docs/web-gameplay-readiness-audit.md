# Web Gameplay Readiness audit

Repository inspection: 2026-09-09. Scope: the first playable Portal loop; no gameplay implementation or migrations applied. Findings below come from source inspection, including existing tests; tests were not executed for this documentation-only audit. Concurrency findings describe reachable source-level interleavings, not reproduced production incidents.

The repository has substantial reusable domain logic. It needs a shared gameplay coordinator, durable action receipts, and targeted concurrency/recovery fixes—not a new game engine or authentication system. The Platform API is ready to host these interfaces, but its player gameplay routes currently expose reads only. Admin encounter editing/simulation writes are separate and are not player gameplay APIs.

## Material differences from the proposed assumptions

- A hunt already creates a durable `encounters` row when it finds a species. It can also produce items, currency, essence, or flavor. Those outcomes have no durable hunt entity/result receipt. Preserve this outcome union; making every hunt a capturable encounter would change game balance.
- Capture is a maximum-three-attempt state machine. Exactly once means **each submitted attempt** applies once, with one terminal capture/escape/release outcome. A failed attempt may legitimately be followed by another.
- Hunt energy normally costs one, but the existing buddy `energy_save_chance` proc can make it zero. Preserve the proc and persist its outcome; “consumed exactly once” means the server-calculated cost is applied once.
- Travel commits arrival immediately, before a possible world encounter. “Continue Journey” is navigation, not a second travel charge or deferred arrival. Preserve this unless a product change is intended.
- Pass, level, and money requirements gate route acquisition. Movement checks route entitlement; it does **not** recheck pass ownership or level. Pass revocation deliberately leaves routes intact. Requiring a currently owned pass for every trip would change existing rules.
- An existing Discord player profile is required by Portal OAuth. An account with no profile receives `noProfile`; browser onboarding is a separate scope decision, not an authentication failure.

## Readiness table

Labels describe the principal readiness/gap, not a cumulative certification. `DOMAIN_READY`: reusable rules exist, still subject to listed integration caveats. `API_READY`: required current read/auth interface exists. `PARTIALLY_COUPLED`: domain exists but complete orchestration depends on Discord. `NEEDS_STATE_MODEL`: persistence/replay contract needs extension. `DISCORD_COUPLED`: orchestration lives only in Discord. `MISSING`: no corresponding interface exists.

“Tx” means a database transaction; it does not imply request idempotency. Portal entries below refer to player-facing UI, not the admin content editor.

| System | Classification | Authority / Discord rules | Platform API / Portal read | Multiple clients; transaction and replay | Refresh recovery / trusted inputs |
|---|---|---|---|---|---|
| Identity/session/guild scope | API_READY | `api/portalSession.ts`, auth routes/hooks; Discord provisioning is separate | `/auth/session`, `/auth/guild`; existing OAuth/provider | Durable sessions, consumed OAuth state, CSRF; gameplay must explicitly reject read-only bearer authority | Login restores selected player/guild. Never accept body identity as authority |
| Player state | API_READY | `modules/players`, currency/collection/progression services | Player/profile/currency/buddy reads; dashboard shows region, energy, currency, level, buddy | Reads are not a single coherent gameplay snapshot; serialize writes and invalidate caches | Reload works; actor must come from authorized scope |
| Energy | DOMAIN_READY | `currencyService`, `careService`, hunt/travel services | Currency/care reads and dashboard | Hunt/travel spends transactional; lock-order conflict and world-effect lost-update risk below. No request receipt | Balance recoverable; prior charge attribution incomplete. Costs must remain server-derived |
| Hunt | PARTIALLY_COUPLED | `huntService.hunt`; Discord chooses when to invoke world roll | No hunt POST; no playable hunt UI | Core energy/rewards/spawn atomic, cooldown and unique active row; no request idempotency | Species row survives; reward/flavor response and world-roll decision do not. Never accept outcome/cost |
| Encounter/species selection | DOMAIN_READY | Hunt weighted rarity/region pools and `wildEncounterSpawner` | Active species encounter GET; no player encounter screen found | Server RNG, player region/level/buddy; durable chosen species | Recover selected species; no client species/rarity/weight override |
| Capture chance | DOMAIN_READY | `captureMath`, `affinityMath`, capture service gathers data | No quote/eligible-item API; inventory only | Read quotes may be stale; attempt recalculates from DB/config | Requote on resume; no client probability/modifier authority |
| Capture resolution | DOMAIN_READY | `captureService.attemptCapture` | No capture POST / UI | Encounter row lock, attempt uniqueness, atomic item/rewards/collection; optional expected count prevents duplicate failed attempts only when supplied | Attempt/state persisted; no API result replay. Require key plus expected attempt count |
| Capture items/charms | DOMAIN_READY | Capture selection/eligibility/consumable APIs, `items/encounterUse`, effects service | Inventory/effects/content reads; inventory UI | Conditional inventory decrement, transactional consumption; consumables already support expected attempt count plus expected charges; still need response replay | Selected item and active buffs persisted. Item slug is intent; validate ownership/category/enabled/rarity |
| Buddy bonuses | DOMAIN_READY | `buddyBonusService`, effects helpers, collection and affinity services | Buddy/bonus resources; buddy cards | Server calculates bonuses; align locks with concurrent buddy/care changes | Reload buddy/quotes; never accept bonus totals or buddy profile from browser |
| Inventory mutations | DOMAIN_READY | `inventoryService` | Inventory GET/UI; no player mutation API | Conditional decrement and additive upsert; atomic in caller Tx, **not idempotent alone** | Quantities recover; parent action must explain/replay mutation |
| Travel | PARTIALLY_COUPLED | `travelService.travel`; Discord invokes downstream world roll | No travel status/move API; dashboard current-region read only | Energy + destination atomic; same-destination rejection is not general idempotency | Destination survives; no general journey record, lost world roll possible |
| Travel requirements/costs | DOMAIN_READY | `travelCatalog`, `evaluateDestination`, `purchaseDestination`, `evaluateTravelReadiness` | No player route/pass status or purchase API/UI | Entitlement purchases transactional, unique grants; Care Mode/energy/wild-encounter blocks authoritative | Entitlements persist; price/level/pass/money derived on server under acquisition rules |
| World encounter triggering | PARTIALLY_COUPLED | Domain selection/activation; Discord owns linkage to paid action | No player world-encounter API/UI | Unique pending row prevents two simultaneous pending activations; no durable no-hit roll or paid-action binding | Pending activation recoverable; roll cannot safely be retried independently |
| World choices/effects | DOMAIN_READY | `worldEncounterService`, engine/check resolver/effect executor/vendor/spawner | Admin preview is not gameplay; no player choice API/UI | Choice resolution locks activation, applies effects/history/cooldown/continuation in Tx; duplicate resolved choice errors, no response replay; effect races below | Pending/terminal data exists; expiry and result projection need fixes. Choice ID only, never effects/check stats |
| Rewards | DOMAIN_READY | Hunt/capture/world executor plus currency/progression/collection/quests/appearance services | Balances, collection, quests and achievements readable | Core rewards commit with actions; delivery/feed/toasts occur after commit | State survives; receipt needed for exact result after lost response. Never accept reward amount |
| Active/pending gameplay | NEEDS_STATE_MODEL | `encounters`, `capture_attempts`, `active_world_encounters` already exist | Wild encounter GET; Discord UI session GET is not gameplay state | Separate per-table active constraints, no unified action receipt or cross-action serialization | Extend existing state, do not replace it with a parallel pending-hunt table |

Paths in the table are relative to `src/` unless explicitly Portal paths.

## Important blockers and precise evidence

1. **Paid action and world-roll decision are separate commits.** [waifumonHunt.ts](../src/discord/commands/waifumonHunt.ts), `handleHunt` (around lines 455–529), calls the world trigger only after a non-species hunt result. Its original rewards already committed even when the world presentation replaces the find embed. [waifumonLocations.ts](../src/discord/commands/waifumonLocations.ts), `handleLocationTravel` (451 onward), moves before triggering. [waifumonWorldEncounter.ts](../src/discord/commands/waifumonWorldEncounter.ts), `maybeTriggerHuntEncounter` / `maybeTriggerTravelEncounter` (190/244), swallow errors. A process crash can lose the trigger; blindly retrying the trigger can reroll. Persist the hit **or no-hit** decision with the paid action.
2. **No general request identity/result recovery.** Hunt cooldown and active-row uniqueness limit actions but do not recognize replay after a reward-only hunt or after its encounter ends. Travel's already-here check prevents an immediate duplicate move but not an old request replay after another trip. Capture's `expectedAttemptCount` is optional ([captureService.ts](../src/modules/capture/captureService.ts):274–305, 808 onward); omission lets two serialized failed attempts consume two items. A stale-count conflict also cannot return the lost original result.
3. **Cross-operation concurrency needs repair before writes are public.** Hunt locks currency → player → encounter ([huntService.ts](../src/modules/hunt/huntService.ts):491 onward). Travel locks player → currency → encounter ([travelService.ts](../src/modules/travel/travelService.ts), `travel`). Purchase locks currency → player. Capture starts with encounter and later reaches player/progression/currency-related state. These orders can deadlock across clients; a transaction alone does not eliminate this. Adopt a common player-first lock for gameplay entry points and audit all competing care/buddy/reward paths before claiming cross-client safety.
4. **World energy effects can overwrite concurrent changes.** [effectExecutor.ts](../src/modules/worldEncounters/effectExecutor.ts):182–200 reads energy without `FOR UPDATE`, then calls `setHuntEnergy` with a calculated absolute value. A concurrent spend between read and update can be lost. Use atomic delta operations with the existing cap/floor semantics, or lock currency before the read using the common order. Review soft currency-loss reads for consistent reported deductions as well.
5. **Pending-world recovery is incomplete.** Repository `getPendingForPlayer` filters status but not expiry; service `activationFor` also omits expiry ([worldEncounterRepository.ts](../src/modules/worldEncounters/worldEncounterRepository.ts):384, [worldEncounterService.ts](../src/modules/worldEncounters/worldEncounterService.ts):887). `getActivationById` also checks ownership/status without expiry. Align all recovery reads with resolution-time expiry checks. `resolveChoice` writes expiry then throws inside its transaction, rolling that write back; capture's main attempt already uses a commit-then-throw result pattern. Hunt release has the same rollback-of-expiry issue. Time checks still reject actions, but stored status remains stale until cleanup.
6. **No unified pending policy.** Hunt/travel block an active wild encounter, not `active_world_encounters`. A pending world event suppresses a later world activation, while ordinary hunts/trips can proceed. Preserve this initially: recovery should return both kinds, not arbitrarily one. Blocking every new action during a world encounter would be a material rule change.
7. **Player gameplay write authorization is not yet defined for the shared bearer token.** [auth.ts](../src/api/auth.ts) accepts bearer credentials before session cookies and player scope only restricts Portal sessions. The shared token is currently a broad read credential, with admin opt-in handled separately. New game writes should require the Portal actor by default; do not accidentally grant arbitrary-player writes to bearer/dev identity callers.

## Existing authority and Discord coupling

Keep these authoritative modules:

- [huntService.ts](../src/modules/hunt/huntService.ts): cooldown, care exit, energy-saving proc/spend, weighted results/species, region fallback, XP, buddy rewards, quest events. `huntSession.ts` tracks narrative session boundaries, not durable gameplay actions.
- [captureService.ts](../src/modules/capture/captureService.ts), [captureMath.ts](../src/modules/capture/captureMath.ts), [affinityMath.ts](../src/modules/capture/affinityMath.ts): selection, eligible item list/quotes, authoritative attempt and capture modifiers. Formula applies species override or rarity base, charm multiplier, additive affinity/buff/item bonuses, relative buddy percentage, then clamps; guaranteed items bypass it.
- `src/modules/buddyBonus/{buddyBonusService,buddyBonusEffects}.ts`, `src/modules/items/encounterUse.ts`, active-effects services: bonus matching and consumable behavior.
- `src/modules/{currency,inventory,progression,collection,care,quests,appearance}/`: balance, item, XP, buddy, ownership, care and cosmetic reward rules. Do not copy them into HTTP handlers.
- [travelService.ts](../src/modules/travel/travelService.ts), [travelCatalog.ts](../src/modules/travel/travelCatalog.ts): acquisition and movement rules. Money is charged for unlocking, not each journey. Travel rejects Care Mode without exiting it and conditionally spends one energy with the region update.
- `src/modules/worldEncounters/{worldEncounterService,worldEncounterRepository,engine,checkResolver,effectExecutor,vendorService}.ts` and `src/modules/encounters/wildEncounterSpawner.ts`: independent domain engine, transactional effects, persisted vendor stock/continuations, origin-deduplicated wild spawns.

Exact Discord coupling in this slice:

| File/functions | What remains coupled | Recommendation |
|---|---|---|
| `src/discord/commands/waifumonHunt.ts`: `handleHunt` | Non-species-only world-trigger orchestration; separate player-level/region reads; post-commit event delivery | Move orchestration and authoritative context reads to gameplay coordinator; retain rendering |
| `src/discord/commands/waifumonLocations.ts`: `handleLocationTravel` | Travel → level read → world roll sequencing | Shared coordinator returns committed trip plus optional world activation |
| `src/discord/commands/waifumonWorldEncounter.ts`: `maybeTriggerHuntEncounter`, `maybeTriggerTravelEncounter` | Trigger invocation/error policy mixed with Discord presentation | Domain operation records roll result; adapter renders it |
| Same file: choose/continue/vendor handlers | Identity/custom-ID parsing and service calls, not duplicated check/effect arithmetic | Reuse services behind player HTTP routes; retain Discord adapter |
| `waifumonHunt.ts`: capture/select/consumable/release handlers | Item intent dispatch and expected-count/custom-ID plumbing; outcome/feed/announcement rendering | Keep arithmetic in capture service; make replay/version guards shared |
| `src/discord/worldEncounterPresenter.ts`, `worldEncounterVendorPresenter.ts` | Discord embeds/buttons/artwork and navigation | Add JSON resource projection; do not invoke presenters from API |

No capture probability, travel price, energy-cost enforcement, or world check/effect formula was found implemented authoritatively in these Discord handlers. Their important coupling is **which domain actions compose a player command**. `src/api/context.ts` imports `AppServices` from `src/discord/types.ts` as a type only; this is not a runtime Discord dependency. Moving that interface to a neutral file is optional housekeeping, not a prerequisite or justification for a rewrite.

## Smallest appropriate durable model

Retain `encounters` as the capture state machine: durable ID, player/species, state, attempts/max attempts, selected item, expiry, region snapshot and origin identity already exist in [schema.ts](../src/db/schema.ts):419 onward. `capture_attempts` already records computed chance, roll, success and unique `(encounter_id, attempt_number)`. Do not replace either.

Add one **gameplay action receipt** table for command identity and committed results, rather than separate competing hunt and journey engines:

- `id`, `player_id` FK (player already identifies guild), operation kind, idempotency key, normalized request hash, parent action/resource reference where applicable, created/completed timestamps, versioned result JSON.
- Unique `(player_id, operation_kind, idempotency_key)`. Same key/body returns the committed result; same key/different body conflicts. Authenticate/authorize before replay lookup. Retain receipts for a documented retry lifetime and never silently treat an expired old key as a fresh action.
- A hunt receipt supplies the public `huntId` for **every** hunt outcome; link its existing wild encounter ID when applicable. Persist actual energy spent/saved, reward summary and world-roll outcome (`not_eligible`, `no_hit`, `activated`, or explicit skipped reason), including activation ID.
- A travel receipt supplies `travelId`, origin/destination, actual cost/balance result, and world-roll decision even when no encounter fires.
- Capture/consumable/choice receipts bind intent to the resource and expected version, preserve the original result, and link to the hunt/attempt/activation. Replays never recompute RNG or rewards. A second legitimate failed-capture attempt uses a new key and updated attempt count.

Recommended implementation: add transaction-aware internals to the existing services, while preserving public wrappers. A small `src/modules/gameplay/gameplayService.ts` owns actor-scoped locking, receipt lookup, paid-action core, world roll/activation, and receipt write in **one transaction**. Do not wrap existing independent `db.transaction` methods and assume that makes them atomic. World selection/cooldown repository reads must accept that transaction too. Resolve settings/content once per operation; keep network/Discord delivery outside locks. Hunt's existing pending-care tick application occurs before its hunt transaction; preserve its intentional semantics and distinguish care accrual from the paid action receipt.

Use `src/modules/gameplay/gameplayActionRepository.ts` only for receipts and replay, plus API schemas/resources/routes under the existing API tree. No generic workflow framework is needed. Existing Discord handlers should call the coordinator so both clients share ordering and guards. Request IDs used for observability are not idempotency keys. Discord interaction IDs can identify individual commands; expected resource versions also protect repeated distinct interactions from a stale button.

For pre-migration active encounters, continue recovery/capture by their existing encounter IDs. Do not require a fabricated historical hunt receipt or strand them behind a new hunt-only route.

## World-encounter recovery conventions

`active_world_encounters` already has player ownership, source, region, origin/destination, optional guild/channel/message metadata, pending/resolved/expired/abandoned status, timestamps, context/result JSON and continuation parent. Its partial unique index permits one pending row per player. Choice resolution re-reads choice membership, current level/buddy and availability server-side, resolves the check, applies effects, stores history/cooldown and closes the parent atomically. Vendor and wild follow-ups are materialized through domain services; continuation rows inherit journey context. Discord rendering is separated.

Reuse these conventions, with narrow fixes:

- Return only unexpired pending actions and expose expiry/server time. An expired action restores as expired, never receives a refreshed lifetime.
- Add an owned terminal-resource read. Current duplicate choices throw “resolved”; use stored resolution/receipt for replay instead.
- Return continuation references by querying `continuation_of_id` or persisting the created child ID. The current parent `resolutionJson` is saved before the new continuation ID is known, although the returned `Resolution` contains it.
- Do not expose raw authoring rows, failure/success effect definitions, private `contextJson`, or unrevealed outcomes in player JSON. Project presentation text, artwork, available choices and public check information only.
- Current recovery reloads live encounter content rather than an immutable encounter definition snapshot. Preserve revalidation and handle deleted/changed choices safely; immutable content version snapshots can be deferred unless stable content across a pending window is required. Client quotes are advisory under the same rule.
- Engine `tryRoll*` accepts level/region/source/RNG/time from trusted server callers. Never bind HTTP body fields directly to those options; derive context from locked player/action state. `resolveChoice` already recalculates level/buddy itself.

## Authentication and future embedded runtime

Reuse [portalSession.ts](../src/api/portalSession.ts), [auth routes](../src/api/routes/auth.ts), [auth hook](../src/api/auth.ts), and [player scope](../src/api/plugins/playerScope.ts). OAuth requests `identify guilds`, validates a cookie-bound, expiring, one-use state, exchanges the code server-side, and stores a digest-addressed session. Eligible guilds are intersected with existing profiles for that Discord user. The selected guild/player is stored server-side. Session cookies are HttpOnly, SameSite=Lax, with configured secure behavior; writes require the CSRF cookie/header/session token to match. Header comments describing bearer-only auth are stale; implementation already supports cookies/CSRF.

Gameplay routes with `:playerId` inherit the scope hook; ensure they never opt into the public-profile exception. Routes without that parameter need explicit session-player resolution because the hook no-ops. Reject no-profile/no-selection sessions. Keep external bearer authority read-only for gameplay unless a separate explicit trusted-service write policy is added. Guild membership is established at login/selection from stored eligibility, not demonstrated to be revalidated with Discord on every action; document the existing session lifetime/revocation policy rather than redesigning OAuth.

Small runtime seams are advisable, but SDK integration is out of scope:

| Existing assumption | Exact location | Minimal seam |
|---|---|---|
| Full-page, root-relative OAuth navigation | `portal/src/features/selectPlayer/SelectPlayerPage.tsx`:94 (`href="/auth/discord"`) | `runtime.startLogin()` behind current session provider |
| Auth calls force same origin; credentials and CSRF depend on document cookies | `portal/src/api/client.ts`: CSRF reader and request interceptor; `api/auth.ts` | Inject transport/auth credential provider and auth base URL; retain browser implementation |
| Browser history with root paths | `portal/src/app/router.tsx`: `createBrowserRouter` | Router factory with basename/history choice |
| Configured API/CDN/artwork origins, configured absolute OAuth redirect origin | `portal/src/lib/env.ts`, image providers, `src/api/routes/auth.ts` | Central URL resolver/runtime configuration; avoid embedding new host assumptions in gameplay components |
| `window.location.origin` and full-page reload | `portal/src/images/instrumentation.ts`:34; `components/layout/ErrorBoundary.tsx`:54 | URL-base and reload/recovery methods |
| Persistent browser preferences/dev identity | `app/ThemeProvider.tsx`, `auth/dev/devIdentity.ts`, dev/env session providers | Optional storage adapter; production identity continues to come from session |

No popup OAuth or `window.open` call was found in the inspected Portal source. No authoritative production gameplay state in localStorage was found: theme is a preference and stored Discord identity belongs to development login. `SessionContext` already supplies a useful identity seam; extend it instead of creating a second identity system. Direct browser APIs for pixel ratio, media queries, downloads/clipboard, and admin confirmation are secondary adapter candidates, not gameplay blockers. Embedded cookie/redirect behavior must be validated during a later Activity integration; this audit does not assert SDK compatibility or propose loosening cookie protections now.

## Recommended first-slice API

Use the existing `/api/v1/players/:playerId/game` namespace, auth/scoping hooks, Zod schemas, response envelopes and error mapping. The conceptual `/game/hunts` flow remains intact under that prefix. All writes require idempotency keys; resource mutations also carry expected attempt count/version where relevant.

| Method/path under prefix | Input / output |
|---|---|
| `GET /state` | Player summary, server time, energy/currency/level/region/buddy, both pending types, latest relevant action links |
| `POST /hunts` | Empty gameplay body; returns hunt receipt ID, discriminated result, cost, encounter/world activation links |
| `GET /hunts/:huntId` | Owned original result and current linked encounter state, including terminal result |
| `GET /encounters/:encounterId` | Owned capture state, expiry, selected item and authoritative eligible-item/quote projection; supports legacy/scripted spawns |
| `POST /hunts/:huntId/capture` | Item slug or persisted-selection action plus expected attempt count; resolve receipt-linked encounter only |
| `POST /encounters/:encounterId/capture` | Same shared operation for existing/scripted encounters; not a separate rule implementation |
| `PUT /encounters/:encounterId/selection` | Item slug; persist validated selection, no consumption |
| `POST /encounters/:encounterId/consumables` | Consumable slug plus version; guarded activation, refreshed quotes |
| `POST /encounters/:encounterId/release` | Terminal release; retry returns original result |
| `GET /travel` | Existing TravelStatus projection: destinations, prices, gates, readiness |
| `POST /travel/unlocks` | Destination ID only; existing purchaseDestination rules, priced server-side |
| `POST /travels` | Destination ID only; durable receipt, energy, committed origin/destination, optional world encounter |
| `GET /travels/:travelId` | Recovery of journey and original trigger result |
| `GET /world-encounters/:activeId` | Owned pending or terminal public projection, continuation/vendor/wild links |
| `POST /world-encounters/:activeId/choices` | Choice ID only; existing resolution engine plus receipt guard |
| `GET /world-encounters/:activeId/vendor` and `POST .../vendor/purchases` | Existing vendor instance and server-priced item purchase, if enabled content leads there |

`GET /state` avoids a separate “pending” endpoint initially. Existing profile, inventory, collection and care reads remain usable. If Phase 1 must support recovering energy or exiting Care Mode entirely in the browser, add narrow care start/stop and daily claim adapters to existing services; otherwise state explicitly that travel can remain blocked until the player leaves care in Discord. Do not silently disable those domain gates.

## Required migration scope

1. Add the gameplay receipt table described above, ownership/parent/resource indexes, unique replay key and operation/result-version constraints. It provides both hunt and travel identity; no duplicate species-pending table is required.
2. Make `encounters.channel_id` nullable and update service input/DTO types to accept optional delivery metadata. A web action has no Discord channel. Avoid fake channel IDs; the world table already permits null. Existing real channel data stays valid.
3. No replacement migrations for `active_world_encounters`, capture attempts, inventory, player/session, passes or routes. Existing partial unique indexes and attempt-number uniqueness remain.
4. Selection/consumable concurrency can use receipt keys plus explicit state comparison; add an encounter `version` column only if using one common version for selection, consumables and capture. Consumables already offer `expectedCharges` alongside `expectedAttemptCount`; reuse those guards. Attempt count alone cannot version a buff activation or selection. This is a conditional migration, not a requirement to duplicate all existing state.

Receipt results must be written in the transaction that applies their effects. A table added around already-committed service calls would leave the same crash window. An outbox is optional for reliable Discord feed/announcement delivery, not required for authoritative reward correctness; do not let a failed announcement repeat gameplay.

## Security, replay and validation plan

- Strict allowlisted bodies: item/action/choice/destination plus concurrency metadata. Reject submitted probability, reward, energy cost, rarity modifiers, buddy bonus, guild/player overrides, RNG or clock values. Keep capture math input types internal.
- Require both resource ownership and session-selected player scope for reads, writes, receipts and continuations. Never authorize with a Discord channel or possession of an ID.
- Same key/same intent returns the original result after reconnect or restart; conflicting reuse returns 409. Different keys against the same stale attempt resolve at most once. Resolved/expired resources cannot be reopened. A new legitimate action gets a new key.
- Lock receipt/resource/player state consistently. Make the player serialization convention cover Discord as well as HTTP and competing care/buddy/effect paths. Add bounded handling for retryable database conflicts only around operations whose whole mutation/receipt transaction can be retried safely.
- Cache mutations by receipt identity and invalidate profile, currency, inventory, collection, buddy, care, effects, quests and pending state as appropriate. Abort/fetch timeout is not proof of rollback. Clear player-sensitive query state on logout/guild changes and refetch on reconnect; no client storage is authoritative.
- Bound request/key sizes and public mutation rate at the API boundary. Never expose the shared platform token in a production bundle or reuse admin simulator DTOs for gameplay.

Existing tests worth retaining include `tests/integration/{hunt,capture,captureItems,encounterConsumables,captureAppearanceUnlock,travel,travelEnergy}.test.ts`, buddy/affinity tests, `tests/unit/{captureMath,travelEligibility,huntWorldEncounterReach}.test.ts`, and API/OAuth integration suites. Their existence does not prove whole-loop retry safety. Add focused database/API integration coverage for lost responses, same-key conflicts, duplicate failed capture, duplicate consumables, cross-client hunt/travel/capture/choice races, world energy deltas, expired recovery, content changes, continuation/vendor recovery, unauthorized IDs and rejected authoritative fields. Include rollback injection between energy/result/world activation and receipt write, and restart recovery after commit.

## Implementation sequence

1. Preserve the material rule differences above in a written API contract and fixtures. Decide whether all gameplay must stop during a pending world encounter; default to current behavior and return both pending types.
2. Repair lock ordering, world energy deltas and expiry recovery. Add focused concurrency tests before public writes.
3. Add receipts and optional channel metadata; introduce transaction-aware service internals and shared coordinator. Keep hunt non-species rewards, buddy energy saves and immediate travel arrival unchanged. Wire Discord to that coordinator.
4. Add owned state/result/item/travel/world projections, then CSRF-protected, session-scoped mutations and stable error mapping. Cover legacy wild encounters and continuation/vendor paths reached by enabled content.
5. Build Portal gameplay screens only after those contracts pass. Reuse current session/dashboard/query infrastructure; add small runtime login/transport/router seams while touching those call sites.
6. Validate browser + Discord mixed-client behavior, reconnect/restart recovery and regression suites, then roll out the playable slice. Defer SDK integration and unrelated game systems.

## Concrete Phase 1 definition and acceptance criteria

Phase 1 is one playable, recoverable hunt/capture/travel/world-encounter loop in the existing Portal, backed by the same authoritative services as Discord. It includes the backend work above, not just UI buttons. It does not require combat, trading, full shop redesign, a generic workflow engine or Discord SDK integration.

- Player logs into the existing Portal using an existing profile and guild selection.
- Player sees current region, energy, currency, level and buddy from server state.
- Player initiates a hunt; the server applies its calculated energy cost exactly once, including the existing energy-save proc.
- Every hunt returns a persistent hunt ID and result. A species-producing hunt creates a recoverable encounter; reward/flavor outcomes remain valid and retain durable receipts.
- Player selects a valid capture item from a server-produced list; selection persists, and ownership/eligibility is rechecked at commitment.
- Buddy, affinity, item, consumable, rarity/species and other supported modifiers are calculated server-side.
- Each submitted capture attempt resolves exactly once, including replay after a failure. Up to three legitimate attempts remain supported, with one terminal outcome.
- Item/buff consumption, rewards, XP, quests, collection and applicable appearance unlocks commit together and update the Portal correctly.
- Refresh/reconnect midway restores the same unexpired hunt encounter, selection, attempt count and current quotes; terminal/expired results restore without rerolling.
- Player can unlock an eligible route and travel; insufficient funds, level/pass acquisition requirements, locked routes, active wild encounters, Care Mode and insufficient energy are enforced server-side.
- Travel consumes one energy exactly once and persists origin/destination; replay cannot move or charge again.
- Travel can trigger a world encounter. The hit/no-hit decision is persisted with the journey and cannot be rerolled by refresh or request replay.
- World choices resolve through the existing engine with atomic effects and once-only submission semantics. Enabled continuations, vendor and wild follow-ups can be recovered.
- Refresh during a pending world encounter restores it with its original expiry and journey context; continuing the journey does not charge or move again.
- Discord gameplay continues through the same coordinator/domain rules. Concurrent browser/Discord actions cannot duplicate an attempt, lose an energy update or bypass ownership checks. Discord presentation failure cannot roll back or repeat rewards.
