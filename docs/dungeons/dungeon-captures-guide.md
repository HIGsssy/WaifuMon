# Dungeon WaifuMon encounters and rescues

Use the Dungeon Editor to offer WaifuMon during a run, either from a weighted
pool or as a specific character. A **Wild Encounter** always uses capture
charms. A **Rescue** can use charms or grant an authorized character directly.
These activities share the player's real capture inventory with hunting.

This guide describes the implemented Phase 4 behavior. For narrative choices
and item checks, see [Dungeon Events](dungeon-events-guide.md); for treasure,
see [Dungeon Rewards](dungeon-rewards-guide.md).

## Create a WaifuMon pool

1. Open your dungeon and its Dungeon settings. In **WaifuMon Pools**, choose
   **+ New WaifuMon pool** and enter a **Pool name**.
2. Add species using **+ Add species**. Search by name or slug, or filter by
   rarity, race, affinity and availability. The picker shows whether a species
   is enabled, exclusive, permitted here, and authorized for direct rescue.
3. Give each entry an integer weight from 1 to 1,000,000. Weights are relative:
   weights 4 and 1 mean 80% and 20% when both entries are eligible.
4. Use **+ Add Nothing** if the encounter should sometimes find nobody.
   Give it a weight and optional narrative, such as “Only rust and silence.”
5. Save the dungeon draft. A pool is part of this dungeon; regional hunting
   pools are separate and are not changed by this editor.

You can rename and duplicate pools. Activities keep their pool reference when
you rename one. A pool's usage list identifies the activities using it; remove
those references before deleting it. Each pool can have up to 50 entries, with
up to 30 pools per dungeon. A pool needs at least one species entry to publish.

### Read probabilities and conditions

**Probability insight** shows **With every entry in the draw** and **In this
simulated run**. These numbers come from the server's gameplay rules. They are
selection probabilities, not the chance of successfully capturing a selection.

For each entry, **Entry N is in the draw** controls whether it enters the draw. Use run
flags, completed rooms, or combinations of conditions. The scenario controls
let you assume flags, completed rooms, encountered species and acquisition
counts without changing a real run.

**At most once per run, after this species has been presented anywhere in the
run** is on by default for new species entries. It excludes that
species after she has been presented anywhere in this run, including a named
encounter. Capturing her is not required. It does not mean “once per player.”
An entry with this option off may appear again at another activity.

Nothing's probability is its weight divided by the total eligible weight.
For example, species weights 40 and 10 plus Nothing weight 50 give Nothing a
50% chance. Conditions and once-per-run exclusions change that denominator.
If no entries qualify, the result is Nothing with 100% probability.

A disabled, missing, restricted or acquisition-limited species keeps her draw
weight. Selecting her produces **Unavailable**; her share never moves to the
other species. The insight panel reports unavailable probability separately.
Changing a flag, resuming a run or retrying an interaction does not reroll an
activity that already selected someone or Nothing.

## Add a Wild Encounter

Add **Wild Encounter** to a room's activities. Set **Encounter source** to:

- **Specific WaifuMon**: use **Choose WaifuMon** to select one species.
- **WaifuMon pool**: select a pool, then use **Edit selected pool** to inspect
  its entries and probabilities.

Write the **Introductory narrative** and configure **Capture rules**:

- **Capture attempt limit**: one to three; the default is three.
- **Permitted capture charms**: **All globally eligible charms**, or
  **Authored subset** followed by the permitted items.
- **Allow guaranteed capture items**: on by default. Turn it off if this
  encounter should require an ordinary capture roll. Remove guaranteed charms
  from an explicit subset when you disallow them.

The player sees only owned, enabled, rarity-eligible permitted charms and their
server-calculated capture chances. Choosing a charm spends nothing. Each
resolved attempt spends one charm, even on failure. An ordinary attempt also
uses an applicable Microdose charge; a guaranteed item does not. An item
restriction never overrides rarity eligibility or missing inventory.

A miss below the attempt limit leaves the same WaifuMon offered. The last miss
resolves **Escaped**. Success grants a copy, capture XP, new-collection credit
when applicable, and capture quest progress. Duplicate copies are allowed and
use the existing Keep / Convert choice. Capture odds use the run's pinned Buddy
and the normal capture rules; there is no authored dungeon difficulty modifier.

There is always a Leave option. Leaving ends this encounter for the run and
spends nothing. Do not make an encounter an optional activity.

## Add a Rescue

Add **Rescue**, set **Rescue mode**, and choose a species or pool as above.

