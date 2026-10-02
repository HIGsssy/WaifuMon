/**
 * Equipment rewards — the one path every reward source (World Encounters,
 * bosses, expeditions) goes through to hand out a random piece of gear.
 *
 *   reward source decides a drop happens, with a selector
 *     → eligible base definitions (`rewardSelector.ts`)
 *     → one chosen uniformly
 *     → `grantEquipment(… random …)`: multiplier, affix, instance, audit
 *
 * Reward sources never roll a multiplier or an affix and never see a pool:
 * this service picks only the **base definition**, and `grantEquipment` owns
 * everything after that.
 *
 * ## Idempotency
 *
 * A grant key pins the whole reward, not just the instance count. Before
 * selecting anything, a keyed grant looks its first copy up by key; when the
 * reward was already paid it returns that instance — same definition, same
 * multiplier, same affix — without drawing again. That matters because
 * `grantEquipment` refuses a key that was used for a *different* definition,
 * so a retry that re-selected could fail where it should replay.
 *
 * Every write happens through the caller's transaction, so a failed grant
 * rolls back the resolution that asked for it.
 *
 * ## Eligibility: the permanent `equipment` unlock
 *
 * Random gear is for players who have the Equipment feature — the unlock the
 * onboarding grants on completion. Level alone is not enough: Level 35 only
 * makes the onboarding available. {@link EquipmentRewardService.canReceiveRandomEquipmentRewards}
 * is the one answer every reward source asks, and each source asks it at the
 * moment it decides what can drop, so a locked player's draw never contains
 * gear in the first place (nothing is rolled and then thrown away):
 *
 *  - bosses — per participant, at payout, before the roll;
 *  - expeditions — at deploy, before the plan is snapshotted;
 *  - World Encounters — a choice that pays gear is unavailable.
 *
 * Both grant methods re-check it as a backstop and refuse a locked player
 * with `FeatureLockedError`, except a reward the source already {@link
 * GrantChosenEquipmentRewardInput.promised promised} while the player was
 * eligible. The rule lives here, not in `grantEquipment`: onboarding
 * starters, admin and restore grants are explicit and never ask.
 */
import { asc } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { equipmentDefinitions } from '../../db/schema';
import { defaultRng, type Rng } from '../../shared/random';
import type { EquipmentAffixCatalogue } from './affixCatalogue';
import { equipmentDisplayName } from './equipmentRoll';
import type { EquipmentService, GrantKeyRecord } from './equipmentService';
import type { EquipmentDefinitionView, EquipmentInstanceView } from './equipmentQueries';
import { FeatureLockedError, type EquipmentIssue } from '../../shared/errors';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import {
  eligibleRewardDefinitions,
  equipmentSelectorIssues,
  pickRewardDefinition,
  type EquipmentRewardSelector,
  type RewardableDefinition,
} from './rewardSelector';
import type { EquipmentSlot, EquipmentSourceType } from './vocabulary';

/**
 * One granted reward, as a result screen needs it. `affixKey` and
 * `rolledMultiplierBp` are internal — a presenter shows `displayName` and the
 * multiplier formatted, never the key or raw basis points.
 */
export interface EquipmentRewardGrant {
  equipmentId: number;
  definitionKey: string;
  /** The definition's base name. */
  name: string;
  /** Base name plus affix suffix — what every surface shows. */
  displayName: string;
  slot: EquipmentSlot;
  rarity: string;
  rolledMultiplierBp: number;
  affixKey: string | null;
  /** True when the grant key had already been paid and this is that instance. */
  alreadyGranted: boolean;
}

interface RewardGrantCommon {
  playerId: number;
  /** Who is paying. `key` names the authored content (an encounter slug, a boss id, a mission key). */
  source: { type: EquipmentSourceType; key?: string | null };
  /**
   * The reward's stable identity, derived from the parent system's own
   * resolution id. Omit only when the parent cannot retry.
   */
  grantKey?: string | null;
  actorDiscordId?: string | null;
}

