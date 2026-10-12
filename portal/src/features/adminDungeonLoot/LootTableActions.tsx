/**
 * Duplicate, archive, restore and delete for a loot table, each as one small
 * confirmation that says what will and will not happen. Used by the catalogue
 * and by the editor, so the wording and the rules are the same in both.
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DUNGEON_LOOT_TABLES_QUERY_KEY,
  archiveDungeonLootTable,
  deleteDungeonLootTable,
  duplicateDungeonLootTable,
  listDungeonLootTables,
  restoreDungeonLootTable,
  type DungeonLootTable,
  type DungeonLootTableUsage,
} from '@/api/adminDungeonLootTables';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { keyFromName } from '@/features/adminDungeons/dungeonModel';
import { LOOT_LIMITS, uniqueKey } from './lootModel';
import { deleteBlockers, dungeonUses, invalidateLootTables, type DungeonUse } from './lootUsage';

function Confirm({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <Card className="max-h-full w-full max-w-md space-y-3 overflow-y-auto p-5">
          <DialogTitle className="font-display text-lg text-ink">{title}</DialogTitle>
          {children}
        </Card>
      </DialogContent>
    </Dialog>
  );
}

interface ActionProps {
  table: DungeonLootTable;
  onClose: () => void;
  onDone: (table: DungeonLootTable) => void;
}

export function DuplicateDialog({
  table,
  onClose,
  onDone,
  unsaved = false,
}: ActionProps & { unsaved?: boolean }) {
  const client = useQueryClient();
  const [name, setName] = useState(`${table.name} copy`.slice(0, LOOT_LIMITS.name));
  // Every key, archived ones included, so the copy's hidden key never collides.
  const all = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'list', { includeArchived: true }],
    queryFn: ({ signal }) => listDungeonLootTables({ includeArchived: true }, signal),
  });
  const duplicate = useMutation({
    mutationFn: () =>
      duplicateDungeonLootTable(table.key, {
        key: uniqueKey(keyFromName(name), all.data?.tables.map((t) => t.key) ?? []),
        name: name.trim(),
      }),
    onSuccess: (copy) => {
      invalidateLootTables(client);
      onDone(copy);
    },
  });
  return (
    <Confirm title={`Duplicate ${table.name}`} onClose={onClose}>
      <DialogDescription className="text-sm text-ink-muted">
        Makes a separate copy with the same rewards. No dungeon uses the copy until you add it to
        one, and changing it never affects the original.
        {unsaved && ' It copies the last saved version, without the unsaved changes on this page.'}
      </DialogDescription>
      <label className="block text-xs text-ink-muted">
        Name of the copy
        <Input
          aria-label="Name of the copy"
          value={name}
          maxLength={LOOT_LIMITS.name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {duplicate.isError && (
        <ErrorState
          variant="inline"
          title="Could not duplicate the table"
          error={duplicate.error}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="accent"
          disabled={!name.trim() || all.isPending || duplicate.isPending}
          onClick={() => duplicate.mutate()}
        >
          {duplicate.isPending ? 'Duplicating…' : 'Duplicate table'}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Confirm>
  );
}

export function ArchiveDialog({
  table,
  onClose,
  onDone,
  uses,
}: ActionProps & { uses: DungeonUse[] }) {
  const client = useQueryClient();
  const restoring = table.archivedAt !== null;
  const change = useMutation({
    mutationFn: () =>
      (restoring ? restoreDungeonLootTable : archiveDungeonLootTable)(table.key, table.revision),
    onSuccess: (next) => {
      invalidateLootTables(client);
      onDone(next);
    },
  });
  const drafts = uses.filter((u) => u.draft);
  return (
    <Confirm title={`${restoring ? 'Restore' : 'Archive'} ${table.name}?`} onClose={onClose}>
      <DialogDescription className="text-sm text-ink-muted">
        {restoring
          ? 'The table can be chosen for dungeons again. Nothing is published by restoring it.'
          : 'An archived table can no longer be chosen for dungeons. Dungeons already published keep paying the loot they were published with. You can restore it at any time.'}
      </DialogDescription>
      {!restoring && drafts.length > 0 && (
        <p className="text-sm text-ink" data-testid="archive-warning">
          {drafts.map((u) => u.name).join(', ')} still {drafts.length === 1 ? 'uses' : 'use'} it in{' '}
          {drafts.length === 1 ? 'its draft' : 'their drafts'}, which cannot be published until the
          table is restored or removed there.
        </p>
      )}
      {change.isError && (
        <ErrorState
          variant="inline"
          title={`Could not ${restoring ? 'restore' : 'archive'} the table`}
          error={change.error}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="accent" disabled={change.isPending} onClick={() => change.mutate()}>
          {restoring ? 'Restore table' : 'Archive table'}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Confirm>
  );
}

export function DeleteDialog({
  table,
  onClose,
  onDeleted,
  uses,
}: Omit<ActionProps, 'onDone'> & { uses: DungeonUse[]; onDeleted: () => void }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteDungeonLootTable(table.key, table.revision),
    onSuccess: () => {
      invalidateLootTables(client);
      onDeleted();
    },
  });
  // The server decides; what it refused with is more current than what this page loaded.
  const refused =
    isPortalApiError(remove.error) && remove.error.code === 'DUNGEON_LOOT_TABLE_DELETE_REFUSED'
      ? dungeonUses((remove.error.details as { usage?: DungeonLootTableUsage } | undefined)?.usage)
      : null;
  const blockers = deleteBlockers(refused ?? uses);
  return (
    <Confirm title={`Delete ${table.name}?`} onClose={onClose}>
      {blockers.length > 0 ? (
        <p className="text-sm text-ink" role="alert" data-testid="delete-blocked">
          This table cannot be deleted while {blockers.map((u) => u.name).join(', ')} still{' '}
          {blockers.length === 1 ? 'needs' : 'need'} it. Remove it from{' '}
          {blockers.length === 1 ? 'that dungeon' : 'those dungeons'} first. It can stay archived in
          the meantime.
        </p>
      ) : (
        <DialogDescription className="text-sm text-ink-muted">
          This removes the table for good. Dungeons already published keep their own copy of its
          loot, so players are not affected. This cannot be undone.
        </DialogDescription>
      )}
      {remove.isError && !refused && (
        <ErrorState variant="inline" title="Could not delete the table" error={remove.error} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          disabled={blockers.length > 0 || remove.isPending}
          onClick={() => remove.mutate()}
        >
          Delete table
        </Button>
        <Button variant="outline" onClick={onClose}>
          {blockers.length > 0 ? 'Keep the table' : 'Cancel'}
        </Button>
      </div>
    </Confirm>
  );
}
