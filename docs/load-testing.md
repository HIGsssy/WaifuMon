# Load testing

Controlled, repeatable Waifumon load from the Portal, for answering one
question: **how does Waifumon behave with about 1, 5, 10, 25 and 50 concurrently
active players?** Watch the effect on **Admin — System Metrics**; this page
generates the load and records the client's side of it.

Infrastructure testing only. It is not a player feature, it touches no real
player, and it sends nothing to Discord.

## Enabling it (staging only)

```dotenv
LOAD_TESTING_ENABLED=true
LOAD_TESTING_HOST_LABEL=3400GE staging          # recorded on every run
LOAD_TESTING_OPERATOR_DISCORD_IDS=123456789012345678   # optional allowlist
```

Requires `PLATFORM_API_ENABLED=true` and `PORTAL_PUBLIC_URL` — startup refuses
otherwise. Restart the bot. The log says, at `warn`, that load testing is
enabled; production must never print that line.

### How production is locked out

Waifumon has no "staging" or "production" setting — the two deployments differ
only in which surfaces they opt into — so `LOAD_TESTING_ENABLED` **is** the
environment gate, and it defaults to `false`. With it off, four independent
things hold:

1. **No routes.** The host builds no `LoadTestController`, so
   `/api/v1/admin/load-testing/*` is never registered and 404s for everyone —
   owner, admin-bearer token, anyone — and is absent from the OpenAPI document.
2. **No permission.** The authorization service issues `system.loadtest.run`
   to nobody, the guild owner included, so the Portal never shows the page.
3. **No controller.** `LoadTestController`'s constructor throws unless enabled.
4. **No generator.** `runner.ts` exits with status 2 unless its own
   environment carries `LOAD_TESTING_ENABLED=true`, so starting it by hand from
   a production build does nothing.

Turning it on is an edit to server configuration plus a restart. Nothing in the
Portal or the API can change it.

### Who may use it

`system.loadtest.run` follows `system.metrics.read`: held only by the **live
Discord owner of the selected guild**, never grantable to a role, filtered out
of any grant row that names it. Holding System Metrics access does not confer
it.

That is the same model System Metrics uses, and it is worth being plain about
what it means: "owner of *any* guild the bot is in", not "platform operator".
On a staging bot only you own guilds, and that is fine. If anyone else might,
set `LOAD_TESTING_OPERATOR_DISCORD_IDS` — the permission then also requires
your Discord id.

The bearer token satisfies the permission only with
`PLATFORM_API_ADMIN_BEARER=true`, as for every admin route. That makes runs
scriptable (`curl -XPOST … /api/v1/admin/load-testing/runs`) for back-to-back
comparisons; the operator allowlist cannot apply to a bearer request.

## Architecture

```
 Portal (browser)                         Waifumon process                          generator process
 ────────────────                         ────────────────                          ─────────────────
 Load Testing page ──POST /runs──▶ LoadTestController ──fork(runner.ts)──▶ LoadEngine
        ▲                             │  prepares synthetic players            │  N virtual players
        └──GET status (1 s)───────────┤  mints their Portal sessions           │  act → think → act
                                      │  relays progress ◀──IPC progress───────┤
 System Metrics page ◀── collectors ──┤  snapshots metrics at start/end         │
                                      │  cleans up, records result              │
                                      └──────────── HTTP (loopback) ◀──────────┘
```

**The generator is a separate process.** It exists to read Waifumon's own
event-loop delay, loop utilization and CPU under load. Inside the same process
it would add its own work to every one of those readings — building requests,
parsing responses, reading card bytes, fifty timers — and its latencies would
include time queued behind the server work it was timing. So the controller
forks `src/modules/loadTest/runner.ts`, and load arrives over loopback HTTP like
any other client's.

What that means for the dashboard:

| Reading | Includes the generator? |
| --- | --- |
| `process` CPU, event loop, HTTP latency, pool, renderer | **No** — Waifumon only |
| `host` CPU / memory / load / PSI | **Yes** — same machine |
| `cgroup` memory (under Docker) | **Yes** — same container |

The Load Testing page shows the generator's own CPU ("% of one core") so its
share of the host figures can be subtracted. It is small — the generator mostly
sleeps.

