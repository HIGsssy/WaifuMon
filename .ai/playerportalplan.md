# Plan: Waifumon Player Portal v1 (Development Edition)

## TL;DR

Build the **Waifumon Player Portal** as a standalone **Vite + React + TypeScript SPA** in a sibling `portal/` directory, deployed only for local development in v1, consuming the **Platform API exclusively**. Version 1 is intentionally lightweight and prioritises **fast development, architectural simplicity, and a premium companion-app feel** over completeness. The API client is a **small hand-written Axios wrapper** with per-resource helpers (`getPlayerProfile`, `getCollection`, …) — codegen from OpenAPI is deferred until the API surface stabilises. Development authentication is **a single environment variable** (`VITE_DEFAULT_PLAYER_ID`) resolved through a thin `PortalSession` abstraction; runtime player switching is a future enhancement. Routing is **React Router v7** with a shell layout; state is **TanStack Query** for server state and **React Context** for the session; styling is **Tailwind CSS + shadcn/ui**, dark by default. The Portal ships in **four phases** built around visible milestones — **Phase 1 delivers Dashboard + Collection**, so the Portal feels like a real companion app on day one. Images route through a **centralised image resolver** so the physical asset source is swappable without page changes. The Portal never duplicates gameplay logic; every gap becomes an **API feedback-loop signal** and is filed as a future Platform API enhancement.

---

## 1. Overall Architecture

```
                Browser (dev laptop / phone on LAN)
                             │
                             ▼
                ┌────────────────────────────┐
                │   Player Portal            │
                │   Vite dev server :5173    │
                │   React SPA (TypeScript)   │
                │   ┌──────────────────────┐ │
                │   │ SessionProvider      │ │  ← swappable auth layer
                │   ├──────────────────────┤ │
                │   │ api service (Axios)  │ │  ← thin hand-written wrapper
                │   ├──────────────────────┤ │
                │   │ TanStack Query cache │ │
                │   ├──────────────────────┤ │
                │   │ Image resolver       │ │  ← centralised, swappable
                │   ├──────────────────────┤ │
                │   │ Feature routes       │ │
                │   └──────────────────────┘ │
                └──────────────┬─────────────┘
                     HTTP / JSON (Bearer)
                               │
                               ▼
                ┌────────────────────────────┐
                │   Platform API             │
                │   Fastify :3120            │  ← unchanged surface
                │   /api/v1/…                │
                └──────────────┬─────────────┘
                               ▼
                        Game Services
                               ▼
                          PostgreSQL
```

**Two processes on the dev machine:**
- The existing bot process (Discord client + Platform API + admin panel) — unchanged.
- The new Portal dev server. Runs `npm run dev` in `portal/`, serves the SPA at `http://127.0.0.1:5173`, proxies `/api/*` to the Platform API to sidestep CORS during development. No production deployment in v1.

**Directory layout (repo root):**
- Existing repo untouched: `src/`, `assets/`, `docs/`, `drizzle/`, `content/`, `tests/`.
- New sibling `portal/` with its own `package.json`, `tsconfig.json`, `vite.config.ts`. Promoting to `apps/bot` + `apps/portal` later is a mechanical move if a monorepo is ever wanted.

**Architectural principles (kept front-and-centre):**
- The Portal is a **pure consumer** of the Platform API. Zero database imports, zero service imports, zero shared code reaching into `src/modules`.
- The Platform API is a **pure consumer** of the game services.
- Game services remain the **single authoritative implementation** of gameplay.
- No gameplay logic in the Portal. If a page needs a computed value the API doesn't provide, that computation belongs on the API side, not in a React hook (§14 API Feedback Loop).
- **Simplicity beats future-proofing.** Anything the Portal doesn't need on day one is deferred to §25.

---

## 2. Portal Design Philosophy

The Player Portal is a **premium companion application for a collectible game**. Its job is not to administer accounts or expose gameplay controls — its job is to make players want to open the app, admire their collection, and feel connected to the game even when they are not actively playing.

**Guiding principles (the reference every design decision is checked against):**

- **Artwork is the primary visual focus.** Every card, hero, tile, and thumbnail exists to make the key art breathe. Chrome is the frame, not the picture.
- **Collection browsing should be enjoyable in its own right.** Flipping through the collection is the core activity of the Portal — treated with the polish of a collectible-game companion, not the density of a control panel.
- **Presentation before density.** Information density is a secondary concern. If the choice is between showing one more datum and giving the artwork room to breathe, the artwork wins.
- **Modern, spacious, polished.** Generous padding, quiet chrome, deliberate typography. Nothing on the page competes with the art for attention.
- **Dark mode emphasises the artwork.** The default palette is deep neutral (near-black backgrounds, subtle warm tint) so key art reads as illuminated. Rarity is the accent language; there are no bright primary buttons.
- **Navigation is simple and intuitive.** Flat top-level entries (§9 Site Map). No hidden menus, no clever gestures, no context-dependent chrome.
- **Mobile-first.** Every layout is designed at 375px first and expanded to desktop. Touch targets ≥ 44px. Card hover states have equivalent focus states.

**Reference points:** Pokémon HOME, Steam library, Battle.net collections, Riot Universe. Art-forward tiles, dark quiet chrome, room for lore.

