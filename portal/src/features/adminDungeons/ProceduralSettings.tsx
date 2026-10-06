/**
 * The generator's settings for a procedural dungeon.
 *
 * Laid out for the common case: how long a run is, which rooms are fixed,
 * who is fought, how much a rest heals, where a player can leave, and what
 * the rooms look like. Everything that tunes the generator itself — raw
 * weights, depth bounds, counts, guarantees, limits, extraction windows — is
 * still here and still saved the same way, folded under **Advanced** so an
 * ordinary dungeon never has to open it.
 */
import { useState } from 'react';
import { Link } from 'react-router';

import {
  DUNGEON_NODE_TYPES,
  DUNGEON_POOL_KEYS,
  DUNGEON_WEIGHTED_NODE_TYPES,
  NO_REST_RULES,
  type DepthRange,
  type DungeonContentRef,
  type DungeonExtractionWindow,
  type DungeonGenerationDoc,
  type DungeonNodeType,
  type DungeonEnemyPoolKey,
  type DungeonPoolEntryDoc,
  type DungeonPoolKey,
  type DungeonReferenceData,
  type DungeonRestRules,
  type DungeonWeightedNodeType,
  type DungeonZoneDoc,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import type { EnemyRef } from '@/api/adminEnemies';
import { useHasPermission } from '@/auth/useSession';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EnemyPicker } from '@/features/adminEnemies/EnemyPicker';
import { statLine } from '@/features/adminEnemies/enemyModel';
import { ViewEnemyLink } from '@/features/adminEnemies/enemyParts';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import { RewardsSection } from './RewardsSection';
import { ZoneBackgroundPool, ZoneScenePreview } from './ZoneBackgroundPool';
import {
  NODE_TYPE_LABELS,
  POOL_LABELS,
  basisPointsToPercent,
  issuesAt,
  newPoolEntry,
  parseTags,
  percentToBasisPoints,
} from './dungeonModel';
import {
  Advanced,
  Issues,
  NumberField,
  OptionalNumberField,
  Section,
  TypeChecks,
} from './zoneFormParts';

/**
 * Where guaranteed extraction points go. Each window holds one main-path
 * extraction node between its depths; an optional window is skipped in a run
 * too short to have room for it.
 */
