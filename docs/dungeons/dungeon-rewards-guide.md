# Creating Dungeon Rewards

Dungeon Loot belongs to Delve. Editing these tables does not retune expedition,
guild-boss, World Encounter or vendor rewards. You need dungeon read access to
inspect loot and Test Roll, write access to edit, and publish access to make a
dungeon's new rewards playable.

## Start with an activity

Select a Combat, Boss or Treasure activity in the Dungeon Editor and open
**Rewards**. Combat and Boss pay once after the player wins the final wave.
Intermediate waves, defeat and declining an optional fight pay nothing. Treasure
pays when opened. Returning to a fight and winning again cannot claim its loot
again in the same run. Boss activities have no automatic reward multiplier.

Use **Guaranteed** for every reward the activity must give. Use one number or
choose a range; endpoints are inclusive. Use **Chance drops** for rewards that
each roll independently. Two 25% entries can both hit, both miss, or one hit.
A 100% drop belongs under Guaranteed; remove a 0% drop.

Choose items by name. Charms and salvage are ordinary items here. Disabled items
and items with a per-player ownership limit cannot be selected as valid new
loot. Publication also checks the items inside shared tables. Dependency problems
can be saved in a draft for later repair; they block publishing. Malformed
amounts or percentages must be corrected before the draft can be saved.

Affection always goes to the WaifuMon brought into that run. Switching Buddy
later does not change the recipient or the bonus. The participant cannot be
released or converted to Essence until the run ends.

## Create reusable loot

From the dungeon list, open **Dungeon Loot Tables**, then **New loot table**.
Give it a name, optional description and tier. Common, Rare, Boss and Legendary
are labels for organisation; they do not change odds or rewards.

A table has three parts:

| Part | What one table roll does |
| --- | --- |
| Every time | Gives every guaranteed entry |
| Chance drops | Checks each entry independently |
| Groups of random picks | Makes the group's number of picks; each pick chooses one row by its share |

Shares are relative. An item with share 1 and **Nothing** with share 3 has a 25%
item chance per pick. Nothing is an intentional empty result. Without a Nothing
row, a valid pool always picks a reward. Separate groups each make their own
picks. Picks use replacement: the same row can be selected twice.

Add the table to an activity with **Add loot table** and choose its roll count.
Two table rolls give its guarantees twice, check its chances twice, and make
twice as many picks in every group. If a pool makes two picks and the activity
rolls the table three times, that pool makes six picks. Tables cannot contain
other tables. For a weighted choice directly associated with one activity,
create a table and attach it.

**Open table** opens its editor alongside the dungeon. Save the table, then
review the dungeon's validation and publication status. Saving shared loot does
not update published dungeons. The list supports search, tier filtering,
duplication, usage review and history. Archive hides a table from pickers and
blocks publishing drafts that still name it. Restore makes it selectable again.
Delete requires an archived table with no draft reference; revisions with a
verified frozen copy can keep using that copy after deletion.

If another author saves first, review the newer revision and choose whether to
keep your edits or use theirs. Your unsaved edits remain available to review.

## Choosing equipment

Filter by slot/rarity or select specific pieces. The eligibility preview lists
the pieces the selector can award. No matching gear is a publication error.
One equipment entry grants one instance; more entries or rolls give more pieces.
Rewards do not equip gear automatically.

**Publishing freezes which definitions can drop.** Adding a matching piece
later does not add it to an existing publication. Review **Loot changed** and
publish again to use the new eligible list. Disabling a promised definition
does not erase an existing publication's promise; deleting it can block payout.

**Stat ranges, affix rules and combat-bonus generation rules remain live.** They
are read when gear is awarded. A drop has its own deterministic seed, so retries
produce the same roll while these rules remain unchanged. Editing the rules
between a failed attempt and retry can change the eventual roll. Test Roll
shows the selected piece, not simulated instance stats or affixes.

## Check the odds before publishing

**See all odds** shows exact averages and chances from the server's analyser.
**Test roll** uses the same resolver as gameplay and can check unsaved edits.
Reuse its seed to reproduce a sample; simulations offer an observed comparison
with the exact odds. Nothing is granted to any player.

An average is an expectation across many rolls, not a promise for one run.
For a 25% item chance and two independent rolls, the chance of at least one is
43.75%. Two rolls of an item/Nothing pool with the same 25% chance have the same
at-least-one chance, while each successful pick still gives its own item.
Guaranteed rewards make the chance of receiving nothing overall zero even if
all gear drops miss. Essence and affection averages are before the run Buddy's
bonus. An unavailable dependency is shown as an error, not a Nothing result.

## What players keep

| Reward | Timing and risk |
| --- | --- |
| Baddie Shards and new-format WaifuBux | Accumulate at risk; bank when the run ends |
| Items, equipment, Essence, affection | Granted immediately on activity success; kept after defeat/abandon |

Shards means the dungeon's configured progression currency. Set that currency
before adding Shard rewards. The dungeon's Currency Risk settings control both
at-risk currencies: extraction/completion keep 100%, defeat uses the defeat
rate, and abandon uses its own rate. Each amount rounds down separately.
New dungeons start with defeat **keep half**, abandon **keep nothing**. Older
definitions without a separate abandon choice still follow their defeat rate.

