/**
 * Characterization of the player-facing hunt filler screens and Let Her Go.
 *
 * Written *before* those screens moved out of `handleHunt` into a presenter,
 * to pin the mechanical information a player reads: the title that names the
 * find, the authoritative amount and balance, the item and its quantity, the
 * level-up and Buddy lines, the Energy footer and the navigation row.
 *
 * Authored presentation (flavor text, artwork) is allowed to appear *around*
 * that information, so these assertions look for the mechanical lines rather
 * than pinning the whole embed. No database: the service doubles return
 * already-resolved results, exactly as `HuntService` hands them over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeTriggerHuntEncounter } = vi.hoisted(() => ({
  maybeTriggerHuntEncounter: vi.fn(async () => false),
}));

vi.mock('../../src/discord/commands/waifumonWorldEncounter', () => ({
  maybeTriggerHuntEncounter,
}));
vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  CARD_FILENAME: 'card.png',
  renderOwnedCardAttachment: vi.fn(async () => null),
  renderEncounterDuplicateCardAttachment: vi.fn(async () => null),
}));

import {
  handleEncounterRelease,
  handleHunt,
} from '../../src/discord/commands/waifumonHunt';
import { buddyBonusFeedbackLines } from '../../src/discord/buddyBonusFeedback';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { HuntResult } from '../../src/modules/hunt/huntService';
import type { AppliedBuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { EncounterNotFoundError } from '../../src/shared/errors';

const PLAYER_ID = 7;
const prov = { playerId: PLAYER_ID, guildDbId: 3 } as unknown as Provisioned;
const FLAVOR_POOL = ['A heart-shaped rock.', 'Only the wind.'];

type Body = {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  files?: unknown[];
};

function makeInteraction() {
  const bodies: Body[] = [];
  const record = vi.fn(async (body: Body) => {
    bodies.push(body);
  });
  return {
    bodies,
    interaction: {
      channelId: 'c-1',
      replied: false,
      deferred: false,
      user: { id: 'u-1' },
      isButton: () => true,
      isStringSelectMenu: () => false,
      update: record,
      reply: record,
      editReply: record,
      followUp: record,
    },
  };
}

const base = {
  levelUps: [],
  buddyAward: null,
  buddyBonuses: [] as AppliedBuddyBonus[],
  careExit: null,
  energySaved: false,
  energyRemaining: 9,
  session: { opened: false, closedPreviousReason: null, at: new Date(), previousLastHuntAt: null },
};

const silkCharm = { id: 11, slug: 'silk_charm', name: 'Silk Charm', emoji: '🪢', enabled: true };
const velvetCharm = { id: 12, slug: 'velvet_charm', name: 'Velvet Charm', emoji: '💜', enabled: true };

function ctxFor(result: HuntResult, overrides: Record<string, unknown> = {}): AppContext {
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => [{ level: 10 }] }) }),
  });
  return {
    config: { assetsDir: './assets' },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    db: { select },
    content: { tables: { hunt: { flavor: FLAVOR_POOL } }, items: [] },
    events: { emit: vi.fn() },
    huntSessions: { open: vi.fn(), close: vi.fn() },
    services: {
      hunt: { hunt: vi.fn(async () => result) },
      session: {
        ensureSession: vi.fn(async () => ({ id: 1 })),
        recordEvent: vi.fn(async () => {}),
      },
      travel: { getCurrentRegion: vi.fn(async () => 'waifu-valley') },
      ...overrides,
    },
  } as unknown as AppContext;
}

function lastBody(bodies: Body[]): Body {
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[bodies.length - 1]!;
}

function embedOf(body: Body): {
  title?: string;
  description?: string;
  footer?: { text?: string };
} {
  return JSON.parse(JSON.stringify(body.embeds?.[0] ?? {}));
}

function customIds(body: Body): string[] {
  return (JSON.stringify(body.components ?? []).match(/"custom_id":"([^"]+)"/g) ?? []).map(
    (m) => m.slice('"custom_id":"'.length, -1),
  );
}

async function paint(result: HuntResult): Promise<Body> {
  const { bodies, interaction } = makeInteraction();
  await handleHunt(ctxFor(result), interaction as never, prov);
  return lastBody(bodies);
}

beforeEach(() => {
  maybeTriggerHuntEncounter.mockReset();
  maybeTriggerHuntEncounter.mockResolvedValue(false);
});

describe('hunt filler screens — mechanical output', () => {
  it('WaifuBux find: title, authoritative amount and balance, Energy footer, navigation', async () => {
    const body = await paint({
      ...base,
      kind: 'waifubux_find',
      amount: 12,
      balanceAfter: 112,
    } as HuntResult);
    const embed = embedOf(body);
    expect(embed.title).toBe('💰 WaifuBux Found');
    expect(embed.description).toContain('+**12** WaifuBux (balance: 112)');
    expect(embed.footer?.text).toBe('Energy left: 9');
    expect(customIds(body)).toEqual(['wm|v1|menu|hunt', 'wm|v1|menu|back']);
  });

  it('Essence find: the final amount and the Buddy Bonus that raised it', async () => {
    const bonus: AppliedBuddyBonus = {
      name: 'Extra Serving',
      effectId: 'essence_gain',
      value: 30,
      target: null,
      targetLabel: null,
      baseValue: 20,
      finalValue: 26,
    };
    const body = await paint({
      ...base,
      kind: 'essence_find',
      amount: 26,
      balanceAfter: 226,
      buddyBonuses: [bonus],
    } as HuntResult);
    const embed = embedOf(body);
    expect(embed.title).toBe('✨ Essence Found');
    expect(embed.description).toContain('+**26** Essence (balance: 226)');
    for (const line of buddyBonusFeedbackLines([bonus])) {
      expect(embed.description).toContain(line);
    }
    expect(embed.footer?.text).toBe('Energy left: 9');
  });

  it('item find: emoji, name and quantity', async () => {
    const body = await paint({
      ...base,
      kind: 'item_find',
      item: silkCharm,
      quantity: 2,
    } as unknown as HuntResult);
    const embed = embedOf(body);
    expect(embed.title).toBe('🎒 Item Found');
    expect(embed.description).toContain('🪢 **Silk Charm** ×2');
  });

  it('rare item find: keeps the rare distinction', async () => {
    const body = await paint({
      ...base,
      kind: 'rare_item_find',
      item: velvetCharm,
      quantity: 1,
    } as unknown as HuntResult);
    const embed = embedOf(body);
    expect(embed.title).toBe('🌟 Rare Find!');
    expect(embed.description).toContain('💜 **Velvet Charm** ×1');
  });

  it('nothing found: shows a line from the content flavor pool', async () => {
    const body = await paint({
      ...base,
      kind: 'flavor',
    } as HuntResult);
    const embed = embedOf(body);
    expect(embed.title).toBe('🍃 Nothing but wind…');
    expect(FLAVOR_POOL.some((line) => embed.description?.includes(line))).toBe(true);
    expect(embed.footer?.text).toBe('Energy left: 9');
    expect(customIds(body)).toEqual(['wm|v1|menu|hunt', 'wm|v1|menu|back']);
  });

  it('appends level-up lines after the find', async () => {
    const body = await paint({
      ...base,
      kind: 'waifubux_find',
      amount: 5,
      balanceAfter: 5,
      levelUps: [{ fromLevel: 4, toLevel: 5, rewardLabels: ['50 WaifuBux'] }],
    } as unknown as HuntResult);
    const description = embedOf(body).description ?? '';
    expect(description).toContain('⬆️ **Level 5!** — 50 WaifuBux');
    expect(description.indexOf('+**5** WaifuBux')).toBeLessThan(description.indexOf('Level 5'));
  });

  it('does not paint the find screen itself when a World Encounter takes the turn', async () => {
    maybeTriggerHuntEncounter.mockResolvedValue(true);
    const { bodies, interaction } = makeInteraction();
    await handleHunt(
      ctxFor({ ...base, kind: 'waifubux_find', amount: 5, balanceAfter: 5 } as HuntResult),
      interaction as never,
      prov,
    );
    expect(maybeTriggerHuntEncounter).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(0);
  });
});

describe('Let Her Go — handler', () => {
  const released = {
    id: 55,
    playerId: PLAYER_ID,
    speciesId: 3,
    channelId: 'c-1',
    state: 'released',
    attemptCount: 0,
    maxAttempts: 3,
    selectedItemId: null,
    regionId: 'waifu-valley',
    originKind: null,
    originRef: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    resolvedAt: new Date(),
  };

  /** Doubles that throw: releasing must never reach capture, items or currency. */
  const forbidden = {
    capture: new Proxy({}, { get: () => () => { throw new Error('capture touched'); } }),
    inventory: new Proxy({}, { get: () => () => { throw new Error('inventory touched'); } }),
    currency: new Proxy({}, { get: () => () => { throw new Error('currency touched'); } }),
    itemUse: new Proxy({}, { get: () => () => { throw new Error('itemUse touched'); } }),
  };

  it('releases through HuntService and keeps the release line and a way back', async () => {
    const letHerGo = vi.fn(async () => released);
    const { bodies, interaction } = makeInteraction();
    const ctx = ctxFor({ ...base, kind: 'flavor' } as unknown as HuntResult, {
      hunt: { letHerGo },
      appearance: { currentAppearance: () => ({ assetId: null }) },
      ...forbidden,
    });
    await handleEncounterRelease(ctx, interaction as never, prov, ['55']);

    expect(letHerGo).toHaveBeenCalledWith(PLAYER_ID, 55);
    const body = lastBody(bodies);
    expect(JSON.stringify(body)).toContain('You let her slip back into the neon~');
    expect(customIds(body)).toContain('wm|v1|menu|back');
  });

  it('answers a stale release with the domain message and writes nothing else', async () => {
    const err = new EncounterNotFoundError();
    const letHerGo = vi.fn(async () => {
      throw err;
    });
    const { bodies, interaction } = makeInteraction();
    const ctx = ctxFor({ ...base, kind: 'flavor' } as unknown as HuntResult, {
      hunt: { letHerGo },
      ...forbidden,
    });
    await handleEncounterRelease(ctx, interaction as never, prov, ['55']);
    expect(lastBody(bodies).content).toBe(err.userMessage);
  });

  it('rejects a malformed encounter id without releasing anything', async () => {
    const letHerGo = vi.fn();
    const { bodies, interaction } = makeInteraction();
    const ctx = ctxFor({ ...base, kind: 'flavor' } as unknown as HuntResult, {
      hunt: { letHerGo },
    });
    await handleEncounterRelease(ctx, interaction as never, prov, ['not-a-number']);
    expect(letHerGo).not.toHaveBeenCalled();
    expect(lastBody(bodies).content).toBe('That encounter is no longer active.');
  });
});
