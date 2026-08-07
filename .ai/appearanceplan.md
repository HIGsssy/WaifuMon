# Plan: Appearance Progression System v1

## TL;DR

Build a cosmetic-only appearance system where every species can have multiple appearances gated by unlock conditions (V1 = `owned` + `level`), and every owned Waifumon carries a player-chosen `selected appearance` that is used everywhere art is rendered. Reuse existing infrastructure aggressively:

- `playerWaifus.variant` (already exists) = selected appearance
- Species JSON (already Zod-validated) gains an `appearances[]` array carrying rich cosmetic metadata (display name, description, flavor text, cosmetic rarity, introduced version); loader already auto-disables missing assets
- `progressionService.grantXp` already returns `LevelUpEvent[]` — extend to emit appearance-unlock rewards
- **Assets are addressed by an abstract `AssetId { kind, slug, variant }`, never by physical path.** The Platform API describes *what* artwork to display; each consumer (Discord, Portal, future CDN, future object storage, future mobile) independently resolves *where* it lives. `imagePath` never crosses the API boundary.
- Unlock state is **derived from waifu state, not persisted** for `owned`/`level` types → retroactive content adds "just work"
- A tiny new `seenAppearances jsonb[]` column on `playerWaifus` powers "new appearance available" notifications
- One shared progression-notification concept in the Discord event pipeline, ready to carry Evolution/Event/Achievement later without schema change
- Unlock requirements are **permanently displayed** on every gallery entry (`"Reach Level 20"`, `"Holiday Event 2027"`), turning the gallery into a progression journal

**Design invariant:** appearance is cosmetic. No code path from `variant` selection touches stats, XP, affection, evolution, or battle. Enforced by placing selection mutations in a dedicated `appearanceService` that has read-only access to level/state but only writes `variant` + `seenAppearances`.

---

## Phase 1 — Data & Content Model

*Foundation. All later phases depend on this.*

1. **Extend the species content schema** in `src/modules/content/schemas.ts`:
   - Add `AppearanceContentSchema` with the following fields:
     - **Identity:** `id` (slug, unique per species), `sortOrder?`, `tags?`.
     - **Presentation (rich cosmetic metadata):** `name` (display name), `description?` (short subtitle), `flavorText?` (in-world caption, e.g. `"Prepared for the annual shrine celebration."`), `cosmeticRarity?` (see below), `introducedVersion?` (semver-like string, e.g. `"v1.3"`), `contentRating?` (defaults to species).
     - **Asset identity:** `assetId` — an `AssetIdSchema` producing `{ kind: 'waifumon', slug: string, variant: string }` where `slug` defaults to the parent species slug and `variant` defaults to the appearance `id`. This is the **only** asset reference stored, transmitted, or serialized anywhere; there is no `imagePath` field on appearances.
     - **Unlock:** `unlock` — Zod discriminated union on `type`: `owned` | `level` (V1). Reserve `evolution` | `affection` | `event` | `seasonal` | `achievement` | `promotion` | `admin_grant` | `special` in the type literal but mark them "future" via a shared TS type — do not implement handlers yet.
     - **Unlock requirement label:** `unlockLabel?` (author-supplied short string like `"Reach Level 20"`, `"Winter Festival 2027"`, `"Evolve to Celestial Form"`). If omitted, `appearanceRules.formatUnlockLabel(unlock)` synthesizes a default (`"Owned"`, `"Reach Level {N}"`). Always present on every appearance rendered by the API.
   - Add `CosmeticRaritySchema` = Zod enum with values `standard` | `common` | `rare` | `seasonal` | `limited` | `exclusive`. Purely descriptive; **must not** be conflated with species rarity (`N`/`R`/`SR`/…). V1 renders it as a small badge in the gallery; deeper use deferred.
   - Extend `SpeciesContentSchema` with `appearances?: AppearanceContentSchema[]`. If omitted, the loader synthesizes one implicit `owned` appearance with `id: 'standard'`, `cosmeticRarity: 'standard'`, `assetId: { kind: 'waifumon', slug: species.slug, variant: 'standard' }`, `unlockLabel: 'Owned'` — preserving backward compatibility for every existing species. Species retain their internal `imagePath` field for the loader's own asset validation; it is **never** surfaced above the loader boundary.
   - Add cross-field validation: exactly one appearance must satisfy `unlock.type === 'owned'` (the default). Appearance `id`s unique within a species. Level unlocks reference levels `1..maxLevel`. `assetId.kind` must equal `'waifumon'` in V1.

2. **Add DB column `seenAppearances`** on `playerWaifus`:
   - `jsonb` array of appearance ids the player has been notified about for that waifu instance, default `[]`.
   - Generate a new Drizzle migration (drizzle-kit style, matching `0011_item_effects` etc.).
   - No other schema changes in V1. `variant` (already present) remains the "selected appearance id".

3. **Keep unlock state derived, not persisted (V1)**:
   - Introduce a pure module `src/modules/appearance/appearanceRules.ts` exporting `isUnlocked(appearance, ctx)` where `ctx = { level, ownedSince, seenAppearances }`.
   - `owned` → true when the waifu row exists.
   - `level` → true when `waifu.level >= unlock.atLevel`.
   - Function is total, deterministic, side-effect free — safe to call from API, Discord, and portal mocks.

