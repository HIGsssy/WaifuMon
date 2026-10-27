/** HTTP contracts matching E3-E.1. The Portal never imports server implementation. */
import type { EquipmentIssue, EquipmentSlotName } from './adminEquipment';
import { getData, postData, putData } from './client';

export type ManagedRuleRarity = 'SSR' | 'UR' | 'LR';
export type LegacyRarity = 'N' | 'R' | 'SR';
export type CombatFamily =
  | 'crit_chance_bp'
  | 'crit_damage_bonus_bp'
  | 'double_attack_chance_bp'
  | 'armor_penetration_bp'
  | 'lifesteal_bp';
export interface ManagedRarityRule {
  bonusCountWeightsBp: number[];
  families: {
    stat: CombatFamily | 'flat_sp';
    enabled: boolean;
    slots: EquipmentSlotName[];
    minValue: number;
    maxValue: number;
    step: number;
  }[];
  primarySp: { chanceBp: number; min: number; max: number; step: number } | null;
  affixes: { mode: 'none' } | { mode: 'library'; library: string };
}
export interface RollRules {
  format: 'waifumon-equipment-roll-config';
  version: 2;
  legacy: {
    format: 'waifumon-equipment-combat-bonuses';
    version: 1;
    rarityRules: Record<LegacyRarity, { bonusChanceBp: number; bonusCount: number }>;
    bonuses: {
      stat: CombatFamily;
      enabled: boolean;
      stepBp: number;
      ranges: Record<LegacyRarity, { minBp: number; maxBp: number }>;
    }[];
    eligibility: Record<EquipmentSlotName, CombatFamily[]>;
  };
  rarities: Partial<Record<ManagedRuleRarity, ManagedRarityRule>>;
  flatSpLimits: { perItemMax: number; perLoadoutMax: number };
}
export interface DraftRules {
  draftRevision: number;
  contentHash: string;
  rules: RollRules;
  publishedRevision: number;
  dirty: boolean;
  updatedAt: string;
  updatedBy: string | null;
}
export interface PublishedRules {
  revision: number;
  contentHash: string;
  rules: RollRules;
  publishedAt: string;
  publishedBy: string | null;
  source: 'bootstrap' | 'editor' | 'import' | 'rollback';
}
export type RulesRevision = Omit<PublishedRules, 'rules'> & {
  rolledBackFrom: number | null;
  current: boolean;
};
export interface RollRulesValidation {
  ok: boolean;
  value: RollRules | null;
  errors: EquipmentIssue[];
  warnings: EquipmentIssue[];
}
export interface RollRulesPreview {
  validation: RollRulesValidation;
  draftRevision: number;
  publishedRevision: number;
  changes: {
    path: string;
    kind: 'added' | 'removed' | 'changed';
    before: unknown;
    after: unknown;
  }[];
}
export interface RollRulesExport {
  format: 'waifumon-equipment-roll-config-export';
  version: 1;
  kind: 'draft' | 'published';
  revision: number;
  contentHash: string;
  exportedAt: string;
  config: RollRules;
}
export interface LibrarySummary {
  key: string;
  name: string;
  description: string;
  readOnly: false;
  draftRevision: number;
  publishedRevision: number | null;
  dirty: boolean;
  draftEntryCount: number;
  publishedEntryCount: number;
  assignedTo: ManagedRuleRarity[];
}
interface LibraryDetail extends LibrarySummary {
  publishedEntries: { key: string; suffix: string; slots: EquipmentSlotName[]; enabled: boolean }[];
}
export type LibraryOption = LibrarySummary & { coveredSlots: string[] };
export const RULES_QUERY_KEY = ['admin', 'equipment', 'rarity-rules'] as const;
const root = '/admin/equipment/rarity-rules';
export const getDraft = (signal?: AbortSignal) =>
  getData<DraftRules>(`${root}/draft`, signal ? { signal } : undefined);
export const getPublished = (signal?: AbortSignal) =>
  getData<PublishedRules>(`${root}/published`, signal ? { signal } : undefined);
export const getRevisions = (signal?: AbortSignal) =>
  getData<RulesRevision[]>(`${root}/revisions`, signal ? { signal } : undefined);
export const saveDraft = (rules: RollRules, expectedDraftRevision: number) =>
  putData<DraftRules>(`${root}/draft`, { rules, expectedDraftRevision });
export const validateRules = (rules: RollRules) =>
  postData<RollRulesValidation>(`${root}/validate`, { rules });
export const previewRules = (rules: RollRules) =>
  postData<RollRulesPreview>(`${root}/preview`, { rules });
export const publishRules = (expectedDraftRevision: number) =>
  postData<PublishedRules>(`${root}/publish`, { expectedDraftRevision });
export const rollbackRules = (revision: number, expectedDraftRevision: number) =>
  postData<PublishedRules>(`${root}/rollback`, { revision, expectedDraftRevision });
export const exportRules = (kind: 'draft' | 'published') =>
  getData<RollRulesExport>(`${root}/export`, { params: { kind } });
export const previewImport = (file: unknown, expectedDraftRevision: number) =>
  postData<RollRulesPreview & { handEdited: boolean }>(`${root}/import/preview`, {
    file,
    expectedDraftRevision,
  });
export const importDraft = (file: unknown, expectedDraftRevision: number) =>
  postData<DraftRules & { handEdited: boolean }>(`${root}/import`, { file, expectedDraftRevision });

/** Published entries, rather than drafts, determine whether a library covers every slot. */
export async function getLibraries(signal?: AbortSignal): Promise<LibraryOption[]> {
  const list = await getData<{ managed: LibrarySummary[] }>(
    '/admin/equipment/affix-libraries',
    signal ? { signal } : undefined,
  );
  return Promise.all(
    list.managed.map(async (library) => {
      if (library.publishedRevision === null) return { ...library, coveredSlots: [] };
      const detail = await getData<LibraryDetail>(
        `/admin/equipment/affix-libraries/${encodeURIComponent(library.key)}`,
        signal ? { signal } : undefined,
      );
      return {
        ...library,
        publishedRevision: detail.publishedRevision,
        coveredSlots: [
          ...new Set(detail.publishedEntries.filter((e) => e.enabled).flatMap((e) => e.slots)),
        ],
      };
    }),
  );
}

export async function loadRules(signal?: AbortSignal) {
  const [draft, published, revisions, libraries] = await Promise.all([
    getDraft(signal),
    getPublished(signal),
    getRevisions(signal),
    getLibraries(signal),
  ]);
  return { draft, published, revisions, libraries };
}
export type RulesBundle = Awaited<ReturnType<typeof loadRules>>;
