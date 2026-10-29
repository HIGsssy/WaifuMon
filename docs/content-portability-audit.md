# Content portability audit

Staging-to-production deployment readiness — 2026-10-29

## 1. Executive summary

**The existing systems provide a useful base, but do not yet provide complete staging-to-production content deployment with artwork.** Preserve their separate lifecycles and add bounded package operations around them.

| Phase | Assessment | Principal finding |
|---|---|---|
| CP-1 — Equipment Catalogue | **Minor improvements needed** | Definition transfer already works, including updates and owned-copy protection. Fix empty-filter export scope and import request-size limits; make external artwork requirements visible. |
| CP-2 — Affixes and rarity rules | **Bulk multi-library export/import improvement, with additional dependency review** | Individual managed libraries and the whole rarity-rule document already transfer to drafts. Stable-key assignments already avoid cross-environment revision-number assumptions. No bulk library package or atomic multi-library preview/apply exists. Legacy flavour affixes remain shipped JSON. |
| CP-3 — Standalone enemies and artwork | **Significant work required for the requested workflow** | Standalone CRUD and full definition export exist. There is no Enemy Catalogue package importer, selected export, binary package, asset deduplication, or cross-environment artwork rebinding. |
| CP-4 — Complete dungeon bundles | **Significant but bounded extension** | JSON packages v1–v4 already carry graph content, enemy definitions, modern loot tables, events and species dependency evidence. They omit artwork bytes and several global definitions. Scene Sprite placements explicitly block package export/import. |

The most serious blockers are CP-3's missing standalone importer and image transfer, CP-4's omitted assets/Scene Sprites, and destination species/items that must already have been deployed through content files. A successful current dungeon import is **not** evidence that all artwork is available: missing artwork is a warning, and a draft can remain publishable with that warning.

**Smallest recommended implementation:** close CP-1's two small correctness/transport gaps first, retaining its v3 format and current import policy. Next add a small JSON bulk wrapper for CP-2 and a standalone enemy archive using the existing artwork store for CP-3. Extend dungeon packages only after that asset transfer path exists. No universal content-management framework is warranted.

Evidence and limitations: findings below are confirmed by static source/schema inspection at the recorded HEAD unless labelled **Recommendation**, **Inference**, or **Unverified**. Existing tests were inspected, not executed. No database, API server, container or live staging/production environment was contacted. This report is an implementation plan, not a deployment certification.

## 2. Repository and storage findings

### Audit baseline and scope

- Branch: `Delve`, tracking `origin/Delve`.
- HEAD: `d7c871a3ee6b48331a2b3fa36a8b415a1bf4285e`.
- Initial `git status --short --branch`: `## Delve...origin/Delve`; no modified, staged or untracked files. `git diff --stat` and untracked-file listing were empty.
- The only intended repository change is this uncommitted document. No code, migrations, content, assets, configuration or deployment state changed; no subagents, commits, pushes or merges.
- Project memory's startup instructions, summary, structural map and plan were read. Memory writes were deliberately omitted because the audit request permits only this document to change. Discoveries and proposed choices are recorded here, not represented as approved implementation decisions.

### Authority and restart behaviour

| Content | Authoritative representation | Startup/reload behaviour | Destination requirements |
|---|---|---|---|
| Equipment definitions | PostgreSQL `equipment_definitions` | `seedEquipmentDefinitions` inserts missing keys from `content/equipment/equipment.seed.json`; never updates existing keys in production's startup path. Destructive `reset` is a separate test path. | Matching application/schema; imported definition rows; any relative artwork files. |
| Owned equipment | `player_equipment`, loadouts and equipment ledgers | Runtime state; excluded from packages. | Existing production rows stay in production. |
| Managed rarity rules | `equipment_roll_config` draft + published pointer; immutable `equipment_roll_config_revisions` | `bootstrapEquipmentRollRules` creates once from `content/equipment/combatBonuses.json`. Changed shipped legacy content logs drift, never replaces the configuration. | Bootstrapped local configuration and locally published assigned libraries. |
| Managed affixes | `equipment_affix_libraries` drafts; immutable `equipment_affix_library_revisions` | DB services; no shipped-file reseed of managed libraries. | Imported library rows/revisions, destination assignments. |
| Legacy flavour affixes | `content/equipment/affixes.json`, loaded catalogue | Reloaded from shipped disk content; read-only legacy views in managed editor. | Same legacy keys/suffixes and compatible file. This catalogue is separate from rarity rules' frozen legacy combat-bonus block. |
| Enemies | `combat_enemies` rows, including local artwork UUIDs | `seedCombatEnemies`: insert missing; update untouched seeded rows when Git changes; preserve edited rows; adopt rows matching shipped JSON again. Custom rows and removed shipped keys are retained. Artwork UUIDs are excluded from portable hash and preserved by seeding. | Enemy rows, both full-art/sprite asset rows and files, or shipped fallback paths. |
| Dungeons | `dungeon_definitions` drafts/pointer; immutable `dungeon_revisions`; runtime `dungeon_runs` | Current authored dungeons are **not seeded**. Startup validates open dungeons. Migration 0059 retires earlier zone/run tables to prototype names; `content/dungeons/zones.json` is not a seed for current authored dungeons. | Imported draft, local dependencies, validated published revision, enabled state for new runs. |
| Modern dungeon loot | `dungeon_loot_tables`, events; published revision `reward_snapshot` | DB-managed; publish freezes reward evidence and eligible candidate pools. | Tables imported/reused/copied and global item/equipment/currency dependencies present. |
| Shared legacy boss/expedition reward tables | `reward_tables`, defaults in `content/{bossRewards,expeditionRewards}.json` | Seed updates only untouched rows; preserves edits, like enemies. | Correct destination `expedition` table IDs and valid nested selectors/items for legacy dungeon rewards. |
| Events, text puzzles, flags, species pools | Embedded in dungeon draft/revision JSON | Travel with definition. Run/player progress does not travel. | Same engine version and referenced global content. |
| Scene Sprites | `dungeon_scene_sprites` plus managed asset UUID; revision `scene_sprite_snapshot` | DB-managed; publish freezes catalogue visuals. | Sprite definitions, destination asset bindings and bytes. Current package path refuses placements. |
| Species/items | Version-controlled core/expansion JSON, loaded content; seeded `species`/`items` rows | `seedContent` upserts mutable fields and **disables DB slugs absent from loaded JSON**. Species artwork preflight can disable/drop unavailable artwork-dependent content. | Deployed JSON/expansion configuration, assets and successful reload/seed. DB-only insertion is not a durable deployment strategy. |
| Species acquisition policy | DB species flags + loaded JSON `dungeonAccess` + current published dungeon `speciesPolicies` | Destination live policy remains authoritative. Draft policy authorizes nothing. | Enabled species; compatible central policy and dungeon-owned terms; acquisition ledger remains local. |
| Regions/progression currencies | Regions: code IDs plus loaded region JSON; currencies: `progression_currencies` | Region IDs are closed code vocabulary/DB checks. Currency definitions are DB metadata, distinct from player balances. | Compatible region release/content and enabled currency rows. Neither is created by dungeon import. |
| Managed artwork | `artwork_assets` metadata + `artwork_asset_events`; bytes in `MANAGED_ASSETS_DIR` | Neither file bodies nor asset UUIDs are reconstructed from a JSON content export. | Both local database metadata and persistent stored bytes. |
| Shipped artwork | Files under `ASSETS_DIR`/`assets/`, appearance asset resolution | Served/read from disk; not part of current equipment/enemy/dungeon JSON packages. | Same relative file tree and appearance assets at destination. |

Source anchors: `src/index.ts:481–577,994–1080,1273–1296`; `src/modules/equipment/seed.ts:1–110`; `equipmentRollRulesService.ts:144–225`; `src/modules/enemies/enemyStore.ts:1–25,148–201`; `src/modules/content/seeder.ts:14–108`; `loader.ts:134–210`; `src/modules/dungeons/dungeonSpeciesPolicy.ts:1–35`; `src/modules/locations/regions.ts:1–50`.

### Schema evidence

Existing migrations relevant to portability were inspected; **none were run**:

- `0045_equipment_foundation.sql`, `0046_equipment_rolled_instances.sql`: definitions versus owned rolled instances/import history.
- `0054_artwork_assets.sql`, `0055_combat_enemies.sql`, `0058_boss_artwork_assets.sql`: asset metadata/file separation, central enemies and artwork categories.
- `0059_dungeon_overhaul_foundation.sql`, `0061_dungeon_import_history.sql`: authored drafts/immutable revisions and durable request receipts.
- `0062_dungeon_loot_tables.sql`, `0063_dungeon_reward_snapshots.sql`, `0065_dungeon_events.sql`: loot catalogue, frozen reward dependencies and event state.
- `0066_dungeon_scene_sprites.sql`, `0067_dungeon_scene_sprite_snapshots.sql`, `0068_dungeon_encounters.sql`: sprite catalogue/snapshots and acquisition ledger.
- `0071_equipment_managed_rules.sql`: singleton config, library drafts/revisions, immutable revision triggers and audit events.
- `0072_equipment_definition_roll_policy.sql`, `0073_equipment_catalogue_admin.sql`: high-rarity authoring fields and integer definition revisions. Latest checked-in migration is 0073; live applied versions are unverified.

