# Staging Test Controls

Portal Admin → **Staging Test Controls** (`/admin/test-controls`) lets owners
and granted admins put a **test account** into a known state without grinding:
set Trainer Level, add/remove WaifuBux, set Energy, grant/revoke the
Transporter Beacon, grant standard travel access, apply a one-click
"Prepare Player for Current Content" boost, and reset the Assteroid Belt unlock.

It is test tooling. It never exists on production.

---

## Enabling it (staging only)

```sh
DEPLOYMENT_ENV=staging
ENABLE_TEST_ADMIN_CONTROLS=true
```

| Variable | Default | Notes |
| --- | --- | --- |
| `DEPLOYMENT_ENV` | *(unset → `production`)* | `production`, `staging` or `development`. Unset, blank or unrecognised **is production**. `NODE_ENV` and `COMPOSE_PROJECT_NAME` are never used as the deployment identity. |
| `ENABLE_TEST_ADMIN_CONTROLS` | `false` | Startup **fails** if this is `true` while `DEPLOYMENT_ENV` resolves to `production`. |

Production needs no change: with `DEPLOYMENT_ENV` unset it is production, and
the controls stay off.

## How production is protected

Each lock works without the others:

1. **Startup.** `loadConfig` refuses to boot with the flag on in production.
2. **Registration.** The service is built only when the flag is on *and*
   `DEPLOYMENT_ENV` is `staging`/`development`. No service means the routes
   are never registered, so every `/api/v1/admin/test-controls/…` path 404s.
3. **Permission.** `players.testcontrols` is withheld from everyone, owners
   and role grants alike, unless the same rule passes. A grant row that names
   it is inert on production, and the Role Access picker does not offer it.
4. **Per request.** The service re-checks the flag and environment on every
   call before any write (and refuses to be constructed for production).

Hiding the nav entry is a courtesy on top of these. The API does not rely on it.

## Who can use it

- The guild **owner**, always (when enabled).
- **Admins** holding a Discord role that the owner granted `players.testcontrols`
  in Admin → Role Access.
- Never the shared Platform API bearer token, even with
  `PLATFORM_API_ADMIN_BEARER=true`. Every action is audited with the acting
  admin's Discord id, and a bearer request has no one to name.

Targets must belong to the guild the session has selected. Any other id gets a 404.

## What each action does

| Action | Effect |
| --- | --- |
| Set Level | Writes `players.level` and sets `players.xp` to the start of that level on the real curve, so the two agree. Bounded by `progression.maxLevel`. If max Energy drops, Energy is trimmed to the new max. |
| Add / Remove WaifuBux | Uses the currency service. Removal is a conditional spend, so the balance can never go negative. Max 1,000,000 per click. |
| Set Energy | 0 to the player's current max. There is no over-cap Energy. |
| Grant Beacon | One `transporter_beacon` via the inventory service (`max_owned: 1`). Already owned → informational no-op. |
| Revoke Beacon | The existing `travel.revokeRoute('assteroid-belt')`: takes the beacon, removes any legacy route row, and sends a player standing in the Belt to Waifu Valley. |
| Grant All Standard Travel | Every pass in the travel catalog and every **pass/route** destination. Never the Beacon or any key-item destination. Idempotent. |
| Prepare Player for Current Content | Level 40, +10,000 WaifuBux, Energy to max, standard travel. No Beacon, no Belt components, no expeditions, Waifumon or achievements. |
| Reset Today's Delve Runs | Deletes the player's `dungeon_daily_usage` row for the current game day, restoring the full daily allowance. Runs, rewards, an active run and other days are untouched. No-op when nothing was started. |
| Reset Assteroid Belt | Returns the player to Waifu Valley if in the Belt. Removes the Beacon, the recipe's components (from `tables.keyItemRecipes`), any legacy `assteroid-belt` route row, and cooldowns on the world encounters that award a component. Nothing else. |

## Audit

Every action writes one `player_progression_events` row with
`event_type = 'admin_player_action'`. This is the same mechanism
`/waifumon-admin player` uses. `metadata` holds `action` (`test_…`),
`source: 'portal_test_controls'`, `adminDiscordId`, `targetDiscordId`,
`guildId`, `deploymentEnv`, `before`/`after`, and per-step detail for the
Staging Boost. `xp_delta` is the real XP movement of a level set, so the ledger
still reconciles. The row is written in the same transaction as the change.
A refused action writes nothing.

```sql
select created_at, metadata->>'action', metadata->>'adminDiscordId', metadata->'before', metadata->'after'
  from player_progression_events
 where player_id = $1 and event_type = 'admin_player_action'
 order by created_at desc;
```
