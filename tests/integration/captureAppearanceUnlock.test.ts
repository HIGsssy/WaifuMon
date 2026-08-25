/**
 * Capture → the default appearance is available *immediately*.
 *
 * This is the backend half of a bug that was reported as "a Waifumon I just
 * caught still renders as a silhouette". The Portal half is in
 * `portal/src/features/__tests__/ownershipUnlock.test.tsx`; the two meet at the
 * appearance payload asserted here.
 *
 * The property under test is deliberately narrow and total: **the instant the
 * `player_waifus` row exists, the species' `owned` appearance is unlocked and
 * named as the copy's selected artwork — for every legal shape a catalog can
 * take.** Three shapes exist and they are not interchangeable:
 *
 *   - no `appearances` array at all, so the implicit `standard` entry is
 *     synthesized (every species that predates the appearance system);
 *   - an explicit catalog whose `owned` entry happens to be called `standard`
 *     (what `appearances:sync` writes);
 *   - an explicit catalog whose `owned` entry is called something else. Legal:
 *     the schema requires exactly one `owned` entry, never a particular id, and
 *     the sync tool explicitly preserves an author-named default. This is the
 *     shape the Portal used to get wrong, because `player_waifus.variant`
 *     defaults to the literal `'standard'` on capture no matter what the
 *     catalog calls its default.
 *
 * Two things are asserted *not* to happen as well, because the fix for the
 * rendering bug must not be a loosening of the rule it protects:
 *
 *   - owning the species unlocks the `owned` entry and nothing else — level
 *     gates stay locked;
 *   - unlocks stay **derived**. Capture writes the acknowledgement bookkeeping
 *     (`seen_appearances`) and no unlock row, so re-reading cannot accumulate
 *     duplicates.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encounters,
  playerProgressionEvents,
  playerWaifus,
  species,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  APPEARANCE_UNLOCK_EVENT,
  createAppearanceService,
} from '../../src/modules/appearance/appearanceService';
import { createCaptureService } from '../../src/modules/capture/captureService';
import type { AppearanceContent, LoadedContent, SpeciesContent } from '../../src/modules/content/schemas';
import { toOwnedWaifuResource } from '../../src/api/resources';
import { WaifuNotOwnedError } from '../../src/shared/errors';
import { bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

/** Reassigned per test — exactly what an admin-panel "Save + Reload" does. */
let liveContent: LoadedContent;
let appearance: ReturnType<typeof createAppearanceService>;
let capture: ReturnType<typeof createCaptureService>;

// ── The three catalog shapes ────────────────────────────────────────────────

/** No catalog: the species every content pack shipped before appearances. */
const IMPLICIT_SLUG = 'alley_catgirl';
/** Explicit catalog, canonical default id. */
const EXPLICIT_STANDARD_SLUG = 'shrine_assistant';
/** Explicit catalog, author-named default id. */
const EXPLICIT_RENAMED_SLUG = 'cafe_maid';
/** The `owned` entry's id on {@link EXPLICIT_RENAMED_SLUG}. */
const RENAMED_DEFAULT_ID = 'base_look';

function entry(overrides: Partial<AppearanceContent> & Pick<AppearanceContent, 'id' | 'unlock'>) {
  return {
    name: overrides.id,
    cosmeticRarity: 'standard',
    sortOrder: 0,
    tags: [],
    ...overrides,
  } as AppearanceContent;
}

