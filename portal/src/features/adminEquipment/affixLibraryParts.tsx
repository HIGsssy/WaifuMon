import { useContext, useEffect, useState } from 'react';
import { Link, UNSAFE_DataRouterContext, useBlocker } from 'react-router';
import { EQUIPMENT_SLOTS, SLOT_LABELS, type EquipmentIssue } from '@/api/adminEquipment';
import type { AffixEntry, LibraryPreview, LibraryValidation } from '@/api/adminEquipmentAffixes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { RulesDialog } from './RulesReview';
import { previewEntryChanges } from './affixLibraryModel';

export function AffixNavigation() {
  return (
    <nav aria-label="Equipment administration" className="flex flex-wrap gap-4 text-sm">
      {[
        ['/admin/equipment', 'Equipment Catalogue'],
        ['/admin/equipment/rarity-rules', 'Rarity Rules'],
        ['/admin/equipment/affix-libraries', 'Affix Libraries'],
      ].map(([path, label]) => (
        <Link key={path} className="text-accent underline" to={path!}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function SnapshotNotice() {
  return (
    <p className="text-sm text-ink-muted">
      Affixes are names, not combat bonuses. High-rarity equipment stores a suffix snapshot when
      rolled. Renaming, disabling or removing an entry affects future rolls; existing owned
      equipment keeps its displayed name.
    </p>
  );
}
export function AffixIssues({ issues }: { issues: EquipmentIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-danger" role="alert">
      {issues.map((issue, i) => (
        <li key={i}>
          <span className="font-medium" title={issue.path}>
            {issue.path
              .replace(/^entries\.(\d+)/, (_, n: string) => `Entry ${Number(n) + 1}`)
              .replaceAll('.', ' → ')}
          </span>
          : {issue.message}
        </li>
      ))}
    </ul>
  );
}
export function AffixValidation({ value }: { value: LibraryValidation }) {
  return (
    <div className="space-y-2">
      <p className={value.ok ? 'text-success' : 'text-danger'}>
        {value.ok ? 'Backend validation passed.' : 'Backend validation found problems.'}
      </p>
      <AffixIssues issues={value.errors} />
    </div>
  );
}

function NavigationBlocker({ when, busy }: { when: boolean; busy: boolean }) {
  const blocker = useBlocker(when);
  return blocker.state === 'blocked' ? (
    <RulesDialog
      title="Leave this library?"
      description="There are unsaved changes or an operation is still running. Leaving discards local edits. Save the draft first to keep them."
      close={() => blocker.reset()}
    >
      <Button variant="outline" onClick={() => blocker.reset()}>
        Keep editing
      </Button>
      <Button disabled={busy} onClick={() => blocker.proceed()}>
        Discard local changes and leave
      </Button>
    </RulesDialog>
  ) : null;
}
export function AffixUnsavedGuard({ when, busy = false }: { when: boolean; busy?: boolean }) {
  const router = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    if (!when) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when]);
  return router ? <NavigationBlocker when={when} busy={busy} /> : null;
}

export function AffixEntries({
  entries,
  editable = false,
  add,
  edit,
  duplicate,
  remove,
  change,
  move,
}: {
  entries: AffixEntry[];
  editable?: boolean;
  add?: () => void;
  edit?: (index: number) => void;
  duplicate?: (index: number) => void;
  remove?: (index: number) => void;
  change?: (index: number) => void;
  move?: (index: number, delta: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [slot, setSlot] = useState('');
  const [enabled, setEnabled] = useState('');
  const [page, setPage] = useState(0);
  const filtered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        `${entry.key} ${entry.suffix}`.toLowerCase().includes(search.toLowerCase()) &&
        (!slot || entry.slots.includes(slot as (typeof entry.slots)[number])) &&
        (!enabled || entry.enabled === (enabled === 'enabled')),
    );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg">Affix entries ({entries.length})</h2>
        {add && (
          <Button disabled={!editable} onClick={add}>
            Add entry
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">
          Search entries
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Key or suffix"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Eligible slot
          <select
            className={selectClass}
            value={slot}
            onChange={(e) => {
              setSlot(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All slots</option>
            {EQUIPMENT_SLOTS.map((s) => (
              <option key={s} value={s}>
                {SLOT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Entry status
          <select
            className={selectClass}
            value={enabled}
            onChange={(e) => {
              setEnabled(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All entries</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {entries.length ? 'No entries match these filters.' : 'This library has no entries yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Key</th>
                <th>Rendered suffix</th>
                <th>Slots</th>
                <th>Status</th>
                {add && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(currentPage * 25, currentPage * 25 + 25).map(({ entry, index }) => (
                <tr key={index} className="border-t border-line">
                  <td className="py-3 pr-3 font-mono text-xs">{entry.key}</td>
                  <td className="min-w-40 pr-3">{entry.suffix}</td>
                  <td className="pr-3">{entry.slots.map((s) => SLOT_LABELS[s]).join(', ')}</td>
                  <td className="pr-3">{entry.enabled ? 'Enabled' : 'Disabled'}</td>
                  {add && (
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!editable}
                          onClick={() => edit?.(index)}
                          aria-label={`Edit ${entry.key}`}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable}
                          onClick={() => duplicate?.(index)}
                          aria-label={`Duplicate ${entry.key}`}
                        >
                          Duplicate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable}
                          onClick={() => change?.(index)}
                          aria-label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.key}`}
                        >
                          {entry.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable || index === 0}
                          onClick={() => move?.(index, -1)}
                          aria-label={`Move ${entry.key} up`}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable || index === entries.length - 1}
                          onClick={() => move?.(index, 1)}
                          aria-label={`Move ${entry.key} down`}
                        >
                          ↓
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable}
                          onClick={() => remove?.(index)}
                          aria-label={`Remove ${entry.key}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 25 && (
        <div className="flex items-center gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous entries
          </Button>
          <span>
            Page {currentPage + 1} of {Math.ceil(filtered.length / 25)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(currentPage + 1) * 25 >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next entries
          </Button>
        </div>
      )}
      {add && (
        <p className="text-xs text-ink-subtle">
          Entry order is preserved when saved and used when rolling affixes. Move actions use the
          full library order, including entries hidden by filters.
        </p>
      )}
    </section>
  );
}

export function AffixEntryDialog({
  initial,
  existing,
  apply,
  close,
}: {
  initial: AffixEntry;
  existing: boolean;
  apply: (entry: AffixEntry) => void;
  close: () => void;
}) {
  const [entry, setEntry] = useState(initial);
  return (
    <RulesDialog
      title={existing ? 'Edit affix entry' : 'Add affix entry'}
      description="Suffix text is rendered exactly as entered. Keys and suffixes must be globally unique; the backend checks the saved draft."
      close={close}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply(entry);
        }}
      >
        <label className="grid gap-1 text-sm">
          Affix key
          <Input
            required
            value={entry.key}
            readOnly={existing}
            onChange={(e) => setEntry({ ...entry, key: e.target.value })}
          />
        </label>
        <p className="text-xs text-ink-muted">
          Use a stable lowercase snake_case key. To use a new key for an existing entry, duplicate
          it and choose a distinct suffix.
        </p>
        <label className="grid gap-1 text-sm">
          Rendered suffix
          <Input
            required
            value={entry.suffix}
            onChange={(e) => setEntry({ ...entry, suffix: e.target.value })}
            placeholder="of …"
          />
        </label>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1 text-sm">Eligible equipment slots</legend>
          {EQUIPMENT_SLOTS.map((slot) => (
            <label key={slot} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={entry.slots.includes(slot)}
                onChange={(e) =>
                  setEntry({
                    ...entry,
                    slots: e.target.checked
                      ? [...entry.slots, slot]
                      : entry.slots.filter((s) => s !== slot),
                  })
                }
              />
              {SLOT_LABELS[slot]}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={entry.enabled}
            onChange={(e) => setEntry({ ...entry, enabled: e.target.checked })}
          />
          Entry enabled
        </label>
        <Button type="submit">Apply local entry</Button>
        <p className="text-xs text-ink-muted">
          This changes your local form. Save entries before validation or publication.
        </p>
      </form>
    </RulesDialog>
  );
}

export function AffixDiff({ preview }: { preview: LibraryPreview }) {
  const entries = previewEntryChanges(preview);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Published revision {preview.publishedRevision ?? 'none'} → draft revision{' '}
        {preview.draftRevision}
      </p>
      {!preview.changes.length && <p>No changes from the published library.</p>}
      {preview.changes
        .filter((c) => c.path !== 'entries')
        .map((c) => (
          <p key={c.path}>
            <strong>{c.path === 'name' ? 'Display name' : 'Description'}:</strong>{' '}
            {String(c.before ?? 'Not published')} → {String(c.after ?? '')}
          </p>
        ))}
      {entries && (
        <>
          <p>
            Added {entries.added.length} · Changed {entries.changed.length} · Removed{' '}
            {entries.removed.length}
          </p>
          <ul className="list-disc space-y-2 pl-5">
            {entries.added.map((e) => (
              <li key={`a:${e.key}`}>
                Added {e.key}: {e.suffix}; {e.slots.map((s) => SLOT_LABELS[s]).join(', ')};{' '}
                {e.enabled ? 'enabled' : 'disabled'}
              </li>
            ))}
            {entries.changed.map(({ before, after }) => (
              <li key={`c:${after.key}`}>
                Changed {after.key}:{' '}
                {before.suffix !== after.suffix && (
                  <span>
                    suffix “{before.suffix}” → “{after.suffix}”;{' '}
                  </span>
                )}
                {before.enabled !== after.enabled && (
                  <span>{after.enabled ? 'Enabled' : 'Disabled'}; </span>
                )}
                {JSON.stringify(before.slots) !== JSON.stringify(after.slots) && (
                  <span>
                    slots {before.slots.map((s) => SLOT_LABELS[s]).join(', ')} →{' '}
                    {after.slots.map((s) => SLOT_LABELS[s]).join(', ')}
                  </span>
                )}
              </li>
            ))}
            {entries.removed.map((e) => (
              <li key={`r:${e.key}`}>
                Removed {e.key}: {e.suffix}
              </li>
            ))}
          </ul>
          {entries.reordered && (
            <p>
              Existing entry order changed. Future seeded rolls may select a different suffix after
              publication.
            </p>
          )}
        </>
      )}
    </div>
  );
}
