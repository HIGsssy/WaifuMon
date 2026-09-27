/**
 * Workload profiles: what a virtual player does, and how long they wait
 * between doing it.
 *
 * ## The unit is a person, not a request
 *
 * A virtual player performs **actions** — a Discord command, a Portal page
 * view, a glance at a grid of cards — and then **thinks**. An action is one or
 * more steps; a step's requests are issued together, the way a React page's
 * queries fire at once on mount, and steps run in order, the way a command
 * reads its player before its collection. "50 players" is therefore 50 of
 * these loops, each idle most of the time, which is what 50 active humans look
 * like — not 50 connections hammering the server.
 *
 * ## Only reads, and only the caller's own data
 *
 * Every request is a GET, and every player-scoped path names the virtual
 * player's own synthetic id (or, for a public profile, another synthetic player
 * in the same synthetic guild). The server enforces that independently: each
 * virtual player authenticates with a Portal session bound to its synthetic
 * player, and the player-scope hook refuses any other id. Some GETs do write —
 * `/achievements` records newly-met unlocks, `/encounter` expires a stale
 * encounter — which is exactly why the players are synthetic.
 *
 * ## Repeatability
 *
 * Every choice draws from a seeded PRNG, so two runs of the same scenario with
 * the same seed issue the same actions in the same order, per player. Timing
 * still varies with the server — that variation is the measurement.
 */
import { seededRng, type Rng } from '../../shared/random';
import type {
  ColdCardTarget,
  LoadTestProfile,
  CardMode,
  VirtualPlayerFixture,
} from './types';

/** Width the Portal's grid requests; a derivative of the 1500px master. */
export const GRID_CARD_WIDTH = 512;

export interface RequestSpec {
  /** Route template, for per-endpoint statistics. */
  endpoint: string;
  /** Absolute path on the API origin, query string included. */
  path: string;
  /** A card image: body is bytes, and a 304 is a success. */
  card?: boolean;
  /** Send the last ETag seen for this path, as a browser revalidating would. */
  revalidate?: boolean;
  /** Counted as a cold render request. */
  cold?: boolean;
  /**
   * Statuses that are this endpoint's normal answer rather than a failure —
   * `GET /encounter` is 404 whenever the player is not facing anyone, which
   * between hunts is almost always.
   */
  expectedStatuses?: readonly number[];
}

/** Steps run in order; the requests within a step run concurrently. */
export type ActionSteps = RequestSpec[][];

export interface ActionContext {
  player: VirtualPlayerFixture;
  rng: Rng;
  cardsAvailable: boolean;
  cardMode: CardMode | null;
  /** Next never-requested cold card, or null once the plan is spent. */
  takeCold: () => ColdCardTarget | null;
  /** Called when a cold action found the plan spent and fell back to warm. */
  noteColdExhausted: () => void;
}

export interface ActionDef {
  name: string;
  weight: number;
  build: (ctx: ActionContext) => ActionSteps;
}

/**
 * Think time between actions: log-normal around a median, clamped. Human
 * pauses are right-skewed — mostly short, occasionally long — which a uniform
 * range misrepresents.
 */
export interface ThinkTime {
  medianMs: number;
  sigma: number;
  minMs: number;
  maxMs: number;
}

export interface Persona {
  name: 'discord' | 'portal' | 'cards';
  actions: ActionDef[];
  think: ThinkTime;
}

// ─────────────────────────────────────────────────────────────── helpers

const API = '/api/v1';

function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng.next() * items.length)];
}

function get(endpoint: string, path: string): RequestSpec {
  return { endpoint: `GET ${endpoint}`, path: `${API}${path}` };
}

const me = (p: VirtualPlayerFixture) => `/players/${p.playerId}`;

function collectionPage(ctx: ActionContext, pageSize: number, extra = ''): RequestSpec {
  const pages = Math.max(1, Math.ceil(ctx.player.ownedWaifuIds.length / pageSize));
  const page = 1 + Math.floor(ctx.rng.next() * pages);
  return get(
    '/players/:id/collection/owned',
    `${me(ctx.player)}/collection/owned?page=${page}&pageSize=${pageSize}${extra}`,
  );
}