**The generator can reach only HTTP.** It is forked with an allowlisted
environment (`PATH`, `NODE_ENV`, `TZ`, `LANG`, `HOME`, `NODE_OPTIONS`, plus the
enable flag): no `DATABASE_URL`, no `DISCORD_TOKEN`, no `PLATFORM_API_TOKEN`.
Its only credentials are the synthetic players' session cookies, delivered over
IPC. It exits when stopped, when its own deadline passes, or when the parent
disconnects.

It targets the API port directly on loopback — nginx and Cloudflare are not in
the path. That is deliberate: the question is the application's capacity.

## Workload profiles

Every virtual player loops: **pick an action → perform it → think**. An action
is a Discord command's reads, or a Portal page's queries (issued together, as a
React page does on mount). Think time is log-normal — mostly short, sometimes
long, like people — and clamped:

| Persona | Median think | Range |
| --- | --- | --- |
| Discord player | 10 s | 3–30 s |
| Portal user | 12 s | 4–40 s |
| Card browser | 10 s | 3–30 s |

So 50 players is roughly 5–15 requests per second in total, not 50 loops
hammering the server. Players join over a ramp of a tenth of the run (at most
30 s). Every choice is drawn from a PRNG seeded per run (default seed 1337), so
**the same scenario issues the same requests in the same order on every host.**

1. **Normal Gameplay** — the reads Discord commands make, through the same
   services: hunt pre-checks (encounter, energy, capture bonus), collection
   pages, inspect (entry + her card), profile, inventory + sellables, buddy +
   care, daily + quests, expeditions. The bot's commands call these services
   in-process; the generator cannot drive a Discord interaction, so it reaches
   them through their read-only API adapters. That adds Fastify routing and
   serialization and leaves out embed building and attachment upload.
2. **Portal/API** — Portal page views: dashboard, collection (paged, sometimes
   rarity-filtered), Waifumon detail, encyclopedia and species detail,
   inventory, shop, the players directory and a public profile, leaderboards,
   achievements, and an occasional fresh app load (`/auth/session`). No card
   images.
3. **Card Rendering** — the real card route and renderer.
   - *Warm*: collection grid in card mode — six cards at once (a browser's
     per-origin limit), 30% revalidated with `If-None-Match` (304).
   - *Cold*: bursts of three never-drawn cards. See below.
4. **Mixed Players** — the capacity test. A fixed 20-slot rotation: 55%
   Discord players, 35% Portal users (who also flip to card mode now and then),
   10% card browsers, with an occasional brand-new card standing in for fresh
   captures and level-ups.

Every request is a `GET`. No workload hunts, captures, buys, claims, deploys,
equips or releases anything.

## Test isolation

Some reads write. `GET /achievements` inserts newly-met unlocks; `GET /encounter`
expires a stale encounter. So virtual players are **synthetic players**, never
real ones:

- One synthetic guild, `discord_guild_id = 7357000`, with **no announce channel
  and no boss channel** (reset to null if anyone sets one), so nothing narrates
  or schedules for it.
- Players `7357001…`, one per virtual player, each with a deterministic
  collection: the same 24-copy grid, plus 10–50 more varying by index;
  currencies, a few items, a buddy. Built on first use, extended when a run asks
  for more players, never rebuilt.
- The ids are numeric because the API's schemas require snowflakes, and small
  because a real snowflake cannot be: its top bits are milliseconds since 2015,
  so real ids are 17+ digits. `7357xxx` decodes to 1 ms after Discord's epoch.
- Identity, guild-ownership and role lookups return "unknown" for these ids
  **without calling Discord** — no REST request is ever made for them.
- Each virtual player authenticates with a real Portal session for its own
  synthetic player, minted just before the run and **deleted** after it. The
  server's own player scoping then refuses every other player (tested); the
  directory and leaderboards are guild-scoped, so synthetic players never appear
  to real ones and vice versa.
- Before any session is minted, every planned player is checked against the
  database to be in the synthetic guild with a synthetic id. One real player in
  the list and the run fails before it starts.

The synthetic guild and players stay in the database between runs. They are
inert: no channels, no Discord members, no owner.

## Card warm/cold testing

**Priming** runs first, unmeasured: each virtual player touches every read once
(this also records any first-time achievement unlocks and schedules the
background owned-card warm a first collection listing triggers), and the
controller waits for the renderer and warmer to go idle. The timed phase
therefore starts from a steady, warm state — the same state on every run.

