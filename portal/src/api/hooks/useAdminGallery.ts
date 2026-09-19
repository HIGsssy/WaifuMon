/**
 * Admin Waifumon Gallery queries.
 *
 * One request for the whole catalog and one per species detail — never one per
 * species or per appearance. Artwork is not fetched here: `<img>` elements load
 * it through the image resolver.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  getAdminGalleryCatalog,
  getAdminGallerySpecies,
  type GalleryCatalog,
  type GallerySpeciesDetail,
} from '../adminGallery';
import { ADMIN_GALLERY_POLICY } from '../cachePolicy';
import { queryKeys } from '../queryKeys';

export function useAdminGalleryCatalog(): UseQueryResult<GalleryCatalog> {
  return useQuery({
    queryKey: queryKeys.adminGalleryCatalog(),
    queryFn: ({ signal }) => getAdminGalleryCatalog(signal),
    ...ADMIN_GALLERY_POLICY,
  });
}

export function useAdminGallerySpecies(
  slug: string | undefined,
): UseQueryResult<GallerySpeciesDetail> {
  return useQuery({
    queryKey: queryKeys.adminGallerySpecies(slug ?? ''),
    queryFn: ({ signal }) => getAdminGallerySpecies(slug as string, signal),
    enabled: Boolean(slug),
    ...ADMIN_GALLERY_POLICY,
  });
}