**What the Portal is *not*:** the admin panel (utilitarian by design), a dev dashboard (metrics belong under the Guide's narrative framing, not on the surface), or a spreadsheet.

The tactical execution of these principles — palette, typography, motion, rarity colours — is documented in §17 Visual Design Philosophy.

---

## 3. Project Goals

1. Give a signed-in player a **fast, responsive, artwork-forward web companion** for browsing their account, collection, buddy, inventory, shop catalogue, encyclopedia, and progression — read-only.
2. **Prove the Platform API's external-client contract** by consuming only public HTTP endpoints. Any friction becomes API feedback (§14), not a client workaround.
3. Establish a **long-lived front-end foundation** — Vite + React + TypeScript + TanStack Query + React Router + Tailwind — that survives the addition of OAuth, gameplay mutations, notifications, and a mobile target without a rewrite.
4. **Isolate the dev-auth layer** behind a `PortalSession` interface so replacing it with Discord OAuth is a component swap, not a redesign.
5. **Zero disruption** to the Discord bot, admin panel, and Platform API. The bot behaves bit-identically before and after the Portal ships.
6. **Deliver a visible, enjoyable experience early.** Phase 1 alone (Dashboard + Collection) should already feel like a real companion app.
7. Ship a **thin, well-scoped v1** — no mutations, no gameplay, no admin features, no premature optimisation.

---

## 4. Explicit Non-Goals

- ❌ **No production deployment.** Local dev + LAN only. No TLS, no CDN, no public URL, no rate limiting.
- ❌ **No Discord OAuth in v1.** Dev auth is a placeholder with a documented replacement path.
- ❌ **No runtime player switcher in v1.** Selecting a player is an env-var change and a reload.
- ❌ **No OpenAPI code generation in v1.** A hand-written Axios wrapper is enough while the API is still evolving.
- ❌ **No new Platform API endpoints as a prerequisite to shipping v1.** The Portal uses what exists today; missing data is filed via §14.
- ❌ **No gameplay mutations.** No hunt, capture, care controls, daily claim, shop purchase, item use, buddy change, favorite toggle, nickname edit, release, evolution, quest interaction — the app is browse-only. Buttons that would mutate simply do not exist.
- ❌ **No admin functionality.** Content editing stays in the admin panel.
- ❌ **No SSR / Next.js.** The Portal is a pure SPA.
- ❌ **No BFF, no Portal-owned backend.** Direct talk to the Platform API.
- ❌ **No mobile app, no PWA, no push notifications, no offline mode.** Responsive design only.
- ❌ **No leaderboards, no social features, no public player profiles.** Not modeled in the API today.
- ❌ **No duplicated gameplay logic.** Missing derived values are either fetched or shown as placeholders.
- ❌ **No new Discord bot code.**

---

## 5. Technology Recommendations

| Concern | Choice | Rationale |
|---|---|---|
| Framework | **Vite + React 19 + TypeScript** SPA | Pure client-side app against an existing REST API. Vite gives instant HMR, tiny config, no accidental temptation to reach into `src/`. Not Next.js — SSR / RSC value proposition doesn't apply here and would blur the "external client" boundary. |
| Routing | **React Router v7** (data mode) | Mature, deep-linkable, nested layouts. |
| Server state | **TanStack Query v5** | Best-in-class for a read-only API consumer: caching, retries, request de-duplication, background refetch, `isLoading` / `isError` / `isFetching` primitives mapping 1:1 onto the required loading/empty/error states. Underpins §18 Cache Philosophy and §19 Loading Philosophy. |
| UI state | **React Context** for session and theme; **component-local `useState`** for everything else | Two contexts is enough. No Redux, Zustand, or Jotai in v1. |
| **API client** | **Hand-written Axios wrapper** in `portal/src/api/` exposing per-resource helpers (`getPlayerProfile()`, `getCollection()`, `getBuddy()`, `getInventory()`, `getShop()`, `getSpecies()`, …). Response types are **narrow TypeScript interfaces authored by hand** for the fields each page actually reads. | Fastest to build while the API is still evolving. No codegen step, no OpenAPI download, no CI regeneration job. When the API stabilises, swap to generated types with no route changes — documented in §25. |
| Component primitives | **shadcn/ui** (Radix under the hood) | Copy-in components, no runtime bloat, accessible by default. |
| Styling | **Tailwind CSS v4** with a small design-token file | Utility-first, dark mode via `class` strategy, fast iteration. |
| Icons | **lucide-react** | Ships with shadcn/ui; consistent stroke width. |
| Forms | Not really needed in v1 (read-only, no login form) | Any small input uses controlled state. |
| Build tooling | **Vite** + `@vitejs/plugin-react-swc`, ESLint + Prettier | |
| Testing | **Vitest + @testing-library/react** for components; **MSW** to mock the Platform API in tests; a lightweight Playwright smoke test in Phase 3. | Phase 1 tests are pragmatic — full coverage lands in Phase 3 alongside polish. |
| Package manager | Whatever the root repo uses (npm). Portal keeps its own lockfile. | |

**New dependencies (all in `portal/`):** `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `axios`, `tailwindcss` + `@tailwindcss/vite`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`. **Dev-only:** `msw`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@playwright/test` (added in Phase 3).

---

## 6. Development Authentication Strategy

### The `PortalSession` contract (the load-bearing abstraction)

Every screen in the Portal reads the current session from a single React context. The shape does not change between the dev provider and a future OAuth provider:

```
interface PortalSession {
  playerId: string;               // internal id used in all /players/:playerId endpoints
  guildDbId: string;              // resolved once at session start
  displayName: string;            // for the header/avatar
  discordUserId?: string;         // populated when known; presentation only
  discordGuildId?: string;        // populated when known; presentation only
}
```

**Rule:** no page component reads `discordUserId` for anything other than display, and no page component knows or cares whether the session came from dev auth or OAuth. When a page needs the current player id, it reads `session.playerId`. That is the single seam.

### The v1 implementation: `DevSessionProvider`

Radically simple:

1. On startup, read `VITE_DEFAULT_PLAYER_ID` from the Vite env.
2. Resolve it via `GET /api/v1/players/{id}` and populate the session context.
3. Missing / unresolved → render a small `/select-player` fallback that shows the current env value, the resolution error, and instructions ("Set `VITE_DEFAULT_PLAYER_ID` in `portal/.env.local` and reload").

That is the entire dev-auth surface. **No login form, no localStorage, no cookies, no runtime switcher UI, no in-memory picker.** Changing the acting player is a `.env.local` edit + reload.

A tiny **"DEV MODE — no authentication"** banner sits in the header the whole time so the setup is never confused with production.

### Why this is enough for v1

- Zero server-side work — no new API endpoint, no session store.
- Zero login friction on every reload.
- Fully covers the requirements brief: env-var default is the recommended path; internal-id entry, Discord-id entry, and list selection are all deferred to §25 alongside the runtime switcher.
- The `PortalSession` shape does not change when OAuth arrives — only the *provider* does.

### Future OAuth Migration Strategy

When v2 arrives, replace `DevSessionProvider` with `OAuthSessionProvider`:

```
Future flow:
  Discord OAuth (authorize URL)
      ↓ code
  Portal-owned callback endpoint (new BFF)
      ↓ Discord user id + guild id
  GET /api/v1/players/lookup  (unchanged)
      ↓ internal playerId
  Portal sets httpOnly session cookie
      ↓
  OAuthSessionProvider reads the session via /portal/session
      ↓
  Emits the same PortalSession shape
```

**No page component changes.** Every player-scoped page already reads `session.playerId`. The Axios wrapper already attaches a bearer token — v2 changes where the token comes from, not how it's attached.

---

## 7. Site Map

Route tree (nested layouts noted):

```
<AppShell>                                     shared layout: header, primary nav, footer
  <RequireSession>                             gate: shows /select-player when no session resolves
    /                          → redirect to /dashboard
    /dashboard                                 the home page and visual anchor
    /collection                                paginated + filterable list (flagship)
    /collection/:waifuId                       owned waifumon detail
    /buddy                                     current buddy (or empty state)
    /inventory                                 grouped by category
    /shop                                      catalogue (read-only)
    /encyclopedia                              species list (owned/undiscovered overlay)
    /encyclopedia/:slug                        species detail (works even if unowned)
    /profile                                   trainer profile page
    /guide                                     Game Guide (player-facing, was "Game Info")
    /achievements                              Coming Soon placeholder
    /events                                    Coming Soon placeholder
    /friends                                   Coming Soon placeholder
    /settings                                  Coming Soon placeholder (theme + about content)
    /__dev/diagnostics                         Developer Diagnostics — dev builds only (§29)
  </RequireSession>
  /select-player                               dev-only fallback screen
  *                                            404
</AppShell>
```

**Primary navigation** (visible in the sidebar / mobile drawer, in order):

1. Dashboard
2. Collection
3. Buddy
4. Inventory
5. Shop
6. Encyclopedia
7. Guide
8. Profile
9. — divider —
10. Achievements *(disabled, "Coming Soon" chip)*
11. Events *(disabled, "Coming Soon" chip)*
12. Friends *(disabled, "Coming Soon" chip)*
13. Settings *(enabled; small theme + about page in Phase 3)*

The "Coming Soon" entries are rendered but non-interactive. They exist to reserve visual space now so the sidebar doesn't have to be redesigned when those features land.

`/__dev/diagnostics` is a hidden dev-only route (§29). It is registered only when `import.meta.env.DEV` is true and is never linked from the primary navigation.

**Rules:**
- Every route below `<RequireSession>` reads `session.playerId` — never a URL param.
- Every URL is deep-linkable and shareable within the dev context.
- Filter state on `/collection` lives in the URL (`?rarity=SR&archetype=kitsune&page=2`) so back/forward is honest.
- `/encyclopedia/:slug` serves both the encyclopedia entry and the "view species" link on an owned waifumon detail.

---

## 8. Page Designs

Each page is described as: **data sources**, **layout**, **empty state**, **error/loading state**, and **known gaps**. The Dashboard and Collection lead because they carry the Portal's visual identity and ship in Phase 1.

### 8.1 Dashboard (`/dashboard`) — landing page and visual anchor

The Dashboard is the Portal's **first impression**. It establishes the visual identity described in §17: art-forward, dark, spacious, understated chrome. When a developer or player opens the Portal, this page tells them what the Portal *is*.

**Data sources** (fetched in parallel, cached in TanStack Query):
- `GET /api/v1/players/{playerId}/profile` — player, currencies, XP, level.
- `GET /api/v1/players/{playerId}/collection/buddy` — active buddy (or `null`).
- `GET /api/v1/players/{playerId}/collection/stats` — dex progress numbers.

**Layout (mobile-first):**
- **Hero row.** Trainer identity block (avatar, display name, level pill, XP-to-next progress bar) and the **Active Buddy card** — a large art panel with the buddy's key art dominating, name / level / affection layered over a subtle gradient. On desktop, buddy art sits alongside the trainer block; on mobile, buddy sits above and stacks. If no buddy is set, a soft silhouette + "Set a Buddy in Discord" prompt.
- **Currency + Energy row.** Three tiles — Energy, WaifuBux, Essence — with big tabular numerics, iconography that mirrors the Discord game's rarity language. Energy tile shows the current value only (no regen countdown; that would be gameplay logic).
- **Collection progress card.** A large dex-progress ring: "23 owned · 18 / 58 species". Link → `/collection`.
- **Quick-launch strip.** Compact tiles: Collection · Buddy · Inventory · Shop · Encyclopedia · Guide · Profile. Each tile has an icon, a label, and a one-line current stat ("58 caught", "12 items", etc.). Feels curated, not utilitarian.

**Empty state:** newly-provisioned player renders with sensible zeros. No scary "nothing here" screens; the layout looks intentional even when empty.
**Loading state:** the hero art skeleton uses the same footprint as the buddy art so nothing shifts on load. Currency tiles use tabular skeletons. Background refreshes never blank the page (§19 Loading Philosophy).
**Error state:** any failing card shows an inline compact error with retry — the rest of the page renders normally (TanStack Query per-tile `isError`).

**Known gaps:**
- Daily / quest status tiles are omitted from v1 to keep the Dashboard visually clean and to avoid taking a dependency on services the Guide can present better. They'll return once the "Recent Captures" and Daily composite data are exposed via §25.

---

### 8.2 Collection (`/collection`) — the flagship feature

The Collection is the Portal's centrepiece. It should feel like flipping through a premium collector's binder — **not a spreadsheet**. Large artwork, strong rarity presentation, generous spacing, smooth transitions. The design bar is Pokémon HOME, Steam library, Battle.net collections — not an admin table.

**Data sources:**
- `GET /api/v1/players/{playerId}/collection/owned?page=&pageSize=&rarity=` — the paginated list (`pageSize` capped at 25 by the service, honestly presented as ~25 large cards per page).
- Optional secondary: `GET /api/v1/content/species` (memoized indefinitely per §18) for enrichment.

**Filter model (URL-backed):**
- `search` — client-side substring match on nickname + species name.
- `rarity` — passed to the API filter (server-side).
- `type` (archetype) — client-side chip filter.
- `affinity` — client-side chip filter.
- `ownership` — all / favorites / buddy — client-side.
- `sort` — rarity-desc + name (default), name, level, caught date.

**Why client-side filtering:** the collection endpoint only accepts `rarity` today. Filtering 25 rows in-memory is honest and adds zero gameplay logic. Expanded server-side filters are filed with §14 API Feedback Loop.

**Layout:**
- **Toolbar** at the top: search input on the left, filter chips inline (rarity / type / affinity / ownership), sort selector on the right. Filters use the shadcn/ui popover on mobile. The toolbar is sticky as the grid scrolls.
- **Card grid** — 2 columns on phone, 3 on tablet, 4 on desktop, 5 on wide. Each card:
  - **Large key art** filling the top ~70% of the card, no rounded corners cropped, subtle inner shadow. Art loads through the image resolver (§13) with lazy `loading="lazy"` for off-screen tiles.
  - **Rarity glow ring** on the card border colour-coded per rarity (N slate, R blue, SR purple, SSR gold, UR crimson, LR iridescent gradient) — matches Discord embed colours.
  - Bottom panel with name (or nickname with species subtitle), level pill, small favorite/buddy badges, quiet caption.
  - Hover / focus lifts the card 4px with a soft ambient shadow. Motion respects `prefers-reduced-motion`.
- **Detail transition.** Clicking a card animates the card art into the hero of `/collection/:waifuId` via View Transitions API where supported; graceful fallback everywhere else.
- **Pagination** at the bottom: prev / page N of M / next. No infinite scroll in v1 (harder to test, doesn't add value at 25/page).

**Empty state:** "Your collection is empty. Head to Discord and try `/waifumon hunt`." — full-panel illustration, not a bare grid.
**Loading state:** skeleton cards with the exact final footprint; the rarity glow ring appears immediately so the page reads as "Collection" even during load. Background refreshes keep the previous grid visible (§19).
**Error state:** inline retry banner above the grid.

**Known gaps (§14 candidates):**
- "Personality" filter from the brief has no matching content field today. Filter absent in v1.
- "Spirit Type" is a synonym for the current `archetype` field; the UI label is "Type".
- Server-side filtering beyond rarity is a future API enhancement.

---

### 8.3 Waifumon Details (`/collection/:waifuId`)

**Data sources:**
- `GET /api/v1/players/{playerId}/collection/owned/{waifuId}` — owned entry with embedded species row.
- `GET /api/v1/content/species/{slug}` — canonical species content (description, tags, image path).

**Layout:**
- **Hero panel** — full-bleed key art on desktop (max 60vh), rarity glow ring following the same language as the collection card. On mobile, art stacks above a summary card.
- **Identity card** — name (or nickname with species subtitle), rarity badge, type pill, affinity pill, buddy/favorite indicators.
- **Progression card** — level + XP bar, affection meter, "Caught [relative date]" caption.
- **Capture information card** — v1 shows only `caught_at`; the fuller history is a placeholder ("Capture history coming soon"). Backed by a future endpoint filed in §14 / §25.
- **Stats card** — placeholder ("No stats yet — combat is not modelled"), not fabricated.
- **Evolution placeholder** — static "Evolution coming soon" tile.
- **Related species** — up to 4 same-archetype neighbours from the cached content list. Purely presentational.
- **Actions** — view species in encyclopedia link. No release / rename / buddy-set buttons.

**Empty state:** unknown `waifuId` for this player → 404 page with a link back to `/collection`.
**Error state:** inline banner; 404 renders the not-found page.

**Known gaps** (all §14 / §25 candidates):
- Capture history endpoint.
- Waifu combat stats (content-model decision).
- Evolution model (content-model decision).
- Structured related-species field.

---

### 8.4 Buddy (`/buddy`)

**Data sources:**
- `GET /api/v1/players/{playerId}/collection/buddy` — the buddy (may be `null`).
- `GET /api/v1/players/{playerId}/care` — care state.

**Layout:**
- Same hero + progression cards as the Waifumon Details page.
- **Care card** replaces the Stats card: shows whether care mode is active and which waifu it targets. Read-only display of the current care endpoint response.
- No "Enter Care" / "Exit Care" / "Change Target" buttons.

**Empty state (no buddy set):** friendly card with a silhouette illustration and "Set a Buddy from Discord." No button — the game happens in Discord.
**Loading state:** big skeleton for the hero.

**Known gaps:** none blocking.

---

### 8.5 Inventory (`/inventory`)

**Data sources:**
- `GET /api/v1/players/{playerId}/inventory` — items and quantities (embeds the item row).

**Layout:**
- Grouped by `category` (capture / material / cosmetic / consumable).
- Each row: item art thumbnail through the image resolver (§13), name, description, capture modifier badge, quantity chip, "Not for sale" badge on non-purchasable items.
- Capacity chip at the top if `content/tables/inventory` exposes a cap; otherwise omitted.
- No "Use Item" button.

**Empty state:** "Your inventory is empty. Claim your daily on Discord."

**Known gaps:** items artwork resolution today falls back to local dev assets (§13); a first-party image endpoint on the API is filed at §14 / §25.

---

### 8.6 Shop (`/shop`)

**Data sources:**
- `GET /api/v1/shop/catalog` — the current catalogue.

**Layout:**
- Grid of shop tiles: item art, name, description, price chip in the correct currency (WaifuBux / Essence), availability badge.
- Disabled and unpurchasable items rendered greyed with a "Not currently available" ribbon.
- No purchase button. Small footer note: "Purchase from Discord: `/waifumon shop`."

**Empty state:** "The shop is currently closed." (rare).

**Known gaps:** none.

---

### 8.7 Species Encyclopedia (`/encyclopedia`, `/encyclopedia/:slug`)

**Data sources:**
- `GET /api/v1/content/species` — full snapshot; memoized indefinitely per §18.
- `GET /api/v1/players/{playerId}/collection/stats` — for ownership overlay.
- Ownership per-slug in v1 is derived once from `/collection/owned` (paged through and cached for the session). A dedicated dex-slugs endpoint is filed in §14 / §25.

**Layout (`/encyclopedia`):**
- Filter toolbar: search, rarity, type, affinity, discovered / undiscovered toggle.
- Grid of species cards. **Undiscovered** species render as silhouetted art with `???` name, rarity badge visible, description hidden.
- Ownership indicator: "Owned ×N" chip on discovered species.
- Click → `/encyclopedia/:slug`.

**Layout (`/encyclopedia/:slug`):**
- Hero art (silhouetted if undiscovered).
- Species facts: rarity, archetype, affinity, content rating, tags, description.
- "Discovered" panel: how many the player owns; link to their highest-level copy in `/collection`.
- "Related species": same-archetype neighbours.

**Empty state:** filters return zero → "No species match your filters."

**Known gaps:** a dedicated dex-slugs endpoint (§14 / §25).

---

### 8.8 Trainer Profile (`/profile`)

**Data sources:**
- `GET /api/v1/players/{playerId}/profile`
- `GET /api/v1/players/{playerId}/collection/stats`
- `GET /api/v1/players/{playerId}/collection/buddy`

**Layout:**
- Trainer identity block — display name, level, XP, joined date.
- Lifetime statistics grid — distinct species, total waifumon, total captures, current level and XP, currency balances.
- Active Buddy summary card.
- **Placeholder tiles** for Achievements, Seasonal Progress, Leaderboards — bordered, "Coming Soon" label, not clickable. Explicit reserved slots so the layout doesn't shift when they land.
- Links to `/collection`, `/buddy`.

**Empty state:** new player → zeros; placeholders still render.

**Known gaps:** achievements, seasons, leaderboards deliberately unmodeled today.

---

### 8.9 Game Guide (`/guide`) — replaces "Game Info"

The Guide is a **player-facing companion resource**, not a dashboard for raw tuning tables. It reads like an in-game help book — friendly prose, illustrated section headers, and links to relevant pages of the Portal ("See your buddy →", "Open the shop →").

**Sections (v1 content is intentionally lightweight — placeholder copy is acceptable):**
- **Hunting** — how the loop works, energy costs, encounter timers. Backed by `GET /api/v1/content/tables/hunt` where useful; otherwise static prose.
- **Care Mode** — what care mode is, what it affects.
- **Affinities** — the current affinity system with each affinity's identity.
- **Evolution** — placeholder / "coming soon".
- **Currency** — WaifuBux, Essence, Energy explainer.
- **FAQ** — a small hand-authored list.

**Rules for v1:**
- Any section may ship as static placeholder text with a small "Deep dive coming soon" note.
- Where a tuning table is useful (e.g. capture modifiers by item), it is embedded as a small pretty table — but framed with player-facing prose, not printed raw.
- No section exposes admin-oriented dumps of `tables.json`.

**Empty state:** none — the Guide always has content.
**Known gaps:** the Guide will grow with the game. v1's job is to establish the shape.

---

### 8.10 Placeholder pages — Achievements / Events / Friends / Settings

Each renders a themed empty-state hero: illustration, feature name, one-line description, "Coming Soon" chip. **Settings** is enabled and hosts the theme toggle plus an About section (version, links to repo docs). The other three are reachable directly by URL but not linkable from within the app until they exist.

---

### 8.11 Select Player (`/select-player`)

Dev-only fallback shown when `VITE_DEFAULT_PLAYER_ID` is missing or does not resolve. Small centered card with:
- The current env value (or "unset").
- The resolution error, if any.
- A one-line explanation: "Set `VITE_DEFAULT_PLAYER_ID` in `portal/.env.local` and reload."

No input field, no runtime picker. Runtime switching is §25.

---

## 9. Component Architecture

Organized by responsibility. All under `portal/src/`:

- **`app/`** — top-level shell.
  - `main.tsx` — entry.
  - `AppShell.tsx` — global layout (header + primary nav + content + footer).
  - `router.tsx` — React Router config; registers `/__dev/diagnostics` only when `import.meta.env.DEV`.
  - `providers.tsx` — QueryClientProvider + SessionProvider + ThemeProvider composition.
- **`auth/`** — swappable session layer.
  - `types.ts` — `PortalSession`.
  - `DevSessionProvider.tsx` — v1 implementation (env-var only).
  - `useSession.ts` — hook. Every page uses it.
  - `RequireSession.tsx` — route guard.
  - `SelectPlayer.tsx` — v1 fallback screen.
- **`api/`** — hand-written Axios wrapper.
  - `client.ts` — Axios instance factory: base URL, `Authorization: Bearer …` interceptor, error envelope decoder, response-timing instrumentation for §29 diagnostics.
  - `players.ts` — `getPlayerProfile`, `getPlayerLookup`, `getPlayer`.
  - `collection.ts` — `getCollection`, `getCollectionEntry`, `getCollectionStats`, `getBuddy`.
  - `care.ts` — `getCareState`.
  - `inventory.ts` — `getInventory`.
  - `shop.ts` — `getShopCatalog`.
  - `content.ts` — `getContentSpecies`, `getContentSpeciesEntry`, `getContentItems`, `getContentTables`, `getContentTable`, `getContentQuests`.
  - `queryKeys.ts` — canonical TanStack Query cache keys.
  - `hooks/` — one small hook per resource, each ~15 lines, delegating to TanStack Query and the helpers above.
  - `types.ts` — hand-authored TypeScript interfaces for the response shapes each page reads.
  - `telemetry.ts` — small in-memory ring buffer (last N requests, timing, status, error code). **Dev-only import**; tree-shaken in production builds.
- **`features/`** — page components. One folder per route:
  - `dashboard/`, `collection/`, `buddy/`, `inventory/`, `shop/`, `encyclopedia/`, `profile/`, `guide/`, `selectPlayer/`, `comingSoon/` (shared placeholder page used by Achievements / Events / Friends), `settings/`, `diagnostics/` (dev-only, §29).
- **`components/`** — reusable UI, page-agnostic.
  - `ui/` — shadcn/ui primitives (button, card, badge, avatar, tabs, dialog, popover, tooltip, skeleton, progress, input, select, sheet).
  - `layout/` — Header, Sidebar, MobileNav, Footer, PageHeader, EmptyState, ErrorState, ComingSoonTile, DevModeBanner.
  - `waifumon/` — domain widgets: `WaifumonCard`, `WaifumonThumbnail`, `RarityBadge`, `RarityGlowRing`, `TypePill` (archetype), `AffinityPill`, `CurrencyChip`, `XpBar`, `AffectionMeter`, `DexProgressRing`.
  - `media/` — `Artwork` component that consumes the image resolver (§13), handles lazy loading, blur-up placeholders, and silhouette fallbacks.
- **`content/`** — client-side helpers over the content snapshot.
  - `species.ts` — sort/filter helpers over the content array. **Presentation only — no gameplay math.**
- **`images/`** — the centralised image resolution layer (§13).
  - `types.ts` — `AssetKind`, `AssetId`, `ImageProvider` interface.
  - `provider.ts` — provider selection (env-driven), factory.
  - `providers/localDevAssets.ts`, `providers/apiEndpoint.ts` (§25.3 future), `providers/silhouette.ts`.
  - `useImage.ts` — hook returning a resolved URL + fallback state; consumed by `Artwork`.
- **`lib/`** — cross-cutting utilities (`cn.ts`, formatters, date helpers, URL query helpers).
- **`styles/`** — Tailwind config, theme tokens, global CSS.

**Testing surface (co-located):** each feature folder has an `__tests__/` alongside; `msw/handlers.ts` centralises mock API responses.

---

## 10. State Management

Three narrow layers, deliberately boring:

1. **Server state — TanStack Query.**
   - Every API read is a query. Query keys are stable arrays from `queryKeys.ts`.
   - Cache TTLs per resource are documented in §18 Cache Philosophy.
   - Retries default to `1` for reads.
   - No global cache clear needed on session change in v1 — session changes require a full reload (env-var edit).

2. **Session state — React Context.**
   - `DevSessionProvider` owns the `PortalSession`. Exposed via `useSession()`.

3. **UI state — component-local `useState` first.**
   - Theme (light / dark) — in `ThemeProvider` context.
   - URL-backed filter state — via `useSearchParams`, not global state.
   - Modal / popover state — component-local.

**No Redux, no Zustand, no Jotai, no MobX in v1.**

---

## 11. API Integration Strategy

**Base URL + auth:**
- Dev: Vite dev server proxies `/api/*` → `http://127.0.0.1:3120`. Same-origin requests, no CORS.
- Bearer token: read from `import.meta.env.VITE_PLATFORM_API_TOKEN` at build time; attached by an Axios request interceptor. The token ends up in the client bundle — this is dev-only and is called out loudly in `docs/portal.md`.

**Hand-written API service** (`portal/src/api/`):
- Each helper takes plain arguments and returns a typed response promise. Example: `getCollection({ playerId, page, pageSize, rarity })`.
- Response shapes are narrow interfaces authored by hand for the fields each page reads — nothing more.
- Errors are normalized once by the client interceptor into a small `PortalApiError` with `status`, `code`, and `message` fields decoded from the `{ error: { code, message } }` envelope.
- Every request is timed (dev builds only) and pushed to a small telemetry ring buffer surfaced on §29 Developer Diagnostics.
- The Portal never introspects the OpenAPI document at runtime.

**TanStack Query hooks** wrap the helpers 1:1. Example: `usePlayerProfile(playerId)` calls `getPlayerProfile(playerId)`.

**Query lifecycle** (uniform across pages, driven by §19 Loading Philosophy):
- Initial load → skeleton UI (matched to final layout).
- Background refresh → keep previous data visible, show a quiet inline indicator.
- Success → data view.
- Empty → per-page empty state.
- Error → inline retry with a friendly message; `error.code` shown in dev.

**No API workarounds.** Where the API is missing something a page wants, §14 API Feedback Loop is the response — the gap is filed as an API enhancement, not paved over in the client.

---

## 12. Image Architecture

The Portal treats images as **logical asset identifiers**, not filesystem paths or URLs. Every artwork rendered on any page — species, item, avatar, banner — goes through a **centralised image resolution layer** so the physical source is swappable without touching any feature code.

### The resolver contract

```
type AssetKind = 'species' | 'item' | 'avatar' | 'ui';

interface AssetId {
  kind: AssetKind;
  slug: string;            // logical id (species / item slug)
  variant?: 'standard' | 'holo' | string;
}

interface ImageProvider {
  resolve(id: AssetId): { url: string; isFallback: boolean };
}
```

Pages call an `<Artwork>` component (or a `useImage(id)` hook) and never touch URLs, filesystem paths, or CDN configuration directly.

### Provider chain (v1)

Providers are tried in configured order; the first non-fallback URL wins. In dev, the default chain is:

1. **Local dev assets provider** — resolves species / item art from a Portal-hosted asset copy under `portal/public/waifumon/<slug>.png` or a Vite proxy path (`/dev-assets/*`) mounted on the local `assets/` folder.
2. **Silhouette provider** — themed placeholder illustration when nothing else is available. Never fails; always returns a URL and `isFallback: true`.

### Provider chain (future — no page changes)

Future providers slot into the same chain, replacing or supplementing the local one:

- **Platform API image endpoint provider** (§25.3) — hits `GET /api/v1/content/species/{slug}/image` when the Platform API exposes it.
- **CDN provider** — hits a public CDN URL, e.g. `https://cdn.waifumon.example/species/{slug}.webp`.
- **Cloudflare Images / object storage provider** — hits `https://imagedelivery.net/…/{slug}/…` or an S3-compatible URL with signed variants.

Migrating between them touches `portal/src/images/` only — **zero page or component changes**.

### Rules the resolver enforces

- **Deterministic URLs.** For a given `AssetId` + provider config, the URL is stable — enabling browser HTTP caching, immutable headers where supported, and CDN cache-friendliness.
- **Graceful degradation.** Missing art never breaks a layout; the silhouette provider always answers. Cards continue to render name + rarity + level.
- **Lazy by default.** `<Artwork>` sets `loading="lazy"` for off-screen tiles; the hero image on a page above the fold sets `loading="eager"` and `fetchPriority="high"`.
- **Alt text is generated at the resolver.** Alt text is derived from the resource being rendered (species name + rarity), not from the URL.
- **No physical paths leak.** The `imagePath` field returned by the Platform API is treated as an internal detail. Pages consume the resolver, never the raw field.

### Why this matters for v1 even though only one provider ships

Consolidating the resolution layer today is what makes future migrations painless. When the Platform API image endpoint lands (§25.3), swapping the default provider is a single-file change and the Portal instantly benefits — no page rewrite, no visual regression, no forgotten call sites.

---

## 13. Cache Philosophy

TanStack Query is configured with defaults that reflect how each resource actually behaves in the Waifumon game. The goal is a Portal that feels **instant on navigation but never shows stale gameplay data**.

Exact TTL numbers are tunable in implementation; the intent is what matters:

| Resource | Cache behaviour | Rationale |
|---|---|---|
| `GET /content/species`, `/content/items`, `/content/tables`, `/content/quests` | Effectively static. `staleTime: Infinity`, `gcTime` several hours. Refetch only on manual invalidation or full reload. | Content only changes on admin reload; content endpoints do no queries. |
| `GET /shop/catalog` | Long-lived, infrequent refresh. `staleTime` ~5 minutes; refetch on window focus. | Catalog changes rarely; players notice a slow shop far more than an occasionally-stale price. |
| `GET /players/{id}/profile` | Short-lived. `staleTime` ~30 seconds; refetch on window focus. | Currencies and XP shift on gameplay actions; a few seconds' staleness is invisible. |
| `GET /players/{id}/collection/owned`, `GET /players/{id}/collection/owned/{waifuId}`, `GET /players/{id}/collection/stats` | Short-lived. `staleTime` ~30 seconds. | Same as profile — captures move these numbers. |
| `GET /players/{id}/collection/buddy` | Short-lived. `staleTime` ~30 seconds. | Buddy affinity and level tick during care. |
| `GET /players/{id}/care`, `GET /players/{id}/inventory`, `GET /players/{id}/daily`, `GET /players/{id}/quests/daily`, `GET /players/{id}/effects/*` | Short-lived. `staleTime` ~30 seconds. | Care ticks, daily rewards, and item counts all change on gameplay. |

**Cross-cutting rules:**
- `refetchOnWindowFocus: true` for all player-scoped queries. When a player alt-tabs back from Discord after a hunt, the Portal catches up automatically.
- `refetchOnWindowFocus: false` for content queries. Content doesn't change during a session.
- `refetchOnReconnect: true` everywhere.
- Prefetch content endpoints (`species`, `items`) on Portal boot so hover/click on a page tile is already primed.
- Player-scoped keys always start with `[playerId, …]`, so a future runtime switcher (§25) can invalidate a single player subtree cleanly.

The Portal prioritises **responsiveness first, freshness second** — gameplay staleness of a few seconds is a fair trade for a UI that never blocks navigation.

---

## 14. Loading Philosophy

The Portal should feel **smooth and inhabited**, not constantly reloading. Loading UX is designed against a small set of rules:

- **Retain previously displayed content while background refreshes occur.** TanStack Query's `placeholderData` (previous data) is the default on every list and detail query. A card grid stays visible while page navigation or filter changes fetch new data; the toolbar shows a subtle refetching indicator, never a full-screen spinner.
- **Skeletons are for initial loads only.** The first time a query fires with no cached data, the page shows a skeleton matched to the final layout. On every subsequent visit (or refresh) the cached data renders immediately and any newer data replaces it in place when it arrives.
- **Never replace an entire page with a loading indicator.** Route navigation renders the destination shell (header, nav, page frame) as soon as the URL changes; individual cards fill in as their queries resolve. There is no "full-page spinner" state anywhere.
- **Navigation stays responsive during data refresh.** Clicking Collection while the Dashboard is refetching is instant — the Dashboard's in-flight queries do not block the router.
- **Perceived-latency helpers.** A subtle "Still loading…" caption appears after 3 s on slow initial loads. Skeleton shimmer is quiet, not attention-grabbing.
- **View Transitions API** for hero-to-detail navigation on the Collection page (where supported) keeps the artwork visible across the route change — reinforcing that navigation is smooth, not lossy.
- **Reduced motion** disables shimmer and transitions.

Together, these rules deliver a Portal where **artwork stays on screen** as much as possible.

---

## 15. Performance Philosophy

Performance is a design constraint present in every phase, not a hardening pass at the end. The Portal is not measured against strict metrics in v1; it is measured against a small set of principles:

- **Fast initial load.** No render-blocking third-party scripts; Vite production bundles are code-split per route; hero art on the Dashboard is `fetchPriority="high"`. Everything else lazy-loads.
- **Instant page navigation where practical.** Cached queries render immediately (§13, §14); route changes are client-side and free of network round-trips.
- **Smooth scrolling.** Card grids avoid layout shift by reserving space for images before they load. No expensive computations in scroll handlers.
- **Lazy loading for artwork and long collections.** `<Artwork>` marks off-screen tiles `loading="lazy"`; the Collection grid renders one page at a time (25 cards) — deliberate cap on how much art is ever in flight.
- **Route-level code splitting.** Each feature folder is a lazy chunk (`React.lazy` + Suspense) so the Dashboard bundle is not carrying the Guide's markdown parser.
- **Content responses are memoized aggressively** (§13). Species and item lookups after the first are free.
- **Debounced client-side filter inputs** so typing in the collection search doesn't re-render the grid on every keystroke.
- **Responsive at all sizes.** Mobile-first design (§21) implies the same performance principles apply on phone browsers.
- **Performance regressions surface early.** Phase 3 includes a manual Lighthouse pass; if a page slips, it is fixed in phase, not left for a future project.

The tone is: **performance is invisible when done right, and the Portal aims to feel invisible.**

---

## 16. API Feedback Loop

The Player Portal is the **first real consumer of the Platform API**. That role carries a specific responsibility:

**When the Portal encounters friction, the friction is data.**

Every case where a page needs something the API doesn't cleanly provide is a signal that the API surface is incomplete — not a signal that the Portal should compensate.

### The rule

The Portal **never**:
- Duplicates gameplay logic to fill an API gap.
- Introduces cross-player or cross-guild queries the API doesn't already expose.
- Reaches into the database, service layer, or shared source code of the bot.
- Adds "just in the client for now" business logic that would belong on the API.

The Portal **always**:
- Uses only public HTTP endpoints under `/api/v1/…`.
- Files any friction it encounters as a documented API enhancement in §25.
- Shows a placeholder when a piece of data is missing, rather than fabricating or computing it.
- Presents-only derivations (sorting, filtering, grouping, same-archetype "related species") are permitted and clearly labelled — they compute *nothing* about gameplay.

### The loop

```
  Portal implementation encounters missing / awkward data
                              │
                              ▼
              File it in §25 Future Enhancements
                              │
                              ▼
        Portal ships v1 with a placeholder or workaround
                              │
                              ▼
      Platform API team (same team) adds the endpoint
                              │
                              ▼
     Portal replaces the placeholder — usually one file
                              │
                              ▼
      Next Portal implementation benefits from a richer API
```

Concretely, everything filed in §25.4 – §25.7 (recent captures, dex slugs, expanded filters, capture history) came out of designing the Portal's pages. Each is now a candidate for a small, isolated API improvement.

### Why the loop matters

- The Portal proves the "adapter only" rule of the API by trying to consume it.
- The API grows in the direction of real client needs, not speculated ones.
- The bot, admin panel, and Portal end up sharing exactly one authoritative implementation of every gameplay concept — the game services — while three surfaces each present it in their own way.
- When v2 clients arrive (mobile app, public Portal, third-party integrations), they inherit an API shaped by real usage.

The Portal treats every "we'll place a placeholder here for now" as a promise to file the corresponding API enhancement before the placeholder ships.

---

## 17. Visual Design Philosophy

Tactical execution of the design principles established in §2. This section is the reference every UI decision is checked against.

**Core stance:**
- **Artwork is the interface.** Every card, hero, tile, and thumbnail is designed to make the key art breathe. Chrome is the frame, not the picture.
- **Dark, modern, spacious, understated.** The default palette is deep neutral (near-black backgrounds, subtle warm tint), with rarity as the accent language. No neon gradients on the shell, no bright primary buttons competing with art.
- **Rarity is the vocabulary.** Rarity colours (mirrored from Discord embeds — N slate, R blue, SR purple, SSR gold, UR crimson, LR iridescent) show up as glow rings on cards, subtle border accents on badges, and small hues in text emphasis. Nothing else in the UI uses those colours.
- **Typography.** One quiet sans (Inter or system) for chrome; one display accent (a subtle serif or a game-fitting alternative — a design decision to make in Phase 1) for hero names. Tabular numerics for currencies and levels so numbers don't jitter.
- **Space over density.** Generous padding, low-density lists, small caption-weight metadata. If a page starts feeling like a spreadsheet, it's wrong.
- **Motion.** CSS transitions for hover / focus / press. View Transitions API for card → detail navigation where supported. `prefers-reduced-motion` disables non-essential motion. No Framer Motion in v1.
- **Iconography.** lucide-react at a single stroke width. Rarity iconography borrows from the Discord game's emoji language for continuity.
- **Loading and empty states are first-class.** Skeletons match final card footprints. Empty states are illustrated, warm, and never feel like an error.
- **Accessibility is non-negotiable.** shadcn/ui + Radix underpins keyboard navigation. All artwork carries meaningful `alt` (species name + rarity) generated by the image resolver (§13). Rarity meaning is never colour-alone — the badge always names the rarity. AA contrast minimum.

**Reference points:**
- Steam library / Pokémon HOME — card grids that feel like a collection, not a table.
- Battle.net collections — quiet chrome, art-forward tiles, hover lift.
- Riot Universe — moody hero pages with room for lore.

**What the Portal is *not*:** the admin panel (utilitarian by design), a dev dashboard, or a spreadsheet — restated from §2 because the risk is real.

---

## 18. Responsive Design Strategy

- **Mobile-first Tailwind breakpoints.** Default styles target ≤`sm` (phone); layouts stack, sidebar becomes a bottom sheet, card grids collapse to one or two columns with generous tap targets.
- **Breakpoints** — 375, 640, 768, 1024, 1280, 1536. Card grid columns scale 2 → 3 → 4 → 5.
- **Dark mode by default.** Light theme available via a toggle in Settings. Tailwind `class` strategy on `<html>`, persisted in `localStorage`, respects `prefers-color-scheme` on first visit.
- **Touch-first affordances.** Card hover states have equivalent focus states; all interactive elements have ≥ 44px hit targets on mobile.
- **No PWA / offline in v1.**

---

## 19. Error Handling

Uniform strategy, driven by TanStack Query state:

| Condition | UX |
|---|---|
| **API unavailable** (network error, timeout) | Toast: "Can't reach the Waifumon server." Cached data stays visible with a "reconnecting" indicator; Retry button on full-page fallback if there's nothing to show. |
| **401 Unauthorized** | Redirect to `/select-player` with a banner "Session expired — check `VITE_PLATFORM_API_TOKEN`." |
| **404 on the current player** | Redirect to `/select-player` with a banner explaining the env value doesn't resolve. |
| **404 on a specific resource** (unknown `waifuId`, unknown `slug`) | Page-level 404 with a link back to the parent list. |
| **500 / unknown** | Inline error card with the `error.code` (dev only) + retry. |
| **Slow loading** (>1s) | Cached data stays visible if any; otherwise skeleton UI. Subtle "Still loading…" caption after 3 s. |
| **Empty collection / inventory / dex** | Per-page empty state (§8). Never a blank grid. |
| **Partial responses** (one of N parallel queries fails) | Failing tile shows a compact inline error with retry; rest of the page renders. |
| **Missing env config** (no `VITE_DEFAULT_PLAYER_ID`) | `/select-player` fallback, no crash. |
| **Missing image asset** | Silhouette placeholder from the image resolver (§13); layout preserved. |

**Global error boundary** wraps the router. Unhandled render errors show a friendly "Something went wrong" screen with a "Reload the app" button. Errors log to the browser console with a `[portal error]` marker; in dev they are also visible on §29 Developer Diagnostics.

**API error envelope.** The Axios wrapper decodes `{ error: { code, message } }` into `PortalApiError`. `code` is machine-readable (from `AppError.code`); `message` is the safe-to-display `userMessage`.

---

## 20. Deployment Strategy

**v1 = local dev only.**

- `cd portal && npm install && npm run dev` starts Vite at `http://127.0.0.1:5173`.
- Vite proxy config forwards `/api/*` to `http://127.0.0.1:3120`.
- `.env.example` in `portal/` documents all `VITE_*` env vars with security notes.
- `npm run build` produces a static bundle in `portal/dist/` — kept working so future deployment work is unblocked; not deployed in v1. Production builds exclude the diagnostics page (§29) and the telemetry ring buffer via `import.meta.env.DEV` guards.
- **Not registered in the bot's Docker Compose.**
- **CI addition:** a `portal-build` job runs `npm ci && npm run typecheck && npm run test && npm run build` on every PR.
- **No CDN, no domain, no TLS, no auth-hardening.**

**Configuration surface** (`portal/.env.example`):
- `VITE_PLATFORM_API_URL` — default `/api` (proxy target in dev).
- `VITE_PLATFORM_API_TOKEN` — dev bearer, matching `PLATFORM_API_TOKEN` on the bot side.
- `VITE_DEFAULT_PLAYER_ID` — the acting player. Required for the Portal to reach any page beyond `/select-player`.
- `VITE_DEV_ASSETS_PATH` — optional; path served by the `/dev-assets` proxy for local artwork (§13).
- `VITE_IMAGE_PROVIDERS` — optional; comma-separated provider ids for the image resolver chain (§13).

---

## 21. Implementation Phases

Reorganised around **visible milestones**. Phase 1 alone delivers something a player would enjoy using.

### Phase 0 — Scaffolding

- Create `portal/` with Vite + React 19 + TypeScript, ESLint + Prettier, Tailwind CSS v4.
- Set up shadcn/ui primitives, base theme tokens, dark mode default + light toggle plumbing.
- Wire React Router v7 with placeholder routes for every entry in §7 (each renders a "Coming soon" tile).
- `AppShell` with header (logo, "DEV MODE" banner, theme toggle) + primary nav (all 13 entries, disabled where appropriate).
- Vite proxy config for `/api` → bot.
- Axios client factory + `PortalApiError` decoder + bearer-token interceptor + dev-only timing telemetry (§29).
- Image resolver skeleton (§13) with the local-dev-assets + silhouette providers, and the `<Artwork>` component.
- `DevSessionProvider` reading `VITE_DEFAULT_PLAYER_ID`, resolving via `getPlayer`, populating `PortalSession`.
- `/select-player` fallback screen.
- `/__dev/diagnostics` page (§29) registered only in dev builds.
- Vitest + Testing Library + MSW skeleton with one smoke test (`AppShell` renders + nav works).
- Update root `.gitignore` for `portal/node_modules`, `portal/dist`.
- CI: add `portal-build` job.

**Verification:**
- `cd portal && npm run dev` opens the shell; nav works between placeholder pages.
- `/__dev/diagnostics` renders and reports API URL, session, environment, cache stats, last error, timing.
- Theme toggle persists across reloads.
- Fresh clone with `.env.local` pointing at a valid `VITE_DEFAULT_PLAYER_ID` auto-signs in.
- Missing / invalid env shows `/select-player` fallback — no crash.
- Backend unavailable → error boundary + retry.
- `npm run build` succeeds; production bundle excludes the diagnostics page (verified via bundle size / grep).
- `npm run test` passes.
- Discord bot behaviour bit-identical.

### Phase 1 — Dashboard + Collection + Navigation *(visible milestone)*

At the end of this phase, the Portal is a **usable companion application**. A developer or player opens it and immediately sees their trainer, buddy, currencies, and collection.

- API helpers + hooks for: `getPlayerProfile`, `getBuddy`, `getCollectionStats`, `getCollection`, `getCollectionEntry`, `getContentSpecies`, `getContentSpeciesEntry`.
- Domain widgets: `WaifumonCard`, `RarityBadge`, `RarityGlowRing`, `TypePill`, `AffinityPill`, `CurrencyChip`, `XpBar`, `DexProgressRing`, `EmptyState`, `ErrorState`, `Artwork`.
- Ship `/dashboard` — establishes the visual identity per §17.
- Ship `/collection` and `/collection/:waifuId` — the flagship experience per §8.2 / §8.3.
- URL-backed filter state on `/collection`.
- View-transition detail navigation (with graceful fallback).
- Loading skeletons + previous-data retention per §14 Loading Philosophy.
- Cache TTLs applied per §13.
- MSW handlers + component tests for both pages (happy path + one error path each).

**Verification:**
- Fresh dev browser opens directly into a beautiful Dashboard.
- Collection browser renders 25 large cards per page with rarity glow rings; filters back/forward correctly via the URL.
- Card → detail navigation is smooth; detail page renders hero art, progression, and placeholders for future data.
- Navigating away and back shows cached data instantly; a subtle refetch indicator confirms freshness (§14).
- Every page has loading + empty + error states exercised by tests.
- No 4xx in the console during normal navigation.
- Manual walk-through on phone (375px) and desktop (1440px) — layouts feel intentional at both.
- `/__dev/diagnostics` reflects real API URL, current player, live cache stats.

### Phase 2 — Buddy, Inventory, Shop, Encyclopedia, Guide, Profile

Complete the read-only feature surface.

- API helpers + hooks for: `getCareState`, `getInventory`, `getShopCatalog`, `getContentItems`, `getContentTables`, `getContentTable`, `getContentQuests`.
- Ship `/buddy` — hero + care card.
- Ship `/inventory` — grouped by category, quantity chips.
- Ship `/shop` — read-only catalogue.
- Ship `/encyclopedia` and `/encyclopedia/:slug` — with ownership overlay derived from `/collection/owned` cached session-wide.
- Ship `/guide` — player-facing sections per §8.9 (placeholder copy acceptable).
- Ship `/profile` — trainer profile with placeholder tiles for achievements / seasons / leaderboards.
- Coming Soon pages for Achievements / Events / Friends (all share one `ComingSoonTile` shell).
- Settings page (theme toggle + About section).

**Verification:**
- Every page renders with real API data on a running bot.
- Encyclopedia ownership overlay reflects the current player's collection.
- Guide sections render placeholder copy without exposing raw tuning JSON.
- MSW tests cover each new page's happy path + one error path.
- Nav sidebar shows the full set — enabled entries navigate, "Coming Soon" entries are inert.

### Phase 3 — Responsive polish, accessibility, testing, docs *(hardening)*

- Manual responsive audit at 375 / 640 / 768 / 1024 / 1440. Fix any layout shift or overflow.
- Accessibility pass: keyboard-only walk-through, focus rings, screen-reader labels, contrast pass at AA.
- Loading skeleton pass: every list has a skeleton, no spinners.
- Playwright smoke test: startup → dashboard → collection → detail → back.
- Test coverage pass — every page has at least one component test covering loading + success + empty + error.
- Write `docs/portal.md`: dev setup, env vars, dev-auth caveats, image resolver + provider chain, future OAuth roadmap, API image endpoint migration.
- Update root README with a link to `docs/portal.md`.
- Freeze the v1 scope.

**Verification:**
- Lighthouse desktop + mobile — accessibility + best practices ≥ 90.
- Playwright smoke passes in CI.
- Fresh clone → working Portal within a minute.
- README + docs reviewed for accuracy against the running app.
- Discord bot test suite bit-identically green.

---

## 22. Testing Strategy

**Framework:** Vitest + @testing-library/react (component tests), MSW (API mock), Playwright (Phase 3 smoke).

**Layers:**

1. **Component / unit** — every reusable domain widget (`WaifumonCard`, `RarityBadge`, `Artwork`, filters) has a small render test.
2. **Feature / page** — each page has a test suite covering loading + success + empty + error. MSW handlers built by hand, matching the API response shapes read by the hooks.
3. **Auth** — dedicated tests for `DevSessionProvider`: env-var resolution success, resolution failure → fallback, `useSession` propagation.
4. **Image resolver** — provider chain tests: correct provider selected per env config, silhouette fallback fires, alt text derived correctly.
5. **Cache behaviour** — a small test asserting per-resource `staleTime` defaults from §13 (guards against a distracted config change).
6. **Loading behaviour** — a test that background refetches retain previous data (§14).
7. **Error boundary** — a page throwing during render shows the fallback.
8. **API wrapper** — small tests for the Axios interceptor decoding `PortalApiError`.
9. **E2E smoke (Phase 3)** — one Playwright script: startup → dashboard renders → click Collection → detail page.

**Coverage target:** every feature page has at least one test; all four states (loading / success / empty / error) are exercised across the suite; every reusable domain widget has a test.

---

## 23. Developer Diagnostics (dev builds only)

A small, hidden diagnostics page at `/__dev/diagnostics` — registered only when `import.meta.env.DEV` is true and **excluded from production bundles** via a lazy import guarded by that check.

### Contents

Grouped into small cards, each with a copy-to-clipboard affordance:

- **Environment**
  - Node env / mode (from `import.meta.env.MODE`).
  - Portal build hash (from Vite `__APP_VERSION__` define, if configured).
  - `VITE_PLATFORM_API_URL`, effective proxy target.
- **Platform API**
  - Connected base URL.
  - Result of a probe against `GET /ready` (structured component report from `docs/platform-api.md`).
  - Platform API version — from `X-Waifumon-API-Version` on the last response (or the OpenAPI info block on demand).
- **Session**
  - Current `PortalSession` — `playerId`, `guildDbId`, `displayName`, `discordUserId`, `discordGuildId`.
  - Env values `VITE_DEFAULT_PLAYER_ID`, `VITE_DEFAULT_DISCORD_GUILD_ID`, `VITE_DEFAULT_DISCORD_USER_ID`.
- **Query cache**
  - Total queries, hits, refetches, error count.
  - Table of the top N most recent query keys with status, `dataUpdatedAt`, `errorUpdatedAt`.
  - A "Clear cache" button that calls `queryClient.clear()` — dev convenience only.
- **Recent API activity**
  - Ring buffer of the last N HTTP requests: method, path, status, duration, `error.code` if any.
  - Populated by the Axios interceptor's dev-only telemetry hook (§9, §11).
- **Last error**
  - The most recent `PortalApiError` decoded by the client wrapper, with `status`, `code`, `message`, `requestId` if present.
- **Image resolver**
  - Active provider chain from §13, current fallback rate.
- **Feature flags**
  - Live values of `import.meta.env.VITE_*` that control Portal behaviour.

### Guarantees

- **Not registered in production builds.** The route registration in `router.tsx` is wrapped in `import.meta.env.DEV`, and the `diagnostics/` feature module is dynamically imported inside that branch so Vite tree-shakes it out of `npm run build`.
- **No sensitive values are surfaced.** The bearer token is never displayed. The page shows tokens as `••••••••` if it needs to indicate presence.
- **No mutation surface.** The only action available beyond "copy value" is "Clear cache" — safe in dev, still absent in production because the whole page is.
- **Never linked from the primary nav.** Discoverability is intentional: a footer link visible only in dev builds, plus the direct URL.

The diagnostics page pays for itself the first time a developer needs to answer "what player am I signed in as, what's the API returning, and why is the Dashboard blank?" without opening devtools.

---

## 24. Success Criteria

**Objectively verifiable:**

1. ✅ `cd portal && npm install && npm run dev` starts the Portal and it reaches the bot's Platform API through the proxy.
2. ✅ Setting `VITE_DEFAULT_PLAYER_ID` in `portal/.env.local` auto-signs the developer in on load; missing / invalid values show `/select-player` without a crash.
3. ✅ The Portal makes **zero** requests outside `/api/v1/…` (verified by browser devtools + a test asserting the base URL).
4. ✅ Zero imports of `src/modules`, `src/db`, `src/discord`, `src/config` from anywhere under `portal/` (verified by a lint rule or CI grep).
5. ✅ Every page in §7 renders successfully against a real Platform API for a fully-populated test player.
6. ✅ No page issues a POST / PATCH / DELETE against the API (verified by a test inspecting the Axios call log).
7. ✅ Disabling the Portal has zero effect on the Discord bot, admin panel, or Platform API.
8. ✅ The Discord bot's test suite is bit-identically green before and after the Portal ships.
9. ✅ Every page has loading + empty + error states exercised by at least one test.
10. ✅ `docs/portal.md` exists and covers dev setup, env vars, dev-auth caveats, image resolver strategy, and the OAuth migration path.
11. ✅ `PortalSession` is the single seam where session data enters the app; replacing `DevSessionProvider` with a hypothetical `OAuthSessionProvider` touches no feature page.
12. ✅ **Phase 1 alone delivers a Portal that feels like a companion app** — Dashboard + Collection are complete, art-forward, and responsive.
13. ✅ Every page consumes images via the resolver (§13) — no `<img src="…">` referencing a physical path anywhere under `features/`.
14. ✅ Cache behaviour matches §13 for every resource (verified by the cache test in §22).
15. ✅ Background refetches retain previously displayed content (verified by the loading-behaviour test in §22).
16. ✅ `/__dev/diagnostics` renders in dev, is not present in the production build (verified by a bundle-size / grep test).
17. ✅ Every API gap encountered during v1 is filed in §25 — nothing is silently absorbed as client logic.

**Subjective (architectural + UX):**
- Opening the Portal, the first reaction is "this looks like a game companion" — not "this looks like an admin panel."
- Reviewer opening `portal/src/features/` sees only presentation code.
- Adding a new page = one folder in `features/` + one route entry + zero changes to `AppShell` or `DevSessionProvider`.
- Every "we couldn't build this in v1" is a placeholder tile, not a broken page.

---

## 25. Future Enhancements

Called out here so the Portal is never tempted to grow beyond v1's scope. All items are additive and require no v1 redesign to adopt. §14 API Feedback Loop is the mechanism that populates and prioritises this list.

### 25.1 API client evolution — generated OpenAPI client

Once the Platform API surface stabilises (post-v1 of the Portal), replace the hand-written `types.ts` and helpers with types generated from `/api/v1/openapi.json` (via `openapi-typescript` + `openapi-fetch`, or an equivalent). Route bodies do not change; only the wrapper and type source move.

### 25.2 Runtime player switcher

A header dialog that lets a developer switch to a different player without a `.env.local` edit. Backed by:
- An internal `playerId` input (calls `GET /api/v1/players/{id}`).
- A `(discordGuildId, discordUserId)` input pair (calls `GET /api/v1/players/lookup`).
- Optionally a picker over a future `GET /api/v1/players?guildDbId=` list endpoint.

Selection persists in `localStorage`, clears the TanStack Query cache on switch.

### 25.3 Dedicated Platform API image endpoints

`GET /api/v1/content/species/{slug}/image` and `GET /api/v1/content/items/{slug}/image` — stream PNGs from `ASSETS_DIR` with immutable caching. Portal migration is a **single-file change** in the image resolver (§13) — no page code touched.

### 25.4 Recent captures endpoint

`GET /api/v1/players/{playerId}/captures/recent?limit=` — returns the N most recent `player_waifus` entries ordered by `caught_at DESC`. Unlocks a "Recent Captures" strip on the Dashboard.

### 25.5 Dex slug set endpoint

`GET /api/v1/players/{playerId}/collection/dex` returning `{ ownedSlugs: string[] }`. Removes the client-side derivation used for encyclopedia ownership in v1.

### 25.6 Expanded collection server-side filters

Add `archetype`, `affinity`, `search`, `favorite`, `buddyOnly`, `sort` query parameters to `GET /players/{id}/collection/owned`. Enables large collections without paging through client-side.

### 25.7 Capture history per waifu

`GET /api/v1/players/{playerId}/collection/owned/{waifuId}/capture` — the `capture_attempts` chain for that specific catch. Unblocks the Waifumon Details capture-information card.

### 25.8 Composite dashboard endpoint

`GET /api/v1/players/{playerId}/dashboard` composing player + currencies + buddy + daily + quests + care + stats. Cuts the Dashboard from many parallel requests to one.

### 25.9 CORS + browser-friendly variants on the Platform API

The dev proxy sidesteps CORS today. A deployed Portal needs a proper CORS allow-list on the API.

### 25.10 CDN / Cloudflare / object-storage image providers

Additional providers for the image resolver (§13). Migration touches `portal/src/images/` only.

### 25.11 Additional API surface for content-model growth

`personality`, waifu combat stats, evolution, structured related-species — all content-model additions. Portal already reserves layout space for each.

### 25.12 Achievements, Events, Friends, Settings expansion

Each has a reserved sidebar slot and a placeholder page. Filling them out is downstream work, unblocked by whatever service-layer feature ships first.

### 25.13 Production deployment

Nginx / Caddy in front of the SPA, TLS via Let's Encrypt, static-asset CDN. Requires §25.9 first.

### 25.14 Discord OAuth (v2)

Replaces `DevSessionProvider` with `OAuthSessionProvider` and adds a tiny Portal-owned BFF for the callback. Uses `/players/lookup` (unchanged) and the future `/me` aliases (APIcreationplan §8.4).

### 25.15 Live notifications / Activity Feed

SSE stream from the Platform API driven by the existing `GameEventBus`. Enables real-time Dashboard updates.

### 25.16 Gameplay mutations from the Portal

Hunt / capture / care / daily / purchase. Requires the API's `PlatformSource` event variant (APIcreationplan §17.5), a mutation-review policy, per-player rate limiting, and OAuth for identity.

### 25.17 Long-term

- Public player profiles (opt-in privacy model, slug service on the API).
- Collection sharing (share links, screenshots).
- Native mobile app sharing the API contract and design tokens.
- Content-editor migration from admin panel to Portal (only when writable API endpoints exist).

---

## 26. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Portal duplicates gameplay logic to fill an API gap** | Medium | High | §16 API Feedback Loop is the rule. Reviewer discipline + PR checklist. Every derived value is grep-able. Non-gameplay derivation (sort, filter, group) is fine and clearly labelled. |
| **Bearer token in the client bundle** (dev only) | Certain | Low (dev) / High (if reused in prod) | `docs/portal.md` calls it out. `VITE_` prefix is a signal. No production build path in v1. |
| **Hand-written types drift from the API** | Medium | Medium | Types are narrow and per-page. Tests exercise real (MSW-mocked) responses against those types. When drift bites, §25.1 codegen resolves it. |
| **Direct image path references sneak in** | Medium | Medium | §13 rules + lint rule against `<img src="…">` in `features/`. §22 has a resolver test. |
| **Loading behaviour regresses to full-page spinners** | Medium | Medium | §14 rules + a dedicated test that background refetches retain previous data. |
| **Cache TTLs drift** | Low | Medium | §13 table + §22 test locks the intent. |
| **Diagnostics page ships to production** | Low | Medium | `import.meta.env.DEV` guard on the route and dynamic import. §24.16 verifies via bundle inspection. |
| **Local dev asset drift** | Medium | Low | Image resolver silhouette provider ensures no crashes; §25.3 fixes it permanently. |
| **Users mistake dev-auth for real auth** | Medium | High | Persistent "DEV MODE — no authentication" header banner. README + `docs/portal.md` restate it. No production build path. |
| **Scope creep** ("just add a favorite toggle") | Medium | Medium | Non-goals list is contract. Mutations belong to a future project. |
| **Visual identity slips toward "admin panel"** | Medium | High | §2 + §17 are the reference; every page reviewed against them. Dashboard + Collection are Phase 1 explicitly to set the tone. |
| **Vite ↔ bot proxy misconfiguration** | Low | Low | `.env.example` documents defaults; dev-server startup logs the proxy target. |
| **Missing content fields (personality, stats, evolution) surprise implementers** | Certain | Low | Documented per page in §8, filed in §25 via §16. Portal shows placeholders, not fabrications. |
| **Related-species logic drifts into gameplay** | Low | Medium | Same-archetype from cached content list is a pure presentation heuristic; anything richer needs an API field. |

---

## Relevant Files

**New (all under `portal/`):**
- `portal/package.json`, `portal/tsconfig.json`, `portal/vite.config.ts`, `portal/index.html`, `portal/.env.example`, `portal/tailwind.config.ts`.
- `portal/src/app/{main,AppShell,router,providers}.tsx`.
- `portal/src/auth/{types,DevSessionProvider,useSession,RequireSession,SelectPlayer}.ts(x)`.
- `portal/src/api/{client,players,collection,care,inventory,shop,content,queryKeys,types,telemetry}.ts`, `portal/src/api/hooks/*.ts`.
- `portal/src/images/{types,provider,useImage}.ts`, `portal/src/images/providers/{localDevAssets,silhouette}.ts` (v1); `providers/apiEndpoint.ts`, `providers/cdn.ts` land later per §25.3 / §25.10.
- `portal/src/features/{dashboard,collection,buddy,inventory,shop,encyclopedia,profile,guide,selectPlayer,comingSoon,settings,diagnostics}/`.
- `portal/src/components/{ui,layout,waifumon,media}/*.tsx`.
- `portal/src/content/species.ts`.
- `portal/src/lib/*.ts`, `portal/src/styles/globals.css`.
- `portal/msw/handlers.ts`, `portal/tests/*.spec.ts`, `portal/playwright/*.spec.ts` (Phase 3).
- `docs/portal.md` — operator + dev guide.

**Modified (main repo):**
- Root `.gitignore` — add `portal/node_modules`, `portal/dist`.
- Root `README.md` — one-paragraph pointer to the Portal.
- CI config — add `portal-build` job.

**Explicitly untouched:**
- All of `src/discord/**`, `src/admin/**`, `src/modules/**`, `src/db/**`, `src/api/**`.

---

## Decisions

- **Framework:** Vite + React 19 + TypeScript SPA (not Next.js).
- **Location:** sibling `portal/` with its own `package.json`.
- **API client:** hand-written Axios wrapper with per-resource helpers; hand-authored TypeScript response interfaces. OpenAPI codegen deferred to §25.1.
- **Dev auth:** `DevSessionProvider` reads `VITE_DEFAULT_PLAYER_ID` only. No runtime switcher, no localStorage session, no cookies. Runtime switching deferred to §25.2.
- **State:** TanStack Query for server state, React Context for session + theme, `useState` for everything else.
- **Styling:** Tailwind CSS v4 + shadcn/ui, dark by default, mobile-first.
- **Design philosophy:** premium companion application, artwork-first, dark quiet chrome, presentation over density (§2). Tactical execution in §17.
- **Images:** centralised resolver + provider chain (§13). No page code touches URLs or paths. Migrating to API image endpoints / CDN / Cloudflare / object storage is a §25 provider swap.
- **Cache philosophy:** documented per resource (§13). Content effectively static, player data short-lived.
- **Loading philosophy:** retain previous content on background refetch, skeletons for initial load only, no full-page spinners (§14).
- **Performance philosophy:** performance is a design constraint present in every phase, not a hardening pass (§15).
- **API feedback loop (§16):** every friction point files a documented API enhancement rather than a client workaround.
- **Developer diagnostics:** `/__dev/diagnostics` in dev builds only; excluded from production bundles (§23).
- **Roadmap ordering:** Phase 0 scaffolding → Phase 1 Dashboard + Collection → Phase 2 Buddy / Inventory / Shop / Encyclopedia / Guide / Profile → Phase 3 polish + accessibility + testing + docs.
- **"Game Info" → "Game Guide"** — player-facing narrative resource, not a tuning-table dump.
- **Navigation reserves slots for Achievements / Events / Friends / Settings** so future work does not force a redesign.
- **Deployment:** local dev only in v1.
- **Read-only:** no POST / PATCH / DELETE anywhere.

## Further Considerations

1. **Display accent font.** The Dashboard and Collection hero areas benefit from a distinctive display face. Pick during Phase 1 UI review; a single system-safe fallback is fine if licensing is complicated.
2. **View Transitions API scope.** Card → detail is the highest-impact use. Any wider adoption (page-to-page hero morphs) is a Phase 3 polish call, not a Phase 1 commitment.
3. **Guide content authoring.** Placeholder prose is acceptable in Phase 2; a light content pass by a game-voice writer before v1 close would sharpen the "companion, not admin panel" impression significantly.
4. **Image asset copy vs proxy.** In v1, the local-dev-assets provider can either copy assets into `portal/public/` (simple, doubles storage) or Vite-proxy from the repo's `assets/` folder (shared source of truth). Recommendation: **proxy** — one source, no drift, no gitignore juggling.
5. **Diagnostics as a Phase 0 or Phase 1 deliverable.** Diagnostics is small and self-contained. Recommendation: **Phase 0**, so every subsequent phase benefits during development.
