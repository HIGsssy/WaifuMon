# Dungeon Events creator guide

An event tells a short story and offers up to five choices. A choice can require
an item, try a skill check, award loot, change health or remember something that
opens a later path. Events belong to one dungeon. Players encounter them while
playing that dungeon on Discord.

Use a **specific event** when a room should always contain the same scene: a
sealed vault or broken generator. Use a **random event pool** when a room should
draw one scene from several possibilities, such as finds in a scrapheap. Both
use the same event editor and choices. An event library entry does nothing until
you attach it to a room or to a pool used by a room.

## Create and attach an event

1. Open the dungeon in the Dungeon Editor and select its room on the map.
2. In the room's **Event** setting, select **A specific event** and choose an
   existing event, or create one. For a draw, select **A random event from a pool**.
3. Open **Edit** to work in the event or pool side sheet. The room sequence puts
   a newly attached event before a final leave activity; review the sequence if
   the room contains other activities.
4. Write the story and choices, close the sheet, and **Save** the dungeon draft.
   Sheet edits are part of that draft; closing the sheet does not save to the server.

The **Events** list in dungeon settings lets you create, duplicate and manage
events and pools. It shows where each is used. Detach references before deleting
an event or pool that is in use. Editing a reused event changes every reference
in this draft. Duplicate it first when two rooms need different scenes.
The Locked door, Risky shortcut and Shrine starters are useful starting points.
Readers can inspect and test events; saving and publishing require editing permissions.

## Story and artwork

Give the event a short title and a narrative that establishes the situation.
The limits are 80 characters for the title and 1,500 for the story. Button text
has 60 characters, a choice description 200, result text 800 and unavailable
explanations 120. Use the Discord preview to check how the whole scene reads.

Choose an **Event picture** using the dungeon background artwork picker. An
event picture is optional. Without one, Discord falls back through the room
background, dungeon background and dungeon artwork, then a text-only screen.
Event scenes do not place the Buddy on top of the picture. Missing artwork is
a review notice rather than a gameplay blocker. Managed pictures travel by
reference, not as image bytes: upload the matching asset in another environment.
Replacing a managed asset can change the picture shown to an active run; revision
pinning does not freeze the stored image bytes.

## Choices, requirements and consumption

Under **Who can pick this?**, add rules about remembered run events or completed
rooms, and up to two required inventory items. All item requirements must be met.
Quantity can be 1–99. An unavailable choice normally remains visible and disabled;
write a helpful explanation, or select **hide when unavailable** if it should be secret.

Requiring an item and using it up are separate settings. A reusable key can be
required without consuming it. With **used up** selected, the quantity is spent
when the player commits that choice, **including when its skill check fails**.
Explain the cost in the choice description; Discord also shows a consumption warning.
Ownership is checked when the choice is pressed. If another action has spent the
item in the meantime, the event stays open and the screen updates.

Every event needs at least one choice with no item or rule requirements so that
players cannot become stuck. At the entrance, that choice must let the player
continue: **Turn back** has nowhere to go. A turn-back result leaves the event
open for a later visit. It must have no rewards, health or flag changes, skill
check, or consumed items. If you want a permanent decline, make an ordinary
choice whose result says the player leaves it alone and carries on.

## Certain results and SP checks

Under **What happens?**, choose **Always the same result** or **Skill check: it
can succeed or fail**. A checked choice has separate success and failure results;
give both a story and review the rewards and effects on both branches.

**Chance for an average Buddy** sets the chance at 200 SP. Stronger Buddies
increase it and weaker Buddies reduce it. The default influence reaches
15 percentage points either way, at 350 SP or 50 SP. Advanced controls can change
that influence. The final chance stays between 5% and 95%; use a certain result
when you need a guaranteed outcome. For example, 55% for an average Buddy becomes
40% for a weak Buddy and 70% for a strong Buddy with the default influence.

Discord displays the chance for the Buddy participating in the run. That Buddy's
SP is fixed when the run starts, so changing equipment midway does not change
the check. Pool selection and checks are reproducible within a run. Reopening
the screen, disconnecting, retrying or turning back does not provide a fresh roll.
A committed failed check resolves the event just as a successful one does.

## Results, rewards, health and remembered events

Each result can tell the player what happened, set a tone, add rewards, and add
up to six effects. **Remember that something happened** sets a run flag;
**Forget it again** clears it. Name the thing in plain language, such as
“Generator repaired”. These memories last only for this run.

