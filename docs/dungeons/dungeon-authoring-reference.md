# Dungeon authoring implementation reference

Research baseline: branch `Delve`, HEAD `3ecad453887cbeed0c2d627238c29d0358d3f78c`, 2026-10-15. The working tree was clean before this document was created. This is a technical extraction for the writer of a standalone creator guide, not that guide. Labels below come from the current React controls; where an accessible name differs from visible text, both are identified. Implementation takes precedence over older design and completion documents.

Verification means inspection of frontend, schema, validation, service and runtime source at this commit. It does **not** mean a browser session, Discord playthrough, staging migration or production configuration was tested. Environment-specific state is explicitly **Unverified** in section 7. Source links are repository-relative; section 8 identifies the principal schemas and functions.

## 1. Verified product overview

Delve is the player-facing name for authored dungeons. An administrator authors a directed room graph, with an ordered activity sequence in each room. The dungeon has a mutable draft, a separate map layout and immutable published revisions. Saving preserves work; publishing selects the content for new runs; enabling controls availability. A run stays attached to its starting revision.

The implemented feature set includes:

| System | Implemented authoring and player behavior |
| --- | --- |
| Phase 1 | Dungeon catalogue, draft/revision lifecycle, graph editor, connections, conditions, combat/boss waves, rest, flags, gates, treasure, extraction, daily allowance, Discord traversal, package import/export. |
| Phase 2 | Dungeon-specific loot tables, reward bundles on fights/treasures and later Event outcomes, dependency snapshots, probability analysis/Test roll, reward health, currency risk, explicit legacy Treasure conversion. |
| Phase 3 | Dungeon-local narrative Event library and weighted Event Pools, choices, required/consumed inventory, SP checks, effects, result rewards, run-memory branching, previews and engine sandbox. |
| Phase 4 | Dungeon-local WaifuMon Pools, Wild Encounter and Rescue activities, ordinary/guaranteed capture items, capture/direct rescue, live species acquisition policy and cross-run per-dungeon limits, publication species evidence, package v4. |
| Scene Sprites | Shared managed environmental sprite catalogue, room/activity instances, composition with actors, previews, frozen published visuals and dependency protection. Package portability is deliberately blocked. |

Events and Wild Encounters are different activity types. An Event chooses a **story and buttons**, not an obtainable character. A Wild Encounter chooses a **species**, offers charms and capture attempts, and can grant a collection copy. A Rescue can use capture rules or grant a permitted species directly. A console or chest Scene Sprite is visual decoration; it does not create an Event, a lock, loot or a rescue by itself.

Player eligibility is system-wide, rather than an authorable list of dungeon level requirements: Equipment feature unlock, an active Buddy, a complete Attack/Defense/Health equipment loadout, an enabled published dungeon in the current region, an available daily run and no existing active dungeon run. Starting spends a daily run, not Energy. The Buddy, combat stats, gear and applicable bonuses are pinned at start. Progress and HP persist across disconnects; resuming does not spend another allowance. The fighter copy is reserved while the run is active. Do not describe this as a global lock on every other player activity.

Sources: [definition](../../src/modules/dungeons/content/dungeonDefinition.ts), [content service](../../src/modules/dungeons/dungeonContentService.ts), [run service](../../src/modules/dungeons/dungeonRunService.ts), [fighter snapshot](../../src/modules/dungeons/dungeonFighter.ts), [allowance](../../src/modules/dungeons/dungeonAllowanceService.ts).

## 2. Portal navigation map

