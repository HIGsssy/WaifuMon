# Waifumon Player Portal

A **read-only companion web app** for Waifumon. It shows a player their
collection, buddy, inventory, shop and encyclopedia — and nothing else. Every
action in the game still happens through the Discord bot.

> ⚠️ **Development build only.** The Portal has no authentication, ships the
> Platform API's shared token to the browser, and acts as whichever player an
> environment variable names. There is no production deployment path in v1.
> See [Security posture](#security-posture).

---

## Where it sits

```
   Discord bot  ──┐
                  ├──▶  Game services  ──▶  PostgreSQL
   Player Portal ─┴──▶  Platform API  ──┘
```

- **Game services** are the single authoritative implementation of gameplay.
- **The Platform API** is a thin HTTP adapter over them ([platform-api.md](platform-api.md)).
- **The Portal** is a pure consumer of that API. It has no database access, no
  service imports, and no gameplay logic of its own.

The Portal lives in `portal/` with its own `package.json` and lockfile. Nothing
in the bot depends on it, and deleting the directory has no effect on the bot,
the admin panel, or the API.

---

## Quick start

You need the bot running with the Platform API enabled, and a player who has
played at least once.

**1. Enable the Platform API** in the bot's `.env`:

```sh
PLATFORM_API_ENABLED=true
PLATFORM_API_PORT=3120
PLATFORM_API_TOKEN=<a long random secret>    # openssl rand -hex 32
```

**2. Have a Discord user id to hand.** Turn on Discord's developer mode and use
"Copy User ID" on yourself or a tester, plus "Copy Server ID" on the guild. The
Portal resolves the pair to an internal player id itself.

A player only exists after they have used a `/waifumon` command at least once —
the Portal cannot create one, and neither can the lookup endpoint it uses.

**3. Configure and run the Portal:**

```sh
cd portal
cp .env.example .env.local     # then fill in the token
npm install
npm run assets:thumbs          # once — see Performance; skipping it only costs speed
npm run dev                    # http://127.0.0.1:5173
```

The dev server prints the proxy target and asset directory on startup, so a
misconfigured port is visible immediately:

```
  portal  Platform API proxy -> http://127.0.0.1:3120
  portal  /dev-assets -> C:\…\WaifuMon\assets
```

**4. Sign in.** The first load shows a **Developer login** screen: paste the
Discord user id, confirm the server id, and the Portal calls
`GET /api/v1/players/lookup` to find the internal player. It shows the display
name and player id it resolved before entering. The choice is remembered in the
browser, so every later start goes straight to the Dashboard.

If the pair has never played, the screen says so and stops — it does **not**
create a player. If the API is unreachable or the token is wrong, it says that
instead. It never crashes on a bad configuration.

### Switching between testers

"Switch player" in the header (and on Settings, and on the diagnostics page)
returns to the login screen with the current pair pre-filled. No `.env.local`
edit and no dev-server restart.

**All of this is dev-only.** A production build has no login screen, no player
switcher and no `localStorage` session: it resolves `VITE_DEFAULT_PLAYER_ID`
exactly as it always has, and `npm run verify:bundle` fails if a single string
from the developer-login subtree reaches `dist/`.

---

## Configuration

Every value lives in `portal/.env.local` and is baked into the bundle at build
time. See [`portal/.env.example`](../portal/.env.example) for the annotated
source of truth.

| Variable | Required | Purpose |
|---|---|---|
| `VITE_PLATFORM_API_URL` | – | Base URL for API calls. Keep `/api` in dev; the dev server proxies it. |
| `VITE_PLATFORM_API_PROXY_TARGET` | – | Where the dev server forwards `/api`, `/ready` and `/health`. Default `http://127.0.0.1:3120`. |
| `VITE_PLATFORM_API_TOKEN` | ✅ | Must equal `PLATFORM_API_TOKEN` on the bot side. **Readable by anyone who loads the page.** |
| `VITE_API_TIMEOUT_MS` | – | Request timeout. Default `30000`. See [Performance](#performance). |
| `VITE_DEFAULT_PLAYER_ID` | – | The acting player for a **non-dev** build, as an internal integer id. `npm run dev` ignores it and uses the developer login screen. |
| `VITE_DEFAULT_DISCORD_GUILD_ID` | – | Pre-fills the developer login's server field; also shown on the diagnostics page. |
| `VITE_DEFAULT_DISCORD_USER_ID` | – | Pre-fills the developer login's user field on a browser that has never signed in. |
| `VITE_DEV_ASSETS_PATH` | – | Filesystem path served at `/dev-assets/*`. Defaults to the repo's `assets/`. |
| `VITE_IMAGE_PROVIDERS` | – | Comma-separated image-provider chain. See [Images](#images). |

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at `http://127.0.0.1:5173`, with the API proxy. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint, including the architectural rules below. |
| `npm run test` | Vitest + Testing Library + MSW. No bot required. |
| `npm run build` | Production bundle into `portal/dist/`. |
| `npm run verify:bundle` | Asserts the dev-only diagnostics page and developer login are absent from `dist/`. |
| `npm run assets:thumbs` | Generates the artwork renditions the UI actually displays. Run once after cloning, and again when artwork changes. See [Performance](#performance). |
| `npm run e2e` | Playwright: smoke, responsive audit, accessibility. No bot required. |
| `npm run e2e:ui` | The same, in Playwright's interactive UI. |

`npm run test` and `npm run e2e` both stub the Platform API, so neither needs a
database, a Discord client, or a running bot. CI runs the whole set.

---

## Performance

### The problem this section exists for

Source artwork is ~1500×2100 PNG, averaging **4.2 MB** per file and 216 MB
across the set. A collection grid draws 25 of them at roughly 256 CSS pixels
wide.

That is not just wasteful. In development the Vite server serves `/dev-assets`
**and** proxies `/api` on one HTTP/1.1 origin, where a browser opens about six
connections. Multi-megabyte images take all six; JSON queues behind them. Across
a link with real latency the queue outlives the request timeout, and the Portal
reports a network error for an API that never saw the request and logged
nothing. If you have seen intermittent "can't reach the server" while the
dashboard loads, that was this.

### Renditions

```sh
npm run assets:thumbs        # once after cloning; again when artwork changes
```

Writes `assets/.thumbnails/<width>/…​.webp` at 256, 512 and 1024 px — 10 MB in
total against 219 MB of sources. The directory is generated, gitignored, and
never a source of truth.

Components declare how wide they draw (`<Artwork displayWidth>`, from
`ARTWORK_WIDTH` in `src/images/sizes.ts`) and the resolver picks a bucket,
applying device pixel ratio itself and capping it at 2×. The dev server serves
`/dev-assets/t/<width>/<asset>` from the rendition, **falling back to the
original when one has not been generated** — so the Portal works identically
before and after the script is run, and a forgotten step costs speed rather than
correctness.

| View | Rendition | Was | Now |
|---|---|---|---|
| Collection / encyclopedia grid tile | 512 | 4.2 MB | ~49 KB |
| Detail and buddy heroes | 1024 | 4.2 MB | ~127 KB |
| Appearance strips, related rails | 256 | 4.2 MB | ~18 KB |
| A 25-card collection page | — | ~106 MB | **~1.2 MB** |

Generation happens once, in the script, never per request.

### HTTP caching

Assets are served with `Cache-Control: public, max-age=300, must-revalidate`
plus an `ETag` and `Last-Modified`, and the route answers `304` to
`If-None-Match` / `If-Modified-Since`.

Deliberately **not** `immutable`. These URLs are mutable by design — an artist
replaces `standard.png` in place and expects to see it — and `immutable` is only
correct for a content-addressed URL. Revalidation already gets the win that
matters: a 304 costs one round trip and zero bytes, where the previous headers
(`no-cache` with no validator at all) meant the browser re-downloaded every
image on every navigation.

### Request behaviour

- Lazy artwork is `fetchPriority="low"`, so images yield the connection pool to
  the JSON the page is waiting on. Above-the-fold heroes opt into `priority` and
  get `eager` + `high`.
- Layout is reserved by a CSS aspect-ratio box rather than `width`/`height`
  attributes — the Portal does not know the intrinsic size of source art, and
  the box is what prevents shift either way.
- The species catalogue is prefetched on **idle**, not on dashboard mount. It is
  a large payload no dashboard widget reads.
- Cancelled requests are classified as cancellations, not network failures. React
  Query aborts queries on unmount and on key change, and `<StrictMode>` does it
  once per mount in development.
- Timeouts are not retried. A timeout means the pool was saturated for the whole
  window; a second request joins the same queue. 4xx is not retried either.
  Everything else retries once, with capped and jittered backoff so several
  failing tiles do not wake together.

### Cache policy

Set in `src/api/cachePolicy.ts` and locked by
`src/api/__tests__/cachePolicy.test.ts`.

| Policy | Stale | GC | On focus | On reconnect | Applies to |
|---|---|---|---|---|---|
| `IDENTITY_POLICY` | 2 min | 30 min | no | yes | session resolution (`/players/lookup`, `/players/{id}`) |
| `PLAYER_POLICY` | 45 s | 10 min | yes | yes | profile, collection, buddy, stats, care, inventory |
| `SHOP_POLICY` | 5 min | 30 min | no | yes | shop catalogue |
| `CONTENT_POLICY` | ∞ | 6 h | no | **no** | species, items, tuning tables, quests |

Two of those are load-bearing rather than cosmetic. Content does not refetch on
reconnect, because refetching the whole mounted tree is the worst thing to do to
a link that has just come back. Identity does not refetch on focus, because who
the Portal is acting as changes only when someone changes it — and the
dashboard's `/profile` response writes the player row back into the session's
cache entry, so it stays fresh without a second request.

### Instrumentation (development only)

Console warnings, one line per offender, all stripped from production builds and
asserted absent by `npm run verify:bundle`:

- `[portal slow]` — an API call over 2 s
- `[portal duplicate]` — the same path requested twice within 1.5 s, which is
  how two hooks asking for one resource under different query keys shows up
- `[portal image]` — an image over 400 KB, meaning source art reached the
  browser: either a missing rendition or a call site with no `displayWidth`

`/__dev/diagnostics` adds image bytes transferred and an oversized-image count.

---

## Security posture

This is the part to read before showing the Portal to anyone.

- **There is no authentication.** The developer login screen asks *which* player
  to show; it never verifies that you are them, because it cannot — it is a
  picker, not a sign-in. Anyone who opens the page can type any Discord id and
  read that player's collection. (A non-dev build has not even that: whoever
  opens the page is the player `VITE_DEFAULT_PLAYER_ID` names.)
- **The API token is in the bundle.** `VITE_`-prefixed variables are compiled
  into the JavaScript. Anyone who can load the page can read the token and call
  the Platform API directly with it.
- **Do not expose the dev server.** It binds to `127.0.0.1` by default. Keep it
  there, or on a trusted LAN at most.
- **The Portal cannot change game state.** The Axios client rejects any non-GET
  request before it leaves the process, and a test asserts all four write verbs
  are refused. A leaked token is still a read of that player's data, but it is
  not a way to modify it *through the Portal*.

  The rule is **binary and has no allowlist**, which is the point: "no non-GET
  requests" is greppable and needs no judgment, where "none except these" needs
  a ruling per entry. Cosmetic-looking mutations are exactly what would erode it
  one reasonable step at a time — appearance selection is genuinely cosmetic and
  was still declined here, and favourite and nickname would have followed. They
  live in Discord until authenticated writes exist.
- **A persistent "DEV MODE" marker** sits in the header on every page, and
  Settings restates the caveat in full. This is deliberate: the risk is that
  someone forgets.

None of this is acceptable for a deployment, which is why v1 has no deployment
path. Discord OAuth (below) is the prerequisite.

---

## Architecture

```
portal/src/
  app/          shell, router, providers, theme, query client
  auth/         PortalSession — the single seam session data enters through
  api/          hand-written Axios wrapper, hooks, query keys, cache policy
  images/       the image resolver and its provider chain
  features/     one folder per route; presentation only
  components/   ui/ primitives · layout/ chrome · waifumon/ domain · media/
  content/      client-side sort, filter and grouping helpers
  lib/          formatters, rarity vocabulary, class-name helper
  styles/       design tokens and the base layer
```

### The rules, and what enforces them

| Rule | Enforced by |
|---|---|
| No bot source is imported | ESLint `no-restricted-imports` + a test that scans every source file |
| No write ever reaches the API | The Axios request interceptor throws; tests cover all four verbs |
| No feature renders a raw `<img>` | ESLint `no-restricted-syntax` + a source scan |
| Only `api/client.ts` and `api/system.ts` use Axios directly | A source scan |
| Cache TTLs match the plan | A test asserting the policy constants |
| Background refetches keep previous content | A test that turns a filter and asserts the old grid is still on screen |
| Diagnostics never ship to production | `npm run verify:bundle` plus a Playwright check that the route 404s |

### Adding a page

One folder under `features/`, one route entry in `app/router.tsx`. Nothing else
changes — not `AppShell`, not the session provider.

### State

- **Server state** — TanStack Query. Every read is a query; keys come from
  `api/queryKeys.ts`; player-scoped keys start `['player', playerId, …]` so a
  future player switcher can invalidate one subtree.
- **Session** — React context, from `auth/`.
- **Theme** — React context, persisted to `localStorage`.
- **Filters** — the URL. `useSearchParams` *is* the state; there is no store.

### Loading and caching

Content endpoints are effectively static (`staleTime: Infinity`); the shop is
five minutes; everything player-scoped is thirty seconds and refetches when the
window regains focus, so alt-tabbing back from Discord catches you up.

Skeletons appear only on a cold load. A page turn or filter change keeps the
previous content on screen with a quiet "Refreshing…" indicator. There are no
spinners anywhere, and a test sweep over every page enforces that.

---

## Images

Pages never touch a URL or a filesystem path. They name a *logical* asset and
the resolver answers:

```ts
<Artwork asset={speciesAsset(species, waifu)} name={species.name} />
```

Providers are tried in order; the first non-null answer wins:

1. **`apiSuppliedUrl`** — honours an absolute `https:` URL the API itself
   returned. Today that is only the player avatar.
2. **`cardApi`** — resolves rendered cards through the authenticated
   `/api/v1/cards/...` routes.
3. **`artworkApi`** — resolves species base artwork through
   `/api/v1/assets/waifumon/<slug>` and owned-copy artwork through the
   ownership-checked `/api/v1/players/<playerId>/collection/owned/<waifuId>/artwork`
   route. Both use the same `/api` proxy as JSON and rendered cards.
4. **`localDevAssets`** — derives `/dev-assets/waifumon/<slug>/<variant>.png`,
   served by the dev server from the repo's `assets/` directory. Dev only.
5. **`silhouette`** — an inline SVG portrait, deterministic per slug. Never
   fails, so `resolveAsset` is total and no page has a "no image" branch.

`platformCdn` also exists but is **not in the default chain**: it is the
migration path written out in advance. Set `VITE_ASSET_CDN_URL` and list
`platformCdn` in `VITE_IMAGE_PROVIDERS` to move artwork off local assets. It
declines every id until an origin is configured, so it is inert otherwise.

### `assetId` from the API drops straight in

The Platform API identifies artwork with `{ kind, slug, variant }` and never a
path or URL (see [the assetId contract](platform-api.md#artwork-the-assetid-contract)).
That shape is structurally identical to the Portal's own `AssetId`, so a
response field needs no adapter:

```ts
<Artwork asset={appearanceAsset(appearance)} name={species.name} />
```

`AssetKind` accepts both the API's `'waifumon'` and the Portal's older
`'species'`; they name the same artwork and resolve identically.

Alt text is generated at the resolver from the resource, never from the URL.
A URL that 404s at runtime degrades to the silhouette without breaking layout.

### Swapping the source

Migrating to a Platform API image endpoint, a CDN, or object storage is a new
entry in `FACTORIES` and a default-order change in `images/provider.ts`. **No
page or component is touched, and no API contract changes.** That is the entire
point of the layer.

---

## Appearances

`/collection/:waifuId` carries an **appearance gallery** — every look the
species has, with the one she is wearing highlighted.

Three rules the components enforce, each worth preserving through a refactor:

1. **Locked entries are shown, with their requirement.** "Owned", "Reach Level
   20". A gallery that hid them would be a picker; showing them makes it a
   progression journal, which is the feature.
2. **Locked artwork stays a silhouette until asked for.** Tapping a locked tile
   opens its detail panel with a *Reveal artwork* control — opt-in, so players
   who want the surprise keep it.
3. **The Portal never computes unlock state.** `isUnlocked` always comes from
   the API. That is what keeps Discord and the Portal from ever disagreeing
   about what a player has earned, and why a new unlock source needs no Portal
   change at all.

Cosmetic rarity is rendered as a dotted accent chip, deliberately unlike
`RarityBadge`'s solid rarity-palette pill: a Rare species wearing a Seasonal
look must read as two independent facts.

### Selection lives in Discord

The gallery is **read-only**. The Platform API does expose
`PUT …/collection/owned/{id}/appearance`, but the Portal deliberately does not
call it: v1 is browse-only, and more to the point the Portal has no
authenticated identity — its actor is whoever opened the page. Writing on behalf
of that identity is a pattern the Discord OAuth milestone has to revisit
anyway, so building it now would mean building it twice.

Players change looks with `/wm appearance <name>` in Discord, or from the
`🎀 Appearance` button on the inspect card. An unlocked-but-unworn tile names
that command rather than offering a button the API client would refuse to send.

Portal-side selection is the natural first feature to add once authenticated
writes land — the endpoint, the schema and the gallery are all already in
place; only the mutation hook is missing.

### Known limitation

Species artwork is currently multi-megabyte PNGs served straight from disk —
around 4 MB per image, 216 MB across the set. Lazy loading and the 25-per-page
cap keep this tolerable in development, but it is the Portal's largest
performance debt. The fix belongs on the API (resized WebP variants), not in the
client, and is tracked under [API feedback](#api-feedback).

---

## Testing

| Layer | Tool | Covers |
|---|---|---|
| Component + page | Vitest, Testing Library, MSW | Every page's loading, success, empty and error states |
| Architecture | Vitest source scans | The boundary rules in the table above |
| Accessibility | axe-core in jsdom | WCAG 2 A/AA on every route |
| Accessibility (real browser) | Playwright + axe-core | The same rules **with colour contrast**, in both themes |
| Responsive | Playwright | No horizontal overflow at 375/640/768/1024/1440; touch targets; grid columns |
| End to end | Playwright | Startup → dashboard → collection → detail → back, against a production build |

Colour contrast is checked only in Playwright: jsdom has no computed colour, so
asserting it there would be theatre. The palette's quietest tokens were set by
measurement against those runs, not by eye.

---

## Developer diagnostics

`/__dev/diagnostics` reports the environment, the API base URL and `/ready`
probe, the resolved session, query-cache contents, a ring buffer of recent HTTP
calls with timings, the last decoded API error, and the image resolver's
fallback rate.

It is **registered only when `import.meta.env.DEV`**, and the module is
dynamically imported inside that branch, so Vite eliminates the whole subtree
from a production build. `npm run verify:bundle` greps `dist/` for its markers
and fails if any survive; a Playwright test additionally confirms the route
404s in a built bundle. The bearer token is never rendered.

Reachable from a footer link that exists only in dev builds, or by direct URL.

---

## Future work

### Discord OAuth (replaces dev auth)

Every page reads `session.playerId` from a `PortalSession`, and nothing else.
Replacing the provider is the whole migration:

```
Discord OAuth  →  Portal-owned callback (new BFF)
               →  GET /api/v1/players/lookup   (unchanged)
               →  httpOnly session cookie
               →  OAuthSessionProvider emits the same PortalSession
```

`app/providers.tsx` imports the provider under an alias for exactly this reason
— the swap is one line there, and no feature page changes.

The dev login already exercises the identity half of that path: it calls the
same `/players/lookup` with the same `(guild, user)` pair and emits the same
`PortalSession`. What OAuth adds is *proof* that the pair is yours, plus the
cookie and callback to carry it. The seam is not speculative — it is in use.

### API feedback

The Portal is the Platform API's first substantial consumer, and everything it
could not do cleanly is recorded rather than worked around. These are candidates
for a **Platform API Presentation Enhancements** milestone after the Portal MVP:

| Gap | Impact today |
|---|---|
| **Resized image variants** | Worked around locally by `npm run assets:thumbs`; the API still exposes only one size, so every consumer needs its own pipeline |
| Item artwork | Items carry an emoji and no image path; the Portal renders the emoji |
| Trainer level progression | `player` has `level` and `xp` but no `xpIntoLevel`/`xpToNext`, so the Dashboard shows a total instead of a bar |
| Lifetime capture total | `owned` counts active copies only; the Profile says so rather than implying otherwise |
| Dex slug set | The encyclopedia walks the whole collection once per session to build its ownership overlay |
| Server-side collection filters | Only `rarity` is server-side; the rest narrows the current page, and the UI says so |
| Capture history | The detail page reserves a card and states the gap |
| Hunt energy cost | Absent from tuning, so the Guide can say hunting costs energy but not how much |
| Inventory capacity | No player-scoped current/max, so the capacity chip is omitted |
| Discord guild snowflake | The player resource carries only the internal guild id |
| `/health` and `/ready` outside `/api/v1` | Needs a second proxy rule, and will need its own CORS entry |
| CORS allow-list | The dev proxy sidesteps it; a deployed Portal needs one |

The rule throughout: **a gap is shown as a placeholder and filed, never
approximated in the client.** Recomputing an XP curve or a capture rate in React
would put a second implementation of a game rule in the codebase, which is what
the whole architecture exists to prevent.

### Artwork hosting

The local pipeline solves the bandwidth problem and leaves one structural issue
untouched: **artwork and the API share an origin.** In development that is the
Vite server for both; in any deployment it would be whatever fronts them. On
HTTP/1.1 that means images and JSON compete for the same six connections, and no
amount of shrinking images removes the coupling — it only raises the number of
images needed to trigger it.

Three ways out, cheapest first. None is needed today, and none should be adopted
without a measurement showing the current setup is the bottleneck:

1. **HTTP/2 on whatever serves the Portal.** Multiplexing removes the
   six-connection cap outright, which is the actual constraint. This is a
   server-configuration change and nothing else — no code moves.
2. **A second origin for assets.** Its own connection budget, and a natural
   place to set long-lived caching. Costs a CORS entry and a DNS name.
3. **A CDN or object store.** `src/images/providers/platformCdn.ts` already
   exists for this: set `VITE_ASSET_CDN_URL`, put `platformCdn` ahead of
   `artworkApi` in `VITE_IMAGE_PROVIDERS`, and publish renditions at
   `<origin>/<slug>/<variant>@<width>.webp`. No API response, route, page or
   component changes — the size buckets are already in the URL contract.

The authenticated artwork routes make base artwork deployment-safe today and
prefer generated WebP thumbnails when available. A future CDN can replace that
transport by moving `platformCdn` ahead of `artworkApi`; the Portal's logical
asset contract does not change.

### Also deferred

Generated OpenAPI types, composite dashboard endpoint, live notifications,
gameplay mutations, and production deployment. None require a v1 redesign to
adopt. (The runtime player switcher landed as the dev-only developer login
above; a *production* switcher is a consequence of OAuth, not a feature of its
own.)

---

## Troubleshooting

**"This Discord account hasn't played here yet."** The lookup found nobody for
that `(server, user)` pair. Either the id is wrong, or the account has genuinely
never run a `/waifumon` command in that server. The Portal will not create a
player — play once in Discord first.

**The developer login screen on every start.** The choice is kept in
`localStorage` under `waifumon-portal:dev-identity`. A private window, a cleared
site data, or a sign-in that never resolved will all start signed out. Only a
successful resolution is persisted.

**"Can't reach the Waifumon server."** The bot is not running, or
`PLATFORM_API_ENABLED` is not `true`, or `VITE_PLATFORM_API_PROXY_TARGET` points
at the wrong port. The dev server logs its target on startup. This message now
means *unreachable* specifically — a slow server says something else.

**"The Waifumon server took too long to answer."** The API is reachable and did
not finish in time. If it happens while the dashboard is loading artwork, the
cause is almost certainly image traffic occupying the connection pool: run
`npm run assets:thumbs` and check `/__dev/diagnostics` for an oversized-image
count above zero. Raising `VITE_API_TIMEOUT_MS` hides that rather than fixing
it. See [Performance](#performance).

**"The Platform API rejected the token."** `VITE_PLATFORM_API_TOKEN` and
`PLATFORM_API_TOKEN` differ. They must match exactly.

**Everything is a silhouette.** The dev server could not find the assets
directory. Check the `/dev-assets` line in the startup log, or set
`VITE_DEV_ASSETS_PATH`. `/__dev/diagnostics` reports the resolver's fallback rate.

**The trainer name shows as `Trainer #1`.** The API returned no `identity` —
either the bot predates that field, or the Discord gateway could not resolve the
user. The Portal falls back rather than inventing a name.