function ownedCard(p: VirtualPlayerFixture, waifuId: number, revalidate: boolean): RequestSpec {
  return {
    endpoint: 'GET /players/:id/collection/owned/:waifuId/card',
    path: `${API}${me(p)}/collection/owned/${waifuId}/card?width=${GRID_CARD_WIDTH}`,
    card: true,
    revalidate,
  };
}

function coldCard(target: ColdCardTarget): RequestSpec {
  return {
    endpoint: 'GET /cards/species/:slug (cold)',
    path: `${API}/cards/species/${target.slug}?level=${target.level}&width=${GRID_CARD_WIDTH}`,
    card: true,
    cold: true,
  };
}

/** A browser loading a grid: up to six images at once, its per-origin limit. */
function warmGrid(ctx: ActionContext, size: number, revalidateChance: number): RequestSpec[] {
  const ids = ctx.player.gridWaifuIds;
  if (!ctx.cardsAvailable || ids.length === 0) return [];
  const start = Math.floor(ctx.rng.next() * ids.length);
  const out: RequestSpec[] = [];
  for (let i = 0; i < Math.min(size, ids.length); i += 1) {
    const id = ids[(start + i) % ids.length]!;
    out.push(ownedCard(ctx.player, id, ctx.rng.next() < revalidateChance));
  }
  return out;
}

function coldBurst(ctx: ActionContext, size: number): RequestSpec[] {
  if (!ctx.cardsAvailable) return [];
  const out: RequestSpec[] = [];
  for (let i = 0; i < size; i += 1) {
    const target = ctx.takeCold();
    if (target === null) break;
    out.push(coldCard(target));
  }
  if (out.length === 0) {
    // The plan is spent. Say so, and keep the player behaving like a person
    // looking at cards rather than going idle — the summary reports how many
    // cold requests actually happened.
    ctx.noteColdExhausted();
    return warmGrid(ctx, size, 0);
  }
  return out;
}

const LEADERBOARD_METRICS = ['trainer', 'collector', 'hunter', 'devoted', 'legendary'] as const;

// ──────────────────────────────────────────────────────────── personas

/**
 * Discord gameplay. The bot's commands call these same services in-process;
 * the generator cannot drive a Discord interaction, so it reaches them through
 * their read-only API adapters instead. What that adds (Fastify routing and
 * serialization) and what it leaves out (embed building, attachment upload to
 * Discord) is noted in `docs/load-testing.md`.
 */
