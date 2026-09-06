/**
 * Applying an encounter promotion package.
 *
 * Split from {@link encounterPackage} on purpose: that module is pure — it
 * builds packages and plans imports with no database at all, which is what
 * lets the planner be exercised exhaustively in unit tests. This module is the
 * only place that writes.
 *
 * ## One transaction, or nothing
 *
 * `apply` opens a single `db.transaction()` covering every vendor, every
 * encounter, every choice tree, and the audit row. A package is a unit of
 * *tested content*: half of a chain is not a smaller success, it is a broken
 * server. So a failure anywhere rolls the whole thing back, and the audit row
 * — written inside the same transaction — exists if and only if the content
 * landed.
 *
 * The plan is recomputed inside the transaction rather than trusted from the
 * preview. A preview is a read of a moment that has passed by the time the
 * operator clicks Apply, and applying a stale plan is exactly how a package
 * validated against one target lands on another.
 *
 * ## Vendors first
 *
 * Vendors are written before encounters because an encounter's `open_vendor`
 * effect references a vendor key. Nothing in the schema enforces that as a
 * foreign key — vendor keys are resolved at runtime — but ordering the writes
 * to match the dependency keeps the database consistent at every point, not
 * only at commit.
 *
 * ## What import never does
 *
 * It never deletes. An encounter present on the target and absent from the
 * package is left exactly as it is: a package is a statement about the
 * encounters it contains, not a declaration of the server's whole catalogue,
 * and treating absence as deletion would make a partial export a destructive
 * act. Removing content stays a deliberate, separate action.
 */
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  worldEncounterImportLog,
  worldEncounterVendors,
  worldEncounters,
} from '../../db/schema';
import { AppError } from '../../shared/errors';
import { createWorldEncounterRepository } from './worldEncounterRepository';
import type { WorldEncounterRepository } from './worldEncounterRepository';
import { hydrateEncounter } from './hydrate';
import type { LoadedContent } from '../content/schemas';
import {
  EncounterPackageSchema,
  PackagedVendorSchema,
  buildEncounterPackage,
  planImport,
  type EncounterPackage,
  type ImportPlan,
  type ImportTargetState,
  type PackagedVendor,
} from './encounterPackage';
import type { LoadedEncounter } from './types';

export class EncounterImportRejectedError extends AppError {
  readonly plan: ImportPlan;
  constructor(plan: ImportPlan) {
    super(
      'ENCOUNTER_IMPORT_REJECTED',
      `Encounter import rejected with ${plan.counts.errors} error(s)`,
      'This package cannot be imported — see the problems listed.',
    );
    this.plan = plan;
  }
}

export interface ApplyImportOptions {
  actorDiscordUserId: string | null;
  /** Filename the operator uploaded, for the audit row. */
  sourceFilename?: string | null;
}

export interface ApplyImportResult {
  plan: ImportPlan;
  importLogId: number;
}

export interface EncounterPromotionService {
  /** Package every encounter, or just the named slugs. Read-only. */
  exportPackage(opts?: { slugs?: readonly string[]; label?: string | null }): Promise<EncounterPackage>;
  /** Validate against this environment and describe the effect. Writes nothing. */
  preview(raw: unknown): Promise<ImportPlan>;
  /** Re-plan and apply, in one transaction. Throws if the re-plan has errors. */
  apply(raw: unknown, opts: ApplyImportOptions): Promise<ApplyImportResult>;
}

export interface EncounterPromotionServiceDeps {
  db: Db;
  getContent: () => LoadedContent;
  /**
   * Whether an artwork path resolves to a deployed file. Optional — a target
   * that cannot check simply never warns, and missing artwork is never fatal.
   */
  artworkExists?: (relativePath: string) => boolean;
}