export interface GrantRandomEquipmentRewardInput extends RewardGrantCommon {
  selector: EquipmentRewardSelector;
  /**
   * The draw that picks the base definition. A source with derived randomness
   * (bosses) passes its own; otherwise the service's injected RNG is used.
   * Never used for the multiplier or affix.
   */
  rng?: Rng;
}

export interface GrantChosenEquipmentRewardInput extends RewardGrantCommon {
  /** A definition the source already selected through this module. */
  definitionKey: string;
  /**
   * Pay it even if it has since been disabled — for a reward that was won
   * while it was enabled (an expedition whose pool was snapshotted at deploy).
   */
  allowDisabled?: boolean;
  /**
   * The source checked {@link EquipmentRewardService.canReceiveRandomEquipmentRewards}
   * when it promised this reward (an expedition, at deploy) and the promise
   * stands: skip the payout-time eligibility backstop.
   */
  promised?: boolean;
}

export interface EquipmentRewardService {
  /**
   * Whether normal random gear may drop for this player: the permanent
   * `equipment` feature unlock, read through `tx`. Never the player's level.
   */
  canReceiveRandomEquipmentRewards(tx: DbOrTx, playerId: number): Promise<boolean>;
  /** Select a base definition for `selector` and grant one random instance of it. */
  grantRandomEquipmentReward(tx: DbOrTx, input: GrantRandomEquipmentRewardInput): Promise<EquipmentRewardGrant>;
  /** Grant one random instance of a definition the source selected earlier. */
  grantChosenEquipmentReward(tx: DbOrTx, input: GrantChosenEquipmentRewardInput): Promise<EquipmentRewardGrant>;
  /**
   * The definitions `selector` may hand out right now.
   * @throws {EquipmentRewardConfigError} when the selector is invalid or matches nothing.
   */
  eligibleDefinitions(tx: DbOrTx, selector: unknown): Promise<RewardableDefinition[]>;
}

export interface EquipmentRewardServiceDeps {
  equipment: Pick<EquipmentService, 'grantEquipment' | 'findByGrantKeys'>;
  getAffixes(): EquipmentAffixCatalogue;
  /** The eligibility rule: random gear needs the `equipment` unlock. */
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  /** Picks the base definition when a caller supplies no RNG. Injected by tests. */
  rng?: Rng;
}

/**
 * Every definition, enabled or not, as selection sees it. A plain read through
 * `tx` — authoring validation and import planning use it without a service.
 */
export async function listRewardableDefinitions(tx: DbOrTx): Promise<RewardableDefinition[]> {
  return tx
    .select({
      key: equipmentDefinitions.key,
      name: equipmentDefinitions.name,
      slot: equipmentDefinitions.slot,
      rarity: equipmentDefinitions.rarity,
      enabled: equipmentDefinitions.enabled,
    })
    .from(equipmentDefinitions)
    .orderBy(asc(equipmentDefinitions.key));
}

/** A reward table as the selector audit sees it — boss and expedition tables both fit. */
export interface AuditableRewardTable {
  /** `bossRewards["standard-scouting-v1"]` — how a finding names the table. */
  label: string;
  enabled: boolean;
  groups: readonly {
    id: string;
    enabled: boolean;
    equipment?: readonly ({ enabled: boolean } & EquipmentRewardSelector & { weight: number })[] | undefined;
  }[];
}

export interface RewardSelectorFinding {
  location: string;
  selector: EquipmentRewardSelector;
  issues: EquipmentIssue[];
}

/**
 * Every enabled Equipment entry in these tables that the definitions on this
 * server cannot satisfy. Content files load before the database is in reach,
 * so this is how a boss or expedition selector naming a missing, disabled or
 * mismatched definition is heard about at startup — before the boss payout or
 * expedition deploy that would refuse it. Pure over its inputs.
 */
export function auditRewardTableSelectors(
  tables: readonly AuditableRewardTable[],
  definitions: readonly RewardableDefinition[],
): RewardSelectorFinding[] {
  const findings: RewardSelectorFinding[] = [];
  for (const table of tables) {
    if (!table.enabled) continue;
    for (const group of table.groups) {
      if (!group.enabled) continue;
      for (const [index, entry] of (group.equipment ?? []).entries()) {
        if (!entry.enabled) continue;
        const { enabled: _enabled, weight: _weight, ...selector } = entry;
        const issues = equipmentSelectorIssues(selector, definitions);
        if (issues.length > 0) {
          findings.push({ location: `${table.label}.groups["${group.id}"].equipment[${index}]`, selector, issues });
        }
      }
    }
  }
  return findings;
}

