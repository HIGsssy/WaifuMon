# Peanut Gallery — WaifuMon Read-Only Integration (as built)

The integration consumer (CherryBot) sends WaifuMon the ID of a WaifuMon announcement message it saw. WaifuMon answers with what that announcement published plus guild-public live statistics. There is one endpoint, one read-only credential type and one guild. WaifuMon has no knowledge of which application holds a key.

## Status

| Layer | State |
| --- | --- |
| Code | Implemented on branch `PeanutGallery`. Not yet reviewed. |
| Automated tests | Pass locally against real PostgreSQL 16. See [Verification](#verification). |
| nginx rule | `nginx -t` passes, and a live nginx 1.27 container answers 404 for the integration paths. |
| Docker network override | Per-environment network and alias. Checked statically, including how default, staging and production values resolve. Compose is not available on the development machine, so `docker compose config` has not been run. **Not deployed.** |
| Staging | **Not deployed and not exercised.** Treat the endpoint as not operational until the [staging procedure](#staging-validation) passes. |
| Production | Not deployed. |

## Endpoint

```
GET  /api/v1/integrations/commentary/context?discordGuildId={snowflake}&messageId={snowflake}
HEAD (same URL, same rules)
Authorization: Integration <keyId>.<secret>
```

Internal base URL: `http://<alias>:3120/api/v1`, where the alias is per environment: `waifumon-api-staging` on staging and `waifumon-api-prod` on production (see [Network](#network)). The name resolves only for containers on that environment's integration network. The public Portal host answers 404 for anything under `/api/v1/integrations`.

| Query parameter | Rule |
| --- | --- |
| `discordGuildId` | Digits only. Must equal `PLATFORM_API_INTEGRATION_GUILD_ID`. Any other value returns `404 ANNOUNCEMENT_NOT_FOUND`. |
| `messageId` | Digits only. The Discord message ID of a WaifuMon announcement in that guild. |

No parameter names a player, so the endpoint cannot be used to look up or enumerate players.

## Authentication

- **Header:** `Authorization: Integration <keyId>.<secret>`. The value is split at the first dot. Do not use `Bearer`.
- **Storage:** WaifuMon stores only `sha256(secret)` as lowercase hex, per `keyId`. Comparison is constant-time. Unknown key IDs take the same time to refuse.
- **Allowlist (enforced in the API's auth hook, before routing reaches any handler):**
  - the method must be `GET` or `HEAD`;
  - the matched route must opt in with `config.integrationRoute`;
  - the path must start with `/api/v1/integrations/`.

  Anything else returns `403 INTEGRATION_FORBIDDEN`. That includes every player route, every admin route, `/metrics` and unknown paths. A test sweeps every route in the OpenAPI document.
- **The integration route accepts only integration keys.** The shared `PLATFORM_API_TOKEN` bearer and Portal session cookies get `403 INTEGRATION_REQUIRED`.
- **No fallback.** A request that says `Integration` is judged only as an integration request. A bad key returns 401 even if the same request also carries a valid Portal cookie.
- **Logging:** the header and the secret are never logged. Only `keyId` appears, and only after successful authentication.

### Generating, rotating and revoking a key

```sh
# Run on the host. The secret goes to CherryBot's secret store only.
secret=$(openssl rand -hex 32)
printf %s "$secret" | sha256sum | cut -d' ' -f1    # → <hash> for WaifuMon
echo "CherryBot credential: peanut-gallery-2026a.$secret"
```

WaifuMon `.env`:

```sh
PLATFORM_API_ENABLED=true                       # prerequisite
PLATFORM_API_INTEGRATION_KEYS=peanut-gallery-2026a:<hash>
PLATFORM_API_INTEGRATION_GUILD_ID=<the Peanut Gallery guild id>
```

- **Rotate:** add a second entry (`a:<hash1>,b:<hash2>`), then recreate the bot container. Switch CherryBot to the new key, remove the old entry, and recreate the container again.
- **Revoke:** remove the entry and recreate the container. Configuration is read at startup only, so revocation takes effect when the container is recreated: `docker compose up -d waifumon-bot`, **not** `restart`.
- **Startup validation:** the bot refuses to start if any of these hold. The error messages name a `keyId`, never a hash.
  - only one of the two variables is set;
  - `PLATFORM_API_ENABLED` is not `true`;
  - the guild ID is not a snowflake;
  - a `keyId` is malformed or repeated;
  - a hash is not 64 hex characters.

## Supported announcement kinds

| `kind` | Posted by | Resolved through |
| --- | --- | --- |
| `rare_capture` | Rare-capture embed (SR and above, from hunts and Delve recruits) | Announcement ledger |
| `appearance_unlock` | Activity Feed line or embed | Announcement ledger |
| `level_up` | Activity Feed line | Announcement ledger |
| `collection_completed` | Activity Feed line | Announcement ledger |
| `boss_spawn` | Boss channel announcement, while the encounter is live | `boss_encounters.message_id` |
| `boss_completed` | The same message, after it is edited when the encounter ends | `boss_encounters.message_id` |
| `boss_results` | Boss results message | `boss_encounters.results_message_id` |

Every other post returns 404. That includes captures below the rare threshold, item finds, care, gifts and expeditions. No new announcements were added, and existing wording and embeds are unchanged.

## Response

Success envelope: `{ "data": CommentaryContext, "meta": { "requestId": string } }`.

### Fact semantics

- Each live statistic is either `{ status: "verified", value, asOf }` or `{ status: "unavailable", reason }`. A verified `0` is a real zero. An unavailable fact is never a zero.
- `reason` is one of:
  - `withheld`: the data exists but is not guild-public;
  - `not_recorded`: WaifuMon never stores it;
  - `player_unavailable`: the player row is gone or no longer in the guild;
  - `degraded`: the query missed its 750 ms budget or failed. Other facts are unaffected.
- **`announced`** is what the message said when it was posted. It is immutable and copied from the ledger or the boss record.
- **`facts`** are read live and may be cached for up to 60 s. Each carries its own `asOf`.
- Describe the event from `announced`. Use `facts` only for "now" statements. Example: `announced.isDuplicate` is the flag as posted, while `facts.activeCopiesOfSpecies` is today's count.

### Facts by kind

| `kind` | `announced` | `facts` |
| --- | --- | --- |
| `rare_capture` | `species {slug,name,rarity}`, `source` (`hunt` \| `delve_recruit`), `isDuplicate`, `waifuId` | `playerLevel`, `activeCopiesOfSpecies`, `collection`, `rarityDistribution`, `guildOwnersOfSpecies`, `firstEverCopy` (always withheld), `captureRegion` (always not recorded) |
| `appearance_unlock` | `waifuId`, `waifuName`, `speciesSlug`, `appearanceId`, `appearanceName`, `unlockLabel`, `cosmeticRarity` | `playerLevel`, `collection`, `copyLevel` (withheld once the copy is no longer actively owned) |
| `level_up` | `level` | `playerLevel`, `trainerRank {rank, guildTrainers}` (a rank, never XP) |
| `collection_completed` | `distinctSpecies`, `totalSpecies` | `collection` |
| `boss_spawn` | `encounterId`, `boss {id,name,affinity,region}`, `deadlineAt` | `guildBossHistory`, `perPlayerRewards` (withheld), `perPlayerOutcome` (not recorded) |
| `boss_completed` | the `boss_spawn` fields, plus `outcome` (`repelled` \| `unchallenged` \| `cancelled_admin` \| `channel_lost`), `participantCount`, `totalDamage`, `totalAttacks`, `resolvedAt` | same as `boss_spawn` |
| `boss_results` | the `boss_completed` fields, plus `firstOnScene {playerId, discordUserId, trainerName, waifuName}` or `null` | same as `boss_spawn` |

Notes on the fields:

- **`source: "hunt"`** covers every wild-encounter capture, including encounters spawned by world encounters, quests or items. `delve_recruit` is a Delve dungeon recruit.
- **`isDuplicate`** means the player already had an **active** copy of the species when this one was caught. A player who released their only copy and then caught another gets `false`.
- **Bosses** are repelled or unchallenged by the whole guild. No player wins or loses one, so `perPlayerOutcome` is always `not_recorded`.

### TypeScript types

```ts
type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR' | 'LR' | 'EX';
type UnavailableReason = 'not_recorded' | 'withheld' | 'player_unavailable' | 'degraded';
type Fact<T> =
  | { status: 'verified'; value: T; asOf: string }
  | { status: 'unavailable'; reason: UnavailableReason };
type Unavailable = Extract<Fact<never>, { status: 'unavailable' }>;

type Kind =
  | 'rare_capture' | 'appearance_unlock' | 'level_up' | 'collection_completed'
  | 'boss_spawn' | 'boss_completed' | 'boss_results';

interface CommentaryContext {
  contractVersion: 1;
  announcement: {
    messageId: string;
    channelId: string | null;      // null only for a boss encounter with no recorded channel
    discordGuildId: string;
    kind: Kind;                    // treat unknown future values as "skip"
    eventId: string;               // UUID, or `boss:<encounterId>:<spawn|completed|results>`
    occurredAt: string;            // ISO 8601 UTC
  };
  player: null | {                 // null for boss posts
    playerId: number | null;
    discordUserId: string | null;
    displayName: string | null;    // presentation only; may be null
    status: 'active' | 'unavailable';
  };
  announced:
    | { species: { slug: string; name: string; rarity: Rarity };
        source: 'hunt' | 'delve_recruit'; isDuplicate: boolean; waifuId: number | null }
    | { waifuId: number; waifuName: string; speciesSlug: string; appearanceId: string;
        appearanceName: string; unlockLabel: string; cosmeticRarity: string }
    | { level: number }
    | { distinctSpecies: number; totalSpecies: number }
    | { encounterId: number; boss: { id: string; name: string; affinity: string; region: string };
        deadlineAt: string | null;
        outcome?: 'repelled' | 'unchallenged' | 'cancelled_admin' | 'channel_lost' | null;
        participantCount?: number; totalDamage?: number; totalAttacks?: number;
        resolvedAt?: string | null;
        firstOnScene?: { playerId: number; discordUserId: string; trainerName: string; waifuName: string } | null };
  facts: {                         // keys depend on kind; ignore unknown keys
    playerLevel?: Fact<number>;
    activeCopiesOfSpecies?: Fact<number>;
    collection?: Fact<{ owned: number; distinctSpecies: number; totalSpecies: number }>;
    rarityDistribution?: Fact<Record<Rarity, number>>;
    guildOwnersOfSpecies?: Fact<{ trainers: number; guildTrainers: number }>;
    trainerRank?: Fact<{ rank: number; guildTrainers: number }>;
    copyLevel?: Fact<number>;
    guildBossHistory?: Fact<{ encounters: number; repelled: number; unchallenged: number;
                              cancelled: number; channelLost: number }>;
    firstEverCopy?: Unavailable;
    captureRegion?: Unavailable;
    perPlayerRewards?: Unavailable;
    perPlayerOutcome?: Unavailable;
  };
}

type Success = { data: CommentaryContext; meta?: { requestId?: string } };
type Failure = { error: { code: string; message: string; details?: Record<string, unknown> }; requestId: string };
```

### Example responses

These were captured from the integration test suite against PostgreSQL 16. All IDs are test fixtures. In the rare-capture example the fixture announced a duplicate, which shows that `announced` reports the flag as posted rather than recomputing it.

**`rare_capture`**

```json
{
  "data": {
    "contractVersion": 1,
    "announcement": {
      "messageId": "1400000000000000001",
      "channelId": "330000000000000003",
      "discordGuildId": "310000000000000001",
      "kind": "rare_capture",
      "eventId": "c7eb917f-cbd6-45bb-877d-44ec07536c0f",
      "occurredAt": "2026-11-03T02:55:25.831Z"
    },
    "player": { "playerId": 1, "discordUserId": "910000000000000001", "displayName": "Sam", "status": "active" },
    "announced": {
      "species": { "slug": "forgotten_valkyrie", "name": "Forgotten Valkyrie", "rarity": "SSR" },
      "source": "hunt",
      "isDuplicate": true,
      "waifuId": 1
    },
    "facts": {
      "playerLevel": { "status": "verified", "value": 12, "asOf": "2026-11-03T02:55:25.854Z" },
      "activeCopiesOfSpecies": { "status": "verified", "value": 1, "asOf": "2026-11-03T02:55:25.864Z" },
      "collection": { "status": "verified", "value": { "owned": 2, "distinctSpecies": 2, "totalSpecies": 197 }, "asOf": "2026-11-03T02:55:25.864Z" },
      "rarityDistribution": { "status": "verified", "value": { "N": 1, "R": 0, "SR": 0, "SSR": 1, "UR": 0, "LR": 0, "EX": 0 }, "asOf": "2026-11-03T02:55:25.866Z" },
      "guildOwnersOfSpecies": { "status": "verified", "value": { "trainers": 1, "guildTrainers": 2 }, "asOf": "2026-11-03T02:55:25.866Z" },
      "firstEverCopy": { "status": "unavailable", "reason": "withheld" },
      "captureRegion": { "status": "unavailable", "reason": "not_recorded" }
    }
  },
  "meta": { "requestId": "ce5b307b-73e0-41a6-96d8-73f14710994a" }
}
```

**`level_up`**

```json
{
  "data": {
    "contractVersion": 1,
    "announcement": { "messageId": "1400000000000000002", "channelId": "330000000000000004", "discordGuildId": "310000000000000001", "kind": "level_up", "eventId": "9c047bcb-db5a-4c05-b58d-5b877d6f619e", "occurredAt": "2026-11-03T02:55:25.869Z" },
    "player": { "playerId": 1, "discordUserId": "910000000000000001", "displayName": "Sam", "status": "active" },
    "announced": { "level": 12 },
    "facts": {
      "playerLevel": { "status": "verified", "value": 12, "asOf": "2026-11-03T02:55:25.880Z" },
      "trainerRank": { "status": "verified", "value": { "rank": 2, "guildTrainers": 2 }, "asOf": "2026-11-03T02:55:25.880Z" }
    }
  },
  "meta": { "requestId": "258048de-3f11-4462-a6ac-7c75b1858455" }
}
```

**`boss_results`**

```json
{
  "data": {
    "contractVersion": 1,
    "announcement": { "messageId": "1400000000000000901", "channelId": "340000000000000004", "discordGuildId": "310000000000000001", "kind": "boss_results", "eventId": "boss:1:results", "occurredAt": "2026-11-03T02:55:25.881Z" },
    "player": null,
    "announced": {
      "encounterId": 1,
      "boss": { "id": "test_boss", "name": "Test Boss", "affinity": "dominant", "region": "waifu-valley" },
      "deadlineAt": null,
      "outcome": "repelled",
      "participantCount": 1,
      "totalDamage": 2400,
      "totalAttacks": 15,
      "resolvedAt": "2026-11-03T02:55:25.881Z",
      "firstOnScene": { "playerId": 2, "discordUserId": "910000000000000002", "trainerName": "Sam", "waifuName": "Pumpkin" }
    },
    "facts": {
      "guildBossHistory": { "status": "verified", "value": { "encounters": 1, "repelled": 1, "unchallenged": 0, "cancelled": 0, "channelLost": 0 }, "asOf": "2026-11-03T02:55:25.906Z" },
      "perPlayerRewards": { "status": "unavailable", "reason": "withheld" },
      "perPlayerOutcome": { "status": "unavailable", "reason": "not_recorded" }
    }
  },
  "meta": { "requestId": "d2913337-19fe-447d-86f4-1c5ee792e9a6" }
}
```

### Errors

| Status | `error.code` | When | What CherryBot should do |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | A non-numeric `discordGuildId` or `messageId`. `details.issues` names the field. | Fix the caller. |
| 401 | `UNAUTHORIZED` | The key is missing, malformed, unknown, revoked or has the wrong secret. The body is identical in every case. | Stop calling and alert the operator. |
| 403 | `INTEGRATION_FORBIDDEN` | A valid key used with a non-GET method, or on any other route. | Treat as a CherryBot bug. |
| 403 | `INTEGRATION_REQUIRED` | The bearer token or a Portal session was used on this route. | Not applicable to CherryBot. |
| 404 | `ANNOUNCEMENT_NOT_FOUND` | Unknown message, another guild, wrong `discordGuildId`, or a kind that isn't recorded. The body is identical in every case. | Skip. See the retry note under [Timeouts, retries and rate limits](#timeouts-retries-and-rate-limits). |
| 429 | `RATE_LIMITED` | Over the per-key budget. A `Retry-After` header gives the wait in seconds. | Skip, or wait `Retry-After` once. |
| 503 | `DB_UNAVAILABLE` | The deciding database lookup failed or took longer than 1.5 s. | Skip. Do not retry in a loop. |

Real bodies captured from the tests:

```json
{ "error": { "code": "ANNOUNCEMENT_NOT_FOUND", "message": "Not found." }, "requestId": "77e82afa-…" }
{ "error": { "code": "UNAUTHORIZED", "message": "Unauthorized." }, "requestId": "709d53d4-…" }
{ "error": { "code": "INTEGRATION_FORBIDDEN", "message": "You do not have permission to do that." }, "requestId": "c57c983b-…" }
{ "error": { "code": "VALIDATION_ERROR", "message": "The request was not valid.", "details": { "issues": [ { "path": "/messageId", "message": "Expected a Discord id." } ] } }, "requestId": "3fb2961d-…" }
```

Branch on `error.code`. The `message` field is user-facing wording and may change.

## Event identity and deduplication

- For ledger kinds, `announcement.eventId` is a UUID that is stable per announcement. For boss posts it is `boss:<encounterId>:<spawn|completed|results>`.
- Deduplicate on `eventId` so a gateway redelivery or a repeated request never produces a second comment.
- A boss announcement is one Discord message whose kind changes from `boss_spawn` to `boss_completed` when the encounter ends. To comment on the outcome, re-query on `messageUpdate`. The new kind has a new `eventId`.

## Privacy restrictions (enforced server-side)

- **Never returned:** XP, currencies, Energy, inventory, gear, affection, Seductive Power, release history, hidden or locked achievements, per-player boss rewards or damage, artwork asset IDs, admin data, and anything from another guild.
- **Comparisons:** only within the configured guild, and only from guild-public data: who owns a species, and leaderboard **rank**, never the underlying value.
- **Disclosure tier:** at most what a guild-mate already sees in the Portal, plus what the announcement itself published.
- **Allowlist:** the response is serialised through an allowlist schema (`src/api/schemas/integrations.ts`). Any key not listed there is stripped.
- **No player opt-out** exists, by decision.
- **Player identity** always comes from the ledger or boss record, never from a display name.
- **No mentions are generated.** If CherryBot addresses a player as `<@discordUserId>`, it should send with mentions disabled unless it intends to ping.

## Timeouts, retries and rate limits

- **Rate limit:** 30 requests per minute per key, with a burst of 10. Over the limit returns 429 with `Retry-After`.
- **Server budgets:**
  - the deciding lookup has 1.5 s, after which the request returns 503;
  - each live fact has 750 ms, after which that fact is `degraded`.
- **Cache:** each answer is cached for 60 s per message. Concurrent requests for the same message share one computation.
- **CherryBot timeout:** use 2 s. On timeout or 503, retry at most once, after 5 s. Never poll.
- **Race on new messages:** WaifuMon writes the ledger row just *after* Discord confirms the post, so CherryBot can see the message a few milliseconds before the row exists. If a message less than 10 s old returns 404, retry once after 2 s. Misses are never cached.

## Network

Staging and production run on **one Docker host** as separate Compose projects. Each environment therefore gets its own integration network and its own API alias, and nothing is shared between them.

| Item | Staging | Production | Default (single-environment host) |
| --- | --- | --- | --- |
| `WAIFUMON_INTEGRATION_NETWORK` | `waifumon-integrations-staging` | `waifumon-integrations-prod` | `waifumon-integrations` |
| `WAIFUMON_INTEGRATION_ALIAS` | `waifumon-api-staging` | `waifumon-api-prod` | `waifumon-api` |
| API base URL for the integration | `http://waifumon-api-staging:3120/api/v1` | `http://waifumon-api-prod:3120/api/v1` | `http://waifumon-api:3120/api/v1` |

Common to every environment:

| Item | Value |
| --- | --- |
| Network type | External, created by the operator with `--internal` (no route off the host). Compose never creates it. |
| Members | That environment's `waifumon-bot` and that environment's CherryBot container. **Not** `postgres` or `waifumon-portal`, and never the other environment's containers. |
| Port | 3120, container to container. No host port is added; `PLATFORM_API_PUBLISH_HOST` is unchanged. |
| Public edge | Portal nginx: `location ^~ /api/v1/integrations { return 404; }` |

On the WaifuMon side this is the opt-in override `docker-compose.integrations.yml`. It is not part of the base file because Compose refuses to start a project whose external network does not exist. The override keeps the bot on its `default` network, which is how it reaches Postgres and how the Portal reaches it, and adds the environment's integration network.

### Two kinds of variable

| Variable | Read by | When |
| --- | --- | --- |
| `COMPOSE_FILE`, `WAIFUMON_INTEGRATION_NETWORK`, `WAIFUMON_INTEGRATION_ALIAS` | **Docker Compose**, while parsing the files | Every `docker compose` command. Taken from the shell environment if set there, otherwise from the `.env` file in the project directory. |
| `PLATFORM_API_INTEGRATION_KEYS`, `PLATFORM_API_INTEGRATION_GUILD_ID` | **The WaifuMon application**, at bot startup | Passed into the container through `env_file: .env`. |

Both groups usually live in the same per-environment `.env`. That works only when `docker compose` is run from that environment's checkout directory, or with `--project-directory` pointing at it. A shell `export` overrides `.env`, so an exported staging value would leak into a production command run from the same shell. Prefer `.env`, and check with `docker compose config` before every `up`. The application ignores the two Compose variables.

If `WAIFUMON_INTEGRATION_*` is unset or empty, both environments fall back to the same default network. On the shared host, always set them explicitly.

### CherryBot's side (not in this repository)

Each CherryBot environment joins only the matching WaifuMon network and calls the matching alias:

```yaml
services:
  cherrybot:            # its real service name
    networks: [default, waifumon]   # keep its own default network for Discord
networks:
  waifumon:
    external: true
    name: waifumon-integrations-staging   # -prod for production
```

Staging CherryBot uses `http://waifumon-api-staging:3120/api/v1`. Production CherryBot uses `http://waifumon-api-prod:3120/api/v1`.

The CherryBot container can reach the whole Platform API on port 3120, and the legacy admin panel on 3111 if that is ever enabled. Every route still requires a credential, and the integration key can reach only its own prefix. **The credential is the authorization boundary.** The network keeps the traffic private, keeps Postgres out of reach, and keeps staging and production apart.

## Deployment prerequisites

Do these per environment, in that environment's checkout (staging first). Examples use staging; use the `-prod` values for production.

1. `PLATFORM_API_ENABLED=true` and a `PLATFORM_API_TOKEN` are already set in that `.env`. If not, enabling the Platform API is its own change and needs its own review.
2. Migration `0077_announcement_ledger` runs automatically at bot startup. It is additive. To roll back, leave the table in place.
3. Create that environment's network once. This is an operator action; nothing in WaifuMon creates or changes networks.

   ```bash
   docker network create --internal waifumon-integrations-staging   # staging
   docker network create --internal waifumon-integrations-prod      # production, later
   ```

4. In that environment's `.env`, set:

   ```dotenv
   COMPOSE_FILE=docker-compose.yml:docker-compose.integrations.yml
   WAIFUMON_INTEGRATION_NETWORK=waifumon-integrations-staging
   WAIFUMON_INTEGRATION_ALIAS=waifumon-api-staging
   PLATFORM_API_INTEGRATION_KEYS=<keyId>:<hash>
   PLATFORM_API_INTEGRATION_GUILD_ID=<the guild id>
   ```

   Use a different key for each environment. The equivalent one-off shell form is `export COMPOSE_FILE=docker-compose.yml:docker-compose.integrations.yml`, but see the warning above about exported variables.
5. **Before `up`, confirm the resolved configuration names this environment and only this environment:**

   ```bash
   docker compose config | grep -nE 'waifumon-integrations|waifumon-api'
   #   expect only the -staging names; no -prod line and no bare default name
   docker compose config | sed -n '/^  waifumon-bot:/,/^  [a-z]/p' | grep -A6 '^    networks:'
   #   expect both `default` and `integrations` (with the -staging alias)
   docker compose config | sed -n '/^networks:/,$p'
   #   expect `integrations:` with `external: true` and `name: waifumon-integrations-staging`
   ```

6. Rebuild and recreate:

   ```bash
   docker compose config >/dev/null   # fails here if a file in COMPOSE_FILE is missing
   docker compose up -d --build waifumon-bot
   docker compose --profile portal up -d --build waifumon-portal   # for the nginx rule
   ```

   Use `up -d`, not `restart`: `restart` keeps the old environment and the old network attachments.

## Staging validation

Run these on the shared host from the **staging** checkout, after the prerequisites. Record each result. Do not mark the endpoint operational until every step passes. Container names are looked up through Compose, never assumed.

```sh
NET=waifumon-integrations-staging
ALIAS=waifumon-api-staging
BOT=$(docker compose ps -q waifumon-bot)
nets() { docker inspect "$1" --format '{{range $n, $c := .NetworkSettings.Networks}}{{$n}} aliases={{$c.Aliases}}{{"\n"}}{{end}}'; }

# 1. Network attachments.
docker network inspect "$NET" --format 'internal={{.Internal}} members={{range .Containers}}{{.Name}} {{end}}'
#    expect internal=true and only this environment's bot (plus its CherryBot once attached)
nets "$BOT"
#    expect two lines: <project>_default, and $NET with aliases including $ALIAS
nets "$(docker compose ps -q postgres)"          # expect only <project>_default
nets "$(docker compose ps -q waifumon-portal)"   # expect only <project>_default

# 2. A throwaway container on the integration network reaches the API and NOT Postgres.
docker run --rm --network "$NET" curlimages/curl:8.10.1 -s -o /dev/null -w '%{http_code}\n' "http://$ALIAS:3120/health"   # 200
docker run --rm --network "$NET" busybox:1.36 nslookup postgres                                                         # must fail

# 3. Auth boundary over the private network.
K="Authorization: Integration <keyId>.$SECRET"
U="http://$ALIAS:3120/api/v1/integrations/commentary/context"
C="docker run --rm --network $NET curlimages/curl:8.10.1 -s -o /dev/null -w %{http_code}\n"
$C -H "$K" "$U?discordGuildId=$GUILD&messageId=1"                       # 404 ANNOUNCEMENT_NOT_FOUND
$C -H "Authorization: Integration <keyId>.wrong" "$U?discordGuildId=$GUILD&messageId=1"   # 401
$C -X POST -H "$K" "$U?discordGuildId=$GUILD&messageId=1"              # 403
$C -H "$K" "http://$ALIAS:3120/api/v1/players/1"                       # 403
$C -H "Authorization: Bearer $PLATFORM_API_TOKEN" "$U?discordGuildId=$GUILD&messageId=1"   # 403

# 4. Public edge refuses it.
curl -s -o /dev/null -w '%{http_code}\n' https://<staging portal host>/api/v1/integrations/commentary/context   # 404

# 5. Real announcement → real context. In the staging guild:
#    - level up a test player, or catch an SR+ in the Waifumon Log;
#    - copy the message ID (Discord developer mode → Copy Message ID);
$C -H "$K" "$U?discordGuildId=$GUILD&messageId=<that id>"              # 200
#    and with `-o -` instead of `-o /dev/null`, confirm kind, player.discordUserId and announced match the post.
#    For a boss: query the results message ID after an encounter resolves (expect boss_results + firstOnScene).

# 6. Ledger is being written and pruned.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select kind, count(*), max(created_at) from announcement_ledger group by kind;"
```

### Shared-host isolation checklist

Tick each item and record the command output. Items marked *production* apply once production enables the integration; until then, confirm production is untouched.

- [ ] **1. Staging bot joins `waifumon-integrations-staging`.** Run `nets "$BOT"` from the staging checkout. The staging network appears.
- [ ] **2. Production bot does not join the staging network.** From the production checkout, run `nets "$(docker compose ps -q waifumon-bot)"`. No `-staging` network appears. Also run `docker network inspect waifumon-integrations-staging`: none of its members belong to the production project.
- [ ] **3. Staging bot stays on its default Compose network.** `nets "$BOT"` still shows `<staging project>_default`. The bot logs show no database connection errors after the recreate.
- [ ] **4. Postgres and the Portal are absent from the integration network.** `nets` for both shows only `<project>_default`, and `nslookup postgres` from the integration network fails.
- [ ] **5. Staging alias is `waifumon-api-staging`.** It appears in `nets "$BOT"`, and step 2 above reaches `/health` through it.
- [ ] **6. *Production:* alias is `waifumon-api-prod`.** Same checks from the production checkout, against `waifumon-integrations-prod`.
- [ ] **7. Application-to-database connectivity still works.** `curl -s http://127.0.0.1:$PLATFORM_API_PORT/ready` on the host (3220 for staging per `.env.example`) reports the database as ok, and `/waifumon` works in the staging guild.
- [ ] **8. No additional host ports.** `docker compose ps` shows the same published ports as before the change: loopback 3211/3220/3230 for staging, 3111/3120/3130 for production.
- [ ] **9. The public Portal still denies integration access.** Step 4 above returns 404 on the staging Portal host, and later on the production Portal host.

## Known limitations

- **Revocation needs a container recreate.** There is no hot reload.
- **Unrecorded messages:** messages posted before this deployment, or whose ledger insert failed, return 404. A failed insert is logged as `announcement-ledger/record-failed`.
- **What isn't recorded:** captures below the rare threshold, item and currency finds, care, gifts, expeditions, region discoveries, achievements and Delve run outcomes. WaifuMon announces none of the last four.
- **Rare-embed channel:** when a guild has no Waifumon Log set, the rare-capture embed falls back to the channel the capture happened in. The ledger records the actual channel.
- **Slow queries keep running:** a `degraded` fact's database query may still finish in the background. All fact queries are bounded to one player, one species or one guild.
- **Per-process state:** the rate limiter and cache live in the bot process and reset on restart.
- **Ledger retention:** 30 days, pruned hourly in bounded batches (at most 10,000 rows per pass).
- **Boss channel ID:** `channelId` is `null` for a boss encounter whose channel was never recorded. This has not been observed.

## Contract version

`contractVersion: 1`. New `kind` values, new fact keys and new optional fields are additive and do not bump the version, so ignore unknown values. Any removal or change of meaning bumps the version.

## Recommended CherryBot integration sequence

1. Build against the TypeScript types and the examples above, using a local stub that returns them.
2. Filter on Discord `messageCreate`, plus `messageUpdate` in the boss channel. Act only when all of these hold:
   - the author is the WaifuMon bot user;
   - the guild is the configured guild;
   - the channel is the Waifumon Log or the boss channel.

   Never identify a player from text, embed titles or attachment names.
3. Decide whether a message is interesting. Embed title and rarity are an acceptable hint.
4. Call the endpoint with the 2 s timeout, handling each status as in the [Errors](#errors) table.
5. Deduplicate on `eventId`.
6. Use only `verified` facts. Never mention an `unavailable` one, and never phrase it as zero.
7. After the WaifuMon staging procedure passes, join staging CherryBot to `waifumon-integrations-staging` and repeat step 5 of that procedure from the CherryBot container, against `http://waifumon-api-staging:3120`. Production CherryBot later joins only `waifumon-integrations-prod` and calls `waifumon-api-prod`.

## Verification

Results from the development machine, on PostgreSQL 16 run in podman. See the implementation report for the full run.

| Suite | Result |
| --- | --- |
| `tests/unit/api/integrationAuth.test.ts` (credentials, rotation, revocation, allowlist sweep over every documented route, path tricks, rate limit, config) | 29/29 |
| `tests/integration/api/commentaryContext.test.ts` (correlation through the real `sendRareAnnouncement`, same-name trainers, guild 404s, privacy keys, verified zero vs unavailable, released copies, boss semantics, concurrency, cache, degraded facts, 503, retention) | 33/33 |
| `tests/unit/announcementLedgerFeed.test.ts` (the feed passes its event, wording unchanged, v1 kind mapping) | 3/3 |
| `tests/unit/composeIntegrationNetwork.test.ts` (static checks: Compose's `${VAR:-default}` rule resolved for default, empty, staging and production values; staging and production never share a network or alias; the bot keeps `default`; only the bot is attached; external network; no ports; base file untouched) | 13/13. A deliberately broken override (no `default`, hardcoded name) fails 7. |
| `portal/src/__tests__/nginxHeaders.test.ts` (including the new rule) | 48/48 |
| nginx 1.27 `nginx -t` on the rendered template, plus live requests | Syntax OK. `/api/v1/integrations`, `/api/v1/integrations/…`, `%69ntegrations`, `//`, and `x/../` variants all return 404. A normal `/api/…` request still proxies. |
| Full root suite | 9418 tests, 166 failing, against 9347 tests and 166 failing on untouched HEAD `87c475d6`. The failure lists are identical apart from one swapped `bossScheduler` timing flake, which passes 2/2 in isolation. The 71 additional tests are the new ones, and all pass. |
| Portal suite | 2057/2058. The one failure is the pre-existing architecture baseline (#0069). |
| `npm run typecheck`, `npm run build` | Pass. |
