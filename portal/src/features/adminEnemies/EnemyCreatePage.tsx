/**
 * Admin — create an enemy.
 *
 * The basics and nothing else: what it is called, how hard it hits, how much
 * it takes. Create saves it and opens the editor on it — artwork, the sprite's
 * placement and the description are for there, once the enemy exists.
 *
 * The key is made from the name and can be changed here, and only here: once
 * the enemy exists, dungeons and trials refer to it by that key.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createEnemy, invalidateEnemyQueries, type EnemyIssue } from '@/api/adminEnemies';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { keyFromName } from '@/features/adminDungeons/dungeonModel';

import {
  BLANK_ENEMY_FORM,
  createInputOf,
  enemyPath,
  formErrors,
  issuesAt,
  keyError,
  type EnemyForm,
} from './enemyModel';
import { EnemyIssues, StatFields, TagInput } from './enemyParts';

/** Every field this page shows a server issue beside. */
const FIELD_PATHS = ['name', 'key', 'attack', 'defense', 'hp', 'tags'];

export function EnemyCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<EnemyForm>(BLANK_ENEMY_FORM);
  /** Set once the author types their own key; until then it follows the name. */
  const [customKey, setCustomKey] = useState<string | null>(null);
  const set = (patch: Partial<EnemyForm>) => setForm({ ...form, ...patch });

  const key = customKey ?? keyFromName(form.name);
  const named = form.name.trim() !== '';
  const badKey = keyError(key);
  const ready = formErrors(form).length === 0 && badKey === null;

  const create = useMutation({
    mutationFn: () => createEnemy(key, createInputOf(form)),
    onSuccess: (detail) => {
      invalidateEnemyQueries(queryClient);
      navigate(enemyPath(detail.key), { replace: true });
    },
  });
  const refused: EnemyIssue[] =
    isPortalApiError(create.error) && create.error.code === 'ENEMY_INVALID'
      ? (((create.error.details ?? {}) as { issues?: EnemyIssue[] }).issues ?? [])
      : [];
  const keyTaken = isPortalApiError(create.error) && create.error.code === 'ENEMY_KEY_TAKEN';
  const elsewhere = refused.filter((i) => !FIELD_PATHS.some((p) => issuesAt([i], p).length > 0));

  return (
    <div className="space-y-4">
      <PageHeader
        title="New enemy"
        description="Name it and set its stats. Artwork and everything else come after, in the editor."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/enemies">Back to enemies</Link>
          </Button>
        }
      />
      <Card className="max-w-2xl space-y-5 p-5" data-testid="enemy-create">
        <div>
          <label className="block text-sm text-ink">
            Name
            <Input
              aria-label="Enemy name"
              className="mt-1"
              placeholder="Scrapyard Drone"
              value={form.name}
              autoFocus
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <EnemyIssues issues={issuesAt(refused, 'name')} testId="enemy-name-issues" />
        </div>

        <div>
          <label className="block text-sm text-ink">
            Key
            <Input
              aria-label="Enemy key"
              className="mt-1 w-72 font-mono"
              value={key}
              onChange={(e) => setCustomKey(e.target.value)}
            />
          </label>
          <p className="mt-1 text-xs text-ink-subtle">
            Made from the name. Dungeons and trials refer to the enemy by it, so it can never be
            changed once the enemy exists.
          </p>
          {(named || customKey !== null) && badKey && (
            <p className="text-xs text-danger" role="alert">
              {badKey}
            </p>
          )}
          {keyTaken && (
            <p className="text-xs text-danger" role="alert" data-testid="enemy-key-taken">
              An enemy with the key “{key}” already exists — change the name or the key.
            </p>
          )}
          <EnemyIssues issues={issuesAt(refused, 'key')} testId="enemy-key-issues" />
        </div>

        <div>
          <StatFields form={form} disabled={false} onChange={set} />
          <p className="mt-1 text-xs text-ink-subtle">
            Attack is at least 1, defense at least 0, HP at least 1.
          </p>
          <EnemyIssues
            issues={['attack', 'defense', 'hp'].flatMap((p) => issuesAt(refused, p))}
            testId="enemy-stat-issues"
          />
        </div>

        <div>
          <TagInput value={form.tags} disabled={false} onChange={(tags) => set({ tags })} />
          <EnemyIssues issues={issuesAt(refused, 'tags')} testId="enemy-tag-issues" />
        </div>

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-1"
            aria-label="Enemy enabled"
            checked={form.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <span>
            Enabled
            <span className="block text-xs text-ink-muted">
              Only an enabled enemy can be picked for a dungeon. Nothing uses a new enemy until you
              add it somewhere.
            </span>
          </span>
        </label>

        <EnemyIssues issues={elsewhere} />
        {create.isError && !keyTaken && refused.length === 0 && (
          <ErrorState variant="inline" title="Could not create the enemy" error={create.error} />
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="accent"
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create enemy'}
          </Button>
          <span className="text-xs text-ink-subtle">Opens the editor, where artwork is added.</span>
        </div>
      </Card>
    </div>
  );
}