For example, defeat at 50% with 45 Shards and 501 WaifuBux banks 22 Shards and
250 WaifuBux. All secured rewards stay owned. Existing wallet balances are
never reduced. Disconnect or restart leaves the run active without settlement.
If the configured progression currency is removed or disabled during a run,
Shard banking is skipped and recorded; earned WaifuBux settle independently.

An undeliverable secured reward fails the entire activity step. No partial
loot or successful receipt commits; progress stays at the previous step so it
can be retried after repair. Discord's Kept and settlement summaries show what
was actually committed, including the affection recipient and bonus.

## Worked example: a foreman's boss loot

Create a **Foreman Cache** table with one guaranteed Bent Gear item, a 30%
chance of 5–10 Essence, and a group making one pick between an R gear selector
(share 3) and Nothing (share 1). Use valid uncapped items and eligible pieces
from your environment; these names and amounts illustrate authoring, not a
prescribed balance.

On the Boss activity:

1. Add guaranteed **40–60 Baddie Shards**.
2. Add a **5% equipment chance**, selecting the desired slot/rarity.
3. Add **Foreman Cache**, rolled **twice**.
4. Inspect eligibility and odds; Test Roll; save, review and publish.

After final-wave victory, the player earns 40–60 at-risk Shards and gets two
Bent Gear. The direct 5% gear check is independent of the cache. The cache makes
two Essence checks and two gear/Nothing picks. With 75% gear chance per cache
pick, its chance of at least one piece is 93.75%, averaging 1.5 pieces. The
direct check adds an average 0.05 pieces, for 1.55 total. Gear/items/Essence are
secured; the Shards are banked according to the eventual run outcome.

## Publication and repairs

Saving edits creates working content. **Publish** validates and freezes the
reward table bodies and eligible equipment lists into a new dungeon revision.
**Loot changed** means live reward dependencies differ from that publication;
**Dungeon changed** means the definition differs. Both can appear together.
**Loot needs repair** means the current draft cannot be published as configured.
Names/descriptions/tiers alone do not force a gameplay revision.

After changing shared loot, publish each affected dungeon explicitly when
ready. Published revisions keep paying their old loot until then. Active runs
keep their original revision even after republishing or rollback. Turning off
a dungeon stops new starts; it does not stop active runs or erase promised loot.

**Reward Health** checks current publications and older revisions with runs in
progress. It reports missing/capped items, missing equipment and invalid frozen
snapshots. It is read-only and lists run counts without player identities.
Ordinary table edits do not break frozen loot. Draft errors and publication
health are separate. Legacy-only publications show no frozen rewards to check;
that does not certify their live expedition tables.

For new runs, repair the draft and publish. For an older active run, republishing
cannot change its promise: restore the same item/gear key or remove the item's
new ownership limit as appropriate. Follow the reported repair guidance. Health
does not certify every live equipment roll rule or every unused historical
revision, so verify those changes separately.

## Legacy Treasure conversion

An old Treasure shows its expedition tables and **Convert to dungeon rewards**.
Preview first. The conversion copies both legacy tables' actual payable
WaifuBux, items and gear into Dungeon Loot and preserves their probabilities,
including explicit Nothing shares. Legacy Essence and XP are omitted because
dungeons never paid them. The extra gear-labelled table is copied in full; it
may also contain items and WaifuBux.

Conversion changes only the draft and can create/reuse converted tables.
Publish to make it playable. The preview explains that WaifuBux become at risk
and seeded outcomes change. Unsupported zero-to-positive Shard ranges or exact
weights exceeding the new limits need manual review. Existing published legacy
Treasure and active runs retain immediate secured WaifuBux and their old rolls.

## Move a dungeon between environments

Export **Published** or a numbered revision to carry its frozen reward tables;
export **Draft** to carry current validated working loot. New rewards use
package v2, with verified table bodies/hashes and source equipment candidates.
Legacy-only dungeons still export v1. A v2 file needs a Phase 2 backend.

On the target, choose **Import Dungeon** and review the plan:

| Table on the target | Decision |
| --- | --- |
| Missing | Create the bundled table, or explicitly leave an incomplete draft |
| Identical body | Reuse it; no table edit is written |
| Different body | Choose import as a copy under a free key, or explicitly use existing |

A copy rewrites every imported activity reference to the new key. Use-existing
means the target's loot wins: read the body comparison and acknowledge that
rewards differ. Imports never overwrite an existing table. Review **Different
gear can drop here** when target equipment candidates differ. Items, equipment
definitions, currencies, regions and image bytes must be installed separately.
An incomplete import remains blocked from publication until dependencies work.

Apply the reviewed plan. If it becomes stale, preview again and review the new
state. An uncertain response keeps the exact request for retry; keep that page
open until the receipt is confirmed. V2 imports create or replace **disabled,
unpublished drafts**. Replacement keeps historical revisions and active runs
but clears the current published pointer. Publish and enable explicitly after
review. V1 replacement retains its earlier enabled/published behaviour.

Package hashes verify gameplay identities and table bodies, not authenticity
or every display label. Use a trusted export source and review names and
warnings as well as hashes. Description/origin can be absent from published
exports because old snapshots did not store them.
