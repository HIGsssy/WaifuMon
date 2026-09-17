# Hunt filler-result presentation audit

**Audit date:** 2026-09-17 · **Branch:** `Encount` (at `5d07405`) · **Type:** read-only architecture audit. No code, migrations or tests were changed.

**Goal it serves:** let the Portal author presentation (flavor text, artwork, weighted and enable/disable variants, preview) for lightweight hunt results and for "Let Her Go", while gameplay stays authoritative over every reward.

**Short answer:** The hunt pipeline already keeps reward calculation and presentation mostly apart. The service works out and saves the reward, then returns a typed result, and Discord builds the message from that result. Four things make Portal-authored presentation harder than it looks:

1. **Let Her Go is not a hunt result.** It happens in a later button click and also applies to Waifumon spawned by World Encounters. Right now it replies with a plain text line and removes the artwork.
2. **A World Encounter completely replaces the find screen.** The reward is already granted but never shown.
3. **The "nothing found" line is picked inside the gameplay service,** using the same random-number generator (RNG) as the gameplay rolls.
4. **All artwork is files on disk in each environment,** entered as a free-text path. There is no picker, no upload, and promotion only carries the path.

Line numbers are as of the commit above. Two claims were confirmed by reading the code directly: the World Encounter publish-permission gap (§10) and the `.png`-only attachment name (§9).

---

## 1. Current hunt result architecture

The hunt runs in this order:

