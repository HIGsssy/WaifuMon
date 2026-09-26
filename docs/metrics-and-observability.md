# Metrics and observability

Instrumentation for capacity measurement: what the process reports, how to read
it, and the staging-only Postgres settings that cover the half the process
cannot see.

This exists because of a gap the card-rendering work left open.
`docs/card-rendering-deployment.md` benchmarks the renderer on a 24-core
workstation and says plainly that those are not sizing numbers for the
production node — a Ryzen mini-PC sharing 16 GB between Postgres, the Discord
gateway, Fastify and the renderer. The measurements that would close that gap
(peak RSS during a cold burst, event-loop delay on four slower cores, whether
the connection pool saturates) had nowhere to be read from. Now they do.

## What it is not

No Prometheus, no Grafana, no scrape agent, no time-series database. This
process deliberately runs without Redis and without a queue broker, and buying a
permanent metrics stack to answer one sizing question is a bad trade. `/metrics`
is JSON over the existing authenticated HTTP surface: readable with `curl` and
`jq`, consumable by a load harness, and free when nobody calls it.

The tradeoff is that **nothing is retained**. A scrape reports the window since
process start or since the last reset; history lives in whatever you write it
to. For a bounded capacity test that is the right shape. A standing production
dashboard would want the other design, and that is a deliberate later decision
rather than something this quietly forecloses.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/metrics` | Everything, for the current window. |
| `POST` | `/metrics/reset` | Start a fresh window. Instrumentation only. |

Both sit outside `/api/v1`, beside `/health` and `/ready`, for the reason those
two do: ops tooling needs a target that survives a version bump. Both answer at
the top level rather than inside the `{ data }` envelope — they describe the
process, not a game resource.

### Authentication

Two layers, and they guard different things.

1. **The route requires the bearer token.** `/metrics` is deliberately absent
   from `isPublicPath`, so the global auth hook already demands a credential —
   but that hook accepts either `PLATFORM_API_TOKEN` *or* a Portal session
   cookie. A Portal session is a **player's** browser login, and RSS, query
   latency and pool saturation are operator readings. So these routes narrow
   further and answer `403 METRICS_FORBIDDEN` to a session the global hook was
   happy with. This is the security boundary.
2. **Nginx returns 404 at the Portal edge.** `location ^~ /metrics` in
   `portal/nginx.conf.template`, the same treatment `/ready` and the Swagger
   surface get, and for a stronger reason: the payload is a live capacity
   profile of the deployment. Unpublished rather than removed — it still answers
   on the loopback Platform API and container-internally, which is where it is
   actually used.

`PLATFORM_API_METRICS_ENABLED` defaults to **`true`**. That is a departure from
the other flags in `.env.example` and it is deliberate: given the two layers
above, enabling the routes exposes nothing a token holder could not already
reach, and an observability endpoint that needs a config change plus a restart
is one that is off during the incident it was built for. Set it to `false` and
both the routes *and* the request-timing hooks disappear — a real off switch,
not a hidden endpoint.

## Reading it on staging

The API is published on loopback by default (`PLATFORM_API_PUBLISH_HOST`), so
from a shell on the stage host:

```bash
# Everything, pretty-printed.
curl -s -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  http://127.0.0.1:3120/metrics | jq .
```

From a workstation, tunnel rather than publishing the port:

```bash
ssh -N -L 3120:127.0.0.1:3120 stage-host
```

The three readings that matter most, in one line each:

```bash
M='curl -sH "Authorization: Bearer '$PLATFORM_API_TOKEN'" http://127.0.0.1:3120/metrics'

# Is the loop stalling? Compare p99 against resolutionMs, not against zero.
eval $M | jq '.eventLoop | {resolutionMs, p99: .delay.p99Ms, utilization}'

# Is the pool the bottleneck? Sustained waitingCount > 0 is the answer.
eval $M | jq '.database.pool'

# Is the card cache holding? A healthy steady state is masterRenders flat.
eval $M | jq '.cards'
```

Sample every few seconds into a file for the duration of a test:

```bash
while :; do
  curl -s -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
    http://127.0.0.1:3120/metrics
  echo
  sleep 5
