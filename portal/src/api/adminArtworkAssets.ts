/**
 * Portal admin API client for managed artwork — images uploaded through the
 * Portal and referenced from authored content by id — plus enemy artwork and
 * the scene preview.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/artworkAssets.ts`. An upload sends the
 * file itself as the request body; the server reads the type from the bytes
 * and generates the stored name, so nothing here is trusted.
 *
 * Bytes are always fetched as a `Blob` through the authenticated client and
 * shown via an object URL — the Portal never builds an image URL from an id.
 */
import {
  apiClient,
  deleteData,
  getData,
  patchData,
  postBlob,
  postData,
  putData,
  requestTimeoutMs,
} from './client';

export type ArtworkAssetCategory =
  | 'dungeon_zone'
  | 'dungeon_background'
  | 'enemy_sprite'
  | 'enemy_art'
  | 'event_art'
  | 'npc_portrait'
  | 'equipment_art';

export const ARTWORK_CATEGORY_LABELS: Record<ArtworkAssetCategory, string> = {
  dungeon_zone: 'Dungeon zone art',
  dungeon_background: 'Dungeon background',
  enemy_sprite: 'Enemy sprite',
  enemy_art: 'Enemy full art',
  event_art: 'Event art',
  npc_portrait: 'NPC portrait',
  equipment_art: 'Equipment art',
};
export const ARTWORK_CATEGORIES = Object.keys(ARTWORK_CATEGORY_LABELS) as ArtworkAssetCategory[];

export type ArtworkAssetStatus = 'active' | 'disabled' | 'deleted';

export interface ArtworkAsset {
  id: string;
  category: ArtworkAssetCategory;
  name: string;
  originalFilename: string;
  mimeType: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  fileSize: number;
  /** sha256 of the image; changes when the asset is replaced. */
  contentHash: string;
  version: number;
  status: ArtworkAssetStatus;
  uploadedBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  replacedAt: string | null;
}

export interface ArtworkAssetReference {
  kind: 'dungeon_zone' | 'combat_enemy';
  key: string;
  name: string | null;
  field: string;
}

export interface ArtworkAssetEvent {
  id: number;
  action: string;
  actor: string | null;
  oldHash: string | null;
  newHash: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ArtworkAssetDetail {
  asset: ArtworkAsset;
  references: ArtworkAssetReference[];
  events: ArtworkAssetEvent[];
}

export type SpriteAnchor =
  'left' | 'center' | 'right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export const SPRITE_ANCHOR_LABELS: Record<SpriteAnchor, string> = {
  left: 'Left',
  center: 'Center',
  right: 'Right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
};
export const SPRITE_ANCHORS = Object.keys(SPRITE_ANCHOR_LABELS) as SpriteAnchor[];

export interface SpritePlacement {
  anchor: SpriteAnchor;
  /** The sprite's height as a share of the scene's: 8500 = 85%. */
  scaleBasisPoints: number;
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_SPRITE_PLACEMENT: SpritePlacement = {
  anchor: 'bottom-right',
  scaleBasisPoints: 8500,
  offsetX: 0,
  offsetY: 0,
};

export interface ArtworkMeta {
  categories: ArtworkAssetCategory[];
  mimeTypes: string[];
  maxBytes: number;
  maxDimension: number;
  scene: { width: number; height: number };
  placement: {
    anchors: SpriteAnchor[];
    scaleMin: number;
    scaleMax: number;
    offsetXMax: number;
    offsetYMax: number;
  };
}

/** What the editors assume until the server's limits arrive. */
export const FALLBACK_ARTWORK_META: ArtworkMeta = {
  categories: ARTWORK_CATEGORIES,
  mimeTypes: ['image/png', 'image/webp', 'image/jpeg'],
  maxBytes: 8 * 1024 * 1024,
  maxDimension: 4096,
  scene: { width: 1200, height: 675 },
  placement: {
    anchors: SPRITE_ANCHORS,
    scaleMin: 1000,
    scaleMax: 10_000,
    offsetXMax: 600,
    offsetYMax: 337,
  },
};

/** An image named by a managed asset, a shipped path, or both (the asset wins). */
export interface ArtworkLayerRef {
  assetId?: string | null;
  artworkPath?: string | null;
}

export interface EnemyArtworkEntry {
  key: string;
  name: string;
  enabled: boolean;
  /** Shipped (Git) values. */
  artworkPath: string | null;
  spriteArtworkPath: string | null;
  shippedPlacement: SpritePlacement | null;
  /** The Portal override; null when none was ever saved. */
  managed: {
    artworkAssetId: string | null;
    spriteAssetId: string | null;
    spritePlacement: SpritePlacement | null;
    revision: number;
    updatedAt: string;
    updatedBy: string | null;
  } | null;
  /** What is in effect. */
  visual: {
    artworkAssetId: string | null;
    artworkPath: string | null;
    spriteAssetId: string | null;
    spriteArtworkPath: string | null;
    spritePlacement: SpritePlacement;
  };
}

export const ARTWORK_ASSETS_QUERY_KEY = ['admin', 'artwork-assets'] as const;
export const ENEMY_ARTWORK_QUERY_KEY = ['admin', 'dungeons', 'enemy-artwork'] as const;

const base = '/admin/artwork';
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});
/** Uploads carry megabytes; give them longer than a JSON call. */
const uploadTimeout = () => Math.max(requestTimeoutMs(), 60_000);
const contentTypeOf = (file: Blob) =>
  FALLBACK_ARTWORK_META.mimeTypes.includes(file.type) ? file.type : 'application/octet-stream';

