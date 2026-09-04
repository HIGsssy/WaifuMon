/**
 * Portal admin API client for World Encounter management.
 *
 * Every function here maps 1:1 to a route in
 * `src/api/routes/v1/admin/encounters.ts`. Types mirror the response
 * schemas — kept intentionally light on shared type files so the admin
 * bundle stays independent of the player-facing bundle.
 */
import { deleteData, getData, patchData, postData, putData } from './client';

export interface AdminEncounterChoice {
  id: number;
  sortOrder: number;
  label: string;
  emoji: string | null;
  requirements: Record<string, unknown>;
  check: Record<string, unknown>;
  successEffects: Array<Record<string, unknown>>;
  failureEffects: Array<Record<string, unknown>>;
}

export interface AdminEncounter {
  id: number;
  slug: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  weight: number;
  lifecycle: 'draft' | 'active' | 'disabled';
  huntEligible: boolean;
  travelEligible: boolean;
  cooldownSeconds: number;
  artworkPath: string | null;
  chainedEncounterSlug: string | null;
  choicesRequired: boolean;
  regions: string[];
  routes: Array<{ fromRegion: string; toRegion: string }>;
  choices: AdminEncounterChoice[];
  metadata: Record<string, unknown>;
}

export interface AdminEncounterReference {
  regions: string[];
  affinities: string[];
  races: string[];
  items: Array<{ slug: string; name: string; category: string }>;
  encounters: Array<{ slug: string; name: string }>;
  species: Array<{ slug: string; name: string; rarity: string }>;
  vendors: Array<{ vendorKey: string; name: string }>;
  types: string[];
  rarities: string[];
  lifecycles: string[];
}

export interface PreviewChoice {
  choiceId: number;
  label: string;
  emoji: string | null;
  available: boolean;
  unavailableReason: string | null;
  chance: number;
  breakdown: {
    base: number;
    spTerm: number;
    levelTerm: number;
    affinityMod: number;
    raceMod: number;
    buddyBonusMod: number;
    baseBias: number;
  };
}

export interface PreviewResponse {
  encounter: AdminEncounter;
  choices: PreviewChoice[];
}

/**
 * The result of an actual N-roll run, not a closed-form estimate.
 *
 * `successRate` is what the run observed; `expectedSuccessRate` is what the
 * formula predicts; `successRateStdError` says how far a fair run of this size
 * is expected to stray, so a reader can tell an unlucky sample from a broken
 * balance number. `seed` reproduces the run exactly.
 */
export interface SimulateAggregate {
  rolls: number;
  successes: number;
  failures: number;
  successRate: number;
  expectedSuccessRate: number;
  successRateDeviation: number;
  successRateStdError: number;
  waifubuxGained: number;
  waifubuxLost: number;
  netWaifubux: number;
  netWaifubuxPerRoll: number;
  expectedNetWaifubuxPerRoll: number;
  essenceGained: number;
  essenceLost: number;
  netEssence: number;
  itemFrequency: Record<string, number>;
  followUpFrequency: Record<string, number>;
  seed: number;
}

export interface SimulateResponse {
  encounter: AdminEncounter;
  choiceId: number;
  aggregate: SimulateAggregate;
}

export interface EncounterInputPayload {
  slug: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  weight: number;
  lifecycle: 'draft' | 'active' | 'disabled';
  huntEligible: boolean;
  travelEligible: boolean;
  cooldownSeconds: number;
  artworkPath: string | null;
  chainedEncounterSlug: string | null;
  choicesRequired: boolean;
  regions: string[];
  routes: Array<{ fromRegion: string; toRegion: string }>;
  choices: Array<{
    label: string;
    emoji: string | null;
    requirements: Record<string, unknown>;
    check: Record<string, unknown>;
    successEffects: Array<Record<string, unknown>>;
    failureEffects: Array<Record<string, unknown>>;
  }>;
  metadata: Record<string, unknown>;
}

export function listAdminEncounters(signal?: AbortSignal): Promise<{ encounters: AdminEncounter[] }> {
  return getData<{ encounters: AdminEncounter[] }>('/v1/admin/encounters', signal ? { signal } : {});
}

export function getAdminEncounter(id: number, signal?: AbortSignal): Promise<AdminEncounter> {
  return getData<AdminEncounter>(`/v1/admin/encounters/${id}`, signal ? { signal } : {});
}

export function getAdminEncounterReference(signal?: AbortSignal): Promise<AdminEncounterReference> {
  return getData<AdminEncounterReference>(
    '/v1/admin/encounters/reference',
    signal ? { signal } : {},
  );
}

export function createAdminEncounter(input: EncounterInputPayload): Promise<AdminEncounter> {
  return postData<AdminEncounter>('/v1/admin/encounters', { input });
}

export function updateAdminEncounter(
  id: number,
  input: EncounterInputPayload,
): Promise<AdminEncounter> {
  return putData<AdminEncounter>(`/v1/admin/encounters/${id}`, { input });
}

export function cloneAdminEncounter(id: number, newSlug: string): Promise<AdminEncounter> {
  return postData<AdminEncounter>(`/v1/admin/encounters/${id}/clone`, { newSlug });
}

export function setAdminEncounterLifecycle(
  id: number,
  lifecycle: 'draft' | 'active' | 'disabled',
): Promise<AdminEncounter> {
  return patchData<AdminEncounter>(`/v1/admin/encounters/${id}/lifecycle`, { lifecycle });
}

export function deleteAdminEncounter(id: number): Promise<{ ok: boolean; reason?: string }> {
  return deleteData<{ ok: boolean; reason?: string }>(`/v1/admin/encounters/${id}`);
}

export interface PreviewBody {
  playerLevel: number;
  buddy: {
    level: number;
    currentSp: number;
    affinity: string;
    race: string;
  } | null;
  buddyBonusPercent: number;
}

export function previewAdminEncounter(id: number, body: PreviewBody): Promise<PreviewResponse> {
  return postData<PreviewResponse>(`/v1/admin/encounters/${id}/preview`, body);
}

export interface SimulateBody extends PreviewBody {
  choiceId: number;
  rolls: number;
  /** Omit to let the server pick one and report it back in the aggregate. */
  seed?: number;
}

export function simulateAdminEncounter(id: number, body: SimulateBody): Promise<SimulateResponse> {
  return postData<SimulateResponse>(`/v1/admin/encounters/${id}/simulate`, body);
}