**Capture rescue (uses a charm)** uses the same capture rules and inventory as
a Wild Encounter. Success uses the **Rescued** result. Failure can leave another
attempt, or end in **Escaped** when the limit is reached.

**Direct rescue (direct grant)** has no charm selection or capture roll. The
player chooses Rescue or Leave. Every possible species must centrally authorize
direct rescue for this exact dungeon key and have an explicit finite limit.
An unlimited capture authorization does not permit direct rescue. Direct rescue
awards the configured ownership XP, including an applicable new-dex bonus,
but gives no capture-attempt or capture-success quest credit. At most three
direct-rescue activities are allowed per dungeon.

Use **Only happens if** to gate the rescue behind an Event flag or a completed
room. An ungated direct rescue warns during validation. A false condition skips
the activity without selecting or granting a species.

## Exclusive species and limits

Central species policy is read-only in this editor. Ask the content maintainer
to authorize the dungeon's stable key before using a dungeon-exclusive or
region-exclusive species. Being in the same region does not authorize it.
Dungeon-exclusive species cannot appear through normal hunting or scripted
wild spawns. Importing a dungeon never imports or grants species authorization.

The picker labels the actual scope: **per player, in this dungeon, across
runs**. A finite value counts successful acquisitions from this dungeon,
including capture rescues and direct rescues. It does not count current
collection size or copies obtained elsewhere. Releasing or converting a copy
does not restore this allowance. Authorizing the same species with limit one
in two different dungeons currently permits one acquisition from each dungeon.

**Unlimited (explicit)** permits repeated captures across runs. **Unlimited
(no limit configured)** is the ordinary capture default. Neither is valid for
direct rescue. A global cap across every dungeon has not been implemented;
the design's ledger scope is per dungeon. Record that scope in production
acceptance so “per player” is not mistaken for an all-dungeon cap.

Policy and enabled state remain live even for published and already-offered
encounters. When a species becomes unavailable, the player can Continue through
the Unavailable result with no charm or ownership grant. If eligibility returns
before that Continue press, it is refused and the encounter remains offered.
Continue never becomes a capture or rescue automatically.

## Outcomes, flags and routes

Expand the appropriate result under **Encounter results** and set **Outcome
text** and any run flags. Declare those flags in Dungeon settings first.
You can add up to four flag writes per result. Player-scoped flag persistence
is not supported here.

Wild encounters have Captured, Escaped, Left, Nothing and Unavailable results.
Rescues use Rescued instead of Captured; direct rescues have no Escaped result.
A failed attempt with attempts remaining is not a terminal authored outcome.

In the activity's routing controls, set **After capture**, **After rescue**,
**After escape**, **After leaving her**, or **When she is unavailable** as
needed. Default routing continues to the next activity. Routes can skip forward
to another activity, complete the room, take a path, or end the run. Encounter
outcomes cannot route to retreat. Their result flags and grants apply once.

## Place characters and environmental sprites

**WaifuMon scene actor placement** controls the offered character's position
and scale; **Mirror horizontally** changes facing. The player's pinned Buddy
is placed automatically during encounters and fights. Enemy placement remains
on the Fight / Boss fight activity.

For scenery, use **Scene Sprites** in the room or activity and select a catalogue
sprite. Adjust placement, scale, mirroring and layer. Room placements accompany
its activities; activity placements apply at that activity. Use **Manage
Dungeon Scene Sprites** for the catalogue and uploaded artwork. The server
preview uses the same 1200×675 scene composition as gameplay. Missing character
sprites fall back to available standard artwork, then background/text.

Environmental Scene Sprite placements currently prevent package export/import,
including v4. An encounter character's normal species sprite alone does not.
If portability is necessary, export a separately saved copy without environmental
placements. The exporter refuses clearly; it never silently drops them.

## Preview, test, validate and publish

Use **Discord encounter preview** to inspect Offered, Capture/Rescue success,
Failed attempt, Escape, Leave, Nothing and Unavailable where applicable.
Choose the species to preview when the source is a pool. A guaranteed-only
configuration cannot preview an impossible ordinary failure. A one-attempt
failed-attempt preview explains its simulation exception.

Choose **Test encounter in dungeon sandbox** to play the authored sequence.
Adjust **Simulated capture rolls**, simulated charm quantities, acquisitions,
availability, run flags and completed rooms. Selection remains seed-based.
These controls replay a simulation; they never spend a real player's inventory
or create ownership. The simulated Buddy has neutral capture modifiers, so these
quotes are not a real player's Buddy quote. Success image previews use standard
artwork; the real owned-copy card requires actual gameplay.

