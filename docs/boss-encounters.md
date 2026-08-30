# Boss encounters (Stage 1)

Bosses periodically wander into Waifu Valley and scout the area. Players have
**30 minutes** to commit their active buddy. When the window closes, every
committed buddy attacks, damage and rewards are calculated, the encounter
message is closed out in place, and a separate public **Boss Results** message
is posted beneath it.

Stage 1 **records and displays** damage. Bosses have no HP, cannot be failed
against, and cannot hurt anyone.

## The channel is a permanent history

A boss channel reads chronologically, forever:

```text
[Boss Encounter — Oh Pwincess]     ← edited in place: live → ended
[Boss Results — Oh Pwincess]       ← posted when the window closes
[Boss Encounter — Sir Goonsworth]
[Boss Results — Sir Goonsworth]
```

Two rules produce that shape, and both are load-bearing:

1. **An encounter owns exactly two messages.** The announcement is *edited* —
   participant count and countdown while the window is open, then once more
   into its terminal form when it ends — and it is never deleted, never
   replaced, and never repurposed into the results. The results are always a
   **second, separate** message.
2. **No public message is ever consumed by a player's interaction.** Pressing
   **Commit Buddy** opens a private preview; it does not touch the public
   message. The only public edit the commit path makes is refreshing the
   participant count, through the same renderer the scheduler uses.

A zero-participant encounter still gets a results message, saying that nobody
confronted the boss and that no rewards were distributed. Silence would be
indistinguishable from a bot that had crashed.

### The two message states

The **encounter message** while scouting shows boss artwork, name, affinity and
the affinity that beats it, scouting prose, the participation deadline, the
current participant count, the current rapid-response bracket, and the
**Commit Buddy** button.

The **encounter message** once it ends keeps the artwork and identity, swaps
the scouting prose for `repelledText` or `unchallengedText`, shows participant
count, combined damage and total attacks, and carries **no components at all** —
Commit Buddy is removed, not greyed out.

The **results message** carries the boss name, every participant's line
(trainer, committed Waifumon, individual damage, XP actually awarded, every
item received), the **First on the Scene** callout, the combined totals, and
every result control: pagination when there is more than one page, and
**My Result** always. Result controls are never attached to the encounter
message — pagination repaints the message its button lives on, and the
encounter message is history.

---

## For operators

### Turning it on for a server

```
/waifumon-admin boss set-channel #boss-arena
```

The channel must be a **guild text channel**, and the bot must hold
**View Channel**, **Send Messages**, **Embed Links**, **Attach Files** and
**Read Message History** in it. The command checks all of that before saving —
if something is missing it names it rather than saving a channel that will fail
half an hour later.

Until a channel is configured, **nothing is scheduled**. That is the entire
feature gate: a server with no boss channel simply never sees a boss.

The boss channel does not need to be on the play-channel allowlist. It is
exempted from that rule automatically.

### The rest of the admin surface

| Command | What it does |
| --- | --- |
| `/waifumon-admin boss status` | Current encounter, next appearance, shuffle-bag depth, and any warning |
| `/waifumon-admin boss clear-channel` | Turns bosses off for this server. A live encounter still resolves and pays out |
| `/waifumon-admin boss spawn [boss]` | Force-spawn for testing. **Does not consume the shuffle bag** |
| `/waifumon-admin boss end` | Ends the active encounter now. Anyone who committed is still paid in full |
| `/waifumon-admin boss repair` | Reposts a deleted announcement onto the **same** encounter — never creates a second one |
| `/waifumon-admin boss pause` / `resume` | Stops or restarts scheduling. A live encounter still resolves while paused |

### When something breaks

If the configured channel is deleted, or a permission is revoked, scheduling
**suspends** for that guild: nothing new is drawn, and `boss status` shows a
warning naming the exact problem and the command that fixes it. A live
encounter still resolves and still pays out — rewards never depend on Discord
succeeding.

The suspension lifts automatically on the first pass after the channel works
again. `resume` also clears it, for the case where you fixed a permission and
do not want to wait.

### What a restart cannot do

A restart re-derives everything from the database, so it can never:

- reroll the active boss, or its end time;
- post a second announcement;
- lose committed participants;
- reroll the next scheduled appearance;
- create a second encounter;
- pay anyone twice;
- post a second results message;
- reactivate the buttons on an encounter that has already resolved;
- touch an older encounter's messages.

