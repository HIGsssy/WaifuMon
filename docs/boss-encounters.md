# Boss encounters (Stage 1)

Bosses periodically wander into Waifu Valley and scout the area. Players have
**60 minutes** to commit their active buddy. When the window closes, every
committed buddy attacks, damage and rewards are calculated, and a public result
is posted.

Stage 1 **records and displays** damage. Bosses have no HP, cannot be failed
against, and cannot hurt anyone.

---

## For operators

### Turning it on for a server

```
/waifumon-admin boss set-channel #boss-arena
```

The channel must be an **NSFW-marked text channel**, and the bot must hold
**View Channel**, **Send Messages**, **Embed Links**, **Attach Files** and
**Read Message History** in it. The command checks all of that before saving —
if something is missing it names it rather than saving a channel that will fail
an hour later.

Until a channel is configured, **nothing is scheduled**. That is the entire
feature gate: a server with no boss channel simply never sees a boss.

The boss channel does not need to be on the play-channel allowlist. It is
exempted from that rule automatically (but not from the NSFW rule).

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
- pay anyone twice.

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
| `rewardTable` | must name a key in `tables.json` → `bossEncounters.rewardTables` |
| the four text fields | all required and all non-empty |

Missing artwork is **not** an error. The file is dropped with a warning and the
encounter renders as a text/embed announcement — everything else about it works
identically. That is deliberate: a missing file must never take a scouting
window away, least of all after players have already committed.

### Balance rules the validator enforces

- boss ids are unique;
- every `rewardTable` reference resolves;
- every reward item exists **and is enabled** (a dangling reward would fail at
  payout time, an hour after anyone could have fixed it);
- at least one enabled boss exists for every enabled region.

All of these are fatal at startup and in the admin panel's **Validate** action.

### Tuning

Everything numeric lives in `content/tables.json` under `bossEncounters`:

```jsonc
{
  "scoutingMinutes": 60,
  "downtimeMinutesMin": 120,        // 2 hours
  "downtimeMinutesMax": 300,        // 5 hours
  "attacksPerParticipation": 10,
  "performanceMinPercent": 85,      // ×0.85
  "performanceMaxPercent": 115,     // ×1.15
  "affinityAdvantageBonus": 0.10,
  "responseBrackets": [
    { "withinMinutes": 15, "bonus": 0.05 },
    { "withinMinutes": 30, "bonus": 0.02 }
  ]
}
```

Retuning these takes effect on the next **restart** — the same rule every other
`tables.json` block follows, because service closures capture their config at
construction. Adding or editing a *boss* takes effect on **Save + Reload**,
because boss content is read through a live getter.

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
| under 15 minutes | +5% |
| 15 to under 30 minutes | +2% |
| 30 minutes onward | none |

Boundaries are **strict**: a commitment at exactly 15:00.000 earns +2%, not
+5%. The bonus is frozen onto the participation row at commitment, so a later
retune cannot alter a battle someone already joined.

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

Generated **only at resolution**, never at commitment. `standard-scouting-v1`
ships as:

- **15 buddy XP**, guaranteed;
- **one weighted minor-item roll** (weights out of 10,000):

  | Drop | Weight | Share |
  | --- | ---: | ---: |
  | 2× Basic Charm | 4,500 | 45% |
  | 1× Silk Charm | 2,500 | 25% |
  | 3× Basic Charm | 2,000 | 20% |
  | 1× Velvet Charm | 900 | 9% |
  | 1× Energy Drink | 100 | 1% |

- a **separate 0.25%** chance at a Mythic Contract, which never displaces the
  minor drop — a lucky participant gets both.

A **max-level** buddy participates, deals damage and receives items, but gains
no XP. The discarded XP is not redirected anywhere; redirecting it would make
capped buddies the optimal pick, which is the opposite of what a level cap is
for.

XP goes to **the exact copy that was committed**, even if the player has since
changed buddies. If that copy was released in the meantime, the XP is recorded
as zero and the items are still delivered.

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
