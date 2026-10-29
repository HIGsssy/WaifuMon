/**
 * The Admin Equipment Catalogue (Equipment 3.0, E3-D) — what the Portal's
 * equipment routes call. It composes the existing services and adds no
 * second set of rules:
 *
 *  - **Definitions** are written only through `equipmentDefinitionService`
 *    (shared schema, key immutability, slot and rarity locks, roll-policy
 *    feasibility, integer `revision`, audit rows).
 *  - **Packages** go through `equipmentImportService` with the Catalogue
 *    defaults (new definitions start disabled; updated ones keep their
 *    enabled state) and the preview → `planHash` → apply stale check.
 *  - **Roll previews** use the real engine (`rollEquipmentInstance`,
 *    `analyseHighRarityRoll`) on the published rules, with an explicit seed
 *    and a private RNG. Nothing is granted, stored or logged.
 *  - **Reward impact** resolves every live automatic selector with the real
 *    selector functions (`eligibleRewardDefinitions`) — never a guess from
 *    rarity. SSR/UR/LR can never appear there: selectors, loot tables and
 *    recipes stay on `EQUIPMENT_REWARD_RARITIES`.
 *
 * The Catalogue's own server-side rules: a created or duplicated definition
 * always starts **disabled**; an edit never changes the enabled state (that
 * is the separate enable/disable action); and enabling an N/R/SR definition
 * that would join an automatic reward source at once is refused until the
 * request acknowledges that impact.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  dungeonLootTables,
  equipmentAdminEvents,
  equipmentDefinitions,
  equipmentImportLog,
  playerEquipment,
  rewardTables,
  worldEncounterChoices,
  worldEncounters,
  type EquipmentDefinitionRow,
} from '../../db/schema';
import {
  EquipmentDefinitionNotFoundError,
  EquipmentEnableConfirmationRequiredError,
  EquipmentExportRefusedError,
  EquipmentValidationError,
  type EquipmentIssue,
} from '../../shared/errors';
import { seededRng } from '../../shared/random';
import { parseRewardTableRow } from '../rewardTables/rewardTableStore';
import { equipmentSelectorsOf } from '../rewardTables/rewardTableCore';
import { affixPoolOf, isEquipmentAffixPool, type EquipmentAffixCatalogue } from './affixCatalogue';
import {
  COMBAT_BONUS_LABELS,
  FLAT_SP_BONUS_STAT,
  eligibleCombatBonusFamilies,
  isCombatBonusRarity,
  type CombatBonus,
} from './combatBonuses';
import {
  definitionInputFromRow,
  validateEquipmentDefinition,
  type EquipmentDefinitionInput,
} from './definitionSchema';
import {
  assertDefinitionRevision,
  countDefinitionInstances,
  type EquipmentDefinitionService,
} from './equipmentDefinitionService';
import type { EquipmentPromotionService, ImportPreview } from './equipmentImportService';
import { itemFlatSpOf } from './equipmentMath';
import type { EquipmentPackage } from './equipmentPackage';
import { listRewardableDefinitions } from './equipmentRewardService';
import {
  equipmentDisplayName,
  multiplierRangeIssues,
  multiplierValues,
  rollEquipmentInstance,
  rolledPropertiesOf,
} from './equipmentRoll';
import type { EquipmentRollRulesService } from './equipmentRollRulesService';
import { analyseHighRarityRoll, definitionRollPolicyIssues, isHighRarity, planHighRarityRoll, type ResolvedAffixLibrary } from './highRarityRoll';
import {
  describeEquipmentSelector,
  eligibleRewardDefinitions,
  EQUIPMENT_REWARD_RARITIES,
  type EquipmentRewardSelector,
  type RewardableDefinition,
} from './rewardSelector';
import { EQUIPMENT_AUTHORING_RARITIES, EQUIPMENT_SLOTS, WORKSHOP_SLOT_CHOICES, type EquipmentSlot } from './vocabulary';
import type { WorkshopConfig } from './workshopConfig';
import { fabricationSelector } from './equipmentWorkshopService';

// ── read models ───────────────────────────────────────────────────────────

export interface CatalogueDefinition extends EquipmentDefinitionInput {
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
  /** Copies players hold now. */
  ownedCount: number;
  /** Every copy ever granted, removed ones included — what locks slot and rarity. */
  instanceCount: number;
}

export type CatalogueSort = 'key' | 'name' | 'rarity' | 'slot' | 'updated' | 'owned';
export const CATALOGUE_SORTS: readonly CatalogueSort[] = ['key', 'name', 'rarity', 'slot', 'updated', 'owned'];
export const CATALOGUE_MAX_PAGE_SIZE = 100;

