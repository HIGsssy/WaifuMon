/**
 * AppearanceService against real Postgres.
 *
 * The invariants worth a database to prove:
 *
 *   - **Cosmetic means cosmetic.** Selecting a look must diff exactly one
 *     column. There is a row-level diff assertion below, and it is the single
 *     most important test in this file.
 *   - **Unlocks are derived, notifications are persisted.** A copy that levels
 *     past a milestone gets the unlock and one audit row; a copy that was
 *     *already* past it when the artwork shipped gets the same, on read, with
 *     `source: 'content_add'`.
 *   - **Acknowledgement is idempotent.** Levelling twice, or opening the
 *     gallery twice, must not double-notify or double-log.
 *   - **Backward compatibility.** A species with no authored catalog still has
 *     a gallery, and it contains exactly the implicit standard entry.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  playerProgressionEvents,
  playerWaifus,
  species,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { APPEARANCE_UNLOCK_EVENT } from '../../src/modules/appearance/appearanceService';
import type { LoadedContent, SpeciesContent } from '../../src/modules/content/schemas';
import {
  AppearanceLockedError,
  AppearanceNotFoundError,
  WaifuNotOwnedError,
} from '../../src/shared/errors';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let subject: SpeciesRow;

/**
 * A content snapshot in which one species carries a real catalog.
 *
 * Built by *overlaying* the shipped content rather than seeding new species:
 * the appearance catalog is content, never database state, so this is exactly
 * how shipping new artwork behaves in production — no migration, no re-seed.
 */
function contentWithCatalog(base: LoadedContent, slug: string): LoadedContent {
  return {
    ...base,
    species: base.species.map((s) =>
      s.slug === slug
        ? ({
            ...s,
            appearances: [
              {
                id: 'standard',
                name: 'Standard',
                cosmeticRarity: 'standard',
                sortOrder: 0,
                tags: [],
                unlock: { type: 'owned' },
              },
              {
                id: 'level_5',
                name: 'Midnight Bloom',
                description: 'A darker cut of her usual silhouette.',
                flavorText: 'Prepared for the annual shrine celebration.',
                cosmeticRarity: 'seasonal',
                introducedVersion: 'v1.3',
                sortOrder: 1,
                tags: [],
                unlock: { type: 'level', atLevel: 5 },
              },
              {
                id: 'level_20',
                name: 'Eclipse',
                cosmeticRarity: 'limited',
                sortOrder: 2,
                tags: [],
                unlock: { type: 'level', atLevel: 20 },
              },
            ],
          } as SpeciesContent)
        : s,
    ),
  };
}

/** Content the service reads; reassigned per test to simulate a content ship. */
let liveContent: LoadedContent;
let appearance: ReturnType<typeof createAppearanceService>;

async function grantWaifu(level = 1): Promise<PlayerWaifuRow> {
  const [row] = await t.db
    .insert(playerWaifus)
    .values({ playerId, speciesId: subject.id, level })
    .returning();
  return row!;
}

async function unlockEvents(waifuId: number) {
  const rows = await t.db
    .select()
    .from(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId));
  return rows.filter(
    (r) => r.eventType === APPEARANCE_UNLOCK_EVENT && r.refId === waifuId,
  );
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  const provisioned = await provisionPlayer(app, 'g-appearance', 'u-appearance');
  playerId = provisioned.playerId;
  const [row] = await t.db.select().from(species).where(eq(species.slug, 'alley_catgirl'));
  subject = row!;
  // The service reads content through a getter, so reassigning `liveContent`
  // mid-test is exactly what an admin-panel "Save + Reload" does.
  appearance = createAppearanceService({ db: t.db, getContent: () => liveContent });
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  liveContent = contentWithCatalog(app.content, 'alley_catgirl');
  await t.db.delete(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
});

