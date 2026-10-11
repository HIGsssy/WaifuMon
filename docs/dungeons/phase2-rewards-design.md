# Dungeon overhaul Phase 2B: loot and combat rewards design

**Date:** 2026-10-11. **Checkout:** `Delve` at `7b6b311`; the only uncommitted path is `docs/dungeons/` (the Phase 2A audit and this document). **Status:** design for approval. Nothing here is implemented, and no application code, migration or test was changed to produce it.

**Inputs:** `docs/dungeons/phase2-rewards-audit.md` (Phase 2A), plus a targeted read of the code each decision rests on. Where this document says *verified*, the cited code was read for this design; everything else cites the audit.

**How to read this.** Sections 1–11 are the design. Section 12 is the work, cut into tasks small enough to review one at a time. Section 13 lists what needs your approval before Codex starts. Words used throughout:

| Term | Meaning |
| --- | --- |
| Activity | One action in a room: Combat, Boss, Treasure, and later events. The schema calls it an action. |
| Reward bundle | The rewards configured on one activity. |
| Loot table | A reusable, named dungeon-only reward list in the new catalogue. |
| At-risk | Earned in the run, held on the run, paid out only when the run settles. |
| Secured | Granted to the player at the moment the activity is completed. |
| Claim | The stored record that an activity's rewards were resolved and paid in this run. |
| Legacy reward | The Phase 1A treasure shape: up to two expedition tables plus a currency range. |

---

## 1. Gameplay rules: approved and provisional

### 1.1 Approved (from the brief; treated as requirements)

1. An activity can combine guaranteed rewards, independent percentage drops and weighted loot-table rolls, in any mix.
2. Reward types: WaifuBux, Essence, Baddie Shards, inventory items (charms and salvage included), equipment, and affection.
3. Combat and Boss activities carry rewards directly. They pay after the whole activity is won, meaning the final wave.
4. Boss loot is bigger because the author configured it so. There is no boss multiplier in code.
5. Dungeon loot tables are their own catalogue, separate from expedition, guild-boss, World Encounter and vendor content.
6. Baddie Shards and WaifuBux earned in a run are at-risk. Equipment, items, Essence and affection are secured.
7. Only run-earned currency is at risk. A player's existing balance is never reduced.
8. Extraction and completion bank 100%. A disconnect leaves the run active and settles nothing.
9. Published revisions and active runs keep the reward behaviour they have today.

### 1.2 Provisional (recommended defaults, need approval)

| Rule | Recommended default | Where configured |
| --- | --- | --- |
| Defeat | Keep 50% of at-risk currency | Per dungeon |
| Voluntary abandon | Keep 0% | Per dungeon |
| One rate for both currencies | Yes | n/a |
| Rounding | Banked amount rounds down, per currency | Fixed (existing rule) |
| Essence | Gets the participating Buddy's pinned `essence_gain` bonus | Fixed |
| Affection | Gets the participating Buddy's pinned `affection_gain` bonus | Fixed |

### 1.3 Should defeat and abandon rates be configurable per dungeon now?

**Recommendation: yes, now, because the schema is already per dungeon.** *Verified:* `DungeonSettingsSchema` holds `defeatCurrencyRetentionBasisPoints` (default 0), and `endRun` applies that single value to both defeat and abandon (`src/modules/dungeons/engine/step.ts:113–114`). So today every dungeon loses 100% on both, and the two outcomes cannot differ.

The smallest change that delivers the approved direction and leaves old content untouched:

* Keep `defeatCurrencyRetentionBasisPoints` exactly as it is, default included.
* Add one optional field, `abandonCurrencyRetentionBasisPoints`. When it is absent, abandon uses the defeat value, which is precisely today's behaviour.
* The Portal writes both values explicitly for a newly created dungeon: defeat 5000, abandon 0. The Zod default does not change.

A global setting would be a second source of truth beside a field that already exists, and changing the Zod default would silently change the hash and the behaviour of every stored dungeon (see 9.1). Neither is worth it.

The editor does not show basis points. It shows a "Risk" choice with three presets (Keep half, Keep nothing, Keep everything) and a custom percentage under Advanced.

---

## 2. Reward data model

All new schemas live in a new pure module, `src/modules/dungeons/content/dungeonRewards.ts`. It imports only Zod and the shared equipment selector schema, so the engine can use it without breaking `engineArchitecture.test.ts`.

### 2.1 One rule that protects every existing hash

*Verified:* `dungeonContentHash` hashes the **parsed** definition with defaults filled in (`package/dungeonPackage.ts:122–125`). A new field with a Zod default would therefore appear in every old definition and change its hash. That would mark every published dungeon as "draft differs" and make every existing v1 package fail verification.

**Rule: every field Phase 2 adds to `DungeonDefinitionSchema` is `.optional()` with no default.** An existing definition must parse to byte-identical canonical JSON. Task T1 pins this with a golden hash of `content/dungeons/examples/service_tunnels.dungeon.json`.

### 2.2 Grants

```ts
/** Inclusive. The editor shows one number until the author asks for a range. */
interface QuantityRange { min: number; max: number }   // integers, max >= min

type RewardGrant =
  | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence'; amount: QuantityRange }
  | { type: 'item'; item: string; quantity: QuantityRange }        // item slug
  | { type: 'equipment'; selector: EquipmentRewardSelector }       // exactly one instance
  | { type: 'affection'; amount: QuantityRange };
```

* `shards` means the dungeon's `settings.progressionCurrency`, as today. For live content that is `ascension_currency`, displayed with the currency's live name (Baddie Shards). A `shards` grant in a dungeon with no progression currency is a publish error.
* `item` covers charms (`category: 'capture'`) and salvage (`category: 'salvage'`). They are ordinary inventory rows; there is no charm grant type.
* `equipment` reuses `EquipmentRewardSelectorSchema` from `equipment/rewardSelector.ts` unchanged. One entry yields one instance. More instances come from more entries or more draws.
* `affection` always goes to the run's participating Buddy (section 7). There is no recipient field.
* Player XP, WaifuMon XP, Hunt Energy and Salvaged Components are not reward types in Phase 2.

Risk class is a property of the type, not a field the author sets:

| Grant | Class |
| --- | --- |
| `currency: shards`, `currency: waifubux` | At-risk |
| `currency: essence`, `item`, `equipment`, `affection` | Secured |

### 2.3 The activity bundle

```ts
interface GuaranteedEntry { id: string; grant: RewardGrant }
interface ChanceEntry     { id: string; chanceBasisPoints: number; grant: RewardGrant }  // 1..9999
interface TableDraw       { id: string; table: string; draws: number }                    // loot table key, 1..10

interface RewardBundle {
  guaranteed: GuaranteedEntry[];   // every entry pays
  chances: ChanceEntry[];          // each rolls on its own
  tables: TableDraw[];             // each rolls its table `draws` times
}
```

Entry IDs follow `DUNGEON_ID_PATTERN`, are generated by the editor, are unique within the bundle, and survive reordering. Authors never see them. They are what makes a draw and an equipment instance identifiable (section 5.3).

Where the bundle attaches:

```ts
// combat and boss: new optional field
{ type: 'combat' | 'boss', ...combatFields, rewards?: RewardBundle }

// treasure: `reward` becomes optional, `rewards` is added, exactly one must be present
{ type: 'reward', ...actionBase, reward?: RewardSpec, rewards?: RewardBundle }
```

A treasure activity with both `reward` and `rewards`, or neither, is a schema error. Future non-combat activity types take the same optional `rewards` field and call the same claim routine on their success outcome. Nothing else about them is designed here.

### 2.4 Example: a boss using all three modes

```json
{
  "id": "foreman",
  "type": "boss",
  "waves": [{ "enemy": { "key": "scrap_foreman" } }],
  "rewards": {
    "guaranteed": [
      { "id": "g-shards", "grant": { "type": "currency", "currency": "shards", "amount": { "min": 40, "max": 60 } } },
      { "id": "g-bux",    "grant": { "type": "currency", "currency": "waifubux", "amount": { "min": 500, "max": 500 } } },
      { "id": "g-bond",   "grant": { "type": "affection", "amount": { "min": 3, "max": 3 } } }
    ],
    "chances": [
      { "id": "c-charm", "chanceBasisPoints": 2500,
        "grant": { "type": "item", "item": "velvet_charm", "quantity": { "min": 1, "max": 1 } } },
      { "id": "c-gear", "chanceBasisPoints": 500,
        "grant": { "type": "equipment", "selector": { "rarities": ["epic"], "slots": ["attack"] } } }
    ],
    "tables": [
      { "id": "t-hoard", "table": "scrapheap_boss_hoard", "draws": 2 }
    ]
  }
}
```