Save the draft, resolve checklist errors, and use **Show me** to open the
affected pool/activity. Validate before publishing. Missing or disabled species,
unpermitted rescues, missing pools, invalid attempts and invalid explicitly named
charms block publication. An explicitly disabled charm cannot be hidden by a
second working charm. Drafts may retain unresolved references for repair.

Publish after reviewing warnings. New runs use that publication. Active runs
keep their original pools, weights, conditions and encounter rules after edits
or republishing. Current species policy and enabled state still apply. Species
dependency status distinguishes the current publication from older active runs;
older publications without recorded evidence report unknown until republished.

## Import and export v4

Export the draft or a published revision through the existing dungeon export
workflow. Species pools and encounter activities select package v4 automatically.
Other dungeons retain their established v1/v2/v3 format.

In import review, check required species, rarity/policy differences, capture
items, reward/Event items, and any existing enemy or loot-table conflicts.
The destination must have its own species and item content. A package carries
references and dependency evidence, not species, charm or access definitions.

Complete imports require compatible dependencies. Explicit acceptance of missing
dependencies creates a repair draft; it does not make that draft publishable.
Repair missing species, permitted charms or destination access, validate again,
then publish and enable. Imported dungeons start disabled and unpublished.
Review again if the catalogue changes while you are approving an import.

Replacement does not rewrite old revisions or active runs. Identical request
retries return the original receipt; a new import remains subject to the normal
conflict review. Environmental Scene Sprites remain unsupported in every package
version.

## Worked example: weighted Android patrol

Create **Scrapheap Androids** with the following entries. These species exist,
but check the destination picker for current access before adding them; obtain
central authorization where required. The example does not change shipped policy.

| Entry | Weight | Initial chance |
| --- | ---: | ---: |
| Konbini Android | 40 | 27.59% |
| Courier Android | 40 | 27.59% |
| Valley Enforcer Unit | 25 | 17.24% |
| Ice House Android | 10 | 6.90% |
| Nothing: “Only rust and silence.” | 30 | 20.69% |

Total weight is 145. Leave the once-per-run option on. Add a Wild Encounter using this pool
in two rooms; allow three attempts and globally eligible charms. If Konbini
Android is presented in the first room, her entry is excluded in the second;
the other eligible entries share total weight 105. Verify the changed odds with
**Assume encountered** before publishing.

For a conditional rare entry, add a permitted test Android with weight two and
a condition requiring `generator_on`. It has no chance while the flag is false;
with the flag true the total becomes 147 and its chance is 2/147 (1.36%).

## Worked example: repair-event rescue

Declare the run flag `android_repaired`. Create a Dungeon Event with a Repair
choice. Its successful outcome remembers that flag; its failure/refusal leaves
the flag unset. The Event can use the existing consumed-item requirement and
SP check if you want repair to cost an item and sometimes fail.

Place the Event before a Rescue. Choose **Capture rescue (uses a charm)**,
select a permitted Android, and require `android_repaired` under **Only happens
if**. Allow two attempts and choose an authored charm subset compatible with
that species. Set Rescued text to “Her eyes brighten. She takes your hand.”
Test Event success, failure, missing repair item, no capture charm, failed
capture, and leaving. Only a successful capture grants ownership. The repair
item follows the Event's existing consume/check rules, independently of capture.

For a direct-rescue version, use an isolated test species whose maintainer has
authorized direct rescue in this dungeon with limit one. Switch to **Direct
rescue (direct grant)**. No charm is required; a second run by that player must
reach Unavailable. Do not substitute an unauthorized shipped species.

## Worked example: boss-unlocked dungeon-exclusive companion

Have the maintainer provide a test-only dungeon-exclusive species, authorized
for this dungeon key with direct rescue enabled and limit one. Declare
`warden_defeated`. Add a **Boss fight**, then **Remember something** to set that
flag after victory. Route **After winning** to that activity; use the existing
defeat behavior for losing.

Connect the completed boss room to a cell containing a direct Rescue. Require
both `warden_defeated` and completion of the boss room. The dungeon's Boss fight
is the supported combat activity; there is no guild-boss defeat subscription
or external boss integration in this workflow.

After the rescue, offer Treasure and a route to the exit or an extraction point.
Test victory, refusal to rescue, an exhausted acquisition limit, and a second
player. Also test a capture-mode variant with an explicitly unlimited exclusive
species; unlimited permits repeated captures but never a direct grant.