function ExtractionWindows({
  windows,
  readOnly,
  onChange,
}: {
  windows: DungeonExtractionWindow[];
  readOnly: boolean;
  onChange: (next: DungeonExtractionWindow[]) => void;
}) {
  const update = (i: number, patch: Partial<DungeonExtractionWindow>) =>
    onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="space-y-2" data-testid="extraction-windows">
      <p className="text-xs text-ink-muted">
        Extraction windows — each guarantees one extraction point on the main path between its
        depths. With none, guaranteed points land at any depth from the extraction depth.
      </p>
      {windows.map((w, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3">
          <NumberField
            label={`Window ${i + 1} min depth`}
            min={1}
            value={w.minDepth}
            disabled={readOnly}
            onChange={(minDepth) => update(i, { minDepth })}
          />
          <OptionalNumberField
            label={`Window ${i + 1} max depth`}
            value={w.maxDepth}
            disabled={readOnly}
            onChange={(maxDepth) => update(i, { maxDepth })}
          />
          <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              aria-label={`Window ${i + 1} required in every run`}
              checked={w.required}
              disabled={readOnly}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            Required in every run
          </label>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove window ${i + 1}`}
              onClick={() => onChange(windows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!readOnly && windows.length < 5 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...windows, { minDepth: 1, maxDepth: null, required: false }])}
        >
          Add extraction window
        </Button>
      )}
    </div>
  );
}

export function ProceduralSettings({
  form,
  set,
  issues,
  reference,
  readOnly,
}: {
  form: DungeonZoneDoc;
  set: (patch: Partial<DungeonZoneDoc>) => void;
  issues: DungeonZoneIssue[];
  reference: DungeonReferenceData | undefined;
  readOnly: boolean;
}) {
  const canWrite = !readOnly;
  const canSeeEnemies = useHasPermission('enemies.read');
  const gen = form.generation;
  const setGen = (patch: Partial<DungeonGenerationDoc>) =>
    set({ generation: { ...gen, ...patch } });
  const setPool = (pool: DungeonPoolKey, entries: DungeonPoolEntryDoc[]) => {
    const pools = { ...form.pools, [pool]: entries };
    // The first entry in a pool whose room type has no weight would never be
    // placed. Give the type a starting weight, so adding an enemy or an event
    // is enough to see it — nobody should have to open Advanced for that.
    const firstEntry = form.pools[pool].length === 0 && entries.length > 0;
    if (firstEntry && pool !== 'boss' && gen.nodeWeights[pool] === 0) {
      set({
        pools,
        generation: { ...gen, nodeWeights: { ...gen.nodeWeights, [pool]: STARTING_WEIGHT } },
      });
    } else set({ pools });
  };
  const rest = gen.rest ?? NO_REST_RULES;
  const setRest = (patch: Partial<DungeonRestRules>) => setGen({ rest: { ...rest, ...patch } });

  const setDepthRange = (type: DungeonNodeType, patch: Partial<DepthRange>) => {
    const next = { minDepth: 1, maxDepth: null, ...gen.depthRanges[type], ...patch };
    const { [type]: _removed, ...rest } = gen.depthRanges;
    // "Anywhere" is the absence of a range, not a range of 1..∞.
    setGen({
      depthRanges: next.minDepth === 1 && next.maxDepth === null ? rest : { ...rest, [type]: next },
    });
  };
  /** Something under Advanced is wrong: open it rather than hide the problem. */
  const advancedHasErrors = [
    'generation.nodeWeights',
    'generation.depthRanges',
    'generation.noConsecutive',
    'generation.required',
    'generation.limits',
    'generation.maxConsecutiveSameEnemy',
  ].some((p) => issuesAt(issues, p).some((i) => i.severity === 'error'));

  return (
    <>
      <Section
        title="Run length & branching"
        hint="How many rooms a run has, and how often the path forks. Every run is generated fresh inside these limits."
        testId="zone-shape"
      >
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Min nodes"
            min={2}
            value={gen.minNodes}
            disabled={readOnly}
            onChange={(minNodes) => setGen({ minNodes })}
          />
          <NumberField
            label="Max nodes"
            min={2}
            value={gen.maxNodes}
            disabled={readOnly}
            onChange={(maxNodes) => setGen({ maxNodes })}
          />
          <NumberField
            label="Branch chance (%)"
            step={0.01}
            className="w-32"
            value={basisPointsToPercent(gen.branching.chanceBasisPoints)}
            disabled={readOnly}
            onChange={(percent) =>
              setGen({
                branching: { ...gen.branching, chanceBasisPoints: percentToBasisPoints(percent) },
              })
            }
          />
        </div>
        <p className="text-xs text-ink-subtle">
          A branch is a fork in the path that rejoins. 0% never forks; 100% forks whenever the run
          has room.
        </p>
        <Advanced
          title="Advanced branching"
          testId="zone-shape-advanced"
          hint="How many forks a run may hold and how long each side runs before rejoining."
        >
          <div className="flex flex-wrap items-end gap-3">
            <NumberField
              label="Min branches"
              value={gen.branching.minBranches}
              disabled={readOnly}
              onChange={(minBranches) => setGen({ branching: { ...gen.branching, minBranches } })}
            />
            <NumberField
              label="Max branches"
              value={gen.branching.maxBranches}
              disabled={readOnly}
              onChange={(maxBranches) => setGen({ branching: { ...gen.branching, maxBranches } })}
            />
            <NumberField
              label="Max branch length"
              min={1}
              className="w-32"
              value={gen.branching.maxLength}
              disabled={readOnly}
              onChange={(maxLength) => setGen({ branching: { ...gen.branching, maxLength } })}
            />
          </div>
        </Advanced>
        <Issues
          issues={['generation.minNodes', 'generation.maxNodes', 'generation.branching'].flatMap(
            (p) => issuesAt(issues, p),
          )}
        />
      </Section>

      <Section
        title="Fixed rooms"
        hint="Rooms every run has, whatever else the generator rolls: how it opens and how it ends. Everything between is generated."
        testId="zone-anchors"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            First room
            <select
              aria-label="First room"
              className={selectClass}
              value={gen.firstNodeType ?? ''}
              disabled={readOnly}
              onChange={(e) => {
                const { firstNodeType: _unset, ...rest } = gen;
                // "Any" is the absence of the field, so an untouched zone saves as it loaded.
                set({
                  generation:
                    e.target.value === ''
                      ? rest
                      : { ...gen, firstNodeType: e.target.value as DungeonWeightedNodeType },
                });
              }}
            >
              <option value="">Any — let the generator choose</option>
              {DUNGEON_WEIGHTED_NODE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {NODE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              aria-label="Final boss required"
              checked={gen.boss.required}
              disabled={readOnly}
              onChange={(e) => setGen({ boss: { required: e.target.checked } })}
            />
            Ends on a Boss
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-1"
            aria-label="Always Rest before final Boss"
            checked={rest.beforeBoss}
            disabled={readOnly}
            onChange={(e) => setRest({ beforeBoss: e.target.checked })}
          />
          <span>
            Always Rest Before Boss
            <span className="block text-xs text-ink-muted">
              Guarantees the final approach is Rest → Boss on every generated run. That depth is
              kept off every branch, so no route can bypass it. It counts toward the Rest minimum
              and maximum — it is not an extra Rest.
            </span>
          </span>
        </label>
        <p className="text-xs text-ink-subtle" data-testid="anchor-summary">
          {anchorSummary(gen)}
        </p>
        <Issues
          issues={[
            'generation.firstNodeType',
            'generation.boss',
            'generation.rest.beforeBoss',
          ].flatMap((p) => issuesAt(issues, p))}
        />
      </Section>

      {DUNGEON_POOL_KEYS.map((pool) =>
        pool === 'event' ? (
          <PoolCard
            key={pool}
            entries={form.pools[pool]}
            options={reference?.events ?? []}
            issues={issuesAt(issues, `pools.${pool}`)}
            disabled={readOnly}
            onChange={(entries) => setPool(pool, entries)}
          />
        ) : (
          <EnemyPoolCard
            key={pool}
            pool={pool}
            entries={form.pools[pool]}
            enemies={reference?.enemies}
            issues={issuesAt(issues, `pools.${pool}`)}
            disabled={readOnly}
            onChange={(entries) => setPool(pool, entries)}
          />
        ),
      )}

      <Section title="Rest & Recovery" hint="How much a Rest room heals." testId="zone-rest">
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Rest heals (% of max HP)"
            step={0.01}
            className="w-44"
            value={basisPointsToPercent(form.nodeSettings?.rest.healBasisPoints ?? 3000)}
            disabled={readOnly}
            onChange={(percent) =>
              set({ nodeSettings: { rest: { healBasisPoints: percentToBasisPoints(percent) } } })
            }
          />
        </div>
        <p className="text-xs text-ink-subtle">
          A rest restores this share of the fighter’s max HP, never above max. Runs already in
          progress keep the value they started with.
        </p>
        <Advanced
          title="Advanced rest placement"
          testId="zone-rest-advanced"
          hint="How many Rests the generator places and at which depths."
          open={issuesAt(issues, 'generation.rest').some(
            (i) => i.severity === 'error' && !i.path.startsWith('generation.rest.beforeBoss'),
          )}
        >
          <div className="flex flex-wrap items-end gap-3">
            <NumberField
              label="Minimum Rest nodes"
              className="w-36"
              value={rest.minNodes}
              disabled={readOnly}
              onChange={(minNodes) => setRest({ minNodes })}
            />
            <OptionalNumberField
              label="Maximum Rest nodes"
              min={0}
              value={rest.maxNodes}
              disabled={readOnly}
              onChange={(maxNodes) => setRest({ maxNodes })}
            />
            <NumberField
              label="Earliest Rest depth"
              min={1}
              className="w-36"
              value={rest.minDepth}
              disabled={readOnly}
              onChange={(minDepth) => setRest({ minDepth })}
            />
            <OptionalNumberField
              label="Latest Rest depth"
              value={rest.maxDepth}
              disabled={readOnly}
              onChange={(maxDepth) => setRest({ maxDepth })}
            />
          </div>
          <p className="text-xs text-ink-subtle">
            The minimum is guaranteed on the main path, where no branch can skip it. The maximum
            counts every Rest in the run. Depth 1 is the first node.
          </p>
        </Advanced>
        <Issues
          issues={['generation.rest', 'nodeSettings']
            .flatMap((p) => issuesAt(issues, p))
            // Rest → Boss is a fixed room: its problems show beside that switch.
            .filter((i) => !i.path.startsWith('generation.rest.beforeBoss'))}
        />
      </Section>

      <Section
        title="Extraction"
        hint="Where a player may leave with what they carry: from this depth on, at a Rest or an Exit."
        testId="zone-extraction"
      >
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Extraction from depth"
            min={1}
            className="w-36"
            value={gen.extraction.minDepth}
            disabled={readOnly}
            onChange={(minDepth) => setGen({ extraction: { ...gen.extraction, minDepth } })}
          />
          <NumberField
            label="Guaranteed extraction points"
            className="w-44"
            value={gen.extraction.minPoints}
            disabled={readOnly}
            onChange={(minPoints) => setGen({ extraction: { ...gen.extraction, minPoints } })}
          />
        </div>
        <p className="text-xs text-ink-subtle" data-testid="extraction-summary">
          {extractionSummary(gen)}
        </p>
        <Advanced
          title="Advanced extraction"
          testId="zone-extraction-advanced"
          hint="Which room types offer a way out, and depth windows that each guarantee one."
          open={issuesAt(issues, 'generation.extraction').some((i) => i.severity === 'error')}
        >
          <TypeChecks
            label="Extraction offered at"
            value={gen.extraction.nodeTypes}
            disabled={readOnly}
            types={DUNGEON_WEIGHTED_NODE_TYPES}
            onChange={(nodeTypes) => setGen({ extraction: { ...gen.extraction, nodeTypes } })}
          />
          <ExtractionWindows
            windows={gen.extraction.windows ?? []}
            readOnly={readOnly}
            onChange={(windows) => setGen({ extraction: { ...gen.extraction, windows } })}
          />
        </Advanced>
        <Issues issues={issuesAt(issues, 'generation.extraction')} />
      </Section>

      <RewardsSection
        form={form}
        set={set}
        issues={issues}
        reference={reference}
        readOnly={readOnly}
        authored={false}
      />

      <Section
        title="Backgrounds"
        hint="Backgrounds this zone’s rooms are drawn against. Each node of a run draws one by weight from those covering its depth, once, when the run is generated."
        testId="zone-backgrounds"
      >
        <ZoneBackgroundPool
          backgrounds={form.backgrounds ?? []}
          issues={issues}
          readOnly={readOnly}
          onChange={(backgrounds) => set({ backgrounds })}
        />
        <Issues issues={issues.filter((i) => i.path === 'backgrounds')} />
        <Advanced
          title="How a scene is chosen"
          testId="zone-scene-rules"
          hint="What a Delve screen shows, first match wins."
        >
          <div className="grid gap-4 text-xs text-ink-muted md:grid-cols-2">
            <div>
              <p className="font-medium text-ink">A fight</p>
              <ol className="ml-4 list-decimal space-y-0.5">
                <li>The node’s background with the enemy’s sprite over it</li>
                <li>The enemy’s full artwork</li>
                <li>The node’s background on its own</li>
                <li>The zone artwork, then the zone background</li>
                <li>Text only</li>
              </ol>
            </div>
            <div>
              <p className="font-medium text-ink">Event, rest, reward, exit</p>
              <ol className="ml-4 list-decimal space-y-0.5">
                <li>The event’s own artwork</li>
                <li>The node’s background on its own</li>
                <li>The zone artwork, then the zone background</li>
                <li>Text only</li>
              </ol>
            </div>
          </div>
          <p className="text-xs text-ink-muted">
            Sprites and where they stand are set per enemy under{' '}
            {canSeeEnemies ? (
              <Link to="/admin/enemies" className="text-accent underline">
                Enemies
              </Link>
            ) : (
              'Enemies'
            )}
            . A run keeps the backgrounds, sprites and placement it started with.
          </p>
          <ZoneScenePreview zone={form} enemies={reference?.enemies ?? []} />
        </Advanced>
      </Section>

      <details
        className="space-y-4 rounded-lg border border-border bg-surface p-4"
        data-testid="zone-advanced"
        {...(advancedHasErrors ? { open: true } : {})}
      >
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Advanced generator rules
        </summary>
        <p className="mt-2 text-xs text-ink-muted">
          Raw weights, depth bounds, guarantees and limits. A dungeon made from the starter template
          works without touching any of these.
        </p>
        <div className="mt-3 space-y-4">
          <Section
            title="Room types & weights"
            hint="Weight is preference among the types that are legal at a slot. Depths and “no repeats” are legality — a weight never overrides them. Rest depths here and in Rest & Recovery both apply."
            testId="zone-node-types"
          >
            <div className="space-y-2">
              {DUNGEON_WEIGHTED_NODE_TYPES.map((type) => {
                const range = gen.depthRanges[type];
                return (
                  <div
                    key={type}
                    className="flex flex-wrap items-end gap-3"
                    data-testid={`node-type-${type}`}
                  >
                    <span className="w-20 pb-2 text-sm text-ink">{NODE_TYPE_LABELS[type]}</span>
                    <NumberField
                      label={`${NODE_TYPE_LABELS[type]} weight`}
                      value={gen.nodeWeights[type]}
                      disabled={readOnly}
                      onChange={(weight) =>
                        setGen({ nodeWeights: { ...gen.nodeWeights, [type]: weight } })
                      }
                    />
                    <NumberField
                      label={`${NODE_TYPE_LABELS[type]} min depth`}
                      min={1}
                      value={range?.minDepth ?? 1}
                      disabled={readOnly}
                      onChange={(minDepth) => setDepthRange(type, { minDepth })}
                    />
                    <OptionalNumberField
                      label={`${NODE_TYPE_LABELS[type]} max depth`}
                      value={range?.maxDepth ?? null}
                      disabled={readOnly}
                      onChange={(maxDepth) => setDepthRange(type, { maxDepth })}
                    />
                    <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        aria-label={`${NODE_TYPE_LABELS[type]} never twice in a row`}
                        checked={gen.noConsecutive.includes(type)}
                        disabled={readOnly}
                        onChange={(e) =>
                          setGen({
                            noConsecutive: DUNGEON_NODE_TYPES.filter((t) =>
                              t === type ? e.target.checked : gen.noConsecutive.includes(t),
                            ),
                          })
                        }
                      />
                      Never twice in a row
                    </label>
                  </div>
                );
              })}
            </div>
            <Issues
              issues={[
                'generation.nodeWeights',
                'generation.depthRanges',
                'generation.noConsecutive',
              ].flatMap((p) => issuesAt(issues, p))}
            />
          </Section>

          <Section
            title="Guarantees & limits"
            hint="Extra guarantees and limits by node type — for example “at least one Cache or Event”. Guarantees are counted on the main path only (a node on a fork can be walked around); limits count the whole run. Rest counts belong in Rest & Recovery."
            testId="zone-constraints"
          >
            {gen.required.map((group, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3" data-testid="required-row">
                <NumberField
                  label={`Guarantee ${i + 1}: at least`}
                  min={1}
                  className="w-28"
                  value={group.min}
                  disabled={readOnly}
                  onChange={(min) =>
                    setGen({ required: gen.required.map((g, j) => (j === i ? { ...g, min } : g)) })
                  }
                />
                <TypeChecks
                  label={`Guarantee ${i + 1} of`}
                  value={group.types}
                  disabled={readOnly}
                  onChange={(types) =>
                    setGen({
                      required: gen.required.map((g, j) => (j === i ? { ...g, types } : g)),
                    })
                  }
                />
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove guarantee ${i + 1}`}
                    onClick={() => setGen({ required: gen.required.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                )}
                <Issues issues={issuesAt(issues, `generation.required[${i}]`)} />
              </div>
            ))}
            {gen.limits.map((limit, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3" data-testid="limit-row">
                <NumberField
                  label={`Limit ${i + 1}: at most`}
                  className="w-28"
                  value={limit.max}
                  disabled={readOnly}
                  onChange={(max) =>
                    setGen({ limits: gen.limits.map((l, j) => (j === i ? { ...l, max } : l)) })
                  }
                />
                <TypeChecks
                  label={`Limit ${i + 1} of`}
                  value={limit.types}
                  disabled={readOnly}
                  onChange={(types) =>
                    setGen({ limits: gen.limits.map((l, j) => (j === i ? { ...l, types } : l)) })
                  }
                />
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove limit ${i + 1}`}
                    onClick={() => setGen({ limits: gen.limits.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                )}
                <Issues issues={issuesAt(issues, `generation.limits[${i}]`)} />
              </div>
            ))}
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setGen({ required: [...gen.required, { types: ['rest'], min: 1 }] })
                  }
                >
                  Add guarantee
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setGen({ limits: [...gen.limits, { types: ['elite'], max: 1 }] })}
                >
                  Add limit
                </Button>
              </div>
            )}
            <OptionalNumberField
              label="Same enemy in a row, at most"
              value={gen.maxConsecutiveSameEnemy}
              disabled={readOnly}
              onChange={(maxConsecutiveSameEnemy) => setGen({ maxConsecutiveSameEnemy })}
            />
            <Issues issues={issuesAt(issues, 'generation.maxConsecutiveSameEnemy')} />
          </Section>
        </div>
      </details>
    </>
  );
}

/** `Start: any room → generated rooms → Rest → Boss` — the run's fixed shape in one line. */
function anchorSummary(gen: DungeonGenerationDoc): string {
  const rest = gen.rest ?? NO_REST_RULES;
  const parts = [
    gen.firstNodeType ? `${NODE_TYPE_LABELS[gen.firstNodeType]} first` : 'Any first room',
    'generated rooms',
    ...(rest.beforeBoss && gen.boss.required ? ['Rest'] : []),
    gen.boss.required ? 'Boss' : 'Exit',
  ];
  return `Every run: ${parts.join(' → ')}.`;
}

/** The extraction rules in a sentence, so the windows need not be opened to be understood. */
function extractionSummary(gen: DungeonGenerationDoc): string {
  const windows = gen.extraction.windows ?? [];
  const where = (w: DungeonExtractionWindow) =>
    w.maxDepth === null
      ? `from depth ${w.minDepth}`
      : `between depth ${w.minDepth} and ${w.maxDepth}`;
  if (windows.length === 0) {
    return gen.extraction.minPoints > 0
      ? `Every run has at least ${gen.extraction.minPoints} way${gen.extraction.minPoints === 1 ? '' : 's'} out from depth ${gen.extraction.minDepth}.`
      : 'No way out is guaranteed — a run may have none before its final room.';
  }
  return windows
    .map((w, i) =>
      w.required
        ? `${i === 0 ? 'An early' : 'A'} way out ${where(w)}, in every run.`
        : `A later way out ${where(w)}, when the run is long enough.`,
    )
    .join(' ');
}

/** The weight a room type gets when its pool receives its first entry. */
const STARTING_WEIGHT = 10;

const POOL_HINTS: Record<DungeonPoolKey, string> = {
  combat: 'The enemies ordinary fights are drawn from.',
  elite: 'Tougher fights. Leave empty for a dungeon without elites.',
  miniboss: 'Leave empty for a dungeon without minibosses.',
  boss: 'Who waits in the final room. A dungeon that ends on a Boss needs at least one.',
  event: 'Non-combat rooms. Leave empty for a dungeon without events.',
};

/** `Depth 1–4`, `Depth 3+`, or `any depth` — where in a run an entry may be drawn. */
function depthLabel(entry: DepthRange): string {
  if (entry.maxDepth !== null) return `Depth ${entry.minDepth}–${entry.maxDepth}`;
  return entry.minDepth > 1 ? `Depth ${entry.minDepth}+` : 'any depth';
}

/** Weight, depths, id, tags and the on/off switch of one pool entry — the same for enemies and events. */
function EntryTuning({
  label,
  entry,
  summary,
  disabled,
  onChange,
}: {
  label: string;
  entry: DungeonPoolEntryDoc;
  summary: string;
  disabled: boolean;
  onChange: (patch: Partial<DungeonPoolEntryDoc>) => void;
}) {
  return (
    <details className="text-xs text-ink-muted" data-testid="pool-entry-tuning">
      <summary className="cursor-pointer">{summary}</summary>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Entry id
          <Input
            aria-label={`${label} id`}
            className="w-40 font-mono"
            value={entry.id}
            disabled={disabled}
            onChange={(e) => onChange({ id: e.target.value })}
          />
        </label>
        <NumberField
          label={`${label} weight`}
          value={entry.weight}
          disabled={disabled}
          onChange={(weight) => onChange({ weight })}
        />
        <NumberField
          label={`${label} min depth`}
          min={1}
          value={entry.minDepth}
          disabled={disabled}
          onChange={(minDepth) => onChange({ minDepth })}
        />
        <OptionalNumberField
          label={`${label} max depth`}
          value={entry.maxDepth}
          disabled={disabled}
          onChange={(maxDepth) => onChange({ maxDepth })}
        />
        <label className="text-xs text-ink-muted">
          Tags
          <Input
            aria-label={`${label} tags`}
            className="w-40"
            key={entry.tags.join(',')}
            defaultValue={entry.tags.join(', ')}
            disabled={disabled}
            onBlur={(e) => onChange({ tags: parseTags(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            aria-label={`${label} enabled`}
            checked={entry.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>
    </details>
  );
}

/**
 * One of the four enemy pools. Enemies are chosen from the catalogue with the
 * picker and shown with their stats, which belong to the enemy and are not
 * edited here — an entry only says how often and how deep it is drawn.
 */
function EnemyPoolCard({
  pool,
  entries,
  enemies,
  issues,
  disabled,
  onChange,
}: {
  pool: DungeonEnemyPoolKey;
  entries: DungeonPoolEntryDoc[];
  /** Undefined until the reference data has loaded. */
  enemies: EnemyRef[] | undefined;
  issues: DungeonZoneIssue[];
  disabled: boolean;
  onChange: (next: DungeonPoolEntryDoc[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const update = (i: number, patch: Partial<DungeonPoolEntryDoc>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <Section title={POOL_LABELS[pool]} hint={POOL_HINTS[pool]} testId={`pool-${pool}`}>
      {entries.length === 0 && <p className="text-xs text-ink-subtle">No entries.</p>}
      {entries.map((entry, i) => {
        const enemy = enemies?.find((e) => e.key === entry.enemyKey);
        const label = `${POOL_LABELS[pool]} ${i + 1}`;
        return (
          <div
            key={i}
            className="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0"
            data-testid="pool-entry"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-ink" data-testid="pool-entry-name">
                {enemy ? enemy.name : enemies ? '(unknown enemy)' : 'Loading…'}
              </span>
              {enemy && !enemy.enabled && (
                <Badge variant="danger" data-testid="pool-entry-disabled">
                  disabled — not drawn
                </Badge>
              )}
              {!entry.enabled && <Badge variant="outline">switched off in this pool</Badge>}
              {enemy && (
                <span className="text-xs text-ink-muted" data-testid="pool-entry-stats">
                  {statLine(enemy)}
                </span>
              )}
              <span className="text-xs text-ink-muted" data-testid="pool-entry-odds">
                Weight {entry.weight} · {depthLabel(entry)}
              </span>
              {enemy && <ViewEnemyLink enemyKey={enemy.key} name={enemy.name} />}
              {!disabled && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(entries.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              )}
            </div>
            <EntryTuning
              label={label}
              entry={entry}
              summary="Weight, depth & tuning"
              disabled={disabled}
              onChange={(patch) => update(i, patch)}
            />
            <Issues issues={issuesAt(issues, `pools.${pool}[${i}]`)} />
          </div>
        );
      })}
      <Issues issues={issues.filter((i) => i.path === `pools.${pool}`)} />
      {!disabled && (
        <Button type="button" size="sm" variant="outline" onClick={() => setPicking(true)}>
          + Add Enemy
        </Button>
      )}
      <EnemyPicker
        open={picking}
        title={`Add enemies to the ${POOL_LABELS[pool].toLowerCase()}`}
        enemies={enemies ?? []}
        multiple
        onClose={() => setPicking(false)}
        onPick={(keys) =>
          // One entry per enemy, each with an id of its own derived from the enemy.
          onChange(
            keys.reduce<DungeonPoolEntryDoc[]>(
              (next, key) => [...next, newPoolEntry(pool, key, next)],
              entries,
            ),
          )
        }
      />
    </Section>
  );
}

/** The event pool: events are few and have no stats, so a plain list of selects does. */
function PoolCard({
  entries,
  options,
  issues,
  disabled,
  onChange,
}: {
  entries: DungeonPoolEntryDoc[];
  options: DungeonContentRef[];
  issues: DungeonZoneIssue[];
  disabled: boolean;
  onChange: (next: DungeonPoolEntryDoc[]) => void;
}) {
  const pool = 'event' as const;
  const update = (i: number, patch: Partial<DungeonPoolEntryDoc>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <Section title={POOL_LABELS[pool]} hint={POOL_HINTS[pool]} testId={`pool-${pool}`}>
      {entries.length === 0 && <p className="text-xs text-ink-subtle">No entries.</p>}
      {entries.map((entry, i) => {
        const current = entry.eventKey ?? '';
        const known = options.some((o) => o.key === current);
        const label = `${POOL_LABELS[pool]} ${i + 1}`;
        return (
          <div
            key={i}
            className="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0"
            data-testid="pool-entry"
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-ink-muted">
                Event
                <select
                  aria-label={`${label} event`}
                  className={selectClass}
                  value={current}
                  disabled={disabled}
                  onChange={(e) => update(i, { eventKey: e.target.value })}
                >
                  {!known && (
                    <option value={current}>{current || 'Choose an event'} (unknown)</option>
                  )}
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.name}
                      {o.enabled ? '' : ' (disabled)'}
                    </option>
                  ))}
                </select>
              </label>
              {!disabled && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(entries.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              )}
            </div>
            <EntryTuning
              label={label}
              entry={entry}
              summary={`Weight ${entry.weight}${
                entry.minDepth > 1 || entry.maxDepth !== null
                  ? ` · depth ${entry.minDepth}–${entry.maxDepth ?? 'end'}`
                  : ' · any depth'
              }${entry.enabled ? '' : ' · switched off'}`}
              disabled={disabled}
              onChange={(patch) => update(i, patch)}
            />
            <Issues issues={issuesAt(issues, `pools.${pool}[${i}]`)} />
          </div>
        );
      })}
      <Issues issues={issues.filter((i) => i.path === `pools.${pool}`)} />
      {!disabled && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={options.length === 0}
          onClick={() => onChange([...entries, newPoolEntry(pool, options[0]?.key ?? '', entries)])}
        >
          Add event
        </Button>
      )}
    </Section>
  );
}