export function createEncounterPromotionService(
  deps: EncounterPromotionServiceDeps,
): EncounterPromotionService {
  const repo: WorldEncounterRepository = createWorldEncounterRepository(deps.db);

  /** Every encounter, hydrated, keyed by slug. */
  async function loadAllEncounters(tx: DbOrTx = deps.db): Promise<Map<string, LoadedEncounter>> {
    const rows = await tx.select().from(worldEncounters);
    const out = new Map<string, LoadedEncounter>();
    for (const row of rows) {
      const full = await repo.loadById(tx, row.id);
      if (full) out.set(row.slug, hydrateEncounter(full));
    }
    return out;
  }

  async function loadAllVendors(tx: DbOrTx = deps.db): Promise<Map<string, PackagedVendor>> {
    const rows = await tx.select().from(worldEncounterVendors);
    const out = new Map<string, PackagedVendor>();
    for (const row of rows) {
      // Parsed leniently: a stored template this build cannot read is treated
      // as empty rather than crashing a preview the operator needs in order to
      // *fix* it.
      const parsed = PackagedVendorSchema.safeParse({
        vendorKey: row.vendorKey,
        name: row.name,
        description: row.description,
        stockTemplate: row.stockTemplateJson ?? [],
      });
      if (parsed.success) out.set(row.vendorKey, parsed.data);
    }
    return out;
  }

  async function targetState(tx: DbOrTx = deps.db): Promise<ImportTargetState> {
    const content = deps.getContent();
    const [existingEncounters, existingVendors] = await Promise.all([
      loadAllEncounters(tx),
      loadAllVendors(tx),
    ]);
    return {
      existingEncounters,
      existingVendors,
      itemSlugs: new Set(content.items.map((i) => i.slug)),
      speciesSlugs: new Set(content.species.map((s) => s.slug)),
      ...(deps.artworkExists ? { artworkExists: deps.artworkExists } : {}),
    };
  }

  return {
    async exportPackage(opts = {}) {
      const all = await loadAllEncounters();
      const wanted = opts.slugs;
      const encounters =
        wanted && wanted.length > 0
          ? wanted.map((slug) => {
              const found = all.get(slug);
              if (!found) {
                throw new AppError(
                  'ENCOUNTER_NOT_FOUND',
                  `No encounter with slug "${slug}"`,
                  `No encounter named "${slug}".`,
                );
              }
              return found;
            })
          : [...all.values()];
      if (encounters.length === 0) {
        throw new AppError(
          'ENCOUNTER_EXPORT_EMPTY',
          'No encounters to export',
          'There are no encounters to export.',
        );
      }
      const vendorRows = await deps.db.select().from(worldEncounterVendors);
      return buildEncounterPackage({
        encounters,
        vendors: vendorRows,
        label: opts.label ?? null,
      });
    },

    async preview(raw) {
      return planImport(raw, await targetState());
    },

    async apply(raw, opts) {
      return deps.db.transaction(async (tx) => {
        // Re-planned against state read *inside* the transaction. The preview
        // the operator saw is advisory; this is the plan that governs.
        const plan = planImport(raw, await targetState(tx));
        if (!plan.ok) throw new EncounterImportRejectedError(plan);

        // Safe: `planImport` returning ok means the package parsed.
        const pkg: EncounterPackage = EncounterPackageSchema.parse(raw);

        // Vendors first — encounters reference vendor keys.
        for (const vendor of pkg.vendors) {
          const [existing] = await tx
            .select({ id: worldEncounterVendors.id })
            .from(worldEncounterVendors)
            .where(eq(worldEncounterVendors.vendorKey, vendor.vendorKey));
          const values = {
            name: vendor.name,
            description: vendor.description,
            stockTemplateJson: vendor.stockTemplate as unknown as Record<string, unknown>[],
            updatedAt: new Date(),
          };
          if (existing) {
            await tx
              .update(worldEncounterVendors)
              .set(values)
              .where(eq(worldEncounterVendors.id, existing.id));
          } else {
            await tx
              .insert(worldEncounterVendors)
              .values({ vendorKey: vendor.vendorKey, ...values });
          }
        }

        for (const encounter of pkg.encounters) {
          const values = {
            slug: encounter.slug,
            name: encounter.name,
            description: encounter.description,
            type: encounter.type,
            rarity: encounter.rarity,
            weight: encounter.weight,
            lifecycle: encounter.lifecycle,
            huntEligible: encounter.huntEligible,
            travelEligible: encounter.travelEligible,
            cooldownSeconds: encounter.cooldownSeconds,
            artworkPath: encounter.artworkPath,
            chainedEncounterSlug: encounter.chainedEncounterSlug,
            choicesRequired: encounter.choicesRequired,
            metadata: encounter.metadata,
          };
          const [priorRow] = await tx
            .select({ id: worldEncounters.id })
            .from(worldEncounters)
            .where(eq(worldEncounters.slug, encounter.slug));

          let id: number;
          if (priorRow) {
            id = priorRow.id;
            await repo.update(tx, id, values);
          } else {
            id = await repo.insert(tx, values);
          }
          // `replaceChildren` deletes and re-inserts regions, routes and
          // choices, so an update cannot leave an orphaned choice from the
          // previous definition behind. `sortOrder` is the array index, which
          // is how choice ordering survives a round trip without exporting a
          // surrogate id.
          await repo.replaceChildren(
            tx,
            id,
            encounter.regions,
            encounter.routes,
            encounter.choices.map((c, i) => ({
              sortOrder: i,
              label: c.label,
              emoji: c.emoji,
              requirementsJson: c.requirements as unknown as Record<string, unknown>,
              checkJson: c.check as unknown as Record<string, unknown>,
              successEffectsJson: c.successEffects as unknown as Record<string, unknown>[],
              failureEffectsJson: c.failureEffects as unknown as Record<string, unknown>[],
            })),
          );
        }

        const [logRow] = await tx
          .insert(worldEncounterImportLog)
          .values({
            actorDiscordUserId: opts.actorDiscordUserId,
            packageFormat: pkg.format,
            packageVersion: pkg.version,
            packageExportedAt: pkg.exportedAt,
            packageLabel: pkg.label,
            sourceFilename: opts.sourceFilename ?? null,
            createdCount: plan.counts.created,
            updatedCount: plan.counts.updated,
            unchangedCount: plan.counts.unchanged,
            vendorCreatedCount: plan.counts.vendorsCreated,
            vendorUpdatedCount: plan.counts.vendorsUpdated,
            encounterSlugs: pkg.encounters.map((e) => e.slug),
          })
          .returning({ id: worldEncounterImportLog.id });
        if (!logRow) throw new Error('import log insert returned no row');

        return { plan, importLogId: logRow.id };
      });
    },
  };
}