(The selector fields shown are illustrative; the real shape is whatever `EQUIPMENT_REWARD_SELECTOR_SHAPE` defines.)

### 2.5 Bounds

| Limit | Value | Reason |
| --- | --- | --- |
| Guaranteed entries per bundle | 12 | Keeps the editor readable |
| Chance entries per bundle | 12 | Same |
| Table draws per bundle | 4 references, 1–10 draws each | Bounds work per claim |
| `chanceBasisPoints` | 1–9999 | 0% is a mistake, 100% belongs under Guaranteed |
| Item quantity | 1–999 | |
| Shards, WaifuBux amount | 1–1,000,000 per entry | Matches the legacy currency bound |
| Essence amount | 1–100,000 per entry | |
| Affection amount | 1–500 per entry | No affection cap exists anywhere; see 13 |
| Worst-case equipment instances per activity | 10 | Each is a row, an audit event and a roll |
| Worst-case resolved draws per activity | 200 | Hard ceiling on one step's work |
| Worst-case affection per activity | 1,000 | |
| Worst-case at-risk total per dungeon, per currency | 2,000,000,000 | `unbanked_*` columns are `integer` |

"Worst case" is computed statically from the bundle and the table bodies it references, assuming every chance hits, every pool draw picks its largest entry, and every range rolls its maximum. A claim is paid once per activity per run, so the per-dungeon total is a simple sum over activities.

---

## 3. The Dungeon Loot Table catalogue

### 3.1 Storage

A new table, `dungeon_loot_tables`. It shares nothing with `reward_tables`: no kind column, no seed file, no route, no Portal page.

```ts
interface DungeonLootTableRecord {
  key: string;                    // portable, lower_snake_case, max 64, immutable after create
  name: string;                   // 1..100
  description: string;            // 0..600
  tier: 'common' | 'rare' | 'boss' | 'legendary' | null;   // a label for filtering, no mechanical effect
  archivedAt: string | null;      // archived tables are hidden from pickers
  body: DungeonLootTableBody;
  contentHash: string;            // sha256 of the canonical parsed body only
  revision: number;               // optimistic lock, starts at 1, +1 per content or metadata change
  origin: 'portal' | 'import' | 'converted' | 'seed';
  createdAt: string; createdBy: string | null;
  updatedAt: string; updatedBy: string | null;
}
```

`contentHash` covers the body alone. Renaming a table or changing its tier is not a gameplay change and must not make dungeons look out of date.

A second table, `dungeon_loot_table_events`, is append-only: `created`, `updated`, `archived`, `restored`, `deleted`, `imported`, `converted`, each with actor, revision, previous and new hash.

There is no publish step for a table. A table is a mutable working copy; it becomes immutable only by being embedded in a dungeon revision at publication (section 9).

### 3.2 The table body

```ts
type PoolEntry =
  | { id: string; weight: number; grant: RewardGrant }
  | { id: string; weight: number; nothing: true };     // an explicit "no drop" slot

interface LootPool {
  id: string;
  name: string;          // "Rare gear", shown in the editor and in Test Roll
  draws: number;         // 1..10, each draw picks one entry, with replacement
  entries: PoolEntry[];  // 1..40, weight 1..1,000,000
}

interface DungeonLootTableBody {
  guaranteed: GuaranteedEntry[];   // max 12, pays on every draw of the table
  chances: ChanceEntry[];          // max 20, each rolls on every draw of the table
  pools: LootPool[];               // max 6
}
```

Design choices:

* **No-drop is a weighted "Nothing" entry, and that is the only way to express it.** A pool has no separate chance gate. One concept means the percentages the editor shows are the whole truth. A pool with one item at weight 1 and Nothing at weight 3 drops that item 25% of the time.
* **Draws are with replacement.** A pool drawn twice can give the same entry twice. Unique draws are not offered.
* **No nested tables.** A table cannot reference another table. Nothing in the brief needs it, and it would add cycles, depth limits and probability maths the author cannot check by eye. An activity can already reference up to four tables.
* **A table is drawn as a whole.** "2 draws" of a table means its guaranteed entries pay twice, its chance entries roll twice, and each pool makes `2 × pool.draws` picks.

### 3.3 Example

```json
{
  "key": "scrapheap_boss_hoard",
  "name": "Scrapheap Boss Hoard",
  "description": "Main loot for the Service Tunnels foreman.",
  "tier": "boss",
  "body": {
    "guaranteed": [
      { "id": "scrap", "grant": { "type": "item", "item": "bent_gear", "quantity": { "min": 2, "max": 4 } } }
    ],
    "chances": [
      { "id": "essence", "chanceBasisPoints": 3000,
        "grant": { "type": "currency", "currency": "essence", "amount": { "min": 5, "max": 10 } } }
    ],
    "pools": [
      { "id": "gear", "name": "Boss gear", "draws": 1, "entries": [
        { "id": "rare", "weight": 60, "grant": { "type": "equipment", "selector": { "rarities": ["rare"] } } },
        { "id": "epic", "weight": 15, "grant": { "type": "equipment", "selector": { "rarities": ["epic"] } } },
        { "id": "none", "weight": 25, "nothing": true }
      ] }
    ]
  }
}
```

### 3.4 Lifecycle and where-used

| Operation | Rule |
| --- | --- |
| Create | Key unique. `409` on a taken key. |
| Update | Requires `expectedRevision`; a mismatch returns `409` with the current revision and editor, and the Portal keeps the author's edits (same pattern as dungeon drafts). |
| Archive | Always allowed. Hidden from pickers. A draft that still references it gets a publish error. Published revisions are unaffected because they carry their own copy. |
| Restore | Clears `archivedAt`. |
| Delete | Only an archived table that no dungeon **draft** references. Refused with the list of drafts otherwise. Historical revisions do not block deletion; they hold embedded copies. |
| Where used | Lists drafts that reference the key, and published revisions that embed it, each marked "same as current" or "older version". |

Archiving or editing a table never changes what a published revision pays. The lever for stopping payouts in an emergency is the existing dungeon `enabled` switch, which stops new runs; active runs finish on what they were promised.

### 3.5 API and permissions

Routes under `/api/v1/admin/dungeons/loot-tables`, registered in the existing `admin/dungeons.ts` route group:

| Route | Permission |
| --- | --- |
| `GET /` (list, filter by tier, archived, search), `GET /:key`, `GET /:key/where-used`, `GET /:key/history` | `dungeons.read` |
| `POST /`, `PUT /:key`, `POST /:key/archive`, `POST /:key/restore`, `DELETE /:key`, `POST /:key/duplicate` | `dungeons.write` |
| `POST /validate` (body in, issues out, nothing written) | `dungeons.read` |
| `POST /test-roll` (section 11) | `dungeons.read` |

**Recommendation: reuse `dungeons.read` and `dungeons.write`.** A dungeon author must not need `rewards.write`, which governs expedition and guild-boss tables. A table edit cannot reach players without `dungeons.publish`, so no new permission is needed to keep live rewards safe.

`GET /admin/dungeons/reference` gains: the loot tables (key, name, tier, archived, hash), the item list (slug, name, category, `maxOwned`, enabled), and nothing else. Equipment eligibility is asked per selector through a preview route, since selectors are open-ended.

---

## 4. Editor UX

Principles carried over from Phase 1B.5: activity-based, names instead of IDs, plain sentences instead of field labels, advanced detail behind a disclosure, problems stated as what to fix.

### 4.1 The Rewards section on an activity

Shown in the activity card for Combat, Boss and Treasure. Collapsed, it is one summary line. Expanded:

