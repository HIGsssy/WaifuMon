/**
 * Buddy Bonus over the Platform API.
 *
 * The contract under test is narrow and load-bearing: a client that cannot
 * import the bot's source — the Portal is a pure API consumer, asserted by
 * `portal/src/__tests__/architecture.test.ts` — must still print the *same*
 * sentence the bot prints. So the API resolves `targetLabel` and
 * `effectSummary` from the canonical registry and ships them, and nothing here
 * names a species: every case authors a bonus the way a species file would.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { contentSpeciesSchema } from '../../../src/api/schemas/content';
import { toContentSpeciesResource } from '../../../src/api/resources';
import {
  appliedBuddyBonus,
  buddyBonusEffectSummary,
  BUDDY_BONUS_EFFECTS,
  BUDDY_BONUS_EFFECT_IDS,
  type BuddyBonus,
  type BuddyBonusEffectId,
} from '../../../src/modules/buddyBonus/buddyBonusEffects';
import { SpeciesFileSchema } from '../../../src/modules/content/schemas';
import type { LoadedContent } from '../../../src/modules/content/schemas';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/** Content as a species file authors it, parsed by the real content schema. */
function species(slug: string, buddyBonus?: unknown) {
  return SpeciesFileSchema.parse([
    {
      slug,
      name: 'Test Subject',
      rarity: 'SR',
      archetype: 'demon',
      race: 'demon',
      contentRating: 'suggestive',
      affinity: 'dominant',
      imagePath: `waifumon/${slug}/standard.png`,
      ...(buddyBonus ? { buddyBonus } : {}),
    },
  ])[0]!;
}

const HIJACK = {
  name: 'Hijack',
  flavorText: 'She talks to their firmware the way most people talk to a dog.',
  effectId: 'capture_chance',
  value: 15,
  target: { type: 'race', value: 'android' },
};

/**
 * A target that satisfies each effect's rule. Effects that take none get none;
 * `encounter_weight` requires one, so it is handed the first type it allows.
 */
function targetFor(effectId: BuddyBonusEffectId) {
  const rule = BUDDY_BONUS_EFFECTS[effectId];
  const type = rule.allowedTargetTypes[0];
  if (!type || rule.targetOptional === true) return undefined;
  return { type, value: type === 'race' ? 'demon' : 'SR' };
}

// A catalog is irrelevant here and is exercised by the appearance tests.
const NO_APPEARANCES = [] as const;

describe('the species content resource', () => {
  it('resolves the bonus copy from the registry, not from the species file', () => {
    const resource = toContentSpeciesResource(species('hijacker', HIJACK), NO_APPEARANCES);

    expect(resource.buddyBonus).toEqual({
      name: 'Hijack',
      flavorText: 'She talks to their firmware the way most people talk to a dog.',
      effectId: 'capture_chance',
      value: 15,
      target: { type: 'race', value: 'android' },
      targetLabel: 'android Waifumon',
      effectSummary: '+15% capture chance against android Waifumon',
    });
  });

  /**
   * Not `null`, and not `{}`: there is no such thing as an empty Buddy Bonus,
   * and a placeholder would invite a client to render one.
   */
  it('omits the key entirely for a species with no bonus', () => {
    const resource = toContentSpeciesResource(species('plain_jane'), NO_APPEARANCES);

    expect('buddyBonus' in resource).toBe(false);
    expect(contentSpeciesSchema.parse(resource).buddyBonus).toBeUndefined();
  });

  it('serialises every effect id the registry defines', () => {
    for (const effectId of BUDDY_BONUS_EFFECT_IDS) {
      const target = targetFor(effectId);
      const authored: BuddyBonus = {
        name: 'Test Bonus',
        flavorText: 'Authored prose.',
        effectId,
        value: 20,
        ...(target ? { target } : {}),
      };
      const resource = toContentSpeciesResource(
        species(`effect_${effectId}`, authored),
        NO_APPEARANCES,
      );

      // Survives the response schema — which is what actually goes on the wire.
      const parsed = contentSpeciesSchema.parse(resource);
      expect(parsed.buddyBonus?.effectId, effectId).toBe(effectId);
      // And says exactly what a fired bonus would say.
      expect(parsed.buddyBonus?.effectSummary, effectId).toBe(
        buddyBonusEffectSummary(appliedBuddyBonus(authored)),
      );
      expect(parsed.buddyBonus?.effectSummary, effectId).not.toBe('');
    }
  });

  it('carries a null target label when the bonus applies to everything', () => {
    const resource = toContentSpeciesResource(
      species('generalist', { ...HIJACK, target: undefined }),
      NO_APPEARANCES,
    );

    expect(resource.buddyBonus?.target).toBeNull();
    expect(resource.buddyBonus?.targetLabel).toBeNull();
    expect(resource.buddyBonus?.effectSummary).toBe('+15% capture chance');
  });

  it.each([
    [{ type: 'rarity_min', value: 'SSR' }, 'SSR and above'],
    [{ type: 'rarity_max', value: 'R' }, 'R and below'],
    [{ type: 'affinity', value: 'primal' }, 'primal Waifumon'],
    [{ type: 'ownership', value: 'unowned' }, 'not-yet-owned Waifumon'],
  ])('labels a %o qualifier', (target, expected) => {
    const resource = toContentSpeciesResource(
      species('qualified', { ...HIJACK, target }),
      NO_APPEARANCES,
    );

    expect(resource.buddyBonus?.targetLabel).toBe(expected);
    expect(resource.buddyBonus?.effectSummary).toBe(`+15% capture chance against ${expected}`);
  });
});

describe('GET /content/species/:slug', () => {
  let app: ZodFastify | undefined;

  async function build(content: Partial<LoadedContent>): Promise<ZodFastify> {
    app = await createPlatformApiServer({
      config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
      logger: createCapturedLogger('silent').logger,
      probes: createProbes(),
      ctx: createApiContext({ content }),
    });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('emits the bonus with its resolved copy', async () => {
    const server = await build({ species: [species('hijacker', HIJACK)] } as Partial<LoadedContent>);

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/content/species/hijacker',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.buddyBonus).toMatchObject({
      name: 'Hijack',
      effectSummary: '+15% capture chance against android Waifumon',
      targetLabel: 'android Waifumon',
    });
  });

  it('sends no buddyBonus key for a species without one', async () => {
    const server = await build({ species: [species('plain_jane')] } as Partial<LoadedContent>);

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/content/species/plain_jane',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty('buddyBonus');
  });
});