/** Overlays catalogs onto the shipped snapshot — no re-seed, no migration. */
function contentWithCatalogs(base: LoadedContent): LoadedContent {
  const catalogs: Record<string, AppearanceContent[]> = {
    [EXPLICIT_STANDARD_SLUG]: [
      entry({ id: 'standard', unlock: { type: 'owned' } }),
      entry({ id: 'level_10', sortOrder: 10, unlock: { type: 'level', atLevel: 10 } }),
    ],
    [EXPLICIT_RENAMED_SLUG]: [
      entry({ id: RENAMED_DEFAULT_ID, unlock: { type: 'owned' } }),
      entry({ id: 'level_20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } }),
    ],
  };

  return {
    ...base,
    species: base.species.map((s) =>
      catalogs[s.slug] ? ({ ...s, appearances: catalogs[s.slug] } as SpeciesContent) : s,
    ),
  };
}

// ── Capture ─────────────────────────────────────────────────────────────────

/** Resolves any encounter left active by a previous capture. */
async function retireEncounters(): Promise<void> {
  // Deleted rather than resolved is not an option: `capture_attempts` holds a
  // foreign key onto every encounter that was ever rolled against.
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
}

async function activeEncounter(speciesSlug: string): Promise<{ encounter: EncounterRow; row: SpeciesRow }> {
  await retireEncounters();
  const [row] = await t.db.select().from(species).where(eq(species.slug, speciesSlug));
  if (!row) throw new Error(`missing seeded species ${speciesSlug}`);
  const [encounter] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: row.id,
      channelId: 'chan-unlock',
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return { encounter: encounter!, row };
}

/**
 * A real capture through the real service — Mythic Contract, so the roll never
 * decides whether this test runs.
 */
async function captureOne(speciesSlug: string) {
  const item = await getItemBySlug(t.db, 'mythic_contract');
  await app.inventory.addItem(t.db, playerId, item.id, 1);
  const { encounter } = await activeEncounter(speciesSlug);
  const result = await capture.attemptCapture(playerId, encounter.id, 'mythic_contract');
  expect(result.outcome).toBe('success');
  return result;
}

async function unlockAuditRows(waifuId: number) {
  const rows = await t.db
    .select()
    .from(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId));
  return rows.filter((r) => r.eventType === APPEARANCE_UNLOCK_EVENT && r.refId === waifuId);
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-unlock', 'u-unlock'));

  appearance = createAppearanceService({ db: t.db, getContent: () => liveContent });
  capture = createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    collection: app.collection,
    quests: app.quests,
    effects: app.effects,
    appearance,
    logger: t.logger,
  });
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  liveContent = contentWithCatalogs(app.content);
  await t.db.delete(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, playerId));
  await retireEncounters();
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
});

// ── The three shapes ────────────────────────────────────────────────────────

describe('a fresh capture unlocks the default appearance', () => {
  it('for a species with only the implicit standard appearance', async () => {
    const { newWaifu } = await captureOne(IMPLICIT_SLUG);

    const gallery = await appearance.listAppearances(playerId, newWaifu!.id);

    expect(gallery.selected).toBe('standard');
    expect(gallery.appearances).toHaveLength(1);
    expect(gallery.appearances[0]).toMatchObject({
      id: 'standard',
      unlock: { type: 'owned' },
      isUnlocked: true,
      isSelected: true,
    });
  });

  it('for an explicit catalog whose default is the canonical standard', async () => {
    const { newWaifu } = await captureOne(EXPLICIT_STANDARD_SLUG);

    const gallery = await appearance.listAppearances(playerId, newWaifu!.id);
    const byId = Object.fromEntries(gallery.appearances.map((a) => [a.id, a]));

    expect(gallery.selected).toBe('standard');
    expect(byId['standard']).toMatchObject({ isUnlocked: true, isSelected: true });
    // No regression to level gates: owning her buys the `owned` entry only.
    expect(byId['level_10']).toMatchObject({ isUnlocked: false, isSelected: false });
  });

  it('for an explicit catalog whose default is not called “standard”', async () => {
    const { newWaifu } = await captureOne(EXPLICIT_RENAMED_SLUG);

    // The stored column is the literal default, and is deliberately *not* the
    // catalog's default id. Everything below resolves through the catalog
    // rather than reading this, which is the whole point.
    expect(newWaifu!.variant).toBe('standard');

    const gallery = await appearance.listAppearances(playerId, newWaifu!.id);
    const byId = Object.fromEntries(gallery.appearances.map((a) => [a.id, a]));

    expect(gallery.selected).toBe(RENAMED_DEFAULT_ID);
    expect(byId[RENAMED_DEFAULT_ID]).toMatchObject({
      unlock: { type: 'owned' },
      isUnlocked: true,
      isSelected: true,
    });
    expect(byId['level_20']).toMatchObject({ isUnlocked: false });
    // There is no `standard` entry to fall back to — a consumer that guessed
    // one would be asking for artwork this species does not have.
    expect(byId['standard']).toBeUndefined();
  });
});

// ── What the Portal actually reads ──────────────────────────────────────────

