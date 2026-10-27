/** E3-E.1 wire contracts. Domain documents use the E3-B schemas. */
import { z } from 'zod';
import { RollRulesSchema } from '../../modules/equipment/rollRules';
import { LibraryKeySchema, LibraryMetaSchema, ManagedAffixEntrySchema } from '../../modules/equipment/affixLibraries';

export const draftRevision = z.number().int().positive();
export const revisionRequest = z.object({ expectedDraftRevision: draftRevision }).strict();
export const rollbackRequest = revisionRequest.extend({ revision: draftRevision });
export const exportQuery = z.object({ kind: z.enum(['draft', 'published']) });
export const libraryParams = z.object({ key: z.string().min(1).max(64) });
export const issue = z.object({ path: z.string(), message: z.string() });
export const libraryValidation = z.object({ ok: z.boolean(), errors: z.array(issue) });
export const rulesValidation = libraryValidation.extend({
  warnings: z.array(issue),
  value: RollRulesSchema.nullable(),
});
export const change = z.object({ path: z.string(), before: z.unknown(), after: z.unknown() });
export const rulesPreview = z.object({
  draftRevision,
  publishedRevision: draftRevision,
  validation: rulesValidation,
  changes: z.array(change.extend({ kind: z.enum(['added', 'removed', 'changed']) })),
});
export const libraryPreview = z.object({
  draftRevision,
  publishedRevision: draftRevision.nullable(),
  validation: libraryValidation,
  changes: z.array(change),
});
export const publishedRules = z.object({
  revision: draftRevision,
  contentHash: z.string(),
  publishedAt: z.string(),
  publishedBy: z.string().nullable(),
  source: z.enum(['bootstrap', 'editor', 'import', 'rollback']),
  rules: RollRulesSchema,
});
export const draftRules = z.object({
  draftRevision,
  contentHash: z.string(),
  rules: RollRulesSchema,
  publishedRevision: draftRevision,
  dirty: z.boolean(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export const revisionSummary = publishedRules.omit({ rules: true }).extend({
  rolledBackFrom: draftRevision.nullable(),
  current: z.boolean(),
});
export const librarySummary = LibraryMetaSchema.extend({
  key: LibraryKeySchema,
  readOnly: z.literal(false),
  draftRevision,
  publishedRevision: draftRevision.nullable(),
  dirty: z.boolean(),
  draftEntryCount: z.number().int(),
  publishedEntryCount: z.number().int(),
  assignedTo: z.array(z.enum(['SSR', 'UR', 'LR'])),
});
export const libraryDetail = librarySummary.extend({
  draftEntries: z.array(ManagedAffixEntrySchema),
  publishedEntries: z.array(ManagedAffixEntrySchema),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export const legacyLibrary = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  readOnly: z.literal(true),
  rarity: z.enum(['N', 'R', 'SR']),
  entries: z.array(ManagedAffixEntrySchema),
});
export const libraryList = z.object({ managed: z.array(librarySummary), legacy: z.array(legacyLibrary) });
export const libraryRevision = revisionSummary.extend({ entryCount: z.number().int() });
export const rulesExport = z.object({
  format: z.literal('waifumon-equipment-roll-config-export'),
  version: z.literal(1),
  kind: z.enum(['draft', 'published']),
  revision: draftRevision,
  contentHash: z.string(),
  exportedAt: z.string(),
  config: RollRulesSchema,
});
export const libraryExport = z.object({
  format: z.literal('waifumon-equipment-affix-library'),
  version: z.literal(1),
  kind: z.enum(['draft', 'published']),
  revision: draftRevision,
  exportedAt: z.string(),
  library: LibraryMetaSchema.extend({ key: LibraryKeySchema }),
  affixes: z.array(ManagedAffixEntrySchema),
});
export const saveRulesRequest = revisionRequest.extend({ rules: z.unknown() });
export const importRulesRequest = revisionRequest.extend({ file: z.unknown() });
export const importLibraryRequest = z
  .object({ file: z.unknown(), expectedDraftRevision: draftRevision.optional() })
  .strict();
export const createLibraryRequest = z
  .object({ key: LibraryKeySchema, name: z.string().optional(), description: z.string().optional() })
  .strict();
export const saveEntriesRequest = revisionRequest.extend({ entries: z.unknown() });
export const saveEntryRequest = revisionRequest.extend({ entry: z.unknown() });
export const saveMetaRequest = revisionRequest.extend({ meta: z.unknown() });

export type SaveRulesRequest = z.infer<typeof saveRulesRequest>;
export type ImportRulesRequest = z.infer<typeof importRulesRequest>;
export type ImportLibraryRequest = z.infer<typeof importLibraryRequest>;
export type PublishedRulesResponse = z.infer<typeof publishedRules>;
export type DraftRulesResponse = z.infer<typeof draftRules>;
export type LibraryDetailResponse = z.infer<typeof libraryDetail>;