Current schema anchors: `src/db/schema.ts:2625` (`equipmentDefinitions`), `:2748` (`playerEquipment`), `:3101–3230` (managed rules/libraries), `:3415–3525` (dungeons/revisions/events), `:3553` (loot), `:3752` (runs), `:3883` (species acquisitions), `:3988` (assets), `:4105` (enemies), `:4249` (Scene Sprites). Some old source comments describe earlier phase boundaries; executable schemas/services take precedence.

## 3. Existing import/export inventory

HTTP paths below have the `/api/v1` prefix registered by `src/api/server.ts:312`. Source route literals omit it.

| System | Service/format | Existing API and Portal |
|---|---|---|
| Equipment | `createEquipmentPromotionService`, `createEquipmentCatalogueService`; `waifumon-equipment` v3, reads v2/v3 | `/admin/equipment/export`, `/import/preview`, `/import/apply`; `EquipmentCataloguePage`, `EquipmentDefinitionEditorPage`, `EquipmentImportPage`. Full, filtered and selected export. |
| Rarity rules | `createEquipmentRollRulesService`; `waifumon-equipment-roll-config-export` v1 | `/admin/equipment/rarity-rules/{draft,published,export,import/preview,import,validate,preview,publish,rollback,revisions}`; `EquipmentRarityRulesPage`. |
| Managed library | `createEquipmentAffixLibraryService`; `waifumon-equipment-affix-library` v1 | `/admin/equipment/affix-libraries`, per-key draft/preview/publish/export/revision operations and library import; `AffixLibrariesPage`, `AffixLibraryEditorPage`, `AffixLibraryImportPage`. One library per file. |
| Enemy Catalogue | `createEnemyCatalogueService`; export wrapper containing `waifumon-combat-enemies` document | `/admin/enemies` CRUD, `/validate`, `/reference`, `/export`; `EnemiesListPage`, `EnemyCreatePage`, `EnemyEditorPage`. No package-import endpoint/page. |
| Artwork | `createArtworkAssetService`, `createLocalArtworkStorage` | `/admin/artwork/assets` upload/list; `/:id/file` read/replace; metadata/enable/delete/references. `adminArtwork/AssetField` reused by enemy editor. Individual raw-file upload/download, no bundle transport. |
| Dungeon | `createDungeonContentService`, `createDungeonImportService`; `waifumon-dungeon-package` v1–v4 | `/admin/dungeons/definitions/:key/export`, `/import/plan`, `/import/apply`, per-key `/import-history`; existing `adminDungeons` editor/import review, validation, sandbox, publication and rollback. |
| Legacy shared reward tables | `createRewardTableService.export/planImport/applyImport` | Existing `adminRewardTables` surface; exports by kind, revision-checked additive import. Modern dungeon tables are distinct and travel inside dungeon packages. |

Evidence: `src/api/routes/v1/admin/{equipment.ts:555–630,equipmentManaged.ts,enemies.ts:230–335,artworkAssets.ts:246–385,dungeons.ts:776–834,1089–1125}`; `src/modules/rewardTables/rewardTableService.ts:524–585`; Portal clients `portal/src/api/admin{Equipment,EquipmentRules,EquipmentAffixes,Enemies,Dungeons,ArtworkAssets}.ts`. Existing clients use `/v1` beneath their `/api` base; preserve that convention.

## 4. CP-1 — Equipment Catalogue assessment

### What is complete

`equipmentPackage.ts` parses strict, key-identified definitions, rejects numeric IDs/unknown fields/duplicate keys, and builds sorted exports. Full export reads **all rows**, not just rewardable rarities or enabled definitions (`equipmentImportService.ts:261–269`). Thus N/R/SR/SSR/UR/LR and disabled definitions are included. EX is deliberately unauthorable (`vocabulary.ts:113` onward): a manually inserted DB-only EX row could be exported but would fail normal import; do not interpret SQL's wider rarity check as portable authoring support.

All authorable fields round-trip through `definitionInputFromRow` and `definitionColumnValues` (`definitionSchema.ts:181–230`): key, name, description, slot, rarity, multiplier min/max/step, secondary effects, primary-SP eligibility, bonus maximum, tags, region, artwork path, enabled, shop regions, buy price and currency. Secondary effects must currently be empty. Numeric DB IDs, revisions, timestamps, ownership, loadouts and grant history intentionally do not travel.

Version 2 packages remain readable, defaulting `primarySpEligible=false` and `maxAdditionalBonuses=null`; v2 explicitly carrying either v3 field is refused. Version 1 is refused with re-export guidance (`equipmentPackage.ts:44–159`). Importing old v2 definitions over high-rarity v3 definitions can therefore reset these policies to defaults; preview the changed fields.

The Catalogue applies its own availability policy before planning: **new rows start disabled; existing rows retain destination enabled state**, regardless of the package value. Preview reports overrides. Enabling remains a separate action with revision checks and reward-impact acknowledgement (`equipmentPackage.ts:220–256`; `equipmentCatalogueService.ts`, `create/update/setEnabled/previewImport`). This meets reviewed deployment safety; it is intentionally not an exact copy of staging activation state. The lower-level promotion service without `catalogueDefaults` can honour package enabled values; the Admin Catalogue always opts into the safer defaults.

Apply validates the whole package, locks existing rows, recomputes the plan and reads published roll rules within one transaction. It updates by existing row ID, inserts missing keys, writes import/admin events, and never deletes omitted rows. Slot/rarity changes are rejected if **any** instance exists, including removed copies. A new-key race rolls back with a clean conflict. Unchanged definitions are not rewritten, although a repeated import creates another import-log row (`equipmentImportService.ts:180–305`; `equipmentPackage.ts`, `planEquipmentImport`).

Owned `player_equipment` rows and saved rolls/bonuses remain intact. Definition names/descriptions/artwork are live metadata, so changing the base name can change a copy's displayed name; preserving rolls does not freeze the entire definition. See `equipmentQueries.ts:100–134` and `equipmentService.ts:680–695`.

Preview `planHash` covers adjusted input plus destination revisions/copy counts/absence. API apply requires it; stale catalogue edits/creates or copy-count changes refuse the entire import. Rules are revalidated at apply, but the plan hash **does not bind the published rules revision**. A rules-only edit may leave that hash unchanged; if incompatible it is refused by fresh validation, if compatible it can apply without requiring another preview (`equipmentPackage.ts`, `importPlanHash`; `equipmentImportService.ts:187–194`). Treat this as the precise scope of preview freshness, not a rules-version pin.

### Dependencies and artwork

- Region/shop-region strings must belong to `isRegion`'s code vocabulary; an unknown region is an error. This does not verify that matching region content is enabled in the destination. A region newly introduced by code requires a compatible build/schema/content release.
- Tags are bounded free strings, not foreign keys to a tag catalogue. A previously unseen tag is accepted. Definitions have no item-ID or affix-library assignment field; an unexpected `item`/library field is rejected by the strict schema rather than resolved.
- SSR/UR/LR roll-policy feasibility is checked against available published rules for enabled definitions. Import does not install those rules/libraries. Disabled new definitions still need valid rules before future random grants/enabling.
- `artworkPath` is syntax-validated as a relative image path; bytes/existence/checksum are not exported or verified by import. The editor's artwork picker is rooted at `equipment/`, but a syntactically safe authored path is not proof of destination file availability. No managed asset UUID field is present on an equipment definition (`definitionSchema.ts:33–95`; admin `equipment.ts:69`).

### Exact gaps

1. **Zero-match filtered export exports everything.** `equipmentCatalogueService.ts:793–795` passes `keys: []` after an empty filter; `equipmentImportService.ts:263–265` treats an empty key list as no restriction. Fix the distinction between omitted scope and explicitly empty selection; do not turn an empty result into a full package. Selected nonexistent keys are also silently omitted by the query; report them or reject rather than imply every requested key was exported.
2. **Accepted catalogue sizes exceed import transport capacity.** `EQUIPMENT_PACKAGE_MAX_DEFINITIONS=1000`, but equipment routes set no larger `bodyLimit`; they inherit **64 KiB** (`src/api/server.ts:52,122`; admin `equipment.ts:585–630`). A valid large export can receive HTTP 413 on import. Align bounded preview/apply limits with the supported package capacity, including request-wrapper overhead. This is a confirmed code constraint, not evidence that today's live catalogue exceeds it. The checked-in seed has 30 definitions and is about 14 KB on disk.
3. **Artwork is an external prerequisite without a package readiness check.** Keep JSON-only definitions if artwork ships in the assets release, but show missing paths explicitly. If equipment artwork must also be independently deployable, reuse CP-3's asset transport later; that is additional scope, not a missing definition field.
4. **Scale guard:** export does not itself enforce the parser's 1,000-definition ceiling. If the DB grows above it, a full export can be unreadable by its own importer. Export should refuse clearly or partition explicitly; no silent truncation.