What a restart *will* do is finish work Discord never received: if the process
died between resolving and publishing, the next tick repairs the completion
edit and posts the missing results message. Each half is stamped in the
database only once Discord has accepted it, so "outstanding" is a query rather
than a memory — and a results message that was sent just before the crash is
**found and adopted** rather than duplicated, by matching the
`Boss Encounter #<id>` marker in its footer.

Pagination keeps working across restarts: the page number lives in the button's
custom id and the page size is frozen onto the encounter row at publication.

The same properties hold for **two bot processes running at once**: the "one
active encounter per guild" rule is a partial unique index, and resolution is
claimed by a single conditional `UPDATE`.

---

## For content authors

### Adding a boss

Bosses live in `content/bosses.json` — one array, one object per boss:

```json
{
  "id": "oh_pwincess",
  "name": "Oh Pwincess",
  "affinity": "dominant",
  "region": "waifu-valley",
  "enabled": true,
  "artwork": "bosses/oh_pwincess_boss.webp",
  "rewardTable": "standard-scouting-v1",
  "scoutingText": "Shown while the window is open.",
  "repelledText": "Shown when at least one trainer committed.",
  "unchallengedText": "Shown when nobody did.",
  "description": "One line of flavour."
}
```

| Field | Rules |
| --- | --- |
| `id` | lowercase snake_case, unique, **never reused** — it is snapshotted onto every encounter row |
| `affinity` | one of `dominant`, `submissive`, `caregiver`, `primal`, `switch` |
| `region` | must be a canonical region (`waifu-valley` today) |
| `artwork` | relative path under `assets/`. Optional. `..`, absolute paths and backslashes are rejected |
| `rewardTable` | must name an `id` in `content/bossRewards.json` |
| the four text fields | all required and all non-empty |

Missing artwork is **not** an error. The file is dropped with a warning and the
encounter renders as a text/embed announcement — everything else about it works
identically. That is deliberate: a missing file must never take a scouting
window away, least of all after players have already committed.

### Balance rules the validator enforces

- boss ids are unique;
- every `rewardTable` reference resolves to a table in `content/bossRewards.json`;
- every reward item exists (a dangling reward would fail at payout time, half an
  hour after anyone could have fixed it);
- reward table ids are unique, group ids are unique within a table, and no group
  lists the same item-and-quantity drop twice;
- at least one **drawable** boss exists for every enabled region — meaning a boss
  that is itself enabled *and* whose reward table is enabled.

All of these are fatal at startup and in the admin panel's **Validate** action.