describe('backward compatibility', () => {
  it('gives a species with no authored catalog a single implicit standard entry', async () => {
    liveContent = app.content; // the shipped snapshot, no appearances anywhere
    const waifu = await grantWaifu();
    const gallery = await appearance.listAppearances(playerId, waifu.id);

    expect(gallery.selected).toBe('standard');
    expect(gallery.appearances).toHaveLength(1);
    expect(gallery.appearances[0]).toMatchObject({
      id: 'standard',
      unlockLabel: 'Owned',
      isUnlocked: true,
      isSelected: true,
      assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'standard' },
    });
  });

  it('renders an existing copy whose stored variant predates the catalog', async () => {
    const waifu = await grantWaifu();
    await t.db
      .update(playerWaifus)
      .set({ variant: 'standard' })
      .where(eq(playerWaifus.id, waifu.id));
    const gallery = await appearance.listAppearances(playerId, waifu.id);
    expect(gallery.selected).toBe('standard');
  });
});

describe('listAppearances', () => {
  it('returns locked entries with their requirement, not just unlocked ones', async () => {
    const waifu = await grantWaifu(1);
    const gallery = await appearance.listAppearances(playerId, waifu.id);

    expect(gallery.appearances.map((a) => a.id)).toEqual(['standard', 'level_5', 'level_20']);
    expect(gallery.appearances.map((a) => a.isUnlocked)).toEqual([true, false, false]);
    // The journal property: every entry states how it is earned.
    expect(gallery.appearances.map((a) => a.unlockLabel)).toEqual([
      'Owned',
      'Reach Level 5',
      'Reach Level 20',
    ]);
  });

  it('carries the full cosmetic metadata set', async () => {
    const waifu = await grantWaifu(1);
    const gallery = await appearance.listAppearances(playerId, waifu.id);
    expect(gallery.appearances[1]).toMatchObject({
      name: 'Midnight Bloom',
      description: 'A darker cut of her usual silhouette.',
      flavorText: 'Prepared for the annual shrine celebration.',
      cosmeticRarity: 'seasonal',
      introducedVersion: 'v1.3',
      assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_5' },
    });
  });

  it('never returns a path, URL, or file extension', async () => {
    const waifu = await grantWaifu(1);
    const gallery = await appearance.listAppearances(playerId, waifu.id);
    const json = JSON.stringify(gallery);
    expect(json).not.toMatch(/\.(png|jpe?g|webp|gif|svg)/i);
    expect(json).not.toContain('assets/');
    expect(json).not.toContain('imagePath');
  });

  it('404s for a copy the player does not own', async () => {
    await expect(appearance.listAppearances(playerId, 999_999)).rejects.toBeInstanceOf(
      WaifuNotOwnedError,
    );
  });
});

describe('retroactive unlocks (content added after the copy already qualified)', () => {
  it('acknowledges on read and logs the unlock with source content_add', async () => {
    // A Level-25 copy that has never been told about anything. Both milestones
    // apply the instant the artwork ships — no backfill job involved.
    const waifu = await grantWaifu(25);

    const gallery = await appearance.listAppearances(playerId, waifu.id);
    expect(gallery.appearances.filter((a) => a.isUnlocked)).toHaveLength(3);

    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifu.id));
    expect(after?.seenAppearances.sort()).toEqual(['level_20', 'level_5', 'standard']);

    const events = await unlockEvents(waifu.id);
    // The `owned` default is marked seen but deliberately not logged.
    expect(events.map((e) => e.metadata.appearanceId).sort()).toEqual(['level_20', 'level_5']);
    expect(events.every((e) => e.metadata.source === 'content_add')).toBe(true);
    expect(events.every((e) => e.xpDelta === 0)).toBe(true);
  });

  it('is idempotent — a second gallery view logs nothing new', async () => {
    const waifu = await grantWaifu(25);
    await appearance.listAppearances(playerId, waifu.id);
    const first = await unlockEvents(waifu.id);
    await appearance.listAppearances(playerId, waifu.id);
    expect(await unlockEvents(waifu.id)).toHaveLength(first.length);
  });

  it('embeds assetId in the audit row so a renderer needs no second lookup', async () => {
    const waifu = await grantWaifu(25);
    await appearance.listAppearances(playerId, waifu.id);
    const [event] = await unlockEvents(waifu.id);
    expect(event?.metadata.assetId).toEqual({
      kind: 'waifumon',
      slug: 'alley_catgirl',
      variant: 'level_5',
    });
    expect(event?.metadata.unlockLabel).toBe('Reach Level 5');
  });
});

