/**
 * Which availability reasons block a deployment. Pure — no DB.
 *
 * The regression this file exists for: the old rule blocked *every* reason
 * except the Buddy, so `favorite` — a reason that only release cares about —
 * hid a player's favourite copies from every mission's candidate list and made
 * `deploy` refuse them.
 */
import { describe, expect, it } from 'vitest';
import { deploymentBlockers } from '../../src/modules/expeditions/expeditionEligibility';
import {
  WAIFU_UNAVAILABILITY_REASONS,
  type WaifuUnavailabilityReason,
} from '../../src/modules/collection/waifuAvailability';

const DEFAULT = { buddyDeployable: false };
const BUDDY_OK = { buddyDeployable: true };

describe('deploymentBlockers', () => {
  it.each([
    ['released', DEFAULT, ['released']],
    ['on_expedition', DEFAULT, ['on_expedition']],
    ['care_target', DEFAULT, ['care_target']],
    ['buddy', DEFAULT, ['buddy']],
    ['buddy', BUDDY_OK, []],
    ['favorite', DEFAULT, []],
    ['favorite', BUDDY_OK, []],
  ] as const)('%s with %o blocks %o', (reason, config, expected) => {
    expect(deploymentBlockers([reason], config)).toEqual(expected);
  });

  it('has a decision for every reason in the vocabulary', () => {
    // A new reason fails here until someone decides whether it blocks.
    const decided = new Set(['released', 'on_expedition', 'care_target', 'buddy', 'favorite']);
    expect(WAIFU_UNAVAILABILITY_REASONS.filter((r) => !decided.has(r))).toEqual([]);
  });

  it('does not block on a reason it has never heard of', () => {
    const future = 'loaned_to_friend' as WaifuUnavailabilityReason;
    expect(deploymentBlockers([future], DEFAULT)).toEqual([]);
    expect(deploymentBlockers([future, 'favorite'], DEFAULT)).toEqual([]);
  });

  it('keeps only the blocking reasons from a mixed list, in order', () => {
    expect(
      deploymentBlockers(['favorite', 'buddy', 'care_target', 'on_expedition'], DEFAULT),
    ).toEqual(['buddy', 'care_target', 'on_expedition']);
    expect(deploymentBlockers(['favorite', 'buddy'], BUDDY_OK)).toEqual([]);
  });

  it('is empty for a free copy', () => {
    expect(deploymentBlockers([], DEFAULT)).toEqual([]);
  });
});
