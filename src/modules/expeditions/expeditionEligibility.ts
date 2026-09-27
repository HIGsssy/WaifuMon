/**
 * Which availability reasons stop a copy being deployed — pure.
 *
 * The availability service reports *facts* (see `waifuAvailability.ts`); each
 * operation decides which of them it cares about. This is the expedition
 * policy, and the one place it lives: `getCandidates` uses it to decide what
 * the select menu offers, and `deploy` uses it to decide what it accepts, so
 * the two can never disagree about who may go.
 *
 * It is an allow-list of *blocking* reasons rather than a list of exemptions.
 * A reason added to the vocabulary later ("loaned to a friend") does not block
 * a deployment until someone decides here that it should — which is exactly
 * the failure the exemption form had: `favorite` exists for release, was never
 * exempted here, and silently hid players' favourite copies from every
 * mission.
 */
import type { WaifuUnavailabilityReason } from '../collection/waifuAvailability';

/** Reasons that always block, whatever content says. */
const ALWAYS_BLOCKING: ReadonlySet<WaifuUnavailabilityReason> = new Set([
  'released',
  'on_expedition',
  'care_target',
]);

/**
 * The subset of `reasons` that prevents deployment, in the order given.
 *
 *   - released, on an expedition, the Care target → blocked;
 *   - the Buddy → blocked unless content sets `buddyDeployable`;
 *   - a favourite, and anything else → not blocked.
 */
export function deploymentBlockers(
  reasons: readonly WaifuUnavailabilityReason[],
  config: { buddyDeployable: boolean },
): WaifuUnavailabilityReason[] {
  return reasons.filter((reason) =>
    reason === 'buddy' ? !config.buddyDeployable : ALWAYS_BLOCKING.has(reason),
  );
}
