/**
 * Portal admin API client for Staging Test Controls.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/testControls.ts`, gated on
 * `players.testcontrols`. Those routes exist only on a non-production
 * deployment started with `ENABLE_TEST_ADMIN_CONTROLS=true`; everywhere else
 * every call here answers 404, which the pages report as "not available on
 * this server" rather than as an error.
 *
 * Mutations are session-cookie POSTs with the CSRF header the shared client
 * attaches. The server validates every value against live limits — nothing
 * sent from here is trusted.
 */
import { getData, postData } from './client';

export interface TestControlsInfo {
  enabled: true;
  deploymentEnv: 'staging' | 'development' | 'production';
  stagingBoost: { level: number; waifubux: number };
  maxWaifubuxPerAction: number;
}

export interface TestControlsPlayerState {
  playerId: number;
  discordUserId: string;
  displayName: string;
  level: number;
  xp: number;
  maxLevel: number;
  waifubux: number;
  energy: number;
  maxEnergy: number;
  currentRegion: string;
  currentRegionName: string;
  /** `requiredLevel` null: the Belt has no level requirement. */
  beacon: { slug: string; name: string; owned: boolean; requiredLevel: number | null } | null;
  beltComponents: { slug: string; name: string; owned: number; required: number }[];
  legacyBeltRoute: boolean;
  beltEncounterCooldowns: number;
  passes: { id: string; name: string; owned: boolean }[];
  routes: { regionId: string; name: string; unlocked: boolean; requiredLevel: number | null }[];
  /** Null (or absent from an older server) when the deployment has no Equipment onboarding. */
  equipmentOnboarding?: {
    phase: string;
    nextStep: string | null;
    unlocked: boolean;
    starters: { slot: string; definitionKey: string; granted: boolean; removed: boolean }[];
  } | null;
  /** Today's Delve allowance. Null (or absent from an older server) without the dungeon service. */
  delve?: { limit: number; used: number; remaining: number; periodKey: string } | null;
}

export type TestControlAction =
  | 'test_set_player_level'
  | 'test_add_waifubux'
  | 'test_remove_waifubux'
  | 'test_set_energy'
  | 'test_grant_transporter_beacon'
  | 'test_revoke_transporter_beacon'
  | 'test_grant_travel_access'
  | 'test_staging_boost'
  | 'test_reset_assteroid_belt'
  | 'test_reset_equipment_onboarding'
  | 'test_reset_delve_usage';

export interface TestControlResult {
  action: TestControlAction;
  changed: boolean;
  message: string;
  changes: { field: string; before: unknown; after: unknown }[];
  state: TestControlsPlayerState;
}

const BASE = '/v1/admin/test-controls';
const player = (id: number) => `${BASE}/players/${id}`;

export function getTestControlsInfo(signal?: AbortSignal): Promise<TestControlsInfo> {
  return getData<TestControlsInfo>(BASE, signal ? { signal } : {});
}

export function getTestControlsPlayer(
  playerId: number,
  signal?: AbortSignal,
): Promise<TestControlsPlayerState> {
  return getData<TestControlsPlayerState>(player(playerId), signal ? { signal } : {});
}

/** Every mutation, by the name the page uses. Bodies match the route schemas. */
export const testControlMutations = {
  setLevel: (id: number, level: number) =>
    postData<TestControlResult>(`${player(id)}/level`, { level }),
  addWaifubux: (id: number, amount: number) =>
    postData<TestControlResult>(`${player(id)}/waifubux/add`, { amount }),
  removeWaifubux: (id: number, amount: number) =>
    postData<TestControlResult>(`${player(id)}/waifubux/remove`, { amount }),
  setEnergy: (id: number, energy: number) =>
    postData<TestControlResult>(`${player(id)}/energy`, { energy }),
  grantBeacon: (id: number) => postData<TestControlResult>(`${player(id)}/beacon/grant`),
  revokeBeacon: (id: number) => postData<TestControlResult>(`${player(id)}/beacon/revoke`),
  grantStandardTravel: (id: number) =>
    postData<TestControlResult>(`${player(id)}/travel/grant-standard`),
  stagingBoost: (id: number) => postData<TestControlResult>(`${player(id)}/staging-boost`),
  resetAssteroidBelt: (id: number) =>
    postData<TestControlResult>(`${player(id)}/reset-assteroid-belt`),
  resetEquipmentOnboarding: (id: number) =>
    postData<TestControlResult>(`${player(id)}/reset-equipment-onboarding`),
  resetDelveUsage: (id: number) => postData<TestControlResult>(`${player(id)}/reset-delve-usage`),
} as const;