```
┌ Rewards ────────────────────────────────────────────────────────────────┐
│ Paid once, when the player wins the final wave.                          │
│                                                                          │
│ GUARANTEED                                          always given         │
│  ◆ 40–60 Baddie Shards        [At risk]                          ✎  ✕   │
│  ◆ 500 WaifuBux               [At risk]                          ✎  ✕   │
│  ♥ 3 Affection → the Buddy in this run   [Kept]                  ✎  ✕   │
│  [+ Add guaranteed reward]                                               │
│                                                                          │
│ CHANCE DROPS                            each one rolls on its own        │
│  25%  Velvet Charm ×1         [Kept]                             ✎  ✕   │
│   5%  Epic Attack gear (4 possible)  [Kept]                      ✎  ✕   │
│  [+ Add chance drop]                                                     │
│                                                                          │
│ LOOT TABLES                              random picks from a shared list │
│  Scrapheap Boss Hoard  · Boss  ·  roll [2] times     Open table ↗   ✕   │
│  [+ Add loot table]                                                      │
│                                                                          │
│ ───────────────────────────────────────────────────────────────────────  │
│ On average: 50 Shards · 500 WaifuBux · 3 Affection · 0.25 Velvet Charm   │
│ · 1.55 gear pieces.   This activity always gives something.              │
│ [ Test roll ]  [ See all odds ]                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

Details:

* **Payout timing line** changes with the activity: "when the player wins the final wave" (Combat, Boss, and it says "wins the fight" when there is one wave); "when the player opens this" (Treasure).
* **Risk chips** appear on every row. `At risk` has a tooltip: "Held during the run. Banked on extraction or completion. Lost in part on defeat (this dungeon: keeps 50%) and on abandon (keeps 0%)." `Kept` has: "Given straight away and never taken back."
* **Add reward** opens one small form with a type choice first (Baddie Shards, WaifuBux, Essence, Item, Equipment, Affection), then only the fields that type needs.
* **Amount** is a single number with a "Use a range" link that reveals min and max.
* **Chance** is a percentage input accepting up to two decimals. Entering 100 offers "Move to Guaranteed". Entering 0 is refused with "A 0% drop never happens. Remove it instead."
* **Adding a third or fourth section is not required.** An empty section shows only its Add button and a one-line explanation.

**Item picker.** A searchable list by item name, with filter chips: All, Charms, Salvage, Consumables, Other. Each row shows name, category and a status. Items that cannot be awarded are listed but disabled, with the reason: "Limited to 1 per player, so it cannot be dungeon loot" or "Disabled". The slug is shown only in a hover title.

**Equipment picker.** The author chooses rarity, slot, or specific pieces. Beneath it, a live eligibility preview: "4 pieces can drop: Rusted Wrench, …" from the same selector code the game uses. Zero matches is an error stated at once: "Nothing matches this. Pick a different rarity or slot." A note says: "The exact piece is random among these. Its stats are rolled when it drops."

**Affection.** The form is one number and one fixed sentence: "Goes to the WaifuMon the player brought into this run, even if they switch Buddy afterwards. Kept on defeat. The Buddy's own affection bonus applies."

**Loot table row.** Shows name, tier, and a draws stepper. "Open table" opens the table editor in a side sheet so the author does not lose their place. If the table has changed since the dungeon was last published, the row shows "Changed since last publish".

**See all odds** expands a table: every possible reward, the chance of getting at least one, and the average amount (formulas in 11.2).

**Boss template.** The Boss room template pre-opens the Rewards section with one empty guaranteed row and the three section headings visible, so a first-time author sees where boss loot goes. It does not pre-fill amounts.

### 4.2 The Loot Table editor

A new Portal area, "Dungeon Loot", reached from the dungeon list page and from "Open table".

List page:

```
Dungeon Loot Tables                                   [+ New loot table]
[Search by name…]   Tier: (All) Common Rare Boss Legendary   ☐ Show archived

 Name                    Tier       Used by            Updated
 Scrapheap Boss Hoard    Boss       2 dungeons         2 days ago · Whistler
 Tunnel Cache            Common     1 dungeon          …
```

Editor:

```
┌ Scrapheap Boss Hoard ──────────────────────── [Test roll] [Save] ────────┐
│ Name [Scrapheap Boss Hoard     ]  Tier [Boss ▾]                          │
│ Description [Main loot for the Service Tunnels foreman.              ]   │
│ Used by: Service Tunnels (draft, published r4 uses an older version)     │
│                                                                          │
│ EVERY TIME THIS TABLE IS ROLLED                                          │
│  ◆ 2–4 Bent Gear                                              ✎  ✕      │
│  [+ Add]                                                                 │
│                                                                          │
│ CHANCE DROPS                              each one rolls on its own      │
│  30%  5–10 Essence                                            ✎  ✕      │
│  [+ Add]                                                                 │
│                                                                          │
│ RANDOM PICKS                                                             │
│ ┌ Boss gear ─────────────── picks [1] ─────────────────────────── ✕ ┐   │
│ │  One of these is picked each time. Bigger share = more likely.     │   │
│ │  Rare gear (12 possible)        share [60]   60%   ████████████    │   │
│ │  Epic gear (4 possible)         share [15]   15%   ███             │   │
│ │  Nothing                        share [25]   25%   █████           │   │
│ │  [+ Add reward]  [+ Add "Nothing"]                                 │   │
│ └────────────────────────────────────────────────────────────────────┘   │
│  [+ Add another group of random picks]                                   │
│                                                                          │
│ On average per roll: 3 Bent Gear · 2.25 Essence · 0.75 gear pieces       │
│ Chance of no gear from "Boss gear": 25%                                  │
│ ▸ Advanced (table key, revision, history)                                │
└──────────────────────────────────────────────────────────────────────────┘
```

Details:

* The word "weight" does not appear. The input is "share" and the percentage beside it updates as the author types. Percentages show two decimals when below 1% and never display a positive share as 0%.
* A pool is "a group of random picks". Its count is "picks".
* "Nothing" is a visible row the author adds on purpose, so a pool with no Nothing row visibly always gives something.
* The key is generated from the name on create, editable only then, and lives under Advanced with the revision number and history.
* Saving a table that dungeons use shows: "2 dungeons use this table. They keep paying the old version until each is published again."

### 4.3 Dungeon-level additions

* **Risk settings** in the dungeon's no-selection inspector: "If the player is defeated: [Keep half ▾]. If the player abandons: [Keep nothing ▾]." A caption: "Applies to Baddie Shards and WaifuBux earned in this dungeon. Gear, items, Essence and affection are always kept."
* **Header publish state.** When only a loot table has changed since the last publish, the header shows "Loot changed" beside the Publish button, and the publish confirmation lists which tables changed.
* **Legacy treasure.** A treasure activity still on the legacy shape shows its two expedition tables read-only, with a "Convert to dungeon rewards" button and a preview of what will change (section 10.3).

### 4.4 Creator workflows

1. **Give a boss fixed loot.** Select the boss activity → Rewards → Add guaranteed reward → pick type → enter amount → Save. Four clicks and one number.
2. **Add a rare drop.** Add chance drop → Item → search "velvet" → 25 → Save.
3. **Reuse loot across three dungeons.** Dungeon Loot → New loot table → fill in → Save. In each dungeon: Add loot table → pick by name → set rolls.
4. **Retune shared loot.** Edit the table → Save. Each dungeon using it shows "Loot changed". Publish each when ready; until then players see the old loot.
5. **Check it feels right.** Test roll on the activity or on the table; read "On average" and the single sample roll.

### 4.5 Validation messages

Shown through the existing `dungeonText.friendlyIssue` levels (finish, fix, review), naming the room and activity, never a path or code (those stay in the hover title).

| Code | Message |
| --- | --- |
| `reward_item_missing` | "*Velvet Charm* no longer exists. Pick another item." |
| `reward_item_capped` | "*Founder's Badge* is limited to 1 per player, so it cannot be dungeon loot." |
| `reward_item_disabled` | "*Old Token* is disabled. Enable it or pick another item." |
| `reward_equipment_empty` | "No gear matches *Epic Attack gear*. Loosen the choice." |
| `reward_table_missing` | "The loot table *Boss Hoard* was deleted. Remove it or pick another." |
| `reward_table_archived` | "The loot table *Boss Hoard* is archived. Restore it or pick another." |
| `reward_shards_unset` | "This dungeon has no Baddie Shard currency set, so it cannot pay Shards." |
| `reward_too_much_gear` | "This activity could drop up to 14 gear pieces at once. The limit is 10." |
| `reward_too_many_draws` | "This activity makes too many random picks (260). The limit is 200." |
| `reward_pool_all_nothing` | "*Boss gear* can only ever give Nothing." |
| `reward_empty` (warning) | "This Rewards section gives nothing yet." |
| `reward_legacy_mixed` | "This treasure uses both the old and new reward settings. Convert it." |

---

## 5. Payout lifecycle and execution contract

### 5.1 Where the payout happens

*Verified:* `fightWaves` records the action as `completed`/`victory` only in the branch `waveIndex + 1 >= action.waves.length`, then calls `follow` (`engine/step.ts:351–360`). The reward hook goes in that branch, before `follow`. This holds for `advance: 'auto'` (all waves in one step) and `'confirm'` (one step per wave) alike.

One shared engine routine serves all three activity types:

```ts
function claimRewards(w: Work, room: DungeonRoom, action: DungeonAction, bundle: RewardBundle): void {
  const claimKey = rewardClaimKey(w.ctx.runKey, room.id, action.id);   // unchanged helper
  if (Object.hasOwn(w.state.rewardClaims, claimKey)) return;           // already paid in this run
  const plan = resolveRewardBundle(bundle, w.ctx.rewards, w.rng, { roomId: room.id, actionId: action.id });
  w.state.rewardClaims[claimKey] = plan;
  w.state.unbankedCurrency += plan.atRisk.shards;
  w.state.unbankedWaifubux += plan.atRisk.waifubux;
  if (planHasSecured(plan)) w.effects.push({ type: 'grant_rewards', claimKey, roomId: room.id, actionId: action.id, plan });
  w.state.recent.push({ kind: 'reward', roomId: room.id, actionId: action.id, claimKey, plan });
}
```

| Event | Rewards |
| --- | --- |
| Intermediate wave won | None |
| Final wave won | Claimed once, before routing |
| Defeat or stalemate, whether the run ends or is routed onward | None |
| Optional activity declined | None |
| Activity skipped by its `when` condition | None |
| Abandon mid-fight | None |
| Treasure opened | Claimed once |
| Empty roll (every chance missed, every pool picked Nothing) | Claimed once, with an empty plan |

### 5.2 Claim identity

**The claim key stays `run:<runId>:<roomId>:<actionId>`.** *Verified:* `rewardClaims` is a map on the run, written under the run's `FOR UPDATE` lock in the same transaction as the grants (`dungeonRunService.ts:938–953`), and navigation never clears it. No new claims table is needed.

The key contains no step, visit count or wave number. A combat whose victory is routed to `retreat` has its action record deleted (`step.ts:217`) and is fought again on return; the second victory finds the claim and pays nothing. That is the case test T9 must cover explicitly, because the special case on line 217 protects only `reward` actions.

### 5.3 Deterministic draws

Every draw gets its own named stream from the run seed, so no draw's result depends on how many other draws exist.

```
stream('loot', roomId, actionId, 'g', entryId)                              guaranteed: quantity
stream('loot', roomId, actionId, 'c', entryId)                              chance: hit, then quantity
stream('loot', roomId, actionId, 't', refId, draw, 'g', entryId)            table guaranteed
stream('loot', roomId, actionId, 't', refId, draw, 'c', entryId)            table chance
stream('loot', roomId, actionId, 't', refId, draw, 'p', poolId, pick)       pool pick, then quantity
```

* `'loot'` is a new namespace. The legacy `'reward'` and `'combat'` streams and `DUNGEON_SEED_SALT` are untouched.
* The stream is keyed by the **reference id**, not the table key. Two references to the same table roll independently.
* Order of draws within one stream is fixed: for a chance entry, the hit roll (`intInclusive(0, 9999) < chanceBasisPoints`) then the quantity; for a pool pick, the weighted pick then the quantity; for equipment, the candidate pick.
* Quantities use `intInclusive(min, max)`. Pool picks use the shared `rollWeighted`.

Each resolved line carries a **drop id**, the stream path after the activity: `g:<entryId>`, `c:<entryId>`, `t:<refId>:<draw>:p:<poolId>:<pick>` and so on. It is stable for a given revision and is what equipment grant keys are built from.

### 5.4 The resolved plan

```ts
interface ResolvedLine {
  dropId: string;
  source: 'guaranteed' | 'chance' | 'table';
  tableKey?: string;                 // for display
  hit: boolean;                      // false: a missed chance or a Nothing pick
  grant?:
    | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence'; amount: number }
    | { type: 'item'; item: string; quantity: number }
    | { type: 'equipment'; definitionKey: string; rollSeed: number }
    | { type: 'affection'; amount: number };
}

