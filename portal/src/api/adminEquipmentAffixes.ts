/** E3-E.1 affix-library HTTP contracts. Authentication/CSRF stay in the shared client. */
import type { QueryClient } from '@tanstack/react-query';
import type { EquipmentIssue, EquipmentSlotName } from './adminEquipment';
import type { LibrarySummary } from './adminEquipmentRules';
import { getData, postData, putData } from './client';

export interface AffixEntry {
  key: string;
  suffix: string;
  slots: EquipmentSlotName[];
  enabled: boolean;
}
export interface LibraryMeta {
  name: string;
  description: string;
}
export interface ManagedLibrary extends LibrarySummary {
  draftEntries: AffixEntry[];
  publishedEntries: AffixEntry[];
  updatedAt: string;
  updatedBy: string | null;
}
export interface LegacyLibrary extends LibraryMeta {
  key: string;
  readOnly: true;
  rarity: 'N' | 'R' | 'SR';
  entries: AffixEntry[];
}
export interface LibraryList {
  managed: LibrarySummary[];
  legacy: LegacyLibrary[];
}
export interface LibraryValidation {
  ok: boolean;
  errors: EquipmentIssue[];
}
export interface LibraryPreview {
  draftRevision: number;
  publishedRevision: number | null;
  validation: LibraryValidation;
  changes: { path: string; before: unknown; after: unknown }[];
}
export interface LibraryRevision {
  revision: number;
  contentHash: string;
  source: 'editor' | 'import' | 'rollback';
  rolledBackFrom: number | null;
  entryCount: number;
  publishedBy: string | null;
  publishedAt: string;
  current: boolean;
}
export interface LibraryExport {
  format: 'waifumon-equipment-affix-library';
  version: 1;
  kind: 'draft' | 'published';
  revision: number;
  exportedAt: string;
  library: LibraryMeta & { key: string };
  affixes: AffixEntry[];
}
export const AFFIX_QUERY_KEY = ['admin', 'equipment', 'affix-libraries'] as const;
const root = '/v1/admin/equipment/affix-libraries';
const url = (key: string) => `${root}/${encodeURIComponent(key)}`;
/** A Portal page route (for `<Link>`), not an API path — hence no `/v1`. */
export const libraryPath = (key: string) =>
  `/admin/equipment/affix-libraries/${encodeURIComponent(key)}`;
export const listLibraries = (signal?: AbortSignal) =>
  getData<LibraryList>(root, signal ? { signal } : undefined);
export const getLibrary = (key: string, signal?: AbortSignal) =>
  getData<ManagedLibrary | LegacyLibrary>(url(key), signal ? { signal } : undefined);
export const getHistory = (key: string, signal?: AbortSignal) =>
  getData<LibraryRevision[]>(`${url(key)}/revisions`, signal ? { signal } : undefined);
export const createLibrary = (input: LibraryMeta & { key: string }) =>
  postData<ManagedLibrary>(root, input);
export const saveMeta = (key: string, meta: LibraryMeta, expectedDraftRevision: number) =>
  putData<ManagedLibrary>(`${url(key)}/meta`, { meta, expectedDraftRevision });
export const saveEntries = (key: string, entries: AffixEntry[], expectedDraftRevision: number) =>
  putData<ManagedLibrary>(`${url(key)}/draft`, { entries, expectedDraftRevision });
export const validateLibrary = (key: string) => postData<LibraryValidation>(`${url(key)}/validate`);
export const previewLibrary = (key: string) => postData<LibraryPreview>(`${url(key)}/preview`);
export const publishLibrary = (key: string, expectedDraftRevision: number) =>
  postData<ManagedLibrary>(`${url(key)}/publish`, { expectedDraftRevision });
export const rollbackLibrary = (key: string, revision: number, expectedDraftRevision: number) =>
  postData<ManagedLibrary>(`${url(key)}/rollback`, { revision, expectedDraftRevision });
export const exportLibrary = (key: string, kind: 'draft' | 'published') =>
  getData<LibraryExport>(`${url(key)}/export`, { params: { kind } });
export const importLibrary = (file: unknown, expectedDraftRevision?: number) =>
  postData<ManagedLibrary>(`${root}/import`, {
    file,
    ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
  });
export async function loadLibrary(key: string, signal?: AbortSignal) {
  const library = await getLibrary(key, signal);
  const revisions = library.readOnly ? [] : await getHistory(key, signal);
  return { library, revisions };
}
export function invalidateEquipment(client: QueryClient) {
  return client.invalidateQueries({ queryKey: ['admin', 'equipment'] });
}
