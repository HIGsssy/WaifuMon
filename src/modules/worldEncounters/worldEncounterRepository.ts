/**
 * Repository — the only place that reads/writes the world_encounter_* tables.
 *
 * Two audiences:
 *
 *   1. The engine loads encounters, choices, region/route joins by id/slug
 *      and inserts active + history rows during a resolution transaction.
 *   2. The admin layer performs full-object CRUD, always inside a
 *      transaction that also rewrites the child tables (regions, routes,
 *      choices) so a partial write cannot land.
 *
 * Nothing here parses JSONB. Every call returns raw DB rows; conversion to
 * runtime `LoadedEncounter` happens in `service.ts`, which is also where the
 * Zod schemas live.
 */
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  activeWorldEncounters,
  worldEncounterChoices,
  worldEncounterCooldowns,
  worldEncounterHistory,
  worldEncounterRegions,
  worldEncounterRoutes,
  worldEncounters,
  type ActiveWorldEncounterRow,
  type WorldEncounterChoiceRow,
  type WorldEncounterRegionRow,
  type WorldEncounterRouteRow,
  type WorldEncounterRow,
} from '../../db/schema';

export interface EncounterWithChildren {
  encounter: WorldEncounterRow;
  regions: WorldEncounterRegionRow[];
  routes: WorldEncounterRouteRow[];
  choices: WorldEncounterChoiceRow[];
}

export type { WorldEncounterChoiceRow };

export interface WorldEncounterRepository {
  /** Full-object load by id, with child rows. Null when missing. */
  loadById(idOrTx: DbOrTx | number, id?: number): Promise<EncounterWithChildren | null>;
  loadBySlug(slug: string): Promise<EncounterWithChildren | null>;
  /** All active encounters that pass a first-pass region + source filter. */
  listSelectable(opts: {
    source: 'hunt' | 'travel';
    regionId: string;
    fromRegion?: string | null;
    toRegion?: string | null;
  }): Promise<EncounterWithChildren[]>;
  /** For the list page — no children loaded. */
  listAll(): Promise<WorldEncounterRow[]>;
  insert(tx: DbOrTx, values: NewEncounterValues): Promise<number>;
  update(tx: DbOrTx, id: number, values: NewEncounterValues): Promise<void>;
  replaceChildren(
    tx: DbOrTx,
    id: number,
    regions: string[],
    routes: Array<{ fromRegion: string; toRegion: string }>,
    choices: NewChoiceValues[],
  ): Promise<void>;
  setLifecycle(tx: DbOrTx, id: number, lifecycle: 'draft' | 'active' | 'disabled'): Promise<void>;
  deleteEncounter(tx: DbOrTx, id: number): Promise<void>;
  hasHistory(id: number): Promise<boolean>;

  // Active state
  insertActive(tx: DbOrTx, values: NewActiveValues): Promise<ActiveWorldEncounterRow>;
  getActiveById(tx: DbOrTx, id: number): Promise<ActiveWorldEncounterRow | null>;
  getPendingForPlayer(playerId: number): Promise<ActiveWorldEncounterRow | null>;
  markResolved(
    tx: DbOrTx,
    id: number,
    choiceId: number | null,
    resolution: Record<string, unknown>,
  ): Promise<void>;
  markExpired(tx: DbOrTx, id: number): Promise<void>;
  updateActiveMessage(tx: DbOrTx, id: number, messageId: string): Promise<void>;

  // Cooldown
  upsertCooldown(tx: DbOrTx, playerId: number, encounterId: number, expiresAt: Date): Promise<void>;
  getCooldownEncounterIds(playerId: number, now: Date): Promise<Set<number>>;

  // History
  insertHistory(tx: DbOrTx, values: NewHistoryValues): Promise<number>;
}

export interface NewEncounterValues {
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
  metadata: Record<string, unknown>;
}

export interface NewChoiceValues {
  sortOrder: number;
  label: string;
  emoji: string | null;
  requirementsJson: Record<string, unknown>;
  checkJson: Record<string, unknown>;
  successEffectsJson: Record<string, unknown>[];
  failureEffectsJson: Record<string, unknown>[];
}

export interface NewActiveValues {
  playerId: number;
  encounterId: number;
  source: 'hunt' | 'travel';
  regionId: string;
  originRegionId: string | null;
  destinationRegionId: string | null;
  guildId: number | null;
  channelId: string | null;
  contextJson: Record<string, unknown>;
  expiresAt: Date;
  /** Set when this row is a chained continuation of another resolved row. */
  continuationOfId?: number | null;
}

export interface NewHistoryValues {
  playerId: number;
  encounterId: number;
  choiceId: number | null;
  source: 'hunt' | 'travel';
  regionId: string;
  success: boolean | null;
  effectsAppliedJson: Record<string, unknown>[];
  startedAt: Date;
}

