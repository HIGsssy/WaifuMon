/**
 * Artwork survives the editor's load → edit → save round trip.
 *
 * The editor keeps a local `Draft` between the server's encounter resource and
 * the save payload, so a field that either mapper forgets is silently dropped:
 * the author sets artwork, saves, and the path quietly reverts. That failure is
 * invisible in the UI, which is exactly the kind worth pinning in a test.
 *
 * Pure functions over plain objects — no rendering, no network.
 */
import { describe, expect, it } from 'vitest';

import { draftFrom, toPayload } from '../encounterDraft';
import type { AdminEncounter } from '@/api/adminEncounters';

function serverEncounter(artworkPath: string | null): AdminEncounter {
  return {
    id: 5,
    slug: 'tv_bandit_ambush',
    name: 'Bandit Ambush',
    description: 'Rough company on the road.',
    type: 'combat',
    rarity: 'uncommon',
    weight: 10,
    lifecycle: 'active',
    huntEligible: false,
    travelEligible: true,
    cooldownSeconds: 1800,
    artworkPath,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    metadata: {},
    choices: [
      {
        id: 51,
        sortOrder: 0,
        label: 'Fight',
        emoji: '⚔️',
        requirements: {},
        check: { type: 'sp', difficulty: 75 },
        successEffects: [{ type: 'waifubux_gain', amount: 350 }],
        failureEffects: [],
      },
    ],
  } as unknown as AdminEncounter;
}

describe('encounter editor: artwork round trip', () => {
  it('carries an authored path from the server through to the save payload', () => {
    const path = 'encounters/bandit_ambush.webp';
    const draft = draftFrom(serverEncounter(path));

    expect(draft.artworkPath).toBe(path);
    expect(toPayload(draft).artworkPath).toBe(path);
  });

  it('keeps "no artwork" as null rather than turning it into an empty string', () => {
    // An empty string would be a path the API then has to reject; null is the
    // canonical "this encounter has no artwork".
    const draft = draftFrom(serverEncounter(null));

    expect(draft.artworkPath).toBeNull();
    expect(toPayload(draft).artworkPath).toBeNull();
  });

  it('saves a newly set path on an encounter that had none', () => {
    const draft = draftFrom(serverEncounter(null));
    const edited = { ...draft, artworkPath: 'encounters/valley_shrine.webp' };

    expect(toPayload(edited).artworkPath).toBe('encounters/valley_shrine.webp');
  });

  it('saves the removal of an existing path', () => {
    const draft = draftFrom(serverEncounter('encounters/bandit_ambush.webp'));
    const edited = { ...draft, artworkPath: null };

    expect(toPayload(edited).artworkPath).toBeNull();
  });

  it('leaves the rest of the encounter untouched while artwork changes', () => {
    // Guards against a mapper that "fixes" artwork by rebuilding the draft and
    // loses something else on the way.
    const draft = draftFrom(serverEncounter(null));
    const before = toPayload(draft);
    const after = toPayload({ ...draft, artworkPath: 'encounters/x.webp' });

    expect({ ...after, artworkPath: null }).toEqual(before);
  });
});