A reward item that is `enabled: false` in `items.json` is **not** fatal. That
flag is retirement, not Shop availability, and a retired item can still be
granted; the panel raises a warning instead. See
[Editing Boss Loot](#editing-boss-loot).

### Tuning

Everything numeric lives in `content/tables.json` under `bossEncounters`:

```jsonc
{
  "scoutingMinutes": 30,
  "downtimeMinutesMin": 10,
  "downtimeMinutesMax": 35,
  "attacksPerParticipation": 10,
  "performanceMinPercent": 85,      // ×0.85
  "performanceMaxPercent": 115,     // ×1.15
  "affinityAdvantageBonus": 0.10,
  "responseBrackets": [
    { "withinMinutes": 10, "bonus": 0.05 },
    { "withinMinutes": 20, "bonus": 0.02 }
  ]
}
```

Payout tables are **not** here — they live in `content/bossRewards.json`. See
[Editing Boss Loot](#editing-boss-loot).

Retuning these takes effect on the next **restart** — the same rule every other
`tables.json` block follows, because service closures capture their config at
construction. Adding or editing a *boss* takes effect on **Save + Reload**,
because boss content is read through a live getter.

### The encounter cycle

| Phase | Length |
| --- | --- |
| Scouting / participation window | 30 minutes |
| Downtime after resolution | random 10–35 minutes |
| **Full cycle** | **≈40–65 minutes** |

Roughly **22–36 encounters a day**. The scheduler ticks once every 60 seconds
and re-derives what is due from the database; it holds no timers, which is what
makes restart recovery and multi-process operation the same code path.

The next appearance is drawn and persisted **when the previous encounter
resolves**, so a restart cannot reroll it into an earlier or later slot.

Because participation is free and capped at one buddy per player per encounter,
the daily ceiling for a player who catches every single window is bounded by
attention rather than by resources. See
[Reward economy at this cadence](#reward-economy-at-this-cadence).

---

## The rules, precisely

### Affinity advantage

Boss affinity → the buddy affinity that beats it:

| Boss | Beaten by |
| --- | --- |
| Dominant | Switch |
| Submissive | Dominant |
| Caregiver | Submissive |
| Primal | Caregiver |
| Switch | Primal |

The superior affinity gets **+10% damage**. Everything else — inferior and
neutral alike — gets exactly nothing. There are no penalties in Stage 1.

> This is **not** the capture wheel. `modules/capture/affinityMath.ts` treats
> `switch` as neutral on both sides; here it is a full participant. The two
> tables are deliberately separate modules so neither can be changed by editing
> the other.

### Rapid response

Measured from the announcement to the confirmed commitment:

| Committed within | Bonus |
| --- | --- |
| first 10 minutes | +5% |
| 10 to under 20 minutes | +2% |
| final 10 minutes | none |

Boundaries are **strict** and measured in milliseconds, not whole minutes:

| Elapsed | Bonus |
| --- | --- |
| 9:59.999 | +5% |
| 10:00.000 | +2% |
| 19:59.999 | +2% |
| 20:00.000 | none |
| 29:59.999 | none |
| at or past the deadline | *commitment refused* |

The bonus is frozen onto the participation row at commitment, so a later retune
cannot alter a battle someone already joined.

The first arrival gets a cosmetic **First on the Scene** callout in the result
and no mechanical reward.

### Damage

```
battleDamage = round(
  currentSp × attacksPerParticipation × performanceModifier
            × (1 + affinityBonus + responseBonus)
)
```

- `currentSp` is the buddy's **Current** SP, snapshotted at commitment — never
  Base SP, and never re-read at resolution.
- `performanceModifier` is an integer 85–115 interpreted as hundredths, so both
  endpoints are exactly reachable.
- Percentage bonuses are **additive with one another** before application:
  +10% and +5% is ×1.15, not ×1.10 × ×1.05.

Worked example — 200 SP, both bonuses:

```
min: 200 × 10 × 0.85 × 1.15 = 1,955
max: 200 × 10 × 1.15 × 1.15 = 2,645
```

The ten attacks are a **presentation and scaling convention**. Nothing
simulates ten of anything: there is one modifier, one multiply, one result. No
hit rolls, no criticals, no boss defence.

The performance modifier is **derived**, not rolled — from
`md5(encounterId:participationId:purpose:salt)`. That is what makes a crashed
resolution safe to retry: the second attempt computes the same numbers as the
first, without depending on any write having landed.

### Rewards

Generated **only at resolution**, never at commitment, from the table named by
the boss's `rewardTable`. `standard-scouting-v1` ships as:

- **15 buddy XP**, guaranteed;
- the `standard-item` group — one guaranteed weighted pick:

  | Drop | Weight | Share |
  | --- | ---: | ---: |
  | 2× Basic Charm | 4,500 | 45% |
  | 1× Silk Charm | 2,500 | 25% |
  | 3× Basic Charm | 2,000 | 20% |
  | 1× Velvet Charm | 900 | 9% |
  | 1× Energy Drink | 100 | 1% |

- the `rare-bonus` group — an independent **0.25%** (25 basis points) chance at
  1× Mythic Contract, which never displaces the standard drop. A lucky
  participant gets both.

Groups are independent by construction, which is exactly why the rare bonus is
its own group rather than another weighted row: retuning the standard pool
cannot move the rare group's odds, and the rare group cannot eat a standard
drop.

A **max-level** buddy participates, deals damage and receives items, but gains
no XP. The discarded XP is not redirected anywhere; redirecting it would make
capped buddies the optimal pick, which is the opposite of what a level cap is
for.

XP goes to **the exact copy that was committed**, even if the player has since
changed buddies. If that copy was released in the meantime, the XP is recorded
as zero and the items are still delivered.

Every draw is **derived, not rolled** — from
`md5(encounterId:participationId:purpose:salt)` — so a retried resolution
reproduces the same rewards. Combined with the `reward_status = 'pending'`
guard on the payout `UPDATE`, a crash mid-payout can only ever be finished, not
repeated.

---

## Editing Boss Loot

### Where it lives

```text
content/bossRewards.json
```

**Boss loot is completely independent of the Shop.** They are different
acquisition sources for the same items, and neither has a vote in the other:

| File / field | Governs |
| --- | --- |
| `content/items.json` | What an item **is** — name, category, behaviour. `enabled: false` means **retired**: withdrawn from every source at once |
| `items.json` → `purchasable`, `buyPrice`, `priceCurrency` | Whether the Shop sells it, and for how much |
| `content/bossRewards.json` | Whether a boss **drops** it, how many, and how often |
| (future) scavenge config | Separate again, for the same reason |

Concretely:

- Un-listing an item from the Shop (`purchasable: false`) does **not** stop it
  dropping from a boss.
- Disabling a boss reward entry does **not** remove the item from the Shop.
- Nothing in the Shop's availability or pricing is read on the boss payout
  path — not `purchasable`, not `buyPrice`, not the Shop's own weighting.
- `items.enabled: false` *does* affect both, because it means the item is
  retired rather than merely unlisted. A boss table that names a retired item
  still pays it out, and the admin panel warns about it.

### Schema

```jsonc
[
  {
    "id": "standard-scouting-v1",   // what bosses.json's rewardTable names
    "enabled": true,                // false ⇒ bosses using it do not spawn
    "version": "standard-scouting-v1", // optional; defaults to id
    "buddyXp": 15,                  // guaranteed, not a roll
    "groups": [
      {
        "id": "standard-item",      // unique within the table
        "enabled": true,            // false ⇒ group skipped entirely
        "rolls": 1,                 // independent draws per participation
        "chanceBasisPoints": 10000, // 10000 = always, 25 = 0.25%
        "entries": [
          { "itemId": "basic_charm", "enabled": true, "weight": 4500, "quantity": 2 }
        ]
      }
    ]
  }
]
```

| Field | Rules |
| --- | --- |
| `id` (table) | unique across the file; referenced by `bosses.json` → `rewardTable` |
| `enabled` (table) | `false` makes every boss pointing at it **undrawable**, with a logged, actionable error |
| `version` | optional. Stamped onto every encounter at spawn; defaults to `id`. Bump it when you retune and want old and new results distinguishable in an audit |
| `buddyXp` | non-negative integer. `0` is legal — items still drop |
| `id` (group) | lowercase snake/kebab, unique within its table. **Part of the deterministic draw key** — renaming a group re-rolls any encounter that has not yet resolved |
| `rolls` | positive integer. `2` performs two independent draws against this group |
| `chanceBasisPoints` | `0`–`10000`. Probability the group produces anything **per roll** |
| `itemId` | must be a slug in `items.json`. Fatal if it is not |
| `weight` | positive integer, relative **within its group** |
| `quantity` | positive integer stack size |

### Enabling and disabling

Every level has its own `enabled` switch, and each one is narrower than the
last:

- **An entry** — `entries[].enabled: false` excludes that drop from future boss
  rolls **and nothing else**. It stays in the Shop, stays in the file, and
  stays payable on any reward already granted.
- **A group** — `groups[].enabled: false` skips the group entirely, every roll
  of it. The other groups are unaffected.
- **A table** — `enabled: false` stops every boss that references it from
  **spawning at all**, rather than letting it appear and pay nothing. The skip
  is logged at error level naming the boss, the table and the fix. If it leaves
  an enabled region with no drawable boss, startup and **Validate** both fail
  with a message that says which table to re-enable.

### How weights and quantities work

Weights are **relative within a group** and normalized over whatever is
*enabled*, not over what is written. Disabling an entry redistributes its share
across the rest in proportion — there is no hole in the distribution and no
second number to keep in sync.

With all five standard entries enabled, `4500 / 10000` = 45% for 2× Basic
Charm. Disable the 4,500 entry and the remaining total becomes 5,500, so 1×
Silk Charm rises from 25% to `2500 / 5500` ≈ 45.5% on its own — nothing else
needs editing.

`quantity` is the stack size granted when that entry is picked. The same item
may appear more than once in a group at different quantities — "2× Basic Charm"
and "3× Basic Charm" are two legitimate drops — but the same item at the *same*
quantity twice is rejected, because it silently doubles that drop's weight.
Stacks of the same item won from different groups are merged into one
inventory write.

### How independent bonus groups work

`chanceBasisPoints` gates a group; weights choose within it. A group with
`chanceBasisPoints: 25` and one entry fires 0.25% of the time and grants that
entry when it does. Because it is a *separate group*, it composes with the
standard group instead of competing with it: a participant who wins the rare
bonus receives it **in addition to** their standard item, never instead of it.

`rolls` multiplies the gate. `rolls: 2, chanceBasisPoints: 5000` is two
independent coin flips, so a participation can win from that group twice, once,
or not at all.

To add a second bonus tier, add a third group — do not add a rare item as a
low-weight row in the standard group, which would make it displace ordinary
drops and couple its odds to every future retune of that pool.

### Does a restart apply the change?

**No — Save + Reload is enough.** Edit `content/bossRewards.json` on disk, then
press **Reload Content** in the admin panel (or restart, which does the same
thing). The panel has no boss-loot *editor*, but its reload re-reads every
content file and republishes `ctx.content`, and the reward table is resolved
through that live getter at payout time — the same rule `bosses.json` follows.

That puts boss loot on the *content* side of the repository's split rather than
the *tuning* side: `tables.json` values are captured by service closures at
construction and genuinely do need a restart, which is one more reason payouts
do not live there.

A reload is validated before it lands: an edit that breaks a rule in the table
below is rejected and the previous content stays live.

What an edit can *never* do is change an encounter that has already been paid.
Granted rewards are written onto `boss_participations.reward_items` inside the
payout transaction, and the encounter row records the table id and version it
spawned under. Editing the table changes future rolls only; a snapshot already
taken stays payable and stays exactly as it was.

### When it is wrong

| Problem | Where you hear about it |
| --- | --- |
| `itemId` names an item that does not exist | **Fatal** at startup and in **Validate** |
| A boss names a table that does not exist | **Fatal**, listing the known table ids |
| Duplicate table id, duplicate group id, duplicate item-and-quantity drop | **Fatal**, from the schema |
| Every enabled boss in a region points at a disabled table | **Fatal**, naming the table to re-enable |
| A single table disabled while others remain | Error log at spawn time, naming the boss and the fix |
| An enabled group whose every entry is disabled | Panel warning; error log at payout time, once per participation |
| `chanceBasisPoints: 0` on an enabled group | Error log at payout time — the group can never drop |
| An entry naming a **retired** (`enabled: false`) item | Panel warning; it is still granted |

### A complete example

Two tables: the shipped one, plus a richer table for a single boss that drops
more and has two independent bonus tiers.

```json
[
  {
    "id": "standard-scouting-v1",
    "enabled": true,
    "buddyXp": 15,
    "groups": [
      {
        "id": "standard-item",
        "enabled": true,
        "rolls": 1,
        "chanceBasisPoints": 10000,
        "entries": [
          { "itemId": "basic_charm", "enabled": true, "weight": 4500, "quantity": 2 },
          { "itemId": "silk_charm", "enabled": true, "weight": 2500, "quantity": 1 },
          { "itemId": "basic_charm", "enabled": true, "weight": 2000, "quantity": 3 },
          { "itemId": "velvet_charm", "enabled": true, "weight": 900, "quantity": 1 },
          { "itemId": "energy_drink", "enabled": true, "weight": 100, "quantity": 1 }
        ]
      },
      {
        "id": "rare-bonus",
        "enabled": true,
        "rolls": 1,
        "chanceBasisPoints": 25,
        "entries": [
          { "itemId": "mythic_contract", "enabled": true, "weight": 1, "quantity": 1 }
        ]
      }
    ]
  },
  {
    "id": "elite-scouting-v1",
    "enabled": true,
    "version": "elite-scouting-v1",
    "buddyXp": 30,
    "groups": [
      {
        "id": "standard-item",
        "enabled": true,
        "rolls": 2,
        "chanceBasisPoints": 10000,
        "entries": [
          { "itemId": "silk_charm", "enabled": true, "weight": 6000, "quantity": 2 },
          { "itemId": "velvet_charm", "enabled": true, "weight": 3000, "quantity": 1 },
          { "itemId": "prismatic_charm", "enabled": false, "weight": 1000, "quantity": 1 }
        ]
      },
      {
        "id": "uncommon-bonus",
        "enabled": true,
        "rolls": 1,
        "chanceBasisPoints": 1500,
        "entries": [
          { "itemId": "energy_drink", "enabled": true, "weight": 1, "quantity": 2 }
        ]
      },
      {
        "id": "rare-bonus",
        "enabled": true,
        "rolls": 1,
        "chanceBasisPoints": 100,
        "entries": [
          { "itemId": "mythic_contract", "enabled": true, "weight": 1, "quantity": 1 }
        ]
      }
    ]
  }
]
```

`elite-scouting-v1` grants 30 XP, **two** standard picks, a 15% chance of 2×
Energy Drink, and a 1% chance of a Mythic Contract — up to four stacks in one
payout. Its Prismatic Charm entry is disabled, so its 1,000 weight is
redistributed and the remaining two entries normalize to 6000/9000 ≈ 67% and
3000/9000 ≈ 33%. Prismatic Charm remains available in the Shop throughout,
because a boss entry has nothing to say about Shop listing.

Point a boss at it by setting `"rewardTable": "elite-scouting-v1"` in
`content/bosses.json`.

---

## Reward economy at this cadence

The 40–65 minute cycle means **roughly 22–36 encounters a day**, against the
2–5 hour downtime it replaced (previously ~7–11 a day). Participation is free,
so a maximally attentive player's ceiling moved by about **3×**.

Per participation, `standard-scouting-v1` grants 15 buddy XP, ~2.3 charms of
mixed tier, and a 0.25% Mythic Contract check. At 36 encounters:

| | Per day, ceiling |
| --- | ---: |
| Buddy XP | ~540 |
| Charms | ~83 |
| Energy Drinks | ~0.4 |
| Mythic Contract | ~9% chance |

Two things are worth watching in live data before assuming this is fine:

1. **Charm inflation.** Charms are also the Shop's WaifuBux sink and the daily
   package's staple. A player who catches most windows can stop buying charms
   entirely, which weakens WaifuBux as a currency. The `inventory.captureCapacity`
   soft cap (100 capture items) is the existing backstop, and it will now be hit
   far more often — watch how many players sit against it.
2. **Mythic Contract frequency.** At ~9% per attentive player per day, a busy
   server sees them regularly rather than as an event. If they should stay
   remarkable, lower `rare-bonus`'s `chanceBasisPoints` rather than raising the
   downtime — the cadence is the feature, the drop rate is the dial.

Both are one-line edits in `content/bossRewards.json` and neither touches the
Shop. Realistically most players catch a fraction of the windows, so these are
ceilings rather than expectations; they are the numbers to check telemetry
against, not a reason to pre-emptively retune.

---

## Persistence

| Table | Holds |
| --- | --- |
| `guild_boss_state` | shuffle bag, next appearance, pause and suspension flags |
| `boss_encounters` | one row per appearance, with the boss content snapshotted onto it |
| `boss_participations` | one row per committed buddy — the immutable battle record |

`boss_participations.waifu_id` carries **no foreign key**, matching
`players.buddy_waifu_id`: releasing an owned copy must not take a historical
battle result with it. Trainer display names are snapshotted too, so a result
renders correctly years later without resolving a member who may have left.

### The two messages, and their delivery state

`boss_encounters` tracks each public message and each delivery step separately,
which is what makes recovery a query rather than a guess:

| Column | Meaning |
| --- | --- |
| `channel_id`, `message_id` | The **encounter announcement**. Non-null `message_id` is the "already announced" flag |
| `results_message_id` | The **results message**. Independent, so repairing one cannot lose the other |
| `completion_edited_at` | Null ⇒ the announcement still needs its terminal edit |
| `results_published_at` | Null ⇒ the results message still needs posting |
| `results_page_size` | The page size the results were published with, so pagination pages the same way after a retune |

Both flags are timestamps rather than booleans — the same shape `resolved_at`
uses — so an operator debugging a stuck encounter gets a *when*, not only a
*whether*.

Discord's send and our `UPDATE` cannot share a transaction, so every results
embed carries a `Boss Encounter #<id>` footer marker. If the process dies
between sending and persisting, the next tick scans the channel tail for that
marker and **adopts** the orphaned message instead of posting a second one.

---

## Future: boss HP

Stage 2 can add HP without touching a single stored Stage 1 value.

`boss_participations.total_damage` is already the per-participant contribution
and `boss_encounters.total_damage` is already the encounter total. An HP pool is
a new column on `boss_encounters` plus one comparison at resolution:
`totalDamage >= bossHp` decides victory instead of `participantCount > 0`.

Nothing about the damage numbers themselves changes, which is why
`BOSS_DAMAGE_FORMULA_VERSION` does **not** move: consuming a number differently
is not re-modelling how it was produced. Historical encounters keep
`resolution_reason = 'repelled'` and read exactly as they always did — they
simply predate a pool for their damage to have been measured against.

---

## Explicitly out of scope in Stage 1

Boss HP · failure on insufficient damage · player damage taken · injury or
energy costs · teams · multiple attacks per player · extra attempts from items ·
equipment, affection or race modifiers · critical hits · individual hit
simulation · boss resistances or abilities · contribution rankings or bonus
tiers · PvP · cross-server bosses · travel · scavenge mode.

---

## Related documentation

- [`docs/content-authoring.md`](content-authoring.md) — appearances and card metadata
- [`docs/admin-web.md`](admin-web.md) — the content admin panel