**Restore health** and **Lose health** use a percentage of the Buddy's maximum
HP, rounded down. Healing stops at full health; event damage leaves at least
1 HP. A defeat ending is an explicit result setting, separate from health loss.

Use **Rewards** to select the same guaranteed rewards, chance drops and Dungeon
Loot tables used by treasure and battles. See the
[Dungeon Rewards guide](dungeon-rewards-guide.md). Shards and WaifuBux accumulate
as loot at risk until the run settles. Essence, items, Equipment and affection
are secured when granted, subject to the ordinary reward rules and limits.
Consumption, effects, reward grants and the result commit together. A failed
delivery keeps the event unresolved for a retry without spending the item twice.

The result's **Then** setting can carry on, jump forward to a later activity,
finish the room, turn back, or end the run as completed or defeated. A completed
ending banks the run's at-risk currency; a defeat uses the dungeon's retention
setting. A turn-back result keeps the selection open. For a later path, use a
remembered event in the connection's rule rather than trying to move the player
directly from the event.

## Random pools

Create a pool, name it, and add entries under **What can happen**. Each entry
selects an event or **Nothing happens**, with optional text. Its **share** is a
relative weight, not a percentage. Shares of 30, 20, 10 and 40 give 30%, 20%,
10% and 40% when all four entries are eligible. Entries can have rules about
run memories or completed rooms. The **Chances** section shows both the full
draw and the draw in your selected scenario.

**Once per run** is on by default for an event entry. Once that event is selected
anywhere in the run, another once-per-run pool entry for it cannot be selected,
even if the player turns back before answering. This applies across rooms and
pools. Attaching that event directly to a room still presents it there; direct
placement is deliberate. Turn once-per-run off for an event that may repeat.
Nothing entries remain repeatable.

Unavailable entries leave the draw and the remaining shares are recalculated.
After the 30-share event has been seen, the other shares above become roughly
28.6%, 14.3% and 57.1%. If no entries remain eligible, nothing happens. A pool
selection is saved as soon as the player encounters it; returning uses that
selection, even if a flag later changes which entries would now be eligible.

## Preview, sandbox and publication

In **How players see it**, try scenarios with different inventory quantities,
remembered events, completed rooms, previously seen events and permission to
turn back. Weak, average and strong Buddy settings show how SP changes chances.
Pool previews use the same draw eligibility and chance rules as play. A preview
describes an assumed situation; it does not give a player items or change a run.

Open the dungeon sandbox, choose a seed and assumed inventory/Buddy strength,
and **Play the dungeon** from its entrance. Use **Skip ahead** to reach an event
through the dungeon's actual sequence, then try choices and follow paths. Test
both check branches with different seeds, a missing item, a changed flag, a
return visit and a second room using the same pool. Inspect health, recorded
costs, rewards and settlement. The sandbox writes no player inventory or balances.

Save, validate and fix blocking issues before publishing. Rewards and dependencies
reachable only through event outcomes are included in publication. Unused library
ideas do not bring their reward, required-item or artwork dependencies into the
published run, but must still be structurally valid. Check Reward Health for
missing or disabled required items; disabling an item is a notice and can make
it difficult for players to obtain. Choices read actual inventory, not a pinned
quantity. Missing required item definitions block publication.

Publishing creates a revision for new runs. Existing runs keep their event
definitions, choices, chance settings and reward snapshot, including an event
already offered. Editing a draft, publishing again, importing over the dungeon
or rolling publication back does not rewrite those runs. Their random selections
remain saved.

## Worked example: The Sealed Vault

1. Attach a specific event to the Vault room. Title it **The Sealed Vault** and
   explain that a blast door blocks the chamber. Add a vault picture if available.
2. Add **Use the Vault Key**. Require one existing Vault Key item and mark it
   used up. Give it a certain result that remembers “Vault opened” and awards a
   small treasure bundle.
3. Add **Work the lock** with a 55% average-Buddy SP check. Success remembers
   “Vault opened” and awards a smaller reward. Failure remembers “Alarm triggered”
   and explains the jam. If this choice also spends a tool, describe that it is
   lost even on failure.
4. Add **Force it** with no requirements. Its certain result loses 25% maximum
   health and remembers “Vault opened”. This is the always-available way forward.
5. In a room reached from another room, optionally add **Leave it** with **Turn
   back** and no cost or effects. It leaves the same vault waiting on return.