interface DungeonRewardPlanV2 {
  v: 2;
  resolverVersion: 1;
  snapshotHash: string;                          // the revision's reward snapshot
  atRisk: { shards: number; waifubux: number };  // totals
  secured: {
    essence: number;                             // base amount, before bonus
    affection: number;                           // base amount, before bonus
    items: { item: string; quantity: number }[]; // merged by slug, sorted
    equipment: { dropId: string; definitionKey: string; rollSeed: number }[];
  };
  lines: ResolvedLine[];
}
```

A legacy plan has no `v` field and keeps its existing shape. Every reader (`runView`, the presenter, `settle`) branches on `v`.

### 5.5 Applying the plan

The live adapter applies a `grant_rewards` effect inside the step's transaction, in this fixed order, so lock order is the same for every request:

1. Essence: pinned bonus applied, then `CurrencyService.grantEssence`.
2. Items, sorted by slug: `InventoryService.addItem`.
3. Equipment, sorted by drop id: `grantChosenEquipmentReward` with `grantKey = dungeon:<claimKey>:<dropId>` and the plan's `rollSeed`.
4. Affection: the copy-targeted operation of section 7.

Shards and WaifuBux are not granted here. They were added to the run's unbanked totals by the engine.

**Any failure throws and rolls back the whole step**: grants, claim, cursor, history. The player is still standing at the activity and can press the button again. The retry resolves the identical plan from the same seed and snapshot. Nothing is skipped, nothing is partially delivered, and no claim is ever committed without its grants.

There is no pending-delivery queue. The audit's reasoning stands: currency, item and affection grants have no idempotency of their own, so they are only safe inside the claim's transaction.

### 5.6 Concurrency and duplicates

| Case | Outcome |
| --- | --- |
| Two requests for the same step | The second waits on the run lock, then is refused `stale`. One payout. |
| Replayed button after commit | Refused `stale`; the view is redrawn from stored state, including the receipt. |
| Request after the run ended | Refused `run_over`. |
| Crash or lost connection after commit | The reward is owned; the next view shows it. |
| Crash before commit | Nothing was granted; the step is retried and resolves identically. |
| Retreat and re-entry, any number of times | Claim found; no second payout. |
| Bot restart mid-run | State is in the row; nothing in memory matters. |

Every new mutating interaction must pass `expectedStep`, as the existing handlers do.

### 5.7 Missing and capped rewards

| Problem | Authoring | Publish and import | Runtime |
| --- | --- | --- | --- |
| Item does not exist | Picker cannot select it | Error, blocks | Throw; step rolls back |
| Item has `maxOwned` | Disabled in picker with reason | Error, blocks | `addItem` throws; step rolls back |
| Item disabled | Disabled in picker | Error, blocks | Granted (it was promised) |
| No equipment matches a selector | Immediate error | Error, blocks | Cannot occur; candidates are frozen at publish |
| Equipment definition deleted after publish | n/a | n/a | Throw; step rolls back |
| Loot table missing or archived | Row marked | Error, blocks | Cannot occur; the body is embedded |

**Capped items are refused outright in Phase 2.** There is no overflow conversion. The capture-item soft cap is not applied to dungeon loot, which matches how dungeon loot behaves today.

A runtime throw means published content has been invalidated by a later change elsewhere (an item gained a cap; a definition was deleted). Validation makes it unreachable at publish time; it stays reachable afterwards because items and equipment are shared catalogues. Mitigations: the failure is logged with tag `dungeons/reward-grant-failed` and the claim key; the player sees "This reward can't be delivered right now. Your progress is safe. Try again shortly."; and task T15 adds a Portal health check that lists published dungeons whose snapshot no longer validates. The player's remaining options are to wait for a fix, extract if the room allows, or abandon. See decision D8.

---

## 6. At-risk currency settlement

### 6.1 State

*Verified:* a run holds one integer, `unbanked_currency`, in the dungeon's progression currency; WaifuBux are granted immediately by the live adapter (`dungeonRunService.ts:600`).

Phase 2 adds one column, `dungeon_runs.unbanked_waifubux integer not null default 0` with a `>= 0` check, and the matching `unbankedWaifubux` on the engine state. `unbanked_currency` keeps meaning Baddie Shards.

`DungeonRunEnd` gains an optional block, absent on runs that ended before Phase 2:

```ts
waifubux?: { earned: number; banked: number; lost: number };
```

### 6.2 Settlement rules

```
retention = 10000                                       extracted, completed
          = settings.defeatCurrencyRetentionBasisPoints defeated (hp_zero, stalemate, scripted)
          = settings.abandonCurrencyRetentionBasisPoints
              ?? settings.defeatCurrencyRetentionBasisPoints   abandoned