describe('the owned-copy resource names artwork that exists', () => {
  it('embeds the catalog’s default appearance, not the stored variant string', async () => {
    const { newWaifu, species: speciesRow } = await captureOne(EXPLICIT_RENAMED_SLUG);

    const resource = toOwnedWaifuResource(newWaifu!, speciesRow, appearance);

    expect(resource.selectedAppearance).toMatchObject({
      id: RENAMED_DEFAULT_ID,
      isUnlocked: true,
      isSelected: true,
      assetId: { kind: 'waifumon', slug: EXPLICIT_RENAMED_SLUG, variant: RENAMED_DEFAULT_ID },
    });
  });

  it('carries an assetId the species catalog actually contains', async () => {
    for (const slug of [IMPLICIT_SLUG, EXPLICIT_STANDARD_SLUG, EXPLICIT_RENAMED_SLUG]) {
      await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
      const { newWaifu, species: speciesRow } = await captureOne(slug);

      const resource = toOwnedWaifuResource(newWaifu!, speciesRow, appearance);
      const catalogIds = appearance.catalogFor(speciesRow).map((a) => a.id);

      expect(catalogIds).toContain(resource.selectedAppearance.assetId.variant);
    }
  });
});

// ── The rule the fix must not erode ─────────────────────────────────────────

describe('ownership stays the source of truth', () => {
  it('refuses a gallery for a copy the player does not own', async () => {
    // The backend form of "unowned artwork stays hidden": there is no per-copy
    // appearance state to read at all until a row exists.
    const other = await provisionPlayer(app, 'g-unlock-2', 'u-unlock-2');
    const { newWaifu } = await captureOne(EXPLICIT_RENAMED_SLUG);

    await expect(appearance.listAppearances(other.playerId, newWaifu!.id)).rejects.toBeInstanceOf(
      WaifuNotOwnedError,
    );
  });

  it('unlocks only the owned entry, whatever the copy’s level would allow later', async () => {
    const { newWaifu } = await captureOne(EXPLICIT_STANDARD_SLUG);
    const gallery = await appearance.listAppearances(playerId, newWaifu!.id);

    expect(gallery.appearances.filter((a) => a.isUnlocked).map((a) => a.id)).toEqual(['standard']);
  });
});

// ── Derived, not persisted ──────────────────────────────────────────────────

describe('unlock state is derived and cannot accumulate', () => {
  it('writes no unlock row for the appearance she arrived wearing', async () => {
    const { newWaifu, newAppearances } = await captureOne(EXPLICIT_RENAMED_SLUG);

    // The default is acknowledged, never announced — nobody wants a toast for
    // "you own her" — and it is not audit-worthy either.
    expect(newAppearances).toEqual([]);
    expect(await unlockAuditRows(newWaifu!.id)).toEqual([]);

    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, newWaifu!.id));
    expect(row!.seenAppearances).toEqual([RENAMED_DEFAULT_ID]);
  });

  it('reads the same after a reload, and writes nothing the second time', async () => {
    // The "hard refresh" case: the answer comes from ownership plus content,
    // so a fresh read reproduces it exactly rather than replaying a write.
    const { newWaifu } = await captureOne(EXPLICIT_RENAMED_SLUG);

    const first = await appearance.listAppearances(playerId, newWaifu!.id);
    const second = await appearance.listAppearances(playerId, newWaifu!.id);

    expect(second).toEqual(first);
    expect(second.appearances.find((a) => a.id === RENAMED_DEFAULT_ID)?.isUnlocked).toBe(true);
    expect(await unlockAuditRows(newWaifu!.id)).toEqual([]);

    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, newWaifu!.id));
    expect(row!.seenAppearances).toEqual([RENAMED_DEFAULT_ID]);
  });

  it('survives the catalog gaining artwork after the capture', async () => {
    // Retroactive content: the copy already owns her, so the default stays
    // unlocked and the newly-added gate stays locked. Nothing is backfilled.
    const { newWaifu } = await captureOne(EXPLICIT_RENAMED_SLUG);

    liveContent = {
      ...liveContent,
      species: liveContent.species.map((s) =>
        s.slug === EXPLICIT_RENAMED_SLUG
          ? ({
              ...s,
              appearances: [
                ...(s.appearances ?? []),
                entry({ id: 'level_30', sortOrder: 30, unlock: { type: 'level', atLevel: 30 } }),
              ],
            } as SpeciesContent)
          : s,
      ),
    };

    const gallery = await appearance.listAppearances(playerId, newWaifu!.id);
    const byId = Object.fromEntries(gallery.appearances.map((a) => [a.id, a]));

    expect(gallery.selected).toBe(RENAMED_DEFAULT_ID);
    expect(byId[RENAMED_DEFAULT_ID]?.isUnlocked).toBe(true);
    expect(byId['level_30']?.isUnlocked).toBe(false);
  });
});