function fromInstance(
  definition: EquipmentDefinitionView,
  instance: EquipmentInstanceView,
  alreadyGranted: boolean,
): EquipmentRewardGrant {
  return {
    equipmentId: instance.id,
    definitionKey: definition.key,
    name: definition.name,
    displayName: instance.displayName,
    slot: definition.slot,
    rarity: definition.rarity,
    rolledMultiplierBp: instance.rolledMultiplierBp,
    affixKey: instance.affixKey,
    alreadyGranted,
  };
}

export function createEquipmentRewardService(deps: EquipmentRewardServiceDeps): EquipmentRewardService {
  const rng = deps.rng ?? defaultRng();

  async function canReceiveRandomEquipmentRewards(tx: DbOrTx, playerId: number): Promise<boolean> {
    return deps.featureUnlocks.isUnlocked(playerId, 'equipment', tx);
  }

  /** The backstop: a source that asked first never reaches this throw. */
  async function requireEligible(tx: DbOrTx, playerId: number): Promise<void> {
    if (!(await canReceiveRandomEquipmentRewards(tx, playerId))) throw new FeatureLockedError('equipment');
  }

  function fromRecord(record: GrantKeyRecord): EquipmentRewardGrant {
    return {
      equipmentId: record.equipmentId,
      definitionKey: record.definition.key,
      name: record.definition.name,
      displayName: equipmentDisplayName(record.definition.name, record.affixKey, deps.getAffixes()),
      slot: record.definition.slot,
      rarity: record.definition.rarity,
      rolledMultiplierBp: record.rolledMultiplierBp,
      affixKey: record.affixKey,
      alreadyGranted: true,
    };
  }

  /** The reward this key already paid, if any. Rewards are always one copy: `${key}:0`. */
  async function alreadyPaid(tx: DbOrTx, playerId: number, grantKey: string | null | undefined) {
    if (grantKey == null) return null;
    const stored = `${grantKey}:0`;
    const found = await deps.equipment.findByGrantKeys(tx, playerId, [stored]);
    const record = found.get(stored);
    return record ? fromRecord(record) : null;
  }

  async function grantOne(
    tx: DbOrTx,
    input: RewardGrantCommon & { definitionKey: string; allowDisabled?: boolean },
  ): Promise<EquipmentRewardGrant> {
    const result = await deps.equipment.grantEquipment(tx, {
      playerId: input.playerId,
      definitionKey: input.definitionKey,
      quantity: 1,
      source: input.source,
      grantKey: input.grantKey ?? null,
      actorDiscordId: input.actorDiscordId ?? null,
      ...(input.allowDisabled ? { allowDisabled: true } : {}),
      roll: { kind: 'random' },
    });
    return fromInstance(result.definition, result.instances[0]!, result.alreadyGranted);
  }

  return {
    canReceiveRandomEquipmentRewards,

    async grantRandomEquipmentReward(tx, input) {
      // A replay returns what was already paid, whatever the unlock says now.
      const replay = await alreadyPaid(tx, input.playerId, input.grantKey);
      if (replay) return replay;
      await requireEligible(tx, input.playerId);
      const eligible = eligibleRewardDefinitions(input.selector, await listRewardableDefinitions(tx));
      const chosen = pickRewardDefinition(eligible, input.rng ?? rng);
      return grantOne(tx, { ...input, definitionKey: chosen.key });
    },

    async grantChosenEquipmentReward(tx, input) {
      const replay = await alreadyPaid(tx, input.playerId, input.grantKey);
      if (replay) return replay;
      if (!input.promised) await requireEligible(tx, input.playerId);
      const { promised: _promised, ...grant } = input;
      return grantOne(tx, grant);
    },

    async eligibleDefinitions(tx, selector) {
      return eligibleRewardDefinitions(selector, await listRewardableDefinitions(tx));
    },
  };
}
