# Waifumon — Project Plan (Revised)

> Revision 3 — content gating simplified: per-species image gating (ContentGate) replaced by a whole-game NSFW play-channel guard (PlayChannelGuard) with optional admin channel allowlist; `content_rating` demoted to metadata. (Revision 2: Postgres from day one, MVP shop, collection/inspect in first playable, Mythic Contract locked, milestone restructure.) See Diff Summary at the end.

## 1. Executive Summary

Waifumon is a standalone, single-server-scoped Discord collection game bot for an age-verified, mature-content server. Players spend a daily pool of Hunt Energy to roll hunts, encounter collectible Waifumon of varying rarity, and attempt captures using consumable charm items via Discord buttons. Captures build a per-server collection; duplicates convert to Essence; players and individual Waifumon both level up through small, capped progression systems. A small shop gives WaifuBux an immediate sink from day one.

The stack is TypeScript + Node.js + discord.js v14, **PostgreSQL** with Drizzle ORM and drizzle-kit migrations, deployed via Docker Compose (bot + Postgres services) with a persistent database volume and a mounted assets volume for card art. Content (species, items, shop prices, drop tables) is seeded from local JSON files, and card art is served from local files attached to embeds — no image generation, no external services, no shared economy.

The interaction model is button-first: `/waifumon` opens an ephemeral main menu; hunts are private; capture attempts and outcomes are public theater for the channel; rare captures announce publicly with a configurable `@here` threshold. **The whole game plays only in NSFW-marked channels** — a single PlayChannelGuard middleware blocks every command and button outside them (with an optional per-guild allowed-channel list), keeping platform compliance to one tested choke point.

The MVP is deliberately tight: hunt → encounter → capture → collect → daily → shop → light progression. Everything else (trading, quests, events, marketplace, PvP) is explicitly deferred.

---

## 2. Core Gameplay Loop

```
Non-NSFW / non-allowed channel ──► EVERY command & button blocked by PlayChannelGuard
                                   (friendly ephemeral message — nothing consumed)

/waifumon (ephemeral menu, in an NSFW-marked play channel)
   ├── Claim Daily ──► Energy refilled to max + WaifuBux + charm pack (ephemeral)
   ├── Shop ──► buy charms with WaifuBux (ephemeral, transactional)
   ├── Hunt ──► spend 1 Energy ──► roll result table (ephemeral)
   │      ├── Item / WaifuBux / Essence / flavor ──► ephemeral, done
   │      └── Waifumon encounter (ephemeral card + charm buttons, 2-min timer)
   │             ├── Let Her Go ──► ephemeral dismissal, done
   │             └── Use Charm ──► consume item ──► FIRST attempt goes PUBLIC
   │                    ├── Success ──► public capture card
   │                    │       ├── New species ──► dex entry + bonus XP
   │                    │       ├── Duplicate ──► ephemeral Keep / Convert-to-Essence prompt
   │                    │       └── SSR+ ──► public announcement (UR/LR/EX: @here)
   │                    └── Fail ──► public "she resisted!" ──► up to 3 total attempts, then escape (public)
   ├── Profile / Collection / Inventory / Buddy ──► ephemeral browsing
   └── XP from hunts, captures, new entries, dailies ──► player levels ──► small perks
```

Session shape: a player logs in once a day, claims daily, burns ~25 hunts over 15–25 minutes (gated by the 30s cooldown), makes a handful of capture decisions, spends spare WaifuBux on charms, and checks their collection. The public capture messages create ambient social activity that draws other players in.

---

## 3. MVP Scope

**In scope:**
- Single `/waifumon` command with subcommands (hunt, daily, shop, profile, collection, inventory, inspect, release, buddy).
- Button-driven main menu, encounter flow, shop, duplicate handling, collection actions.
- Hunt Energy system (base 25/day), daily claim, 30s hunt cooldown, 2-minute encounter expiry.
- Weighted hunt result table and rarity table exactly as specified.
- Capture system: 5 capture items with multipliers, up to 3 attempts, per-attempt item consumption, logged attempts. **Mythic Contract = guaranteed capture, extremely rare, never sold.**
- **MVP shop:** buy Basic/Silk/Velvet Charms with WaifuBux; ephemeral, transactional, audited.
- **NSFW play-channel gating:** all commands and buttons require an NSFW-marked channel, with an optional per-guild allowed-channel list; `content_rating` on species is metadata only.
- Duplicate → keep or Essence conversion.
- **Basic collection browser and inspect view ship with the capture loop** (first playable milestone) — paginated list, counts, rarity/name sorting, detail card.
- Player XP/levels with the specified unlock schedule (implementing only the unlocks that have MVP mechanics behind them; others recorded but marked "later").
- Individual Waifumon: level, affection, nickname, buddy status; Essence investment for Waifumon levels; single active buddy.
- Rare capture announcements with configurable @here threshold per guild.
- Species/items/prices seeded from local JSON; images attached from local disk.
- **PostgreSQL + Drizzle migrations**, Vitest tests for core services against real Postgres, Docker Compose (bot + Postgres) with persistent volumes.

**Deliberately thin in MVP:** cosmetics are stored flags/labels rendered as text in embeds (frames, auras, titles are just displayed strings — no image compositing). Shop sells capture items only.

## 4. MVP Non-Goals

No trading, marketplace, PvP, breeding/fusion, public server-wide spawns, paid rolls, image generation, integration with any other bot or economy, multi-server/global collections, content-management UI, quests/daily-targets (XP sources reserved), events (EX rarity reserved), or shop categories beyond capture items. The shop exists but stays deliberately tiny — it is a WaifuBux sink, not a marketplace.

---

## 5. Interaction Model

**Slash commands** — one top-level `/waifumon` with subcommands (Discord requires subcommands to be invoked explicitly; bare `/waifumon` is modeled as a `menu` default subcommand). All slash responses are **ephemeral** by default.

**Visibility rules (the social contract of the game):**

| Interaction | Visibility |
|---|---|
| Main menu, profile, collection, inventory, buddy, **shop** | Ephemeral |
| Hunt roll + non-encounter results | Ephemeral |
| Encounter reveal + charm selection | Ephemeral |
| Channel-guard block message | Ephemeral |
| First capture attempt onward (attempts, fails, success, escape) | **Public** channel message |
| Duplicate keep/convert prompt | Ephemeral (follow-up to the player) |
| SSR capture | Public announcement embed |
| UR / LR / EX capture | Public announcement + `@here` (configurable threshold) |
| Daily claim | Ephemeral (MVP; public brag optional later) |