1. **Entry point.** `/waifumon hunt` or the menu's Hunt button calls `handleHunt` ([waifumonHunt.ts:444](../src/discord/commands/waifumonHunt.ts#L444)).
2. **Gameplay.** `ctx.services.hunt.hunt()` → `createHuntService().hunt` ([huntService.ts:501](../src/modules/hunt/huntService.ts#L501)). One transaction does all of this:
   - Care Mode pending ticks
   - currency and player row locks
   - the one-active-encounter check (with lazy expiry)
   - cooldown and energy checks
   - the Buddy Bonus lookup
   - the Energy spend
   - hunt XP, the buddy award and quest events
   - **the result roll**, then the reward grant or encounter insert
3. **Result type.** The service returns the `HuntResult` union ([huntService.ts:133](../src/modules/hunt/huntService.ts#L133)): `HuntEncounterResult | HuntItemResult | HuntWaifubuxResult | HuntEssenceResult | HuntFlavorResult`. Each extends `WithXp` ([:67](../src/modules/hunt/huntService.ts#L67)).
4. **Discord follow-up.** `handleHunt` records session events ([:457-491](../src/discord/commands/waifumonHunt.ts#L457-L491)), then builds Activity Feed narration with `huntDescriptors` ([gameEventBuilders.ts:231](../src/discord/gameEventBuilders.ts#L231)).
5. **Encounter path.** An encounter result goes to `buildEncounterView` ([waifumonHunt.ts:279](../src/discord/commands/waifumonHunt.ts#L279)).
6. **World Encounter routing (every other result).** `maybeTriggerHuntEncounter` ([waifumonWorldEncounter.ts:190](../src/discord/commands/waifumonWorldEncounter.ts#L190)) calls `worldEncounter.tryRollForHunt` ([worldEncounterService.ts:459](../src/modules/worldEncounters/worldEncounterService.ts#L459)). If it fires, the World Encounter screen **replaces** the find screen.
7. **Find screen.** Otherwise the find embed is built **inline** in `handleHunt` ([waifumonHunt.ts:533-573](../src/discord/commands/waifumonHunt.ts#L533-L573)).

**No presentation layer exists for filler results.** There is no presenter module, and the result-kind union is the only abstraction for these outcomes. The closest pattern is the dedicated [worldEncounterPresenter.ts](../src/discord/worldEncounterPresenter.ts).

**Web gameplay:** the Platform API has no hunt endpoint. [encounter.ts](../src/api/routes/v1/encounter.ts) only offers `GET /players/:playerId/encounter`, so this presentation is Discord-only today.

## 2. Hunt result types and selection weights

`HUNT_RESULT_KINDS` is defined in [schemas.ts:~726-734](../src/modules/content/schemas.ts#L726-L734), and the table is validated by `HuntTableSchema` ([schemas.ts:773](../src/modules/content/schemas.ts#L773)). The values come from `content/tables.json` → `hunt`:

| Kind | Weight | Sub-roll |
|---|---|---|
| `encounter` | 74 | rarity table N 60 / R 25 / SR 10 / SSR 4 / UR 0.9 / LR 0.1, plus a level-40 shift and Buddy weighting |
| `item_find` | 8 | `basic_charm` 70 (qty 1–2), `silk_charm` 30 (qty 1) |
| `waifubux_find` | 8 | 5–15 |
| `essence_find` | 5 | 15–35 base, then the Buddy `essence_gain` bonus |
| `rare_item_find` | 3 | `velvet_charm` 60, `prismatic_charm` 39, `mythic_contract` 1 (all qty 1) |
| `flavor` | 2 | one of 4 lines, picked uniformly |

- **Item-find bonus.** The Buddy bonus `hunt_item_find_chance` scales the two item weights relative to the rest ([huntService.ts:655-665](../src/modules/hunt/huntService.ts#L655-L665)).
- **Rare items are a separate kind** (`rare_item_find`) but share the `HuntItemResult` type and code path. Only the sub-table differs ([huntService.ts:748](../src/modules/hunt/huntService.ts#L748)).
- **World Encounters are not in this table.** They are a second, independent roll: `huntChance` from the DB settings (`settingsService`, schema default 0.35). That roll runs *after* any non-encounter result has been committed.

## 3. Waifubux result path

- **Granted:** [huntService.ts:784-799](../src/modules/hunt/huntService.ts#L784-L799). It draws `rng.intInclusive(min, max)` and calls `currency.grantWaifubux(tx, …)`. No Buddy Bonus applies.
- **Result fields:** `amount` and `balanceAfter`.
- **Shown:** [waifumonHunt.ts:539-542](../src/discord/commands/waifumonHunt.ts#L539-L542) — title `'💰 WaifuBux Found'`, description `+**N** WaifuBux (balance: B)`.
- **Also recorded:** a session `find` event ([waifumonHunt.ts:481](../src/discord/commands/waifumonHunt.ts#L481)) and `PLAYER_FOUND_WAIFUBUX` narration.

## 4. Essence result path

- **Granted:** [huntService.ts:801-822](../src/modules/hunt/huntService.ts#L801-L822). It draws a base amount, then calls `essenceAward.awardEssence(tx, playerId, base)` ([essenceAwardService.ts](../src/modules/currency/essenceAwardService.ts)). That function is the single choke point for the `essence_gain` bonus.
- **Result fields:** `amount` is the **final** amount granted. `balanceAfter` is also included.
- **Buddy bonus:** if it applied, it is pushed onto `buddyBonuses` as an `AppliedBuddyBonus` with `baseValue`/`finalValue` ([buddyBonusEffects.ts:360](../src/modules/buddyBonus/buddyBonusEffects.ts#L360)). **The base amount is not a field of `HuntEssenceResult`;** it only survives inside that bonus record.
- **Shown:** [waifumonHunt.ts:543-546](../src/discord/commands/waifumonHunt.ts#L543-L546), with bonus lines from `buddyBonusFeedbackLines` ([buddyBonusFeedback.ts:39](../src/discord/buddyBonusFeedback.ts#L39)).

## 5. Item and rare-item result paths

- **Granted:** [huntService.ts:743-782](../src/modules/hunt/huntService.ts#L743-L782). The service picks a sub-table, rolls the entry, loads it with `loadItemBySlug`, rolls the quantity, and calls `inventory.addItem(tx, …)`.
- **Silent fallback:** if the item row is missing or disabled, the result **silently becomes `flavor`** ([huntService.ts:754-767](../src/modules/hunt/huntService.ts#L754-L767)).
- **Result fields:** `item: ItemRow` (full row, including name, slug, emoji, category and so on) and `quantity`.
- **Shown:** [waifumonHunt.ts:534-538](../src/discord/commands/waifumonHunt.ts#L534-L538). The title is `'🌟 Rare Find!'` or `'🎒 Item Found'`; the description is `emoji **name** ×qty`.
- **Session events:** only `rare_item_find` records one ([waifumonHunt.ts:476](../src/discord/commands/waifumonHunt.ts#L476)). Normal item finds don't.

## 6. Flavor / nothing-found result path

- **Text is chosen inside the gameplay service:** `hunt.flavor[rng.intInclusive(...)]` ([huntService.ts:825](../src/modules/hunt/huntService.ts#L825)). It uses **the same `rng` as every gameplay roll**.
- **`flavor` is also the degrade path** in two places: no species available ([huntService.ts:679-691](../src/modules/hunt/huntService.ts#L679-L691)), and an item missing or disabled.
- **Result field:** `HuntFlavorResult.text`.
- **Shown:** [waifumonHunt.ts:547-548](../src/discord/commands/waifumonHunt.ts#L547-L548) — title `'🍃 Nothing but wind…'`.
- **Not recorded anywhere:** no session event, and `huntDescriptors` emits nothing for this kind.

## 7. Let Her Go path

This is not a hunt result. It is a state change on an encounter, triggered by a later interaction.

- **Button:** `enc:release:<encounterId>` is created in `encounterButtonRows` ([waifumonHunt.ts:145](../src/discord/commands/waifumonHunt.ts#L145)) and in the post-failure `retryButtonRows` ([waifumonHunt.ts:801](../src/discord/commands/waifumonHunt.ts#L801)). It is routed in [client.ts:264](../src/discord/client.ts#L264).
- **Handler:** `handleEncounterRelease` ([waifumonHunt.ts:1252](../src/discord/commands/waifumonHunt.ts#L1252)) calls `hunt.letHerGo` ([huntService.ts:863](../src/modules/hunt/huntService.ts#L863)).
- **Database changes:** in one transaction it locks the row and checks it is active. If it has expired, it marks it `expired` and throws. Otherwise it sets `state='released'` and `resolvedAt`, and returns the updated `EncounterRow`.
- **What is not touched:** no `capture_attempts` row, no inventory or currency change, and no consumable charge (tested in `tests/integration/consumables.test.ts:511`).
- **History and narration:** no session event, no game event and no Activity Feed entry. The `encounters` row itself is the only history.
- **Final message:** plain `content: 'You let her slip back into the neon~'`, with `embeds: []` and `files: []`. The `files: []` explicitly **removes** the artwork that was on the encounter screen.
- **Available but thrown away:** the handler discards the returned row. That row carries `speciesId`, `regionId` (nullable snapshot), `attemptCount`, `originKind`/`originRef` and `selectedItemId`. Species, rarity, archetype, affinity and appearance would need one lookup: `loadSpeciesById` already exists in the same file ([waifumonHunt.ts:425](../src/discord/commands/waifumonHunt.ts#L425)).
- **Canonical artwork is reusable immediately.** `attachSpeciesArtwork(ctx, species)` ([waifumonHunt.ts:256](../src/discord/commands/waifumonHunt.ts#L256)) is exactly what the escape and resist outcomes use.
- **Shared code:** none. It does not use `buildEphemeralOutcomeMessage` ([waifumonHunt.ts:824](../src/discord/commands/waifumonHunt.ts#L824)), which serves success, escape and failure.
- **Scope is wider than hunting.** The same button appears on encounters opened through `handleWildEncounterOpen` ([waifumonHunt.ts:1297](../src/discord/commands/waifumonHunt.ts#L1297)), which are World-Encounter-spawned wild Waifumon with `originKind` set. A "hunt result" name would be wrong for it.
- **Expiry is unrelated:** an encounter that expires has no presentation at all.

## 8. Current Discord presentation architecture

- **All filler presentation is inline in `handleHunt`** and fully hard-coded: one shared embed, colour `0xff6fa5`, with the title and description chosen per kind.
- **Appended after the description:** level-up lines, Buddy bonus and award lines, and the footer `Energy left: N`.
- **Components:** Hunt again plus Back (`withBackRow`, [ui.ts:68](../src/discord/ui.ts#L68)).
- **No images on find embeds today.** `respondScreen` clears files unless they are provided ([ui.ts:39](../src/discord/ui.ts#L39)).
- **Duplication:** the level-up line format is repeated in `buildEphemeralOutcomeMessage` ([waifumonHunt.ts:928](../src/discord/commands/waifumonHunt.ts#L928)), and `rarityColor` is local to this file.
- **Reusable helpers:** [buddyBonusFeedback.ts](../src/discord/buddyBonusFeedback.ts), whose header states the rule "presentation never decides whether a bonus applied".

## 9. Current artwork architecture

**Where files live**
- The root is `ASSETS_DIR` ([config.ts:17](../src/config/config.ts#L17)), `/app/assets` in Docker. It is mounted read-only from each stack's own `./assets` checkout ([docker-compose.yml:47](../docker-compose.yml#L47)); the image contains no assets.
- **Species:** stored as `waifumon/<slug>/<variant>.png` ([appearanceContent.ts:76](../src/modules/appearance/appearanceContent.ts#L76)). Resolved through `resolveAppearanceAsset` / `resolveAppearanceAssetOrLegacyPath` ([assetResolver.ts:65-108](../src/modules/appearance/assetResolver.ts#L65-L108)), then `resolveAppearanceAssetOrPath` ([resolveAppearanceAsset.ts](../src/discord/assets/resolveAppearanceAsset.ts)).
- **Cards:** rendered into `.card-cache` ([attachRenderedCard.ts](../src/discord/assets/attachRenderedCard.ts)).
- **Bosses:** `relativeAssetPath` schema ([schemas.ts:1334](../src/modules/content/schemas.ts#L1334)), resolved by `resolveBossArtwork` ([bossArtwork.ts:29](../src/discord/bossArtwork.ts#L29)).

**Path safety**
- The authoritative check is `resolveAssetPath` ([loader.ts:57-66](../src/modules/content/loader.ts#L57-L66)), which enforces root containment.
- The boss `relativeAssetPath` schema is the strongest validator: no leading slash, no drive letter, no backslash, no `..`.
- World Encounter `artworkPath` validation is weaker: only `!includes('..')` and `max(200)` ([types.ts:264](../src/modules/worldEncounters/types.ts#L264)). Containment is then enforced when the file is used.

**World Encounter `artworkPath` end to end**
- **DB:** the `world_encounters.artwork_path` text column ([schema.ts:1464](../src/db/schema.ts#L1464)).
- **Discord:** `resolveEncounterArtwork` ([worldEncounterPresenter.ts:58](../src/discord/worldEncounterPresenter.ts#L58)) → `AttachmentBuilder` → `attachment://…`. A missing file degrades to a text-only embed.
- **Filename bug (verified):** `encounterArtworkFilename` always appends `.png`, even for `.webp`/`.jpg` sources ([worldEncounterPresenter.ts:49](../src/discord/worldEncounterPresenter.ts#L49)).

**How the Portal gets artwork**
- **Admin route:** `GET /v1/admin/encounters/artwork?path=` ([admin/encounters.ts:683](../src/api/routes/v1/admin/encounters.ts#L683)). It needs `encounters.read`, checks against an extension allowlist, uses `resolveAssetPath` and `existsSync`, and returns the bytes.
- **Portal component:** `EncounterArtwork` ([EncounterArtwork.tsx](../portal/src/components/media/EncounterArtwork.tsx)) fetches that route as a blob and shows it via an object URL, with empty, loading, missing and loaded states.
- **Coupling:** the component is generic apart from its name, the API function it calls and the `encounters.read` permission.

**Player-facing routes and Portal image providers**
- Species routes live in [artwork.ts](../src/api/routes/v1/artwork.ts) and require species visibility or ownership.
- The Portal's image providers (`portal/src/images/*`) handle species and cards only.

**Authoring**
- The encounter editor has a free-text `<Input>` with a live preview ([AdminEncounterEditorPage.tsx:315-330](../portal/src/features/adminEncounters/AdminEncounterEditorPage.tsx#L315-L330)).
- **No picker, no asset-listing endpoint, and no upload** — this is explicitly deferred per [docs/admin-web.md](../docs/admin-web.md).

**Discord delivery**
- Always sent as attachments, never URLs.

**Staging vs production**
- The code paths are identical. They are separated only by `COMPOSE_PROJECT_NAME`, and each stack serves its own `./assets` checkout.

## 10. Portal/admin architecture

**Routes and navigation**
- Admin routes are declared in [router.tsx:205-246](../portal/src/app/router.tsx#L205-L246), with nav entries in [navigation.ts:57-71](../portal/src/app/navigation.ts#L57-L71).
- Routes are gated in the UI by `RequirePortalPermission`. Its own comment says this is a convenience, not a security boundary.

**Permissions**
- The list is `ALL_PORTAL_PERMISSIONS` ([portalAuthService.ts:38](../src/modules/portalAuth/portalAuthService.ts#L38)): `admin.access`, `admin.roles.manage`, and `encounters.{read,write,publish,simulate,history}`.
- The server enforces them with a per-route `gate()` at `preValidation`, which calls `requirePortalPermission` ([portalPermissions.ts:69](../src/api/plugins/portalPermissions.ts#L69)).

**Admin features**
- `portal/src/features/adminEncounters/*` is entirely World-Encounter-shaped.
- Preview runs on the server against the **saved** row, not unsaved edits.
- `GlobalEncounterSettingsPanel` and `ContentPromotionPanel` are WE-specific.

**API client**
- [adminEncounters.ts](../portal/src/api/adminEncounters.ts) is a flat module of functions over `client.ts` helpers.
- There are no admin hooks and no admin query keys in `queryKeys.ts`; pages use literal keys.

**No "Gameplay Content" abstraction exists.** There are two separate worlds:
- **JSON-file content** via `AdminContentService` ([adminContentService.ts](../src/modules/content/adminContentService.ts)), editable only in the **legacy** admin panel (`src/admin/`, still mounted when `ADMIN_WEB_ENABLED`). That panel can already edit `tables.json`, **including `hunt.flavor`**.
- **DB content:** World Encounters, via `worldEncounterRepository` and `adminService`. There are no revisions: edits to an active row apply immediately.

**Security finding (verified):** a role with only `encounters.write` can publish an encounter. `POST` and `PUT /admin/encounters` accept `lifecycle: 'active'` without the `encounters.publish` check that the lifecycle `PATCH` enforces ([admin/encounters.ts:863-903](../src/api/routes/v1/admin/encounters.ts#L863-L903) vs [admin/encounters.ts:950](../src/api/routes/v1/admin/encounters.ts#L950)). Don't copy this pattern.

**Realistically shareable:** the `gate()` pattern, `EncounterArtwork` (after renaming or generalising it), the artwork route logic, the `PlanIssue` model, UI primitives, and `downloadJson`.

## 11. Reward vs presentation boundary

The boundary is **`HuntService.hunt()` returning**: everything before it is authoritative and committed, and everything after it is presentation. That already matches the `reward = grant(); embed = render(reward)` shape, with these exceptions:

| Result | Where the boundary sits | What needs separating |
|---|---|---|
| Waifubux | clean | — |
| Essence | clean. The bonus maths lives in `awardEssence`. | The base amount is only available via `bonus.baseValue` |
| Item / rare item | clean | A missing or disabled item silently becomes `flavor` |
| Flavor | **blurred**: text is chosen in the service with the gameplay `rng` | Move text choice to the presentation side, on its own RNG |
| Let go | clean (`letHerGo` → handler) | The handler discards the row; a species lookup is needed |
| Any filler result + World Encounter | the reward is committed, then **the presentation is replaced** | Decide whether the World Encounter screen should mention the find |

**Why the flavor RNG matters:** the codebase deliberately protects the RNG sequence. See the `energy_save_chance` comment at [huntService.ts:592-595](../src/modules/hunt/huntService.ts#L592-L595). Any weighted variant pick for presentation must **not** draw from `deps.rng` inside the transaction, or seeded tests and downstream rolls will shift.

**Future presentation code must receive only the finished result object.** It should never be handed `tx`, services, or the tables. Presentation must never be authoritative for reward amount, reward item, rarity roll, species selection, capture chance, XP, Essence bonus calculations, Buddy Bonuses, or inventory and currency changes.

## 12. Runtime data available to presentations

At `handleHunt`, after the result is back:

- **Every result:** `levelUps`, `buddyAward` (a `PlayerWaifu` row with xp/affection and bonus fields; getting the buddy's *species* needs a lookup), `careExit`, `session` boundary, `energySaved`, `buddyBonuses[]`, `energyRemaining`.
  - The player is available via `prov` (playerId, guildDbId) and `interaction.user`.
  - **Region is not in any non-encounter result.** The handler reads `travel.getCurrentRegion()` *after* the commit ([waifumonHunt.ts:523](../src/discord/commands/waifumonHunt.ts#L523)). The locked `player.currentRegion` inside the service is not returned.
- **Waifubux:** `amount`, `balanceAfter`.
- **Essence:** final `amount`, `balanceAfter`, plus `baseValue`/`finalValue` and the bonus name, only when a bonus applied.
- **Items:** the full `ItemRow` (slug, name, emoji, category and the rest) and `quantity`. The normal vs rare distinction comes from `kind`. Not yet checked: whether `items` has a rarity column.
- **Flavor:** `text`, plus the common fields.
- **Let go:** the returned `EncounterRow` (`speciesId`, `regionId` which may be null, `attemptCount`/`maxAttempts`, `originKind`) and `prov`. With one lookup: the `SpeciesRow` (name, rarity, archetype, affinity, description) and its default appearance and artwork. `buildEncounterView` already does the equivalent.
  - Race comes from authored content via `buddyBonus.subjectFor`, not from the species row.

## 13. Reusable World Encounter infrastructure

**Reuse:**
- The `artworkPath` storage convention: a relative path under `assets/`, nullable.
- `resolveAssetPath` containment, `resolveEncounterArtwork`'s degrade-to-text behaviour, and the admin artwork route logic.
- The `EncounterArtwork` preview component.
- The [outcomeText.ts](../src/modules/worldEncounters/outcomeText.ts) normalisation and length-cap pattern: `OutcomeTextSchema`, `OUTCOME_TEXT_MAX_LENGTH`, and a single resolver that every surface uses.
- The `gate()` / `requirePortalPermission` authorisation.
- The DB settings service caching pattern ([settingsService.ts](../src/modules/worldEncounters/settingsService.ts)), which gives hot edits without a restart.
- The promotion building blocks: preview-then-apply, `stableJson`, `PlanIssue`.

**Improve rather than copy:**
- The weak `..`-only path validation (use the boss `relativeAssetPath` rules).
- The `.png`-only attachment name.
- Publish checks that live only on the lifecycle route.
- Preview that only works on saved rows.

**Must not reuse:** `world_encounters` / `active_world_encounters`, choices, checks, effects, chaining, cooldowns, `hasHistory` deletion guards, lifecycle `draft` semantics tied to selectors, `huntEligible`/`travelEligible`, or the WE engine and presenter. Filler presentation needs none of these.

## 14. Content promotion implications

- **Tightly coupled to World Encounters.**
  - The format is `PACKAGE_FORMAT = 'waifumon-world-encounters'`, version 1, with an exact format and version match ([encounterPackage.ts:53](../src/modules/worldEncounters/encounterPackage.ts#L53), checks at lines 470–481).
  - The envelope contains only `vendors[]` and `encounters[]`.
  - Target-state checks, the import log table and the routes are all encounter-specific.
- **Artwork is referenced, not packaged.** A missing file on the target is only a **warning**.
- **Adding a kind is moderate to high effort:** a new format or kind-tagged envelope, a target-state loader, an apply branch, new permissions, and a Portal panel.
- **Target-environment dependencies for presentation variants:** the artwork files must already exist in the target's `./assets`, and item slugs are only relevant if a variant is ever keyed by item.
- **Existing bug:** rejection details are lost, because `AppError` has no details field ([encounterPromotion.ts](../src/api/routes/v1/admin/encounterPromotion.ts), catch block around lines 204–214). The Portal only receives a problem count.

**Recommendation:** make presentation a **separate** package format later, reusing the planner and `PlanIssue` pattern, rather than extending the WE envelope.

## 15. Relevant existing tests

**Service-level coverage is good**
- [tests/integration/hunt.test.ts](../tests/integration/hunt.test.ts) covers each non-encounter kind (kind, range, balance or inventory) and Let Her Go → `released`.
  - Its "flavor" test only checks `kind`.
  - It uses fixture weights, not production weights.
- `regionalHunt.test.ts`, `essenceAward*.test.ts`, `speciesSelection.test.ts`, `random.test.ts` and `huntSession.test.ts`.
- `consumables.test.ts:511` (no charge on Let Her Go).

**World Encounters**
- `huntWorldEncounterReach.test.ts` (the WE roll is only reached for non-encounter hunts).
- `worldEncounterSettings.test.ts`.
- `worldEncounterArtwork.test.ts`: missing file, path escaping the assets root, attachment naming.
- Outcome-flavor tests (unit, integration and Portal).

**Portal**
- `EncounterArtwork.test.tsx`, `artworkRoundTrip.test.ts`, `OutcomeFlavor.test.tsx`, and `portal/src/images/__tests__/*`.

**Gaps**
- No test asserts the find embeds. None of the five titles appears in any test.
- No test of the flavor text choice or of the two degrade-to-flavor paths.
- No test of the `handleEncounterRelease` handler or the screen it paints.
- No test that a World Encounter suppressing the find screen still leaves the reward committed.
- No hunt equivalent of `worldEncounterTriggerPath.test.ts`.

## 16. Risks and architectural problems found

1. **World Encounters hide filler presentation.** Authored find art and text would never show on roughly `huntChance` (DB default 35%) of filler hunts.
2. **Flavor text is chosen with the gameplay RNG inside the transaction.**
3. **Silent degrade to flavor.** A misconfigured item shows "nothing found" text while the item presentation never runs.
4. **Let Her Go** is not a hunt result, also covers spawned encounters, emits no events, and discards its data.
5. **Artwork is per-environment files with no upload.** Presentation art has to ship through the assets checkout or deploy, and promotion cannot carry it.
6. **Hot reload.** `createHuntService` captures `tables.hunt` at construction ([huntService.ts:242](../src/modules/hunt/huntService.ts#L242)), so the flavor pool needs a restart. The legacy panel says the same. DB-authored presentation needs a cached read path.
7. **Two editing surfaces.** The legacy admin panel already edits `hunt.flavor`, so adding a Portal editor creates a second source of truth unless one is retired.
8. **The publish-permission bypass pattern** in the WE admin routes (see §10).
9. **Weak WE path validation and the `.png` attachment name.**
10. **Preview only works on saved rows.** A "Discord preview" is really a data preview that the Portal renders; there is no shared renderer.
11. **Duplicated embed helpers** (level-up line, `rarityColor`), and no find-embed tests to refactor safely against.

## 17. Recommended architecture for a future implementation

### Naming and scope

**Neither `hunt_result_presentations` nor a broad `gameplay_presentations`.**
- `hunt_result_presentations` is wrong because Let Her Go is not a hunt result and applies to spawned encounters.
- A generic `gameplay_presentations` invites scope creep toward the World Encounter machinery.

**Recommended:** a narrow `result_presentation_variants` table, keyed by a **closed, code-defined** `presentation_key` enum. The initial keys would be:
- `hunt.waifubux_find`
- `hunt.essence_find`
- `hunt.item_find`
- `hunt.rare_item_find`
- `hunt.nothing_found`
- `encounter.released`

The closed enum keeps it type-safe and auditable. It can later grow to `capture.escaped` and similar without a new abstraction.

**Columns:** key, label, `enabled`, `weight > 0`, optional `flavor_text` (reusing the `OutcomeTextSchema`-style normalisation and cap), optional `artwork_path` (validated with the boss `relativeAssetPath` rules plus `resolveAssetPath` and an extension allowlist), `artwork_mode`, and timestamps.

**Deliberately excluded:** choices, effects, cooldowns, lifecycle beyond `enabled`, and history.

### Runtime shape
1. **Gameplay stays unchanged,** apart from two fixes:
   - Move flavor-text selection out of `HuntService`. Keep `kind: 'flavor'`; `tables.hunt.flavor` becomes the fallback pool.
   - Have `letHerGo`'s caller use the returned row.
2. **New pure resolver:** `resolvePresentation(key, context, presentationRng)`. It picks from the enabled weighted variants using a **separate** RNG, and falls back to the current hard-coded copy when none exist. It must never import services and never be handed `tx`.
3. **Extract the inline find embed** into `src/discord/huntResultPresenter.ts`, following the `worldEncounterPresenter.ts` style.
   - **Mechanical lines stay code-rendered:** amounts, balances, bonuses and level-ups. Authored text is prose *alongside* them.
   - This avoids needing a template language at all, and makes it structurally impossible for presentation to affect or misstate rewards.
4. **Read path:** use a cached repository read like `settingsService` (TTL-based), so edits apply without a restart.

### Feature support

| Capability | Recommendation |
|---|---|
| Multiple variants | **Yes** |
| Weighted variants | **Yes** (integer weight > 0) |
| Enabled/disabled per variant | **Yes**; with no enabled variant, use the built-in default |
| Optional flavor text | **Yes** |
| Optional custom artwork | **Yes** |
| Encountered-Waifumon artwork for let-go | **Yes**: `artwork_mode = 'encountered' \| 'custom' \| 'none'`, defaulting to `encountered` via `attachSpeciesArtwork` |
| Region-specific variants | **Later.** Pass region in the resolver context now so it is additive, and return it on hunt results from the locked player row rather than re-reading it after the commit |

### Portal
- Add a new admin section with new permissions (e.g. `presentations.read/write/publish`), rather than reusing `encounters.*`, and **enforce publish on every write route**.
- Generalise `EncounterArtwork` and the artwork route into an asset-preview component and route that aren't tied to encounters.
- Preview should use the same resolver, fed by sample context, and should work on **unsaved** drafts.
- Retire or make read-only the legacy panel's `hunt.flavor` editing.

### Before building
- Add characterisation tests for the five find embeds and the release screen.
- Decide product behaviour for "find + World Encounter" (for example, a one-line find summary on the World Encounter screen).
- Accept that artwork deployment stays file-based until an upload or asset-listing feature exists.
- Treat promotion as a separate future package format.

**What makes this bigger than it looks:** the World Encounter override, Let Her Go being outside the hunt pipeline, flavor selection sitting in the gameplay RNG, and file-based per-environment artwork with no picker or upload.