4. **Extend the content loader** (`src/modules/content/loader.ts`):
   - `validateSpeciesAssets` already probes and auto-disables species with missing image files. Extend it to iterate `species.appearances`; the loader translates each `assetId` to a local filesystem probe via a private `assetIdToLocalPath(assetId)` helper (`assets/waifumon/<slug>/<variant>.png`). This mapping stays inside the loader; it is not exported to services, API resources, or client bundles.
   - Missing appearance files are **filtered out with a warning** (not fatal), while the species remains enabled as long as its `owned` default appearance exists.
   - `resolveAssetPath` continues to guard against path traversal for the private probe.

5. **Author the initial appearance-content shape** in `content/species/*.json`:
   - No content changes required to ship this phase. Existing species without `appearances` auto-synthesize a `standard` owned appearance. New artwork can be added incrementally.

---

## Phase 2 — Appearance Service & Unlock Detection

*Depends on Phase 1. Blocks Discord and API phases.*

1. **Create `src/modules/appearance/appearanceService.ts`**:
   - `listAppearances(playerId, waifuId) → { appearances: AppearanceView[], selected: string }` — reads waifu, resolves species, returns per-appearance `{ id, name, description?, flavorText?, cosmeticRarity?, introducedVersion?, assetId, unlock, unlockLabel, isUnlocked, unlockedAt?, isSelected }`. Never returns `imagePath`.
   - `selectAppearance(tx, playerId, waifuId, appearanceId)` — validates ownership, validates the appearance exists on the species, validates `isUnlocked`, then writes `playerWaifus.variant = appearanceId`. Emits a `WAIFU_APPEARANCE_CHANGED` game event with `{ waifuId, assetId }` payload.
   - `detectNewlyUnlocked(waifu, species) → AppearanceContent[]` — pure helper returning appearances that are `isUnlocked` but not in `waifu.seenAppearances`.
   - `acknowledgeUnlocks(tx, waifuId, appearanceIds)` — appends to `seenAppearances` and writes a `playerProgressionEvents` row per unlock (`eventType: 'appearance_unlock'`, `metadata: { waifuId, speciesSlug, appearanceId, assetId, source: 'level'|'owned'|'content_add' }`). `assetId` is embedded so downstream renderers (Discord toast, activity feed, portal notifications) can resolve artwork without another lookup.

2. **Wire into level-up flow** (`src/modules/progression/progressionService.ts` + `src/modules/collection/collectionService.ts`):
   - When a waifu's level increases (grantWaifuXp path), immediately call `detectNewlyUnlocked` in the same transaction and, for each, call `acknowledgeUnlocks` and add a `rewardLabels` entry (`"New appearance: {name}"`).
   - Return the newly-unlocked appearance ids alongside the existing `LevelUpEvent` shape so upstream renderers can display artwork thumbnails, not just labels.

3. **Wire into capture / grant flow**:
   - `collectionService.grantWaifu` (or equivalent) calls `detectNewlyUnlocked` on the freshly-owned waifu → the `owned` appearance is acknowledged immediately (no notification popup for the default appearance; suppress `sortOrder < 1` from notifications).

4. **Retroactive content-add path**:
   - Add a lightweight "gallery view" side effect: when `appearanceService.listAppearances` is called and finds `isUnlocked && !seenAppearances.includes(id)`, it enqueues acknowledgement (transactional). This guarantees a player who logs in after new Level-20 artwork ships sees the unlock notification the next time they open the gallery — no batch job required.
   - Alternatively (Further Consideration §1): a background reconciler.

5. **Enforce cosmetic-only invariant**:
   - `appearanceService` file has no imports from `progressionService`, `battleService`, `affinityService`, or `careService`. Add an ESLint architectural boundary rule (e.g., `eslint-plugin-boundaries` or a simple import-restrict config) to prevent regressions.

---

## Phase 3 — Platform API

*Depends on Phase 2. Parallel with Phase 4 (Discord).*

1. **Extend `src/api/schemas/collection.ts`**:
   - `assetIdSchema`: `{ kind: z.literal('waifumon'), slug: string, variant: string }` — the sole asset reference on the wire. Reused everywhere art must be identified.
   - `cosmeticRaritySchema`: enum `'standard' | 'common' | 'rare' | 'seasonal' | 'limited' | 'exclusive'`.
   - `appearanceUnlockSchema`: discriminated union on `type`. V1 members: `{ type: 'owned' }`, `{ type: 'level', atLevel: number }`. Future members reserved (not emitted by V1 handlers) so clients can start rendering them as soon as content ships.
   - `appearanceSchema`:
     ```
     {
       id: string,
       name: string,
       description?: string,
       flavorText?: string,
       cosmeticRarity?: cosmeticRaritySchema,
       introducedVersion?: string,
       assetId: assetIdSchema,
       unlock: appearanceUnlockSchema,
       unlockLabel: string,        // always populated (author-supplied or synthesized)
       isUnlocked: boolean,
       unlockedAt?: string,
       isSelected: boolean
     }
     ```
     **No `imagePath`, no URL, no filesystem hint anywhere in this schema.**
   - `ownedWaifuSchema`: keep `variant`, add `selectedAppearance: appearanceSchema` (embedded for convenience). Do not remove `variant` — it stays as the wire format for selection identity to preserve backward compatibility with existing portal code.