**Warm** requests then hit cached cards; a healthy warm run shows
`masterRenders` flat and `cacheHits` climbing on System Metrics.

**Cold** needs cards nobody has drawn, without wiping the real cache (which
would make the next hour of real traffic a render storm) and without leaving
the run's renders behind (which would make the next cold run warm). Level is
part of a card's render key, and `/cards/species/:slug` takes `level`, so the
key space already holds thousands of legitimate, never-requested cards — a
level-44 preview of a species nobody has at 44. Just before the clock starts
the controller:

1. walks (species every synthetic player has discovered) × (levels, highest
   first), asks the renderer for each master's key, and keeps only keys **not
   on disk**;
2. hands that list to the generator, which requests each exactly once at the
   Portal grid width (master + 512 px derivative);
3. after the run, waits for renders in flight to land, then **deletes exactly
   those keys' files** — master and derivatives — and nothing else.

Nothing that existed before the run is ever in the list, so nothing real is
deleted, and the cache ends the run as it began — the next cold run is cold
again (verified end to end in `tests/integration/api/loadTestCards.test.ts`).
The plan is capped at 1,500 cards; if a run exhausts it, the page says so
("plan spent") and the players fall back to warm grids. If a real player
happens to request one of those exact previews during the run, that cache entry
is removed too and re-renders on its next request.

On System Metrics during a cold run: renderer workers `active` at the pool size,
`queued` and `peakQueued` climbing, event-loop delay (the point of the worker
pool is that it *doesn't*), process CPU above 100% (worker threads).

## Running a comparison

1. Open **Admin — Load Testing** and **System Metrics** (the page links it, in
   a new tab).
2. Pick a profile, players and duration. Leave *Reset the metrics window at
   start* on so System Metrics' cumulative percentiles cover exactly the run.
3. Start. States: `preparing` → `priming` → `running` → `completed`. Stop is
   available throughout and still cleans up and records the partial run.
4. Compare under **Recorded runs**; each row is also in `load_test_runs`.

A sensible series: Mixed at 1, 5, 10, 25, 50 players, 5 minutes each, on each
host, with the same seed. Then Card Rendering cold at 10 and 25 to find where
the renderer queue stops draining.

## What is recorded

One row per run in `load_test_runs` (migration `0041`):

- start/end time, profile, card mode, players, requested and actual duration,
  seed, label, host label, operator;
- host info: hostname, CPU model, logical CPUs, memory, Node version, render
  workers, database pool max;
- the generator's summary: operations attempted/completed, failures by kind
  (4xx, 5xx, timeout, network), cancelled, actions, ops/sec, latency
  p50/p95/p99 overall **and per endpoint**, cold cards planned/requested,
  304s, generator CPU, up to 20 sample errors;
- a compact System Metrics reading at the start and end of the timed phase
  (event loop, process CPU/RSS, host CPU/load/memory, cgroup memory/OOM, HTTP
  counts and percentiles, pool, renderer counters) and the counter deltas
  across the run (requests, 5xx, master/derivative renders, cache hits, worker
  crashes, OOM kills).

Latency here is client-observed: request sent to body fully read, over
loopback. System Metrics' HTTP latency is server-side. The gap between them is
Fastify queueing and transport.

## Limits and known gaps

- **Players 1–100, duration 30 s–30 min**, validated server-side. One run at a
  time. A run past its deadline is told to stop and then killed.
- **Discord is not exercised.** Gateway latency, rate limits, embed building
  and attachment upload are outside the harness; so is nginx.
- **Reads only.** Write paths (hunts, captures, purchases, deploys) and their
  locking are not load-tested. Adding them would mean write-capable synthetic
  gameplay behind the same isolation checks — a deliberate next step, not a
  flag.
- **Same host.** The generator shares CPU and memory with Waifumon. Its CPU is
  reported so it can be accounted for; running it from another machine is not
  built.
- **Synthetic collections are not your players'.** Sizes (34–74 copies) and
  levels are plausible, not measured. Comparisons between hosts are sound;
  absolute numbers are an estimate of real load.
- **Session lookups** hit Postgres per request, exactly as a browser's do.
