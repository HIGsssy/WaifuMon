/**
 * The three ways a loot table gives rewards, as three sections an author reads
 * top to bottom: every time, chance drops, and random picks.
 *
 * One small form is open at a time. Rows show a sentence, not fields; the only
 * numbers edited in place are a drop's percentage and a choice's share.
 */
import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Pencil, X } from 'lucide-react';
import type { DungeonRewardGrant } from '@/api/adminDungeonLootTables';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { RewardEditor } from './RewardForm';
import {
  LOOT_LIMITS,
  describeGrant,
  formatChance,
  moved,
  newEntryId,
  parsePercent,
  parseShare,
  shareFractions,
  type FriendlyLootIssue,
  type ItemRef,
  type LootForm,
  type PoolForm,
  type PoolRow,
  type RewardNames,
} from './lootModel';

export interface SectionTools {
  names: RewardNames;
  items: readonly ItemRef[];
  readOnly: boolean;
  /** Which row's form is open: an entry ID, or `add:<section or group ID>`. */
  open: string | null;
  setOpen: (id: string | null) => void;
  /** What the author must fix at this place before saving. */
  problems: (at: string) => string[];
  /** What the server reported at this place. */
  issues: (at: string) => FriendlyLootIssue[];
  /** A marker beside a reward's sentence, such as its At risk / Kept chip. */
  chip?: (grant: DungeonRewardGrant) => ReactNode;
}
type SectionForm = Pick<LootForm, 'guaranteed' | 'chances' | 'pools'>;
/** Wording and limits for a section used outside the loot table editor. */
export interface SectionCopy {
  title: string;
  hint: string;
  /** The explanatory line under the heading. */
  intro: ReactNode;
  addLabel: string;
  max: number;
  limit: string;
}
interface SectionProps {
  form: SectionForm;
  update: (patch: Partial<SectionForm>) => void;
  tools: SectionTools;
  copy?: SectionCopy;
  /** Chance drops only: what the "always" section is called where this is shown. */
  alwaysLabel?: string;
}