banked(currency) = trunc(earned × retention / 10000)    existing settleCurrency, per currency
lost(currency)   = earned − banked
```

Worked example, defeat at 50% with 45 Shards and 501 WaifuBux unbanked: banks 22 Shards and 250 WaifuBux; loses 23 and 251.

The `settle_run` effect carries both banked amounts. The live adapter:

* banks Shards through `ProgressionCurrencyService.grant` with the existing request key `dungeon_run:v1:<runId>:settlement`, unchanged;
* banks WaifuBux through `CurrencyService.grantWaifubux` in the same transaction.

`grantWaifubux` has no request key. Its exactly-once guarantee is the run row: settlement happens only on the transition out of `active`, under the row lock, and every later request is refused `run_over`. That is the same protection immediate WaifuBux grants rely on today.

Pre-existing balances are never touched: settlement only ever adds `banked`, and `banked` is between 0 and `earned`.

### 6.3 Outcomes

| Outcome | Shards and WaifuBux | Secured rewards already granted |
| --- | --- | --- |
| Extraction | 100% banked | Kept |
| Completion | 100% banked | Kept |
| Combat defeat, stalemate, scripted defeat | Defeat rate banked (new dungeons: 50%) | Kept |
| Voluntary abandon | Abandon rate banked (new dungeons: 0%) | Kept |
| Disconnect, bot restart, player walks away | Nothing settles; the run stays active with its totals | Kept |

*Verified:* nothing in the inspected run service expires or auto-settles an idle run. Phase 2 does not add such a job.

With defeat keeping more than abandon, a player facing a lost fight cannot improve their outcome by abandoning. That ordering is deliberate; an author who inverts it gets a review-level warning.

### 6.4 What stays as it is

* A legacy treasure plan (no `v`) still pays its WaifuBux immediately and securely. Old revisions and runs on them behave exactly as before.
* If the progression currency is missing or disabled at settlement, the existing behaviour stands: the run ends, nothing is banked, and the receipt records `bankingSkipped`. See decision D10.

### 6.5 What the player sees

The Discord run view shows two groups: "At risk: 45 Baddie Shards, 501 WaifuBux" and "Kept: …". The dungeon card and the pre-run screen state both rates in words: "Defeat: keep half. Abandon: keep nothing." The abandon confirmation names the amounts that will be lost. The end-of-run summary shows earned, banked and lost per currency, from the committed settlement receipt.

---

## 7. Affection and the participating Buddy

### 7.1 What exists

*Verified:* the fighter's `waifuId` is pinned at run start (`dungeonFighter.ts:65–75`). `awardBuddyAffection` resolves the **current** Buddy and applies the **current** `affection_gain` bonus (`collectionService.ts:1299–1358`). `softRelease` blocks the current Buddy, favourites and copies on expedition; it asks `availability.reasonsFor` and keeps only `on_expedition` (`collectionService.ts:877–879`). A player can therefore swap Buddy mid-run and release the copy that is fighting.

### 7.2 Copy-targeted affection

A new `CollectionService` operation:

```ts
awardCopyAffection(tx, input: {
  playerId: number;
  waifuId: number;          // the pinned fighter
  baseAmount: number;       // positive integer
  bonusPercent: number;     // pinned at run start; 0 for none
}): Promise<{
  waifuId: number; baseAmount: number; granted: number;
  affectionBefore: number; affectionAfter: number;
}>
```

It locks the `player_waifus` row `FOR UPDATE`, verifies owner and not released, computes `applyPercentModifierInt(baseAmount, bonusPercent)` (the same rounding helper the existing award uses), and increments `affection`. It throws `WaifuNotOwnedError` or `WaifuAlreadyReleasedError` rather than returning null, because a dungeon must not continue past a reward it could not deliver.

`awardBuddyAffection` is refactored to resolve its Buddy and bonus as now and then call the same inner lock-and-increment helper, so there is one write path.

**What it must not do:** roll or advance an affection gift, touch pity counters, award XP, change level, sync appearances, or emit a stage notification. The existing mutation does none of these (audit 5.1), and the new one adds none. If crossing an affection stage should be announced in the dungeon summary, the presenter can compute it from `affectionBefore` and `affectionAfter` with the existing pure helper in `affectionStages.ts`; that is display only.

### 7.3 Reserving the participating copy

Add `'in_dungeon'` to `WAIFU_UNAVAILABILITY_REASONS`, with a provider that reports it when the player's active run (at most one, by the partial unique index) has `fighter.waifuId` equal to the copy. `softRelease` treats it like `on_expedition` for both release and convert-to-Essence.

* Switching Buddy mid-run stays allowed. The run keeps its pinned fighter, and affection keeps going to the pinned copy.
* The release message says: "She is in a dungeon run. Finish or abandon the run first."
* Race safety: `softRelease` reads availability after it holds the `players` row lock, and run start holds the same lock for its whole transaction (`dungeonRunService.ts:746–750`), so a release cannot slip between a start's check and its commit.
* Lock order: a dungeon step locks the run, then the copy. Release locks the copy, then the player, and only reads runs. There is no cycle.

With the reservation in place, an unavailable recipient at grant time is an invariant violation, and the throw from 7.2 (atomic rollback, loud log) is the right response. Affection is never redirected to another WaifuMon.

### 7.4 Pinned bonuses

At run start the fighter snapshot gains an optional block:

```ts
rewardBonuses?: {
  affectionGainPercent: number;
  essenceGainPercent: number;
  source: { speciesSlug: string; bonusKey: string } | null;   // for the receipt
}
```

It is read from the starting Buddy's bonus, once, in the start transaction. Both affection and Essence awards use these numbers for the life of the run, so a retry and a mid-run Buddy swap cannot change the amount.

For Essence this means the dungeon adapter applies the pinned percentage itself and calls `CurrencyService.grantEssence`, instead of `EssenceAwardService.awardEssence`, which would read the live Buddy. The rounding helper is the same one.

**Runs without `rewardBonuses`.** A run that started before this ships is pinned to a revision published before this ships, which cannot contain affection or Essence rewards. So the case should not arise. If it ever does, the rule is: apply no bonus (base amount), record `bonus: 'not_pinned'` on the receipt, and never read the live Buddy's bonus.

### 7.5 Receipt

Stored in `secured_rewards` and in the `rewards_granted` history event:

```ts
{ kind: 'affection', source: claimKey, step, waifuId, name, speciesSlug,
  baseAmount, granted, bonusPercent, affectionAfter }
{ kind: 'essence', source: claimKey, step, baseAmount, granted, bonusPercent, balanceAfter }
```

Affection is secured: it is in the player's collection the moment the activity is won and no run outcome removes it.

---

## 8. Equipment determinism

### 8.1 What is and is not stable today

*Verified:* the piece that drops (the definition key) is chosen from seeded draws against a frozen candidate list. The instance's multiplier, affix and combat bonuses are rolled by `rollCopies` with the equipment service's own RNG (`equipmentService.ts:700–717`). A grant key makes a **committed** instance permanent; if the transaction rolls back, the next attempt rolls new properties. The service already accepts a dictated roll (`roll: { kind: 'fixed', … }`), and `rollEquipmentInstance` already takes its RNG as a parameter.

### 8.2 Strategy

Three layers, the first two in Phase 2:

1. **Which piece: frozen at publication.** Each selector's candidate list is resolved when the dungeon is published and stored in the revision's reward snapshot (section 9). The engine picks from that list with the drop's seeded stream. New equipment added later does not enter a published dungeon's loot until it is published again.
2. **What it rolls: seeded per drop.** The plan carries `rollSeed = seedOf('loot', roomId, actionId, 'gear', dropId)`. A small, additive extension lets `grantChosenEquipmentReward` accept `rollSeed`, which the equipment service turns into `seededRng(rollSeed)` for `rollEquipmentInstance` in place of its shared RNG. Callers that pass nothing behave exactly as now. A retry after a rollback therefore rolls the same multiplier, affix and bonuses.
3. **Roll inputs: live, documented.** The definition's multiplier range, the affix catalogue and the combat-bonus catalogue are read at grant time. If an admin edits them between a failed attempt and its retry, the retry can produce a different instance. No player ever saw the first one, and nothing was committed, so this is not a reroll a player can cause. Freezing these inputs too would mean snapshotting three more catalogues into every revision; that is deferred (decision D7).

### 8.3 Grant keys

`dungeon:<claimKey>:<dropId>`, to which the equipment service appends `:0`. Legacy keys are `dungeon:<claimKey>:<number>`; drop ids always start with a letter and a colon, so the two cannot collide. Because the drop id comes from stable entry ids rather than a position in a flattened list, no reordering can remint an instance.

Equipment rewards never equip. The receipt records the actual instance (id, definition, name, slot, rarity, multiplier, affix, bonuses) as returned by the grant.

T7 must confirm `player_equipment.grant_key` is unbounded `text`; a v2 key can approach 220 characters.

---

## 9. Immutable revisions and packages

### 9.1 The reward snapshot

*Verified:* `publish` stores the definition and its hash and returns `unchanged` when the hash matches the published one (`dungeonContentService.ts:527–534`). Table bodies are read at run start. `dungeon_revisions` refuses UPDATE and DELETE by trigger.

Two nullable columns are added to `dungeon_revisions` (adding a column is DDL and does not fire the row trigger; existing rows read null):

```ts
reward_snapshot: DungeonRewardSnapshot | null
gameplay_hash:   string | null
```

```ts
interface DungeonRewardSnapshot {
  format: 'waifumon-dungeon-reward-snapshot';
  version: 1;
  resolverVersion: 1;
  tables: Record<string, {                       // every loot table the definition references
    key: string; name: string; tier: string | null;
    sourceRevision: number; contentHash: string; body: DungeonLootTableBody;
  }>;
  equipmentPools: Record<string, EquipmentRewardCandidate[]>;   // by equipmentSelectorKey, inline and in tables
  items: Record<string, { name: string; category: string }>;    // every item referenced, as validated
  hash: string;                                  // sha256 of the canonical snapshot without this field
}
```

Rules:

* A definition with no v2 bundle has `reward_snapshot = null` and `gameplay_hash = null`. For it, everything works as today and the content hash remains the only hash.
* Otherwise `gameplay_hash = sha256(canonical({ v: 1, contentHash, rewardSnapshotHash }))`.
* `content_hash` keeps its current meaning (the definition alone). It is what packages and the draft hash already use.
* Item names in the snapshot are a display fallback and evidence of what was validated. Live names are still shown when the item exists.

### 9.2 Publication

Inside the existing publish transaction, after the definition row is locked:

1. Collect the referenced table keys. Lock those `dungeon_loot_tables` rows `FOR SHARE`, in key order.
2. Validate the definition, then every referenced table body, then every item and selector they reach (section 11.1). Any error blocks publication.
3. Resolve every selector's candidates and build the snapshot.
4. Compare `gameplay_hash` (or `content_hash` when there is no snapshot) with the current published revision. Equal means `unchanged`. Different means a new revision, even when the definition itself has not changed.
5. Insert the revision with the snapshot and both hashes.

**Draft state.** `detailOf` computes the draft's would-be gameplay hash and returns, beside `draftDiffers`, a list the editor renders as "Loot changed":

```ts
dependencyChanges: { tableKey: string; name: string; status: 'changed' | 'missing' | 'archived';
                     publishedHash: string | null; currentHash: string | null }[]
