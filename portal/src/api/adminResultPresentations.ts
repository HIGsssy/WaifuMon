/**
 * Portal admin API client for Result Presentations.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/resultPresentations.ts`. The canonical
 * presentation keys, labels, legal artwork modes, defaults and limits are
 * *read from the reference endpoint* — this module deliberately declares no
 * second copy of those rules, only the wire types.
 */
import type { ArtworkDirectory, ArtworkSearchResults } from './adminArtwork';
import { apiClient, deleteData, getData, patchData, postData } from './client';

export type ArtworkMode = 'custom' | 'encountered' | 'none';

/** A presentation key. Opaque here: the list itself comes from the server. */
export type PresentationKey = string;

export interface ResultPresentationVariant {
  id: number;
  presentationKey: PresentationKey;
  enabled: boolean;
  weight: number;
  flavorText: string | null;
  artworkMode: ArtworkMode;
  artworkPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResultPresentationGroup {
  key: PresentationKey;
  label: string;
  variantCount: number;
  enabledCount: number;
  /** No enabled variant: players see the built-in screen. */
  usingFallback: boolean;
  variants: ResultPresentationVariant[];
}

export interface PresentationKeyReference {
  key: PresentationKey;
  label: string;
  allowedArtworkModes: ArtworkMode[];
  defaultArtworkMode: ArtworkMode;
  fallbackDescription: string;
  /** What players see when a variant has no flavor text of its own. */
  emptyFlavorDescription: string;
}

export interface PreviewSpecies {
  slug: string;
  name: string;
  rarity: string;
}

export interface ResultPresentationReference {
  keys: PresentationKeyReference[];
  flavorTextMaxLength: number;
  maxWeight: number;
  supportedArtworkExtensions: string[];
  previewSpecies: PreviewSpecies[];
  defaultPreviewSpeciesSlug: string | null;
  sampleNotice: string;
}

/** The editable fields. The key is fixed at creation. */
export interface ResultPresentationFields {
  enabled: boolean;
  weight: number;
  flavorText: string | null;
  artworkMode: ArtworkMode;
  artworkPath: string | null;
}

export interface PreviewSection {
  kind: 'flavor' | 'mechanical' | 'level_up' | 'buddy';
  text: string;
  /** Gameplay values from the server's fixture, not from the variant. */
  sample: boolean;
}

export type PreviewArtwork =
  | { mode: 'none' }
  | { mode: 'custom'; path: string; status: 'available' | 'missing' | 'unsafe' }
  | { mode: 'encountered'; species: PreviewSpecies | null; available: boolean };

export interface ResultPresentationPreview {
  key: PresentationKey;
  label: string;
  screen: {
    title: string;
    sections: PreviewSection[];
    description: string;
    color: number;
    footer: string | null;
  };
  artwork: PreviewArtwork;
  artworkMode: ArtworkMode;
  flavorSource: 'authored' | 'fallback' | 'none';
  flavorNote: string | null;
  sampleNotice: string;
  previewSpecies: PreviewSpecies | null;
}

/** What the preview may be asked about: the look of one unsaved variant. */
export interface PreviewRequest {
  variant: {
    presentationKey: PresentationKey;
    flavorText: string | null;
    artworkMode: ArtworkMode;
    artworkPath: string | null;
  };
  previewSpeciesSlug?: string | null;
}

const BASE = '/v1/admin/result-presentations';

export function getResultPresentationReference(
  signal?: AbortSignal,
): Promise<ResultPresentationReference> {
  return getData<ResultPresentationReference>(`${BASE}/reference`, signal ? { signal } : {});
}

export function listResultPresentations(
  signal?: AbortSignal,
): Promise<{ groups: ResultPresentationGroup[] }> {
  return getData<{ groups: ResultPresentationGroup[] }>(BASE, signal ? { signal } : {});
}

export function getResultPresentation(
  id: number,
  signal?: AbortSignal,
): Promise<ResultPresentationVariant> {
  return getData<ResultPresentationVariant>(`${BASE}/${id}`, signal ? { signal } : {});
}

export function createResultPresentation(
  input: { presentationKey: PresentationKey } & ResultPresentationFields,
): Promise<ResultPresentationVariant> {
  return postData<ResultPresentationVariant>(BASE, input);
}

/** Partial edit. Never creates: a deleted variant answers 404. */
export function updateResultPresentation(
  id: number,
  patch: Partial<ResultPresentationFields>,
): Promise<ResultPresentationVariant> {
  return patchData<ResultPresentationVariant>(`${BASE}/${id}`, patch);
}

export function deleteResultPresentation(id: number): Promise<{ id: number; deleted: true }> {
  return deleteData<{ id: number; deleted: true }>(`${BASE}/${id}`);
}

/** Preview the unsaved variant. Read-only on the server; persists nothing. */
export function previewResultPresentation(
  request: PreviewRequest,
  signal?: AbortSignal,
): Promise<ResultPresentationPreview> {
  return postData<ResultPresentationPreview>(`${BASE}/preview`, request, signal ? { signal } : {});
}

/**
 * Custom artwork bytes for the editor preview — the path is the subject here,
 * so the API answers with bytes rather than the page building a URL. The
 * caller owns the object URL.
 */
export async function resultPresentationArtworkBlob(path: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${BASE}/artwork`, {
    params: { path },
    responseType: 'blob',
  });
  return response.data;
}

/** One folder of presentation artwork for the picker (`results/` only, server-chosen). */
export function browseResultPresentationArtwork(
  path: string | undefined,
  signal?: AbortSignal,
): Promise<ArtworkDirectory> {
  return getData<ArtworkDirectory>(`${BASE}/artwork/browse`, {
    params: path ? { path } : {},
    ...(signal ? { signal } : {}),
  });
}

/** Search presentation artwork by file name or folder. */
export function searchResultPresentationArtwork(
  query: string,
  signal?: AbortSignal,
): Promise<ArtworkSearchResults> {
  return getData<ArtworkSearchResults>(`${BASE}/artwork/search`, {
    params: { q: query },
    ...(signal ? { signal } : {}),
  });
}

/** A Waifumon's release-screen artwork, by species slug, for the preview. */
export async function resultPresentationSpeciesArtworkBlob(slug: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${BASE}/preview/species-artwork`, {
    params: { slug },
    responseType: 'blob',
  });
  return response.data;
}

/** Per-field problems from a 400, keyed by field name ('' for the variant). */
export function fieldIssuesOf(error: unknown): Record<string, string> {
  const details = (error as { details?: { issues?: unknown } } | null)?.details;
  const issues = Array.isArray(details?.issues) ? details.issues : [];
  const out: Record<string, string> = {};
  for (const issue of issues as Array<{ path?: unknown; message?: unknown }>) {
    const path = typeof issue.path === 'string' ? issue.path.replace(/^\//, '') : '';
    if (typeof issue.message === 'string' && !(path in out)) out[path] = issue.message;
  }
  return out;
}