done > metrics-$(date +%s).ndjson
```

### Isolating a measurement window

```bash
curl -s -XPOST -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  http://127.0.0.1:3120/metrics/reset
```

**Percentiles cannot be differenced between two scrapes.** Counters can — take
two samples and subtract — but a p99 is a property of a distribution, so
answering "p99 during the ramp" as distinct from "p99 including warm-up"
requires zeroing between phases. That is why the reset route exists.

It touches instrumentation only: no gameplay state, no cache, no database.
`inFlight` is deliberately **not** zeroed, because requests in flight are still
in flight afterwards and clearing it would make the next response underflow the
count.

## What is reported

### `eventLoop`

The most diagnostic number here. The renderer is built the way it is *because* a
master render blocks a thread for ~750 ms in synchronous resvg, and the point of
moving it to a worker was to keep that off the loop serving Discord and Fastify.
This is the measurement that says whether that separation holds on a given
machine.

- `delay` — how late timers fired, in ms, as percentiles over the window.
- `resolutionMs` — the sampling floor, 20 ms by default. **Reported delay never
  drops below roughly this value even on a completely idle loop.** Compare
  against the idle baseline, never against zero.
- `utilization` — fraction of wall time the loop was busy, 0–1.

Reading both distinguishes the two ways a request gets slow: low utilization
with high latency means waiting on Postgres; high utilization means compute-
bound. A capacity test needs to tell those apart.

### `process.memory`

`rssBytes` is the figure to compare against host RAM, and it includes the render
worker threads — threads share an address space. But `heapUsedBytes` and
`heapTotalBytes` are **per-isolate** and describe the main thread only, which is
why the payload carries `heapScope: "main-thread"`: part of the rss/heap gap is
another thread's JavaScript heap, not native allocation. Sharp's decoded buffers
and resvg's canvases land in `externalBytes`.

`cpu.majorPageFaults` climbing is the signal that the host has started swapping
— on a 16 GB box shared with Postgres that is the failure mode worth catching
early.

### `http`

Per-route request counts and latency percentiles, keyed on the route *pattern*
(`/api/v1/players/:playerId/collection`) so cardinality is bounded by the route
table rather than growing with player ids. Requests that matched no route fold
into `<unrouted>`.

Timing starts at `onRequest`, before body parsing, validation and auth — so a
401, a 413 and a 404 are all in the distribution. A client waited for each of
them, and an instrument that timed only successful requests would report the
system healthiest exactly when it had started refusing work.

`errors` is 4xx + 5xx (the error-rate numerator); `serverErrors` is 5xx alone.

### `database.pool`

`waitingCount` is the one to watch. The pool is capped at 10 in
`src/db/client.ts` and **that ceiling is unchanged by this work**. Sustained
`waitingCount > 0` means requests are serializing on connections rather than on
Postgres, and it is the reading that would justify raising `max` — which is why
it is reported next to the ceiling rather than on its own.

### `cards`

`active: false` with nulls throughout means no renderer has been built in this
process — no card drawn or served. That is a real signal, not a gap, which is
why it is not reported as zeros.

`workers` appears once a cold master has actually been drawn on a thread. Two
fields carry most of the value:

- `peakQueued` — how deep a burst actually got. The pool bounds concurrency, so
  25 cold cards produce a queue, not 25 threads; this is that queue's high-water
  mark.
- `replaced` — threads replaced after an unexpected exit. **A crash count.**
  Non-zero during a load test is a finding, not noise.

A healthy warm steady state is `masterRenders` flat across scrapes with
`cacheHits` climbing.

## Postgres observability (staging only)

Two tracked files, wired in by the host's own Compose override:

- `docker/postgres/stage-observability.conf` — `pg_stat_statements`, a 200 ms
  slow-query threshold, lock-wait logging.
- `docker/postgres/initdb/10-observability.sql` — `CREATE EXTENSION`.

Nothing in either changes query results, planning or durability. Every setting
is a statistics collector or a logging threshold, so the worst case of getting
one wrong is log volume.

**Stage only, on purpose.** `pg_stat_statements` carries a small per-statement
bookkeeping cost and a shared-memory allocation, and `log_min_duration_statement`
writes a line per slow query. Both are the right trade during a capacity test and
neither should be carried into production without deciding to.

### Wiring it in

`docker-compose.stage.yml` is host-specific and intentionally untracked, so it is
not modified here. Add to its `postgres` service:

```yaml
services:
  postgres:
    volumes:
      - ./docker/postgres/stage-observability.conf:/etc/postgresql/observability.conf:ro
      - ./docker/postgres/initdb:/docker-entrypoint-initdb.d:ro
    command:
      - postgres
      - -c
      - config_file=/usr/share/postgresql/postgresql.conf.sample
      - -c
      - include=/etc/postgresql/observability.conf
```

Simpler alternative, if editing `command` is awkward — pass the settings
directly and skip the file:

```yaml
services:
  postgres:
    command:
      - postgres
      - -c
      - shared_preload_libraries=pg_stat_statements
      - -c
      - pg_stat_statements.track=all
      - -c
      - log_min_duration_statement=200ms
      - -c
      - log_lock_waits=on
      - -c
      - track_io_timing=on
```

Then **restart** — `shared_preload_libraries` is read only at startup, so a
reload will not do:

```bash
docker compose up -d postgres
```

### Creating the extension on the existing volume

Scripts in `/docker-entrypoint-initdb.d` run **only when the data directory is
empty**. The staging volume already has data, so the SQL file will not execute
there. Run it once by hand:

```bash
docker compose exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
```

Confirm it took:

```bash
docker compose exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_stat_statements;"
```

### Querying it

```sql
-- Slowest by total time. The first question after a load test.
SELECT calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       round((100 * shared_blks_hit::numeric
              / nullif(shared_blks_hit + shared_blks_read, 0)), 1) AS cache_hit_pct,
       left(query, 120) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;

-- Worst single-call latency, which total time hides.
SELECT calls, round(max_exec_time::numeric, 1) AS max_ms, left(query, 120)
FROM pg_stat_statements
ORDER BY max_exec_time DESC
LIMIT 20;
```

Reset the statement statistics at the start of a measurement window, the same
way you reset `/metrics`:

```bash
docker compose exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT pg_stat_statements_reset();'
```

Slow queries and lock waits go to the container log:

```bash
docker compose logs -f postgres | grep -E 'duration:|still waiting for'
```

## What this still does not measure

Honest gaps, so nobody reads a green `/metrics` as a complete picture:

- **Host CPU, host memory, disk I/O.** Outside the process. Use `vmstat`,
  `iostat -x` and `docker stats` alongside a scrape loop. `cpu.majorPageFaults`
  is the in-process hint that the host is under memory pressure, not a
  substitute.
- **Per-container CPU and memory.** `docker stats --no-stream` is the source.
- **Discord gateway latency and rate limiting.** Not yet surfaced. The bot's own
  logs carry it.
- **Client-observed latency.** `/metrics` reports server-side time and excludes
  network and Cloudflare. A load harness must measure its own, and comparing the
  two is how you separate application time from transport.
