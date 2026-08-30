/**
 * Appearance resources — the cosmetic progression surface.
 *
 * **The API is asset-location agnostic.** Nothing in this file names a
 * filesystem path, a static URL, a CDN host, an object-storage key, a content
 * hash, or a file extension. Artwork is identified by `assetId` and nothing
 * else, and every consumer (Portal, Discord, a future mobile client) owns its
 * own `AssetId → physical resource` resolver. Migrating storage backends is
 * therefore a per-consumer change with **zero** API-contract impact.
 *
 * That is not a convention to remember: `tests/integration/api/
 * assetAbstraction.test.ts` walks every v1 response body and fails on any image
 * extension or `assets/` substring, so adding a leaky field breaks CI.
 *
 * Everything here is presentation. `name`, `description`, `flavorText`,
 * `cosmeticRarity`, `introducedVersion`, and `unlockLabel` render on the client
 * and never influence stats, XP, affection, evolution, capture odds, or drops.
 *
 * **Locked artwork is withheld, not merely flagged.** `assetId` is nullable and
 * is populated only for artwork the caller has earned — see its description
 * below. Because `assetId` is the single asset reference, withholding it here
 * is the whole access control: a client that never receives one has nothing to
 * resolve, and `isUnlocked: false` is a rendering hint rather than the fence.
 */
import { z } from 'zod';
import {
  APPEARANCE_UNLOCK_TYPES,
  COSMETIC_RARITIES,
} from '../../modules/content/schemas';

/**
 * The system's only asset reference.
 *
 * `kind` is a single literal in v1 and the discriminator later (`card_print`,
 * an animated `slot`, …). `variant` is the appearance id, which is also what
 * `ownedWaifu.variant` carries — one vocabulary, not two.
 */
export const assetIdSchema = z
  .object({
    kind: z.literal('waifumon'),
    slug: z.string().describe('Species slug the artwork belongs to.'),
    variant: z.string().describe('Appearance id — the art variant to render.'),
  })
  .describe(
    'Abstract artwork identifier. Describes *what* to render, never where it lives — no path, ' +
      'URL, CDN host, storage key, or file extension. Each client resolves it independently.',
  );

/**
 * Cosmetic rarity — **fully independent from species rarity** (`N`/`R`/`SR`/…).
 * A Rare species may wear a Seasonal appearance; the two are separate signals
 * with separate field names (`species.rarity` vs `appearance.cosmeticRarity`)
 * and are expected to be styled differently. Descriptive only: it drives no
 * drop, no unlock, and no gameplay.
 */
export const cosmeticRaritySchema = z
  .enum(COSMETIC_RARITIES)
  .describe(
    'Presentation badge, independent of species rarity. Render unknown future values as "common".',
  );

/**
 * How an appearance is earned.
 *
 * v1 handlers emit only `owned` and `level`. The remaining literals are
 * **reserved**: they are published now so a client can implement its renderer
 * once and need no update when the first grant-driven source ships.
 */
export const appearanceUnlockSchema = z
  .object({
    type: z.enum(APPEARANCE_UNLOCK_TYPES).describe('v1 emits only "owned" and "level".'),
    atLevel: z
      .number()
      .int()
      .optional()
      .describe('Present for type "level": the waifu level (per copy) that unlocks it.'),
  })
  .describe('Structured unlock requirement. Prefer `unlockLabel` for display.');

/** Authored catalog metadata — the same for every player. */
export const appearanceCatalogSchema = z.object({
  id: z.string().describe('Unique within the species; also the `variant` value.'),
  name: z.string(),
  description: z.string().nullable(),
  flavorText: z.string().nullable().describe('In-world caption, rendered as a quote.'),
  cosmeticRarity: cosmeticRaritySchema,
  introducedVersion: z.string().nullable().describe('Free-form, e.g. "v1.3". Never parsed.'),
  assetId: assetIdSchema
    .nullable()
    .describe(
      'The artwork identifier, or `null` when this client may not see the artwork yet.\n\n' +
        'Locked appearances are returned as **slots**: id, name, `unlock`, `unlockLabel` — ' +
        'everything needed to render "Reach Level 20" — but no `assetId`, because resolving one ' +
        'is what produces the picture, and the picture is the reward. On the species catalog ' +
        '(no player in scope) only the `owned` entry carries an id; on a collection gallery it ' +
        'follows `isUnlocked` exactly.\n\n' +
        'This is enforced server-side. There is no parameter, header, or client state that ' +
        'returns an id for artwork the copy has not earned.',
    ),
  unlock: appearanceUnlockSchema,
  unlockLabel: z
    .string()
    .describe(
      'Always populated — author-supplied or synthesized. Shown on locked *and* unlocked ' +
        'entries so the gallery reads as a progression journal.',
    ),
});

/** Catalog metadata plus this owned copy's state. */
export const appearanceSchema = appearanceCatalogSchema.extend({
  isUnlocked: z.boolean(),
  isSelected: z.boolean(),
});

export const appearanceGallerySchema = z.object({
  appearances: z.array(appearanceSchema),
  selected: z.string().describe('The appearance id currently rendered for this copy.'),
});

export const setAppearanceBody = z.object({
  appearanceId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_]+$/, 'Appearance ids are lowercase alphanumerics and underscores.'),
});