export function getArtworkMeta(signal?: AbortSignal): Promise<ArtworkMeta> {
  return getData<ArtworkMeta>(`${base}/meta`, withSignal(signal));
}

export function listArtworkAssets(
  query: {
    category?: ArtworkAssetCategory | undefined;
    status?: 'active' | 'disabled' | undefined;
    q?: string | undefined;
    limit?: number | undefined;
  } = {},
  signal?: AbortSignal,
): Promise<{ assets: ArtworkAsset[]; total: number }> {
  const params: Record<string, string | number> = {};
  if (query.category) params.category = query.category;
  if (query.status) params.status = query.status;
  if (query.q?.trim()) params.q = query.q.trim();
  if (query.limit) params.limit = query.limit;
  return getData(`${base}/assets`, { params, ...withSignal(signal) });
}

export function getArtworkAsset(id: string, signal?: AbortSignal): Promise<ArtworkAssetDetail> {
  return getData<ArtworkAssetDetail>(`${base}/assets/${id}`, withSignal(signal));
}

/** Upload a new image. Resolves to the created asset. */
export async function uploadArtworkAsset(
  file: File,
  options: { category: ArtworkAssetCategory; name?: string | undefined },
): Promise<ArtworkAsset> {
  const { asset } = await postData<{ asset: ArtworkAsset }>(`${base}/assets`, file, {
    params: {
      category: options.category,
      filename: file.name,
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    },
    headers: { 'Content-Type': contentTypeOf(file) },
    timeout: uploadTimeout(),
  });
  return asset;
}

/** Put a new image behind an existing asset id; everything referencing it shows the new image. */
export async function replaceArtworkAsset(id: string, file: File): Promise<ArtworkAsset> {
  const { asset } = await putData<{ asset: ArtworkAsset }>(`${base}/assets/${id}/file`, file, {
    params: { filename: file.name },
    headers: { 'Content-Type': contentTypeOf(file) },
    timeout: uploadTimeout(),
  });
  return asset;
}

export async function updateArtworkAsset(
  id: string,
  patch: { name?: string; category?: ArtworkAssetCategory },
): Promise<ArtworkAsset> {
  return (await patchData<{ asset: ArtworkAsset }>(`${base}/assets/${id}`, patch)).asset;
}

export function setArtworkAssetEnabled(
  id: string,
  enabled: boolean,
): Promise<{ asset: ArtworkAsset; references: ArtworkAssetReference[] }> {
  return putData(`${base}/assets/${id}/enabled`, { enabled });
}

/** Refused with 409 `ARTWORK_ASSET_IN_USE` (details.references) while anything references it. */
export function deleteArtworkAsset(id: string): Promise<{ deleted: true }> {
  return deleteData(`${base}/assets/${id}`);
}

/**
 * The preview source for an asset: its id and current hash, so a replaced
 * asset is a new source and the preview reloads.
 */
export const artworkAssetSource = (asset: Pick<ArtworkAsset, 'id' | 'contentHash'>) =>
  `${asset.id}@${asset.contentHash}`;

/** Bytes of an asset, from an {@link artworkAssetSource} or a bare id. */
export async function artworkAssetBlob(source: string): Promise<Blob> {
  const [id, hash] = source.split('@');
  const response = await apiClient.get<Blob>(`${base}/assets/${id}/file`, {
    ...(hash ? { params: { v: hash } } : {}),
    responseType: 'blob',
  });
  return response.data;
}

export interface ScenePreviewRequest {
  background: ArtworkLayerRef;
  sprite?: ArtworkLayerRef | null;
  placement?: SpritePlacement;
}

/** The composed scene exactly as a player screen would show it. */
export function scenePreviewBlob(request: ScenePreviewRequest): Promise<Blob> {
  return postBlob(`${base}/scene-preview`, request);
}

export function listEnemyArtwork(signal?: AbortSignal): Promise<{ enemies: EnemyArtworkEntry[] }> {
  return getData('/admin/dungeons/enemy-artwork', withSignal(signal));
}

export function saveEnemyArtwork(
  key: string,
  input: {
    artworkAssetId: string | null;
    spriteAssetId: string | null;
    spritePlacement: SpritePlacement | null;
    expectedRevision: number;
  },
): Promise<EnemyArtworkEntry> {
  return putData<EnemyArtworkEntry>(`/admin/dungeons/enemy-artwork/${key}`, input);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
