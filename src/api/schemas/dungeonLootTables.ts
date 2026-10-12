/** Wire schemas shared with the Portal through erased type imports. */
import { z } from 'zod';
import { DungeonLootTableBodySchema } from '../../modules/dungeons/content/dungeonRewards';

export const dungeonLootTableTierSchema = z.enum(['common', 'rare', 'boss', 'legendary']);
export const dungeonLootTableOriginSchema = z.enum(['portal', 'import', 'converted', 'seed']);
const rewardIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
});
const equipmentPoolsSchema = z.record(
  z.string(),
  z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      slot: z.string(),
      rarity: z.string(),
      enabled: z.boolean(),
    }),
  ),
);
export const dungeonLootTableSchema = z.object({
  issues: z.array(rewardIssueSchema),
  equipmentPools: equipmentPoolsSchema,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  tier: dungeonLootTableTierSchema.nullable(),
  body: DungeonLootTableBodySchema,
  contentHash: z.string(),
  revision: z.number().int(),
  archivedAt: z.string().nullable(),
  origin: dungeonLootTableOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export const dungeonLootTableUsageSchema = z.object({
  drafts: z.array(
    z.object({
      kind: z.literal('draft'),
      dungeonKey: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      draftRevision: z.number().int(),
    }),
  ),
  published: z.array(
    z.object({
      kind: z.literal('published'),
      dungeonKey: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      revisionId: z.number().int(),
      revision: z.number().int(),
      current: z.boolean(),
      snapshotStatus: z.enum(['embedded', 'not_embedded']),
    }),
  ),
});
export const dungeonLootTableEventSchema = z.object({
  id: z.number().int(),
  tableKey: z.string(),
  action: z.enum([
    'created',
    'updated',
    'archived',
    'restored',
    'deleted',
    'duplicated',
    'imported',
    'converted',
  ]),
  actor: z.string().nullable(),
  revision: z.number().int(),
  origin: dungeonLootTableOriginSchema,
  previousContentHash: z.string().nullable(),
  newContentHash: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export const dungeonLootTableValidationSchema = z.object({
  valid: z.boolean(),
  body: DungeonLootTableBodySchema.nullable(),
  contentHash: z.string().nullable(),
  issues: z.array(rewardIssueSchema),
  equipmentPools: equipmentPoolsSchema,
});
export type DungeonLootTable = z.infer<typeof dungeonLootTableSchema>;
export type DungeonLootTableUsage = z.infer<typeof dungeonLootTableUsageSchema>;
export type DungeonLootTableEvent = z.infer<typeof dungeonLootTableEventSchema>;
export type DungeonLootTableValidation = z.infer<typeof dungeonLootTableValidationSchema>;