**Public message mechanics:** the first charm click posts one public message via `channel.send()` (not an interaction reply, so it isn't tied to the ephemeral context). Subsequent attempts **edit** that same public message, appending an attempt log, so a 3-attempt fight is one evolving message rather than three. Final state (captured/escaped/released after an attempt) locks the message. The bot needs `Send Messages`, `Embed Links`, `Attach Files`, and `Mention Everyone` (for @here) permissions; degrade gracefully (no @here, plain announcement) if missing.

**Button ownership:** every component interaction validates that the clicker is the encounter/menu owner; others get an ephemeral "This isn't your encounter."

---

## 6. Game Economy and Resources

| Resource | Role | Sources | Sinks |
|---|---|---|---|
| **Hunt Energy** | Daily play limiter | Daily claim (refill to max), level-based max increases | 1 per hunt |
| **WaifuBux** | Soft cash | Hunt finds, daily claim | **MVP shop (capture items)** |
| **Essence** | Progression currency | Duplicate conversion, hunt material finds | Waifumon leveling investment |
| **Charms/Contracts** | Capture consumables | Daily claim, hunt item finds, **shop** | 1 per capture attempt |

Design principles: Energy is the only hard limiter; charms are the strategic resource (which charm on which rarity?); Essence creates a reason duplicates feel fine; WaifuBux now has a day-one sink in the shop, which also creates the core economic decision — hoard for Velvet Charms or spend on volume. All bonuses that touch these numbers are additive, small, and hard-capped.

**Suggested daily claim package:** full Energy refill, 100 WaifuBux, 5 Basic Charms, 2 Silk Charms, 1 Velvet Charm; +1 Silk Charm at player level 12; small rare-item chance at level 30. Amounts live in content JSON, not code.

**Economy sanity check:** daily income ≈ 100 WaifuBux (claim) + ~2 WaifuBux finds (~100 avg) ≈ 200/day. A Silk Charm at 75 is an everyday purchase; a Velvet at 200 is a "one day of saving" purchase; Prismatic at 750 is a multi-day goal. Tune via Monte Carlo tests and week-one telemetry.

---

## 7. Hunt Energy and Daily Limits

- **Max Energy:** 25 base; +5 at levels 7, 20 (and future milestones), hard cap ~40. Computed from level, not a mutable column.
- **Spend:** 1 per hunt, decremented transactionally with the hunt roll.
- **Refill:** daily claim sets `energy = max` (no banking, no overflow, no partial stacking). No passive regen in MVP — one clean mental model.
- **Daily reset:** calendar-day boundary in a configurable timezone (default UTC), stored as `claim_date` per claim row. Claim available once per calendar day, enforced by a **unique constraint** — double-claims are impossible even under race.
- **Hunt cooldown:** 30 seconds (env-configurable in the 30–60s range), enforced server-side via `last_hunt_at` timestamp — never trust client pacing. An active unresolved encounter also blocks new hunts.
- **Encounter expiry:** 2 minutes from reveal. Enforced lazily (timestamp check on every button click) **plus** a best-effort `setTimeout` to edit the ephemeral message to "She slipped away…". Lazy check is the source of truth; timers are cosmetic and don't survive restarts (a startup sweep marks stale encounters expired).
- **Channel-guard blocks are free:** PlayChannelGuard rejects interactions *before* any state change — no Energy spent, no cooldown applied, no roll performed. Since the roll never happens, there is nothing to fish for and nothing to refund.

---

## 8. Hunt Result System

Single weighted roll, table data-driven from JSON so weights can be tuned without redeploy:

| Result | Weight | Payload |
|---|---|---|
| Waifumon encounter | 70% | Roll rarity → roll species within rarity |
| Basic item find | 12% | 1–3 Basic/Silk Charms (weighted) |
| WaifuBux find | 8% | 25–75 WaifuBux |
| Essence find | 5% | 3–10 Essence |
| Rare item find | 3% | Velvet Charm, Prismatic Charm (rare), **Mythic Contract (very rare — this is its only regular source)** |
| Empty flavor | 2% | Random flavor line from a JSON pool ("You found a suspiciously heart-shaped rock.") |

Implementation notes: one `rollWeighted<T>(table)` utility used for result type, rarity, species-within-rarity, and item sub-tables — the most test-critical code in the project. RNG behind an injectable interface so tests can use a seeded PRNG. Level-40's "+1% rare encounter chance" applies as a shift inside the rarity table (N loses 1%, redistributed upward), capped and additive-only.

All non-encounter results grant their reward immediately in the same transaction as the energy spend and log a progression event.

---

## 9. Encounter and Capture System

**Encounter creation:** hunt roll produces species → an `encounters` row is created (`player_id`, `species_id`, `state='active'`, `attempt_count=0`, `max_attempts=3`, `expires_at`, `channel_id`). One active encounter per player at a time.

**Encounter reveal (ephemeral):** embed with card image, name, rarity badge, archetype, flavor text, and charm buttons showing owned quantities ("Silk Charm ×2"). Buttons for charms the player doesn't own are disabled. The Mythic Contract button is labeled to communicate its power: **"Mythic Contract ×1 — guaranteed."**

**Capture math:**

```
chance = clamp(base_capture_rate × charm_modifier × (1 + buddy_bonus), 0.02, 0.95)
```

Suggested `base_capture_rate` by rarity: N 0.50, R 0.35, SR 0.22, SSR 0.12, UR 0.06, LR 0.03, EX per-event. Per-species override allowed in JSON.

**Mythic Contract (locked behavior):**
- **Guaranteed capture — bypasses the formula entirely.** No config flag; this is the contract's identity.
- Extremely rare: only from very rare hunt finds (§8), admin grants, or future events.
- **Never sold in the MVP shop** (item flagged `purchasable=false`).
- Capture log rows record `guaranteed=true` and the item used, so audits clearly show a Contract capture.
- UI copy everywhere (inventory, encounter button, capture card) states it guarantees capture, so players never waste it doubting.

With these numbers an LR needs a Prismatic (0.03×4 ≈ 12%/attempt, ~32% over 3 attempts) — rare stays genuinely rare, and Mythic Contracts become treasured LR insurance. Validate curves in tests with Monte Carlo assertions.

**Attempt flow:**
1. Click charm → in one transaction: `SELECT … FOR UPDATE` the encounter row, verify active/not expired/owned, lock and decrement the inventory row, insert `capture_attempts` row, roll, update `attempt_count` and state.
2. First attempt posts the public message; later attempts edit it.
3. Fail with attempts remaining → ephemeral follow-up with **Try Again** (same charm), **Use Different Charm** (reopens charm row), **Let Her Go**; public message shows the running attempt log.
4. Third fail → state `escaped`, public message finalizes ("After 3 attempts, Neon Kitsune vanished into the night…").
5. Success → state `captured`, `player_waifus` row created (or duplicate flow), public capture card, XP awarded, rare-announcement check.
6. **Let Her Go** before any attempt → everything stays ephemeral. After an attempt → public message finalizes as "released."

**Double-click safety:** row lock + conditional state transition (`WHERE state='active'`) inside a transaction; a stale click gets an ephemeral "that attempt already resolved."

---

## 10. Rarity and Species Design

Rarity table as specified (N 60 / R 25 / SR 10 / SSR 4 / UR 0.9 / LR 0.1; EX event-only, never in the base roll — event system injects EX via `event_key` post-MVP).

**Species record** (from JSON): `slug`, `name`, `rarity`, `archetype` (kitsune, succubus, android, etc. — pure flavor in MVP, hook for future type mechanics), `base_capture_rate` (optional override), `description`, `tags[]`, `content_rating` (**`suggestive` | `mature` | `explicit`** — metadata only in MVP, see §11), `image_path`, variant image paths (e.g., `holo` — variants are post-MVP but the schema field exists), `enabled`, `event_key`.

**Content targets for launch:** ~40–60 species is plenty: 20 N, 15 R, 10 SR, 6 SSR, 3 UR, 2 LR. Species-within-rarity roll is uniform in MVP (per-species weight field reserved in JSON).

Disabled species are skipped at roll time; if a rarity bucket is empty, reroll the rarity (log a warning).

## 11. Play-Channel Gating — PlayChannelGuard (MVP Requirement)

The game is mature/NSFW by default, so the compliance model is simple: **the entire game only functions in NSFW-marked channels.** There is no per-species or per-image gating — one guard, one rule, applied uniformly. This is a safety and platform-compliance requirement, not a censorship feature.

**PlayChannelGuard** is a middleware that runs **before every command and every component (button/select) handler** — no gameplay code executes in a disallowed channel.

**Rules (evaluated in order):**
1. Interaction must be in a guild channel (no DMs — the game is guild-scoped anyway).
2. The channel must be **NSFW-marked** (`channel.nsfw`; threads inherit their parent's flag).
3. If the guild has configured an **allowed-channel list** (optional, admin-managed), the channel must also be on it. An empty/unset list means "any NSFW channel in the server."

**Blocked interaction behavior:**
- Friendly ephemeral message: "Waifumon plays in NSFW-marked channels only~ Head to #waifumon-hunts." (names the first allowed channel when a list is configured).
- **Nothing is consumed and nothing changes:** no Energy spent, no cooldown applied, no encounter rolled, no daily claimed, no purchase made. The guard rejects before any service call, so there is no state to refund and no reroll-fishing exploit to worry about.

**What this makes automatic:** hunt reveals, capture attempts, public capture/escape messages, collection, inspect, shop, profile — every render already happens in an NSFW channel, so no individual feature needs its own content check. Rare announcements go to the configured announce channel, which admin setup must point at an NSFW channel (the admin command validates this).

**Admin management:** `/waifumon-admin allow-channel add|remove|list`. Stored per guild (`allowed_channel_ids`).

**`content_rating` stays metadata only:** species keep `suggestive` | `mature` | `explicit` in content JSON and the DB for organization, dex badges, and future filtering features — but it drives no runtime behavior in MVP.

**Implementation notes:** the guard is one small service with a pure decision function (`guildConfig × channelInfo → allow | deny(reason)`), unit-tested across the NSFW-flag × allowlist × thread-inheritance matrix, and wired once into the interaction router so no handler can forget it.

## 12. Duplicate Handling

On capture of a species the player already owns:
- Capture still succeeds publicly (the crowd saw the fight; the outcome is real).
- Player gets an **ephemeral** follow-up: card + "You already have her!" with **Keep Duplicate** / **Convert to Essence (+N)** buttons.
- Essence values by rarity: N 5, R 15, SR 40, SSR 100, UR 250, LR 600 (data-driven).
- No response within 5 minutes → **default: keep** (never destroy property by timeout).
- Keeping creates a second `player_waifus` row (independent level/affection/nickname). Dex completion counts distinct species, so duplicates don't inflate it.
- New-species captures award a "new dex entry" XP bonus; duplicates award only base capture XP.
- Level-15 "duplicate preferences" (auto-convert) is post-MVP; schema reserves a player setting column.

---

## 13. Player Progression

**XP sources (MVP):** hunt 5 XP; capture by rarity (N 10, R 15, SR 25, SSR 50, UR 100, LR 200); new dex entry +25; daily claim 20; failed attempts 2 XP (participation trickle). Quests reserved.

**Curve:** `xp_to_next(level) = 100 + 50 × (level − 1)` (linear-ish; level 10 ≈ a week of full dailies, level 50 is a long-haul goal). Tune in config.

**Unlock schedule** (MVP implements the mechanical ones, stores the rest):

| Lv | Unlock | MVP status |
|---|---|---|
| 1 | 25 max Energy | ✅ |
| 2 | +5 inventory capacity | ✅ (soft cap, see §15) |
| 3 | Collection filters | ✅ (rarity filter select) |
| 5 | Daily target hunts | 🔒 later |
| 7 | +5 max Energy | ✅ |
| 10 | Profile showcase slot | ✅ (text/thumbnail in profile) |
| 12 | +1 Silk Charm in daily | ✅ |
| 15 | Duplicate preferences | 🔒 later |
| 20 | 2nd showcase + 5 max Energy | ✅ |
| 25 | Weekly quests | 🔒 later |
| 30 | Daily rare-item chance | ✅ |
| 40 | +1% rare encounter shift | ✅ |
| 50 | Prestige title | ✅ (profile string) |

All numeric bonuses additive and centrally capped (`maxEnergyCap`, `rareShiftCap`) in one `progression.ts` config. Level-ups announce in the ephemeral context of whatever action triggered them ("⬆️ Level 7! Max Hunt Energy +5"). Every XP grant writes a `player_progression_events` row — the audit log and data source for future quests/analytics.

## 14. Individual Waifumon Progression

Each owned copy has: `level` (1–50), `xp`, `affection`, `nickname`, `is_buddy` (via players.buddy_waifu_id), `is_favorite`, `cosmetic_unlocks` (JSONB array of earned flags).

**XP/affection sources:** being active buddy while the owner hunts (+2 waifu XP, +1 affection per hunt — this makes buddy choice a leveling decision); Essence investment via Inspect → "Invest Essence" (10 Essence = 25 waifu XP, diminishing at high levels); capture grants nothing extra to other waifus.

**Unlocks:** Lv5 nickname · Lv10 flavor quote · Lv15 tiny buddy bonus (+2% capture chance while buddy — the *only* gameplay-affecting waifu perk, hard-capped, single-buddy-only) · Lv20 card frame label · Lv30 ascension cosmetic label · Lv50 prestige aura/title. Cosmetics render as embed text/emoji badges in MVP.

**Buddy rules:** exactly one buddy per player, enforced by a `buddy_waifu_id` column on players. Buddy shows on profile and in hunt flavor text.

---

## 15. Inventory and Item Design

**Item catalog** (seeded from JSON): `slug`, `name`, `category` (`capture`, `material`, `cosmetic`, `consumable`), `capture_modifier`, `description`, `emoji`, `enabled`, **`purchasable`, `buy_price`, `daily_stock_limit`** (shop fields, see §16).

| Item | Modifier | Acquisition profile |
|---|---|---|
| Basic Charm | 1.0× | Abundant (daily ×5, common finds, shop) |
| Silk Charm | 1.5× | Common (daily ×2, shop) |
| Velvet Charm | 2.25× | Uncommon (daily ×1, rare finds, shop) |
| Prismatic Charm | 4.0× | Rare (rare finds; shop-listed but disabled at launch) |
| Mythic Contract | **Guaranteed** | Very rare (rare-find jackpot, admin grants, future events — **never sold**) |

Player inventory is a quantity table (`player_id`, `item_id`, `quantity`). **Capacity:** soft cap on total capture items (default 50, +5 at level 2) enforced at *acquisition* time — hunt-find excess converts to WaifuBux with a note; **shop purchases that would exceed the cap are rejected before payment** (clear error, nothing charged); daily claims are never blocked entirely. Currencies (Energy/WaifuBux/Essence) are columns on a `player_currencies` row, not inventory items.

The inventory screen groups by category and shows quantities and capture modifiers, with Mythic Contract labeled "guarantees capture."

## 16. MVP Shop

A deliberately tiny WaifuBux sink — capture items only, no marketplace ambitions.

**Access:** **Shop** button on the main menu, or `/waifumon shop`. Fully ephemeral.

**Shop embed:** current WaifuBux balance in the header; one line per item — emoji, name, capture modifier, price, and currently-owned quantity. Purchase via buttons (one per item, "Buy Silk Charm — 75 WB"), with a select-menu quantity picker (×1/×5/×10) if button count allows; MVP can ship with ×1 buttons only.

**Launch catalog (data-driven from content JSON):**

| Item | Price | Notes |
|---|---|---|
| Basic Charm | 25 WaifuBux | Always available |
| Silk Charm | 75 WaifuBux | Always available |
| Velvet Charm | 200 WaifuBux | Always available |
| Prismatic Charm | 750 WaifuBux | **Listed but disabled at launch** (`purchasable=false`); `daily_stock_limit` field reserved for enabling later with limited stock |
| Mythic Contract | — | **Not sold.** Not listed, or listed greyed-out as "Not for sale" for mystique — pick one at UI build time |

**Purchase transaction (single DB transaction):**
1. Verify player exists (auto-provisioned upstream).
2. Verify item `enabled` and `purchasable`.
3. Lock the player's currency row (`SELECT … FOR UPDATE`), verify sufficient WaifuBux.
4. Verify inventory capacity (reject before charging).
5. Deduct WaifuBux; upsert inventory quantity.
6. Insert a `shop_transactions` audit row (item, qty, unit price, total, balance after).
7. Refresh the shop embed with new balance and owned counts.

Failures (broke, capped, item disabled) answer ephemerally with the specific reason; nothing is ever partially applied.

**Explicitly out of scope for the MVP shop:** selling/buyback, cosmetics, Essence trading, rotating stock, discounts, player-to-player anything.

## 17. Collection Design

Basic collection viewing **ships with the capture loop** (first playable milestone) — players must never be able to catch Waifumon they can't view.

**First-playable tier (required with capture loop):**
- `/waifumon collection` + Collection menu button → ephemeral paginated list (10/page, ◀ ▶ buttons).
- Header shows owned count and **dex completion**: "23 owned · 18/58 species".
- Sorting: rarity-desc then name (default), name toggle.
- A string select menu over the current page opens the **detail card** (= `/waifumon inspect`): image, rarity, level/XP, affection, nickname, badges, capture date.

**Full MVP tier (later phase, still MVP):**
- Level-3 rarity filter select; favorites-first toggle.
- Detail card action buttons: **Set Buddy**, **Favorite**, **Release**.
- **Release:** confirmation button ("Really release Lv12 ★Favorite Neon Kitsune?"), grants 50% of the duplicate Essence value, hard-blocks releasing the active buddy (unset first), extra-warns on favorites. Releases are logged.

---

## 18. Command Design

| Command | Behavior |
|---|---|
| `/waifumon menu` (and bare entry point) | Main menu embed + buttons |
| `/waifumon hunt` | Skips menu, executes a hunt immediately |
| `/waifumon daily` | Claims daily (or shows time-until-reset) |
| `/waifumon shop` | Opens the shop |
| `/waifumon profile [user]` | Own profile; viewing others is public-safe read-only |
| `/waifumon collection` | Paginated collection browser |
| `/waifumon inventory` | Inventory view |
| `/waifumon inspect <name/nickname>` | Autocomplete over owned waifus → detail card |
| `/waifumon release <name/nickname>` | Autocomplete → confirm → release |
| `/waifumon buddy [name]` | No arg: show current buddy; arg: set buddy |
| `/waifumon-admin` (separate, permission-gated) | `set-announce-channel` (validates NSFW), `allow-channel add|remove|list`, `set-here-threshold`, `reload-content`, `grant` (incl. Mythic Contract grants), guild admins only |

Autocomplete queries the player's own collection (fast indexed lookups). Every command auto-provisions the `guilds` and `players` rows on first touch (`INSERT … ON CONFLICT DO NOTHING`), so there's no registration step.

## 19. Button Interaction Design

**Custom ID scheme** — compact, versioned, self-describing: `wm|v1|<scope>|<action>|<entityId>|<arg>`, e.g. `wm|v1|enc|use|1234|silk_charm`, `wm|v1|shop|buy|silk_charm|1`, `wm|v1|dup|convert|5678`, `wm|v1|col|page|2|rarity=SR`. A single component router parses IDs, dispatches to handlers, and rejects unknown versions gracefully (100-char custom ID limit respected).

**Layouts (5-button row limit):**
- *Main menu:* Row 1: Hunt · Claim Daily · Shop — Row 2: Profile · Collection · Inventory · Buddy (4).
- *Encounter:* Row 1: five charm buttons (disabled when quantity 0, labels include counts; Mythic labeled "guaranteed") — Row 2: Let Her Go.
- *Shop:* one Buy button per purchasable item (3 at launch) + Close.
- *Failed attempt:* Try Again · Use Different Charm · Let Her Go.
- *Duplicate:* Keep Duplicate · Convert to Essence (+N).

**Rules:** every handler re-validates state from the DB (never trust the rendered button); ownership check first; expired encounters answer "She's already gone"; resolved interactions disable their components on edit; always `deferUpdate`/`deferReply` within 3 seconds and use follow-ups for slow paths. Ephemeral messages with buttons live ~15 minutes (Discord token lifetime) — encounter expiry (2 min) is well inside that; menu buttons that outlive their token just fail silently and the user re-runs `/waifumon`.

---

## 20. Database Schema (PostgreSQL)

PostgreSQL 16, all timestamps `timestamptz`, `bigint generated always as identity` PKs, JSON as `jsonb`, rarity/state as `text` with CHECK constraints (Postgres enums are annoying to migrate; revisit later). Key tables:

```
guilds            id, discord_guild_id UQ, announce_channel_id NULL,
                  here_threshold_rarity DEFAULT 'UR', allowed_channel_ids jsonb NULL,
                  settings jsonb, created_at

players           id, guild_id FK, discord_user_id,
                  UQ(guild_id, discord_user_id),
                  xp, level, buddy_waifu_id NULL FK, showcase jsonb,
                  last_hunt_at NULL, settings jsonb, created_at

player_currencies player_id PK/FK, hunt_energy, waifubux, essence, updated_at

species           id, slug UQ, name, rarity CHECK, archetype,
                  base_capture_rate NULL, description, tags jsonb,
                  content_rating CHECK ('suggestive'|'mature'|'explicit'),
                  image_path, enabled, event_key NULL, per_species_weight DEFAULT 1

items             id, slug UQ, name, category CHECK, capture_modifier NULL,
                  is_guaranteed_capture DEFAULT false,
                  purchasable DEFAULT false, buy_price NULL,
                  daily_stock_limit NULL, description, emoji, enabled

player_inventory  player_id FK, item_id FK, quantity CHECK (quantity >= 0),
                  PK(player_id, item_id)

player_waifus     id, player_id FK, species_id FK, level, xp, affection,
                  nickname NULL, is_favorite, variant DEFAULT 'standard',
                  cosmetics jsonb, caught_at, released_at NULL

encounters        id, player_id FK, species_id FK, channel_id,
                  public_message_id NULL,
                  state CHECK ('active'|'captured'|'escaped'|'released'|'expired'),
                  attempt_count, max_attempts DEFAULT 3,
                  created_at, expires_at, resolved_at NULL

capture_attempts  id, encounter_id FK, attempt_number, item_id FK,
                  computed_chance, roll, success, guaranteed DEFAULT false,
                  created_at

daily_claims      id, player_id FK, claim_date date, rewards jsonb, created_at,
                  UQ(player_id, claim_date)

shop_transactions id, player_id FK, item_id FK, quantity, unit_price,
                  total_price, balance_after, created_at

player_progression_events
                  id, player_id FK, event_type, xp_delta, ref_id NULL,
                  metadata jsonb, created_at
```

**Concurrency model (Postgres does the heavy lifting):**
- **Row-level locking** (`SELECT … FOR UPDATE`) on: the encounter row per capture attempt, the currency row per spend (shop, Essence investment), the inventory row per consume/purchase, the player row where ordering matters.
- **Unique constraints** as race-proof backstops: `daily_claims(player_id, claim_date)`, `players(guild_id, discord_user_id)`, partial unique index `encounters(player_id) WHERE state='active'` (one active encounter per player, enforced by the database, not just code).
- **CHECK (quantity >= 0)** and conditional updates (`… SET waifubux = waifubux - $1 WHERE waifubux >= $1 RETURNING …`) make over-spends impossible even if a lock is missed.

**Indexes:** `encounters(player_id) WHERE state='active'` (partial, doubles as the uniqueness guard), `players(guild_id, discord_user_id)` (via the UQ), `player_waifus(player_id)`, `player_waifus(player_id, species_id)` (duplicate check), `player_inventory(player_id)`, `capture_attempts(encounter_id)`, `shop_transactions(player_id, created_at)`, `player_progression_events(player_id, created_at)`, `daily_claims(player_id, claim_date)` (via the UQ).

Notes: `capture_attempts` doubles as the capture log — successful attempts *are* the log, and the `guaranteed` flag makes Mythic Contract usage unambiguous in audits. Every player-facing table reaches `guild_id` through `players`, keyed by `(guild_id, discord_user_id)` from day one. Species/items are global content; ownership is per-server.

**Tooling: Drizzle ORM + drizzle-kit** (as preferred): schema-as-TypeScript with full type inference, drizzle-kit generates plain reviewable SQL migrations run automatically at startup, first-class Postgres support (`FOR UPDATE`, partial indexes, `ON CONFLICT` all expressible), tiny runtime, and an easy raw-SQL escape hatch for anything exotic. Driver: `pg` (node-postgres) with a small connection pool (bot workloads need ~5–10 connections).

**Why Postgres from day one:** no future SQLite→Postgres migration pain; real concurrency primitives (row locks, partial unique indexes) instead of single-writer discipline; and a straight runway to the features on the horizon — trading (multi-player transactions), events, admin tools, analytics queries against live data, and multi-server expansion — all of which strain SQLite's single-process model.

## 21. Species and Item Seeding Strategy

- Content lives in `content/species/*.json` (one file per species or grouped per rarity), `content/items.json` (including shop fields: `purchasable`, `buy_price`, `daily_stock_limit`), `content/tables.json` (hunt weights, rarity weights, essence values, daily package, XP tables), `content/flavor.json`.
- All content validated at load with **zod** schemas — bad content fails startup loudly with file+field errors, never silently. Schema-level rules enforce invariants: `is_guaranteed_capture=true` ⇒ `purchasable=false`; `purchasable=true` ⇒ `buy_price` present; `content_rating` ∈ the three ratings.
- Seeder runs at startup after migrations: **upsert by slug** — new slugs insert, existing slugs update mutable fields (name, rates, prices, description, image_path, enabled, purchasable), and slugs present in DB but missing from JSON are flagged disabled (never deleted — owned waifus must keep their species row).
- Seeder verifies each `image_path` exists on disk; missing image = warning + species auto-disabled (game never renders a broken card).
- `/waifumon-admin reload-content` re-runs the seeder live (shop prices are hot-tunable this way); content is also re-seeded on every deploy. Because assets are volume-mounted, adding a species = drop JSON + PNG, run reload — no rebuild.

## 22. Local Image Asset Strategy

- Layout: `assets/waifumon/<slug>/standard.png` (plus future `holo.png` etc.), `assets/ui/` for menu banners/icons. Species JSON stores paths relative to the assets root; env var `ASSETS_DIR` (default `/app/assets`) anchors them.
- Embeds attach via `AttachmentBuilder(absolutePath, { name: 'card.png' })` and reference `attachment://card.png` in `setImage`. Attachment filename is normalized (always `card.png`) to keep embed code uniform.
- No per-image gating: PlayChannelGuard (§11) guarantees every render already happens in an NSFW-marked channel, so the attach helper stays simple and rating-agnostic.
- Path safety: resolved absolute path must be inside `ASSETS_DIR` (guards against a malicious `image_path` in content JSON).
- Sizing guidance: ~800×1100 PNG or high-quality WebP, target <500 KB per image. Discord uploads the file on every send — a tiny in-memory LRU of file buffers avoids disk reads on hot species, but is an optimization, not MVP-required.
- **Bake vs. mount:** *mount as a volume* (`./assets:/app/assets:ro`): content updates without rebuild, small image, art can live outside git. Baking is only worth it if art churn is near-zero and a single self-contained artifact is required.

---

## 23. Error Handling

- **Interaction wrapper:** every command/button handler runs through one `withInteractionGuard()` that catches, logs (structured — pino), and answers the user with a friendly ephemeral "Something went wrong, nothing was consumed" *only when that's true* — all state-changing flows are transactional, so a thrown error genuinely means no partial state.
- **Transactions everywhere state moves:** energy spend + hunt roll + reward grant; item consume + attempt insert + state update; shop verify + deduct + grant + audit — each is one transaction with appropriate row locks (§20).
- **Postgres availability:** startup uses bounded exponential-backoff retry until Postgres accepts connections (compose healthchecks help but don't cover every restart ordering). Runtime pool errors are logged; interactions during an outage get a clean "the game is napping, try again shortly" ephemeral rather than a crash. `restart: unless-stopped` covers process death.
- **Discord API failures:** public `channel.send` can fail (permissions). Capture logic commits *first*, then attempts the public post; on failure the player gets the outcome ephemerally with a note that the bot lacks channel permissions. Never let a Discord send failure eat a capture.
- **Token expiry:** stale button clicks (`Unknown interaction`, expired encounter rows) get calm, specific ephemeral messages, not stack traces.
- **Startup validation:** env config (zod-validated, including `DATABASE_URL`), DB connectivity, migrations, content seeding, asset checks — fail fast and loud before Discord login.
- **Global safety nets:** `unhandledRejection`/`uncaughtException` logged; process exits nonzero so Docker restarts it.

## 24. Anti-Abuse, Cooldowns, and Concurrency

- All limits enforced server-side from DB state: hunt cooldown (`last_hunt_at`), one active encounter per player (**partial unique index — database-enforced**), one daily claim per calendar day (**unique constraint**).
- Row-level locking + conditional state transitions kill double-click/duplicate-interaction exploits (Discord *does* deliver duplicate interactions occasionally); balance CHECKs make negative currency/inventory impossible as a last line.
- PlayChannelGuard rejects before any service call, so blocked interactions consume nothing — there is no refund path and no reroll-fishing surface.
- Ownership checks on every component.
- Rate limiting: per-player in-memory token bucket on component interactions (e.g., 10/10s) to blunt macro spam; hunt cooldown is the real economic limiter. Shop purchases are additionally idempotent-per-click via the transaction (worst case a double-click buys two — acceptable for consumables; quantity confirmation happens in the button label).
- `@here` abuse is impossible by design — only the bot's own rare-capture path mentions, thresholds are admin-configured, and `allowedMentions` is locked to exactly the intended @here.
- Audit trails (`capture_attempts` incl. `guaranteed` flag, `shop_transactions`, `player_progression_events`, `daily_claims`) make any suspected exploit reconstructable; admin `grant`/inspect commands aid investigation.
- Multi-accounting is out of scope for MVP (no trading = little incentive); flagged as the risk trading will later force us to address.

---

## 25. Testing Strategy

**Vitest**, with **real Postgres for integration tests** — via **Testcontainers** locally (spins up a disposable Postgres per suite) and a Postgres service container in CI. Real SQL, real migrations, real locks — no mocking the DB, and no SQLite stand-in (dialect differences around locking and `ON CONFLICT` are exactly what we need to test).

- **Unit — pure logic (no DB, fastest):** weighted roll utility (distribution tests with seeded PRNG), capture chance formula (table-driven cases incl. clamps, buddy bonus, **Mythic guaranteed bypass**), XP curves and level-unlock computation, essence values, energy/cooldown math, **PlayChannelGuard decisions** (NSFW flag × allowlist × thread-inheritance × DM matrix).
- **Service tests (core of the suite, real Postgres):** `HuntService`, `CaptureService`, `DailyService`, `ShopService`, `ProgressionService`, `CollectionService` with injected seeded RNG and fake clock — covering: energy decrement + insufficient energy, cooldown rejection, channel-guard block consuming nothing (no energy, no cooldown, no rows), encounter lifecycle including expiry, all 3-attempt paths, Mythic Contract guaranteed path + `guaranteed` log flag, duplicate flows, daily double-claim (unique-constraint path), **shop purchases: success, insufficient funds, disabled item, capacity rejection, audit row correctness**, transactional rollback on injected failure.
- **Concurrency tests (the reason we're on Postgres):** parallel capture-attempt calls on one encounter (exactly one proceeds), parallel daily claims (one succeeds), parallel shop purchases draining a balance (never negative), parallel hunts vs. the one-active-encounter partial index.
- **Migration tests:** fresh database migrates from zero to head; seeder is idempotent (run twice, same state).
- **Monte Carlo balance tests:** 100k simulated hunts asserting rarity distribution and capture-rate curves within tolerance; shop-economy sanity (daily income vs. price ladder).
- **Content validation tests:** every shipped JSON file passes the zod schemas (including shop-field invariants); every referenced image exists (runs in CI).
- **Discord layer:** kept deliberately thin (handlers parse interaction → call service → render embed) and covered by a few tests with stubbed interaction objects for the custom-ID router, visibility rules (ephemeral vs public flags), and PlayChannelGuard middleware ordering (the guard runs before any handler). No live-Discord integration tests in MVP; manual test checklist on a private test server instead.

## 26. Docker / Deployment Strategy

- **Dockerfile (bot):** multi-stage — `node:22-alpine` build stage (install, `tsc`), slim runtime stage with prod deps only, non-root user, `NODE_ENV=production`. `pg` is pure JS — no native build headaches.
- **docker-compose.yml:**
  - `waifumon-bot` service: env from `.env`; `depends_on: postgres: condition: service_healthy`; `restart: unless-stopped`; volume `./assets:/app/assets:ro`.
  - `postgres` service: `postgres:16-alpine`; env `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`; named volume `waifumon-pgdata:/var/lib/postgresql/data`; healthcheck `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB`; **not port-mapped to the host by default** (bot reaches it on the compose network; expose only for local debugging).
  - Volumes: `waifumon-pgdata` (persistent DB), `./assets` bind mount (read-only).
- **Environment variables:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DATABASE_URL` (e.g. `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB`), `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `ASSETS_DIR=/app/assets`, `HUNT_COOLDOWN_SECONDS`, `DAILY_TIMEZONE`, `LOG_LEVEL`.
- **Startup order:** validate env → **retry-connect to Postgres with bounded exponential backoff** (belt-and-suspenders over the compose healthcheck) → run migrations → seed/validate content & assets → register slash commands (guild-scoped for instant iteration; global later) → Discord login.
- **Development:** same compose file (or a `compose.override.yml` exposing 5432 and enabling watch-mode) — dev and prod both run real Postgres, so there is no dialect drift.
- **Backups (pg_dump):** nightly `docker compose exec -T postgres pg_dump -U $POSTGRES_USER -Fc $POSTGRES_DB > waifumon-$(date +%F).dump` via host cron or a small sidecar; retain 7 daily + 4 weekly; copy off-host. `-Fc` (custom format) enables selective restore.
- **Restore (high level):** stop the bot → restore into a fresh database with `pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists waifumon-YYYY-MM-DD.dump` → start the bot (migrations no-op if the dump is current). **Test a restore once before launch.**
- **Scaling note:** one bot process + Postgres comfortably serves a single server and well beyond; Postgres removes the old single-writer ceiling, so future sharding/multi-instance work is an application concern, not a database migration.

---

## 27. Phased Implementation Roadmap

**Phase 0 — Foundation (2–3 days):** repo scaffold (TS strict, ESLint/Prettier, Vitest), config loading + validation, logging, Docker Compose with bot + Postgres + volumes, Postgres connection with retry, Drizzle schema + first migration, Testcontainers wiring, CI running tests.

**Phase 1 — Economy core (3–4 days):** zod content schemas + seeder (species/items/tables incl. shop fields), asset validation, **PlayChannelGuard middleware wired into the interaction router**, player auto-provisioning, currency + inventory services, daily claim, **MVP shop (service + UI)**, profile + inventory UI. *End of Phase 1 = first coding milestone done.*

**Phase 2 — Hunt & encounters (2–3 days):** hunt roll + energy + cooldown, non-encounter rewards, encounter creation + lifecycle + expiry, ephemeral encounter reveal.

**Phase 3 — Capture (3–4 days):** full 3-attempt capture state machine, inventory consumption with locks, Mythic Contract guaranteed path, public message posting/editing, capture logs, duplicate keep/convert, rare announcements + @here threshold.

**Phase 4 — Collection basics (2 days):** paginated collection list, counts + dex completion, rarity/name sorting, inspect detail card (gated images), `/waifumon inspect`. *End of Phase 4 = first playable milestone.*

**Phase 5 — Progression & polish (3–4 days):** XP events, player levels + implemented unlocks, waifu leveling + affection + Essence investment, buddy, nickname, favorites, release, collection filters.

**Phase 6 — Hardening & launch (2–3 days):** admin commands, rate limiting, error-path polish, Monte Carlo balance pass, backup/restore drill, manual test checklist on staging server, real art drop-in, launch.

**Post-MVP backlog (ordered):** shop expansion (quantity picker, Prismatic enablement with daily stock), variants (holo), quests/daily targets, events (EX + `event_key`), duplicate auto-preferences, channel-restriction admin config, trading (with its anti-abuse implications).

## 28. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Economy imbalance** (shop prices vs. income) | All numbers in content JSON, Monte Carlo + shop-economy tests, admin reload for hot price tuning, expect a tuning patch in week one |
| **Mature content rendered outside NSFW channels** (compliance) | PlayChannelGuard runs before every command/button handler — one choke point, unit-tested; the game simply does not function outside NSFW-marked channels |
| **Public-message spam** annoys non-players | Only first-attempt-onward is public and it's one edited message per encounter; consider an admin-set dedicated channel if volume complains |
| **@here fatigue** | Threshold defaults to UR+ (~1% of captures); admin-tunable; can raise or disable per guild |
| **Ephemeral token expiry mid-flow** | 2-min encounter expiry sits far inside the 15-min token window; stale clicks handled gracefully |
| **Postgres outage / data loss** | Compose healthcheck + bot retry-connect; nightly `pg_dump` (7 daily + 4 weekly, off-host copy); restore drill before launch |
| **Race conditions** (double-claims, double-spends) | Row locks + unique constraints + CHECK constraints + dedicated concurrency tests — enforced by the database, not just code |
| **Content/asset drift** (JSON references missing art) | Startup validation auto-disables broken species; CI content tests |
| **Discord rate limits** on capture bursts | discord.js queues internally; one public message per encounter (edits, not sends) keeps volume low |
| **Scope creep** (trading! events! bigger shop!) | Non-goals list is the contract; shop is capture-items-only by design; backlog is ordered; MVP ships first |

## 29. Open Questions Before Coding

1. **Daily reset timezone** — UTC, or the server community's local timezone? (Affects when the daily rush happens.)
2. **Dedicated play channel at launch?** The admin allowlist supports confining Waifumon to one NSFW channel — recommended, since it concentrates the social capture feed. Configure at launch or leave open to all NSFW channels?
3. **Art pipeline** — who produces the ~50 launch images, at what dimensions/format, and is placeholder art acceptable for staging?
4. **Duplicate default on timeout** — keep (recommended) or auto-convert?
5. **Should daily claims be public brags** or stay ephemeral in MVP?
6. **Multiple guilds at launch?** Design supports it, but if it's genuinely one server, slash commands can stay guild-registered (instant updates) indefinitely.
7. **Names/flavor tone** — any content boundaries for species writing beyond "mature anime" (helps content authors move fast)?
8. **Shop UI detail** — Mythic Contract greyed-out "Not for sale" row (mystique) or absent entirely?

*(Resolved in prior revisions: SQLite vs Postgres → Postgres; Mythic Contract → guaranteed; content gating → whole-game NSFW play-channel guard, `content_rating` metadata only; shop → yes, capture items only.)*

## 30. Milestones — First Coding vs. First Playable

### Milestone 1 (first coding): "Standalone Postgres Foundation" — Phases 0–1, ~1 week

Definition of done:
- Docker Compose starts bot + Postgres with persistent DB volume and mounted assets volume.
- Bot connects to Postgres (with retry) and runs migrations to head.
- PlayChannelGuard blocks all commands/buttons outside NSFW-marked (or allowlisted) channels, consuming nothing.
- Content seed data for all 5 items (with shop fields) and placeholder species loads and validates; seeder is idempotent.
- Player provisioning works (`ON CONFLICT` upsert on first interaction).
- Currency and inventory services work with locks and constraints.
- Daily claim grants Hunt Energy, WaifuBux, and capture items; double-claim is constraint-blocked.
- MVP shop buys Basic/Silk/Velvet Charms with WaifuBux, fully transactional, with `shop_transactions` audit rows; Prismatic listed-disabled; Mythic absent/not-for-sale.
- Tests pass for: migrations, content validation, PlayChannelGuard decision matrix, player provisioning, currency, inventory, daily claim, shop purchases (incl. insufficient-funds, disabled-item, capacity, and concurrency cases).
- **No hunt/capture logic yet.**

This milestone deliberately proves the entire operational spine — compose, Postgres, migrations, seeding, transactions, locking, testing harness — on the simplest possible gameplay surface (daily + shop), so the capture state machine lands on solid ground.

### Milestone 2 (first playable): "First Capture" — Phases 2–4, ~1.5–2 weeks after M1

Definition of done:
- Hunt spends energy, honors cooldown, rolls the full result table.
- Encounters render ephemerally with local images and live charm buttons; the full 3-attempt state machine works including the Mythic guaranteed path; public attempt/capture/escape messages post and edit correctly; duplicates prompt keep/convert; SSR+ announcements fire with the @here threshold.
- **Players can view what they caught:** paginated collection with counts and sorting, and an inspect detail card (image-gated per channel).
- Core services have passing Vitest coverage including Monte Carlo distribution and concurrency tests.

Everything after M2 (progression depth, buddy, release, filters, polish) is low-risk accretion.

---

## 31. Diff Summary

### Revision 3 (current) — channel gating simplified

1. **ContentGate removed as a per-species image gate.** No rating-based render logic anywhere — the image-attach helper is rating-agnostic again, and the "explicit blocked in SFW channel" hunt branch (with its energy-refund-but-keep-cooldown rule) is gone.
2. **PlayChannelGuard added** (§11): a middleware that runs before **every** command and component handler. Rules: guild channel only, must be NSFW-marked (threads inherit the parent flag), and — if the guild configured one — must be on the allowed-channel list.
3. **Optional admin allowed-channel list:** `/waifumon-admin allow-channel add|remove|list`, stored as `guilds.allowed_channel_ids` (replaces the `nsfw_gating_mode` column). Empty list = any NSFW channel. `set-announce-channel` validates the target is NSFW.
4. **Blocked interactions consume nothing:** the guard rejects before any service call — no Energy, no cooldown, no rolls, no rows. The old refund/cooldown anti-fishing rule is unnecessary because the roll never happens.
5. **`content_rating` demoted to metadata only:** kept in species JSON and the DB (`suggestive`/`mature`/`explicit`) for organization and future filtering, but it drives no runtime behavior in MVP.
6. **Ripple updates:** guard moved into Phase 1 (it ships with the first commands) and into Milestone 1's definition of done; testing swaps the ContentGate matrix for a PlayChannelGuard decision matrix (NSFW × allowlist × threads × DMs) plus middleware-ordering tests; the compliance risk row now points at the single guard choke point; open questions trimmed accordingly.

### Revision 2 — vs. original plan

1. **Postgres replaces SQLite entirely (Rev 1).** better-sqlite3 is gone; the stack is PostgreSQL 16 + `pg` + Drizzle ORM/drizzle-kit (kept from before, now targeting Postgres). Schema section rewritten with Postgres types (`timestamptz`, `jsonb`, identity PKs, CHECK constraints), explicit row-level locking strategy (`FOR UPDATE` on encounters, currency, inventory), a database-enforced partial unique index for one-active-encounter-per-player, and a full index list. Docker section rewritten: compose now runs `waifumon-bot` + `postgres` services, `waifumon-pgdata` volume, healthcheck + bot-side retry-connect, `DATABASE_URL`/`POSTGRES_*` env vars, `pg_dump` backup and `pg_restore` guidance. `/app/data/waifumon.db` and SQLite backup guidance removed. Testing now runs against real Postgres (Testcontainers + CI service container) with new dedicated concurrency tests. Rationale recorded: avoids future migration pain; enables trading, events, admin tools, analytics, multi-server growth.
2. **MVP shop added (Rev 2)** — new §16, plus Shop button/command, shop fields on items (`purchasable`, `buy_price`, `daily_stock_limit`), `shop_transactions` audit table, transactional purchase flow with locking and capacity checks, launch prices (Basic 25 / Silk 75 / Velvet 200 / Prismatic 750-disabled / Mythic never sold), and economy sanity-check math. WaifuBux "no sink in MVP" language removed throughout.
3. **Collection/inspect moved into the first playable milestone (Rev 3)** — §17 split into a required first-playable tier (paginated list, counts, dex completion, rarity/name sort, inspect detail card) and a later-phase MVP tier (filters, favorites, buddy actions, release). Roadmap Phase 4 covers it; Milestone 2's definition of done requires it.
4. **Explicit-content channel gating promoted to MVP requirement (Rev 4)** — introduced a per-species ContentGate (three ratings, block-mode, image-attach-helper enforcement). *Superseded in Revision 3 by the whole-game PlayChannelGuard above.*
5. **Mythic Contract behavior locked (Rev 5)** — guaranteed capture, bypasses the formula (the former "guaranteed vs flat-90%" config flag is removed), extremely rare, never sold in MVP, sources limited to rare hunt finds/admin grants/future events, `guaranteed` flag on capture-attempt logs, and explicit "guarantees capture" UI copy.
6. **Roadmap and milestones restructured (Rev 6)** — old Phases 0–4 replaced with Phases 0–6; the first coding milestone is now the smaller **"Standalone Postgres Foundation"** (Phases 0–1, no hunt/capture logic) and is explicitly separated from the first playable milestone **"First Capture"** (Phases 2–4, which now includes collection viewing).
7. **No scope expansion beyond the six revisions** — trading, marketplace, PvP, events, public spawns, image generation, and shop categories beyond capture items remain out; the game stays standalone and button-first.