export interface CatalogueQuery {
  /** Case-insensitive substring of key, name or description. */
  q?: string;
  rarity?: string;
  slot?: string;
  status?: 'enabled' | 'disabled';
  sort?: CatalogueSort;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface CatalogueCounts {
  total: number;
  enabled: number;
  disabled: number;
  byRarity: Record<string, number>;
}

export interface CataloguePage {
  definitions: CatalogueDefinition[];
  /** Matching the filters, before paging. */
  total: number;
  page: number;
  pageSize: number;
  /** The whole catalogue, unfiltered. */
  counts: CatalogueCounts;
}

/** Which fields the existing copies pin, and why. */
export interface DefinitionLocks {
  slotLocked: boolean;
  rarityLocked: boolean;
  instanceCount: number;
}

export interface CatalogueDetail {
  definition: CatalogueDefinition;
  locks: DefinitionLocks;
  roll: RollAnalysis;
  availability: Availability;
}

/** Enabled, rollable and rewarded are three different facts; obtainable needs all three. */
export interface Availability {
  enabled: boolean;
  /** `legacy` N/R/SR rules; `published` / `unconfigured` / `invalid` high-rarity rules. */
  rollConfiguration: 'legacy' | 'published' | 'unconfigured' | 'invalid' | 'unsupported';
  /** A random grant of it would roll now. */
  rollable: boolean;
  /** Its rarity can be named by automatic reward sources (N/R/SR only). */
  rewardRarity: boolean;
  /** Plain-language summary for the editor. */
  summary: string;
}

export interface BonusFamilyRange {
  stat: string;
  label: string;
  unit: 'percent' | 'sp';
  min: number;
  max: number;
  step: number;
}

export type RollAnalysis =
  | {
      mode: 'legacy';
      rarity: string;
      multiplier: { min: number; max: number; step: number; values: number };
      bonusChanceBp: number;
      bonusCount: number;
      families: BonusFamilyRange[];
      affixPool: string;
      enabledAffixes: number;
      issues: EquipmentIssue[];
    }
  | {
      mode: 'high';
      rarity: string;
      rulesRevision: number | null;
      configured: boolean;
      rollable: boolean;
      issues: EquipmentIssue[];
      multiplier: { min: number; max: number; step: number; values: number };
      primarySpEligible: boolean;
      maxAdditionalBonuses: number | null;
      counts: { count: number; probability: number }[];
      families: BonusFamilyRange[];
      primarySp: { probability: number; min: number; max: number; step: number } | null;
      affix: { mode: 'none' } | { mode: 'library'; library: string; revision: number | null; candidates: number | null };
      /** The flat SP one copy can carry, primary plus additional. */
      spRange: { min: number; max: number };
    }
  | { mode: 'unsupported'; rarity: string; issues: EquipmentIssue[] };

export interface SampleRoll {
  displayName: string;
  rolledMultiplierBp: number;
  affixKey: string | null;
  combatBonuses: CombatBonus[];
  primarySp: number;
  totalFlatSp: number;
}

export interface RollPreview {
  analysis: RollAnalysis;
  availability: Availability;
  /** Present when samples were asked for and the definition can roll. */
  samples: SampleRoll[] | null;
  seed: number | null;
  sampleError: string | null;
}

export type RewardSourceKind = 'boss_reward_table' | 'expedition_reward_table' | 'world_encounter' | 'workshop_recipe' | 'dungeon_loot_table';

export interface RewardImpactEntry {
  source: RewardSourceKind;
  key: string;
  name: string;
  /** Where in the source, in admin words. */
  location: string;
  selector: string;
  /** When the source would start paying it. */
  when: 'immediately' | 'next_deploy' | 'next_publish';
}

export interface RewardImpact {
  /** Its rarity is one random rewards can hand out (N/R/SR). */
  rewardRarity: boolean;
  /** Sources that would pay it as soon as it is enabled. */
  automatic: RewardImpactEntry[];
  /** Sources that snapshot their pools: they would include it the next time they are deployed or published. */
  deferred: RewardImpactEntry[];
}

/**
 * A package definition whose `artworkPath` this server cannot serve. Artwork
 * travels in the assets release, not in the package, so this is a warning:
 * it never blocks the import or changes its `planHash`.
 */
export interface ImportArtworkWarning {
  key: string;
  artworkPath: string;
  /** `missing`: no file at that path here. `unsafe`: the path resolves outside the assets root. */
  status: 'missing' | 'unsafe';
}

export interface CatalogueImportPreview extends ImportPreview {
  /** For each N/R/SR definition the import would create, what it would join once enabled. */
  rewardImpact: { key: string; impact: RewardImpact }[];
  /** `checked` is false when this server was built without an assets directory to look in. */
  artwork: { checked: boolean; warnings: ImportArtworkWarning[] };
}

export interface CatalogueHistoryEntry {
  id: number;
  key: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface CatalogueImportLogEntry {
  id: number;
  actor: string | null;
  appliedAt: Date;
  packageVersion: number;
  packageLabel: string | null;
  sourceFilename: string | null;
  created: number;
  updated: number;
  unchanged: number;
  definitionKeys: string[];
}

export interface EquipmentCatalogueService {
  list(query?: CatalogueQuery): Promise<CataloguePage>;
  get(key: string): Promise<CatalogueDetail | null>;
  /** Every issue saving `input` would raise, without writing. `creating` also checks the key is free. */
  validate(input: unknown, opts: { creating: boolean; key?: string }): Promise<EquipmentIssue[]>;
  /** Always created disabled, whatever `input.enabled` says. */
  create(input: unknown, actor: string | null): Promise<CatalogueDetail>;
  /** The stored enabled state is kept; use `setEnabled`. */
  update(key: string, input: unknown, opts: { expectedRevision: number; actor: string | null }): Promise<CatalogueDetail>;
  setEnabled(
    key: string,
    enabled: boolean,
    opts: { expectedRevision: number; acknowledgeRewardImpact?: boolean; actor: string | null },
  ): Promise<CatalogueDetail>;
  /** A new key with the source's authoring fields, through the normal create path; starts disabled. */
  duplicate(sourceKey: string, opts: { key: string; name?: string; actor: string | null }): Promise<CatalogueDetail>;
  /** Automatic reward sources this definition (or an unsaved input) would join if enabled. */
  impact(definition: Pick<RewardableDefinition, 'key' | 'slot' | 'rarity'>): Promise<RewardImpact>;
  /** Analysis, and optionally seeded sample rolls, for a stored key or an unsaved input. Writes nothing. */
  previewRoll(target: { key: string } | { input: unknown }, opts?: { seed?: number; count?: number }): Promise<RollPreview>;
  /**
   * No `keys` and no `query` exports everything. `keys` (wins over `query`)
   * exports exactly those; `query` exports what the list would show. A scope
   * that matches nothing is refused (`empty`), never widened.
   */
  exportPackage(opts?: { keys?: readonly string[]; query?: CatalogueQuery; label?: string | null }): Promise<EquipmentPackage>;
  previewImport(raw: unknown): Promise<CatalogueImportPreview>;
  applyImport(raw: unknown, opts: { expectedPlanHash: string; actor: string | null; sourceFilename?: string | null }): ReturnType<EquipmentPromotionService['applyImport']>;
  history(opts?: { key?: string; limit?: number }): Promise<{ events: CatalogueHistoryEntry[]; imports: CatalogueImportLogEntry[] }>;
}

export interface EquipmentCatalogueServiceDeps {
  db: Db;
  definitions: EquipmentDefinitionService;
  promotion: EquipmentPromotionService;
  rollRules: Pick<EquipmentRollRulesService, 'forGrant' | 'affixLibraryForGrant'>;
  getAffixes(): EquipmentAffixCatalogue;
  getWorkshopConfig(): WorkshopConfig | null;
  /** Whether this server's assets root can serve an artwork path (`locateArtworkFile`); omitted, previews skip the check. */
  artworkStatus?(relativePath: string): 'available' | 'missing' | 'unsafe';
}

export const SAMPLE_ROLL_MAX = 20;
const RARITY_ORDER = EQUIPMENT_AUTHORING_RARITIES as readonly string[];
const isRewardRarity = (rarity: string) => (EQUIPMENT_REWARD_RARITIES as readonly string[]).includes(rarity);

function familyRange(stat: string, min: number, max: number, step: number): BonusFamilyRange {
  const label = (COMBAT_BONUS_LABELS as Record<string, string>)[stat] ?? stat;
  return { stat, label, unit: stat === FLAT_SP_BONUS_STAT ? 'sp' : 'percent', min, max, step };
}

/** Every `{ type: 'equipment', selector }` grant in a JSON body, wherever it sits. */
function selectorsInBody(value: unknown, out: EquipmentRewardSelector[] = []): EquipmentRewardSelector[] {
  if (Array.isArray(value)) {
    for (const v of value) selectorsInBody(v, out);
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.type === 'equipment' && o.selector && typeof o.selector === 'object') out.push(o.selector as EquipmentRewardSelector);
    for (const v of Object.values(o)) selectorsInBody(v, out);
  }
  return out;
}

export function createEquipmentCatalogueService(deps: EquipmentCatalogueServiceDeps): EquipmentCatalogueService {
  const { db } = deps;

  async function counts(tx: DbOrTx, ids: readonly number[]) {
    const owned = new Map<number, number>();
    const all = new Map<number, number>();
    if (ids.length === 0) return { owned, all };
    const rows = await tx
      .select({ id: playerEquipment.definitionId, removedAt: playerEquipment.removedAt })
      .from(playerEquipment)
      .where(inArray(playerEquipment.definitionId, [...ids]));
    for (const r of rows) {
      all.set(r.id, (all.get(r.id) ?? 0) + 1);
      if (r.removedAt == null) owned.set(r.id, (owned.get(r.id) ?? 0) + 1);
    }
    return { owned, all };
  }

  function toCatalogue(row: EquipmentDefinitionRow, owned: number, instances: number): CatalogueDefinition {
    return {
      ...definitionInputFromRow(row),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      ownedCount: owned,
      instanceCount: instances,
    };
  }

  async function rowByKey(tx: DbOrTx, key: string) {
    const [row] = await tx.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, key));
    return row ?? null;
  }

  // ── roll analysis ───────────────────────────────────────────────────────

  /** The published rules and, if the rarity draws from one, its library — read-only. */
  async function rollContext(definition: { rarity: string }) {
    return db.transaction(async (tx) => {
      const rules = await deps.rollRules.forGrant(tx).catch(() => null);
      let library: ResolvedAffixLibrary | null = null;
      if (rules && isHighRarity(definition.rarity)) {
        const assignment = rules.rules.rarities[definition.rarity]?.affixes;
        if (assignment?.mode === 'library') library = await deps.rollRules.affixLibraryForGrant(tx, rules, assignment.library);
      }
      return { rules, library };
    });
  }

  function analyse(
    definition: EquipmentDefinitionInput,
    ctx: Awaited<ReturnType<typeof rollContext>>,
  ): { analysis: RollAnalysis; availability: Availability } {
    const multiplier = {
      min: definition.multiplierMinBp,
      max: definition.multiplierMaxBp,
      step: definition.multiplierStepBp,
      values: multiplierRangeIssues(definition.slot, definition).length === 0 ? multiplierValues(definition).length : 0,
    };
    const rewardRarity = isRewardRarity(definition.rarity);
    const rangeIssues = multiplierRangeIssues(definition.slot, definition);

    const legacyRarity = definition.rarity;
    if (isCombatBonusRarity(legacyRarity)) {
      const pool = affixPoolOf(definition);
      const affixes = isEquipmentAffixPool(pool) ? deps.getAffixes().rollable(pool) : [];
      const issues: EquipmentIssue[] = [...rangeIssues];
      if (affixes.length === 0) issues.push({ path: 'affixes', message: `affix pool ${pool} has no enabled affix` });
      if (!ctx.rules) issues.push({ path: 'rules', message: 'the roll rules have not been initialised on this server' });
      const catalogue = ctx.rules?.combatBonuses;
      const rule = catalogue?.rarityRules[legacyRarity];
      const families = catalogue
        ? eligibleCombatBonusFamilies(catalogue, definition.slot, legacyRarity).map((f) => {
            const r = f.ranges[legacyRarity];
            return familyRange(f.stat, r.minBp, r.maxBp, f.stepBp);
          })
        : [];
      const rollable = issues.length === 0;
      return {
        analysis: {
          mode: 'legacy',
          rarity: definition.rarity,
          multiplier,
          bonusChanceBp: rule?.bonusChanceBp ?? 0,
          bonusCount: rule?.bonusCount ?? 0,
          families,
          affixPool: pool,
          enabledAffixes: affixes.length,
          issues,
        },
        availability: {
          enabled: definition.enabled,
          rollConfiguration: 'legacy',
          rollable,
          rewardRarity,
          summary: !definition.enabled
            ? 'Disabled: no reward, recipe or grant can hand it out.'
            : rollable
              ? 'Enabled: reward sources whose selectors match it can hand it out.'
              : 'Enabled, but a random grant of it would fail: see the issues.',
        },
      };
    }

    if (!isHighRarity(definition.rarity)) {
      return {
        analysis: { mode: 'unsupported', rarity: definition.rarity, issues: [{ path: 'rarity', message: `${definition.rarity} cannot be rolled` }] },
        availability: { enabled: definition.enabled, rollConfiguration: 'unsupported', rollable: false, rewardRarity: false, summary: 'This rarity cannot be rolled.' },
      };
    }

    const rules = ctx.rules?.rules ?? null;
    const rule = rules?.rarities[definition.rarity] ?? null;
    const configured = rule != null;
    const highCtx = rules ? { rules, affixLibrary: ctx.library } : null;
    const planned = highCtx ? planHighRarityRoll({ ...definition }, highCtx) : null;
    const analysed = highCtx ? analyseHighRarityRoll({ ...definition }, highCtx) : null;
    const issues: EquipmentIssue[] = [
      ...rangeIssues,
      ...(planned && !planned.ok ? planned.issues : []),
      ...(!rules ? [{ path: 'rules', message: 'the roll rules have not been initialised on this server' }] : []),
    ];
    const families = (planned?.ok ? planned.plan.families : rule?.families.filter((f) => f.enabled && (f.slots as readonly string[]).includes(definition.slot)) ?? []).map(
      (f) => familyRange(f.stat, f.minValue, f.maxValue, f.step),
    );
    const ok = analysed?.ok === true ? analysed.analysis : null;
    const sp = definition.primarySpEligible && rule?.primarySp && rule.primarySp.chanceBp > 0 ? rule.primarySp : null;
    const flat = families.find((f) => f.stat === FLAT_SP_BONUS_STAT);
    const canRollFlat = (ok?.counts ?? []).some((c) => c.count > 0);
    const rollable = rangeIssues.length === 0 && planned?.ok === true;
    const rollConfiguration = !configured ? 'unconfigured' : planned?.ok ? 'published' : 'invalid';
    return {
      analysis: {
        mode: 'high',
        rarity: definition.rarity,
        rulesRevision: ctx.rules?.revision ?? null,
        configured,
        rollable,
        issues,
        multiplier,
        primarySpEligible: definition.primarySpEligible,
        maxAdditionalBonuses: definition.maxAdditionalBonuses,
        counts: (ok?.counts ?? []).map((c) => ({ count: c.count, probability: c.probability })),
        families,
        primarySp: sp ? { probability: sp.chanceBp / 10_000, min: sp.min, max: sp.max, step: sp.step } : null,
        affix: !rule
          ? { mode: 'none' }
          : rule.affixes.mode === 'none'
            ? { mode: 'none' }
            : {
                mode: 'library',
                library: rule.affixes.library,
                revision: ctx.library?.revision ?? null,
                candidates: planned?.ok ? (planned.plan.affix?.candidates.length ?? 0) : null,
              },
        spRange: {
          min: sp && sp.chanceBp >= 10_000 ? sp.min : 0,
          max: (sp?.max ?? 0) + (flat && canRollFlat ? flat.max : 0),
        },
      },
      availability: {
        enabled: definition.enabled,
        rollConfiguration,
        rollable,
        rewardRarity: false,
        summary: !configured
          ? `No ${definition.rarity} roll rules are published, so it cannot be rolled yet.`
          : !rollable
            ? `The published ${definition.rarity} rules cannot roll it: see the issues.`
            : definition.enabled
              ? 'Enabled and rollable — but no reward source can grant SSR/UR/LR equipment yet, so players cannot obtain it.'
              : 'Rollable under the published rules once enabled. No reward source can grant SSR/UR/LR equipment yet.',
      },
    };
  }

  function sample(definition: EquipmentDefinitionInput, ctx: Awaited<ReturnType<typeof rollContext>>, seed: number, count: number): SampleRoll[] {
    // A private stream: never the grant RNG, never stored.
    const rng = seededRng(seed);
    const affixes = deps.getAffixes();
    const highRarity = ctx.rules && isHighRarity(definition.rarity) ? { rules: ctx.rules.rules, affixLibrary: ctx.library } : null;
    return Array.from({ length: count }, () => {
      const roll = rollEquipmentInstance(definition, {
        rng,
        affixes,
        combatBonuses: ctx.rules?.combatBonuses ?? null,
        highRarity,
      });
      const props = rolledPropertiesOf(roll);
      return {
        displayName: equipmentDisplayName(definition.name, roll.affixKey, affixes, props),
        rolledMultiplierBp: roll.rolledMultiplierBp,
        affixKey: roll.affixKey,
        combatBonuses: roll.combatBonuses,
        primarySp: roll.flatSp ?? 0,
        totalFlatSp: itemFlatSpOf({ rolledProperties: props, combatBonuses: roll.combatBonuses }).contribution,
      };
    });
  }

  async function detailOf(row: EquipmentDefinitionRow): Promise<CatalogueDetail> {
    const { owned, all } = await counts(db, [row.id]);
    const definition = toCatalogue(row, owned.get(row.id) ?? 0, all.get(row.id) ?? 0);
    const { analysis, availability } = analyse(definition, await rollContext(definition));
    return {
      definition,
      locks: { slotLocked: definition.instanceCount > 0, rarityLocked: definition.instanceCount > 0, instanceCount: definition.instanceCount },
      roll: analysis,
      availability,
    };
  }

  // ── reward impact ───────────────────────────────────────────────────────

  async function impactOf(definition: Pick<RewardableDefinition, 'key' | 'slot' | 'rarity'>): Promise<RewardImpact> {
    const rewardRarity = isRewardRarity(definition.rarity);
    if (!rewardRarity) return { rewardRarity, automatic: [], deferred: [] };
    const live = (await listRewardableDefinitions(db)).filter((d) => d.key !== definition.key);
    const name = (await rowByKey(db, definition.key))?.name ?? definition.key;
    const asEnabled: RewardableDefinition[] = [...live, { key: definition.key, name, slot: definition.slot, rarity: definition.rarity, enabled: true }];
    const pays = (selector: EquipmentRewardSelector) => {
      try {
        return eligibleRewardDefinitions(selector, asEnabled).some((d) => d.key === definition.key);
      } catch {
        return false;
      }
    };
    const automatic: RewardImpactEntry[] = [];
    const deferred: RewardImpactEntry[] = [];

    for (const row of await db.select().from(rewardTables).where(eq(rewardTables.enabled, true))) {
      const table = parseRewardTableRow(row);
      for (const selector of equipmentSelectorsOf([table as never]).values()) {
        if (!pays(selector)) continue;
        const entry = {
          key: row.tableId,
          name: row.tableId,
          location: row.kind === 'boss' ? 'boss reward table' : 'expedition reward table',
          selector: describeEquipmentSelector(selector),
        };
        if (row.kind === 'boss') automatic.push({ ...entry, source: 'boss_reward_table', when: 'immediately' });
        else deferred.push({ ...entry, source: 'expedition_reward_table', when: 'next_deploy' });
      }
    }

    const choices = await db
      .select({ slug: worldEncounters.slug, name: worldEncounters.name, label: worldEncounterChoices.label, success: worldEncounterChoices.successEffectsJson, failure: worldEncounterChoices.failureEffectsJson })
      .from(worldEncounterChoices)
      .innerJoin(worldEncounters, eq(worldEncounterChoices.encounterId, worldEncounters.id))
      .where(eq(worldEncounters.lifecycle, 'active'));
    for (const choice of choices) {
      const effects = [...((choice.success as unknown[]) ?? []), ...((choice.failure as unknown[]) ?? [])];
      for (const effect of effects) {
        if (!effect || typeof effect !== 'object' || (effect as { type?: unknown }).type !== 'give_equipment') continue;
        const { type: _type, quantity: _quantity, ...selector } = effect as Record<string, unknown>;
        if (!pays(selector as EquipmentRewardSelector)) continue;
        automatic.push({
          source: 'world_encounter',
          key: choice.slug,
          name: choice.name,
          location: `choice "${choice.label}"`,
          selector: describeEquipmentSelector(selector as EquipmentRewardSelector),
          when: 'immediately',
        });
      }
    }

    for (const recipe of deps.getWorkshopConfig()?.recipes ?? []) {
      if (!recipe.enabled) continue;
      for (const choice of WORKSHOP_SLOT_CHOICES) {
        const selector = fabricationSelector(recipe.rarity, choice);
        if (!pays(selector)) continue;
        automatic.push({
          source: 'workshop_recipe',
          key: recipe.key,
          name: recipe.name,
          location: choice === 'any' ? 'any slot' : `${choice} slot`,
          selector: describeEquipmentSelector(selector),
          when: 'immediately',
        });
      }
    }

    for (const table of await db.select().from(dungeonLootTables).where(isNull(dungeonLootTables.archivedAt))) {
      const seen = new Set<string>();
      for (const selector of selectorsInBody(table.body)) {
        const described = describeEquipmentSelector(selector);
        if (seen.has(described) || !pays(selector)) continue;
        seen.add(described);
        deferred.push({ source: 'dungeon_loot_table', key: table.tableKey, name: table.name, location: 'dungeon loot table', selector: described, when: 'next_publish' });
      }
    }

    return { rewardRarity, automatic, deferred };
  }

  // ── listing ─────────────────────────────────────────────────────────────

  async function all(): Promise<CatalogueDefinition[]> {
    const rows = await db.select().from(equipmentDefinitions);
    const { owned, all: instances } = await counts(db, rows.map((r) => r.id));
    return rows.map((r) => toCatalogue(r, owned.get(r.id) ?? 0, instances.get(r.id) ?? 0));
  }

  function filtered(definitions: CatalogueDefinition[], query: CatalogueQuery): CatalogueDefinition[] {
    const q = query.q?.trim().toLowerCase();
    const out = definitions.filter(
      (d) =>
        (!q || d.key.includes(q) || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)) &&
        (query.rarity === undefined || d.rarity === query.rarity) &&
        (query.slot === undefined || d.slot === query.slot) &&
        (query.status === undefined || d.enabled === (query.status === 'enabled')),
    );
    const sort = query.sort ?? 'key';
    const value = (d: CatalogueDefinition): string | number => {
      switch (sort) {
        case 'name':
          return d.name.toLowerCase();
        case 'rarity':
          return RARITY_ORDER.indexOf(d.rarity);
        case 'slot':
          return (EQUIPMENT_SLOTS as readonly string[]).indexOf(d.slot);
        case 'updated':
          return d.updatedAt.getTime();
        case 'owned':
          return d.ownedCount;
        default:
          return d.key;
      }
    };
    const sign = query.direction === 'desc' ? -1 : 1;
    return out.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va < vb) return -sign;
      if (va > vb) return sign;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }

  function requireDefinitionInput(raw: unknown): EquipmentDefinitionInput {
    const result = validateEquipmentDefinition(raw);
    if (!result.ok) throw new EquipmentValidationError(result.issues);
    return result.value;
  }

  return {
    async list(query = {}) {
      const definitions = await all();
      const matches = filtered(definitions, query);
      const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 50), 1), CATALOGUE_MAX_PAGE_SIZE);
      const page = Math.max(Math.trunc(query.page ?? 1), 1);
      const byRarity: Record<string, number> = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0]));
      for (const d of definitions) byRarity[d.rarity] = (byRarity[d.rarity] ?? 0) + 1;
      return {
        definitions: matches.slice((page - 1) * pageSize, page * pageSize),
        total: matches.length,
        page,
        pageSize,
        counts: {
          total: definitions.length,
          enabled: definitions.filter((d) => d.enabled).length,
          disabled: definitions.filter((d) => !d.enabled).length,
          byRarity,
        },
      };
    },

    async get(key) {
      const row = await rowByKey(db, key);
      return row ? detailOf(row) : null;
    },

    async validate(raw, opts) {
      const result = validateEquipmentDefinition(raw);
      if (!result.ok) return result.issues;
      const input = result.value;
      const issues: EquipmentIssue[] = [];
      const existing = await rowByKey(db, opts.creating ? input.key : (opts.key ?? input.key));
      if (opts.creating && existing) issues.push({ path: 'key', message: `an equipment definition with the key "${input.key}" already exists` });
      if (!opts.creating) {
        if (!existing) return [{ path: 'key', message: `no equipment definition "${opts.key}"` }];
        if (input.key !== existing.key) issues.push({ path: 'key', message: 'keys never change' });
        if ((await countDefinitionInstances(db, existing.id)) > 0) {
          if (existing.slot !== input.slot) issues.push({ path: 'slot', message: 'players own copies of this equipment, so its slot cannot change' });
          if (existing.rarity !== input.rarity) issues.push({ path: 'rarity', message: 'players own copies of this equipment, so its rarity cannot change' });
        }
      }
      const enabled = opts.creating ? false : (existing?.enabled ?? false);
      const ctx = await rollContext(input);
      if (enabled && ctx.rules) issues.push(...definitionRollPolicyIssues(input, ctx.rules.rules));
      return issues;
    },

    async create(raw, actor) {
      const input = requireDefinitionInput(raw);
      // Server-side and unconditional: a new definition is reviewed before it is enabled.
      const row = await deps.definitions.create({ ...input, enabled: false }, { actorDiscordId: actor });
      return detailOf(row);
    },

    async update(key, raw, opts) {
      const input = requireDefinitionInput(raw);
      const existing = await rowByKey(db, key);
      if (!existing) throw new EquipmentDefinitionNotFoundError(key);
      assertDefinitionRevision(existing, opts.expectedRevision);
      // The editor never toggles availability: enabling has its own reviewed action.
      const row = await deps.definitions.update(key, { ...input, enabled: existing.enabled }, {
        actorDiscordId: opts.actor,
        expectedRevision: opts.expectedRevision,
      });
      return detailOf(row);
    },

    async setEnabled(key, enabled, opts) {
      const existing = await rowByKey(db, key);
      if (!existing) throw new EquipmentDefinitionNotFoundError(key);
      assertDefinitionRevision(existing, opts.expectedRevision);
      if (enabled && !existing.enabled && !opts.acknowledgeRewardImpact) {
        const impact = await impactOf(existing);
        if (impact.automatic.length > 0) throw new EquipmentEnableConfirmationRequiredError(key, impact.automatic);
      }
      const row = await deps.definitions.setEnabled(key, enabled, { actorDiscordId: opts.actor, expectedRevision: opts.expectedRevision });
      return detailOf(row);
    },

    async duplicate(sourceKey, opts) {
      const source = await rowByKey(db, sourceKey);
      if (!source) throw new EquipmentDefinitionNotFoundError(sourceKey);
      // Authoring fields only: no copies, grants or rolled values travel, and
      // the copy goes through the ordinary create validation.
      const input = {
        ...definitionInputFromRow(source),
        key: opts.key,
        name: opts.name?.trim() ? opts.name.trim() : `${source.name} (copy)`.slice(0, 80),
        enabled: false,
      };
      const row = await deps.definitions.create(input, {
        actorDiscordId: opts.actor,
        audit: { action: 'duplicated', details: { duplicatedFrom: sourceKey } },
      });
      return detailOf(row);
    },

    impact: impactOf,

    async previewRoll(target, opts = {}) {
      let definition: EquipmentDefinitionInput;
      if ('key' in target) {
        const row = await rowByKey(db, target.key);
        if (!row) throw new EquipmentDefinitionNotFoundError(target.key);
        definition = definitionInputFromRow(row);
      } else {
        definition = requireDefinitionInput(target.input);
      }
      const ctx = await rollContext(definition);
      const { analysis, availability } = analyse(definition, ctx);
      if (opts.seed === undefined) return { analysis, availability, samples: null, seed: null, sampleError: null };
      const count = Math.min(Math.max(Math.trunc(opts.count ?? 5), 1), SAMPLE_ROLL_MAX);
      try {
        return { analysis, availability, samples: sample(definition, ctx, opts.seed, count), seed: opts.seed, sampleError: null };
      } catch (err) {
        return { analysis, availability, samples: null, seed: opts.seed, sampleError: err instanceof Error ? err.message : String(err) };
      }
    },

    async exportPackage(opts = {}) {
      const label = opts.label ?? null;
      if (opts.keys === undefined && opts.query === undefined) return deps.promotion.exportPackage({ label });
      const keys = opts.keys ?? filtered(await all(), opts.query!).map((d) => d.key);
      if (keys.length === 0) {
        throw new EquipmentExportRefusedError(
          'empty',
          opts.keys ? 'No equipment was selected, so nothing was exported.' : 'No equipment matches these filters, so nothing was exported.',
        );
      }
      return deps.promotion.exportPackage({ keys, label });
    },

    async previewImport(raw) {
      const preview = await deps.promotion.previewImport(raw, { catalogueDefaults: true });
      const rewardImpact: CatalogueImportPreview['rewardImpact'] = [];
      for (const entry of preview.entries) {
        if (entry.action !== 'create') continue;
        const definition = preview.package.definitions.find((d) => d.key === entry.key)!;
        if (!isRewardRarity(definition.rarity)) continue;
        const impact = await impactOf({ key: definition.key, slot: definition.slot as EquipmentSlot, rarity: definition.rarity });
        if (impact.automatic.length + impact.deferred.length > 0) rewardImpact.push({ key: definition.key, impact });
      }
      const warnings: ImportArtworkWarning[] = [];
      if (deps.artworkStatus) {
        const statusOf = new Map<string, ReturnType<NonNullable<typeof deps.artworkStatus>>>();
        for (const definition of preview.package.definitions) {
          if (!definition.artworkPath) continue;
          let status = statusOf.get(definition.artworkPath);
          if (status === undefined) {
            status = deps.artworkStatus(definition.artworkPath);
            statusOf.set(definition.artworkPath, status);
          }
          if (status !== 'available') warnings.push({ key: definition.key, artworkPath: definition.artworkPath, status });
        }
      }
      return { ...preview, rewardImpact, artwork: { checked: deps.artworkStatus !== undefined, warnings } };
    },

    applyImport(raw, opts) {
      return deps.promotion.applyImport(raw, {
        catalogueDefaults: true,
        expectedPlanHash: opts.expectedPlanHash,
        actorDiscordId: opts.actor,
        sourceFilename: opts.sourceFilename ?? null,
      });
    },

    async history(opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const where = opts.key
        ? and(eq(equipmentAdminEvents.subjectKind, 'definition'), eq(equipmentAdminEvents.subjectKey, opts.key))
        : eq(equipmentAdminEvents.subjectKind, 'definition');
      const events = await db.select().from(equipmentAdminEvents).where(where).orderBy(desc(equipmentAdminEvents.id)).limit(limit);
      const logs = await db.select().from(equipmentImportLog).orderBy(desc(equipmentImportLog.id)).limit(limit);
      return {
        events: events.map((e) => ({ id: e.id, key: e.subjectKey, action: e.action, actor: e.actor, details: e.details, createdAt: e.createdAt })),
        imports: logs
          .filter((l) => !opts.key || l.definitionKeys.includes(opts.key))
          .map((l) => ({
            id: l.id,
            actor: l.actorDiscordUserId,
            appliedAt: l.appliedAt,
            packageVersion: l.packageVersion,
            packageLabel: l.packageLabel,
            sourceFilename: l.sourceFilename,
            created: l.createdCount,
            updated: l.updatedCount,
            unchanged: l.unchangedCount,
            definitionKeys: l.definitionKeys,
          })),
      };
    },
  };
}
