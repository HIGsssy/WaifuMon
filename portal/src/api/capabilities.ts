/**
 * `/api/v1/capabilities` — which optional backend features exist.
 *
 * The Portal asks once rather than discovering a feature by requesting it and
 * reading the 404. A disabled optional route and a mistyped one are both 404,
 * so probing cannot tell them apart; it also logs as an error and caches badly.
 *
 * The backend is the authority here on purpose. A `VITE_…` copy of the same
 * flag would be a second source of truth, and the failure mode is the confusing
 * one: the UI offering a button for a feature the server does not have.
 */
import { getData } from './client';
import type { PlatformCapabilities } from './types';

/**
 * Every capability off. Used when the API is older than this client, or when
 * the request failed — a feature we cannot confirm is one we do not offer.
 */
export const NO_CAPABILITIES: PlatformCapabilities = { cards: false };

export async function getCapabilities(signal?: AbortSignal): Promise<PlatformCapabilities> {
  const data = await getData<Partial<PlatformCapabilities>>('/v1/capabilities', {
    ...(signal ? { signal } : {}),
  });
  // Additive by contract: unknown keys are ignored, and a key this client
  // expects but the server never sent reads as off.
  return { ...NO_CAPABILITIES, ...data };
}
