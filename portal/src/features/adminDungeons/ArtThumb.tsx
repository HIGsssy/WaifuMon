/**
 * A thumbnail of one artwork reference, wherever the image lives: an uploaded
 * asset while it exists, else a file shipped with the game, else nothing.
 */
import {
  artworkAssetBlob,
  artworkAssetSource,
  type ArtworkLayerRef,
} from '@/api/adminArtworkAssets';
import { dungeonArtworkBlob } from '@/api/adminDungeons';
import { useHasPermission } from '@/auth/useSession';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { useArtworkAsset } from '@/features/adminArtwork/assetHelpers';

/** A small picture of one artwork reference — an uploaded asset, else a shipped path, else nothing. */
export function ArtThumb({
  image,
  label,
  testId,
}: {
  image: ArtworkLayerRef;
  label: string;
  testId: string;
}) {
  const canBrowse = useHasPermission('artwork.read');
  const asset = useArtworkAsset(canBrowse ? (image.assetId ?? null) : null);
  const usesAsset = Boolean(image.assetId) && asset !== null;
  return (
    <AuthoredArtwork
      source={usesAsset ? (asset ? artworkAssetSource(asset) : null) : (image.artworkPath ?? null)}
      load={usesAsset ? artworkAssetBlob : dungeonArtworkBlob}
      className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-sunken text-[10px] text-ink-subtle"
      testIdPrefix={testId}
      emptyLabel="No art"
      missingLabel={() => 'Missing'}
      alt={() => label}
    />
  );
}
