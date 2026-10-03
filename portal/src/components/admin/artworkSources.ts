/**
 * The artwork picker bound to each admin area's own routes.
 *
 * Each source reaches only its area's picker endpoints — so its permission
 * and its server-chosen folders — plus that area's existing artwork route for
 * thumbnails. A new consumer adds a source here; the picker itself does not
 * change.
 */
import type { ArtworkSource } from '@/api/adminArtwork';
import {
  browseDungeonArtwork,
  dungeonArtworkBlob,
  searchDungeonArtwork,
} from '@/api/adminDungeons';
import {
  adminEncounterArtworkBlob,
  browseAdminEncounterArtwork,
  searchAdminEncounterArtwork,
} from '@/api/adminEncounters';
import {
  browseResultPresentationArtwork,
  resultPresentationArtworkBlob,
  searchResultPresentationArtwork,
} from '@/api/adminResultPresentations';

/** Dungeon zones: `dungeons.read`, `dungeons/`. */
export const dungeonArtworkSource: ArtworkSource = {
  scope: 'dungeons',
  browse: (path, signal) => browseDungeonArtwork(path, signal),
  search: (query, signal) => searchDungeonArtwork(query, signal),
  loadImage: (path) => dungeonArtworkBlob(path),
};

/** Result Presentations: `presentations.read`, `results/`. */
export const resultPresentationArtworkSource: ArtworkSource = {
  scope: 'result-presentations',
  browse: (path, signal) => browseResultPresentationArtwork(path, signal),
  search: (query, signal) => searchResultPresentationArtwork(query, signal),
  loadImage: (path) => resultPresentationArtworkBlob(path),
};

/** World Encounters: `encounters.read`, `encounters/`. */
export const encounterArtworkSource: ArtworkSource = {
  scope: 'encounters',
  browse: (path, signal) => browseAdminEncounterArtwork(path, signal),
  search: (query, signal) => searchAdminEncounterArtwork(query, signal),
  loadImage: (path) => adminEncounterArtworkBlob(path),
};