const DISCORD_ACTIONS: ActionDef[] = [
  {
    // Pre-hunt checks: is there a live encounter, is there energy, any charm?
    name: 'hunt-check',
    weight: 30,
    build: (ctx) => [
      [{ ...get('/players/:id/encounter', `${me(ctx.player)}/encounter`), expectedStatuses: [404] }],
      [get('/players/:id/currency', `${me(ctx.player)}/currency`)],
      [get('/players/:id/effects/capture-bonus', `${me(ctx.player)}/effects/capture-bonus`)],
    ],
  },
  {
    name: 'collection-browse',
    weight: 15,
    build: (ctx) => {
      const waifu = pick(ctx.rng, ctx.player.ownedWaifuIds);
      return [
        [collectionPage(ctx, 25, '&sort=rarity')],
        ...(waifu === undefined
          ? []
          : [[get('/players/:id/collection/owned/:waifuId', `${me(ctx.player)}/collection/owned/${waifu}`)]]),
      ];
    },
  },
  {
    // Inspect: the entry, then her card — Discord attaches the rendered card.
    name: 'inspect',
    weight: 10,
    build: (ctx) => {
      const waifu = pick(ctx.rng, ctx.player.gridWaifuIds);
      if (waifu === undefined) return [[get('/players/:id/collection/stats', `${me(ctx.player)}/collection/stats`)]];
      return [
        [get('/players/:id/collection/owned/:waifuId', `${me(ctx.player)}/collection/owned/${waifu}`)],
        ...(ctx.cardsAvailable ? [[ownedCard(ctx.player, waifu, false)]] : []),
      ];
    },
  },
  {
    name: 'profile',
    weight: 10,
    build: (ctx) => [
      [get('/players/:id/profile', `${me(ctx.player)}/profile`)],
      [get('/players/:id/collection/stats', `${me(ctx.player)}/collection/stats`)],
    ],
  },
  {
    name: 'inventory',
    weight: 10,
    build: (ctx) => [
      [get('/players/:id/inventory', `${me(ctx.player)}/inventory`)],
      [get('/players/:id/shop/sellable', `${me(ctx.player)}/shop/sellable`)],
    ],
  },
  {
    name: 'buddy',
    weight: 10,
    build: (ctx) => [
      [get('/players/:id/collection/buddy', `${me(ctx.player)}/collection/buddy`)],
      [get('/players/:id/care', `${me(ctx.player)}/care`)],
    ],
  },
  {
    name: 'daily',
    weight: 10,
    build: (ctx) => [
      [get('/players/:id/daily', `${me(ctx.player)}/daily`)],
      [get('/players/:id/quests/daily', `${me(ctx.player)}/quests/daily`)],
    ],
  },
  {
    name: 'expeditions',
    weight: 5,
    build: (ctx) => [[get('/players/:id/expeditions', `${me(ctx.player)}/expeditions`)]],
  },
];

/** Portal page views: each step is the set of queries that page fires on mount. */
const PORTAL_ACTIONS: ActionDef[] = [
  {
    name: 'dashboard',
    weight: 15,
    build: (ctx) => [
      [
        get('/players/:id/profile', `${me(ctx.player)}/profile`),
        get('/players/:id/collection/stats', `${me(ctx.player)}/collection/stats`),
        get(
          '/players/:id/collection/owned',
          `${me(ctx.player)}/collection/owned?page=1&pageSize=5&sort=newest`,
        ),
        get('/players/:id/collection/buddy', `${me(ctx.player)}/collection/buddy`),
        get('/players/:id/quests/daily', `${me(ctx.player)}/quests/daily`),
        get('/players/:id/expeditions', `${me(ctx.player)}/expeditions`),
      ],
    ],
  },
  {
    name: 'collection',
    weight: 20,
    build: (ctx) => {
      const rarity = ctx.rng.next() < 0.3 ? `&rarity=${pick(ctx.rng, ['N', 'R', 'SR', 'SSR'])}` : '';
      return [
        [
          collectionPage(ctx, 25, rarity),
          get('/players/:id/collection/stats', `${me(ctx.player)}/collection/stats`),
        ],
      ];
    },
  },
  {
    name: 'waifu-detail',
    weight: 10,
    build: (ctx) => {
      const waifu = pick(ctx.rng, ctx.player.ownedWaifuIds);
      if (waifu === undefined) return [];
      return [
        [
          get('/players/:id/collection/owned/:waifuId', `${me(ctx.player)}/collection/owned/${waifu}`),
          get(
            '/players/:id/collection/owned/:waifuId/appearances',
            `${me(ctx.player)}/collection/owned/${waifu}/appearances`,
          ),
        ],
      ];
    },
  },
  {
    name: 'encyclopedia',
    weight: 10,
    build: (ctx) => [
      [
        get('/content/species', '/content/species'),
        get('/players/:id/collection/stats', `${me(ctx.player)}/collection/stats`),
      ],
    ],
  },
  {
    name: 'species-detail',
    weight: 5,
    build: (ctx) => {
      const slug = pick(ctx.rng, ctx.player.speciesSlugs);
      return slug === undefined ? [] : [[get('/content/species/:slug', `/content/species/${slug}`)]];
    },
  },
  {
    name: 'inventory',
    weight: 8,
    build: (ctx) => [
      [
        get('/players/:id/inventory', `${me(ctx.player)}/inventory`),
        get('/content/items', '/content/items'),
      ],
    ],
  },
  {
    name: 'shop',
    weight: 7,
    build: (ctx) => [
      [
        get('/shop/catalog', '/shop/catalog'),
        get('/players/:id/shop/sellable', `${me(ctx.player)}/shop/sellable`),
        get('/players/:id/currency', `${me(ctx.player)}/currency`),
      ],
    ],
  },
  {
    name: 'players',
    weight: 8,
    build: (ctx) => {
      const other = pick(ctx.rng, ctx.player.neighbourPlayerIds);
      return [
        [get('/players', '/players?page=1&pageSize=25')],
        ...(other === undefined
          ? []
          : [
              [
                get('/players/:id/public', `/players/${other}/public`),
                get(
                  '/players/:id/public/collection',
                  `/players/${other}/public/collection?page=1&pageSize=25`,
                ),
              ],
            ]),
      ];
    },
  },
  {
    name: 'leaderboards',
    weight: 7,
    build: (ctx) => [
      [get('/leaderboards', `/leaderboards?metric=${pick(ctx.rng, LEADERBOARD_METRICS)}`)],
    ],
  },
  {
    name: 'achievements',
    weight: 5,
    build: (ctx) => [[get('/players/:id/achievements', `${me(ctx.player)}/achievements`)]],
  },
  {
    // Opening the Portal fresh: the session read the SPA makes before anything.
    name: 'app-load',
    weight: 5,
    build: (ctx) => [
      [{ endpoint: 'GET /auth/session', path: '/auth/session' }],
      [
        get('/capabilities', '/capabilities'),
        get('/players/:id/profile', `${me(ctx.player)}/profile`),
      ],
    ],
  },
];