| Starting point / route | Controls and destination | Permissions / purpose |
| --- | --- | --- |
| Sidebar **Admin — Dungeons**, `/admin/dungeons` | **Create dungeon**, **Import Dungeon**, **Dungeon Loot Tables**; dungeon rows open their editor; **Enable**/**Disable** controls availability. | `dungeons.read` for catalogue; `dungeons.write` for creation, import and enable changes. |
| Same page, **Delve settings** | **Daily run limit**, **Save limit**. | Shared across all dungeons; initial limit 3, integer 0–50; 0 closes new starts. |
| Same page, **Progression currency** | **Singular name**, **Plural name**, **Icon or emoji**, **Currency enabled**, **Currency description**, **Save currency** (accessible control names). | Existing currency key is fixed; edit display metadata/enabled state, not a new per-dungeon currency definition. |
| Same page, **Reward Health** | **Check again**, affected dungeon links and published/older active revision findings. | Reads whether promised rewards remain deliverable, not just whether a draft validates. |
| `/admin/dungeons/new` | **Create dungeon draft**; **Dungeon name**, **Dungeon key**, **Progression currency**, **Available regions**, **Create draft**. | `dungeons.write`. |
| `/admin/dungeons/definitions/:key` | **Back to dungeons**, **Check again**, **Save draft**, **Publish draft**, checklist button, **Map**, **History & export**. | Read-only inspection with `dungeons.read`; edits with `dungeons.write`; publish/rollback with `dungeons.publish`. |
| Editor **Map** | **Outline**: **Rooms**, **Paths**, **To do**; room palette **Combat**, **Boss**, **Treasure**, **Rest**, **Event**, **Exit**, **Empty**. Click a room/path for its inspector. | Room cards, directed edges, drag positions and connection handles; outline is an alternative to graph interaction. |
| Editor dungeon settings | **Publication**, **Dungeon settings**, **Currency Risk**, **WaifuMon Pools**, **Events**, **Pictures**, **Advanced**. | Library sheets edit the same in-memory dungeon draft; closing them is not a server save. |
| Room inspector | **Room details**, **Scene Sprites**, **Event**, **What happens here?**, **Ways out**, **Advanced rules**. | Attach narrative source, configure activities, create/connect the next room, choose start/end/extraction. |
| Activity card | Expand the activity; type-specific fields, **Rewards** where supported, **Advanced options** and **What happens afterward?** routing. | Ordered activities, conditions, optionality, combat waves and encounter rules. |
| `/admin/dungeons/loot` and `/admin/dungeons/loot/:key` | Shared Dungeon Loot Table list/editor, reward forms, odds, **Test roll**, archive/restore and usage. | `dungeons.read` / `dungeons.write`; new table route `/admin/dungeons/loot/new`. |
| Sidebar **Admin — Enemies**, `/admin/enemies` | Enemy catalogue; create/edit enemy; full art, transparent sprite, placement and preview. | `enemies.read` / `enemies.write`; separate from dungeon permissions. |
| Sidebar **Admin — Dungeon Scene Sprites**, `/admin/dungeons/scene-sprites` | Search, create/edit sprite, defaults, artwork, archive/restore/delete, usage/history. | `dungeons.read` / `dungeons.write`; artwork access needs separate artwork permissions. |

Compatibility routes: `/admin/dungeons/zones/:key` opens the definition editor; `/admin/dungeons/enemies` redirects to the enemy catalogue; `/admin/dungeons/preview` redirects to the list. Do not send creators to an old standalone dungeon preview page.

Artwork selection/preview requires `artwork.read`; uploads require `artwork.write`. Reading dungeons does not confer those rights. Cookie-authenticated mutations also use Portal CSRF protection. The authoritative API permission gates are in [dungeons routes](../../src/api/routes/v1/admin/dungeons.ts), [loot routes](../../src/api/routes/v1/admin/dungeonLootTables.ts) and [sprite routes](../../src/api/routes/v1/admin/dungeonSceneSprites.ts). Navigation: [navigation.ts](../../portal/src/app/navigation.ts), [router.tsx](../../portal/src/app/router.tsx).

## 3. Complete feature reference

### 3.1 Creation, identity, settings and access

**Creation controls.** **Dungeon name** is required, trimmed, 1–100 characters. The Portal derives **Dungeon key** from the name until manually changed. Keys are at most 64 characters, lower-case letters/digits separated by single underscores (`scrapheap_delve`). Keys are stable identities used by policies, packages and references; renaming the display name does not rename the key. Reserved route keys are rejected by the content service. The creation form requires at least one **Available regions** selection; disabled regions cannot be newly selected there.

**Initial content.** `starterDungeon` creates one ordinary room with ID `entrance`, name `Entrance`, no activities and `extraction: true`. It does not create a separate exit room. Empty ordinary rooms complete their sequence immediately, so the entrance is an immediate extraction point until changed. New Portal settings explicitly retain 50% on defeat and 0% on abandonment. Schema omission is different: defeat defaults to 0%; omitted abandonment follows defeat. Ordinary Portal creation leaves an **enabled but unpublished** row: the content service does not override the database's `enabled: true` default. It is unavailable to players until published, but publishing that enabled row can immediately open new starts. Package-created drafts use a different disabled/unpublished lifecycle.

**Editing metadata.** In dungeon settings, **Dungeon name**, **Dungeon description** (up to 1,000 characters) and **Available regions** affect the next publication. **Progression currency** selects an enabled catalogue currency or **None**. Phase 2 `shards` grants resolve to this selection; it must be configured and enabled before such rewards publish. Display names may say Baddie Shards, but reward content uses the abstract `shards` kind, not a hard-coded currency key. Global currency metadata changes are separate from publishing a dungeon. On the list's currency form, singular/plural names are required, 1–60 characters; description max 500 (default empty), optional icon max 64 (null means none), enabled is boolean. The stable key is not editable.

**Access and progression.** Available regions restrict **starting** a run; an existing run can be resumed elsewhere. There is no dungeon editor field for minimum level, quest prerequisites, arbitrary inventory entry fees, a campaign progression tree, a per-zone daily limit or an energy cost. A room/path rule can test run flags or completed rooms, not an arbitrary global progression condition. The Equipment unlock and loadout requirement come from the live service.

**Daily allowance.** List page → **Delve settings** → **Daily run limit** → **Save limit**. Integer 0–50, initially 3, shared across every zone. The game day uses configured `DAILY_TIMEZONE`, resetting logically at its midnight; there is no per-dungeon reset schedule. Remaining = `max(0, limit - runs started today)`. Raising/lowering the setting affects availability immediately. Completion, defeat, extraction and abandonment do not refund a committed start. A failed start transaction does not consume a run. Bonus run items/grants are future work.

**Save versus publish.** **Save draft** stores content and layout under an optimistic `draftRevision`. A structurally unreadable definition cannot save; a readable draft can retain semantic errors for repair. The UI also refuses incomplete enemy selections. Unsaved edits, stale conflicts and blocking issues disable publication. **Publish draft** opens confirmation **Publish [name]?**, then **Publish now**; only this explicit publication changes new-run content. Read-only users can inspect previews/sandbox without authoring rights.

Sources: [create page](../../portal/src/features/adminDungeons/DungeonCreatePage.tsx), [`starterDungeon`](../../portal/src/features/adminDungeons/dungeonModel.ts), [editor](../../portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx), [list/settings](../../portal/src/features/adminDungeons/DungeonsListPage.tsx), [identifier schemas](../../src/modules/dungeons/content/dungeonIdentifiers.ts), [allowance](../../src/modules/dungeons/dungeonAllowanceService.ts), [currency metadata schema](../../src/modules/progressionCurrency/progressionCurrencyService.ts), [database definition defaults](../../src/db/schema.ts).

### 3.2 Rooms, graph layout and sequence ordering

**Room creation.** In **Map**, select a room then use its add-next-room control or the palette. Templates **Combat**, **Boss**, **Treasure**, **Rest**, **Event**, **Exit**, **Empty** create ordinary schema content, not special immutable room classes. Adding after a selected room places and connects it; adding without a source leaves it disconnected. A Combat/Boss room starts with an unselected enemy; finish that selection. Event creates a new blank library Event with a Continue choice. Exit sets `kind: exit`; other templates use ordinary rooms. A room can subsequently mix activity types.

**Room fields.** Select a card or **Outline → Rooms** row. **Room name**: 0–80 characters. **Description players read** (accessible **Room description**): 0–600 characters. **Room background** overrides the dungeon scene. **What happens here?** contains the ordered activity list. Common add buttons: **Fight**, **Boss fight**, **Treasure**, **Rest**, **Wild Encounter**, **Rescue**. **More** reveals **Remember something**, **Checkpoint**, **Leave through a path**. Narrative Events are attached via the separate **Event** source control rather than created as a bare activity.

**Ordering.** Activities run in array order, independently of map coordinates or room array order. Move-up/down changes gameplay order. Duplicate creates a new activity identity; remove deletes that entry. Moving/removing a forward-jump target can invalidate another activity's route; the editor retains and reports the broken reference instead of silently changing it. Map dragging changes layout only. The start room is designated explicitly, not inferred from the leftmost or first-drawn card.

**Advanced room controls.** **Make this the start room** opens confirmation with **Make it the start room**. **Completing this room finishes the dungeon** (accessible **Ends the dungeon**) sets exit kind; its activity sequence must finish before completion, so an Exit containing a boss does not bypass that fight. **Players may leave the dungeon here and keep everything** (accessible **Players can leave here**) sets extraction; extraction becomes available only once the room's sequence completes. An exit ends automatically, so also marking it extraction is redundant. **Delete room** removes the room; inspect resulting paths, start reference and any conditions/routes afterwards.

**Runtime.** Entering an unfinished room starts/resumes its sequence. A finished room does not replay activities or rewards on re-entry; it offers paths. Activities whose `when` condition is false are skipped as the sequence reaches them; do not assume returning later will reopen a completed room to run skipped activities. Put a conditionally unlocked rescue in a still-unvisited room behind a locked path when it must remain available for later repair. Empty Exit completes on arrival; empty ordinary room immediately offers its ways out. No automatic two-way travel is created by a single directed connection.

**Bounds.** 1–200 rooms, up to 600 connections, at most 60 activities per room. Room/activity/connection/flag IDs use lower-case letters/digits with `_` or `-`, maximum 40 characters; the Portal generates identities. Human labels are independent of those IDs. Gameplay definition schema is version 1 internally; package schema versions are a different numbering system.

Sources: [graph](../../portal/src/features/adminDungeons/DungeonGraphView.tsx), [`ROOM_TEMPLATES`, `addTemplateRoom`, `connectionProblem`](../../portal/src/features/adminDungeons/dungeonRoomTemplates.ts), [room inspector](../../portal/src/features/adminDungeons/RoomInspector.tsx), [activity model](../../portal/src/features/adminDungeons/dungeonActionModel.ts), [`enterRoom`, `completeRoom`, `runSequence`](../../src/modules/dungeons/engine/step.ts), [definition schema](../../src/modules/dungeons/content/dungeonDefinition.ts).

### 3.3 Paths, gates, flags, conditions and routing

**Connections.** Use **Ways out**, **Add next room**, or connect an existing room using the graph handle **Drag to another room to connect**. Select the edge or **Outline → Paths** entry to edit:

| Control | Meaning / constraints |
| --- | --- |
| **Can players take this path?** → **Open path** | No requirement; ordinary visible path. |
| **Locked path** | A visible but unavailable path until its rule holds. **This path opens when** edits the condition. **Message while it is locked** (accessible **Locked text**) is up to 200 characters. |
| **Hidden path** | A secret connection omitted entirely while its rule is false. It appears once unlocked. Hidden is not a percentage-based discovery mechanic. |
| **Button text players see** (accessible **Path button text**) | 0–80 characters; empty uses destination-room wording. |
| **Advanced** → **Starts in**, **Leads to**, **Reverse direction** | Directed endpoints; no outgoing path may originate at an Exit. Reversing creates the opposite direction for that connection, not an additional return path. |
| **Mark as a shortcut** | Planning/presentation marker; same traversal mechanics as an ordinary path. Unavailable for a hidden path. |
| **Remove path** | Delete connection; inspect routes that explicitly named it. |

Switching an open path to locked/hidden seeds a rule based on completion of the source room; replace it with the intended flag rule. Switching back to open clears the requirement. The graph UI refuses self/duplicate source-to-target connections and outgoing connections from exits. The backend treats a self-loop as a warning, so imported definitions may show configurations the UI will not newly create.

**Checkpoint is an activity gate, not a savepoint.** Add through **More → Checkpoint**. **Players can continue only if** edits a required condition; **Blocked text** is up to 300 characters. Passed proceeds; blocked defaults to retreat to the room of arrival, leaving this room unfinished. A default blocked gate at the entrance is invalid because there is nowhere to retreat. Explicit blocked routing can finish the room/end the run instead. Ordinary room paths are evaluated when offered; an activity's explicit **Go through the path to [room]** route bypasses that connection's requirement, which the validator warns about. Do not use that as a secure lock.

**Run memories.** **Remember something** activity → **What to remember** or **Name of what is remembered**; **Remember or forget** selects **Remember that it happened** / **Forget it again**. Event effects and encounter results can also set declared run flags. Dungeon settings → **Advanced → Things this dungeon remembers** lists descriptions (accessible **Remembered thing N**) and **Add something to remember**. A description can be up to 300 characters; changing its wording preserves its stable key. Up to 200 flag declarations. Unset = false. They reset each run; there is no persistent player flag writer. Player-scoped imported declarations are preserved but cannot be authored/set through these controls.

**Condition vocabulary.** The same editor is reused by paths, action **Only happens if**, gates, Event choice availability and pool entries. Type options are **Always**, **A room is completed**, **Something was remembered**, **All of these are true**, **Any of these is true**, **This is not true**. Flag comparisons offer **has happened** / **has not happened**. Empty condition means true; room-completed means completed sequence, not merely visited. All/Any require 1–20 child conditions; nesting depth at most 6. Conditions cannot test arbitrary SP thresholds, currencies, item counts or species ownership. Event required items and encounter acquisition policy are separate mechanisms.

**Activity advanced controls.** Expand **Advanced options**. **Button text players see** (accessible **Button text**) max 80; empty uses type-specific Discord wording. **Players can choose to skip this** (accessible **Player can skip this**) adds a decline path for supported ordinary activities; Event/encounter activities reject optionality because they supply their own choices/Leave controls. **Only happens if** is checked on sequence arrival. **What happens afterward?** offers **Usual: …**, **Continue with the next activity**, **Skip the rest of this room**, **Send the player back the way they came**, **Finish the dungeon**, **End the run in defeat**, **Skip ahead to activity N: …**, **Go through the path to [room]**. Retreat is not offered for resolved encounters.

**Routing precedence and outcomes.** Exact `outcomes[result]` override comes first. General `next` applies to the success outcome for ordinary activities; optional decline otherwise carries on. Encounter `next` is special: it applies to **all** encounter terminal results unless specifically overridden. Then type defaults apply:

| Activity | Results | Usual routing |
| --- | --- | --- |
| Fight/Boss | `victory`, `defeat` | Victory next; defeat ends defeated. |
| Rest, Remember | `done` | Next. |
| Checkpoint | `passed`, `blocked` | Passed next; blocked retreat. |
| Treasure | `claimed` | Next. |
| Leave through a path | Destination itself | Named outgoing connection, or room complete if none. |
| Event | `resolved`, `nothing` | Next, unless branch `then` or activity routing changes it. A failed SP check still resolves the Event. |
| Wild Encounter | `captured`, `escaped`, `left`, `nothing`, `unavailable` | General encounter continuation or next. |
| Rescue | `rescued`, `escaped`, `left`, `nothing`, `unavailable` | Same; direct rescue cannot escape. |

An action jump can only name a later activity in the **same** room. No backward/self jumps or arbitrary room teleport. A leave destination must use an outgoing connection from that room. `room_complete` skips remaining activities and marks the room complete. Retreat retains the unfinished sequence position for return; completed action results are not a farmable replay.

Sources: [connection inspector](../../portal/src/features/adminDungeons/ConnectionInspector.tsx), [activity card](../../portal/src/features/adminDungeons/ActivityCard.tsx), [condition editor](../../portal/src/features/adminDungeons/DungeonConditionEditor.tsx), [flags](../../portal/src/features/adminDungeons/RunFlagsEditor.tsx), [condition/destination schemas](../../src/modules/dungeons/content/dungeonPrimitives.ts), [`evaluateCondition`](../../src/modules/dungeons/engine/conditions.ts), [`destinationFor`, `defaultDestination`, `forwardIndex`](../../src/modules/dungeons/engine/routing.ts).

### 3.4 Combat, enemies, waves, rest and Buddy effects

**Catalogue first.** Open **Admin — Enemies**; the dungeon picker selects catalogue keys, not arbitrary combat JSON. Enemy create/edit has **Enemy name**, **Enemy key** on creation, **Enemy enabled**, **Enemy description**, **ATK**, **DEF**, **HP**, tags, **Full artwork**, **Transparent sprite**, default placement controls and **Preview background**. Name 1–100 characters; key lower_snake_case up to 64; description 500; up to 20 identifier-style tags. Attack and HP integers 1–1,000,000; defense 0–1,000,000. Tags are metadata, not dungeon scripting triggers. Missing enemies block publication; disabled enemies produce a review warning. Artwork is optional.

The catalogue offers **Search enemies**, status/tag/usage filters, enable/disable, duplicate and **Export**. Duplicate asks for **Key of the copy**, **Name of the copy** and **Copy artwork**. **Save enemy** uses optimistic revision checks. **Delete enemy…** is for unused mistakes; prefer disabling an entry that is referenced. Catalogue rows distinguish shipped/custom/edited content; a locally edited shipped enemy is not overwritten by a subsequent deploy. Export produces the enemy content envelope for the separate content-maintenance workflow, not a published dungeon revision.

**Placement.** In a Fight/Boss activity, choose **Wave N enemy**. The picker displays art, stats/status and a link to inspect the enemy when permitted. **Wave N random enemy group** switches a wave to a weighted enemy list. Weights are integers 1–1,000,000, up to 50 entries; duplicate enemy keys in a group are errors. A wave selects exactly one enemy, not simultaneous combatants. Add/remove/reorder waves; 1–100 waves per activity. Many waves trigger a warning; the hard maximum is not a balance recommendation.

**Boss semantics.** Under **Advanced options**, **Present this as a boss fight** (accessible **Present as a boss fight**) switches combat/boss presentation. It uses the same combat engine and wave structure; it does not add a boss AI, guaranteed rewards or rescue automatically. Configure **Rewards** and a following Rescue separately.

**Battle execution.** Fights are sequential one-versus-one basic-attack simulations using the ordinary combat engine. Each enemy starts its wave at full HP; the Buddy carries current HP between waves, activities and rooms. Weighted enemy selection and combat use seeded per-location streams. **Fight all waves in one go (no button press between waves)** (accessible **Fight remaining waves automatically**, under **Advanced options**) changes `advance` from default `confirm` to `auto`: after initiating the activity, subsequent waves resolve without a separate confirmation each. It does not globally auto-traverse the dungeon. Rewards on a combat activity pay once after the activity is won, not once per wave. A loss ordinarily ends the run; overriding defeat routing deserves deliberate testing.

**Buddy and equipment.** Active Buddy, current SP, level, ATK, DEF, max HP, equipment identity/rolls and aggregated capped modifiers are snapshotted at run start. The engine uses those modifiers, including applicable combat bonuses, rather than rereading changed gear mid-run. Applicable affection/Essence reward bonuses and capture Buddy inputs are also pinned. An SP Event check reads this pinned SP, not a new live Buddy or just equipment rarity. Creature art uses the pinned fighter species. The author cannot select the actual live player's Buddy in dungeon content.

**Rest.** Add **Rest**, configure **Restore HP percent** 0–100. Default 30% of maximum HP, rounded down and capped at maximum. This is dungeon HP, not a world inventory healing item or a respawn. Event healing/damage is documented separately below.

**Discord.** Fight buttons use the authored label or **Fight**, then **Next wave** where applicable. Results show enemies, wave outcomes, HP and rewards. The encounter scene uses a transparent enemy sprite if available; full-art fallback differs visually (section 3.8). Defeat routes to the settlement screen by default.

Sources: [enemy schema/catalogue](../../src/modules/combat/enemyDefinitions.ts), [enemy editor](../../portal/src/features/adminEnemies/EnemyEditorPage.tsx), [enemy fields](../../portal/src/features/adminEnemies/enemyParts.tsx), [activity card](../../portal/src/features/adminDungeons/ActivityCard.tsx), [enemy appearance preview](../../portal/src/features/adminDungeons/EnemyAppearance.tsx), [`selectWaveEnemy`, `fightWave`](../../src/modules/dungeons/engine/combat.ts), [`fighterFromCombatStats`, `pinnedRewardBonuses`, `pinnedCaptureBuddy`](../../src/modules/dungeons/dungeonFighter.ts), [Discord presenter](../../src/discord/dungeonPresenter.ts).

### 3.5 Rewards, Treasure, Dungeon Loot and risk

**Reward sites.** Expand **Rewards** on Fight, Boss or Treasure; Event outcome editors also have a separate Rewards section for fixed/success/failure branches. New Treasures use a Phase 2 bundle. Ordinary fights may start collapsed; Boss/Treasure normally expose rewards, while Event result rewards start collapsed. Reward configuration does not attach itself to unrelated activities or scene art.

The bundle has **Guaranteed**, **Chance drops**, and shared loot-table references (**+ Add loot table**). **+ Add guaranteed reward** always pays its configured amount/range. **+ Add chance drop** adds an independent probability; **Chance percent** supports 0.01–99.99%, stored as integer basis points 1–9,999. Use Guaranteed for 100%; delete a row for 0%. **What to give** / accessible **Reward type** selects Baddie Shards, WaifuBux, Essence, item, Equipment or affection. **Amount** / **How many**, **Use a range**, **Lowest amount**, **Highest amount**, **Use a single amount** configure inclusive integer quantities. Amounts are positive; range maximum must be at least minimum.

| Grant | Valid configuration and dependencies | Delivery / Discord meaning |
| --- | --- | --- |
| Baddie Shards (`currency: shards`) | Amount 1–1,000,000 per grant; enabled dungeon **Progression currency** required. | Accumulates at risk until settlement. |
| WaifuBux | Amount 1–1,000,000 per grant. | Accumulates at risk until settlement. |
| Essence | Amount 1–100,000 per grant. | Secured when paid; applicable pinned Buddy Essence bonus applies. |
| Item / charm | Existing enabled item slug; quantity 1–999. `maxOwned` must be null: capped items cannot be authored as dungeon loot. | Secured immediately. Global item definitions are not created here. |
| Equipment | Selector: optional slot Attack/Defense/Health, optional rarity N/R/SR, optional whitelist of 1–50 definition keys. | One eligible base definition selected uniformly, then ordinary grant rolls determine multiplier/affix; secured immediately. |
| Affection | 1–500 per grant, within aggregate activity limit. | Goes to participating pinned Buddy, with her pinned affection bonus; never an authored recipient selector. |

**Equipment details.** **Equipment rarity** defaults to **Any rarity (N, R or SR)**; **Equipment slot** defaults to **Any slot**; specific-piece selection further narrows the intersection. Explicit nonexistent, disabled or contradictory keys invalidate the selector; they are not silently dropped. No matching enabled definition blocks publication. Random SSR/higher, authored multipliers and authored affixes are unsupported. Affixes come from the ordinary equipment grant pipeline. The picker reports matching gear so an empty choice can be corrected.

**Shared Dungeon Loot Tables.** List page **Dungeon Loot Tables** opens `/admin/dungeons/loot`. Table editor metadata includes **Table name** (1–100 characters), stable **Table key** on creation (dungeon-key syntax), **Tier** (**No tier**, **Common**, **Rare**, **Boss**, **Legendary**; default none, stored lower-case values, organizational metadata), **Description** (author-only, up to 600 characters, default empty). Sections: guaranteed rewards, **Chance drops**, **Random picks**. **+ Add a group of random picks** creates a pool; **Group name** (1–100 characters), **Picks** (accessible **Picks from [name]**), reward rows with relative **Share**, **+ Add reward**, **+ Add “Nothing”**. Nothing is only an outcome in a weighted group, not a reward type in Guaranteed. The UI allows one Nothing row per group; increase its share rather than adding another. Tables cannot recursively reference other tables.

List **New loot table** opens creation; **Create table** and **Save table** save this shared catalogue separately from the dungeon. **Duplicate** copies the last saved table under a new identity; no dungeon uses that copy automatically. **Archive** hides it from new selection and blocks new publications that still reference it; **Restore** makes it selectable again. **Delete** requires archiving first and is refused while drafts or nonembedded published dependencies still need the live row. Published snapshots that embed its body can outlive a deleted table. The editor/list usage views explain which dungeons need review/republish. A catalogue save is not a dungeon publish.

Each pool makes 1–10 independent picks with replacement from 1–40 entries; at most 6 pools/table. Weights are integers 1–1,000,000. A picked entry can repeat. Guaranteed rows and chance drops execute alongside every pool, not instead of them. A table reference's **Times [name] is rolled** is 1–10 (default 1); that repeats the entire table, including guaranteed rows, chance checks and all pool picks. **Open table** opens editing context or, from Event results, a new tab. Shared table edits affect all drafts using it, but published Phase 2 rewards retain their frozen copy until republished.

**Probability interpretation.** A 20% chance row and a 30% chance row are independent and can both pay. A weighted 3:1 group makes one 75%/25% choice per pick; two picks make the chance of at least one 3-share reward `1 - 0.25^2 = 93.75%`, not 150%. Amount ranges are inclusive integer rolls after selection. **LootOdds** reports quantities, expected values, at-least-once probabilities and equipment chances; **Test roll** shows reproducible sample rolls, not guaranteed payouts or live inventory writes. Raising table roll counts multiplies all its work and can exceed activity bounds.

**Hard bounds.** Per bundle: 12 guaranteed rows, 12 chance rows, 4 table references. Per table: 12 guaranteed rows, 20 chance rows, 6 pools, 40 entries/pool, 10 picks/pool. Unique entry identities are required. Expanded worst-case limits: 10 Equipment, 200 resolved draws and 1,000 base affection per activity; 2,000,000,000 at-risk currency across a dungeon. Limits use possible payout/work, not expected payout; a tiny chance does not exempt a huge grant. Empty rewards and all-Nothing groups are warnings, while malformed grants/dependencies/work excess block publication.

**Currency Risk.** Dungeon settings → **Currency Risk** → **If the player is defeated**, **If the player abandons the run**. Presets **Keep everything (100%)**, **Keep half (50%)**, **Keep nothing (0%)**. Abandon also offers **Same as defeat: …** (omits its independent value). **Advanced: custom percentages** exposes **Kept on defeat**, **Kept on abandoning**, accepting 0–100 with at most two decimal places. The new-dungeon Portal defaults are defeat 50%, abandon 0%; imported/legacy omission retains schema semantics described in 3.1. Abandoning keeping more than defeat is legal but warned about.

**Settlement.** Completion and extraction bank 100% of accumulated Shards and WaifuBux; defeat/abandonment bank the configured retention separately per currency, rounded down. Example: 45 Shards and 501 WaifuBux at 50% become 22 and 250. Existing wallets are never reduced. Items, Equipment, Essence, affection and obtained WaifuMon are already secured and retained on bad endings. Disconnect/restart does not settle a run. Missing/disabled progression currency at settlement can skip Shard banking and record the reason; WaifuBux settle independently. A secured reward delivery failure rolls back the whole activity step, so progress and consumption can retry after repair without partial grants.

**Legacy Treasure.** Older `reward` content uses expedition reward-table / equipment-table references and an integer currency min/max (0–1,000,000). Current UI preserves those fields and provides explicit conversion review rather than silently rewriting old content. Legacy and new `rewards` cannot coexist on one Treasure. Conversion requires a saved draft, previews resulting tables/rewards and warnings, then rewrites only that saved Treasure after confirmation. It does not publish. Treat legacy reward dependency behavior separately from Phase 2 snapshots; new recipes should use bundles.

**Reward Health and publication drift.** The list's **Reward Health → Check again** checks current published snapshots and older revisions with active runs. **Broken published rewards** / **Runs in progress affected** are operational findings. Draft errors are separate, as are Event required-item notices. **Loot changed** means present catalogues differ from publication, not that old loot suddenly changed. Republishing captures new loot/eligible gear for future runs; it cannot repair an active old revision whose required underlying item/gear no longer exists or is disabled. Restore those dependencies. An archived loot table blocks a new publication; frozen prior table content can still be healthy.

Sources: [reward schemas and work limits](../../src/modules/dungeons/content/dungeonRewards.ts), [activity reward UI](../../portal/src/features/adminDungeons/ActivityRewards.tsx), [reward form](../../portal/src/features/adminDungeonLoot/RewardForm.tsx), [loot sections](../../portal/src/features/adminDungeonLoot/LootSections.tsx), [table editor](../../portal/src/features/adminDungeonLoot/LootTableEditorPage.tsx), [equipment selector](../../src/modules/equipment/rewardSelector.ts), [`resolveRewardBundle`, `analyseRewardBundle`](../../src/modules/dungeons/engine/lootResolver.ts), [reward validation](../../src/modules/dungeons/validation/dungeonRewardValidation.ts), [risk controls/model](../../portal/src/features/adminDungeons/CurrencyRiskSettings.tsx), [health panel](../../portal/src/features/adminDungeons/RewardHealthPanel.tsx), [conversion service](../../src/modules/dungeons/dungeonTreasureConversion.ts).

### 3.6 Narrative Dungeon Events

#### Library, attaching and pools

Dungeon settings → **Events** is a dungeon-local library. **+ New event** offers **Blank**, **Locked door**, **Risky shortcut**, **Shrine** starting points. Blank has a story and one Continue choice; Locked door starts with a 50% SP Force it check, 15% maximum-HP failure damage and a free turn-back choice; Risky shortcut uses a 60% check and 20% failure damage plus a safe alternate; Shrine offers 25% healing or moving on. Presets are editable content, not special runtime mechanics. In particular, do not attach a turn-back-only fallback at the entrance without checking validation.

Library entries show usage. Edit/view opens a side sheet; duplicate creates an independent identity; delete is refused while referenced by a room or pool. Removing a pool does not delete its Events. Reused Event edits affect every reference in the same draft. Closing any sheet leaves unsaved dungeon changes; use **Save draft** after editing.

Room inspector → **Event** / **Room event** → **A specific event** or **A random event from a pool**, then choose/create the source and **Edit**. A new attached Event activity is inserted before a final leave activity; review actual activity ordering. Rooms with multiple Event activities edit them individually. Specific sources reference `eventId`; random sources reference `poolId`. Library content alone never runs.

**+ New random pool** opens the Event Pool sheet. **What can happen** contains Event or **Nothing happens** rows, **share** weights, optional entry rules and **Once per run**. **Chances** shows full and scenario-conditioned probabilities. Limits: 100 Events, 50 Event Pools per dungeon; 1–20 entries/pool; name 1–80 characters; weight 1–1,000,000; Nothing text up to 200. Duplicate Event identities within one pool are errors; combine shares. A pool containing only Nothing is invalid. All entries conditional/once-only is allowed with an exhaustion warning; an empty eligible draw silently resolves Nothing, whereas an explicit Nothing entry can provide text.

**Once per run** defaults true for Event entries. Selection anywhere in the run marks that Event seen for other once-only pool entries, even before a choice is answered and even if the player turns back. Direct named placement still deliberately presents the Event. Nothing repeats. Conditions and seen exclusions are removed **before** weight normalization: probability = eligible weight / eligible total. The selected result is saved per room/activity; returning cannot reroll it after flags change.

#### Story and choices

Event sheet **Title** (accessible **Event title**): 1–80 characters. **What the player reads** (accessible **Event story**): 1–1,500 characters. **Event picture** is optional, selected through the dungeon-background artwork picker. **Choices** holds 1–5 buttons, displayed in author order. Expand the relevant **Choice N: [label]** card to edit it.

Button text is 1–60 characters (accessible **Choice N button text**); optional description up to 200. **Who can pick this?** holds **Choice N is available** conditions and **+ Needs an item**. At most 2 distinct required item slugs, quantity 1–99 (default 1), consume default false. Each requirement must be met. A consumed item is spent on committing the choice **before** the SP roll, including failure. Merely previewing or pressing a stale/refused choice does not spend it. Required definitions must exist; disabled required items produce a warning, unlike disabled reward items which block publication. Actual owned quantity is live, not a publication snapshot.

**What players read when they can’t pick it (optional)** (accessible **Choice N unavailable text**) is up to 120 characters. **Hide it from players who can’t pick it** (accessible **Choice N: hide when unavailable**) defaults off: unavailable buttons normally remain visible and disabled. At least one choice must have **no rule and no required items**; a conditional choice whose rule happens to be true in one preview is not an unconditional escape. At the entrance, each possible Event must have an unconditional choice that actually proceeds, since retreat is unavailable.

#### Exact location of SP skill checks

The control is **inside an expanded choice**, not in dungeon settings, the Event header, the room's advanced rules, the rewards editor or the pool entry:

1. Open the Event's side sheet via **Events** or the room source's **Edit**.
2. Expand **Choice N: [button text]** under **Choices**.
3. Find **What happens?**, below **Who can pick this?**.
4. Open the dropdown currently showing **Always the same result** and select **Skill check: it can succeed or fail**.
5. Set **Chance for an average Buddy:**. Open the nearby **Advanced** control for **Buddy strength moves the chance by up to**.
6. Configure the separate success and failure result editors, including their text, effects, rewards and **Then** destinations.

The dropdown has the accessible label **Choice N result kind**, but that label is screen-reader-only; a sighted creator sees the current option under **What happens?**. A guide should use that visible landmark, ideally with a screenshot taken from the deployed UI. **Unverified:** actual visual layout at the creator's browser size.

Enabling a check initializes base chance **50%**, maximum Buddy influence **15 percentage points**; the previous fixed outcome becomes success and failure starts empty. Disabling the check retains success as the fixed outcome and removes failure. If failure contains authored content, a confirmation explains that loss.

**Chance configuration and exact formula.** Base slider 0–100%, whole-percent UI steps; schema stores integer basis points 0–10,000. Advanced influence 0–50 percentage points, whole-point UI steps; schema 0–5,000 basis points, default 1,500. This is SP only, not a choice of stat:

```text
modifierBP = trunc(maxInfluenceBP * clamp(SP - 200, -150, 150) / 150)
chanceBP = clamp(baseBP + modifierBP, 500, 9500)
success = rollInteger(0..9999) < chanceBP
```

Average SP = 200; the full negative influence applies at SP ≤50 and full positive at SP ≥350. Missing SP uses the full negative adjustment. For base 55% and influence 15 points: weak 40%, average 55%, strong 70%. Final chances are always 5–95%, including a 0%/100% base; use a fixed result for certainty. Modifier is additive percentage points, not a percentage multiplier. A flat check outside the final clamp with zero influence gets a warning. Server preview displays weakest/average/strongest chances; Discord uses the actual pinned Buddy's chance. Checks have deterministic room/action/choice seed streams; refreshing/retrying does not create a fresh committed roll. Failed checks settle the Event, so a second visit cannot retry its challenge.

#### Results, effects, rewards and follow-up flow

Each fixed/success/failure result has text up to 800 characters, optional mood **Neutral**, **Good news**, **Bad news**, up to 6 effects and an optional independent Rewards bundle. Tone changes presentation, not chance or economy. Effect controls:

| Control | Content / behavior |
| --- | --- |
| **Remember that something happened** | `set_flag`, true on an existing or newly created declared run memory. |
| **Forget it again** | Same flag effect with false. |
| **Restore health** | UI percent input has minimum 1, maximum 100, step 1; newly added heal/damage effects start at 25%. Schema also accepts finer 0.01–100% values (1–10,000 BP). Integer HP rounds down, capped at max HP. |
| **Lose health** | Same maximum-HP basis, rounded down, leaves at least 1 HP. It cannot by itself kill the Buddy. |
| **Rewards** | Guaranteed/chance/table bundles from section 3.5, paid once only on the selected branch. |

The visible **Then** options are **Carry on**, **Finish the room**, **Turn back (the event stays open)**, **End the run: the dungeon is completed**, **End the run in defeat**. An already stored explicit `next` additionally displays **Carry on with the next activity, whatever the room’s flow says**. Default Carry on omits branch `then` and uses the activity's resolved routing; an explicit next bypasses that routing. The current choice dropdown does not create direct jumps to an arbitrary later activity or through a path. Set a run flag and use subsequent activity/path conditions, or configure activity-level resolved routing.

**Turn back** deliberately leaves the Event open. It cannot have a check, effects, rewards or consumed items. Nonconsumed requirements are allowed, but still need an unconditional viable alternative. Resolved/nothing activity routing cannot retreat, because a settled Event would then permanently block that room. A checked result cannot retreat even if failure seems like a natural retry. For a permanent decline, write a free ordinary choice that carries on instead.

Consumption, effects, rewards and the selected result commit together in live service transactions. If reward delivery fails, the Event remains unresolved and consumed inventory is not lost twice. Supported effects are only flag/heal/damage plus the separate Rewards field. `lose_currency`, `start_combat`, `move`, `set_player_flag`, `trigger_event` are explicitly unsupported effects. To start a fight or rescue after a narrative choice, author a subsequent activity gated by that choice's flag.

**Discord and preview.** Event narrative, available/disabled/hidden choices, item-cost explanation and actual SP chance are shown. One committed choice resolves the Event; success/failure text, health/memory changes and loot appear in results. **How players see it** uses **Buddy strength**, assumed inventory quantities, flags, completed rooms, already-seen Events and ability to turn back. It is a scenario preview, not a live mutation. **Play the dungeon** tests sequencing in the sandbox (3.9).

**Validation scope.** Every library Event/pool is structurally checked, used or unused. Live catalogue requirements, reward and artwork dependencies are traversed only for Events reachable through an attached source; unused ideas cannot unnecessarily block the played dungeon for a missing external dependency. Warnings include unused Events/pools, contradictory availability, an exhaustible pool and a clamped flat check. Errors include missing Event/pool/flag/item, duplicate identities, no open choice, unsafe retreat or entrance deadlock. This is static analysis; it does not prove every conditional route is playable.

Sources: [Event schemas](../../src/modules/dungeons/content/dungeonEvents.ts), [Event sheet](../../portal/src/features/adminDungeons/EventEditorSheet.tsx), [`EVENT_PRESETS`, `setChoiceCheck`](../../portal/src/features/adminDungeons/dungeonEventModel.ts), [library](../../portal/src/features/adminDungeons/DungeonEventsPanel.tsx), [source picker](../../portal/src/features/adminDungeons/EventSourcePicker.tsx), [pool sheet](../../portal/src/features/adminDungeons/EventPoolSheet.tsx), [preview scenarios](../../portal/src/features/adminDungeons/EventScenarioControls.tsx), [`eventCheckChance`, check implementation](../../src/modules/dungeons/engine/eventChecks.ts), [`analyseEventPool`, `selectDungeonEvent`, `describeEventChoice`, `applyEventEffects`](../../src/modules/dungeons/engine/events.ts), [Event validator](../../src/modules/dungeons/validation/dungeonEventValidation.ts).

### 3.7 WaifuMon Pools, Wild Encounter and Rescue

#### Species pools and central policy

Dungeon settings → **WaifuMon Pools** → **+ New WaifuMon pool**. Edit/view, duplicate and delete controls show pool usage; a referenced pool cannot be deleted until its activities detach it. The pool is local to this dungeon and part of its draft, not a global Region Pool.

Sheet controls include **WaifuMon pool name** (1–80 characters), species picker, **+ Add Nothing**, per-entry **weight**, **once per run**, **Nothing text (optional)**, **Entry N is in the draw** conditions and remove/replace controls. Limits: 30 pools/dungeon, 1–50 entries/pool, weight 1–1,000,000; at least one species required; duplicate species or entry identities are errors. Nothing text max 200. Species entry `oncePerRun` defaults true. Nothing has no once-only property. A direct source uses **Specific WaifuMon** instead and needs no pool.

The picker and insight panels report enabled status, rarity, tags/access, artwork and policy. Selection percentages are **not capture chances**. **Probability insight** includes **With every entry in the draw**, **In this simulated run**, flags, completed rooms, assumed already encountered species and acquisition counts. Conditions and once-only species exclusions remove entries before normalization. Once-only is keyed by selected species across the run, not just a pool row, successful capture or current ownership. Specific direct placement does not use a pool's once-only filter. The first selected species/Nothing is persisted per activity; revisiting does not reroll.

Live missing/disabled species, central exclusivity and exhausted acquisition limits do **not** redistribute pool weights. The originally selected species resolves `unavailable` when policy disallows acquisition. This preserves authored odds and does not give extra chances at a rare alternative. An empty eligible pool resolves Nothing. Result-level Nothing text overrides a selected Nothing row's text when explicitly present.

**Central policy is read-only here.** Species content may tag `dungeon_exclusive` or `region_exclusive`; either makes the species restricted and requires a matching `dungeonAccess` entry for this dungeon key. Ordinary enabled species can be used without an access entry. Access entries can specify `perPlayerLimit` as a positive integer or explicit `'unlimited'`, and `directRescue: true`. Omitted limits are unlimited for ordinary capture; there is no implicit one-copy policy. A dungeon author cannot grant permission by adding a species to a pool or importing a package. Arrange source-content policy changes through the appropriate content-maintenance workflow outside this editor. Dungeon-exclusive species are excluded from ordinary world spawning/hunting; source content rejects combining both exclusivity tags, duplicate dungeon-access entries or placing dungeon-exclusive species in ordinary pools. This Portal does not edit Region Pools.

Acquisition counts are ledger counts by **player + dungeon key + species**, across all runs and capture/direct rescue modes. They count acquired copies, not current collection ownership: releasing/salvaging a copy does not reset the allowance. A capture in a different dungeon has that dungeon's own count. No additional global cross-dungeon acquisition cap is implemented. A direct rescue requires an explicit matching access entry with `directRescue: true` and a finite numeric limit, even for ordinary nonexclusive species; unlimited authorization is insufficient.

#### Encounter activity controls and results

Select a room → **What happens here? → Wild Encounter** or **Rescue**, then expand its activity:

| Control | Values / default / effect |
| --- | --- |
| **Rescue mode** | Rescue only: **Capture rescue (uses a charm)** default; **Direct rescue (direct grant)** removes capture rules. |
| **Encounter source** | **Specific WaifuMon** or **WaifuMon pool**. **Choose WaifuMon** opens species picker; pool source selects a dungeon-local pool. |
| **Encounter introduction** | Up to 600 characters; default empty. Narrative shown while offered. |
| **Capture attempt limit** | Integer 1–3, default 3, per activity/offer, not per charm type. |
| **Permitted capture charms** | **All globally eligible charms** (omitted whitelist, default) or **Only selected charms** (explicit nonempty list, maximum 100 unique item slugs). |
| **Allow guaranteed capture items** | Default on; turning off excludes guaranteed items even if explicitly listed. Global rarity eligibility still applies. |
| **Encounter results** | Per terminal outcome text (up to 400 characters), up to 4 declared run flags with boolean values. Accessible names include **captured outcome text**, **rescued result flag N**, **… flag N value**. |
| **Encounter artwork** | Shared **Position**, **Scale (%)**, **Offset X (px)**, **Offset Y (px)** plus **Mirror encountered WaifuMon**; optional placement default follows shared actor placement. |
| **Only happens if**, **What happens afterward?** | Common activity conditions/routing. Resolved encounter retreat is forbidden; optional skip is forbidden. |

Wild outcomes: Captured, Escaped, Left, Nothing, Unavailable. Rescue outcomes substitute Rescued for Captured. Direct rescue has no Escaped outcome and cannot retain capture fields. Result flags are set only on the actual terminal outcome; a failed nonfinal attempt is not yet Escaped. Schema allows 40 encounter activities/dungeon, of which at most 3 may be direct rescues. An ungated direct rescue gets a warning, not an automatic lock. For a boss prerequisite, actual ordered combat/defeat flow can implement the gate; the warning's simple structural heuristic may still need review.

**Capture gameplay.** Discord offers eligible owned charms with server-calculated chance, **Capture**, **Leave her**; direct mode offers Rescue without charms. Choosing a charm spends nothing. A resolved attempt consumes one charm whether it succeeds or fails. Ordinary attempts use the shared hunting capture pipeline with the pinned Buddy matchup/bonus and applicable player effects; there is no authored dungeon capture-difficulty modifier. Guaranteed success still requires global item/rarity eligibility, ownership, permitted rules and live species policy. Ordinary attempts consume an applicable Microdose charge; guaranteed attempts do not. A failed attempt with attempts left keeps the same encounter open; final failure escapes. Success grants a collection copy and normal capture XP/collection/quest effects. Capture-mode rescue has the same acquisition mechanics but reports Rescued.

**Direct rescue gameplay.** Explicit grant, no roll, no charm or Microdose consumption. Awards the copy through the shared acquisition pipeline, including applicable acquisition XP/collection handling, but gives no capture-attempt/success quest credit. Policy and ledger cap are rechecked transactionally before granting. Both modes support duplicate copies; the dungeon result card's Keep/Salvage handling is bound to that run, result step and granted copy. **Continue the Delve** reopens the current run without advancing, spending or regranting; duplicate handling retains a route back to the run. These are not world-hunt reroll controls.

**Availability changes and mistakes.** Policy is checked when offered and before acquisition. Exhausted limit/disabled/restricted species resolve Unavailable without spending a charm. A dedicated unavailable dismissal advances that result; it cannot dismiss an otherwise available encounter. Lack of an owned eligible charm is not a reroll: obtain a charm if possible outside the flow, or **Leave her** and continue. Capture rules with no globally usable item for a referenced species block publication, but validation cannot guarantee a particular player owns one. Never claim guaranteed items bypass restricted rarity or direct-rescue authorization.

Explicit charm whitelists have an additional publication/export/import dependency check: **every named charm** must exist, be enabled, be a capture item and be compatible with each referring reachable encounter's species rarity and guaranteed-item rule. Listing a guaranteed charm while **Allow guaranteed capture items** is off blocks complete publication/export even if another listed charm would work. Remove incompatible explicit entries rather than relying on runtime filtering. The pure encounter validator's disabled-item warning does not override this stricter complete-content dependency gate. Omitted all-eligible whitelists carry no explicit charm manifest and use eligible destination/live catalogue items.

**Dependencies.** Publish/rollback validate live species/capture rules. Species manifests record metadata and policy evidence for comparison, including unknown evidence on older revisions; this is informational pinning, not frozen acquisition permission. **Species dependencies changed** asks for review/republish. Current policy can still revoke availability in a pinned run. Package v4 carries required species/capture-item evidence, but does not create species, policy permissions, inventory or acquisition ledger history on the target.

Sources: [encounter schema/limits](../../src/modules/dungeons/content/dungeonEncounters.ts), [pool library](../../portal/src/features/adminDungeons/DungeonSpeciesPoolsPanel.tsx), [pool sheet](../../portal/src/features/adminDungeons/SpeciesPoolSheet.tsx), [encounter controls](../../portal/src/features/adminDungeons/EncounterActivity.tsx), [picker](../../portal/src/features/adminDungeons/DungeonSpeciesPicker.tsx), [policy service](../../src/modules/dungeons/dungeonSpeciesPolicy.ts), [`dungeonSpeciesUnavailableReason`, encounter validation](../../src/modules/dungeons/validation/dungeonEncounterValidation.ts), [`analyseSpeciesPool`, `selectDungeonEncounter`, `decideEncounterInput`](../../src/modules/dungeons/engine/encounters.ts), [species manifest](../../src/modules/dungeons/dungeonSpeciesManifest.ts), [transactional grants](../../src/modules/dungeons/dungeonRunService.ts), [Discord commands](../../src/discord/commands/waifumonDungeon.ts), [presenter](../../src/discord/dungeonPresenter.ts).

### 3.8 Artwork, actor composition and managed Scene Sprites

#### Backgrounds and character art

Dungeon settings → **Pictures → Scene background**, **Dungeon artwork**. Room → **Room background** overrides scene context. Event → **Event picture** supplies a story image. Combat enemy full art/transparent sprite and default placement belong to **Admin — Enemies**, not an arbitrary per-Fight image field. Encounter species art comes from species assets; placement/mirror belongs to the encounter activity. Environmental artwork is managed separately as Scene Sprites. Do not describe a generic independent illustration upload on every activity type.

Dungeon artwork references are nullable shipped paths under `assets/`, or managed category + SHA-256 hash + optional informational name; portable references do not use environment-specific asset IDs. Shipped paths must be relative, cannot start `/` or contain `..`, max 300 characters. Managed hashes are 64 lower-case hex characters. Managed artwork pickers need the correct category. Uploads accept still PNG, WebP and JPEG by bytes and successful decode, maximum 8 MiB, each edge 8–4,096 pixels. Animated files, GIF, SVG, corrupt data and mismatched signatures are rejected. Transparent PNG/WebP is recommended for sprites; JPEG can be valid but is an opaque rectangle. Transparency is not automatically generated.

**Composition canvas and placement.** Canonical 1,200×675 (16:9). Shared **Position** (accessible **Sprite position**) offers **Left**, **Center**, **Right**, **Bottom left**, **Bottom center**, **Bottom right**, stored as left/center/right/bottom-left/bottom-center/bottom-right anchors. **Scale (%)** 10–100 scales sprite height relative to scene height; schema stores 1,000–10,000 BP. **Offset X (px)** integer −600…600; **Offset Y (px)** integer −337…337. Actor schema default bottom-right at 85%, offsets 0. The sprite keeps its aspect ratio; overwide sprites shrink to fit, and placement clamps to scene bounds. Offsets are scene coordinates, not percentages of a browser thumbnail. Transparent padding affects the apparent body position/size.

Backgrounds use cover crop to fill 16:9; design important text/subjects away from edges. Sprite images are contained and clamped, not stretched or intentionally cropped out of frame. A very wide transparent canvas or padded sprite may make the visible body unexpectedly small even at high scale. The reserved runtime Buddy stands bottom-left at about 80% scene height, constrained to 40% width, facing toward the enemy (species left-facing metadata mirrors her). The author does not add a duplicate Buddy as environmental art. Shared preview warns when a sprite covers at least 15% of the reserved Buddy box; that is a visual warning, not collision detection.

**Fallback matrix.** Actual branch implementation in `dungeonRunSceneArtwork` is authoritative; do not promise every fallback is identical:

| Context | Preferred render and degradation |
| --- | --- |
| Combat with usable enemy sprite | Room background → dungeon scene background → dungeon artwork → generated plain stage, with pinned Buddy and enemy. Missing Buddy sprite simply omits her. |
| Combat without usable enemy sprite | Enemy full artwork shown as an opaque scene without Buddy. If absent, room background → dungeon artwork → dungeon background, with Buddy where the combat fallback supports composition; ultimately text. |
| Offered WaifuMon | Species dungeon sprite + Buddy on room/dungeon background or plain stage. Missing sprite falls back to standard species art alone, then room/dungeon art, then text. Actor disappears after captured/rescued/escaped/left. |
| Event without environmental sprites | Event picture as uploaded, without Buddy/enemy; then ordinary background fallbacks. No forced stage crop of a standalone Event picture. |
| Event with environmental sprites | Event picture becomes the 16:9 cover-cropped backdrop, then room/dungeon fallbacks. Environmental layers compose over it; no Buddy/enemy. |
| Rest/Treasure/paths/end | Ordinary room/dungeon art or environmental scene without combat actors. Buddy card remains separate UI, not an actor in every room. |

Managed art is preferred while usable, otherwise shipped paths/further candidates are tried. Missing/undecodable artwork must degrade without losing gameplay controls. Except for the special frozen Scene Sprite protection below, content/revision pinning does not archive every historical managed image byte; replacing a managed asset can affect image resolution of older references. Species/Buddy sprites follow `waifumon/<slug>/<slug>_sprite.webp` conventions. A full-art enemy already painted into its background cannot have an environmental object inserted behind that painted character.

#### Managed environmental catalogue and instances

Open **Admin — Dungeon Scene Sprites**. **Search scene sprites** searches name/identifier/category; include archived entries when restoring. Create/edit fields: **Sprite identifier**, **Sprite display name**, **Sprite category**, **Scene sprite artwork**, **Default placement**, **Mirror sprite**, **Sprite visual layer**, **Preview background**. Category choices: **No category**, **Chest**, **Console**, **Machinery**, **Decoration**, **Other**; these are organizational, not mechanical. Identifier max 100 lower_snake_case; display name 1–100. Artwork must be an active managed `dungeon_scene_sprite` asset. Default placement bottom-center, scale 50%, offsets 0, mirror false, layer background.

Catalogue changes are independent saves with stale revision protection (`SCENE_SPRITE_STALE`); they are not automatically saved by a dungeon's Save draft. **Where it is used** includes draft and revision references; audit history records catalogue changes. Archive removes a sprite from new selection; restore makes it usable again. Delete is refused while any draft or revision references it, including historical revisions. Archive is not a request to erase published history. Replacing catalogue artwork means uploading/selecting a **new asset**, then saving that sprite definition.

Select a room → **Scene Sprites** → **Add room scene sprite** (accessible name), dropdown **Choose a managed sprite…**. Expanded activity has the parallel **Scene Sprites** / **Add activity scene sprite**. Up to 5 instances at each scope, so room+activity can show 10 at once. The same catalogue key may be placed multiple times, each with a unique instance ID. Each added instance copies current defaults; explicit placement/mirror/layer overrides are retained when the catalogue later changes. An API instance may omit individual overrides to inherit catalogue defaults; publication captures the resolved catalogue visual basis. Removing the last instance removes the optional field.

Per-instance **Position**, **Scale (%)**, offsets, arrow controls **Move sprite N left/right/up/down**, **Mirror scene sprite N**, **Layer for scene sprite N** and **Remove** configure visuals. Layer options **Behind Buddy and enemies**, **In front of Buddy and enemies**. There is no drag-on-image placement tool, animation, click target, collision, stateful chest-open art switch or automatic flag binding. A console repair Event and console sprite can share a room but require independent configuration.

Draw order: backdrop → background environmental instances → reserved Buddy → enemy/encounter actor → foreground environmental instances. Within an environmental layer, room instances draw first, then activity instances, in authored order. Environmental art can be placed over an opaque full-art fallback, but cannot separate already flattened character pixels from their background. Missing environmental images are omitted while other layers remain; missing background uses the plain stage when composition supports it.

**Previews.** Enemy appearance and shared ScenePreview request the backend compositor. Catalogue previews show current defaults on a chosen sample background; room/activity previews use draft context. Specific-Event activity previews can use that Event picture; random Event Pool previews use room background because the actual draw is not yet selected. Encounter previews use selected species/sample information, not proof of which species a live pool will draw. Authoring previews use a sample Buddy/assumed facts, not the eventual player's pinned Buddy. Missing artwork/permissions can prevent an image while fields remain meaningful.

**Publication protection.** A revision freezes Scene Sprite keys/names, asset identities/hashes/categories and default visuals; explicit instances remain in the definition. **Scene sprites changed** can appear even when definition text is unchanged. Republish to use new visuals in future runs. Rollback uses the target revision's frozen visuals, even if its catalogue sprite is now archived. Assets pinned by **any** revision are protected against replacement, disabling, category moves and deletion (`ARTWORK_ASSET_IN_USE`); renaming is allowed. Upload a new asset instead of replacing protected bytes. This protection is narrower and stronger than ordinary background/enemy image behavior.

**Portability restriction.** Any room/activity Scene Sprite placement blocks package construction, service export, inspection and import with `package_scene_sprites_unsupported`, for **all** package versions including v4. Local save/publish/runtime is implemented; safe cross-environment dependency bundling is not. No partial portable sprite package is produced. Removing a placement from a draft does not remove it from an older published revision being exported.

Sources: [background picker](../../portal/src/features/adminDungeons/DungeonBackgroundField.tsx), [Scene Sprite page](../../portal/src/features/adminDungeonSceneSprites/SceneSpritesPage.tsx), [instance editor](../../portal/src/features/adminDungeons/SceneSpritesEditor.tsx), [shared placement/preview controls](../../portal/src/features/adminArtwork/ScenePreview.tsx), [`SpritePlacementSchema`, `layoutPlayerBuddy`](../../src/modules/artworkAssets/scenePlacement.ts), [`inspectImage`](../../src/modules/artworkAssets/imageInspection.ts), [scene layers](../../src/modules/artworkAssets/sceneLayers.ts), [composition](../../src/modules/artworkAssets/sceneComposition.ts), [`SceneSpriteInputSchema`, `resolveSceneSpriteInstance`, `sceneSpriteSites`](../../src/modules/dungeons/sceneSprites/sceneSpriteDefinition.ts), [catalogue service](../../src/modules/dungeons/sceneSprites/sceneSpriteService.ts), [snapshot service](../../src/modules/dungeons/sceneSprites/sceneSpriteSnapshot.ts), [asset protection](../../src/modules/artworkAssets/artworkAssetService.ts), [`dungeonRunSceneArtwork`](../../src/discord/dungeonArtwork.ts).

### 3.9 Validation checklist, Discord preview and sandbox

**Checklist.** Editor header **Check again** validates the current definition against server catalogues; checklist button wording includes **Nothing to fix**, **N to finish**, **N to fix**, **N to review**. **Outline → To do** groups friendly findings. **Show me** selects the affected room/path, expands an activity or opens the Event/pool sheet and relevant field where the issue is locatable. Server code/path/message remains available in detail/hover for support. A global problem may navigate to settings instead of an activity.

**Errors versus warnings.** Errors block publish; readable drafts can be saved with repairable errors. Warnings ask for review and can publish: examples include unreachable rooms, unused content, missing optional pictures, disabled required items, many waves/paths and adverse risk incentives. An error-free graph is not proof that every conditional player state can reach its ending: graph reachability ignores locks. **Check again** must be rerun after external catalogue repairs; a prior green check is not a permanent reservation of those dependencies. Publication validates again.

**Discord preview.** Event **How players see it**, pool **Chances** / probability insight, Enemy appearance, ScenePreview and EncounterPreview cover their respective fragments. There is no single universal preview that proves an entire published Discord session and all image fallbacks. Check long text against the real Discord display; the presenter truncates/control-limits where needed. Preview assumptions do not add items, set real flags or grant ownership.

**Sandbox.** **Play the dungeon** opens the dungeon sandbox from the Event tooling. It sends the in-memory draft to the same pure engine used for live sequencing and records effects through a no-op effects port. It writes no player run, inventory, currency, progression, ownership or grants. Controls include **Buddy strength**, **Try different luck** / **Luck #N**, pretend inventory, simulated run flags/completed rooms, **Back one step**, **Start again**, **Skip ahead to the next event**, path buttons and **Leave the dungeon here** at extraction.

Phase 4 adds **Simulated capture rolls**: **Normal deterministic rolls**, **Force success (authoring test)**, **Force failure (guaranteed items still succeed)**; simulated charm quantities, acquisition counts, disabled/already-owned species assumptions, **Sandbox capture charm**, **Simulate capture attempt**. The sandbox reports attempts, chances, rolls, flags, HP, costs, rewards and simulated grants. Capture quotes use a simulated Buddy without a capture bonus; do not promise identical chances to a live player's affinity/rarity/bonus/effects. Simulated ownership is not the same as a cross-run acquisition ledger count.

The same seed and input sequence replay deterministically; **Try different luck** changes seed. **Back one step** replays simulated inputs, not a live undo button. **Skip ahead to the next event** follows/advances engine flow; it does not establish that all preceding combats are balanced for actual players. Forced encounter outcomes are authoring-only. Test Event success/failure through suitable seeds and Buddy assumptions; do not infer that the capture force selector changes every Event SP check. Combat difficulty, live inventory races, transaction rollback, rewards in actual collections, Discord interaction expiry and deployed permissions need integration/manual checks outside a preview.

Sources: [editor checklist/navigation](../../portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx), [friendly issue mapping](../../portal/src/features/adminDungeons/dungeonText.ts), [Event preview](../../portal/src/features/adminDungeons/EventDiscordPreview.tsx), [encounter preview](../../portal/src/features/adminDungeons/EncounterPreview.tsx), [sandbox dialog](../../portal/src/features/adminDungeons/DungeonSandboxDialog.tsx), [`createDungeonSandbox`, `sandboxEffectsPort`](../../src/modules/dungeons/engine/sandbox.ts), [Event authoring analysis](../../src/modules/dungeons/engine/eventAuthoring.ts), [species authoring analysis](../../src/modules/dungeons/engine/speciesAuthoring.ts).

### 3.10 Run completion, extraction, abandonment and defeat

Completion is triggered by finishing an Exit's sequence or an explicit completed ending. Extraction is a voluntary 100%-retention ending only at an extraction room **after** its sequence completes. Abandon is available for an active run, including stuck situations; Discord confirms it as **Abandon Run** and states the cost. Defeat normally follows lost combat or an authored defeat ending. Event damage alone leaves 1 HP and requires an explicit defeat ending if the story should end the run that way.

Discord shows region-available Delves, **Daily Runs**, pinned Buddy/gear/HP, current room/activity, visible outgoing paths, at-risk versus kept loot and ending settlement. An exhausted daily allowance blocks new starts, not resume. **Extract** confirmation explains banking; abandon confirmation warns when extraction could keep everything instead. Completion/extraction/defeat/abandonment release the fighter reservation. Reading a run screen or using **Continue the Delve** is not a fresh game step or reward claim. Old step-bound buttons are rejected/refreshed rather than spending again.

Sources: [`canExtract`, `endRun`, `stepDungeon`](../../src/modules/dungeons/engine/step.ts), [run service](../../src/modules/dungeons/dungeonRunService.ts), [availability reservation](../../src/modules/dungeons/dungeonAvailability.ts), [`buildExtractConfirm`, `buildAbandonConfirm`](../../src/discord/dungeonPresenter.ts), [command handlers](../../src/discord/commands/waifumonDungeon.ts).

## 4. Cross-system recipes

These are implementation recipes with illustrative names/weights, not shipped content, balance recommendations or assertions that named items/species exist. Choose real enabled catalogue dependencies. Save, check, sandbox and publish/enable only when intentionally making content playable.

### 4.1 Three-room starter with combat and treasure

1. **Create dungeon**; name/key, enabled progression currency, at least one region. Keep the initial Entrance as the first room/extraction point.
2. Select Entrance → add next **Combat** room; name it Guard Post. Choose an enabled **Wave 1 enemy**, leave confirm waves, optionally add a small guaranteed reward.
3. Select Guard Post → add next **Treasure** room; name it Cache Exit. In **Rewards**, **+ Add guaranteed reward** → Baddie Shards → 10–20 range. In that room's **Advanced rules**, enable **Completing this room finishes the dungeon**.
4. Confirm paths Entrance → Guard Post → Cache Exit and the designated start. Add a distinct return path only if desired; never add an outgoing path from Cache Exit.
5. Save, **Check again**, inspect To do; sandbox traversal and live-eligible balance separately. Confirm the enabled state and publish when ready for new starts; ordinary created drafts default enabled, unlike imports.

Player result: entrance can extract early; proceeding requires winning Guard Post. Cache Exit presents Treasure, pays once and completes after claim, banking all at-risk currency. Losing Guard Post settles defeat at configured retention. Three rooms suffice; there is no need for a fourth blank Exit. Sources: 3.1–3.5, 3.10.

### 4.2 Locked console Event with SP success/failure and flags

1. Create an **Event** room after the entrance, titled Control Console. Open its Event → **Title**, **What the player reads**; write the locked-console story.
2. Expand the Repair console choice. **What happens?** → dropdown **Always the same result** → **Skill check: it can succeed or fail**. Set **Chance for an average Buddy:** 55%; leave **Advanced** influence at 15 points.
3. Success: **Remember that something happened** → create/select “Console repaired”; add success text. Failure: add failure text, optionally **Lose health** 10% and a distinct “Alarm raised” flag. Do not set repaired on failure.
4. Add a free **Leave it broken** choice with a fixed result and **Carry on**. It provides an unconditional way onward. If adding Turn back, place it on a separate cost-free fixed choice and retain a viable nonretreat fallback.
5. On the onward locked path, **This path opens when → Something was remembered → Console repaired → has happened**; locked message “The console has no power.” Provide a separate safe exit/extraction route if repair fails.
6. Preview weak/average/strong Buddy (40/55/70%); sandbox both check outcomes and inspect flags/path visibility.

Player result: one actual Buddy-adjusted check, one committed success/failure, permanent result for this room in this run. Returning does not retry repair. The console picture/sprite does not implement the lock; the path condition does. Sources: 3.3, 3.6.

### 4.3 Narrative choice unlocks a secret room

1. Create an Event choice **Search the mural**, a fixed outcome that remembers “Secret latch found”; provide an unconditional **Move on** choice.
2. Create a side room and a directed connection from the Event room to it. Select path → **Hidden path** → **This path opens when** checks “Secret latch found has happened”.
3. Give the side room a return path to an ordinary hub or its own valid ending/extraction; provide an open main route regardless of mural choice.
4. Preview the flag false/true and sandbox both choices. Avoid explicit activity routing through the hidden connection, which would bypass its requirement.

Player result: secret path is absent before the narrative unlock, visible afterwards. No discovery percentage or persistent unlock across runs is implied. Sources: 3.2, 3.3, 3.6.

### 4.4 Weighted wild WaifuMon pool

1. **WaifuMon Pools → + New WaifuMon pool**; choose two enabled permitted species A and B, weights 60 and 30; **+ Add Nothing** weight 10, text “Only distant footsteps.” Leave species **once per run** enabled.
2. Room → **Wild Encounter** → **Encounter source → WaifuMon pool**, select it. Write introduction; attempts 3, globally eligible charms, guaranteed allowed unless the design deliberately restricts them.
3. Inspect **Probability insight** with every entry and then already-encountered A. Full draw A/B/Nothing = 60/30/10%; excluding A makes B/Nothing = 75/25%.
4. Sandbox success/failure/leave/Nothing; simulate a reached acquisition cap. Verify the capped species remains in the draw but produces Unavailable if selected.

Player result: one saved weighted offer, up to three charm-consuming attempts, or Leave. 60% selection of A is not a 60% capture chance. No eligible owned charm means no attempt until one is available or the player leaves. Sources: 3.7, 3.9.

### 4.5 Machinery repair unlocks a rescue

1. Put Repair Machinery Event in a hub. Repair choice uses a fixed success or an SP check; success remembers “Power restored”. If requiring parts, choose an existing item, quantity and **used up** deliberately; checked failure spends those parts too.
2. Include a free **Leave the machinery alone** option and a safe main path/extraction. Do not make repair failure a repeatable retreat check.
3. Create a **separate rescue room**, with a locked path from hub requiring “Power restored”. This keeps the rescue room unvisited until unlocked instead of skipping its activity before the flag exists.
4. Add **Rescue**. Choose **Capture rescue (uses a charm)** for ordinary capture behavior. Use **Direct rescue (direct grant)** only after the species has explicit `dungeonAccess` for this dungeon, `directRescue: true` and a finite per-player limit. Choose source and Rescued/Left/Unavailable texts/flags.
5. Give rescue room a valid ending/return route. Test failed repair, success, lack of charms (capture mode), exhausted limit and leaving the offer.

Player result: repair success opens the room; rescue is a separate interaction. Direct mode does not inherit authorization from the Event or path lock. Sources: 3.3, 3.6, 3.7.

### 4.6 Rescue after a boss victory

1. In one ordinary room, order **Boss fight** first and **Rescue** second. Set enemy/waves and boss Rewards; retain default **After losing → End the run in defeat** and **After winning → Continue with the next activity**.
2. Configure Rescue mode/source/rules. Direct mode still requires explicit finite central authorization. For a separate rescue room instead, route boss victory forward to an activity/path setup that cannot be bypassed; a completed-room condition can gate its connection.
3. Put the actual Exit after rescue or mark this room to finish only when its sequence completes. Do not end the run on boss victory if the rescue still must occur.
4. Test boss loss, boss victory+rescue, Leave, Unavailable and cap exhaustion. Review any ungated-direct-rescue warning against actual combat sequencing; it does not create a gate for you.

Player result: defeated players never reach the offer; victors see the rescue and keep boss loot already granted. Direct rescue uses no charm; capture rescue can still fail or be left. Sources: 3.3–3.5, 3.7.

### 4.7 Treasure using weighted loot

1. **Dungeon Loot Tables** → create a table with **Table name** Foreman Cache and stable key. Add one valid guaranteed uncapped item if desired.
2. **Random picks → + Add a group of random picks**; group Equipment or nothing; **Picks** 2. **+ Add reward** → Equipment → rarity R, optional slot; share 3. **+ Add “Nothing”** → share 1. Save the shared table.
3. On a Treasure activity, **Rewards → + Add loot table** → Foreman Cache, rolled once. Add guaranteed 20 Shards only if progression currency is enabled.
4. Review odds: each pick has 75% Equipment, two picks have 93.75% chance of at least one and can give two pieces. Guaranteed table rows also pay once. Use **Test roll**, validate worst-case work, save/publish dungeon.

Player result: the Treasure resolves once; Equipment/items are immediately secured, Shards remain at risk. Later shared table edits require republishing this dungeon to reach future runs. Sources: 3.5.

### 4.8 Buddy, enemy and environmental scene

1. **Admin — Enemies** → choose an enemy with **Transparent sprite**, set right/bottom-right placement and a suitable scale; inspect **Preview background**. Full artwork alone cannot provide separate actor layering.
2. **Admin — Dungeon Scene Sprites** → create Console and Pipe decoration with transparent managed artwork; defaults bottom-center/background and right/foreground respectively. Save each catalogue entry.
3. In dungeon **Pictures**, set **Scene background**; override **Room background** if desired. Add Console through room **Scene Sprites**. Add Pipe through the expanded Fight's **Scene Sprites**; set **Layer for scene sprite N** to **In front of Buddy and enemies** if it should overlap them.
4. Use Position/scale/offset/arrow controls and mirroring to leave the Buddy's left-side reserved box readable. Inspect preview overlap warnings and 16:9 crop. Choose the enemy in the Fight.
5. Save/publish. A live run supplies its own pinned Buddy sprite; no Buddy instance is authored. New catalogue visuals need republish; preserve old assets for frozen revisions.

Player result: backdrop, room background-layer Console, Buddy, enemy, then foreground Pipe; an activity-only sprite is present in that activity context. Missing transparent actor art degrades to documented fallbacks. **This dungeon cannot currently be exported/imported as a package while placements exist.** Sources: 3.4, 3.8.

## 5. Validation and troubleshooting

The checklist translates backend codes/paths into field-specific help; use **Show me**, repair the relevant control, **Check again**, then save/publish in the appropriate order. Exact severities matter: a warning can still represent an unplayable design under some conditions.

| Symptom / representative code | Severity and explanation | Portal repair / verification |
| --- | --- | --- |
| Missing start / `entrance_missing` | Error; designated ID no longer exists. | Room **Advanced rules → Make this the start room**; check graph. |
| Disconnected room / `room_unreachable` | Warning; graph walk from entrance cannot reach it. | Add directed incoming path; inspect **Outline → Rooms/Paths**, then Show me. |
| No ending / `no_ending` | Error; no Exit/extraction/completed ending. | Add Exit or valid extraction point, or explicit completed route. |
| Dead end / `room_no_route_to_exit` | Error for a reachable room without a structural path to an ending. | Add a route to exit/extraction. Remember graph analysis ignores conditional locks. |
| Paths out of Exit / `exit_has_connections` | Error. Exit completes before traversal. | Remove path or make room ordinary; recheck. |
| Empty room / `room_empty` | Warning in applicable ordinary nonentrance/nonextraction rooms. | Add content or intentionally retain a passage. |
| Removed/moved jump / `transition_unknown_action`, `transition_backward` | Error; forward-only sequence. | Repair **What happens afterward?** to a later valid activity. |
| Wrong explicit path / `transition_invalid_connection` | Error; path is not outgoing from this room. | Select the correct outgoing path or normal continuation. |
| Bypassed lock / `transition_locked_connection` | Warning; explicit activity leave does not evaluate path requirement. | Use ordinary player path selection or an actual gate/condition before routing. |
| Entrance retreat / `retreat_from_entrance` | Error, including default blocked Checkpoint. | Explicit nonretreat blocked route or relocate gate; retain entrance Event escape. |
| Invalid memory / `flag_undeclared`, `flag_scope_mismatch` | Error. Label matching is insufficient if IDs differ. | Select declared run flag; create it inline or in **Things this dungeon remembers**. |
| Persistent memory / `flag_scope_unsupported` | Error when writing; player-scope reads are inert warnings. | Use run memories; persistent campaign flags are unsupported. |
| Never set/unused flag | Warning. It may leave a lock permanently shut. | Ensure reachable Event/result/activity writes the same flag; sandbox false/true. |
| Event no open choice / `event_no_open_choice` | Error. Every choice has rule/item requirements. | Add a requirement-free fixed choice; do not just hide unavailable buttons. |
| Entrance Event no onward choice / `event_entrance_no_exit` | Error for every source candidate that can trap the entrance. | Add unrestricted onward choice in each candidate Event, not solely Turn back. |
| Unsafe retreat / `event_check_retreat`, `event_retreat_with_effects`, `event_route_retreat` | Error. Open Events cannot be farmed for effects/rolls. | Free fixed turn-back choice, no effects/rewards/consumption; normal resolved continuation. |
| Missing required item / `event_item_missing` | Error for reachable Event. | **Who can pick this?** choose an existing slug. Import does not create global items. |
| Disabled required item / `event_item_disabled` | Warning; obtaining it may be impossible, but owned quantities still matter. | Re-enable through item maintenance or choose an obtainable requirement; check health notices. |
| Missing/disabled/capped reward item | Error (`reward_item_missing`, `reward_item_disabled`, `reward_item_capped`). | Pick enabled uncapped item in Rewards; restore live dependencies for old runs. |
| Missing/archived/invalid loot table | Error. Wrong legacy expedition table is not a Dungeon Loot Table. | **Open table**, restore/repair or replace reference; follow exact reward site path. |
| No Equipment matches / `reward_equipment_empty` | Error. Slot, rarity and whitelist intersect. | Broaden selector or repair explicit definitions; random rewards support N/R/SR only. |
| Shards without currency / `reward_shards_unset` | Error for Phase 2 grants. | Dungeon settings → **Progression currency**, choose enabled currency. |
| Huge reward despite low chance | Error when worst-case work/payout exceeds bounds. | Reduce amounts/draws/Equipment/affection; probability does not lower hard bound calculations. |
| Empty or all-Nothing loot | Warning. | Add intended grant or accept intentional nonpayment; inspect odds. |
| Wrong Event/pool reference / duplicate IDs | Error; valid structure does not make missing references exist. | Reattach from library; detach before deleting; combine duplicate weighted entries. |
| Pool probabilities differ from authored weights | Usually expected. | Scenario flags/rooms/seen entries change eligible denominator; distinguish relative shares and percentages. |
| Pool draws Nothing unexpectedly | Explicit Nothing or no eligible entries. | Check once-per-run and entry conditions; supply explicit Nothing text if desired. No retry is implied. |
| Species restricted / `species_not_permitted` | Error for referenced encounter species. | Verify exact dungeon key in central species `dungeonAccess`; picker cannot edit authorization. |
| Direct rescue rejected / `rescue_direct_not_permitted`, `rescue_direct_limit_missing` | Error. Ordinary/unlimited capture access is insufficient. | Explicit direct permission + finite limit, or choose capture mode. |
| Exhausted player acquisition cap | Live Unavailable result, not a filtered weight/reroll. | Inspect simulated counts; do not use current ownership as cap history. Author Unavailable text/continuation. |
| No capture item / `capture_no_usable_item`, `capture_settings_invalid` | Error if authored rules have no usable global item or invalid fields. | Permit an eligible charm; whitelist nonempty/unique, attempts 1–3; direct rescue must have no capture fields. |
| No owned charm in live offer | Player inventory issue, not necessarily invalid content. | Leave/continue; author rules cannot create owned charms automatically. |
| Encounter optional/retreat / `encounter_optional`, `encounter_route_retreat` | Error. It already provides Leave and resolves once. | Use result-specific onward routing. |
| Direct rescue appears free / `rescue_ungated` | Warning heuristic. | Add narrative/path/gate prerequisite where intended; inspect boss sequence rather than assuming the warning gates anything. |
| Sprite missing/archived/broken | Error on new publish (`scene_sprite_missing`, `scene_sprite_archived`, `scene_sprite_artwork_missing`). | **Show me** selects instance; restore catalogue/artwork or replace/remove it. Saved drafts may retain unresolved references. |
| Sprite body too small / background cut off | Placement/padding/cover-crop issue, not gameplay. | Trim excessive transparent padding externally; adjust scale/position, compose for 16:9; no freeform drag editor. |
| Protected artwork / `ARTWORK_ASSET_IN_USE` | Mutation refused for revision-frozen sprite assets. | Upload new asset, select it on catalogue entry; do not delete historical dependency. |
| Draft saved but Discord unchanged | Expected lifecycle. | Publish, enable and start a fresh run; existing runs remain pinned. |
| **Loot changed** / **Scene sprites changed** / **Species dependencies changed** | Dependency drift notices; not equivalent statuses. | Review loot snapshot vs visual snapshot vs live species policy; republish deliberately. |
| Reward Health red on old active revision | Restoring only latest draft does not repair it. | Restore old required item/gear; inspect older revision findings, not just current publication. |
| Stale draft/catalogue/import plan | Concurrent edits or target dependency changes. | Reload/review current state, preserve unsaved work before reapplying; never blindly overwrite stale revision. |
| Sandbox succeeds, player cannot enter/capture | Assumptions differ from live eligibility/inventory/policy/bonuses. | Test actual equipment unlock, region, allowance, permission, policy and quantities; sandbox grants are simulated. |
| Export/import Scene Sprites | Explicit `package_scene_sprites_unsupported` error. | No portable path exists yet; do not hand-edit away integrity or dependency gates. |

Sources: [core validator](../../src/modules/dungeons/validation/dungeonValidation.ts), [Event validator](../../src/modules/dungeons/validation/dungeonEventValidation.ts), [encounter validator](../../src/modules/dungeons/validation/dungeonEncounterValidation.ts), [reward validator](../../src/modules/dungeons/validation/dungeonRewardValidation.ts), [Portal issue mapping](../../portal/src/features/adminDungeons/dungeonText.ts), [publication state](../../portal/src/features/adminDungeons/dungeonPublicationModel.ts).

## 6. Publication and deployment implications

### 6.1 Publication, republishing and rollback

Draft content/layout save together but are hashed separately. A layout-only change bumps optimistic draft revision without changing gameplay content hash. Publication compares content plus applicable reward/visual/species evidence; unchanged publication may report **Draft already published** rather than create another identical revision. New reward candidates, table bodies or sprite visuals can require a new publication even if room JSON has not changed.

**Publication** explains current state: **Not published yet**, **Matches publication**, **Dungeon changed**, **Loot changed**, **Dungeon and loot changed**, **Scene sprites changed**, **Species dependencies changed**. Simultaneous drift can have secondary flags/detail even when one primary label wins. A broken dependency blocks publishing until fixed. Species metadata evidence is not a snapshot that overrides live acquisition restrictions.

**History & export → Published revisions** lists history, exports and rollback controls. Rollback moves the publication pointer to an existing immutable revision; it does not copy it into the draft or modify active runs. It validates the target's own pinned reward/visual dependencies for current deliverability. After rollback, draft and publication can deliberately differ. Enable/disable is a separate action; disabling prevents new starts and does not settle/delete an active run.

Phase 2 rewards snapshot table bodies, candidate gear and related evidence. Enemy/gameplay data used by a run is snapshotted as the run starts. Scene Sprite visuals use revision-frozen assets/defaults. Required Event inventory quantities and encounter acquisition policy are live checks. General managed art is not a universal historical blob store. The guide must preserve these distinctions instead of promising “everything is frozen”.

Sources: [`saveDraft`, `publish`, `rollback`, `setEnabled`](../../src/modules/dungeons/dungeonContentService.ts), [reward snapshot](../../src/modules/dungeons/content/dungeonRewardSnapshot.ts), [visual snapshot](../../src/modules/dungeons/sceneSprites/sceneSpriteSnapshot.ts), [species manifest](../../src/modules/dungeons/dungeonSpeciesManifest.ts), [editor history/publication](../../portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx).

### 6.2 Package export/import and compatibility

**History & export → Export** offers **Export saved draft**, **Export current published package**, and per-history **Export revision N**. Save unsaved changes before draft export; published export deliberately exports that revision, not the current draft. Package includes separate editor layout, portable dungeon definition, dependencies and appropriate bundled evidence. Managed artwork references travel, but image bytes do not.

| Package schema | Export content and compatibility |
| --- | --- |
| v1 | Legacy content without Phase 2 bundles, Event or encounter content; original format retained. |
| v2 | Phase 2 rewards with required snapshot/evidence, bundled Dungeon Loot Tables and reward manifests. |
| v3 | Event library/pools/actions, required inventory item evidence and reachable rewards. Event-free export can remain v1/v2. |
| v4 | Encounter or species-pool content, species/capture-item manifests and dependency/integrity hashes; can also carry Events/rewards. |

Current reader supports versions 1–4, refuses unknown versions/members and validates contents rather than trusting the envelope number. Encounter content in v1–v3 is invalid; v4 does not mean Scene Sprite support. Any placements are blocked at export and read/import boundaries. Integrity hashes detect content/evidence changes; they are **not signatures** proving a trusted publisher. Edit in the Portal and re-export instead of manually splicing manifests.

**Import Dungeon** on the list accepts a JSON package and produces a plan before **Apply import as draft**. Review target identity/new-versus-replacement, diff, missing dependencies, enemies, tables, items, species and artwork. Existing enemies are never silently overwritten: decisions include **Use existing target definition**, **Create bundled enemy** for missing entries, **Leave missing in incomplete draft**. Loot conflicts can use the destination table or import a copy under a new key; copies rewrite reward references, including Event success/failure branches. Using target rewards can change gameplay and is shown in review. Shared target catalogues are not overwritten just to match a package.

Items, equipment definitions, species and central policy must already exist/be repaired on the destination. The importer does not create global species/items, transfer player inventory, grant direct-rescue authorization, reset caps or carry acquisition ledger rows. Required Event items and explicit capture items are separately reviewed; all-eligible charm rules depend on the destination catalogue. Species rarity/policy differences are visible in v4 review. Missing managed artwork needs matching usable assets uploaded separately; same asset ID in another environment is not portable identity.

Explicit acceptance of an incomplete draft permits only the supported unresolved dependencies, not malformed content, unsafe integrity or arbitrary schema errors. Review again when target catalogues change; stale plans cannot be reused with altered decisions. Retry an uncertain apply with its original operation identity/request, not a newly invented import that might duplicate content. Import history records outcomes and created dependencies.

New imports are disabled and unpublished. v2/v3/v4 replacement imports also disable and unpublish the target; existing active runs keep their old revisions. **v1 replacement is a legacy exception and preserves existing enable/publication fields**: do not generalize modern replacement semantics to every historical package. A replacement draft still does not mutate a published revision. After review/repair, save, validate, publish and enable deliberately.

Sources: [`createDungeonPackage`, `readDungeonPackage`, `DUNGEON_PACKAGE_SUPPORTED_VERSIONS`](../../src/modules/dungeons/package/dungeonPackage.ts), [import service](../../src/modules/dungeons/package/dungeonImportService.ts), [loot conflict handling](../../src/modules/dungeons/package/dungeonLootImport.ts), [encounter dependencies](../../src/modules/dungeons/package/dungeonEncounterDependencies.ts), [encounter import policy](../../src/modules/dungeons/package/dungeonEncounterImport.ts), [Portal import](../../portal/src/features/adminDungeons/DungeonImportPanel.tsx), [loot review](../../portal/src/features/adminDungeons/DungeonLootImportReview.tsx), [import history](../../portal/src/features/adminDungeons/DungeonImportHistory.tsx).

### 6.3 Environment readiness versus author actions

Publishing content is not deploying application code or running migrations. The described controls require a matching backend/Portal build and database migrations. Scene Sprite catalogue/snapshots were added in migrations 0066/0067; Phase 4 acquisition support includes migration 0068. This source audit does not establish which environments have them applied. The deployer must also supply managed artwork storage, shipped assets, enabled dependency catalogues, species access configuration, Portal roles and the daily timezone/limit.

This extraction did not run migrations, publish a dungeon, modify live content or establish production readiness. The creator guide should send environment rollout/operator procedures to the maintained release-readiness material rather than present them as ordinary authoring clicks. Relevant context: [Scene Sprites](scene-sprites.md), [Phase 4 readiness](phase4-release-readiness.md), [Phase 4 integration completion](phase4d1-completion.md).

## 7. Known limitations and verification boundaries

**Implemented but bounded:** forward-only intra-room routing; directed graph traversal; 200 rooms/600 connections/60 activities per room; single-actor sequential combat waves; run-scoped conditions; Events ≤5 choices; capture attempts ≤3; encounters ≤40/direct rescues ≤3; per-scope Scene Sprite limit 5; reward work/payout limits. Validation is static and does not prove lock satisfiability or combat balance.

**Unsupported/planned:** persistent player/campaign flag writes; arbitrary condition scripting; Event effects that launch battles/move rooms/trigger Events/spend currency; generic `choice`, `objective`, `random_outcome` activity types; arbitrary stat-check selection beyond SP; backward activity loops; per-dungeon Energy/level/quest access settings; per-zone daily caps/bonus-attempt grants; global cross-dungeon species cap; global isolation from every other player activity; author-set capture difficulty/affixes/multipliers; random SSR+ Equipment; recursive loot tables; interactive/animated/stateful Scene Sprites; scene drag handles; Scene Sprite package portability. Use separate supported activities/flags where applicable, not invented JSON members.

**Unverified — environment and visual execution:** no connected running Portal or Discord playthrough was used for this extraction; deployed responsive layout, rendering of screenshots, role assignments, enabled catalogue entries, current daily limit/timezone, actual authored dungeon names/species/charms, storage availability and staging/production migration state remain unverified. Recipe dependencies are placeholders. Confirm them on the target environment before writing screenshots or claiming a ready-to-play example.

**Unverified — live outcomes:** this documentation-only pass did not execute acquisition transactions, equipment grants, concurrent item spends, duplicate-copy Keep/Salvage interactions, expired Discord buttons, all fallback image decodes or live settlement. Their stated behavior is source-verified, not freshly integration-tested here. Sandbox previews cannot replace those checks. There is no claim that a given illustrative boss is balanced for a real loadout.

**Legacy boundaries:** older revisions can lack species evidence or optional fighter bonus fields; UI may report unknown evidence. Existing legacy Treasure remains supported rather than automatically converted. Pinning definitions does not retroactively add fields, archive every image or freeze live policy/inventory. A guide should label legacy conversion and package exceptions explicitly rather than apply new-author defaults to all saved content.

## 8. Source index

Each feature above includes local citations. This index groups implementation entry points for the downstream writer/reviewer; it does not require the writer to infer missing behavior from filenames.

| Area | Source and principal symbols / role |
| --- | --- |
| Portal entry points | [navigation](../../portal/src/app/navigation.ts), [router](../../portal/src/app/router.tsx): sidebar labels, route aliases, permission gates. |
| List/global settings | [DungeonsListPage](../../portal/src/features/adminDungeons/DungeonsListPage.tsx): catalogue, creation/import links, daily limit, currency metadata, Reward Health. |
| Creation | [DungeonCreatePage](../../portal/src/features/adminDungeons/DungeonCreatePage.tsx), [dungeonModel](../../portal/src/features/adminDungeons/dungeonModel.ts): `keyFromName`, `starterDungeon`. |
| Editor lifecycle | [DungeonZoneEditorPage](../../portal/src/features/adminDungeons/DungeonZoneEditorPage.tsx), [DungeonEditorHeader](../../portal/src/features/adminDungeons/DungeonEditorHeader.tsx): settings, optimistic save, validation, publication/history/export. |
| Graph and rooms | [DungeonGraphView](../../portal/src/features/adminDungeons/DungeonGraphView.tsx), [RoomInspector](../../portal/src/features/adminDungeons/RoomInspector.tsx), [dungeonRoomTemplates](../../portal/src/features/adminDungeons/dungeonRoomTemplates.ts): `addTemplateRoom`, `connectionProblem`, `roomPresentation`. |
| Actions/paths/rules | [ActivityCard](../../portal/src/features/adminDungeons/ActivityCard.tsx), [ConnectionInspector](../../portal/src/features/adminDungeons/ConnectionInspector.tsx), [DungeonConditionEditor](../../portal/src/features/adminDungeons/DungeonConditionEditor.tsx), [RunFlagsEditor](../../portal/src/features/adminDungeons/RunFlagsEditor.tsx). |
| Definition vocabulary | [dungeonDefinition](../../src/modules/dungeons/content/dungeonDefinition.ts): `DungeonDefinitionSchema`, action/room/connection schemas, `ACTION_OUTCOMES`, `dungeonDependencies`; [identifiers](../../src/modules/dungeons/content/dungeonIdentifiers.ts); [primitives](../../src/modules/dungeons/content/dungeonPrimitives.ts): conditions/artwork/destinations. |
| Validation/navigation | [dungeonValidation](../../src/modules/dungeons/validation/dungeonValidation.ts): `validateDungeonDefinition`; [dungeonText](../../portal/src/features/adminDungeons/dungeonText.ts): friendly issue text/targets. |
| Content lifecycle | [dungeonContentService](../../src/modules/dungeons/dungeonContentService.ts): `createDungeonContentService`, draft/publication/rollback/export/health; [admin routes](../../src/api/routes/v1/admin/dungeons.ts). |
| Run/access | [dungeonRunService](../../src/modules/dungeons/dungeonRunService.ts): transactional start/step/grants; [dungeonAllowanceService](../../src/modules/dungeons/dungeonAllowanceService.ts); [dungeonAvailability](../../src/modules/dungeons/dungeonAvailability.ts). |
| Engine sequence | [step](../../src/modules/dungeons/engine/step.ts): `startDungeonRun`, `stepDungeon`, `runSequence`, `enterRoom`, `completeRoom`, `canExtract`; [view](../../src/modules/dungeons/engine/view.ts): `describeDungeonRun`; [routing](../../src/modules/dungeons/engine/routing.ts): `destinationFor`, `forwardIndex`; [conditions](../../src/modules/dungeons/engine/conditions.ts): `evaluateCondition`. |
| Enemies/combat | [enemyDefinitions](../../src/modules/combat/enemyDefinitions.ts): `CombatEnemyDefinitionSchema`, `enemyCombatantInput`; [enemy editor](../../portal/src/features/adminEnemies/EnemyEditorPage.tsx); [combat](../../src/modules/dungeons/engine/combat.ts): `selectWaveEnemy`, `fightWave`; [fighter](../../src/modules/dungeons/dungeonFighter.ts): snapshots/modifiers/bonuses. |
| Reward schemas/resolution | [dungeonRewards](../../src/modules/dungeons/content/dungeonRewards.ts): `DUNGEON_REWARD_LIMITS`, bundle/table schemas, work validation; [lootResolver](../../src/modules/dungeons/engine/lootResolver.ts): deterministic resolution/analysis; [rewardSelector](../../src/modules/equipment/rewardSelector.ts): strict gear candidates. |
| Reward publication/repair | [reward snapshot](../../src/modules/dungeons/content/dungeonRewardSnapshot.ts), [reward validation](../../src/modules/dungeons/validation/dungeonRewardValidation.ts), [loot service](../../src/modules/dungeons/dungeonLootTableService.ts), [Treasure conversion](../../src/modules/dungeons/dungeonTreasureConversion.ts). |
| Reward UI | [ActivityRewards](../../portal/src/features/adminDungeons/ActivityRewards.tsx), [RewardForm](../../portal/src/features/adminDungeonLoot/RewardForm.tsx), [LootSections](../../portal/src/features/adminDungeonLoot/LootSections.tsx), [EquipmentPicker](../../portal/src/features/adminDungeonLoot/EquipmentPicker.tsx), [LootOdds](../../portal/src/features/adminDungeonLoot/LootOdds.tsx), [TestRollDialog](../../portal/src/features/adminDungeonLoot/TestRollDialog.tsx), [RewardHealthPanel](../../portal/src/features/adminDungeons/RewardHealthPanel.tsx). |
| Risk/publication UI | [CurrencyRiskSettings](../../portal/src/features/adminDungeons/CurrencyRiskSettings.tsx), [dungeonRiskModel](../../portal/src/features/adminDungeons/dungeonRiskModel.ts): `NEW_DUNGEON_RISK`, `effectiveAbandon`, `parseRetention`; [dungeonPublicationModel](../../portal/src/features/adminDungeons/dungeonPublicationModel.ts): `publicationState`. |
| Event schema/engine | [dungeonEvents](../../src/modules/dungeons/content/dungeonEvents.ts): Event/choice/check/pool/effect/outcome schemas; [events](../../src/modules/dungeons/engine/events.ts): `analyseEventPool`, `selectDungeonEvent`, `describeEventChoice`, `applyEventEffects`; [eventChecks](../../src/modules/dungeons/engine/eventChecks.ts): chance/roll; [validation](../../src/modules/dungeons/validation/dungeonEventValidation.ts). |
| Event UI | [DungeonEventsPanel](../../portal/src/features/adminDungeons/DungeonEventsPanel.tsx), [EventSourcePicker](../../portal/src/features/adminDungeons/EventSourcePicker.tsx), [EventEditorSheet](../../portal/src/features/adminDungeons/EventEditorSheet.tsx): choice/check/Then controls; [EventPoolSheet](../../portal/src/features/adminDungeons/EventPoolSheet.tsx); [dungeonEventModel](../../portal/src/features/adminDungeons/dungeonEventModel.ts): `EVENT_PRESETS`, `setChoiceCheck`. |
| Encounter schema/engine | [dungeonEncounters](../../src/modules/dungeons/content/dungeonEncounters.ts): `DUNGEON_ENCOUNTER_LIMITS`, capture/access/pool/result schemas; [encounters](../../src/modules/dungeons/engine/encounters.ts): `analyseSpeciesPool`, `selectDungeonEncounter`, `checkEncounterAvailability`, `decideEncounterInput`; [validation](../../src/modules/dungeons/validation/dungeonEncounterValidation.ts). |
| Species policy/evidence | [dungeonSpeciesPolicy](../../src/modules/dungeons/dungeonSpeciesPolicy.ts), [dungeonSpeciesManifest](../../src/modules/dungeons/dungeonSpeciesManifest.ts), [dungeonEncounterAuthoring](../../src/modules/dungeons/dungeonEncounterAuthoring.ts): live policy, counts, authoring catalogue and metadata comparison. |
| Encounter UI | [DungeonSpeciesPoolsPanel](../../portal/src/features/adminDungeons/DungeonSpeciesPoolsPanel.tsx), [SpeciesPoolSheet](../../portal/src/features/adminDungeons/SpeciesPoolSheet.tsx), [DungeonSpeciesPicker](../../portal/src/features/adminDungeons/DungeonSpeciesPicker.tsx), [EncounterActivity](../../portal/src/features/adminDungeons/EncounterActivity.tsx), [SpeciesDependencyStatus](../../portal/src/features/adminDungeons/SpeciesDependencyStatus.tsx). |
| Authoring simulations | [DungeonSandboxDialog](../../portal/src/features/adminDungeons/DungeonSandboxDialog.tsx), [EventScenarioControls](../../portal/src/features/adminDungeons/EventScenarioControls.tsx), [eventAuthoring](../../src/modules/dungeons/engine/eventAuthoring.ts), [speciesAuthoring](../../src/modules/dungeons/engine/speciesAuthoring.ts), [sandbox](../../src/modules/dungeons/engine/sandbox.ts): same engine, no-op effects. |
| Artwork/composition | [ScenePreview](../../portal/src/features/adminArtwork/ScenePreview.tsx): `PlacementControls`, `ScenePreview`; [imageInspection](../../src/modules/artworkAssets/imageInspection.ts): `inspectImage`; [scenePlacement](../../src/modules/artworkAssets/scenePlacement.ts); [sceneComposition](../../src/modules/artworkAssets/sceneComposition.ts); [sceneLayers](../../src/modules/artworkAssets/sceneLayers.ts). |
| Scene Sprite catalogue | [SceneSpritesPage](../../portal/src/features/adminDungeonSceneSprites/SceneSpritesPage.tsx), [SceneSpritesEditor](../../portal/src/features/adminDungeons/SceneSpritesEditor.tsx), [definition](../../src/modules/dungeons/sceneSprites/sceneSpriteDefinition.ts): `resolveSceneSpriteInstance`; [service](../../src/modules/dungeons/sceneSprites/sceneSpriteService.ts); [snapshot](../../src/modules/dungeons/sceneSprites/sceneSpriteSnapshot.ts): `freezeSceneSprites`, `pinnedSceneSpriteCatalogue`; [artworkAssetService](../../src/modules/artworkAssets/artworkAssetService.ts): protected dependencies. |
| Discord | [dungeonPresenter](../../src/discord/dungeonPresenter.ts): run/cards/confirmation/button labels; [dungeonArtwork](../../src/discord/dungeonArtwork.ts): `dungeonRunSceneArtwork`, actor/background fallback; [waifumonDungeon](../../src/discord/commands/waifumonDungeon.ts): interaction handling/navigation. |
| Packages | [dungeonPackage](../../src/modules/dungeons/package/dungeonPackage.ts): schemas, `createDungeonPackage`, `readDungeonPackage`, version/integrity/sprite gates; [import service](../../src/modules/dungeons/package/dungeonImportService.ts), [loot import](../../src/modules/dungeons/package/dungeonLootImport.ts), [encounter import](../../src/modules/dungeons/package/dungeonEncounterImport.ts); [DungeonImportPanel](../../portal/src/features/adminDungeons/DungeonImportPanel.tsx). |

## 9. Documentation gaps or unclear UI

These are documentation/research findings, not proposed code changes in this task. Existing documents were left untouched.

| Finding | Implementation evidence / direction for the creator-guide writer |
| --- | --- |
| General dungeon reference still describes itself through Phase 3 and lists WaifuMon encounters as future Phase 4. | [docs/dungeons.md](../dungeons.md), opening and limitations, is historical in this respect. Current EncounterActivity, schemas, run service, package v4 and [capture guide](dungeon-captures-guide.md) implement Phase 4. Do not repeat the older scope statement as a current limitation. |
| Event SP-check selector is easy to overlook. | Expanded choice → **What happens?** → currently **Always the same result**. **Choice N result kind** is an accessible-only label. A screenshot/callout should show the actual dropdown before enabling the check, followed by the revealed slider and Advanced influence. |
| Event guide describes jumping forward under result Then. | [Event guide](dungeon-events-guide.md), Results section, is broader than the current visible `EventEditorSheet` menu. That dropdown creates carry-on/room-complete/retreat/endings; forward jump/path routing belongs to `ActivityCard`. The schema's Event outcome Then is also narrower than the general action destination union. Use flags and supported activity flow for recipes. |
| “Any Event content exports v3” needs qualification. | Event guide Export section and general dungeon docs predate combined Phase 4 packages. `createDungeonPackage` chooses v4 when encounters/species pools coexist, otherwise v3 for Event content. |
| Scene Sprite package description mentions v1/v2/v3. | [Scene Sprite docs](scene-sprites.md) correctly document the block, but a current guide should explicitly include v4: the implementation gates placements across every supported version. v4 adds encounter manifests, not sprite portability. |
| Creation/risk defaults can be conflated with import/schema defaults. | `starterDungeon` has one extraction Entrance; ordinary creation defaults enabled/unpublished, whereas package creation is disabled/unpublished. `NEW_DUNGEON_RISK` writes defeat 50% / abandon 0%; schema fallback is defeat 0%, abandonment follows defeat. Label examples precisely. |
| Checkpoint, Boss, Shortcut and sprite category names can imply extra mechanics. | Checkpoint is a condition gate, Boss the same combat engine with different presentation, Shortcut ordinary traversal, sprite categories organizational. None independently creates savepoints, AI, teleportation, loot or click behavior. |
| “Once per run” is not “once acquired”. | Event selected identity/species selected identity is recorded before a successful choice/capture. Pool exclusions use seen state. Acquisition caps use a different cross-run ledger. Explain both, with a return/failed-capture example. |
| “Published means frozen” is too broad. | Definitions, Phase 2 reward evidence and Scene Sprite visuals have distinct snapshots; actual required inventory and species policy are live. Ordinary managed image storage is not universal historical byte retention. Reward Health and species dependency badges answer different questions. |
| Branch unlocking can fail if an activity was skipped on first visit. | `runSequence` skips false `when` and completed rooms do not replay. For repair-then-rescue that may occur later, lock entry into a separate unvisited rescue room rather than placing an initially false rescue in an already completed room. |
| Sandbox resembles play but uses assumptions. | No-op effects, simulated Buddy/capture facts, forced capture rolls and replay controls need an explicit explanation. It does not establish deployed permissions, actual charm ownership, concurrent behavior, real collection receipts or production readiness. |
| Package lifecycle has a legacy exception. | v2–v4 replacement disables/unpublishes; v1 replacement preserves existing enable/publication fields. Describe the selected package version and reviewed plan rather than a universal replacement rule. |
| UI screenshots and deployed catalogue examples remain unavailable in this research. | **Unverified.** Take screenshots and choose actual environment-approved items/species/enemies during guide production. The exact labels, configuration, formulas, limits, expected Discord behavior, eight recipes and troubleshooting above are sufficient to write its technical content without rereading the repository. |

Technical sufficiency: this reference covers the implemented creator workflow across Phases 1–4 and Scene Sprites, including dependencies, failure paths and unsupported capabilities. A polished standalone guide can be produced from it; final screenshots, real catalogue choices and environment-specific operating instructions require target-environment verification.
