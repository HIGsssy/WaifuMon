/** The editor's always-visible bar: what is being edited, its state, and Save / Publish. */
import { Link } from 'react-router';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export type DungeonEditorView = 'map' | 'manage';

export interface DungeonEditorHeaderProps {
  name: string;
  dungeonKey: string;
  enabled: boolean;
  draftRevision: number;
  publishedRevision: number | null;
  dirty: boolean;
  validationPending: boolean;
  notice: string;
  /** Items that stop the draft being saved at all. */
  finishCount: number;
  errorCount: number;
  warningCount: number;
  canWrite: boolean;
  canPublish: boolean;
  saveDisabled: boolean;
  publishDisabled: boolean;
  validateDisabled: boolean;
  view: DungeonEditorView;
  onSave: () => void;
  onPublish: () => void;
  onValidate: () => void;
  onShowProblems: () => void;
  onViewChange: (view: DungeonEditorView) => void;
}

export function DungeonEditorHeader(props: DungeonEditorHeaderProps) {
  const plural = (n: number, word: string) => `${n} ${word}`;
  const todo = props.finishCount
    ? plural(props.finishCount, 'to finish')
    : props.errorCount
      ? plural(props.errorCount, 'to fix')
      : props.warningCount
        ? plural(props.warningCount, 'to review')
        : 'Nothing to fix';
  const blocking = props.finishCount + props.errorCount;
  // Why the next step is unavailable, said out loud rather than left as a greyed button.
  const hint = props.finishCount
    ? 'Choose an enemy for every wave to save.'
    : props.dirty
      ? props.canPublish
        ? 'Save the draft before publishing.'
        : ''
      : props.errorCount && props.canPublish
        ? 'Fix the listed items to publish.'
        : '';
  return (
    <header className="shrink-0 space-y-2 bg-canvas md:sticky md:top-16 md:z-20 lg:static">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Link
            className="text-xs text-ink-muted underline-offset-4 hover:underline"
            to="/admin/dungeons"
          >
            Back to dungeons
          </Link>
          <h1 className="truncate font-display text-xl leading-tight text-ink sm:text-2xl">
            {props.name}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={blocking ? 'danger' : 'outline'}
            size="sm"
            aria-label={`Checklist: ${todo}. Show it`}
            onClick={props.onShowProblems}
          >
            {blocking + props.warningCount === 0 ? <CircleCheck /> : <TriangleAlert />}
            {todo}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Check the dungeon for problems again"
            disabled={props.validateDisabled}
            onClick={props.onValidate}
          >
            Check again
          </Button>
          {props.canWrite && (
            <Button variant="accent" disabled={props.saveDisabled} onClick={props.onSave}>
              Save draft
            </Button>
          )}
          {props.canPublish ? (
            <Button disabled={props.publishDisabled} onClick={props.onPublish}>
              Publish draft
            </Button>
          ) : (
            <p className="max-w-48 text-xs text-ink-muted">
              Publishing and rollback require dungeons.publish permission.
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Badge variant="outline">{props.dungeonKey}</Badge>
          <Badge>{props.enabled ? 'Enabled' : 'Disabled'}</Badge>
          <Badge>Draft {props.draftRevision}</Badge>
          <Badge>
            {props.publishedRevision === null
              ? 'Unpublished'
              : `Published ${props.publishedRevision}`}
          </Badge>
          {props.dirty && (
            <Badge variant="danger" role="status">
              Unsaved dungeon changes
            </Badge>
          )}
          {props.validationPending && <span>Checking your changes…</span>}
          {hint && <span>{hint}</span>}
          {props.notice && <span role="status">{props.notice}</span>}
        </div>
        <div className="flex gap-1" role="group" aria-label="Editor view">
          {(
            [
              ['map', 'Map'],
              ['manage', 'History & export'],
            ] as const
          ).map(([view, label]) => (
            <Button
              key={view}
              size="sm"
              variant={props.view === view ? 'default' : 'ghost'}
              aria-pressed={props.view === view}
              onClick={() => props.onViewChange(view)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </header>
  );
}