export function Notes({ at, tools }: { at: string; tools: SectionTools }) {
  const problems = tools.problems(at);
  const issues = tools.issues(at);
  if (problems.length + issues.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs" data-testid="row-notes">
      {problems.map((message) => (
        <li key={message} className="text-danger" role="alert">
          {message}
        </li>
      ))}
      {issues.map((issue) => (
        <li
          key={issue.raw}
          title={issue.raw}
          className={issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
        >
          {issue.severity === 'error' ? 'Fix: ' : 'Review: '}
          {issue.text}
        </li>
      ))}
    </ul>
  );
}

export function Section({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" data-testid={testId} aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-sm font-semibold uppercase text-ink-muted">{title}</h2>
        <p className="text-xs text-ink-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

export function RowActions({
  label,
  tools,
  onMove,
  first,
  last,
  onEdit,
  onRemove,
}: {
  label: string;
  tools: SectionTools;
  onMove: (by: -1 | 1) => void;
  first: boolean;
  last: boolean;
  onEdit?: () => void;
  onRemove: () => void;
}) {
  if (tools.readOnly) return null;
  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Move ${label} up`}
        disabled={first}
        onClick={() => onMove(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Move ${label} down`}
        disabled={last}
        onClick={() => onMove(1)}
      >
        <ArrowDown />
      </Button>
      {onEdit && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Edit ${label}`}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}

export function AddButton({
  children,
  tools,
  full,
  limit,
  onClick,
}: {
  children: ReactNode;
  tools: SectionTools;
  full: boolean;
  limit: string;
  onClick: () => void;
}) {
  if (tools.readOnly) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={full} onClick={onClick}>
        {children}
      </Button>
      {full && <span className="text-xs text-ink-muted">{limit}</span>}
    </span>
  );
}

export const rowClass = 'rounded-lg border border-border bg-surface px-2 py-1.5';
export const sentenceClass = 'min-w-0 flex-1 basis-40 break-words text-sm text-ink';

/** `10 each roll, so 30 when a dungeon rolls this table 3 times.` */
function repeatExample(grant: DungeonRewardGrant, names: RewardNames): string {
  const tripled: DungeonRewardGrant =
    grant.type === 'equipment'
      ? grant
      : grant.type === 'item'
        ? { ...grant, quantity: { min: grant.quantity.min * 3, max: grant.quantity.max * 3 } }
        : { ...grant, amount: { min: grant.amount.min * 3, max: grant.amount.max * 3 } };
  const once = describeGrant(grant, names);
  return grant.type === 'equipment'
    ? `For example, ${once} here means 3 pieces when a dungeon rolls this table 3 times.`
    : `For example, ${once} here means ${describeGrant(tripled, names)} when a dungeon rolls this table 3 times.`;
}

export function GuaranteedSection({ form, update, tools, copy }: SectionProps) {
  const rows = form.guaranteed;
  const example = rows[0];
  return (
    <Section
      title={copy?.title ?? 'Every time this table is rolled'}
      hint={copy?.hint ?? 'always given'}
      testId="section-guaranteed"
    >
      {copy ? (
        copy.intro && <p className="text-xs text-ink-muted">{copy.intro}</p>
      ) : (
        <p className="text-xs text-ink-muted" data-testid="repeat-example">
          These are given on every roll of the table.{' '}
          {example
            ? repeatExample(example.grant, tools.names)
            : 'For example, 10 Baddie Shards here means 30 when a dungeon rolls this table 3 times.'}
        </p>
      )}
      <ul className="space-y-1.5">
        {rows.map((row, index) => {
          const label = describeGrant(row.grant, tools.names);
          return (
            <li key={row.id} className={rowClass} data-testid="guaranteed-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className={sentenceClass}>{label}</span>
                {tools.chip?.(row.grant)}
                <RowActions
                  label={label}
                  tools={tools}
                  first={index === 0}
                  last={index === rows.length - 1}
                  onMove={(by) => update({ guaranteed: moved(rows, index, by) })}
                  onEdit={() => tools.setOpen(tools.open === row.id ? null : row.id)}
                  onRemove={() => update({ guaranteed: rows.filter((r) => r.id !== row.id) })}
                />
              </div>
              <Notes at={row.id} tools={tools} />
              {tools.open === row.id && (
                <RewardEditor
                  initial={row.grant}
                  items={tools.items}
                  confirmLabel="Done"
                  onCancel={() => tools.setOpen(null)}
                  onConfirm={(grant) => {
                    update({
                      guaranteed: rows.map((r) => (r.id === row.id ? { ...r, grant } : r)),
                    });
                    tools.setOpen(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {tools.open === 'add:guaranteed' ? (
        <RewardEditor
          items={tools.items}
          confirmLabel="Add reward"
          onCancel={() => tools.setOpen(null)}
          onConfirm={(grant) => {
            update({ guaranteed: [...rows, { id: newEntryId('g'), grant }] });
            tools.setOpen(null);
          }}
        />
      ) : (
        <AddButton
          tools={tools}
          full={rows.length >= (copy?.max ?? LOOT_LIMITS.guaranteed)}
          limit={copy?.limit ?? `A table holds up to ${LOOT_LIMITS.guaranteed} of these.`}
          onClick={() => tools.setOpen('add:guaranteed')}
        >
          {copy?.addLabel ?? '+ Add guaranteed reward'}
        </AddButton>
      )}
    </Section>
  );
}

/** A new chance drop: its percentage, then the same reward form as everywhere else. */
function AddChance({
  tools,
  onAdd,
}: {
  tools: SectionTools;
  onAdd: (percent: string, grant: DungeonRewardGrant) => void;
}) {
  const [percent, setPercent] = useState('');
  const parsed = parsePercent(percent);
  return (
    <RewardEditor
      items={tools.items}
      confirmLabel="Add chance drop"
      blocked={'problem' in parsed ? parsed.problem : null}
      onCancel={() => tools.setOpen(null)}
      onConfirm={(grant) => onAdd(percent, grant)}
    >
      <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        Chance
        <Input
          aria-label="Chance percent"
          className="w-20"
          inputMode="decimal"
          placeholder="25"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
        % of the time
      </label>
    </RewardEditor>
  );
}

export function ChanceSection({ form, update, tools, copy, alwaysLabel }: SectionProps) {
  const rows = form.chances;
  const guaranteedFull = form.guaranteed.length >= LOOT_LIMITS.guaranteed;
  return (
    <Section
      title={copy?.title ?? 'Chance drops'}
      hint={copy?.hint ?? 'each one rolls on its own'}
      testId="section-chances"
    >
      <p className="text-xs text-ink-muted">
        {copy?.intro ??
          'Every drop here gets its own roll, so a player can get several of them, or none.'}
      </p>
      <ul className="space-y-1.5">
        {rows.map((row, index) => {
          const label = describeGrant(row.grant, tools.names);
          const parsed = parsePercent(row.percent);
          return (
            <li key={row.id} className={rowClass} data-testid="chance-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex shrink-0 items-center gap-1 text-sm text-ink-muted">
                  <Input
                    aria-label={`Chance of ${label}`}
                    className="w-20"
                    inputMode="decimal"
                    value={row.percent}
                    disabled={tools.readOnly}
                    aria-invalid={'problem' in parsed}
                    onChange={(e) =>
                      update({
                        chances: rows.map((r) =>
                          r.id === row.id ? { ...r, percent: e.target.value } : r,
                        ),
                      })
                    }
                  />
                  % chance:
                </span>
                <span className={sentenceClass}>{label}</span>
                {tools.chip?.(row.grant)}
                <RowActions
                  label={label}
                  tools={tools}
                  first={index === 0}
                  last={index === rows.length - 1}
                  onMove={(by) => update({ chances: moved(rows, index, by) })}
                  onEdit={() => tools.setOpen(tools.open === row.id ? null : row.id)}
                  onRemove={() => update({ chances: rows.filter((r) => r.id !== row.id) })}
                />
              </div>
              <Notes at={row.id} tools={tools} />
              {'always' in parsed && !tools.readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1"
                  disabled={guaranteedFull}
                  onClick={() =>
                    update({
                      chances: rows.filter((r) => r.id !== row.id),
                      guaranteed: [...form.guaranteed, { id: row.id, grant: row.grant }],
                    })
                  }
                >
                  Move to “{alwaysLabel ?? 'Every time'}”
                </Button>
              )}
              {tools.open === row.id && (
                <RewardEditor
                  initial={row.grant}
                  items={tools.items}
                  confirmLabel="Done"
                  onCancel={() => tools.setOpen(null)}
                  onConfirm={(grant) => {
                    update({ chances: rows.map((r) => (r.id === row.id ? { ...r, grant } : r)) });
                    tools.setOpen(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {tools.open === 'add:chances' ? (
        <AddChance
          tools={tools}
          onAdd={(percent, grant) => {
            update({ chances: [...rows, { id: newEntryId('c'), percent: percent.trim(), grant }] });
            tools.setOpen(null);
          }}
        />
      ) : (
        <AddButton
          tools={tools}
          full={rows.length >= (copy?.max ?? LOOT_LIMITS.chances)}
          limit={copy?.limit ?? `A table holds up to ${LOOT_LIMITS.chances} chance drops.`}
          onClick={() => tools.setOpen('add:chances')}
        >
          + Add chance drop
        </AddButton>
      )}
    </Section>
  );
}

function PoolCard({
  pool,
  tools,
  change,
  remove,
}: {
  pool: PoolForm;
  tools: SectionTools;
  change: (next: PoolForm) => void;
  remove: () => void;
}) {
  const entries = pool.entries;
  const fractions = shareFractions(entries);
  const name = pool.name.trim() || 'this group';
  const hasNothing = entries.some((e) => 'nothing' in e);
  const full = entries.length >= LOOT_LIMITS.poolEntries;
  const setEntries = (next: PoolRow[]) => change({ ...pool, entries: next });
  const addKey = `add:${pool.id}`;
  return (
    <Card className="space-y-2 p-3" data-testid="pool-card">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 text-xs text-ink-muted">
          Group name
          <Input
            aria-label="Group name"
            placeholder="Rare gear"
            value={pool.name}
            disabled={tools.readOnly}
            onChange={(e) => change({ ...pool, name: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-xs text-ink-muted">
          Picks
          <Input
            aria-label={`Picks from ${name}`}
            className="w-20"
            inputMode="numeric"
            value={pool.picks}
            disabled={tools.readOnly}
            onChange={(e) => change({ ...pool, picks: e.target.value })}
          />
        </label>
        {!tools.readOnly && (
          <Button type="button" variant="ghost" size="sm" onClick={remove}>
            Remove group
          </Button>
        )}
      </div>
      <Notes at={`${pool.id}:name`} tools={tools} />
      <Notes at={`${pool.id}:picks`} tools={tools} />
      <Notes at={pool.id} tools={tools} />
      <p className="text-xs text-ink-muted">
        One of these is picked each time. A bigger share is more likely, and the same choice can be
        picked more than once.{' '}
        {entries.length > 0 &&
          (hasNothing
            ? 'A pick can come up empty.'
            : 'With no “Nothing” row, every pick gives something.')}
      </p>
      <ul className="space-y-1.5">
        {entries.map((row, index) => {
          const label = 'grant' in row ? describeGrant(row.grant, tools.names) : 'Nothing';
          const fraction = fractions[index] ?? null;
          const invalid = 'problem' in parseShare(row.share);
          return (
            <li key={row.id} className={rowClass} data-testid="pool-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn(sentenceClass, 'nothing' in row && 'italic text-ink-muted')}>
                  {label}
                </span>
                <label className="flex shrink-0 items-center gap-1 text-xs text-ink-muted">
                  Share
                  <Input
                    aria-label={`Share of ${label} in ${name}`}
                    className="w-20"
                    inputMode="numeric"
                    value={row.share}
                    disabled={tools.readOnly}
                    aria-invalid={invalid}
                    onChange={(e) =>
                      setEntries(
                        entries.map((r) => (r.id === row.id ? { ...r, share: e.target.value } : r)),
                      )
                    }
                  />
                </label>
                <span
                  className="w-16 shrink-0 text-right text-sm tabular-nums text-ink"
                  data-testid="share-percent"
                >
                  {fraction === null ? '—' : formatChance(fraction)}
                </span>
                <span
                  className="hidden h-2 w-24 shrink-0 overflow-hidden rounded-full bg-surface-sunken sm:block"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${(fraction ?? 0) * 100}%` }}
                  />
                </span>
                <RowActions
                  label={`${label} in ${name}`}
                  tools={tools}
                  first={index === 0}
                  last={index === entries.length - 1}
                  onMove={(by) => setEntries(moved(entries, index, by))}
                  {...('grant' in row
                    ? { onEdit: () => tools.setOpen(tools.open === row.id ? null : row.id) }
                    : {})}
                  onRemove={() => setEntries(entries.filter((r) => r.id !== row.id))}
                />
              </div>
              <Notes at={row.id} tools={tools} />
              {'grant' in row && tools.open === row.id && (
                <RewardEditor
                  initial={row.grant}
                  items={tools.items}
                  confirmLabel="Done"
                  onCancel={() => tools.setOpen(null)}
                  onConfirm={(grant) => {
                    setEntries(entries.map((r) => (r.id === row.id ? { ...r, grant } : r)));
                    tools.setOpen(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      <Notes at={`${pool.id}:entries`} tools={tools} />
      {tools.open === addKey ? (
        <RewardEditor
          items={tools.items}
          confirmLabel="Add choice"
          onCancel={() => tools.setOpen(null)}
          onConfirm={(grant) => {
            setEntries([...entries, { id: newEntryId('e'), share: '1', grant }]);
            tools.setOpen(null);
          }}
        />
      ) : (
        !tools.readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={full}
              onClick={() => tools.setOpen(addKey)}
            >
              + Add reward
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={full || hasNothing}
              title={
                hasNothing
                  ? 'This group already has a Nothing row. Raise its share instead.'
                  : undefined
              }
              onClick={() =>
                setEntries([...entries, { id: newEntryId('e'), share: '1', nothing: true }])
              }
            >
              + Add “Nothing”
            </Button>
            {full && (
              <span className="text-xs text-ink-muted">
                A group holds up to {LOOT_LIMITS.poolEntries} choices.
              </span>
            )}
          </div>
        )
      )}
    </Card>
  );
}

export function PoolsSection({ form, update, tools }: SectionProps) {
  const pools = form.pools;
  return (
    <Section title="Random picks" hint="one choice from a group" testId="section-pools">
      {pools.length === 0 && (
        <p className="text-xs text-ink-muted">
          A group of random picks chooses one reward from a list, such as “one piece of rare gear,
          or nothing”.
        </p>
      )}
      {pools.map((pool) => (
        <PoolCard
          key={pool.id}
          pool={pool}
          tools={tools}
          change={(next) => update({ pools: pools.map((p) => (p.id === pool.id ? next : p)) })}
          remove={() => {
            if (
              pool.entries.length === 0 ||
              window.confirm(`Remove “${pool.name.trim() || 'this group'}” and its choices?`)
            )
              update({ pools: pools.filter((p) => p.id !== pool.id) });
          }}
        />
      ))}
      <AddButton
        tools={tools}
        full={pools.length >= LOOT_LIMITS.pools}
        limit={`A table holds up to ${LOOT_LIMITS.pools} groups.`}
        onClick={() =>
          update({ pools: [...pools, { id: newEntryId('p'), name: '', picks: '1', entries: [] }] })
        }
      >
        {pools.length === 0
          ? '+ Add a group of random picks'
          : '+ Add another group of random picks'}
      </AddButton>
    </Section>
  );
}