```

`list` computes the same flag for all dungeons from one read of the catalogue and one read of rewardable equipment definitions.

**Rollback** moves the pointer to an older revision, which brings its own snapshot. The existing "can this server still run it" check is extended: every item in the snapshot must still exist and be uncapped, and every equipment candidate's definition must still exist. The loot tables themselves need not exist any more.

### 9.3 Runs

A run already pins `revision_id`. The engine context gains `rewards`, read from the pinned revision's snapshot through `revisionById`. Nothing about loot is copied into the run's `dependency_snapshot`, because the revision cannot change. Later edits, archiving or deletion of a table reach neither active runs nor new runs of that revision.

The legacy `dependency_snapshot.rewardTables` block continues to be built and read for definitions that still contain legacy treasure.

### 9.4 Package v2

`waifumon-dungeon-package` gains `schemaVersion: 2`. Readers accept 1 and 2.

```ts
dependencies: {
  ...v1 fields,
  dungeonLootTables: { key: string; contentHash: string }[];
  items: string[];                 // now filled: every slug reachable from rewards
  equipment: { selectorKey: string; candidateKeys: string[] }[];   // what the source could drop
}
bundled: {
  enemies: [...],
  dungeonLootTables: { key, name, description, tier, contentHash, body }[];
}
rewardSnapshotHash: string | null; // set when origin is 'revision'
```

* Exporting a **published revision** bundles the tables from its snapshot, not the current catalogue. Exporting a **draft** bundles the current catalogue bodies and reports any missing table.
* The reader recomputes every bundled table's hash and the dependency list from the definition. It rejects a missing bundled table, a bundled table nothing references, and a hash that does not match its body.
* **Which version is written:** a definition with no v2 bundle is exported as v1, byte-compatible with builds that predate Phase 2. Anything using v2 rewards is exported as v2. This keeps staging-to-production moves working while the two are on different builds.

### 9.5 Import

Loot tables join the existing plan-and-apply protocol (request receipt, plan hash, advisory locks, one transaction, draft created disabled and unpublished). The plan reports one state per bundled table:

| Target state | Default | Other choices |
| --- | --- | --- |
| Missing | Create it, `origin: 'import'` | Leave missing (draft imports, cannot publish) |
| Present, same hash | Use existing; nothing written | None |
| Present, different hash | **No default; the importer must choose** | Import as a copy under a new key, or use the existing table |

* **Import as a copy** creates the table under a new key (suggested `<key>_imported`, editable, must be free) and rewrites the imported draft's references. The plan shows that the draft's content hash will differ from the package's.
* **Use the existing table** requires a visible side-by-side difference and a confirmation that says rewards will differ from the source.
* **An existing table is never overwritten by an import.** Updating one is a deliberate edit in the Loot Table editor.
* Items and equipment are not bundled. A missing or capped item, or a selector with no candidates on the target, is reported; the draft can be imported as incomplete and cannot be published until fixed. Where the target's candidates differ from the source's `candidateKeys`, the plan warns "Different gear can drop here", since that is a real gameplay difference.
* Table rows touched by an import are locked in key order after the existing locks; the plan hash covers each target table's revision and hash, so any change between plan and apply forces a fresh review.

### 9.6 Seeding

Phase 2 ships **no** seed file for dungeon loot tables. If one is added later it gets its own file, inserts missing keys only, never updates a row, and marks `origin: 'seed'`. The existing reward-table seeder is not given the new catalogue, and a published revision's snapshot is never rewritten by anything.

---

## 10. Legacy compatibility

### 10.1 What must not change

| Thing | Guarantee |
| --- | --- |
| Existing revisions | Untouched. Null snapshot, null gameplay hash, legacy semantics. |
| Existing content hashes | Identical, by the optional-field rule (2.1). |
| Active runs | Keep their revision, `dependency_snapshot`, claims and plans. |
| Legacy claims | Plans without `v` are read as before. Keys are unchanged, so nothing is reminted. |
| Legacy treasure payout | Expedition roller, `'reward'` streams, WaifuBux paid immediately, Essence and XP on the table ignored. |
| Legacy equipment keys | `dungeon:<claimKey>:<index>` still replay-safe. |
| Settlement key | `dungeon_run:v1:<runId>:settlement`. |
| Abandon retention | Equals defeat retention wherever the new field is absent. |
| v1 packages | Still read, verified and importable. |
| Expedition, guild-boss, World Encounter and vendor rewards | No schema or behaviour change. |

### 10.2 Legacy and new side by side

A dungeon can hold legacy treasure and v2 bundles at once. Its snapshot covers the v2 parts; its legacy tables are still snapshotted at run start. Mixing is supported so authors can convert one activity at a time.

### 10.3 Converting a legacy treasure

An explicit, per-activity action in the editor. It previews, then on confirm writes new loot tables and replaces `reward` with `rewards` in the draft. Nothing published changes until the author publishes.

| Legacy | Becomes |
| --- | --- |
| `currency` range | Guaranteed Shards with the same range |
| Each referenced expedition table | A new dungeon loot table, `origin: 'converted'`, named after the source, referenced with 1 draw |
| The table's WaifuBux range | Guaranteed WaifuBux in that table |
| A group with chance *p*, *n* rolls, weighted entries | A pool with *n* picks; entry shares scaled by *p*, plus a Nothing entry holding the remaining 1 − *p* |
| A disabled group or entry | Dropped |
| The table's Essence, player XP, WaifuMon XP | **Not carried over**; dungeons never paid them |
| `equipmentRewardTable` | Converted in full, WaifuBux and items included, since it pays them today |

Scaling shares by *p* is exact: each entry's share becomes `w × p_bp` and Nothing gets `Σw × (10000 − p_bp)`, reduced by their greatest common divisor. If a share would exceed 1,000,000 after reduction, the conversion stops and asks the author to adjust the table by hand.

The preview states the two differences an author must know: **WaifuBux from this treasure become at-risk**, and rolls for a given seed will not match the old ones. Converting an already-converted table reuses it when the hashes match.

---

## 11. Validation and Test Roll

### 11.1 Validation layers

| Layer | Checks | Runs when |
| --- | --- | --- |
| Shape | Zod: types, bounds, unique ids, `max >= min`, exactly one of `reward` / `rewards` | Every save; a failing draft is refused, as now |
| References | Table exists and is not archived; item exists, enabled, uncapped; selector has candidates; Shards has a currency | Save (shown as issues), publish and import (blocking) |
| Work | Worst-case gear, draws, affection and at-risk totals within bounds | Same |
| Sense | Empty bundle, pool that is all Nothing, abandon keeps more than defeat | Warnings |

`DungeonValidationContext` gains `lootTables`, `items` and a selector-to-candidates resolver. A loot table is validated against the same item and selector checks when saved on its own, so problems appear in the table editor and not only at dungeon publish.

Publish validation is transitive by construction: it validates the snapshot it is about to store.

### 11.2 Expected-outcome maths

One pure function, `analyseRewardBundle(bundle, snapshot)`, returns exact figures, with no simulation:

* Chance entry with chance *c* and quantity range [*a*, *b*]: chance of at least one = *c*; average = *c* × (*a* + *b*) / 2.
* Pool entry with share *s* in a pool making *n* picks in total: chance of at least one = 1 − (1 − *s*)^*n*; average count = *n* × *s*.
* A table referenced with *d* draws multiplies its guaranteed entries by *d*, rolls each chance entry *d* times, and makes *d* × `pool.draws` picks per pool.
* The same item from several sources: averages add; the chance of at least one is 1 − the product of each source's miss chance.
* "Chance of getting nothing at all" is the product of every source's miss chance, and is 0 as soon as any guaranteed reward exists.
* Equipment is reported as "*n* pieces on average from *k* possible", plus the chance of each named piece (the entry's chance divided by its candidate count).

The summary groups by reward and by risk class, and labels affection and Essence "before the Buddy's bonus".

### 11.3 Test Roll

`POST /admin/dungeons/loot-tables/test-roll`, `dungeons.read`:

```ts
request:  { target: { bundle: RewardBundle } | { tableBody: DungeonLootTableBody; draws: number },
            tables?: Record<string, DungeonLootTableBody>,   // unsaved bodies override the catalogue
            seed?: number, simulate?: number /* 0..10000 */ }