**Classification: minor improvements needed.** Skip rebuilding CRUD, v3, selection UI, revision checks, enabled-state policy and instance protection. Core definition transfer is already usable within its current limits and with artwork predeployed.

## 5. CP-2 — Affix libraries and rarity rules

### Existing lifecycle and portability

Managed libraries export one saved draft or published revision, including stable library key/name/description and entry key/suffix/slot eligibility/enabled state. Import creates a new library or replaces an existing library's **draft**; replacing requires its current destination `expectedDraftRevision`. Source kind/revision are informational. It never publishes or assigns a library (`equipmentAffixLibraryService.ts:553–595`; `affixLibraries.ts:213–278`).

The namespace validator refuses duplicate entry keys and case-insensitive suffix collisions, including disabled entries. `namespaceExcluding` checks shipped legacy entries, other managed drafts/current publications, and historical entry keys from other libraries. Historical suffixes are not reserved in the same way as keys. Library publication validates slot coverage when already assigned; rules publication checks an assigned library exists, is published and covers every gear slot (`equipmentAffixLibraryService.ts:202–251`; `affixLibraries.ts:101–129`; `rollRules.ts:319–328`).

Writes use the shared equipment-configuration advisory lock and local optimistic draft revisions; transactions prevent a refused file leaving an empty created library behind. Reimporting the same document with a fresh destination revision does not duplicate library/entry identities, but **does increment the draft revision and append an audit event even when identical**. Publication refuses an unchanged draft. This is repeat-safe for logical content, not an exact-retry/no-write receipt protocol (`equipmentAffixLibraryService.ts:261–296,449–476,571–595`).

Rarity-rule export carries the complete `RollRules` document: frozen N/R/SR legacy combat-bonus block, SSR/UR/LR rules, library assignments and flat-SP limits. Draft/published exports are distinct. Import validates shape, rejects changes to the destination's frozen legacy block and saves a draft; missing libraries can remain unresolved in a saved draft, but validation/publication fails until repaired. Rules import preview is server-side; individual library import has only Portal file inspection before apply, explicitly disclosed by `AffixLibraryImportPage.tsx:193–195`.

Legacy flavour suffix libraries N/R/SR are **not** managed library exports: `legacyAffixLibraries` presents read-only slices of `content/equipment/affixes.json`, and `legacy*` keys are reserved. The rarity-rule legacy block is combat-bonus configuration, not that flavour catalogue. Therefore complete legacy portability requires the same shipped affix file, and a compatible frozen legacy rules baseline. If the two environments differ in frozen N/R/SR rules, current import rejects the file instead of overwriting production. Do not bypass that check (`rollRules.ts:232–248`; `equipmentRollRulesService.ts:470–500`; `affixLibraries.ts:46–56,164–185`).

### Cross-environment revision handling — already correct

Assignments are `{ mode: 'library', library: '<stable_key>' }`, with **no source library revision number** (`rollRules.ts:92–103`). Rules publication resolves destination published library facts. Live unpinned grants read the locally published library revision when rolling; publishing a library can therefore change future unpinned grants even without republishing the rules. Source export `revision` is diagnostic metadata, not a destination foreign key.

Delayed production rewards create local pins containing local rules revision and a key-to-local-library-revision map. `pinForReward`, `forGrant` and `affixLibraryForGrant` resolve immutable local revisions and fail closed on missing pins (`equipmentRollRulesService.ts:388–423,665–710`). These pins and revision IDs must **never be copied from staging into production**.

Managed owned copies save their suffix/library in `rolled_properties`; altering a library does not rename those suffixes or reroll copies (`affixLibraries.ts:188–208`). Legacy copies still resolve flavour suffixes from shipped content, so keeping that file compatible matters. Existing production pins/history remain intact.

### Correct import/publication sequence

1. Confirm compatible legacy affix file and frozen N/R/SR rules; compare content hashes, not environment revision numbers.
2. Export intended libraries and rules, explicitly choosing saved drafts or published versions.
3. Preview destination library key/entry/suffix conflicts; import all approved library documents into local drafts, retaining keys.
4. Validate and explicitly publish required local library drafts, yielding destination revisions. With current code these steps are per library.
5. Import the rules document into its local draft using the local draft revision. It can technically be saved before libraries are published; it cannot be published successfully then.
6. Validate rules against destination published libraries and enabled definition roll policies; review the diff; publish explicitly. New rewards get local pins as usual.

Publishing an update to a library **already assigned** in production takes effect for unpinned grants at step 4. A bulk importer must not claim that merely delaying rules publication makes that step inert. Draft import itself remains inert.

### Gaps and bounded changes

- No full/selected **multi-library** export, aggregate namespace validation, atomic multi-draft import or all-in-one dependency review. Several individual imports can partially complete across separate transactions.
- Rules documents do not carry library bodies or expected library content hashes. A matching key with different destination content can pass validation; slot coverage does not prove source equivalence. Add source dependency hashes to bulk review and disclose deliberate use of destination content.
- Individual library import has no authoritative pre-import diff/validation endpoint. Reuse the current validators for a batch plan; keep actual validation under lock at apply.
- Managed routes also inherit the 64 KiB API body limit (`equipmentManaged.ts`, no route override; `server.ts:52,122`), while a library may contain 5,000 entries (`affixLibraries.ts:43`). Large valid exports cannot reliably return through that API. Bound and align transport sizes.
- Rules export hash mismatches are intentionally allowed as `handEdited`, followed by draft validation (`rollRules.ts:459–472`); library v1 has no file hash. Preserve that existing draft-editing behaviour; a new bulk manifest may use strict integrity checks without pretending hashes are signatures.

**Assessment:** bulk multi-library transfer plus dependency-safe review is needed; no substantial cross-environment revision compatibility redesign is needed. No change to owned equipment, revision tables or N/R/SR mechanics is justified.

## 6. CP-3 — Enemy Catalogue and artwork

### What exists

Enemies can be created without any dungeon reference, edited by key with `expectedRevision`, enabled/disabled, duplicated and exported. The DB catalogue is shared by dungeons and Combat Trials. There is no requirement that a newly authored enemy already appear in a dungeon (`enemyService.ts:160–195,489–530`; admin `enemies.ts`).

`EnemyCatalogueService.export()` exports every enemy, disabled included, as portable stats/tags/path/placement definitions. It separately lists environment-local full-art/sprite UUIDs. The Portal downloads only `exported.document` and displays a notice about omitted managed artwork (`enemyService.ts:576–598`; `EnemiesListPage.tsx:85–138`). There is **no selected export argument, direct definition-import service or Enemy Admin import route**. Export is principally a Git promotion format for `content/combat/enemies.json`, not a complete deployment package.

Existing create/update rejects missing/deleted managed UUIDs; disabled assets produce a warning and fall back when rendering. The injected asset service checks metadata, not physical file existence in this validation path (`enemyService.ts:295–313`). Shipped paths are relative path fields; neither export nor CRUD copies them. Runtime full art and sprite have separate references, with placement preserved.

### Exact asset identities

| Term | Meaning | Portable today? |
|---|---|---|
| Artwork asset ID | Environment-local UUID identifying an `artwork_assets` logical row. Enemy `artworkAssetId` and `spriteAssetId` point here. Replace keeps this UUID. | No assumption that the same UUID exists elsewhere is valid. |
| Storage key / stored file path | Private generated key `<category>/<uuid>/<sha256>.<ext>` resolved beneath `MANAGED_ASSETS_DIR`. Not accepted from content authors and not returned as a public filesystem path. | Bytes can be transferred, but destination keys should be generated locally. |
| Shipped artwork path | Authored relative path such as `combat/enemies/alley_bruiser.webp`, resolved under `ASSETS_DIR`. | Same relative tree must exist; JSON alone does not create it. |
| Artwork URL | HTTP access to image bytes, e.g. authenticated `/api/v1/admin/artwork/assets/:id/file?v=<hash>`, or a domain-specific preview/scene endpoint. | Host, access controls, UUID and URL are destination-specific; a URL is not a packaged file. |
| Content artwork reference | Enemy: local UUIDs plus optional shipped fallback paths; dungeon: `{kind:'managed',category,contentHash}` or `{kind:'shipped',path}`. Scene Sprite: catalogue key whose visual uses an asset UUID. | Different systems need different binding adapters. |

`artworkAssetService.upload` inspects bytes, generates a new UUID every time, writes the original accepted bytes and metadata, and cleans up the written file on DB failure. It computes SHA-256 but **does not search/deduplicate by hash** (`artworkAssetService.ts:343–379`). The image is not automatically normalised to WebP on this generic enemy upload path. `inspectImage` accepts still PNG/WebP/JPEG only, at most 8 MiB, edges 8–4096 px, with format signature/decode and pixel limits; rejects SVG/GIF/animation (`imageInspection.ts`). Boss-specific `normalizeBossArtwork` is a separate route behaviour, not a generic asset-store guarantee.

