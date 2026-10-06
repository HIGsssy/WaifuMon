/**
 * Pick enemies from the catalogue: a searchable list showing what an author
 * chooses between — the picture, the name, whether it is enabled, its stats
 * and its tags. Callers store the chosen keys; nobody types one.
 *
 * Two modes: `multiple` ticks several and adds them together (a pool), single
 * picks one and closes (a room). A disabled enemy is listed, greyed, and
 * cannot be chosen — content that already names one keeps it, but nothing new
 * may start to.
 *
 * The rows are a prop. The Dungeon editor passes its own reference data, so
 * picking an enemy there needs no enemy permission.
 */
import { useEffect, useState } from 'react';

import type { EnemyRef } from '@/api/adminEnemies';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ArtThumb } from '@/features/adminDungeons/ArtThumb';
import { cn } from '@/lib/cn';

import { enemyThumb, matchesSearch, statLine } from './enemyModel';

export function EnemyPicker({
  open,
  title,
  enemies,
  multiple = false,
  selectedKey = null,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  enemies: readonly EnemyRef[];
  /** Tick several and confirm, rather than pick one and close. */
  multiple?: boolean;
  /** Single mode: the enemy chosen now, shown as such. */
  selectedKey?: string | null;
  /** The chosen keys, in list order. Always one in single mode. */
  onPick: (keys: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [ticked, setTicked] = useState<string[]>([]);
  // Each opening starts clean: an abandoned selection is not carried over.
  useEffect(() => {
    if (open) {
      setText('');
      setTicked([]);
    }
  }, [open]);

  const shown = enemies.filter((enemy) => matchesSearch(enemy, text));
  const choose = (enemy: EnemyRef) => {
    if (!multiple) {
      onPick([enemy.key]);
      onClose();
    } else {
      setTicked(
        ticked.includes(enemy.key) ? ticked.filter((k) => k !== enemy.key) : [...ticked, enemy.key],
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Close enemy picker">
        <div
          className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg"
          data-testid="enemy-picker"
        >
          <div>
            <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-xs text-ink-muted">
              {multiple ? 'Tick every enemy to add, then confirm.' : 'Pick one enemy.'} Disabled
              enemies cannot be chosen — enable one on the Enemies page first.
            </DialogDescription>
          </div>
          <label className="text-xs text-ink-muted">
            Search
            <Input
              aria-label="Search enemies"
              placeholder="Name or tag"
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {shown.length === 0 && (
            <p className="text-xs text-ink-muted" role="status" data-testid="enemy-picker-empty">
              {enemies.length === 0
                ? 'There are no enemies yet. Create one on the Enemies page.'
                : 'No enemy matches.'}
            </p>
          )}
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {shown.map((enemy) => {
              const chosen = multiple ? ticked.includes(enemy.key) : enemy.key === selectedKey;
              return (
                <li key={enemy.key}>
                  <button
                    type="button"
                    aria-label={`${enemy.name}${enemy.enabled ? '' : ' (disabled)'}`}
                    aria-pressed={chosen}
                    disabled={!enemy.enabled}
                    data-testid={`enemy-option-${enemy.key}`}
                    onClick={() => choose(enemy)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md border p-2 text-left',
                      chosen
                        ? 'border-accent ring-1 ring-accent'
                        : 'border-border hover:border-accent',
                      !enemy.enabled && 'cursor-not-allowed opacity-50 hover:border-border',
                    )}
                  >
                    <ArtThumb
                      image={enemyThumb(enemy.visual)}
                      label={`${enemy.name} artwork`}
                      testId={`enemy-option-thumb-${enemy.key}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{enemy.name}</span>
                        {enemy.enabled ? (
                          <Badge variant="default">Enabled</Badge>
                        ) : (
                          <Badge variant="danger">Disabled</Badge>
                        )}
                        {chosen && <Badge variant="solid">{multiple ? 'Ticked' : 'Current'}</Badge>}
                      </span>
                      <span className="block text-xs text-ink-muted">{statLine(enemy)}</span>
                      {enemy.tags.length > 0 && (
                        <span className="block truncate text-xs text-ink-subtle">
                          {enemy.tags.join(', ')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {multiple && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="accent"
                disabled={ticked.length === 0}
                onClick={() => {
                  // In the catalogue's order, whatever order they were ticked in.
                  onPick(enemies.filter((e) => ticked.includes(e.key)).map((e) => e.key));
                  onClose();
                }}
              >
                {ticked.length === 0
                  ? 'Add enemies'
                  : `Add ${ticked.length} ${ticked.length === 1 ? 'enemy' : 'enemies'}`}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
