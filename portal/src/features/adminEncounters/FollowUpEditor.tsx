/**
 * "What happens next" for one choice outcome: nothing, continue to an existing
 * encounter, or create a brand-new follow-up and link it in one step.
 *
 * Stored as the outcome's `trigger_encounter` effect (see `followUps.ts`); the
 * author never sees or types the slug.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthoring } from './AuthoringContext';
import type { EffectShape } from './EffectEditor';
import { EntitySelect } from './EntitySelect';
import { followUpIndices, withFollowUp, type OutcomeBranch } from './followUps';

interface Props {
  effects: EffectShape[];
  onChange: (effects: EffectShape[]) => void;
  choiceIndex: number;
  branch: OutcomeBranch;
  /** False for the failure side of an automatic choice — it never runs. */
  runs?: boolean | undefined;
}

export function FollowUpEditor({ effects, onChange, choiceIndex, branch, runs = true }: Props) {
  const ctx = useAuthoring();
  const indices = followUpIndices(effects);
  const [mode, setMode] = useState<'idle' | 'pick' | 'create'>('idle');
  const [name, setName] = useState('');

  const first = indices.length > 0 ? effects[indices[0]!]! : null;
  const slug = first && typeof first.encounterSlug === 'string' ? first.encounterSlug : '';
  const summary = slug ? ctx.encounterSummary(slug) : null;

  if (!first && mode === 'idle') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="follow-up">
        <span className="text-ink-muted">Follow-up: none</span>
        {runs && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setMode('pick')}>
              Continue to another encounter
            </Button>
            {ctx.createFollowUp && (
              <Button type="button" size="sm" variant="outline" onClick={() => setMode('create')}>
                Create new follow-up
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  if (!first && mode === 'create') {
    return (
      <div
        className="space-y-2 rounded-md border border-border p-2 text-xs"
        data-testid="follow-up"
      >
        <label className="block text-ink-muted">
          Follow-up encounter name
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="Security Override"
          />
        </label>
        <p className="text-ink-muted">
          Creates a draft, chain-only encounter, links it here, saves this encounter, and opens the
          new one for editing. It opens for players once you set it to Active.
        </p>
        {ctx.createFollowUpBlocked && <p className="text-danger">{ctx.createFollowUpBlocked}</p>}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={!name.trim() || ctx.creatingFollowUp || ctx.createFollowUpBlocked != null}
            onClick={() => ctx.createFollowUp?.(choiceIndex, branch, name.trim())}
          >
            {ctx.creatingFollowUp ? 'Creating…' : 'Create and open'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode('idle')}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-xs" data-testid="follow-up">
      <div className="flex flex-wrap items-end gap-2">
        <EntitySelect
          label="Continue to"
          className="min-w-56 flex-1"
          value={slug}
          options={ctx.encounterOptions}
          placeholder="— pick an encounter —"
          searchLabel="Search encounters"
          onChange={(next) => {
            if (!next && !first) return;
            onChange(withFollowUp(effects, next));
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange(first ? withFollowUp(effects, null) : effects);
            setMode('idle');
          }}
        >
          Remove follow-up
        </Button>
      </div>
      {summary && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-surface p-2"
          data-testid="follow-up-summary"
        >
          <span className="font-medium text-ink">{summary.name}</span>
          <Badge variant={summary.lifecycle === 'active' ? 'solid' : 'outline'}>
            {summary.lifecycle}
          </Badge>
          <Badge variant="outline">{summary.appears}</Badge>
          {summary.linkedFrom.length > 0 && (
            <span className="text-ink-muted">also linked from {summary.linkedFrom.join(', ')}</span>
          )}
          {summary.id != null && (
            <Link
              to={`/admin/encounters/${summary.id}`}
              target="_blank"
              className="ml-auto text-accent underline"
            >
              Open in new tab
            </Link>
          )}
        </div>
      )}
      {summary && summary.lifecycle !== 'active' && (
        <p className="text-amber-500" data-testid="follow-up-inactive">
          ⚠ “{summary.name}” is {summary.lifecycle}. Follow-ups only open while Active, so players
          get no follow-up here until it is activated.
        </p>
      )}
      {slug && !summary && (
        <p className="text-danger">“{slug}” does not exist — players will get no follow-up.</p>
      )}
      {indices.length > 1 && (
        <p className="text-ink-muted">
          ⚠ This outcome has {indices.length} follow-ups; only the first is used. The others are
          listed with the effects below the list, and can be removed there.
        </p>
      )}
    </div>
  );
}
