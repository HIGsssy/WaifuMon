import { z } from 'zod';
import { DungeonRewardSnapshotSchema } from '../../modules/dungeons/content/dungeonRewardSnapshot';
export { DungeonTestRollRequestSchema } from '../../modules/dungeons/dungeonRewardPreview';

// T2 owns the detailed plan/analysis contracts; retain every field on the wire.
export const dungeonTestRollResultSchema = z.object({
  seed: z.number().int(),
  roll: z.record(z.string(), z.unknown()).nullable(),
  analysis: z.record(z.string(), z.unknown()).nullable(),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string() })),
  simulation: z.object({
    kind: z.literal('observed'), runs: z.number().int(),
    averages: z.array(z.object({ reward: z.record(z.string(), z.unknown()), riskClass: z.enum(['at_risk', 'secured']), averageQuantity: z.number() })),
    nothingRate: z.number(), nothingResults: z.number().int(),
  }).optional(),
  items: DungeonRewardSnapshotSchema.shape.items,
  equipmentPools: DungeonRewardSnapshotSchema.shape.equipmentPools,
});