Storage is **both metadata in PostgreSQL and files on persistent disk**, never image bytes in the DB. API image endpoints set data-safe headers/ETags; admin UUID reads require artwork permissions. Enemy editor also uses Dungeon artwork/scene endpoints for previews; do not assume every preview capability is granted by `enemies.read` alone. Bot and API run in the same process and use the same services/root.

### Blockers for independent enemy deployment

1. No standalone preview/apply importer for new or updated enemies.
2. No selected export to isolate ten enemies from unrelated production content.
3. No image bytes, checksummed asset manifest, or per-enemy full-art/sprite bindings in the portable export.
4. No destination UUID remapping/reuse for those bindings.
5. Repeated upload of identical bytes creates duplicate logical assets; hash calculation alone is not deduplication.
6. No all-or-nothing multi-enemy/database/filesystem import, durable retry receipt or coordinated failed-import cleanup.
7. No complete readiness check for destination shipped paths and physical managed files.

Dungeon import can explicitly create **missing referenced** bundled enemies, but cannot update existing enemies, does not carry their managed UUIDs, and refuses decisions for unrelated enemy keys (`dungeonImportService.ts:700–755`). It is not a substitute for CP-3 and cannot import a standalone catalogue of unassigned enemies.

### Smallest complete binary approach

**Recommendation:** a bounded ZIP containing the existing portable enemy definition shape, a small versioned envelope, and actual referenced images with a manifest. Use enemy keys as logical identities; use per-asset logical IDs and SHA-256/category bindings; record placement and explicit null bindings. Create destination UUIDs or reuse exact active category/hash matches, and rebind through existing enemy validation. Never copy source UUIDs or hardcode source URLs/storage keys.

Individual authenticated image download/upload already exists and could be orchestrated by a script, but no current tool combines it with definitions, conflict review and idempotence. That would still require implementing CP-3; it is not a simpler complete existing workflow. Base64-in-JSON would expand images and collide with small JSON limits. ZIP is a reasonable small transport addition, not a new content platform.

Package both full art and sprites plus any authored fallback paths required for faithful rendering. For shipped paths, either require exact-hash predeployed files or bind packaged equivalents to managed assets without writing into read-only `assets/`; disclose the chosen policy. Preserve current format acceptance: a legacy shipped GIF cannot silently become an accepted managed upload. Fail clearly or require an explicit conversion policy.

## 7. CP-4 — Complete dungeon deployment

### Implemented content and package versions

`DungeonDefinitionSchema` contains metadata, regions, settings, entrance, rooms, connections, action sequences, flags, artwork/backgrounds, embedded events/event pools, species pools and dungeon-owned species policies (`content/dungeonDefinition.ts:195–345`). Text puzzles are implemented actions with string answers, case policy, attempt limit, text, solved flag and routing; they are not a proposed feature. Preserve strings/leading zeros and internal IDs. A reward activity can be presented as a chest; there is no need to invent a separate chest content system.

Dungeon bosses use the **same combat wave/enemy-key structure** as ordinary combat (`DungeonActionSchema`, `isCombatAction`, `waveEnemyKeys`). They do not refer to the guild Boss Management `boss_definitions` catalogue. Boss full art/sprites therefore follow the referenced enemy; global boss schedules/definitions/art are not a dependency of an ordinary dungeon boss action.

The implemented WaifuMon pool is **dungeon-local `speciesPools` embedded in each definition**, shared by activities within that dungeon. It is separate from world Region Pools; there is no independently managed global Dungeon WaifuMon Pool catalogue in the inspected pipeline (`content/dungeonEncounters.ts:65–113`). Do not plan transport for an imaginary shared service.

`buildDungeonPackage` chooses the lowest sufficient version (`package/dungeonPackage.ts:228–286`):

- v1: legacy graph/rewards, portable bundled enemies, external shared table keys.
- v2: modern reward bundles, bundled dungeon loot tables and frozen reward evidence/candidate manifests.
- v3: events and reachable required inventory-item evidence; nullable reward snapshot for reward-free events.
- v4: encounters/species pools, required species/capture-item evidence, dependency hash and whole-package integrity hash.

The current maximum is v4, but not every export uses v4. Readers support all four. Older envelopes cannot smuggle events/encounters, hashes/manifests are recomputed, and **any Scene Sprite placements cause export/read refusal**, regardless of version (`dungeonPackage.ts:409–412`; `dungeonContentService.ts:1577`). Do not remove this safety gate until sprite definitions and immutable visuals can be transported correctly.

Draft exports resolve current loot dependencies; published/numbered exports retain the revision's immutable reward snapshot, including table bodies no longer in the current catalogue. They still read the **current enemy catalogue** for bundled enemies and destination export-time species policy; publication does not freeze enemy definitions in the dungeon revision. Exporting a published dungeon therefore does not reproduce the dependency snapshot of an old active run (`dungeonContentService.ts:1528–1605`).

### Traversal and conflict handling

`dungeonDependencies` walks all combat/boss waves and weighted candidates; dungeon/room artwork; reachable event art; modern reward sites and loot-table references; regions and currencies. `resolveDungeonRewardDependencies` then traverses referenced table bodies and equipment selectors/item requirements, producing candidate metadata and a snapshot. `dungeonRequiredItems` walks reachable event requirements; `encounterDependencyRequirements` walks reachable named/pool encounters and explicit charms, excluding unused species pools from required manifests. Authored unused pools/events remain in the definition rather than being silently stripped.

Plan/apply exposes new/different/identical dungeon content; missing/bundled/identical/different/unverified enemy content; per-table create/reuse/copy decisions; missing items/species/charms and equipment candidate drift. It does not delete unrelated content. Existing differing enemies require **explicit `use_existing`** or separate reconciliation; no overwrite option. Conflicting dungeon loot tables can be copied under a new key with references rewritten through ordinary rewards and event branches, or deliberately reused. There is no overwrite of a conflicting shared loot table (`dungeonLootImport.ts:35–121`).

Missing global enemies/tables/regions/currencies and listed modern reward/encounter requirements normally reject apply. Explicit `allowMissingDependencies` permits only enumerated missing-dependency errors to remain in a repair draft; it cannot bypass malformed content, integrity failures or the Scene Sprite gate. Publication revalidates independently. Disabled enemies/regions/legacy tables and missing artwork often remain **warnings**, not fatal completeness failures (`dungeonImportService.ts:255,788–805`; `validation/dungeonValidation.ts:493,559,607–621`).

### Publication and run preservation

- New imports create disabled, unpublished drafts. Imports do not create a published revision or grant player rewards.
- Replacing an existing dungeon using **v2/v3/v4** sets `enabled=false` and `publishedRevisionId=null`, even when source content otherwise matches a currently published destination. The plan lists activation/publication changes. This withdraws new-run availability until reviewed publication/enabling; old revision rows remain.
- Legacy v1 replacement updates the draft and preserves the existing enabled flag/published pointer. Do not describe these behaviours as identical (`dungeonImportService.ts:534–546,814–846`).
- Apply uses local expected revision + a hash of package/reviewed target dependency facts; locks and replans, writes content/dependency creations/receipt/audit in one transaction. Exact request replay returns the original receipt; reusing a request ID with different actor/package/decisions/plan is refused. New-request identical import is logically unchanged and can append another receipt.
- Publish validates, locks dependencies, creates immutable local revision/reward/sprite snapshots and moves the local pointer. It uses destination dependency resolution, not source revision IDs or an automatic installation of the source reward snapshot (`dungeonContentService.ts:1338–1422`). Rollback validates the target snapshot and current payability.
- Runs retain `dungeon_revision_id`, snapshotted enemy stats/definition paths, resolved artwork UUIDs, reward dependencies and local equipment rule pins (`dungeonRunService.ts:638–678,1446–1473`). Rebinding an enemy row affects new runs, not saved enemy snapshots.
- Ordinary managed enemy/background artwork snapshots retain a **logical asset UUID**, not immutable image bytes. Replacing that asset can change the look of a run. Scene Sprite snapshots have stronger hash-based protection; asset replace/disable/delete is guarded for pinned sprite revisions (`sceneSpriteSnapshot.ts:19–31,88–130`; `artworkAssetService.ts:254–260,390–391,478–479`). Do not replace a shared asset in place as a package-import shortcut.
- Live species policy can tighten during a run; preserved snapshots do not mean imported/published policy has no acquisition effect. In particular, v2+ replacement clears the published pointer, so `publishedDungeonSpeciesPolicies` returns no dungeon-owned terms until republished. An active run relying on those terms can lose permission at its next offer/grant, even though its saved enemy/reward/revision data is unchanged. Central JSON access may still authorize the species. This follows directly from the importer and the policy reader, not from a live-environment test (`dungeonSpeciesPolicy.ts:70–95`; `dungeonRunService.ts:786,1094`).