response: { seed: number, roll: DungeonRewardPlanV2, analysis: RewardAnalysis,
            simulation?: { runs: number, averages: …, nothingRate: number }, issues: DungeonIssue[] }
```

* It builds a snapshot from the **unsaved** content sent in the request plus the live catalogue, and runs the same `resolveRewardBundle` the engine runs. There is one resolver.
* It constructs no effects port and calls no grant service. The route's only database access is reads.
* The seed is returned and can be re-entered, so a surprising roll can be reproduced.
* The dialog shows the sample roll as a player would see it ("You got: …", "At risk: …"), the exact odds from 11.2, and optionally the simulated averages as a cross-check.
* "Rolled nothing" is shown as a result. "Cannot be rolled" (a missing item, an empty selector) is shown as an error, never as an empty roll.
* Equipment is shown as the piece that would drop. Its stat roll is not simulated; the dialog says so.

The dungeon sandbox (`POST /admin/dungeons/sandbox`) currently passes `rewardTables: {}`. It is changed to build a draft snapshot the same way, so a sandbox playthrough lists v2 rewards as recorded effects.

---

## 12. Implementation tasks for Codex

Each task is one review. Run them in order within a group; groups A and B are independent of each other. Every task: `precheck_file` before editing, focused tests only, no commit. Baseline failures recorded in project memory (#0025, the adminEnemies shipped-edit test, the `errors.test.ts` classification test) are expected and not to be fixed here.

Migration numbers continue from `0061`. Each migration's journal `when` must be later than every existing entry on `Delve`.

### Group A: immediate fixes (no dependency on the new model)

**T-A1. Missing dungeon reward item fails atomically (#0027).**
Scope: `dungeonRunService.liveEffectsPort`: replace the skip-and-continue branch with a typed error.
Accept: a plan naming an absent item throws; grants, claim, cursor and history all roll back; the same step succeeds once the item exists and pays exactly once.
Tests: extend `tests/integration/dungeonRuns.test.ts` beside the existing injected-failure case.
Note: this changes legacy behaviour from silent loss to a retryable failure (decision D11).

**T-A2. Dungeons guard the expedition tables they use (#0028).**
Scope: add a dungeon reference source to `rewardTableService.referencesOf`, covering every draft and every published revision's legacy `reward` fields; wire it in `src/index.ts`. Delete is refused; disable warns.
Accept: an expedition table named by a dungeon draft or revision cannot be deleted and lists the dungeon; unreferenced custom tables still delete.
Tests: reward-table service integration tests; one case each for draft and revision references.

**T-A3. Legacy tables are validated transitively at dungeon publish (#0030, #0031).**
Scope: at `publish` and `rollback`, run the importer's existing transitive reward-table validation against referenced expedition tables, and reject items with `maxOwned`.
Accept: a dungeon whose table has an unpayable equipment selector or a capped item cannot be published and names the table and the item; a dungeon already published is unaffected until its next publish.
Tests: `dungeonContentService` integration tests for both failures and a passing control.

### Group B: model and catalogue (no player-facing change)

**T1. Reward schemas.**
Scope: new `content/dungeonRewards.ts` (grants, bundle, table body, bounds, worst-case calculator). Add optional `rewards` to combat, boss and treasure; make `reward` optional with the exactly-one rule; add optional `abandonCurrencyRetentionBasisPoints`. Extend `dungeonDependencies` with `lootTables`, `items`, `equipmentSelectors`.
Accept: golden test proves the content hash of the shipped example dungeon is unchanged; every bound in 2.5 and 3.2 has an accept and a reject case; the module passes `engineArchitecture.test.ts` with no new offender.
Tests: unit only.

**T2. Pure resolver and analyser.**
Scope: `engine/lootResolver.ts`: `resolveRewardBundle`, `analyseRewardBundle`, drop ids, stream naming per 5.3. Not wired into `step.ts`.
Accept: same inputs give the same plan; adding an unrelated entry does not change another entry's result; two references to one table roll independently; a 10,000-seed sample of each mode is within tolerance of the analyser; fixed vectors (seed → plan) are checked in as regression data.
Tests: unit only.

**T3. Catalogue storage and service.**
Scope: migration for `dungeon_loot_tables` and `dungeon_loot_table_events`; `dungeonLootTableService` with create, update (optimistic), archive, restore, delete, duplicate, where-used, history.
Accept: stale update returns 409 and writes nothing; delete refused while a draft references the table; every write appends one event; metadata-only edits bump the revision and leave the content hash alone.
Tests: integration against the test database.

**T4. Catalogue API.**
Scope: routes of 3.5 except test-roll; reference data additions; Portal API client types.
Accept: each route enforces its permission; `rewards.write` alone grants no access; OpenAPI schemas present.
Tests: `tests/integration/api` for permissions, 409 shape and validation errors.

**T5. Reference and work validation.**
Scope: extend `DungeonValidationContext` and `validateDungeonDefinition` with every code in 4.5; table-level validation for the catalogue's `validate` route and its save path.
Accept: each code has a triggering fixture; messages carry room and activity ids for the Portal to name; legacy-only definitions produce exactly the issues they produce today.
Tests: unit validation tests; one snapshot of legacy issues before and after.

**T6. Publication snapshot and gameplay hash.**
Scope: migration adding `reward_snapshot` and `gameplay_hash`; snapshot builder; publish, `detailOf`, `list` and rollback per 9.2; `revisionById` returns the snapshot.
Accept: editing a referenced table makes the dungeon report "Loot changed" and publishing creates a new revision though the definition is unchanged; editing, archiving and deleting that table afterwards changes neither the old nor the new revision's snapshot; publishing twice with no change returns `unchanged`; a legacy-only dungeon publishes with null snapshot and its existing hash behaviour.
Tests: integration; include the immutability trigger still refusing an UPDATE.

### Group C: execution

**T7. Seeded equipment rolls.**
Scope: optional `rollSeed` on `grantChosenEquipmentReward` → `grantEquipment`; `rollCopies` uses a seeded RNG when given one. Confirm `grant_key` column type.
Accept: the same seed and definition give the same multiplier, affix and bonuses across a forced rollback and retry; callers passing no seed are unchanged; a replay by grant key returns the stored instance.
Tests: equipment service integration; existing equipment suites unchanged.

**T8. Copy-targeted affection, reservation and pinned bonuses.**
Scope: `awardCopyAffection` and the shared inner helper; `'in_dungeon'` availability reason and provider; `softRelease` honours it for release and convert; `rewardBonuses` on the fighter snapshot at start.
Accept: affection goes to the pinned copy after a Buddy swap; the pinned copy cannot be released or converted during an active run and can after it ends; no gift roll, XP or level change results; concurrent start and release cannot both succeed; `awardBuddyAffection` results are unchanged.
Tests: collection service integration, including the concurrency case.

**T9. Engine: claims on combat, boss and treasure; two at-risk currencies.**
Scope: `claimRewards` in `step.ts` at the final-wave branch and the treasure branch; `DungeonRewardPlanV2`; `unbankedWaifubux` on the state; `endRun` with the abandon fallback and the per-currency settlement; sandbox port records v2 effects.
Accept: every row of the table in 5.1; victory routed to `retreat` and re-fought pays once; `auto` and `confirm` pay identically; defeat and abandon use different rates when configured and the same rate when the new field is absent; legacy treasure output is byte-identical to before for fixed seeds.
Tests: `tests/unit/dungeons/dungeonEngine.test.ts` and new engine unit tests. No database.

**T10. Live adapter, receipts and settlement.**
Scope: migration for `unbanked_waifubux`; `liveEffectsPort` applies v2 plans in the order of 5.5; settlement banks WaifuBux; receipts and history per 7.5; `runView` exposes at-risk and secured groups.
Accept: a boss with all three modes pays every type once; injected failure at each grant stage rolls back everything and the retry yields identical instances and amounts; concurrent same-step requests pay once; pre-existing WaifuBux balance is never reduced in any outcome; the worked example in 6.2 banks 22 and 250.
Tests: `tests/integration/dungeonRuns.test.ts` (real Postgres, concurrency and fault injection).

**T11. Discord presentation.**
Scope: `dungeonPresenter` and `waifumonDungeon`: at-risk and kept groups, affection recipient and bonus, Essence, abandon confirmation with amounts, end summary per currency, both retention rates on the card.
Accept: output built from committed receipts only; long reward lists truncate with a count; legacy runs render as before.
Tests: presenter unit tests with fixtures for v2, legacy and empty claims.

### Group D: authoring UI

**T12. Test Roll and sandbox rewards.**
Scope: the test-roll route; draft snapshot builder shared with the sandbox.
Accept: the route performs no writes (asserted by a read-only transaction or a spy on every grant service); the returned seed reproduces the roll; unsaved table bodies are honoured.
Tests: API integration.

**T13. Loot Table list and editor.**
Scope: Portal `adminDungeonLoot` feature per 4.2; item picker and equipment picker as shared components.
Accept: a table with guaranteed, chance and pool entries can be built without typing an id or a weight label; stale save keeps edits; percentages never show a positive share as 0%.
Tests: component tests; one Playwright spec. Stubs must answer `/import-history`.

**T14. Rewards section on activities.**
Scope: `ActivityCard` Rewards section per 4.1 for combat, boss and treasure; Boss template pre-opens it; friendly issue text; "See all odds" from the analyser's response.
Accept: the boss in 2.4 can be configured entirely through the UI; risk chips and the timing line are present; an invalid reward holds Save with a readable reason.
Tests: component tests; extend `dungeonAuthoring.spec.ts` with a boss-loot step.

**T15. Risk settings, "Loot changed", health check, legacy conversion.**
Scope: dungeon Risk presets; header and publish-dialog dependency changes; a read-only route and panel listing published dungeons whose snapshot no longer validates; conversion preview and apply per 10.3.
Accept: new dungeons are created with defeat 50% and abandon 0% written explicitly; conversion of the shipped example reproduces its tables' probabilities exactly and drops Essence and XP; the preview states the WaifuBux risk change.
Tests: model unit tests for conversion maths; component tests.

### Group E: portability

**T16. Package v2 export and reader.**
Scope: schema version 2, bundled tables, filled manifests, version choice per 9.4.
Accept: a legacy-only dungeon exports byte-identical v1; a revision export carries the snapshot's tables though the catalogue has since changed; tampered, missing and unreferenced bundled tables are rejected.
Tests: extend `dungeonPackage` unit tests.

**T17. Import v2.**
Scope: table states and decisions in plan and apply; reference rewriting for copies; locks and plan hash; Portal import panel rows.
Accept: missing, identical and conflicting tables each behave as in 9.5; no code path updates an existing table; a change to a target table between plan and apply forces a new plan; exact retry returns the recorded receipt; v1 packages import as before.
Tests: importer integration tests; Portal import component tests.

**T18. Documentation and end-to-end pass.**
Scope: `docs/dungeons.md`, a creator guide for rewards, and a final run of the focused suites with results recorded.
Accept: docs describe risk, timing, loot tables and import conflicts in creator language; the full focused test list is reported with pass and fail counts.

### Suggested order

A1 → A2 → A3, then T1 → T2 → T3 → T4 → T5 → T6, then T7 → T8 → T9 → T10 → T11, then T12 → T13 → T14 → T15, then T16 → T17 → T18. Group A can ship on its own. Nothing reaches players until T10; nothing reaches authors until T13.

---

## 13. Decisions needing approval

Each has a recommendation; the design above assumes it. An answer of "as recommended" to all of them is enough to start.

| # | Decision | Recommendation | If you choose otherwise |
| --- | --- | --- | --- |
| D1 | Defeat keeps 50%, abandon keeps 0%, configurable per dungeon now | Yes, via one new optional field | A global setting means a new settings store and a second source of truth |
| D2 | One retention rate covers both Shards and WaifuBux | Yes | Per-currency rates add two more fields and a busier Risk panel |
| D3 | "Shards" means the dungeon's configured progression currency | Yes, as today | Hard-wiring `ascension_currency` removes a setting but changes existing content semantics |
| D4 | Legacy treasure keeps paying WaifuBux immediately until converted | Yes; required to preserve published behaviour | Making all WaifuBux at-risk at once changes live dungeons without a publish |
| D5 | Essence gets the Buddy's bonus, pinned at run start | Yes | No bonus is simpler; a live bonus can change between retries |
| D6 | The participating copy cannot be released or converted during its run; Buddy swaps stay allowed | Yes | Allowing release needs a forfeiture rule for owed affection |
| D7 | Equipment: freeze which pieces can drop at publish and seed the stat roll; leave roll ranges and affix catalogues live | Yes for Phase 2 | Full freezing snapshots three more catalogues per revision |
| D8 | Capped items are refused as dungeon loot; a reward that becomes undeliverable after publish blocks that activity until fixed | Yes | Overflow conversion needs a product rule for what the excess becomes |
| D9 | Import never overwrites a loot table; a conflict is resolved by copy-under-new-key or explicit use-existing | Yes | n/a; overwriting is ruled out by the brief |
| D10 | A progression currency disabled mid-run still means nothing is banked, with a recorded reason | Keep for now | Honouring the promise needs a deferred-banking mechanism |
| D11 | A missing item in a legacy plan now fails the step instead of being skipped | Yes | Leaving it means a committed claim with a lost item |
| D12 | Loot tables are governed by `dungeons.read` / `dungeons.write`; no new permission | Yes | A separate permission adds a role to manage |
| D13 | Tiers are Common, Rare, Boss, Legendary; labels only | Yes | Any other list is a one-line change before T3 |
| D14 | Affection is bounded to 500 per entry and 1,000 per activity; no global cap is introduced | Yes | Affection has no cap anywhere today; a cap is a separate product decision |
| D15 | Legacy-only dungeons keep exporting as package v1 | Yes | Always writing v2 breaks imports into builds that predate Phase 2 |
| D16 | No nested loot tables, no unique (without-replacement) draws | Yes | Either needs its own design |

### Known limits of this design

* An item that gains a cap, or an equipment definition that is deleted, after a dungeon is published can make one activity's reward undeliverable until an admin fixes it. T15's health check surfaces this; it does not prevent it.
* Equipment stat rolls are stable across retries only while the definition's ranges and the affix and bonus catalogues are unchanged (D7).
* Database-only dungeons and their real use of expedition tables could not be enumerated, as in the audit. T-A2 and the conversion tool are written to cope with any number of them.
* No test was run for this document. Behaviour described as existing was read from the code or taken from the audit.