export function createWorldEncounterRepository(db: Db): WorldEncounterRepository {
  async function loadOne(dbOrTx: DbOrTx, id: number): Promise<EncounterWithChildren | null> {
    const [encounter] = await dbOrTx
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.id, id));
    if (!encounter) return null;
    const [regions, routes, choices] = await Promise.all([
      dbOrTx.select().from(worldEncounterRegions).where(eq(worldEncounterRegions.encounterId, id)),
      dbOrTx.select().from(worldEncounterRoutes).where(eq(worldEncounterRoutes.encounterId, id)),
      dbOrTx
        .select()
        .from(worldEncounterChoices)
        .where(eq(worldEncounterChoices.encounterId, id))
        .orderBy(asc(worldEncounterChoices.sortOrder), asc(worldEncounterChoices.id)),
    ]);
    return { encounter, regions, routes, choices };
  }

  return {
    async loadById(idOrTx, id) {
      if (typeof idOrTx === 'number') return loadOne(db, idOrTx);
      if (id == null) throw new Error('loadById: id required when a tx is passed');
      return loadOne(idOrTx, id);
    },
    async loadBySlug(slug) {
      const [row] = await db.select().from(worldEncounters).where(eq(worldEncounters.slug, slug));
      if (!row) return null;
      return loadOne(db, row.id);
    },
    async listSelectable({ source, regionId }) {
      // Pull the candidates. Region and route filtering happens in the engine
      // — SQL would be a JOIN storm for "empty = global", and pool sizes are
      // small (dozens, not millions).
      const rows = await db
        .select()
        .from(worldEncounters)
        .where(
          and(
            eq(worldEncounters.lifecycle, 'active'),
            source === 'hunt'
              ? eq(worldEncounters.huntEligible, true)
              : eq(worldEncounters.travelEligible, true),
          ),
        );
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const [regions, routes, choices] = await Promise.all([
        db
          .select()
          .from(worldEncounterRegions)
          .where(inArray(worldEncounterRegions.encounterId, ids)),
        db.select().from(worldEncounterRoutes).where(inArray(worldEncounterRoutes.encounterId, ids)),
        db
          .select()
          .from(worldEncounterChoices)
          .where(inArray(worldEncounterChoices.encounterId, ids))
          .orderBy(asc(worldEncounterChoices.sortOrder), asc(worldEncounterChoices.id)),
      ]);
      return rows.map((encounter) => ({
        encounter,
        regions: regions.filter((r) => r.encounterId === encounter.id),
        routes: routes.filter((r) => r.encounterId === encounter.id),
        choices: choices.filter((c) => c.encounterId === encounter.id),
      }));
    },
    async listAll() {
      return db
        .select()
        .from(worldEncounters)
        .orderBy(asc(worldEncounters.rarity), asc(worldEncounters.name));
    },
    async insert(tx, values) {
      const [row] = await tx
        .insert(worldEncounters)
        .values({
          slug: values.slug,
          name: values.name,
          description: values.description,
          type: values.type,
          rarity: values.rarity,
          weight: values.weight,
          lifecycle: values.lifecycle,
          huntEligible: values.huntEligible,
          travelEligible: values.travelEligible,
          cooldownSeconds: values.cooldownSeconds,
          artworkPath: values.artworkPath,
          chainedEncounterSlug: values.chainedEncounterSlug,
          choicesRequired: values.choicesRequired,
          metadata: values.metadata,
        })
        .returning({ id: worldEncounters.id });
      if (!row) throw new Error('insert: no row returned');
      return row.id;
    },
    async update(tx, id, values) {
      await tx
        .update(worldEncounters)
        .set({
          slug: values.slug,
          name: values.name,
          description: values.description,
          type: values.type,
          rarity: values.rarity,
          weight: values.weight,
          lifecycle: values.lifecycle,
          huntEligible: values.huntEligible,
          travelEligible: values.travelEligible,
          cooldownSeconds: values.cooldownSeconds,
          artworkPath: values.artworkPath,
          chainedEncounterSlug: values.chainedEncounterSlug,
          choicesRequired: values.choicesRequired,
          metadata: values.metadata,
          updatedAt: sql`now()`,
        })
        .where(eq(worldEncounters.id, id));
    },
    async replaceChildren(tx, id, regions, routes, choices) {
      await tx.delete(worldEncounterRegions).where(eq(worldEncounterRegions.encounterId, id));
      await tx.delete(worldEncounterRoutes).where(eq(worldEncounterRoutes.encounterId, id));
      await tx.delete(worldEncounterChoices).where(eq(worldEncounterChoices.encounterId, id));
      if (regions.length > 0) {
        await tx
          .insert(worldEncounterRegions)
          .values(regions.map((regionId) => ({ encounterId: id, regionId })));
      }
      if (routes.length > 0) {
        await tx.insert(worldEncounterRoutes).values(
          routes.map((r) => ({
            encounterId: id,
            fromRegion: r.fromRegion,
            toRegion: r.toRegion,
          })),
        );
      }
      if (choices.length > 0) {
        await tx.insert(worldEncounterChoices).values(
          choices.map((c) => ({
            encounterId: id,
            sortOrder: c.sortOrder,
            label: c.label,
            emoji: c.emoji,
            requirementsJson: c.requirementsJson,
            checkJson: c.checkJson,
            successEffectsJson: c.successEffectsJson,
            failureEffectsJson: c.failureEffectsJson,
          })),
        );
      }
    },
    async setLifecycle(tx, id, lifecycle) {
      await tx
        .update(worldEncounters)
        .set({ lifecycle, updatedAt: sql`now()` })
        .where(eq(worldEncounters.id, id));
    },
    async deleteEncounter(tx, id) {
      await tx.delete(worldEncounters).where(eq(worldEncounters.id, id));
    },
    async hasHistory(id) {
      const [row] = await db
        .select({ id: worldEncounterHistory.id })
        .from(worldEncounterHistory)
        .where(eq(worldEncounterHistory.encounterId, id))
        .limit(1);
      return row != null;
    },
    async insertActive(tx, values) {
      const [row] = await tx
        .insert(activeWorldEncounters)
        .values({
          playerId: values.playerId,
          encounterId: values.encounterId,
          source: values.source,
          regionId: values.regionId,
          originRegionId: values.originRegionId,
          destinationRegionId: values.destinationRegionId,
          guildId: values.guildId,
          channelId: values.channelId,
          contextJson: values.contextJson,
          expiresAt: values.expiresAt,
          continuationOfId: values.continuationOfId ?? null,
        })
        .returning();
      if (!row) throw new Error('insertActive: no row returned');
      return row;
    },
    async getActiveById(tx, id) {
      const [row] = await tx
        .select()
        .from(activeWorldEncounters)
        .where(eq(activeWorldEncounters.id, id))
        .for('update');
      return row ?? null;
    },
    async getPendingForPlayer(playerId) {
      const [row] = await db
        .select()
        .from(activeWorldEncounters)
        .where(
          and(
            eq(activeWorldEncounters.playerId, playerId),
            eq(activeWorldEncounters.status, 'pending'),
          ),
        );
      return row ?? null;
    },
    async markResolved(tx, id, choiceId, resolution) {
      await tx
        .update(activeWorldEncounters)
        .set({
          status: 'resolved',
          resolvedChoiceId: choiceId,
          resolvedAt: sql`now()`,
          resolutionJson: resolution,
        })
        .where(eq(activeWorldEncounters.id, id));
    },
    async markExpired(tx, id) {
      await tx
        .update(activeWorldEncounters)
        .set({ status: 'expired', resolvedAt: sql`now()` })
        .where(eq(activeWorldEncounters.id, id));
    },
    async updateActiveMessage(tx, id, messageId) {
      await tx
        .update(activeWorldEncounters)
        .set({ messageId })
        .where(eq(activeWorldEncounters.id, id));
    },
    async upsertCooldown(tx, playerId, encounterId, expiresAt) {
      await tx
        .insert(worldEncounterCooldowns)
        .values({ playerId, encounterId, expiresAt })
        .onConflictDoUpdate({
          target: [worldEncounterCooldowns.playerId, worldEncounterCooldowns.encounterId],
          set: { expiresAt },
        });
    },
    async getCooldownEncounterIds(playerId, now) {
      const rows = await db
        .select({ encounterId: worldEncounterCooldowns.encounterId })
        .from(worldEncounterCooldowns)
        .where(
          and(
            eq(worldEncounterCooldowns.playerId, playerId),
            gt(worldEncounterCooldowns.expiresAt, now),
          ),
        );
      return new Set(rows.map((r) => r.encounterId));
    },
    async insertHistory(tx, values) {
      const [row] = await tx
        .insert(worldEncounterHistory)
        .values({
          playerId: values.playerId,
          encounterId: values.encounterId,
          choiceId: values.choiceId,
          source: values.source,
          regionId: values.regionId,
          success: values.success,
          effectsAppliedJson: values.effectsAppliedJson,
          startedAt: values.startedAt,
        })
        .returning({ id: worldEncounterHistory.id });
      if (!row) throw new Error('insertHistory: no row returned');
      return row.id;
    },
  };
}