6. Preview with and without a key and with weak/strong Buddies. In the sandbox,
   check that consumed items disappear once, failure resolves once, and a return
   visit cannot repeat treasure. Do not use Turn back as the sole entrance fallback.

## Worked example: Scrapheap randomized events

Create **A Buried Crate**, **A Sparking Drone** and **A Scavenger** as events,
each with a choice available without requirements. Give the crate a small
salvage reward, the drone a risky interaction, and the scavenger a simple trade
or conversation using the supported costs and rewards.

Create **Scrapheap finds** with shares 30 for the crate, 20 for the drone,
10 for the scavenger and 40 for Nothing, with “Nothing but rust” as its text.
Require “Alarm triggered” to be false for the scavenger entry. Leave each event
entry once per run. Attach the pool to two different rooms. Preview the full
draw, an alarmed run and a run where the crate has already been seen. Play both
rooms with several seeds and verify the crate cannot be drawn twice. Turn back
and revisit an offered event to confirm it stays the same.

## Worked example: The Dead Generator

Attach **The Dead Generator** to the Generator room. Explain that the lift needs
power. Add **Repair it** requiring three existing Scrap Parts and consuming them.
Use a certain result to remember “Generator repaired”; or use an SP check with
success remembering it and failure explaining the failed repair. Parts are lost
on either check branch. Add **Leave it broken** without requirements, carrying
on without that memory, so the room remains playable without parts.

On the connection to the lower level, require “Generator repaired” and write
“The lift has no power” as its locked message. Provide another exit or extraction
route so failure does not strand the player. Test that the lift is locked before
repair, opens only after the flag is set, and stays locked after failed repair.
For a checked repair, keep the alternate route: revisiting a resolved generator
does not retry its check. A new run starts with the generator memory cleared.

## Export and import

Use the dungeon's normal package export. Any event library, pool or event action
produces **package v3**, carrying events, pools, artwork references, required item
slugs and reachable reward dependencies. Existing event-free packages continue
to use v1 or v2. Published export uses that publication's frozen reward snapshot.

On another environment, inspect the file and review the import plan. Missing
bundled Dungeon Loot tables can be created; identical tables need no conflict
decision. For different tables, choose the target's existing rewards or import
a copy with a new key. Copy updates both success and failure reward references.
The review shows that using target rewards can change what players receive.

Required item definitions must already exist on the target. Import does not
create global items or transfer player holdings. Explicitly accept missing or
disabled requirements only when intentionally keeping an incomplete draft.
Resolve those notices before release. Artwork bytes also need uploading separately.
New imports are disabled and unpublished. A replacement import changes only the
target's draft: it stays enabled or disabled, and its published revision stays live
until you publish the draft. Existing active runs still use their old revision. Retry an uncertain import with its original
request; a changed plan needs a fresh review. Manually changing package contents
can invalidate its integrity checks; edit in the Dungeon Editor and export again.

## Troubleshooting

| Notice or symptom | What to check |
| --- | --- |
| No always-available choice | Add a choice with no rules or item requirements. Hiding a restricted choice does not provide a fallback. |
| Entrance cannot progress | Add an unrestricted choice that carries on or finishes the room instead of turning back. Check every event the entrance pool can draw. |
| Missing event, pool or remembered event | Reattach a valid library entry or declare the memory in the editor. Remove stale references before deleting entries. |
| Turn-back result is invalid | Remove its effects, rewards, skill check and consumed items. |
| Missing required item or loot table | Select an existing catalogue entry; repair target dependencies after import. Required item slugs must match the target catalogue. |
| Disabled item health notice | Review how players obtain it; re-enable or choose an obtainable item. Held quantity still determines choice availability. |
| Pool chances differ from shares | Check conditional entries and once-per-run exclusions in the scenario; percentages use only eligible shares. |
| Pool does nothing | Check for a Nothing selection or no eligible entries. Neither is a reroll prompt. |
| Unexpected health change | Percentages use maximum health and round down; healing caps at full and damage stops at 1 HP. |
| A later path remains locked | Check that the successful result remembers the same run event the path requires, and that the sandbox scenario includes it. |
| Picture missing | Verify category, hash or shipped asset path on this environment; upload matching managed bytes. |
| Old run shows old event/rewards | Revision pinning is expected. Start a fresh run to test a new publication. |
| Import plan changed | Reinspect and review current target catalogues. Do not reuse an outdated plan with changed decisions. |
| Cannot save or publish | Check editing permission, save the draft, and follow blocking checklist issues. Read-only users can inspect and sandbox. |
