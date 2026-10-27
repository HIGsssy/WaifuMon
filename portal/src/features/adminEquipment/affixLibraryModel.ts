/** Display-only comparison; namespace, schema and assignment validation live on the server. */
import type { AffixEntry, LibraryPreview } from '@/api/adminEquipmentAffixes';
import { isPortalApiError } from '@/api/client';
import type { EquipmentIssue } from '@/api/adminEquipment';

export function affixIssues(error: unknown): EquipmentIssue[] {
  return isPortalApiError(error) && error.code === 'EQUIPMENT_CONFIG_INVALID'
    ? ((error.details?.issues as EquipmentIssue[] | undefined) ?? [])
    : [];
}
export function isAffixStale(error: unknown) {
  return (
    isPortalApiError(error) &&
    (error.code === 'EQUIPMENT_CONFIG_STALE' || error.code === 'EQUIPMENT_CONFIG_CONFLICT')
  );
}
export function entryChanges(before: AffixEntry[], after: AffixEntry[]) {
  const previous = new Map(before.map((entry) => [entry.key, entry]));
  const next = new Map(after.map((entry) => [entry.key, entry]));
  return {
    added: after.filter((entry) => !previous.has(entry.key)),
    removed: before.filter((entry) => !next.has(entry.key)),
    changed: after.flatMap((entry) => {
      const old = previous.get(entry.key);
      return old &&
        (old.suffix !== entry.suffix ||
          old.enabled !== entry.enabled ||
          JSON.stringify(old.slots) !== JSON.stringify(entry.slots))
        ? [{ before: old, after: entry }]
        : [];
    }),
    reordered:
      before
        .filter((e) => next.has(e.key))
        .map((e) => e.key)
        .join('\n') !==
      after
        .filter((e) => previous.has(e.key))
        .map((e) => e.key)
        .join('\n'),
  };
}
export function previewEntryChanges(preview: LibraryPreview) {
  const change = preview.changes.find((c) => c.path === 'entries');
  return change
    ? entryChanges((change.before ?? []) as AffixEntry[], change.after as AffixEntry[])
    : null;
}
/** Inspect uploaded contents only; this is not backend validation or authorization. */
export function importContents(
  raw: unknown,
): { key: string; name: string; description: string; affixes: unknown[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!value.library || typeof value.library !== 'object' || !Array.isArray(value.affixes))
    return null;
  const library = value.library as Record<string, unknown>;
  if (typeof library.key !== 'string' || typeof library.name !== 'string') return null;
  return {
    key: library.key,
    name: library.name,
    description: typeof library.description === 'string' ? library.description : '',
    affixes: value.affixes,
  };
}
