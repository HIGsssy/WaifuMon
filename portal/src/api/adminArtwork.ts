/**
 * Wire types for the admin artwork picker, shared by every consumer.
 *
 * The picker has no endpoint of its own: each admin area exposes
 * `<area>/artwork/browse` and `<area>/artwork/search` under its own
 * permission and with its own backend-chosen folders (see
 * `src/api/adminArtwork.ts` on the server). A consumer hands the picker an
 * {@link ArtworkSource} bound to its routes, so the component never knows
 * which area — or which folders — it is browsing.
 *
 * Every path here is relative to the assets root, exactly as an artwork
 * field stores it.
 */

export interface ArtworkFolder {
  name: string;
  path: string;
}

export interface ArtworkFile {
  name: string;
  /** What an artwork field stores, e.g. `results/hunt/purse-01.webp`. */
  path: string;
  /** Containing folder — context for telling duplicate names apart. */
  folder: string;
  extension: string;
}

export interface ArtworkDirectory {
  /** The folder listed; `''` is the top level when there are several roots. */
  path: string;
  /** Where "up" goes, or null at the top. */
  parent: string | null;
  breadcrumbs: ArtworkFolder[];
  directories: ArtworkFolder[];
  files: ArtworkFile[];
}

export interface ArtworkSearchResults {
  query: string;
  results: ArtworkFile[];
  /** More matched than were returned. */
  truncated: boolean;
  limit: number;
}

/** One consumer's picker routes, plus the bytes route for thumbnails. */
export interface ArtworkSource {
  /** Distinguishes this consumer's cached listings from another's. */
  scope: string;
  /** One folder; omitted is the top level. */
  browse(path: string | undefined, signal?: AbortSignal): Promise<ArtworkDirectory>;
  search(query: string, signal?: AbortSignal): Promise<ArtworkSearchResults>;
  /** Image bytes for a listed path — the consumer's existing artwork route. */
  loadImage(path: string): Promise<Blob>;
}