### What a complete bundle still needs

**Recommendation:** retain the existing definition and loot logic; add a versioned archive wrapper containing required binary artwork, portable enemy artwork bindings, and Scene Sprite definitions/visual evidence. Traverse enemy/boss visuals and scene sprites in addition to existing dungeon/event artwork. For published sprite exports, use the frozen revision snapshot, not today's mutable sprite row. Validate every required byte/hash before declaring the deployment bundle complete.

Equipment may be included as approved CP-1 packages or remain explicit preinstalled dependencies; likewise affix/rule packages should be reviewed through CP-2 rather than activated implicitly. Items/species/regions and their appearance assets should remain declared external release prerequisites unless a separately approved content-authoring lifecycle is designed. DB-only import would be overwritten/disabled by seeding. Legacy shared reward tables need either bundled existing-format exports with explicit approvals or a blocking preflight requiring separate transfer.

The desired flow can then remain: author → validate content and dependency closure → export → upload/review destination additions/updates/conflicts/missing dependencies → import to draft → validate → explicit existing publication/enabling. Keep incomplete repair imports distinct from an asserted **complete** bundle; a complete bundle must not count missing art as success. No weakening of the existing publish, acquisition or snapshot checks is necessary.

## 8. Dependency and artwork handling

Categories: **1** embedded; **2** independently exportable; **3** stable key verified at import; **4** environment-local asset ID; **5** omitted/unsupported. A dependency can have several properties, e.g. portable enemy definition but omitted managed artwork.

### Concrete shipped example: Service Tunnels

`content/dungeons/examples/service_tunnels.dungeon.json` is a real v1 example with **five rooms and seven connections**. Its references trace as follows:

| Dependency | Classification | Current destination resolution |
|---|---|---|
| Graph, ordered room activities, `valve_opened`/`found_keycard`, routing, editor positions/notes | 1 | Embedded; validator checks IDs/routing/flags; layout is transported separately from gameplay hash. |
| `alley_bruiser`, `discord_lurker`, `scrapheap_colossus`, `scrapyard_drone`, `security_automaton`, `suspect_slime` | 1, 2, 3 | All six portable definitions bundled and hashed. Create missing only with approval; keep differing destination enemy explicitly. Includes every weighted guard-pool candidate, not just a sampled enemy. |
| Boss action `colossus` | 1, 3 | Refers to enemy `scrapheap_colossus`; no global boss definition lookup. |
| Background `encounters/door_within_door.webp` | 5 (path declared) | Referenced in `assets`; destination file checked, missing is warning. No bytes. |
| Full art for `alley_bruiser`, `scrapyard_drone`, `security_automaton` | 5 | Paths inside bundled enemy definitions; importer checks those paths separately. No bytes. Other bundled enemies have null artwork paths. |
| Source managed enemy full-art/sprite overrides, if attached later | 4, 5 | Not part of portable enemy shape; not included in package asset closure or reproduced from these paths. |
| `dungeon-scrapheap-cache-v1`, `dungeon-scrapheap-boss-v1` | 2, 3 | External `expedition`-kind `reward_tables` entries; v1 package does not contain their bodies or source hashes. Separate Reward Tables export/import exists. |
| Nested cache reward selectors | 3, 5 | Checked-in table has N/R weights 90/10; destination table body and eligible enabled gear determine actual payout. Definition list/rules/art are not carried by v1. |
| Nested boss reward selectors | 3, 5 | Checked-in table has N/R/SR weights 55/40/5; same destination validation/eligibility caveat. |
| `flaccid-foothills` | 3 | Destination loaded region availability checked; definition not installed. |
| `ascension_currency` | 3 | Destination currency metadata checked; balances/ledger excluded. |

Supporting source: `content/expeditionRewards.json:3562–3605`; `dungeonDefinition.ts:408–457`; `dungeonImportService.ts:322–417,492–558`. The four explicit artwork files above **exist in this checkout**, verified read-only. That establishes neither production availability nor managed-artwork equivalence. The example has no event, puzzle or species encounter; it is not evidence that a complete modern deployment fixture is shipped.

### Modern extensions and remaining external requirements

| Content/dependency | Classification | Behaviour |
|---|---|---|
| Inline rewards/event choices/checks/outcomes/pools | 1 | Entire authored JSON is retained. Internal references validated; rewards visited across reachable branches. |
| Dungeon loot tables | 1, 3 | v2+ bundles carry bodies, source revision/tier/metadata evidence; create/reuse/copy with hash comparison. Source DB IDs are not installed. |
| Items inside loot and event requirements | 3; metadata evidence 1; authoritative definition 5 | Destination existence/enabled/cap rules checked. No item definition installation. |
| Equipment selector candidate lists | Evidence 1, definitions 2/3 | Source candidates preserved for review; destination eligibility recalculated and drift reported. Export does not contain the full definitions/rarity rules/libraries. |
| Puzzle answer strings, attempts, solved flags, conditions | 1 | Embedded; schema/semantic validation. Existing player flag values are production runtime state, not dependencies to copy. |
| Embedded species pools and dungeon-owned `speciesPolicies` | 1 | Included in draft/revision; separate from Region Pools. Destination publication authorizes local policy. |
| Required species and explicit capture items | 3, 5 | v4 evidence compares policy/rarity and checks capture compatibility. Actual global definitions not imported. Central policy is not overwritten by export evidence. |
| Species portraits, default appearances and Buddy sprites | 5 | Resolved from destination shipped appearance/species assets, not included in `assets` manifest. Missing default artwork can make species unavailable during content preflight. Buddy artwork is destination player/world content. |
| Dungeon cover, dungeon/room backgrounds, reachable event art | Reference 1/3; bytes 5 | Managed references use category/hash; shipped use paths. Missing art warns. |
| Enemy/boss full art, transparent sprites and placement | Definition paths/placement 1; local IDs 4; bytes/bindings 5 | Managed bindings omitted; same portable enemy hash does not imply visual equivalence. |
| Scene Sprite instances/catalogue and frozen visuals | Instance structure exists, catalogue IDs 4, packaging 5 | Current explicit gate refuses package export/import. No fallback to dropping placements is acceptable. |

Dungeon managed references are more portable than UUIDs: `resolveManagedArtworkIds` chooses the oldest active exact category/hash match, otherwise a local asset that replaced those bytes per its event history (`managedArtworkLookup.ts`). Imports verify file existence when storage is configured and warn on replacement/unverified storage. Historical replacement lineage is local and **not exported**: the same reference can resolve differently elsewhere. Complete bundles must bind/verify exact intended bytes rather than silently relying on destination replacement history. Names and storage paths alone are insufficient identities.

## 9. Gap matrix

Here “full” means the requested authored logical scope, including required artwork where applicable. “Production-ready” means the complete independent deployment requirement, not general CRUD quality. CP-1 is marked Partial for transport/scope/artwork checks; this does not negate its working definition-only import.

| Content system | Full export | Full import | Binary assets included | Conflict safety | Repeat-import safety | Production-ready |
|---|---|---|---|---|---|---|
| Equipment Catalogue | Partial | Partial | No | Yes | Yes | Partial |
| One managed affix library | Yes | Partial | Not applicable | Yes | Yes | Partial |
| All managed libraries together | No | No | Not applicable | Not applicable | Not applicable | No |
| Complete rarity-rule document | Yes | Yes | Not applicable | Yes | Yes | Yes |
| Legacy N/R/SR flavour affix catalogue | No | No | Not applicable | Not applicable | Not applicable | No |
| Standalone enemies with artwork | Partial | No | No | Partial | No | No |
| Complete dungeon | Partial | Partial | No | Yes | Yes | No |

Evidence for every row:

- Equipment: full-row/selected export and atomic no-op imports in `equipmentImportService.ts:180–305`; empty-filter scope in `equipmentCatalogueService.ts:793–795`; strict full fields in `definitionSchema.ts`; inherited 64 KiB in `server.ts:52,122`; artwork is only a path. Conflict safety covers requested local definitions, not an automatic semantic collision resolution.
- Single library: `equipmentAffixLibraryService.ts:261–296,553–595` and `affixLibraries.ts:43,213–278`: full document, locked draft replacement, stable keys; Partial import/readiness reflects 64 KiB transport versus 5,000-entry schema, plus no authoritative pre-import preview. Repeat safety means no duplicate identities, not unchanged audit/revisions.
- Multi-library: `EquipmentAffixLibraryService` interface `:121–145`, routes in `equipmentManaged.ts` and `AffixLibrariesPage.tsx` expose only individual files/operations; no batch lifecycle.
- Rarity rules: `rollRules.ts:406–472`; `equipmentRollRulesService.ts:470–500,555–592,648–662`. Yes is conditional on compatible frozen legacy baseline and locally published library prerequisites; assignments are portable keys. This row does not claim it bundles those libraries or flavour affixes.
- Legacy flavour affixes: `affixLibraries.ts:164–185`, reserved keys `:46–56`, and `loader.ts:1249–1253`: file deployment/read-only views, not managed package import/export.
- Enemies: `enemyService.ts:134–150,160–195,576–615`; admin `enemies.ts` CRUD/export only; `artworkAssetService.ts:343–379` creates a UUID per upload. Partial conflict safety describes individual CRUD revisions, not a nonexistent importer.
- Dungeons: `dungeonPackage.ts:96–164,228–286,409–412`; `dungeonImportService.ts:638–891`; `dungeonLootImport.ts`; artwork warnings at validator `:616–621`. Strong transaction/retry safety coexists with omitted assets/global definitions and the sprite refusal.