2. **New routes in `src/api/routes/v1/collection.ts`**:
   - `GET /v1/players/{id}/collection/owned/{waifuId}/appearances` → `{ appearances: AppearanceResource[], selected: string }`. Returns the full gallery including locked entries with unlock metadata.
   - `PUT /v1/players/{id}/collection/owned/{waifuId}/appearance` body `{ appearanceId }` → returns updated `ownedEntry`. 400 for unknown id, 409 for locked appearance, 404 for non-owned waifu. Emits `WAIFU_APPEARANCE_CHANGED`.
   - Register both under existing `playerScope` plugin (auth already covered by bearer + player-scope guard).

3. **Species content endpoint** (`src/api/routes/v1/content.ts`):
   - Extend `toSpeciesResource` in `src/api/resources.ts` to include the species' `appearances` catalog metadata (all of the presentational fields + `assetId` + `unlock` + synthesized `unlockLabel`, without per-player `isUnlocked` / `isSelected` — that's the collection view's job). This is the "authoritative source" for appearance catalog data required by the portal for the encyclopedia and locked-appearance previews.

4. **Asset identity contract (strengthened)**:
   - The Platform API is **completely asset-location agnostic**. It **never** returns a filesystem path, static URL, CDN URL, object-storage key, content hash, or file extension. It returns only `assetId = { kind, slug, variant }` — an abstract identifier describing *what* artwork should be shown.
   - Each consumer independently resolves the identifier to a physical resource:
     - **Player Portal** — existing provider chain (`localDevAssets → silhouette`, plus future `platformCdn`, `objectStorage`) already keyed on `AssetId`.
     - **Discord bot** — new `resolveAppearanceAsset(assetId)` helper returns an `AttachmentBuilder` (dev) or a hosted URL (prod), owned entirely by the bot process.
     - **Future CDN / object storage / mobile clients** — each ships its own resolver; **zero** API contract change is required to migrate any consumer.
   - There is exactly one internal exception: the Node.js content loader translates `assetId → local path` privately for pre-flight file existence validation. That translation is not exported, not serialized, and not reachable from any API route, service, or client bundle.
   - Guardrail: an integration test parses every V1 API response body and asserts the JSON contains no substring matching `/\.(png|jpg|jpeg|webp|gif|svg)/i` and no substring matching `/assets\//i`. Adding a leaky field will break CI.

5. **Add OpenAPI-facing docs**: update `docs/platform-api.md` (or a new `docs/platform-api-phase3.md` if that matches the project convention) with the new endpoints and appearance schema.

---

## Phase 4 — Discord Integration

*Depends on Phase 2. Parallel with Phase 3.*

1. **Level-up embed** (`src/discord/gameEventBuilders.ts`, `levelUpDescriptors`):
   - When `LevelUpEvent.rewardLabels` includes an appearance unlock, extend the descriptor to attach a small thumbnail of the new appearance and a "View Gallery" button that opens the gallery for that waifu.

