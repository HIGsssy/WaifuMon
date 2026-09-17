/**
 * Portal Admin — Result Presentation Manager.
 *
 * Authored flavor text and artwork for lightweight outcomes: hunt finds,
 * "nothing found", and Let Her Go. Organised around the closed set of result
 * types the server defines — all of them are listed even with no variants,
 * each with what players see when nothing is enabled.
 *
 * Presentation only: nothing on this page can change an amount, an item, a
 * species or any player state. Rendered under
 * `<RequirePortalPermission permission="presentations.read">`; writes need
 * `presentations.write`, and the API re-checks both on every request.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteResultPresentation,
  getResultPresentationReference,
  listResultPresentations,
  updateResultPresentation,
  type ResultPresentationGroup,
  type ResultPresentationVariant,
} from '@/api/adminResultPresentations';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

import { VariantEditor } from './VariantEditor';
import { VariantList } from './VariantList';

const LIST_KEY = ['admin', 'result-presentations', 'list'] as const;
const REFERENCE_KEY = ['admin', 'result-presentations', 'reference'] as const;

type EditorState = { mode: 'create' } | { mode: 'edit'; variant: ResultPresentationVariant } | null;

function summary(group: ResultPresentationGroup | undefined): string {
  const count = group?.variantCount ?? 0;
  const enabled = group?.enabledCount ?? 0;
  const variants = `${count} variant${count === 1 ? '' : 's'}`;
  if (enabled === 0) return `${variants} · Built-in fallback`;
  return `${variants} · ${enabled} enabled`;
}

export function ResultPresentationsPage() {
  const canWrite = useHasPermission('presentations.write');
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editor, setEditor] = useState<EditorState>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reference = useQuery({
    queryKey: REFERENCE_KEY,
    queryFn: ({ signal }) => getResultPresentationReference(signal),
  });
  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) => listResultPresentations(signal),
  });

  const keys = useMemo(() => reference.data?.keys ?? [], [reference.data]);
  const selectedKey = searchParams.get('key') ?? keys[0]?.key ?? null;
  const keyRef = keys.find((k) => k.key === selectedKey) ?? null;
  const groups = list.data?.groups ?? [];
  const groupFor = (key: string) => groups.find((g) => g.key === key);
  const group = selectedKey ? groupFor(selectedKey) : undefined;
  const variants = group?.variants ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: LIST_KEY });

  /** Tell the author when their action leaves players on the built-in screen. */
  const reportFallback = (remainingEnabled: number) => {
    if (keyRef && remainingEnabled === 0) {
      setNotice(`${keyRef.label} now uses the built-in fallback: ${keyRef.fallbackDescription}`);
    } else {
      setNotice(null);
    }
  };

  const [busyId, setBusyId] = useState<number | null>(null);
  const setEnabled = useMutation({
    mutationFn: ({ variant, enabled }: { variant: ResultPresentationVariant; enabled: boolean }) =>
      updateResultPresentation(variant.id, { enabled }),
    onMutate: ({ variant }) => setBusyId(variant.id),
    onSuccess: (updated) => {
      const remaining = variants.filter((v) => (v.id === updated.id ? updated.enabled : v.enabled)).length;
      reportFallback(remaining);
    },
    onSettled: () => {
      setBusyId(null);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (variant: ResultPresentationVariant) => deleteResultPresentation(variant.id),
    onMutate: (variant) => setBusyId(variant.id),
    onSuccess: (_result, variant) => {
      if (editor?.mode === 'edit' && editor.variant.id === variant.id) setEditor(null);
      reportFallback(variants.filter((v) => v.id !== variant.id && v.enabled).length);
    },
    onSettled: () => {
      setBusyId(null);
      void refresh();
    },
  });
  const actionError = setEnabled.error ?? remove.error;

  const selectKey = (key: string) => {
    setEditor(null);
    setNotice(null);
    setEnabled.reset();
    remove.reset();
    setSearchParams({ key }, { replace: true });
  };

  if (reference.isError || list.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Result Presentations" />
        <ErrorState
          error={reference.error ?? list.error}
          onRetry={() => {
            void reference.refetch();
            void list.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Result Presentations"
        description="Flavor text and artwork for hunt finds and released Waifumon. Gameplay decides what happened; these only change how it is shown."
      />

      {reference.isPending || list.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <nav aria-label="Result types" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {keys.map((k) => {
            const g = groupFor(k.key);
            const active = k.key === selectedKey;
            return (
              <button
                key={k.key}
                type="button"
                onClick={() => selectKey(k.key)}
                aria-current={active ? 'true' : undefined}
                data-testid={`result-type-${k.key}`}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  active ? 'border-border-strong bg-surface-raised' : 'border-border hover:bg-surface-raised',
                )}
              >
                <span className="block font-medium">{k.label}</span>
                <span className="block text-xs text-ink-muted">{summary(g)}</span>
                <code className="block text-[10px] text-ink-subtle">{k.key}</code>
              </button>
            );
          })}
        </nav>
      )}

      {keyRef && reference.data && list.data && (
        <section className="space-y-4" aria-label={`${keyRef.label} variants`}>
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{keyRef.label}</h2>
                <p className="text-xs text-ink-muted">{summary(group)}</p>
              </div>
              {canWrite && (
                <Button
                  variant="accent"
                  onClick={() => {
                    setNotice(null);
                    setEditor({ mode: 'create' });
                  }}
                >
                  New variant
                </Button>
              )}
            </div>

            <div
              className="rounded-md border border-border bg-surface-sunken p-3 text-sm"
              data-testid="fallback-panel"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Built-in fallback</span>
                {group?.usingFallback !== false ? (
                  <Badge variant="solid" data-testid="fallback-active">
                    Active — no enabled variants
                  </Badge>
                ) : (
                  <Badge variant="outline">Used only when no variant is enabled</Badge>
                )}
              </div>
              <p className="mt-1 text-ink-muted">{keyRef.fallbackDescription}</p>
            </div>

            <p className="text-xs text-ink-muted">
              Percentages show how often each enabled variant is picked. They apply only after this
              result type has already occurred — they do not change how often it happens.
            </p>

            {notice && (
              <p role="status" className="rounded-md border border-border bg-surface-raised p-2 text-sm" data-testid="fallback-notice">
                {notice}
              </p>
            )}
            {actionError && <ErrorState error={actionError} variant="inline" />}

            <VariantList
              keyRef={keyRef}
              variants={variants}
              canWrite={canWrite}
              busyId={busyId}
              onEdit={(variant) => {
                setNotice(null);
                setEditor({ mode: 'edit', variant });
              }}
              onSetEnabled={(variant, enabled) => setEnabled.mutate({ variant, enabled })}
              onDelete={(variant) => remove.mutate(variant)}
            />
          </Card>

          {editor && (
            <VariantEditor
              key={editor.mode === 'edit' ? `edit-${editor.variant.id}` : `new-${keyRef.key}`}
              keyRef={keyRef}
              reference={reference.data}
              variant={editor.mode === 'edit' ? editor.variant : null}
              siblings={variants}
              canWrite={canWrite}
              onSaved={(saved) => {
                setEditor(null);
                reportFallback(
                  variants.filter((v) => (v.id === saved.id ? saved.enabled : v.enabled)).length +
                    (variants.some((v) => v.id === saved.id) ? 0 : saved.enabled ? 1 : 0),
                );
                void refresh();
              }}
              onClose={() => setEditor(null)}
            />
          )}
        </section>
      )}
    </div>
  );
}
