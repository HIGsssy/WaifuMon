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
  const problems = props.errorCount + props.warningCount;
  const problemLabel =
    problems === 0
      ? 'No validation problems'
      : [
          props.errorCount && `${props.errorCount} ${props.errorCount === 1 ? 'error' : 'errors'}`,
          props.warningCount &&
            `${props.warningCount} ${props.warningCount === 1 ? 'warning' : 'warnings'}`,
        ]
          .filter(Boolean)
          .join(', ');
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
            variant={props.errorCount ? 'danger' : 'outline'}
            size="sm"
            aria-label={`Validation: ${problemLabel}. Show problems`}
            onClick={props.onShowProblems}
          >
            {problems === 0 ? <CircleCheck /> : <TriangleAlert />}
            {problems === 0
              ? 'No problems'
              : `${problems} ${problems === 1 ? 'problem' : 'problems'}`}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.validateDisabled}
            onClick={props.onValidate}
          >
            Validate draft
          </Button>
          {props.canWrite && (
            <Button variant="accent" disabled={props.saveDisabled} onClick={props.onSave}>
              Save draft
            </Button>
          )}
          {props.canPublish ? (
            <Button
              disabled={props.publishDisabled}
              title={props.dirty ? 'Save your draft changes before publishing.' : undefined}
              onClick={props.onPublish}
            >
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
          {props.validationPending && <span>Validation pending for current edits.</span>}
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
