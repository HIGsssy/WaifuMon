/** V2/V3 table decisions and effective draft construction. No writes. */
import { z } from 'zod';
import type { DungeonLootTableRow } from '../../../db/schema';
import { DungeonDefinitionSchema, mapDungeonRewardBundles, type DungeonDefinition } from '../content/dungeonDefinition';
import { DungeonKeySchema } from '../content/dungeonIdentifiers';
import { DungeonLootTableBodySchema } from '../content/dungeonRewards';
import { dungeonLootBodyHash } from '../content/dungeonRewardSnapshot';
import type { DungeonIssueDetail } from '../../../shared/errors';
import type { DungeonPackageV2Schema, DungeonPackageV3Schema, DungeonPackageV4Schema } from './dungeonPackage';

export const DungeonLootImportDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create') }).strict(),
  z.object({ action: z.literal('use_existing') }).strict(),
  z.object({ action: z.literal('leave_missing') }).strict(),
  z.object({ action: z.literal('copy'), key: DungeonKeySchema }).strict(),
]);
export const DungeonLootImportDecisionsSchema = z.record(z.string(), DungeonLootImportDecisionSchema);
export type DungeonLootImportDecisions = z.infer<typeof DungeonLootImportDecisionsSchema>;
export const DungeonLootImportTablePlanSchema = z.object({
  key: z.string(), name: z.string(), status: z.enum(['missing', 'identical', 'different']),
  currentRevision: z.number().int().positive().nullable(), currentHash: z.string().nullable(),
  incomingHash: z.string(), currentName: z.string().nullable(), archived: z.boolean(),
  incomingBody: DungeonLootTableBodySchema, currentBody: DungeonLootTableBodySchema.nullable(),
  decision: DungeonLootImportDecisionSchema.nullable(), targetKey: z.string(), suggestedCopyKey: z.string(),
});
export type DungeonLootImportTablePlan = z.infer<typeof DungeonLootImportTablePlanSchema>;
export type V2Package = z.infer<typeof DungeonPackageV2Schema>;
export interface DungeonLootImportCreation {
  sourceKey: string; key: string; name: string; description: string;
  tier: 'common' | 'rare' | 'boss' | 'legendary' | null;
  body: z.infer<typeof DungeonLootTableBodySchema>; contentHash: string; sourceRevision: number;
}
const tierSchema = z.enum(['common', 'rare', 'boss', 'legendary']).nullable();

export function planDungeonLootImport(pkg: V2Package | z.infer<typeof DungeonPackageV3Schema> | z.infer<typeof DungeonPackageV4Schema>, rows: readonly DungeonLootTableRow[], choices: DungeonLootImportDecisions = {}) {
  const live = new Map(rows.map(row => [row.tableKey, row]));
  const reserved = new Set([...live.keys(), ...pkg.bundled.dungeonLootTables.map(t => t.key)]);
  const suggestedKeys = new Set(reserved);
  const issues: DungeonIssueDetail[] = [];
  const creations: DungeonLootImportCreation[] = [];
  const rewrites = new Map<string, string>();
  const tablePlans: DungeonLootImportTablePlan[] = [];
  const issue = (key: string, code: string, message: string, severity: 'error' | 'warning' = 'error') =>
    issues.push({ code, severity, path: `dependencies.dungeonLootTables.${key}`, message });
  for (const key of Object.keys(choices))
    if (!pkg.bundled.dungeonLootTables.some(t => t.key === key))
      issue(key, 'loot_table_decision_invalid', 'This table is not referenced by the source package.');
  for (const incoming of [...pkg.bundled.dungeonLootTables].sort((a, b) => a.key.localeCompare(b.key))) {
    const row = live.get(incoming.key);
    const current = row ? DungeonLootTableBodySchema.safeParse(row.body) : null;
    const currentBody = current?.success ? current.data : null;
    const currentHash = currentBody ? dungeonLootBodyHash(currentBody) : row?.contentHash ?? null;
    const status = !row ? 'missing' : currentBody && currentHash === incoming.contentHash ? 'identical' : 'different';
    const decision = Object.hasOwn(choices, incoming.key) ? choices[incoming.key]! :
      status === 'missing' ? { action: 'create' as const } : status === 'identical' ? { action: 'use_existing' as const } : null;
    let suffix = '_imported';
    let suggestion = `${incoming.key.slice(0, 64 - suffix.length).replace(/_+$/, '')}${suffix}`;
    let n = 2;
    while (suggestedKeys.has(suggestion)) {
      suffix = `_imported_${n++}`;
      suggestion = `${incoming.key.slice(0, 64 - suffix.length).replace(/_+$/, '')}${suffix}`;
    }
    suggestedKeys.add(suggestion);
    const targetKey = decision?.action === 'copy' ? decision.key : incoming.key;
    tablePlans.push({ key: incoming.key, name: incoming.name, status, currentRevision: row?.revision ?? null,
      currentHash, incomingHash: incoming.contentHash, currentName: row?.name ?? null, archived: row?.archivedAt != null,
      incomingBody: incoming.body, currentBody, decision, targetKey, suggestedCopyKey: suggestion });
    if (!decision) {
      issue(incoming.key, 'loot_table_decision_required', `“${incoming.name}” has different rewards here. Import a copy or explicitly use the destination table.`);
      continue;
    }
    const valid = status === 'missing' ? ['create', 'leave_missing'].includes(decision.action) :
      status === 'identical' ? decision.action === 'use_existing' : ['copy', 'use_existing'].includes(decision.action);
    if (!valid) { issue(incoming.key, 'loot_table_decision_invalid', 'The selected action does not match this destination table state. Review a new plan.'); continue; }
    if (decision.action === 'use_existing') {
      if (status === 'different') issue(incoming.key, 'loot_table_rewards_differ', `Using destination “${row!.name}” changes rewards from source “${incoming.name}”.`, 'warning');
      continue;
    }
    if (decision.action === 'leave_missing') continue;
    if (decision.action === 'copy' && reserved.has(targetKey)) {
      issue(incoming.key, 'loot_table_copy_key_taken', `Table key “${targetKey}” is already in use. Choose a free key.`); continue;
    }
    const metadata = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(600), tier: tierSchema })
      .safeParse({ name: incoming.name, description: incoming.description ?? '', tier: incoming.tier });
    if (!metadata.success) { issue(incoming.key, 'loot_table_metadata_invalid', `“${incoming.name}” has unsupported authoring metadata; repair the source package.`); continue; }
    reserved.add(targetKey);
    suggestedKeys.add(targetKey);
    if (targetKey !== incoming.key) rewrites.set(incoming.key, targetKey);
    creations.push({ sourceKey: incoming.key, key: targetKey, ...metadata.data, body: incoming.body,
      contentHash: incoming.contentHash, sourceRevision: incoming.sourceRevision });
  }
  const definition: DungeonDefinition = DungeonDefinitionSchema.parse(mapDungeonRewardBundles(pkg.dungeon, bundle => ({ ...bundle,
    tables: bundle.tables.map(ref => ({ ...ref, table: rewrites.get(ref.table) ?? ref.table })),
  })));
  return { definition, tablePlans, creations, issues, rewrites };
}
