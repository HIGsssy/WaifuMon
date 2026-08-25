# Card rendering — deployment and tuning

How to size the card renderer on the machine it actually runs on, and how a card
gets to a player's screen without anyone waiting for it.

The target deployment this is written for is a **Ryzen mini-PC with 16 GB of
RAM**, sharing the box with Postgres, the Discord gateway and the Platform API.
None of the numbers below come from that machine yet; the last section says
exactly what to measure on it before turning anything up.

---

## The three paths to a card

A rendered card reaches a client by one of three routes. The whole warming
design exists to make the third one rare.

| | What happens | Cost |
| --- | --- | --- |
| **Best** | The requested derivative (`@256`/`@512`) is on disk | one file read |
| **Second** | The derivative is missing, the master is cached | one Sharp resize |
| **Worst** | Neither exists | a worker-thread render (~1.2 s), then a resize |

Three things keep the worst case uncommon, and none of them is a startup job:

1. **Warm on capture.** A successful capture already renders her card at 1024,
   which draws the master. A detached follow-up produces `@256` and `@512` off
   that file — two resizes, no rasterizing. The capture reply never waits for it.
2. **Ops warming.** `npm run cards:warm -- --player <id>` / `--all-players`
   covers the back catalogue: everything captured before this existed, and
   anything a cache sweep reclaimed.
3. **Self-healing warm.** Listing a player's collection schedules a bounded,
   deduped background warm of that player's owned cards. It is the *fallback* —
   it catches what the first two missed — and the HTTP response never waits for
   it.

**There is deliberately no global warm at startup.** Warming every player's
collection on boot would turn a restart into a render job proportional to the
player base, on a node that has just come back up and is being asked to serve
Discord.

---

## Settings

| Variable | Default | What it controls |
| --- | --- | --- |
| `CARD_RENDERER_ENABLED` | `false` | Whether `/api/v1/cards/…` is registered at all. |
| `CARD_RENDER_WORKERS` | `2` | Threads that draw cold masters — the ceiling on concurrent cold renders. `0` renders in-process (identical bytes, reinstates the event-loop stall). |
| `CARD_WARM_CONCURRENCY` | `1` | Cards in flight per *background* warm. |
| `CARD_WARM_ON_COLLECTION` | `true` | Whether a collection listing triggers the self-healing warm. |

`cards:warm` has its own `--concurrency` (cards per player) and
`--player-concurrency` (players at once), both defaulting to 1. Those are an
operator running a job; `CARD_WARM_CONCURRENCY` is the live process deciding on
its own, which is why it is capped lower.

---

## Recommendation for the Ryzen / 16 GB node

Start at:

```
CARD_RENDER_WORKERS=1
CARD_WARM_CONCURRENCY=1
CARD_WARM_ON_COLLECTION=true
```

**One worker, not two.** The goal on this node is responsiveness, not render
throughput. Once warming is in place a cold master is an exception, so the
throughput a second thread buys is throughput on work that mostly does not
happen — while the second thread's cost (a second decoded card in flight, a
second core taken from Postgres and the gateway during a burst) is paid on the
machine that is also answering Discord.

Then run the back catalogue once, out of hours:

```
npm run cards:warm -- --all-players
```

and check the report. `masters: 0 rendered` on a second run is the steady state
you want.

### Before moving to 2 workers

Benchmark **the real node**, 1 worker against 2, and compare:

- **Peak RSS** — the number most likely to bite on 16 GB shared with Postgres.
  Each thread holds a full decoded card in flight.
- **Total cold render time** for a representative collection.
- **Event-loop delay** on the main thread during a render burst (mean, p99, max).
- **Discord responsiveness** — slash-command acknowledge latency while the burst
  runs. This is the one players feel.
- **API responsiveness** — p99 on a non-card route during the same burst.
- **CPU saturation** — whether Postgres is being starved.

Move to 2 only if the node stays comfortably responsive on all of them.
**Do not go to 3 or more on this node without those measurements.** The worker
count is never derived from `os.cpus()`, on purpose: the core count describes
the host, not the headroom.

---

## Development-machine benchmark — architecture validation only

Run on a 24-core / 64 GB workstation. **These are not sizing numbers for the
production node**; they are here to show the *shape* of the system, which does
carry over.

A representative 25-card owned collection, tiles requested at `@256` with six
concurrent client connections:

| Phase | first 4 | first 12 | all 25 | Renders | Workers |
| --- | --- | --- | --- | --- | --- |
| **Cold**, 1 worker | 5.03 s | 14.24 s | 29.92 s | 25 master + 25 derivative | 1 alive, peak concurrent 1, peak queued 5 |
| **Cold**, 2 workers | 3.80 s | 10.19 s | 20.90 s | 25 master + 25 derivative | 2 alive, peak concurrent 2, peak queued 4 |
| **Warm** (either) | 0.01 s | 0.01 s | 0.02 s | 0 — 25 cache hits | **never started** |
| **After self-heal** | 0.01 s | 0.01 s | 0.02 s | 0 — 25 cache hits | **never started** |

Event-loop delay stayed at a mean of ~15 ms during cold rendering against a
~5 ms idle baseline, with a max of ~21 ms — the ~750 ms synchronous resvg pass is
on the worker thread, not here. On a fully warm grid the loop sits at the 5 ms
baseline.

Self-heal, with 10 of 25 already warm:

- `schedulePlayerWarm` returned in **0.14 ms** — that is the entire cost the HTTP
  handler pays. The response does not wait.
- The background warm finished the remaining 15 copies in ~20 s.
- The next grid load was 25/25 cache hits with no worker thread started.

Peak main-thread RSS was 193 MB (1 worker) / 218 MB (2 workers), excluding the
worker threads' own heaps — so this is a floor, not the figure to size against.
Measure RSS on the real node.

### What the numbers actually establish

- **Warming removes worker activation entirely.** "Never started" on a fully warm
  grid is the load-bearing result: it means the whole page came off disk and the
  render pool was never involved.
- **The pool bounds concurrency.** 25 cold cards produced 25 queued jobs and
  1 or 2 threads — never 25.
- **The self-heal is genuinely detached.** A sub-millisecond synchronous return,
  with the work finishing long after the response.
- **A second worker roughly halves cold wall time.** True on 24 cores; it is
  precisely the claim that has to be re-measured on 4.

---

## Before enabling collection Card mode by default

Card mode ships **opt-in**, defaulting to Art. Measure these on the production
node before changing that default:

1. **Cold-grid worst case.** With the cache cleared, how long does a 25-tile
   Card-mode grid take on the real node at 1 worker? The dev machine says ~30 s;
   4 slower cores could be 2–3× that, and that is the experience of a player
   whose warm was dropped or whose cache was collected.
2. **Peak RSS during that burst**, alongside Postgres and the gateway. This is
   the 16 GB question.
3. **Discord latency during that burst.** A grid load must not make a slash
   command feel slow.
4. **Self-heal coverage in practice.** After a week, how often does a collection
   request still hit a cold master? Log line `card-renderer/owned-warm` reports
   `mastersRendered` per warm; a healthy steady state is 0.
5. **Cache footprint.** Three files per owned copy (master + `@256` + `@512`).
   Multiply by the real collection sizes and check it against the disk, and
   check `cards:gc` keeps up.
6. **Pre-composed artwork.** Some species artwork is already a finished card, so
   a rendered card of it reads as a card-in-a-card. That is content debt rather
   than a renderer fault, but Card mode is where players would see it — it is
   worth resolving before making Card the default.
