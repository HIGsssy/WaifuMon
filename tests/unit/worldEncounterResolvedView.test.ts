/**
 * `buildEncounterResolved` — the outcome screen's follow-up row.
 *
 * The screen has to be honest about three server-side facts it does not
 * control: whether a chained encounter was queued, whether a vendor opened,
 * and whether a wild Waifumon actually appeared. The wild-Waifumon case is
 * the one with real failure modes — the spawn can be refused because the
 * player is already mid-encounter — so the embed narrates the *spawn result*
 * rather than the effect marker, and the button appears only when there is
 * something to open.
 *
 * Pure rendering. No services, no DB.
 */
import { describe, expect, it } from 'vitest';
import { buildEncounterResolved } from '../../src/discord/worldEncounterPresenter';
import type { AppContext } from '../../src/discord/types';
import type {
  EncounterActivation,
  Resolution,
} from '../../src/modules/worldEncounters/worldEncounterService';

const ctx = { config: { assetsDir: './assets' } } as unknown as AppContext;

const activation = {
  activeId: 42,
  encounter: {
    id: 1,
    slug: 'test_wild_bridge',
    name: 'Bridge Test',
    description: 'A rustle in the undergrowth.',
    rarity: 'common',
    artworkPath: null,
    choices: [],
  },
  buddy: null,
  buddyBonusPercent: 0,
  choiceViews: [],
} as unknown as EncounterActivation;

function resolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    encounter: activation.encounter,
    choice: { id: 1, label: 'Look closer' },
    check: { chance: 1, roll: 0, success: true, breakdown: {} },
    effectsApplied: [],
    followUps: [{ kind: 'trigger_waifumon_encounter', payload: {} }],
    chainedEncounterSlug: null,
    continuationActiveId: null,
    vendorInstance: null,
    wildEncounter: null,
    ...overrides,
  } as unknown as Resolution;
}

/**
 * Every custom id on the view, flattened. Ids are the project's namespaced
 * `wm|v1|<domain>|<action>|<args>` form, so the assertions below match on the
 * tail rather than re-deriving the prefix.
 */
function customIds(view: { components?: readonly unknown[] | undefined }): string[] {
  return (view.components ?? []).flatMap((row) => {
    const json = (row as { toJSON: () => { components: Array<{ custom_id?: string }> } }).toJSON();
    return json.components.map((c) => c.custom_id ?? '');
  });
}

function embedText(view: { embeds?: readonly unknown[] | undefined }): string {
  return JSON.stringify(view.embeds);
}

describe('resolved view: spawned wild Waifumon', () => {
  it('offers a button naming her when the spawn succeeded', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        wildEncounter: {
          status: 'created',
          encounterId: 77,
          speciesSlug: 'alley_catgirl',
          speciesName: 'Alley Catgirl',
          blockedByEncounterId: null,
        },
      }),
    );

    expect(customIds(view)).toContain('wm|v1|enc|wild|77');
    expect(embedText(view)).toContain('Alley Catgirl');
  });

  it('still offers the button on a replayed resolution', () => {
    // `existing` means an earlier click already spawned her. The player must
    // still be able to reach her — the button is the only way back.
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        wildEncounter: {
          status: 'existing',
          encounterId: 77,
          speciesSlug: 'alley_catgirl',
          speciesName: 'Alley Catgirl',
          blockedByEncounterId: null,
        },
      }),
    );

    expect(customIds(view)).toContain('wm|v1|enc|wild|77');
    expect(embedText(view)).toContain('still waiting');
  });

  it('offers no button, and says why, when the spawn was blocked', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        wildEncounter: {
          status: 'blocked',
          encounterId: null,
          speciesSlug: 'alley_catgirl',
          speciesName: null,
          blockedByEncounterId: 5,
        },
      }),
    );

    expect(customIds(view).some((id) => id.includes('|enc|wild|'))).toBe(false);
    expect(embedText(view)).toContain('already mid-encounter');
  });

  it('offers no button when the spawn was unavailable', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        wildEncounter: {
          status: 'unavailable',
          encounterId: null,
          speciesSlug: null,
          speciesName: null,
          blockedByEncounterId: null,
        },
      }),
    );

    expect(customIds(view).some((id) => id.includes('|enc|wild|'))).toBe(false);
    expect(embedText(view)).not.toContain('steps out of the trees');
  });

  it('falls back to the marker text when no spawner is wired at all', () => {
    // `wildEncounter: null` is the bot-less/unwired shape. The follow-up is
    // still narrated, just without a promise the code cannot keep.
    const view = buildEncounterResolved(ctx, activation, resolution());
    expect(customIds(view).some((id) => id.includes('|enc|wild|'))).toBe(false);
    expect(embedText(view)).toContain('wild waifumon appears');
  });
});

describe('resolved view: other follow-ups are unaffected', () => {
  it('keeps the Continue button for a chained encounter', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({ followUps: [], continuationActiveId: 99 }),
    );
    expect(customIds(view)).toContain('wm|v1|encw|continue|99');
  });

  it('keeps the Open shop button, keyed on the parent encounter', () => {
    const view = buildEncounterResolved(
      ctx,
      activation,
      resolution({
        followUps: [],
        vendorInstance: { instanceId: 3, vendorKey: 'wandering_merchant' },
      }),
    );
    expect(customIds(view)).toContain('wm|v1|encv|open|42');
  });
});
