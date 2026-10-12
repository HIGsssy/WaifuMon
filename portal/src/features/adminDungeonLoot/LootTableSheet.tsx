/**
 * A loot table opened in a side sheet over the dungeon editor, so an author
 * can inspect or retune shared loot without leaving their dungeon. The dungeon
 * draft behind it is untouched; the table saves on its own.
 */
import { useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { LootTableEditor } from './LootTableEditorPage';

export const DISCARD_TABLE_EDITS = 'Discard unsaved loot table changes and close this panel?';

export function LootTableSheet({
  tableKey,
  onClose,
  onDirtyChange,
}: {
  tableKey: string;
  onClose: () => void;
  /** Lets the host protect unsaved table edits the way it protects its own. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [embedded] = useState(() => ({
    onDirtyChange: (next: boolean) => {
      setDirty(next);
      onDirtyChange(next);
    },
  }));
  const close = () => {
    if (dirty && !window.confirm(DISCARD_TABLE_EDITS)) return;
    onDirtyChange(false);
    onClose();
  };
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="right"
        closeLabel="Close loot table"
        className="w-full max-w-none sm:w-[46rem] sm:max-w-[92vw]"
      >
        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-4"
          data-testid="loot-table-sheet"
        >
          <SheetTitle className="pr-10 font-display text-xl text-ink">Loot table</SheetTitle>
          <SheetDescription className="text-sm text-ink-muted">
            Your dungeon stays as you left it behind this panel. This table is shared: saving it
            here changes it for every dungeon that uses it, and published dungeons keep their old
            loot until each is published again.
          </SheetDescription>
          <LootTableEditor tableKey={tableKey} embedded={embedded} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
