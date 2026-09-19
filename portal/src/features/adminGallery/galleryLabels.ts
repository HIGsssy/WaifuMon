/**
 * Friendly words for the gallery API's machine-readable codes.
 *
 * The server owns the codes; the Portal owns the wording. A code this build
 * does not know still renders — as its raw code, marked unknown — so a newer
 * server can never crash an older Portal.
 */
import type { GalleryIssue, GallerySpeciesSource } from '@/api/adminGallery';

interface Wording {
  label: string;
  description: string;
}

const ISSUE_WORDING: Readonly<Record<string, Wording>> = {
  species_disabled_by_loader: {
    label: 'Disabled by loader',
    description: 'No default artwork exists, so the runtime loaded this species disabled.',
  },
  default_artwork_missing: {
    label: 'Default artwork missing',
    description: 'The default appearance has no artwork file.',
  },
  appearance_artwork_missing: {
    label: 'Artwork missing',
    description: 'This appearance has no artwork file.',
  },
  artwork_unsafe: {
    label: 'Unsafe artwork path',
    description: 'The artwork resolves outside the assets folder and is refused.',
  },
  appearance_not_in_runtime: {
    label: 'Not present in runtime catalog',
    description: 'Authored, but the loader dropped it from the gameplay catalog.',
  },
  artwork_png_only: {
    label: 'PNG only',
    description: 'Only the PNG master exists; no runtime WebP has been built.',
  },
  renditions_missing: {
    label: 'Missing thumbnails',
    description: 'One or more pre-generated display sizes are missing.',
  },
};

const DIAGNOSTIC_WORDING: Readonly<Record<string, string>> = {
  species_disabled_default_artwork_missing: 'Loader disabled the species: no default artwork',
  default_appearance_artwork_missing: 'Loader kept the default look without its own file',
  appearance_dropped_artwork_missing: 'Loader dropped this appearance: artwork missing',
};

export interface DescribedCode {
  label: string;
  description: string | null;
  /** False for a code this Portal build has no wording for. */
  known: boolean;
  code: string;
}

export function describeIssue(code: string): DescribedCode {
  const wording = ISSUE_WORDING[code];
  return wording
    ? { ...wording, known: true, code }
    : { label: code, description: null, known: false, code };
}

export function describeDiagnostic(code: string): DescribedCode {
  const label = DIAGNOSTIC_WORDING[code];
  return label
    ? { label, description: null, known: true, code }
    : { label: code, description: null, known: false, code };
}

/** "1 issue" / "3 issues". */
export function issueCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'issue' : 'issues'}`;
}

/** Issues grouped by code, for a compact species-level summary. */
export function summarizeIssues(issues: readonly GalleryIssue[]): Array<{
  issue: DescribedCode;
  severity: GalleryIssue['severity'];
  count: number;
}> {
  const byCode = new Map<string, { severity: GalleryIssue['severity']; count: number }>();
  for (const i of issues) {
    const entry = byCode.get(i.code);
    if (entry) entry.count += 1;
    else byCode.set(i.code, { severity: i.severity, count: 1 });
  }
  return [...byCode.entries()].map(([code, { severity, count }]) => ({
    issue: describeIssue(code),
    severity,
    count,
  }));
}

export function sourceLabel(source: GallerySpeciesSource): string {
  return source.kind === 'core'
    ? 'Core content'
    : `${source.expansionName} (${source.expansionEnabled ? 'pack enabled' : 'pack disabled'})`;
}
