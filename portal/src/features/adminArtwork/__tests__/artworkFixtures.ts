import type {
  ArtworkAsset,
  ArtworkAssetCategory,
  EnemyArtworkEntry,
} from '@/api/adminArtworkAssets';

let seq = 0;
const hex = (n: number, length: number) => n.toString(16).padStart(length, '0');

export function assetFixture(
  over: Partial<ArtworkAsset> & { name: string; category: ArtworkAssetCategory },
): ArtworkAsset {
  seq += 1;
  return {
    id: `${hex(seq, 8)}-0000-4000-8000-${hex(seq, 12)}`,
    originalFilename: `${over.name.toLowerCase().replace(/\s+/g, '_')}.png`,
    mimeType: 'image/png',
    width: 1200,
    height: 675,
    hasAlpha: false,
    fileSize: 204_800,
    contentHash: hex(seq, 64),
    version: 1,
    status: 'active',
    uploadedBy: '777',
    updatedBy: '777',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    replacedAt: null,
    ...over,
  };
}

export function enemyFixture(
  over: Partial<EnemyArtworkEntry> & { key: string; name: string },
): EnemyArtworkEntry {
  return {
    enabled: true,
    artworkPath: `combat/enemies/${over.key}.webp`,
    spriteArtworkPath: null,
    shippedPlacement: null,
    managed: null,
    visual: {
      artworkAssetId: null,
      artworkPath: `combat/enemies/${over.key}.webp`,
      spriteAssetId: null,
      spriteArtworkPath: null,
      spritePlacement: { anchor: 'bottom-right', scaleBasisPoints: 8500, offsetX: 0, offsetY: 0 },
    },
    ...over,
  };
}

export const pngFile = (name: string) =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

/** jsdom has no object URLs; every artwork preview needs them. */
export function stubObjectUrls(): void {
  const statics = URL as unknown as {
    createObjectURL?: () => string;
    revokeObjectURL?: () => void;
  };
  statics.createObjectURL = () => 'blob:mock';
  statics.revokeObjectURL = () => {};
}