2. **New progression-notification descriptor**:
   - Add `appearanceUnlockedDescriptor(waifu, appearance)` in `gameEventBuilders.ts` following the shape of existing descriptors. Sends to the current channel (or the trainer's activity feed subscriber in `trainerProfile.ts`) with:
     - Embed title: `"New Appearance Unlocked!"`
     - Species image = the new appearance
     - Buttons: `[Select Now]` (custom id `appearance:select:{waifuId}:{appearanceId}`), `[View Gallery]`, `[Later]`.
   - This descriptor is designed generically so V2 event types (`evolution_available`, `gift_available`, `achievement_unlocked`) can reuse the same "progression toast" pattern without new plumbing.

3. **Gallery UX** — inspect card flow in `src/discord/commands/waifumonCollection.ts`:
   - Add a `[Appearance ▾]` button to the existing inspect card action row.
   - Clicking opens a paginated `StringSelectMenuBuilder` (Discord select menus support up to 25 options; V1's 6 milestones fit trivially, and pagination is unlocked for future scaling). Each option shows `name` + lock icon + the appearance's `unlockLabel` (`"Reach Level 20"`, `"Winter Festival 2027"`, `"Evolve to Celestial Form"`) — **shown for both locked and unlocked entries** so the gallery reads as a progression journal, not a binary lock/unlock indicator.
   - Below the select menu, an embed shows the currently-highlighted appearance's name, flavor text, cosmetic rarity badge, and `"Introduced v1.3"` line where present.
   - Selecting a locked option responds ephemerally with an explanation; selecting an unlocked option calls `appearanceService.selectAppearance` and re-renders the inspect embed with the new artwork (via `attachCardOr`).

4. **Consistent buddy display**:
   - Introduce `src/discord/assets/resolveAppearanceAsset.ts` that takes an **`assetId`** (from the appearance resource, never a path) and returns `AttachmentBuilder | string` (URL). It owns the `assetId → filesystem/URL` mapping for the Discord process. Falls back to the species' `owned` appearance `assetId` on any resolution failure (defense in depth against a content mistake).
   - `attachCardOr` in `waifumonCollection.ts` and hunt / buddy / daily flows are refactored to accept `(waifu, species)`, internally compute the current appearance `assetId` from `waifu.variant`, and delegate to `resolveAppearanceAsset`. No Discord code touches `imagePath` directly.

5. **New `/wm appearance` slash subcommand** (optional but recommended in V1):
   - `/wm appearance <waifu>` opens the gallery directly, mirroring `/wm collection inspect`. Keeps discovery high.

---

## Phase 5 — Player Portal

*Depends on Phase 3.*

1. **Reuse the existing image provider chain** in `portal/src/images/`:
   - `AssetId { kind, slug, variant }` is already the portal's asset primitive and is now **identical** to the API's `assetId` field. The API response can be dropped directly into `useImage(appearance.assetId)` with no adapter.
   - `speciesAsset(species, waifu.variant ?? 'standard')` continues to work for the currently-selected appearance; new call sites read `appearance.assetId` straight from the collection entry.
   - Add a `platformApiProvider` stub (Further Consideration §2) for future CDN / object-storage backends. V1 keeps the `localDevAssets → silhouette` chain.

2. **Appearance gallery UI** in `portal/src/features/collection/`:
   - New component `AppearanceGallery.tsx` rendered as a section inside `WaifumonDetail.tsx`, styled as a progression journal.
   - Grid of appearance tiles: unlocked tiles show the artwork; locked tiles show a silhouette. Selected tile has an outlined ring. Mirrors the existing "Your collection" tile aesthetic in encyclopedia detail.
   - **Every tile permanently displays its `unlockLabel`** (`"Owned"`, `"Reach Level 20"`, `"Holiday Event 2027"`, `"Evolution"`), locked or unlocked, so the gallery reads as a progression journal.
   - Tile also shows: display `name`, small cosmetic-rarity badge (`Seasonal`, `Limited`, …) styled distinctly from species rarity, and a subtle `"v1.3"` version chip in the corner where `introducedVersion` is set.
   - Selected/hovered tile expands into a detail panel showing `flavorText` in italic quotes (`"Prepared for the annual shrine celebration."`), full description, and metadata rows (`Cosmetic Rarity: Seasonal`, `Introduced: v1.3`, `Unlock: Reach Level 20`).
   - Click behavior: unlocked → optimistic mutation `useSetAppearance`; locked → shows a preview modal with the same metadata plus the unlock requirement.

3. **API client & hooks** in `portal/src/api/`:
   - `collection.ts`: `getAppearances(playerId, waifuId)`, `setAppearance(playerId, waifuId, appearanceId)`.
   - New hook `useWaifuAppearances(playerId, waifuId)` in `hooks/useCollection.ts`.
   - `useSetAppearance` mutation: optimistically updates `waifu.variant` in the collection entry cache, invalidates `queryKeys.collectionEntry` and `queryKeys.buddy` (buddy display must refresh when the buddy's appearance changes).

4. **Selection propagation across pages**:
   - `WaifumonCard`, `BuddyPage` hero, `ProfilePage` featured buddy, `Dashboard` hero: all already read from the collection cache; because `variant` is a normal field on the collection entry, cache invalidation alone updates them all.

5. **Locked-appearance presentation**:
   - Silhouette artwork uses the existing `silhouette.ts` provider (never 404s, deterministic per slug).
   - "Preview" hover reveals the actual artwork in a Dialog if the player wants to see what they're working toward (Further Consideration §3 — do we allow spoilers?).

6. **MSW mocks** in `portal/msw/`:
   - Add handlers for the two new endpoints so `phase2Pages.test.tsx`-style tests can exercise the gallery.

---

## Phase 6 — Notification Architecture (shared, forward-compatible)

*Depends on Phase 2. Can be built in parallel with Phase 4.*

Design a single `ProgressionNotification` concept that today carries appearance unlocks and tomorrow carries evolution/event/achievement without new tables or new event types.

1. **Event type in `playerProgressionEvents`**:
   - Reuse the existing soft-typed `eventType` string. V1 emits `appearance_unlock`. `metadata` JSON schema is namespaced by `eventType` (Zod-validated at write time in `appearanceService`).

2. **Discord side**:
   - `trainerProfile.ts` activity-feed subscriber gains a `renderAppearanceUnlock(event)` case. Future cases (`renderEvolutionAvailable`, etc.) drop in beside it.
   - The `appearanceUnlockedDescriptor` is the message-level renderer; the activity feed is the log-level renderer. Both consume the same `metadata` shape.

3. **Portal side**:
   - New `useProgressionNotifications` hook backed by the same audit-log endpoint (or a lightweight "recent notifications" endpoint if we add one; V1 can skip a dedicated endpoint and read from the profile activity feed already exposed).

4. **Documented "notification kinds"**:
   - `appearance_unlock` (V1)
   - `evolution_available` (V2)
   - `affection_milestone` (V2)
   - `event_appearance_available` (V2)
   - `seasonal_appearance_available` (V2)
   - `achievement_unlocked` (V2)
   - `promotion_cosmetic_available` (V2)
   - `admin_grant_delivered` (V2)
   - `gift_available` (V2)

---

## Phase 7 — Content Pipeline & Asset Strategy

*Depends on Phase 1. Independent of runtime phases.*

1. **Physical asset layout** (private to consumers, not exposed via API):
   - The **default** consumer resolver maps `assetId { kind: 'waifumon', slug, variant }` → `assets/waifumon/<slug>/<variant>.png`.
   - Flat per-species folder, one file per appearance. Existing files (`standard.png`) already fit. Adding L10 art → drop `level_10.png` into the folder and add one JSON entry with matching `variant: 'level_10'`.
   - Rejected alternative: subfolder per appearance (`<slug>/<variant>/card.png`) — heavier for a V1 that has one canonical image per appearance; easy to migrate to later, purely inside each consumer's resolver, without touching the API or content schema.

2. **Content authoring flow** (documented in `docs/content-authoring.md` — new):
   - Add appearance entry to `content/species/<file>.json` with `id`, `name`, `unlock`, and rich metadata (`description`, `flavorText`, `cosmeticRarity`, `introducedVersion`, `unlockLabel?`). `assetId` may be omitted; the loader defaults it to `{ kind: 'waifumon', slug: <species slug>, variant: <appearance id> }`.
   - Drop the PNG file at the location the default consumer resolver expects.
   - `pnpm content:validate` (or existing content lint task) runs the extended `validateSpeciesAssets`. Missing files → warning, appearance auto-disabled. Missing default → species disabled (already behavior).
   - No migration, no deploy dance — the loader picks it up on next boot; retroactive unlocks fire on next gallery view or level-up.

3. **Asset abstraction confirmation**:
   - The Platform API returns **`assetId` only**. It has no notion of URL, path, extension, or storage backend. Migration between local files, CDN, object storage, or any future backend is a **per-consumer change with zero API contract impact**:
     - **Portal:** swap or extend the provider chain (`localDevAssets` → `platformCdn` → `objectStorage`); one env var toggle.
     - **Discord:** update `resolveAppearanceAsset` to return a hosted URL instead of an `AttachmentBuilder` in production; same input signature.
     - **Future mobile client:** ship its own `AssetId` resolver targeting whichever backend it prefers; consumes the same API responses.
   - Content-hashed URLs, image size negotiation, WebP fallback, and CDN edge routing all remain inside consumer resolvers and never appear in the API surface.

---

## Future Appearance Sources

*Documentation only. No V1 implementation. Purpose: validate that the architecture scales without redesign.*

Every future appearance source below is expected to become **another `unlock.type` value on the existing `AppearanceContentSchema`**, resolved by **another case in `appearanceRules.isUnlocked`**, notified via **the existing `progression_notification` pipeline**, and rendered by **the existing gallery components on Discord and Portal**. No separate subsystem, no separate API, no separate storage backend.

Each entry below lists the minimum architectural addition required. Anything not listed is expected to work as-is.

### 1. Evolution appearances
- **Unlock type:** `{ type: 'evolution', evolutionStage: string }`.
- **Rule:** `isUnlocked` returns true when `waifu.evolutionStage === unlock.evolutionStage`.
- **Notification source:** on evolution transaction, existing evolution service calls `detectNewlyUnlocked` (already integrated into level-up path in V1; evolution service adopts the same call). Emits `evolution_appearance_unlocked`.
- **Additional schema:** none. `waifu.evolutionStage` is expected to exist on the evolution feature; no appearance-system table needs to change.
- **Requires now (V1) to avoid future work:** ensure `unlock.type` discriminated union already reserves `evolution` (done in Phase 1).

### 2. Affection milestones
- **Unlock type:** `{ type: 'affection', atAffection: number }`.
- **Rule:** `waifu.affection >= atAffection`. Field already exists on `playerWaifus`.
- **Notification source:** affection tick service adopts the `detectNewlyUnlocked` hook the same way level-up did.
- **Additional schema:** none.
- **Requires now:** reserve `affection` in the discriminated union (done in Phase 1).

### 3. Holiday & seasonal events
- **Unlock types:** `{ type: 'event', eventKey: string }` and `{ type: 'seasonal', season: string, year?: number }`.
- **Rule:** `isUnlocked` becomes true when the player has an entry in a new `player_appearance_grants` table (see below). Event unlocks are **not derivable** — they are grants, not consequences of state.
- **Additional schema:** a single new table when the first non-derived unlock ships:
  ```
  player_appearance_grants (
    playerId int,
    waifuId int nullable,        -- null = grant applies to all copies of the species
    speciesSlug text,
    appearanceId text,
    source text,                  -- 'event' | 'seasonal' | 'achievement' | 'promotion' | 'admin_grant'
    sourceRefId text,             -- event key, achievement id, promo code, admin actor id, …
    grantedAt timestamp,
    expiresAt timestamp nullable  -- for limited-time re-lock scenarios
  )
  ```
  `appearanceRules.isUnlocked` accepts a `grants: PlayerAppearanceGrant[]` field on its context and treats `event | seasonal | achievement | promotion | admin_grant` unlocks as "unlocked iff a matching grant exists". `owned` and `level` remain fully derived. This preserves the V1 invariant that unlock state is derived wherever possible.
- **Notification source:** event-participation service issues a grant, then invokes `acknowledgeUnlocks` (existing V1 helper). Discord toast and portal notification fire through the existing pipeline.
- **Retroactive-grant behavior:** grants are additive-only in V1 semantics; expired grants re-lock but the `seenAppearances` acknowledgement remains, so a re-grant does not spam a second notification unless the appearance was manually removed from the seen set.
- **Requires now:** reserve `event`, `seasonal` in the discriminated union (done in Phase 1). No table added yet.

### 4. Achievement rewards
- **Unlock type:** `{ type: 'achievement', achievementId: string }`.
- **Rule:** identical to events — grant-driven, uses the same `player_appearance_grants` table.
- **Notification source:** the achievement service calls the grant helper on achievement completion.
- **Additional schema:** none beyond the shared grants table above.
- **Requires now:** reserve `achievement` in the discriminated union (done in Phase 1).

### 5. Limited-time promotions
- **Unlock type:** `{ type: 'promotion', promotionKey: string }`.
- **Rule:** grant-driven with optional `expiresAt` on the grant row. When expired, `isUnlocked` returns false but the entry stays in the gallery as "Expired — was: `<unlockLabel>`" (or is hidden if a `hideAfterExpiry: true` field is set on the appearance). `cosmeticRarity: 'limited'` is the natural presentation.
- **Notification source:** promotion redemption endpoint issues the grant.
- **Additional schema:** none beyond the shared grants table.
- **Requires now:** reserve `promotion` in the discriminated union (done in Phase 1); confirm `cosmeticRarity: 'limited'` is authoring-ready (done in Phase 1 / Cosmetic Rarity section).

### 6. Administrator-granted cosmetics
- **Unlock type:** `{ type: 'admin_grant' }` (no additional predicate; the grant row itself is the condition).
- **Rule:** grant-driven, always uses `player_appearance_grants` with `source: 'admin_grant'` and `sourceRefId: <admin user id>` for auditing.
- **Notification source:** admin console mutation issues the grant and emits a `progression_notification` with the same shape as any other unlock.
- **Additional schema:** none beyond the shared grants table.
- **Requires now:** reserve `admin_grant` in the discriminated union (done in Phase 1). Admin UI is out of scope until we generally build an admin appearance authoring tool; the DB grant row can be inserted manually in V1.

### 7. Cross-cutting future concerns (do not require V1 changes)
- **Per-appearance card / splash / animated variants:** handled by extending `assetId` with an optional `slot: 'card' | 'splash' | 'anim'` field. Adding this field is a non-breaking schema evolution because consumers default `slot` to `'card'`. No API redesign.
- **Localized display names / flavor text:** switch `name`, `description`, `flavorText`, `unlockLabel` to `Record<Locale, string>` at the content-schema layer and add a locale-negotiation step in the API serializer. Wire format changes are additive; existing clients continue to receive the default locale.
- **Player-to-player gifting of unlocked appearances:** grant table already models this — a gift creates a grant with `source: 'gift'`, `sourceRefId: <gifter playerId>`. No new architecture.
- **Trading cards / print collections:** the `assetId` primitive can be reused with `kind: 'card_print'`; the collection page's asset abstraction already handles multiple `AssetId.kind` values.

### Architectural changes we would need *right now* to avoid pain later
None. Every future source above is reachable by:
- adding a new `unlock.type` (already reserved in Phase 1's discriminated union),
- adding a `player_appearance_grants` table when the first non-derived unlock ships (deferred; not in V1),
- and adding a new case in `appearanceRules.isUnlocked`.

No V1 architectural change is required to preserve any of these paths.

---

## Cosmetic Rarity

*Purely descriptive presentation metadata. Never affects gameplay, drops, or unlocks. Fully independent from species rarity.*

- **Values (V1):** `standard`, `common`, `rare`, `seasonal`, `limited`, `exclusive`. Enum is closed to avoid clients rendering unknown values as raw strings, but future values can be added via additive schema updates that older clients tolerate (fallback: render as `common`).
- **Authored on the appearance:** each `AppearanceContentSchema` entry may include `cosmeticRarity`. Omitted ⇒ `standard`.
- **Never conflated with species rarity:**
  - Species rarity uses the existing palette (N / R / SR / SSR / UR / LR / EX).
  - Cosmetic rarity uses a **distinct visual style** (different border, different chip shape, different accent color) so a Rare species with a Seasonal appearance is unambiguously two independent signals.
  - Distinct field names in every schema (`species.rarity` vs `appearance.cosmeticRarity`) prevent accidental cross-wiring.
- **V1 render sites:**
  - Portal gallery tiles show a small `Seasonal` / `Limited` / … chip below the appearance name.
  - Portal detail panel repeats it in the metadata list (`Cosmetic Rarity: Seasonal`).
  - Discord gallery embed footer includes it as a single-word tag.
  - Discord unlock toast embed shows it under the appearance name.
- **Deferred to later versions:**
  - Rarity-based drop mechanics (there are no drops; appearances are earned, not rolled).
  - Rarity-based sorting / filtering in the gallery (may be added in V1.1 without schema change).
  - Rarity-scoped achievements ("Own 3 Seasonal appearances") — already reachable through the achievements section above.
- **Why introduce it in V1 despite being under-used:** shipping the field now means Seasonal/Limited/Exclusive content authored later requires zero schema change and zero migration; the client already knows how to render it.

---

1. **Unit tests** (`tests/unit/`):
   - `appearanceRules.test.ts` — `isUnlocked` for every V1 unlock type × ownership state × level boundary; `formatUnlockLabel` synthesizes correct defaults for `owned` and `level`.
   - `appearanceService.test.ts` — `detectNewlyUnlocked`, `selectAppearance` validation errors, `acknowledgeUnlocks` idempotence.
   - `contentSchemas.test.ts` — new appearance schema validation (missing owned default, duplicate ids, level out of range, cosmeticRarity enum, `assetId` defaults populated when omitted, `introducedVersion` free-form string accepted, `unlockLabel` synthesized when omitted).

2. **Integration tests** (`tests/integration/`):
   - Extend `collection.test.ts`: grant waifu → assert `standard` appearance auto-acknowledged; level up past a milestone → assert new appearance in `seenAppearances` and audit-log row; `PUT /appearance` with locked id → 409; with unknown id → 400; happy path → embedded `selectedAppearance` reflects new value including `assetId`, `cosmeticRarity`, `flavorText`, `unlockLabel`.
   - New test: retroactive unlock — persist a waifu at Lv 25 with no seen entry for `level_20`; call `listAppearances`; assert `level_20` becomes unlocked *and* an audit-log row is written with `source: 'content_add'`.
   - Cosmetic invariant test: `PUT /appearance` must not change level, xp, affection, isFavorite, or evolution state — assert exact row diff.
   - **Asset-abstraction guardrail test** (fires against every V1 route): parse response bodies and assert no image file extension (`.png|.jpg|.jpeg|.webp|.gif|.svg`) and no `assets/` substring appears anywhere. Locks the API contract into asset-location agnosticism.

3. **Portal tests**:
   - `WaifumonDetail` renders gallery, unlocked/locked states, locked click opens preview modal; every tile shows its `unlockLabel` regardless of state; cosmetic-rarity badge and `introducedVersion` chip render when set.
   - `useSetAppearance` optimistically updates the card image, then reconciles from server response.
   - E2E (Playwright): user opens collection detail → clicks a locked tile → sees `unlockLabel` and flavor text → levels up (via test seed) → refreshes → tile now unlocked → clicks tile → card image changes.

4. **Content lint** as part of CI:
   - Extended `validateSpeciesAssets` runs on every PR; fails only when a species has no valid owned appearance (i.e., cannot render at all). Missing non-default appearances produce warnings and are quietly disabled.

---

## Relevant Files

**Content & schema**
- `src/modules/content/schemas.ts` — add `AppearanceContentSchema`, extend `SpeciesContentSchema`.
- `src/modules/content/loader.ts` — extend `validateSpeciesAssets`, synthesize implicit `standard` appearance for legacy species.
- `content/species/starter.json`, `content/species/placeholders.json` — no changes required at ship; new artwork added incrementally.
- `docs/content-authoring.md` (new) — appearance authoring instructions.

**Database**
- `src/db/schema.ts` — add `seenAppearances: jsonb('seen_appearances').notNull().default([])` on `playerWaifus`.
- `drizzle/00XX_appearance_seen.sql` — generated migration.

**Domain services**
- `src/modules/appearance/appearanceRules.ts` (new) — pure `isUnlocked`.
- `src/modules/appearance/appearanceService.ts` (new) — list / select / detect / acknowledge.
- `src/modules/progression/progressionService.ts` — hook `detectNewlyUnlocked` into waifu level-up path; extend `LevelUpEvent` with `newAppearances?: AppearanceRef[]`.
- `src/modules/collection/collectionService.ts` — hook into `grantWaifu` for `owned` acknowledgement.

**Platform API**
- `src/api/schemas/collection.ts` — new `assetIdSchema`, `cosmeticRaritySchema`, `appearanceUnlockSchema`, `appearanceSchema`; extend `ownedWaifuSchema` with `selectedAppearance`. No path/URL fields.
- `src/api/routes/v1/collection.ts` — add `GET/PUT` appearance endpoints.
- `src/api/resources.ts` — extend `toSpeciesResource` to include species `appearances` catalog (metadata + `assetId` + `unlock` + `unlockLabel`).
- `src/api/routes/v1/content.ts` — surface species appearance catalog.
- `docs/platform-api.md` (or `platform-api-phase3.md`) — endpoint documentation.

**Discord**
- `src/discord/gameEventBuilders.ts` — extend `levelUpDescriptors`, add `appearanceUnlockedDescriptor`.
- `src/discord/commands/waifumonCollection.ts` — inspect-card gallery button + `StringSelectMenuBuilder` handler; renders `unlockLabel`, cosmetic rarity, and flavor text.
- `src/discord/commands/waifumon.ts` — optional `/wm appearance` subcommand.
- `src/discord/trainerProfile.ts` — activity-feed render case for `appearance_unlock`.
- `src/discord/assets/resolveAppearanceAsset.ts` (new) — the Discord process's `assetId → AttachmentBuilder|URL` resolver; the only place Discord code translates identity to storage.

**Portal**
- `portal/src/features/collection/AppearanceGallery.tsx` (new) — renders tiles with `unlockLabel`, cosmetic-rarity badge, `introducedVersion` chip, flavor-text detail panel.
- `portal/src/features/collection/WaifumonDetail.tsx` — embed `AppearanceGallery`.
- `portal/src/api/collection.ts` — `getAppearances`, `setAppearance`.
- `portal/src/api/hooks/useCollection.ts` — `useWaifuAppearances`, `useSetAppearance`.
- `portal/src/api/queryKeys.ts` — add `waifuAppearances` key.
- `portal/src/images/assets.ts` — no change required (already keyed on `AssetId`; consumes API `assetId` directly).
- `portal/msw/collection.ts` (or equivalent) — mock handlers.

**Assets (private to each consumer, never surfaced through the API)**
- `assets/waifumon/<slug>/<variant>.png` — the default local resolver's expected layout for the `assetId { kind: 'waifumon', slug, variant }` primitive. Consumers are free to remap this in production.

---

## Verification

1. Content-loader unit test — species with no `appearances` array parses successfully and gains an implicit `standard` owned appearance.
2. `pnpm test tests/unit/appearanceRules.test.ts` — level boundary and owned-state matrix passes.
3. `pnpm test tests/integration/collection.test.ts` — appearance grant/select/lock scenarios pass; cosmetic invariant test asserts zero drift on level/xp/affection when `variant` changes.
4. Retroactive-unlock integration test passes (waifu already above milestone, appearance content freshly added).
5. `pnpm drizzle-kit generate` produces exactly one column-add migration; `pnpm db:migrate` applies cleanly against a Testcontainers Postgres.
6. Manual: Discord `/wm collection inspect <waifu>` → tap `Appearance` → gallery renders; select unlocked → embed re-renders with new artwork; try locked → ephemeral explanation with milestone.
7. Manual: Discord level-up crossing a milestone posts a progression toast with the new appearance thumbnail and a working `Select Now` button.
8. Manual: Portal `/collection/<waifuId>` shows gallery, locked tiles show silhouettes with lock badges, selecting an unlocked tile updates the hero art without a page reload and buddy hero at `/buddy` reflects the change on next navigation.
9. Manual: `GET /v1/players/{id}/collection/owned/{waifuId}/appearances` returns embedded unlock metadata, `assetId`, `cosmeticRarity`, `flavorText`, `introducedVersion`, and `unlockLabel`; matches the gallery on both surfaces.
10. Lint / architectural boundary check confirms `appearanceService` has no imports from battle/affinity/progression-write paths (defensive).
11. **Asset-abstraction guardrail test**: parse every V1 API response body across all routes and assert no substring matches `/\.(png|jpg|jpeg|webp|gif|svg)$/i` and no substring contains `assets/` — proves the API is asset-location agnostic and stays that way.

---

## Decisions

- **Selected appearance is per-owned-instance**, not per (player, species). Storage is `playerWaifus.variant` (already exists). Reasoning: matches the spec's "each owned Waifumon should store a selected appearance" and lets duplicates be styled differently.
- **V1 unlock state is derived**, not persisted (`owned`, `level` are pure functions of waifu state). Only "was the player notified?" is persisted, via `seenAppearances jsonb[]`. Reasoning: retroactive content adds become free; future non-derivable unlocks (event, achievement) will introduce a `player_waifu_appearances` grant table without disturbing V1 code.
- **Platform API is asset-location agnostic.** It emits `assetId = { kind, slug, variant }` and never a path, URL, extension, or storage hint. Every consumer (Portal, Discord, future CDN / object storage / mobile) resolves the identifier independently. Migrating storage backends is a per-consumer change with zero API contract impact. Enforced by a CI test that asserts no image extensions or `assets/` substrings appear in any V1 API response body.
- **Appearance metadata is rich but purely presentational.** `name`, `description`, `flavorText`, `cosmeticRarity`, `introducedVersion`, `unlockLabel` all render on the client and never influence gameplay, stats, XP, affection, or drop rates.
- **Cosmetic Rarity is fully independent from species rarity.** Values: `standard | common | rare | seasonal | limited | exclusive`. Rendered as a distinctly-styled badge (never using the species-rarity palette).
- **Unlock requirements are permanently shown** on every gallery entry, locked or unlocked — the gallery is a progression journal, not a lock/unlock indicator.
- **Notification pipeline is the existing game-event / activity-feed pipeline**, with a new soft-typed `appearance_unlock` event. No new tables, no new bus, and V2 event types plug into the same case-statement site.
- **In scope for V1:** `owned` + `level` unlock types; rich cosmetic metadata (all fields); cosmetic rarity model; permanent unlock-requirement labels; gallery + selection on Discord and Portal; unlock notifications on Discord and activity feed; Platform API endpoints; asset identity contract.
- **Explicitly excluded from V1:** evolution appearances, affection appearances, event appearances, seasonal appearances, achievement appearances, promotional appearances, admin-grant appearances, premium cosmetics, per-appearance card/splash split, cross-copy sharing of unlocks, admin UI for authoring appearances (content JSON only for now).

---

## Further Considerations

1. **Retroactive-unlock trigger — on-read vs background reconciler.**
   Recommend **on-read** (as designed above): every `listAppearances` call detects and acknowledges. Simple, no cron, always current. Downside: a player who never opens the gallery never gets the audit-log entry. Alternative: a nightly reconciler job. Recommendation: ship on-read, add a reconciler later only if audit gaps matter.
   - A) On-read only *(recommended)*
   - B) On-read + weekly reconciler
   - C) Reconciler on every game event

2. **Portal image resolution — keep `localDevAssets` or add `platformApiProvider` now?**
   The spec asks for future migration between local / API / CDN / object storage. The provider chain already enables this. Recommendation: **ship V1 with `localDevAssets` unchanged**, add a stub `platformApiProvider` behind a `VITE_ASSET_MODE` env flag as prep work but do not enable it. Migration later is one config change.
   - A) Local only, add provider stub *(recommended)*
   - B) Local + enabled API provider from day one
   - C) Local only, no stub yet

3. **Locked-appearance preview — reveal artwork or keep silhouette?**
   Spec says "preview artwork" in the gallery, which implies revealing the locked art. Recommendation: **reveal on explicit "Preview" hover/click** (opt-in), silhouette by default in the grid, so players who want the surprise can keep it. Discord side: locked selection responds with silhouette + text only (Discord ephemeral messages don't hover-preview well).
   - A) Reveal on explicit hover/click *(recommended)*
   - B) Reveal always
   - C) Silhouette only, never reveal until unlocked

4. **Discord: dedicated `/wm appearance` command?**
   Recommendation: **yes**, small addition that makes the feature discoverable independently of the inspect flow.
   - A) Add `/wm appearance <waifu>` *(recommended)*
   - B) Reachable only via inspect card