## 10. Four deployment scenario walkthroughs

### A — Five equipment definitions, owned SR and disabled SSR

Use selected export in `EquipmentCataloguePage`; API accepts comma-separated keys and exports v3. The updated SR and disabled SSR are both exportable. Production preview matches stable keys, shows create/update/unchanged and changed fields, and overrides availability: new definitions disabled, existing definitions keep production's flag. A disabled staging SSR does **not** disable an enabled production SSR; an existing disabled production SSR stays disabled.

Apply with the preview hash updates the SR row in place, retaining its local ID. Existing copies keep saved multiplier, affix key/suffix snapshot, bonuses, rolled properties, upgrade/loadout state and grant identity; metadata may display the new base name. An SR slot/rarity change with any historical instance rejects **all five**. Changed range affects later rolls only. Missing artwork path files are not transferred or rejected. A stale preview aborts atomically; exact content reimport leaves definitions untouched but logs another import. Unmentioned production definitions remain unchanged. Evidence: CP-1 source paths and `tests/integration/api/adminEquipmentCatalogue.test.ts:412–490` (inspected coverage).

### B — Shared library and SSR/UR rules with different local revisions

Current workflow exports one library file plus one full rules file, not a combined deployment. Import the library into a local draft with its local expected revision, resolve suffix/key collisions, validate and publish it. Import rules into their local draft, verify both SSR and UR assignments resolve to that library key, validate definition compatibility/slot coverage and publish. Production might create library revision 12/rules revision 8 while staging used 3/5; correctness depends on keys and bodies, not equal numbers.

Rules can be staged earlier as an unresolved draft. Neither import activates it. Library publication can immediately affect an already assigned production library's future unpinned rolls, so review that separately. Old owned suffix snapshots and delayed production pins keep their saved values/revisions. Reimport does not duplicate entries but writes another draft revision. A frozen N/R/SR mismatch blocks rules import. What is missing is bulk review/atomic staging of multiple libraries and source-content hash comparison, not destination revision translation.

### C — Ten new enemies, all with artwork, none assigned to a dungeon

Creating them in staging succeeds independently. Full enemy export contains their portable definitions along with all other enemies; selected export is unavailable. The API wrapper lists omitted asset UUIDs; the downloaded `enemies.json` does not carry those UUIDs or images. Production has no Enemy Catalogue package upload/preview/apply operation.

Promoting JSON through Git and seeding could create new rows, but cannot recreate their managed artwork, and edited existing production enemies are deliberately preserved by seed divergence rules. Individual production uploads/CRUD could reconstruct them manually, but that violates the desired workflow. Dungeon import cannot be used without inventing dungeon references and still omits their managed art. **The requested scenario fails today.** CP-3 must provide standalone selected/all definitions plus binary bindings, conflict review and repeat-safe import. Unrelated production enemies must be omitted from an approved subset and preserved.

### D — Complete modern dungeon

This is a code-path trace of a representative composition, not a claim that the shipped Service Tunnels example already contains every feature or that live production was exercised.

| Requested feature | Source export and destination outcome |
|---|---|
| Multiple rooms, canvas connections and sequences | Definition/layout retained with stable IDs; importer validates and prunes layout references. |
| Background art | Shipped path or managed category/hash only; destination must already contain matching image/row. Missing image warns and rendering can fall back. |
| Fixed combat and weighted pools | Every wave candidate key is traversed, portable definitions bundled. Missing enemies may be created; existing different ones require deliberate reuse or separate CP-3 update. |
| Boss | Same enemy pipeline; no implicit import of global boss definitions/schedules/art. |
| Chest reward | A reward activity or event outcome uses a modern bundle/table. Table body is bundled; conflicts copy/rewrite or reuse. Item definitions and equipment catalogue/rules remain prerequisites. A chest Scene Sprite placement causes current package refusal. |
| Event | Embedded choices/checks/outcomes/conditions/pool weights and art refs retained. Every reachable required item and reward branch is analysed. |
| Text puzzle | Answers remain strings; attempts/case policy/text/solved flag/outcome routing carried inside definition. No external puzzle store. |
| Dungeon-exclusive WaifuMon | v4 required-species evidence plus embedded encounter/pool/dungeon policy. Destination species must exist/enabled with art and compatible central access; package never installs the species or its central policy. Dungeon-owned access activates only upon destination publication. |
| Equipment/items/currencies | Destination global definitions verified; equipment candidate changes disclosed. Deploy CP-1/CP-2 and shipped species/item/region assets before expecting equivalent content. Legacy shared table bodies require separate transfer if still used. |

This composition exports v4 if encounters are present and no Scene Sprites are placed. Import to a new dungeon creates a disabled unpublished draft; complete dependency failures refuse apply unless explicit repair-mode exceptions are chosen. Missing artwork alone does not force repair mode. Review, validate, publish and enable through existing lifecycle. Replacing an existing v4 dungeon first withdraws its publication/new-run availability as described above. Active production runs retain their historical revision/snapshots, with the ordinary-art/live-policy qualifications already documented.

## 11. Security and persistence risks

### Existing importer safety

| Case | Equipment | Managed configuration | Dungeon |
|---|---|---|---|
| New content | Keyed creates, Catalogue-disabled | New library draft; rules require local singleton | Disabled/unpublished draft; approved missing dependency creations |
| Changed content | Whole-definition reviewed update, no deletes | Explicit local draft replacement | Explicit draft replacement; separate dependency choices |
| Identical/repeated | No definition write; new log | No duplicate identity; draft revision/event advances | No draft write where identical; exact request replays original receipt |
| Identifier conflict | Duplicate keys refused; slot/rarity locks for copies | Namespace/suffix/reserved-key errors | Stable-key diffs; never overwrite existing enemy/loot implicitly |
| Missing dependencies | Static region validation; rules recheck; art not checked | Draft can reference missing libraries; publish refuses | Errors with enumerated incomplete-draft escape; art/disabled content may warn |
| Concurrent edits | Plan hash + locks + key-race rollback | Shared config lock + expected draft revision | Plan hash/revision + advisory/row/table locks + request receipts |
| Invalid file | Strict v2/v3 parse | Strict envelope/schema/namespace; rules hand-edit hash warning | Strict version/content/integrity/manifest validation; depth/node bounds |
| Partial failure | One DB transaction incl. audit | One DB transaction per file, not across files | One DB transaction incl. approved creates, receipt and audit |
| Already published | Availability preserved locally | Import affects draft only; publish is separate | v2+ replacement clears pointer/disables; v1 retains current publication |

Enemy CRUD has optimistic revision/key/validation safety but **no importer** to assess for package failures. Generic single-image upload uses write-then-rename and cleanup on transaction failure; no multi-file transaction or retry deduplication exists. A process crash between file creation and DB insertion can still leave an orphan, so exception cleanup is not a complete crash-recovery protocol.

Existing security conventions to reuse: authenticated Portal permissions/CSRF/actor attribution (`portalPermissions`, API server); schema validation, bounded route-specific bodies, root-contained asset resolution, server-generated storage keys, image magic/decode limits, transactional audit/retry receipts. Dungeon parsing limits nesting to 64 and nodes to 200,000 (`dungeonImportService.ts:197–230`). HTTP/proxy limits must agree: dungeon imports have 2 MiB in Fastify and nginx; artwork routes have 8 MiB API/9m nginx; equipment and managed config remain at 64 KiB API with no special nginx location. JSON-only tests against services would not reveal these HTTP limits.

### Archive requirements — recommendations, not existing protections

No ZIP importer was found in these pipelines. Before accepting archives:

- Limit compressed bytes, entry count, total expanded bytes, individual entries, compression ratio, JSON depth and image pixels; enforce limits during streaming/decompression, not after full extraction.
- Reject absolute paths, `..`, backslashes/drive paths, NULs, symlinks/hardlinks, duplicate canonical paths and unexpected entries. Do not extract user paths into `assets/` or the managed root. Generate destination storage keys through `ArtworkStorage`.
- Validate manifest identity uniqueness, binding targets and hash/size consistency against **actual bytes**; reject conflicting duplicate logical assets. Deduplicate compatible category/hash bytes while retaining required separate binding roles. Never fetch remote URLs from the package.
- Reuse `inspectImage`; do not trust extension or MIME alone. Define an explicit policy for legacy shipped formats outside managed PNG/JPEG/WebP support.
- Authorise enemy/dungeon writes and artwork creation independently through existing permissions; source actor metadata never controls destination audit identity.
- Stage files privately, validate before mutating gameplay content, and make final content/asset-row/receipt writes transactional. Track only newly created files for failure cleanup; never delete a reused/shared production asset. Plan for interrupted imports/orphan cleanup and concurrent identical asset imports, not just caught exceptions.
- Compare all reviewed local revisions and asset hashes/status/file availability again at apply. New packages must not mutate shared assets in place, weaken pinned sprite guards or silently change unrelated content.
- Keep hashes as integrity/equivalence evidence, not authentication. An authorised edited draft can be valid without being cryptographically signed.

### Container persistence and environment assumptions

`docker-compose.yml`, `Dockerfile`, `portal/Dockerfile` and `portal/nginx.conf.template` establish the repository's deployment contract:

| Location | Persistence and portability |
|---|---|
| Bot image | Compiled code, migrations and a copy of `content/`. **No shipped `assets/` copy**; assets are mounted. Rebuilding code is not content transfer between databases. |
| `./content:/app/content` | Host bind, writable. Masks the image's content copy; host checkout/content release controls files. Changes survive image rebuild if host files survive. |
| `./assets:/app/assets:ro` | Host bind, read-only. Identical relative paths resolve identically only when both host trees contain the required files and matching configuration. |
| `waifumon-pgdata` | Persistent PostgreSQL state, including content drafts/revisions and player state. |
| `waifumon-managed-assets:/data/waifumon-assets` | Persistent uploaded files. Must be backed up with asset metadata in PostgreSQL; DB-only backup is incomplete. |
| `waifumon-card-cache` / `waifumon-art-cache` | Derived rendering caches, disposable and regenerated. Not source artwork deployment packages. |
| Portal container | Static SPA/nginx; proxies API to bot. It does not need its own artwork mount because API serves bytes from bot storage. |

Imports through existing DB services and artwork uploads take effect without restart; publication/enabling controls gameplay availability. Changes to shipped JSON require the relevant reload/seed path or startup; different systems have different seed authority rules above. Removing volumes (`down -v`), changing Compose project/volume identity, or deploying without equivalent mounts loses access to state even if the image is unchanged. Dockerfile-created directories alone do not confer persistence.

`DEPLOYMENT_ENV` primarily labels exports and gates staging test controls; inspected content services do not implement a separate production/staging content replication path (`src/config/config.ts:223–287,499–512`; `src/index.ts:575–577`). There is one checked-in Compose contract, not proof of matching real deployments. **Unverified:** actual hosts, overrides, mounted roots, volume identity/backups, applied migrations, catalogue counts, permission grants, proxy limits beyond repository nginx, and differing content release hashes. No credentials or live access are required to design/test portability; operational confirmation can be performed separately before rollout.

## 12. Recommended implementation phases

These are proposals requiring implementation approval. Do not start them as part of this audit.

### CP-1 — Small

**Required work:** distinguish empty explicit/filtered scope from full export; report unknown selected keys; bound full export above parser capacity; align route-specific preview/apply body limits with valid packages. Add a destination artwork prerequisite report for referenced paths without changing the definition format or activation policy. Bind rule revision into preview freshness only if rule-change review is required by the approved policy.

**Reuse:** `equipmentPackage`, promotion/Catalogue/definition services, strict schema, plan hash, existing revision/impact UI and APIs. **Migrations:** none expected. **API/Portal:** extend current responses/errors for missing paths and scope issues, use existing import screen; no new pages. **Tests/security:** empty-filter and unknown-key regression; all supported rarity fields/disabled status; real HTTP preview/apply near limits and over-limit refusal; owned SR preservation and all-or-nothing stale/conflict handling. Keep bounded parsing and permissions.

**Acceptance:** exporting five keys returns exactly those keys; zero matches never broadens scope; a supported-size full package can be uploaded through Portal/API; new rows disabled, destination existing status and rolls preserved; missing artwork disclosed. Skip replacing the already-working v3 transport, CRUD and import transaction.

### CP-2 — Medium

**Required work:** a small JSON wrapper for all/selected managed library documents and optional existing rules export; dependency content hashes and shipped legacy catalogue fingerprint; server-side aggregate preview with new/update/identical/conflict states. Validate namespaces against the effective resulting drafts and existing history under the shared configuration lock; import approved drafts atomically. Local expected revisions and fresh plan hash prevent stale review. Preserve old single-library/rules formats and their separate explicit publication.

**Reuse:** `validateLibraryEntries`, namespace rules, current library/rules services, shared advisory lock, admin events, immutable revisions. Factor transaction-aware internal calls only where necessary for one bulk transaction; do not simulate atomicity by looping public services in separate transactions. **Migrations:** none expected for bodies/keys; a durable bulk request-receipt table is optional only if exact retry semantics are approved. Existing admin events can record diagnostic package evidence without a new schema.

**API/Portal:** add bulk export/plan/apply operations to existing catalogue/import views, explicit saved-draft/published selection, per-library diffs and source/destination hash review; align JSON body limits. **Tests/security:** two DBs with different local revision histories; cross-library and historical-key/suffix collisions, stale plans, rejected last library rolls back earlier imports, legacy mismatch, repeat imports/no duplicates, no activation until publication. Show the effect of publishing already assigned libraries.

**Acceptance:** all/selected libraries and rules can be transferred together into drafts; unrelated libraries remain untouched; no source revision becomes a destination FK; dependency publication order is clear; saved equipment and existing local pins are preserved. Skip a revision-translation framework and any redesign of immutable local revisions.

### CP-3 — Medium

**Required work:** standalone selected/all enemy archive; real full-art/sprite bytes and bindings; manifest/hash validation; exact active asset reuse and local UUID remapping; authoritative preview/new/update/identical decisions; atomic approved definition updates, durable repeat handling and coordinated file cleanup. Import must support zero dungeon references. Default new-enemy activation policy should be explicit, preferably disabled until reviewed.

**Reuse:** `EnemyInputSchema`/CRUD validation/revisions, enemy hash/portable shape, `ArtworkAssetService`, `ArtworkStorage`, image inspection, containment, admin audit/permission conventions and dungeon request-receipt pattern. Use a small shared asset manifest/reader that CP-4 can reuse, not a generic entity registry. **Migrations:** no enemy-definition change expected. A small enemy-import receipt table/unique request key is reasonable; assess a scoped category/hash concurrency guard before imposing global asset-hash uniqueness (existing duplicate assets are legal).

**API/Portal:** extend existing Enemy Catalogue with select/export and upload/review/apply, including physical asset readiness; archive body/proxy limits need explicit bounded routes. **Tests/security:** separate DB/root A→B with ten unassigned enemies, update one existing enemy, preserve unrelated rows and active-run snapshots, repeat and concurrent imports without duplicate assets, HTTP permission and unsafe-archive matrix, rollback/crash cleanup. Do not replace destination shared image bytes in place.

**Acceptance:** the ten definitions and all intended art render in B without source access/manual copying, preserving logical definitions/placement; repeated import adds no duplicate enemy/assets; stale review fails atomically; only approved updates occur. Do not accept a dungeon-dependent workaround.

### CP-4 — Large relative to the other phases

**Required work:** archive wrapper over current v1–v4 JSON with recursive dependency closure; reuse CP-3 assets and enemy bindings, add portable Scene Sprite definitions and frozen published visual evidence, handle stable-key conflicts explicitly. Integrate optional CP-1/CP-2 payloads or enforce their declared preinstalled dependencies. Include or block on legacy reward-table dependencies. Make complete-bundle art checks stricter than ordinary repair-draft warnings. Keep species/item/region release prerequisites explicit.

**Reuse:** current package builders/readers, dependency/reward/encounter analysers, loot copy/rewrite logic, plan/apply/receipts, revision/sprite snapshots and existing Portal review/publish lifecycle. **Migrations:** no replacement dungeon revision/run schema expected; archive binding/import diagnostic metadata may fit existing receipt/event JSON. Add a migration only if an approved new receipt/asset bookkeeping invariant requires it. No item/species DB-import lifecycle is included.

**API/Portal:** extend existing export/upload/review views for asset manifest, missing external content, dependency choices and completeness. New archive paths must coexist with unchanged old JSON imports. Keep sprite gate until the new path passes frozen-visual tests. **Tests/security:** complete multi-room fixture including event branches, puzzle, boss, chest/sprite, species pool and equipment; published/draft exports; conflicts/copy rewrites; source assets unavailable after export; active run and player-state preservation; archive failures roll back every new row/receipt and clean only owned files.

**Acceptance:** complete bundle imports as a reviewed draft and resolves intended assets locally, with no hidden missing dependencies; cannot activate content or overwrite unrelated globals implicitly; publication still independently validates/pins destination dependencies; legacy JSON remains readable; Scene Sprite support is added without discarding instances or weakening immutability. Skip rebuilding graph/event/puzzle/species-pool authoring or the existing dungeon lifecycle.