function cardActions(mode: CardMode, includeRareCold: boolean): ActionDef[] {
  if (mode === 'cold') {
    // A burst of never-drawn cards, as a grid of new captures would be.
    return [{ name: 'cold-cards', weight: 1, build: (ctx) => [coldBurst(ctx, 3)] }];
  }
  const warm: ActionDef[] = [
    {
      // Collection in card mode: a page of the grid, some revalidated (304).
      name: 'card-grid',
      weight: 80,
      build: (ctx) => [
        [collectionPage(ctx, 25)],
        warmGrid(ctx, 6, 0.3),
      ],
    },
    {
      name: 'card-inspect',
      weight: 20,
      build: (ctx) => {
        const waifu = pick(ctx.rng, ctx.player.gridWaifuIds);
        return waifu === undefined || !ctx.cardsAvailable ? [] : [[ownedCard(ctx.player, waifu, false)]];
      },
    },
  ];
  if (includeRareCold) {
    // New captures and level-ups mint cards nobody has drawn — rare, not never.
    warm.push({ name: 'new-card', weight: 4, build: (ctx) => [coldBurst(ctx, 1)] });
  }
  return warm;
}

const THINK_DISCORD: ThinkTime = { medianMs: 10_000, sigma: 0.5, minMs: 3_000, maxMs: 30_000 };
const THINK_PORTAL: ThinkTime = { medianMs: 12_000, sigma: 0.55, minMs: 4_000, maxMs: 40_000 };
const THINK_CARDS: ThinkTime = { medianMs: 10_000, sigma: 0.5, minMs: 3_000, maxMs: 30_000 };

/**
 * Mixed-workload persona rotation over 20 slots: 11 Discord, 7 Portal,
 * 2 card-heavy — 55 / 35 / 10. A fixed rotation rather than a random draw so
 * that 10 players are always the same 10 people, on every host.
 */
const MIXED_ROTATION: readonly Persona['name'][] = [
  'discord', 'portal', 'discord', 'portal', 'discord', 'cards', 'discord', 'portal', 'discord', 'portal',
  'discord', 'portal', 'discord', 'discord', 'portal', 'cards', 'discord', 'portal', 'discord', 'discord',
];