describe('syncUnlocks (the level-up path)', () => {
  it('announces a milestone crossed, but never the default appearance', async () => {
    const waifu = await grantWaifu(1);
    // Acknowledge the default first, as capture does.
    const onCapture = await appearance.syncUnlocks(t.db, waifu, subject, 'owned');
    expect(onCapture).toEqual([]);

    const levelled = { ...waifu, level: 5 };
    const unlocked = await appearance.syncUnlocks(t.db, levelled, subject, 'level');
    expect(unlocked.map((u) => u.appearanceId)).toEqual(['level_5']);
    expect(unlocked[0]).toMatchObject({
      name: 'Midnight Bloom',
      cosmeticRarity: 'seasonal',
      unlockLabel: 'Reach Level 5',
      source: 'level',
    });
  });

  it('does not re-announce an already-seen appearance', async () => {
    const waifu = await grantWaifu(5);
    const first = await appearance.syncUnlocks(t.db, { ...waifu }, subject, 'level');
    expect(first).toHaveLength(1);
    const [reloaded] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifu.id));
    const second = await appearance.syncUnlocks(t.db, reloaded!, subject, 'level');
    expect(second).toEqual([]);
  });
});

describe('selectAppearance', () => {
  it('changes only the variant column — nothing gameplay-relevant drifts', async () => {
    const waifu = await grantWaifu(10);
    const [before] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifu.id));

    await appearance.selectAppearance(playerId, waifu.id, 'level_5');

    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifu.id));

    // The cosmetic invariant, asserted as an exact row diff rather than a
    // handful of spot checks: if a future edit touches anything else here,
    // this fails by name.
    expect(after?.variant).toBe('level_5');
    expect({ ...after, variant: null, seenAppearances: null }).toEqual({
      ...before,
      variant: null,
      seenAppearances: null,
    });
    expect(after?.level).toBe(before?.level);
    expect(after?.xp).toBe(before?.xp);
    expect(after?.affection).toBe(before?.affection);
    expect(after?.isFavorite).toBe(before?.isFavorite);
    expect(after?.nickname).toBe(before?.nickname);
    expect(after?.releasedAt).toEqual(before?.releasedAt);
  });

  it('refuses a locked appearance and names the requirement', async () => {
    const waifu = await grantWaifu(1);
    await expect(
      appearance.selectAppearance(playerId, waifu.id, 'level_20'),
    ).rejects.toBeInstanceOf(AppearanceLockedError);

    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifu.id));
    expect(after?.variant).toBe('standard');
  });

  it('refuses an appearance the species does not have', async () => {
    const waifu = await grantWaifu(50);
    await expect(
      appearance.selectAppearance(playerId, waifu.id, 'no_such_look'),
    ).rejects.toBeInstanceOf(AppearanceNotFoundError);
  });

  it('refuses a copy the player does not own', async () => {
    await expect(
      appearance.selectAppearance(playerId, 999_999, 'standard'),
    ).rejects.toBeInstanceOf(WaifuNotOwnedError);
  });

  it('returns the chosen appearance with its metadata', async () => {
    const waifu = await grantWaifu(10);
    const result = await appearance.selectAppearance(playerId, waifu.id, 'level_5');
    expect(result.appearance).toMatchObject({
      id: 'level_5',
      name: 'Midnight Bloom',
      isSelected: true,
      isUnlocked: true,
    });
    expect(result.waifu.variant).toBe('level_5');
  });
});