### Shared conventions worth adopting

Reuse each domain's existing `format`/version/body and stable key. A small archive/bulk envelope can add content type, export timestamp, package identity, logical dependency references, source revision/build metadata for diagnostics, file size/hash manifest and explicit import classifications. Use existing canonical hash helpers with an explicit algorithm and clear bare-hex versus `sha256:` encoding. File hashes cover bytes; definition hashes cover canonical parsed content. Local revisions protect concurrent destination writes; source revisions describe provenance only.

Share only binary parsing/validation/storage bindings and a consistent conflict vocabulary (`create`, `update`, `identical`, `conflict`, `missing`, `invalid`, approved reuse/copy). Domain services still decide what is legal. A common asset manifest reduces duplicate CP-3/CP-4 security work. Wrapping every definition in a universal registry or forcing equipment JSON into ZIP adds abstraction without solving a current gap.

## 13. Proposed acceptance tests

### Isolated execution

Use `tests/helpers/globalSetup.ts` and `createTestDb` (`tests/helpers/testDb.ts`): Testcontainers starts disposable PostgreSQL 16 unless an explicitly supplied **test-only** URL is used; helpers create randomly named databases and run real migrations. Instantiate A and B using separate DBs and **separate shipped, managed and cache roots**, extending `createDungeonWorld` as needed. Never share A's artwork root with B or fall back to the repository's real assets in portability assertions. After export, make A's roots unavailable to prove the package is self-contained for its declared scope.

Existing precedents include `dungeonPackageV3.test.ts:230` and `dungeonPackageV4.test.ts:542` with separate database worlds, `equipmentContent.test.ts:227–360`, `equipmentManagedRules.test.ts:337–543`, `enemyCatalogue.test.ts:479–605`, and dungeon rollback/receipt tests. These are useful existing coverage, not proof of missing binary transport. Test source was inspected only; no pass counts are claimed here.

After approved implementation, focused existing suites can be run locally without production, for example:

```sh
env -u TEST_DATABASE_URL npm test -- tests/integration/equipmentContent.test.ts tests/integration/equipmentManagedRules.test.ts tests/integration/api/adminEquipmentCatalogue.test.ts tests/integration/enemyCatalogue.test.ts tests/integration/dungeonImport.test.ts tests/integration/dungeonPackageV3.test.ts tests/integration/dungeonPackageV4.test.ts
```

That uses the disposable-container default. New CP acceptance suites should join the same harness. Add HTTP/Fastify and nginx-facing checks rather than relying solely on service calls; execute Portal review-flow tests separately in its existing harness. No command above was run during this read-only audit.

### Required observable assertions

| Test | Evidence required |
|---|---|
| CP-1 A→B | Export every authorable field across N–LR, disabled SSR included; production IDs differ; exact approved keys/definitions and expected enabled overrides in B. Empty filter returns empty/refusal, never full catalogue. |
| Owned SR | Before/after equality of production owned rows, rolled properties/bonuses/upgrade/loadout/grant state; name metadata changes disclosed; slot/rarity conflict rolls back entire import. |
| Large valid package | Preview/apply through real HTTP within agreed bounds; over-limit structured 413 with no writes; export never produces silently unsupported capacity. |
| CP-2 revision divergence | Seed different revision counts in A/B; transfer shared library + SSR/UR rules; B resolves its own published revision by key. Exported source numbers never become B pins/FKs. |
| Legacy baseline | Identical legacy blocks accepted; differing frozen N/R/SR rules rejected; flavour-affix fingerprint mismatch disclosed without mutation. Existing suffix snapshots and local delayed pins remain unchanged. |
| Bulk atomicity | Last-library collision/invalid entry fails all requested draft changes; unrelated libraries untouched; retry/concurrent import adds no duplicate identities; drafts remain inactive. |
| CP-3 standalone | Ten artwork-bearing enemies with **no dungeon/trial usage** move from A to B; both full art and sprites/placement resolve in B using local UUIDs and exact bytes. |
| Asset idempotence | Repeat/new-request/exact-request and concurrent imports reuse intended active assets; disabled/deleted/hash-conflicting assets do not pass silently; shared same bytes with different roles handled predictably. |
| Enemy update isolation | Explicit update to one enemy, stale revision refused; unrelated enemies untouched; an old run retains saved stats/bindings and new runs see the new definition; shared/pinned assets are never overwritten. |
| CP-4 complete graph | Multiple rooms, connections/conditions, weighted waves, boss, reward chest, all event branches, a leading-zero text-puzzle answer, species pool/exclusive policy and Scene Sprite. Compare logical IDs/order/content after A→B, excluding intended local metadata. |
| Nested dependencies | Table copy rewrites all affected reward/event references; every equipment selector candidate and required item/charm/species is reviewed; unused species pool members are retained but do not become invented requirements. |
| Live policy/publication | Missing/disabled/restricted species/charm fails complete import; explicitly incomplete draft stays repairable but unpublishable on errors. Destination policy controls acquisition; per-player/per-dungeon limits and no draft activation remain. |
| Artwork completeness | Missing cover/background/event/enemy/boss/sprite files prevent a **complete** bundle assertion; actual destination API/presenter render succeeds with A unavailable. Historical replacement aliases cannot substitute unintended bytes silently. |
| Published snapshot export | Change/delete mutable A loot/sprite catalogue after publishing: export uses frozen table/sprite evidence where promised; imports do not copy A runtime pins/player state. Re-publication in B uses reviewed local dependencies. |
| Existing publication | Verify intentional v1 versus v2+ replacement availability behaviour; old revision and active-run rows remain unchanged; no automatic publication/enabling. Assert the live acquisition effect when clearing/reinstating the published pointer removes/restores dungeon-owned species terms. |
| Malformed/hostile archives | Traversal/absolute/backslash/drive paths, symlinks, duplicate entries/IDs, unsupported formats, oversized images, compression bombs, hash mismatches, missing files, extra undeclared files and malformed JSON all fail before content mutation. |
| Fault injection | DB/audit/receipt failure after staged files and mid-import crash: no partially visible approved content, no deletion of reused files, documented orphan recovery; exact retry after commit returns original result. |
| Restart/persistence | Recreate services over B DB/managed root; imported definitions/art still resolve. Exercise seed/reload with changed shipped content to prove expected insert-missing/divergence preservation and global species/item prerequisite behaviour. |

## 14. Decisions requiring approval

No implementation choice below has been approved or applied by this audit.

1. **Approve CP-1's bounded fixes first?** Recommendation: fix empty/unknown selection semantics, supported-capacity/HTTP limits and dependency visibility without replacing v3.
2. **Artwork contract:** should equipment art remain a shipped-release prerequisite? For enemy/dungeon complete bundles, recommendation is actual binary transfer with local managed bindings; decide how to handle legacy shipped fallback paths and formats outside the managed allowlist. Exact approved byte identity should be explicit when replacement history exists.
3. **Managed configuration publication:** retain separate deliberate library/rules publication (recommended). A bulk import creates drafts only; publishing an already assigned library affects unpinned grants immediately. Decide whether review should require source dependency hashes to match or allow explicit destination reuse.
4. **Enemy import availability:** recommendation is new enemies disabled pending review, existing destination status preserved, with explicit approved updates only. Current enemy CRUD honours supplied enabled values, so this would be a new importer policy.
5. **Dungeon updates and availability:** retain current v2+ replacement disable/unpublish behaviour unless a separate lifecycle change is approved. Operators must accept the new-run interruption and possible temporary loss of active-run dungeon-owned acquisition permissions, or import under an explicitly chosen separate dungeon key with reviewed key-dependent policy. Do not silently preserve activation or auto-publish.
6. **External globals:** recommendation is species/items/regions and appearance assets remain a coordinated content-release prerequisite; equipment/affixes use CP-1/CP-2, legacy shared reward tables use existing transfer. Confirm whether “complete dungeon” may declare these verified external prerequisites or must embed optional approved subpackages. Supporting arbitrary new species/items solely via DB import would materially enlarge scope and conflict with current seeding.
7. **Scene Sprites:** a dungeon using them cannot meet the requested complete deployment until frozen sprite definitions/assets are supported. Keep the package gate until CP-4 acceptance passes; do not approve removal alone.
8. **Existing production policy questions:** project memory/release readiness already flags acquisition limits as per player **per dungeon**, not global per species, and narrower activity isolation during runs (`docs/dungeons/phase4-release-readiness.md`; `dungeonSpeciesPolicy.ts:103` onward). These are separate release decisions, not import fixes; portability work must preserve the accepted runtime policy.

Operational facts still needing local deployment verification are volume/root identity, backup pairing, applied migrations and compatible content releases. They do not require production credentials to finish this audit or implement its isolated tests. No deployment, asset copying or implementation phase is authorised by this report.