export function personaFor(
  profile: LoadTestProfile,
  cardMode: CardMode | null,
  index: number,
  cardsAvailable: boolean,
): Persona {
  const name: Persona['name'] =
    profile === 'normal'
      ? 'discord'
      : profile === 'portal'
        ? 'portal'
        : profile === 'cards'
          ? 'cards'
          : MIXED_ROTATION[index % MIXED_ROTATION.length]!;

  if (name === 'discord') return { name, actions: DISCORD_ACTIONS, think: THINK_DISCORD };
  if (name === 'cards' && cardsAvailable) {
    const mode = profile === 'cards' ? (cardMode ?? 'warm') : 'warm';
    return { name, actions: cardActions(mode, profile === 'mixed'), think: THINK_CARDS };
  }
  if (name === 'portal' && profile === 'mixed' && cardsAvailable) {
    // A Portal user in the mixed workload also flips the collection to card
    // mode now and then.
    return {
      name,
      actions: [...PORTAL_ACTIONS, ...cardActions('warm', true).map((a) => ({ ...a, weight: a.weight / 8 }))],
      think: THINK_PORTAL,
    };
  }
  return { name: 'portal', actions: PORTAL_ACTIONS, think: THINK_PORTAL };
}

export function chooseAction(actions: readonly ActionDef[], rng: Rng): ActionDef {
  const total = actions.reduce((sum, a) => sum + a.weight, 0);
  let roll = rng.next() * total;
  for (const action of actions) {
    roll -= action.weight;
    if (roll < 0) return action;
  }
  return actions[actions.length - 1]!;
}

/** Log-normal think time via Box–Muller, clamped to the persona's range. */
export function thinkTimeMs(think: ThinkTime, rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = think.medianMs * Math.exp(think.sigma * z);
  return Math.round(Math.min(think.maxMs, Math.max(think.minMs, ms)));
}

/** Per-player PRNG, derived from the run seed so players do not move in lockstep. */
export function playerRng(seed: number, index: number): Rng {
  return seededRng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

/**
 * Stagger over which players join: a tenth of the run, at most 30 s. Fifty
 * sessions opening in the same millisecond is a thundering herd no real
 * evening produces, and it would dominate a one-minute run's percentiles.
 */
export function rampMs(durationMs: number): number {
  return Math.min(30_000, Math.floor(durationMs / 10));
}

/**
 * How many never-drawn cards a run could ask for, with headroom, so the
 * planner can find that many before the clock starts. Capped: a cold plan is
 * a list of files that will be created and then removed.
 */
export const MAX_COLD_PLAN = 1_500;

export function coldCardsNeeded(
  profile: LoadTestProfile,
  cardMode: CardMode | null,
  concurrency: number,
  durationMs: number,
): number {
  const actionsPerPlayer = durationMs / THINK_CARDS.medianMs + 1;
  let estimate = 0;
  if (profile === 'cards' && cardMode === 'cold') {
    estimate = concurrency * actionsPerPlayer * 3 * 1.5;
  } else if (profile === 'mixed') {
    // ~10% card personas plus Portal personas' occasional card view, each
    // minting a new card on a few percent of actions. Generous on purpose.
    estimate = concurrency * actionsPerPlayer * 0.1 + 10;
  }
  return Math.min(MAX_COLD_PLAN, Math.ceil(estimate));
}

/**
 * Every read a player's session makes, once — run before the clock starts so
 * the timed phase measures steady state rather than first-touch effects
 * (achievement unlock inserts, the background card warm a first collection
 * listing schedules, cold renders of the grid).
 */
export function primeRequests(player: VirtualPlayerFixture, cardsAvailable: boolean): RequestSpec[] {
  const out: RequestSpec[] = [];
  const ctx = {
    player,
    rng: seededRng(1),
    cardsAvailable,
    cardMode: 'warm' as const,
    takeCold: () => null,
    noteColdExhausted: () => {},
  };
  for (const action of [...DISCORD_ACTIONS, ...PORTAL_ACTIONS]) {
    for (const step of action.build(ctx)) out.push(...step);
  }
  if (cardsAvailable) {
    for (const id of player.gridWaifuIds) out.push(ownedCard(player, id, false));
  }
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}
