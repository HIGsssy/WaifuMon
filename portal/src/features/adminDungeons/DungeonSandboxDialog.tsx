/**
 * "Play the dungeon": the draft as it stands, walked through by the real
 * engine on the server. The author presses the buttons a player would, with a
 * Buddy strength and an inventory they make up.
 *
 * It is a rehearsal and nothing else. The server plays the whole run again
 * from the start for every press and stores none of it: no reward is given, no
 * item is used up, no run exists. What the run *would* have given or used is
 * only listed. The dialog never touches the draft.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  playDungeonSandbox,
  type DungeonDefinition,
  type DungeonReferenceData,
  type DungeonSandboxInput,
  type DungeonSandboxResult,
} from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { choiceNotes } from './eventPreviewModel';
import { clampInt, eventsOf, percentOfBasisPoints } from './dungeonEventModel';
import { useQuery } from '@tanstack/react-query';
import { getDungeonCaptureItems, type DungeonEncounterScenario } from '@/api/adminDungeons';

const select = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';
const hint = 'text-xs text-ink-muted';
/** Presses a "skip ahead" may take on the author's behalf before it stops and lets them look. */
const SKIP_LIMIT = 40;
const STRENGTHS = [
  { label: 'Weak Buddy', sp: 50 },
  { label: 'Average Buddy', sp: 200 },
  { label: 'Strong Buddy', sp: 350 },
];
const REFUSALS: Record<string, string> = {
  choice_unavailable: 'That choice can’t be picked with what this player holds and remembers.',
  locked: 'That path is locked for this player.',
  choice_required: 'An event needs one of its choices picked.',
};
const ACTION_BUTTON: Record<string, string> = {
  combat: 'Fight',
  boss: 'Fight the boss',
  reward: 'Open the treasure',
  rest: 'Rest',
};
const ENDINGS: Record<string, string> = {
  completed: 'The dungeon was completed.',
  defeated: 'The run ended in defeat.',
  extracted: 'The player left the dungeon early and kept everything.',
  abandoned: 'The run was abandoned.',
};

/** A puzzle as a player meets it: the prompt, a box to type in, and the attempts left. */
function SandboxPuzzle({
  prompt,
  remaining,
  optional,
  busy,
  onAnswer,
  onSkip,
}: {
  prompt: string;
  remaining: number | null;
  optional: boolean;
  busy: boolean;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
}) {
  const [answer, setAnswer] = useState('');
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(answer);
      }}
    >
      <p className="text-sm whitespace-pre-wrap">{prompt || 'No prompt yet.'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Sandbox puzzle answer"
          className="max-w-xs"
          maxLength={100}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={busy || answer === ''}>
          Enter answer
        </Button>
        {optional && (
          <Button size="sm" variant="outline" type="button" disabled={busy} onClick={onSkip}>
            Skip it
          </Button>
        )}
        {remaining !== null && (
          <span className="text-xs text-ink-muted">
            {remaining} {remaining === 1 ? 'attempt' : 'attempts'} left
          </span>
        )}
      </div>
    </form>
  );
}

interface Settings {
  seed: number;
  currentSp: number;
  inventory: Record<string, number>;
  encounterScenario: DungeonEncounterScenario;
}

export function DungeonSandboxDialog({
  definition,
  reference,
  onClose,
}: {
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings>({
    seed: 1,
    currentSp: 200,
    inventory: {},
    encounterScenario: {},
  });
  const hasEncounters = definition.rooms.some((r) =>
    r.actions.some((a) => a.type === 'wild_encounter' || a.type === 'rescue'),
  );
  const charms = useQuery({
    queryKey: ['dungeon-capture-items'],
    queryFn: ({ signal }) => getDungeonCaptureItems(signal),
    enabled: hasEncounters,
  });
  const encounterSlugs = [
    ...new Set(
      definition.rooms.flatMap((r) =>
        r.actions.flatMap((a) => {
          if (a.type !== 'wild_encounter' && a.type !== 'rescue') return [];
          return a.source?.kind === 'species'
            ? [a.source.species]
            : a.source?.kind === 'pool'
              ? (definition.speciesPools
                  ?.find((p) => p.id === (a.source?.kind === 'pool' ? a.source.poolId : ''))
                  ?.entries.flatMap((e) => ('species' in e ? [e.species] : [])) ?? [])
              : [];
        }),
      ),
    ),
  ];
  const [inputs, setInputs] = useState<DungeonSandboxInput[]>([]);
  const [result, setResult] = useState<DungeonSandboxResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const request = useRef(0);
  const itemName = (slug: string) =>
    reference?.items.find((i) => i.slug === slug)?.name ??
    charms.data?.items.find((i) => i.slug === slug)?.name ??
    slug;
  /** Items any event in the dungeon asks for: the ones worth pretending to hold. */
  const askedFor = useMemo(
    () => [
      ...new Set(
        eventsOf(definition).flatMap((e) =>
          e.choices.flatMap((c) => (c.items ?? []).map((i) => i.item).filter(Boolean)),
        ),
      ),
    ],
    [definition],
  );

  /** Plays `next` from the start. Returns what happened, or null when it could not be played or was superseded. */
  const play = async (next: DungeonSandboxInput[], using: Settings) => {
    const mine = ++request.current;
    setBusy(true);
    setProblem('');
    try {
      const played = await playDungeonSandbox({ definition, inputs: next, ...using });
      if (mine !== request.current) return null;
      // An input the run refused is not part of the run: keep what was actually played.
      const kept = played.stoppedBy === 'refused' ? next.slice(0, played.steps) : next;
      setInputs(kept);
      setResult(played);
      setNotice(
        played.stoppedBy === 'refused'
          ? (REFUSALS[played.refusal ?? ''] ??
              'That isn’t possible here. The run is shown as far as it got.')
          : '',
      );
      return played;
    } catch (error) {
      if (mine !== request.current) return null;
      setProblem(
        isPortalApiError(error) && error.code === 'DUNGEON_INVALID'
          ? 'This draft can’t be played yet. Close this and finish everything under “Fix before publishing” in the To do list: the game only runs a dungeon with no errors.'
          : `The run could not be played: ${error instanceof Error ? error.message : 'request failed'}`,
      );
      return null;
    } finally {
      if (mine === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    void play([], settings);
    // Played once on opening; every later run is asked for by a press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const press = (input: DungeonSandboxInput) => void play([...inputs, input], settings);
  const change = (next: Settings) => {
    setSettings(next);
    // The same presses under the new settings; a press that no longer works ends the replay there.
    void play(inputs, next);
  };
  const skipAhead = async () => {
    let presses = inputs;
    let played = result;
    for (let n = 0; n < SKIP_LIMIT && played; n++) {
      const view = played.view;
      if (view.phase === 'ended' || view.action?.event || view.action?.encounter || view.action?.puzzle) break;
      let input: DungeonSandboxInput | null = null;
      if (view.phase === 'action') input = { type: 'advance' };
      else {
        const ways = view.connections.filter((c) => c.open);
        const way = ways.find((c) => !c.toRoomCompleted) ?? ways[0];
        if (way) input = { type: 'move', connectionId: way.id };
      }
      if (!input) break;
      presses = [...presses, input];
      played = await play(presses, settings);
      if (played?.stoppedBy === 'refused') break;
    }
  };

  const view = result?.view;
  const event = view?.action?.event ?? null;
  const encounter = view?.action?.encounter ?? null;
  const puzzle = view?.action?.puzzle ?? null;
  const used = new Map<string, number>();
  let paid = 0;
  for (const effect of result?.effects ?? []) {
    if (effect.type === 'grant_rewards') paid += 1;
    if (effect.type === 'consume_items')
      for (const item of effect.items)
        used.set(item.item, (used.get(item.item) ?? 0) + item.quantity);
    if (effect.type === 'capture_attempt')
      used.set(effect.attempt.item, (used.get(effect.attempt.item) ?? 0) + 1);
  }
  const remembered = Object.entries(view?.flags ?? {})
    .filter(([, value]) => value)
    .map(([key]) => definition.flags.find((f) => f.key === key)?.description || 'an unnamed note');
  const checks = (view?.recent ?? []).flatMap((entry) => {
    const check =
      entry.kind === 'event'
        ? (entry.check as { success: boolean; chanceBasisPoints: number } | null)
        : null;
    return check
      ? [
          `Skill check ${check.success ? 'succeeded' : 'failed'} (${percentOfBasisPoints(check.chanceBasisPoints)} chance).`,
        ]
      : [];
  });
  const nothing = (view?.recent ?? []).filter((entry) => entry.kind === 'event_nothing');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel="Close test play">
        <Card
          className="max-h-full w-full max-w-2xl space-y-4 overflow-y-auto p-4 sm:p-6"
          data-testid="dungeon-sandbox"
        >
          <div className="space-y-1 pr-8">
            <DialogTitle>Play {definition.name || 'this dungeon'}</DialogTitle>
            <DialogDescription>
              A rehearsal of your draft with the real game rules.
            </DialogDescription>
            <p
              role="note"
              data-testid="sandbox-safe"
              className="rounded-md border border-border bg-surface-raised p-2 text-xs"
            >
              Nothing here is real: no reward is given, no item is used up, and no run is saved.
              Your draft is not changed.
            </p>
          </div>

          <fieldset className="space-y-2 rounded-md border border-border p-2" disabled={busy}>
            <legend className="px-1 text-xs font-medium text-ink-muted">The pretend player</legend>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Buddy strength"
                className={select}
                value={settings.currentSp}
                onChange={(e) => change({ ...settings, currentSp: Number(e.target.value) })}
              >
                {STRENGTHS.map((s) => (
                  <option key={s.sp} value={s.sp}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                title="Random pools and skill checks roll differently. The same luck always plays out the same way."
                onClick={() => {
                  const next = { ...settings, seed: settings.seed + 1 };
                  setSettings(next);
                  void play([], next);
                }}
              >
                Try different luck
              </Button>
              <span className={hint} data-testid="sandbox-luck">
                Luck #{settings.seed}
              </span>
            </div>
            {askedFor.length > 0 && (
              <div className="space-y-1">
                <p className={hint}>Pretend the player is holding:</p>
                {askedFor.map((slug) => (
                  <label key={slug} className="flex items-center gap-2 text-sm" title={slug}>
                    <Input
                      type="number"
                      min={0}
                      max={999}
                      step={1}
                      className="w-20"
                      aria-label={`Pretend the player holds ${itemName(slug)}`}
                      value={settings.inventory[slug] ?? 0}
                      onChange={(e) =>
                        change({
                          ...settings,
                          inventory: {
                            ...settings.inventory,
                            [slug]: clampInt(Number(e.target.value), 0, 999),
                          },
                        })
                      }
                    />
                    × {itemName(slug)}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {hasEncounters && (
            <fieldset disabled={busy} className="space-y-2 rounded border border-border p-2">
              <legend className="text-xs">Simulated encounter facts</legend>
              <p className={hint}>
                No live inventory, ownership, XP, quest or dungeon-run records are read or changed.
                Capture quotes use the normal formula with a simulated Buddy with no capture
                modifiers.
              </p>
              <label className="block text-xs">
                Capture rolls
                <select
                  aria-label="Simulated capture rolls"
                  className={select}
                  value={settings.encounterScenario.captureOutcome ?? 'normal'}
                  onChange={(e) =>
                    change({
                      ...settings,
                      encounterScenario: {
                        ...settings.encounterScenario,
                        captureOutcome: e.target.value as 'normal' | 'success' | 'failure',
                      },
                    })
                  }
                >
                  <option value="normal">Normal deterministic rolls</option>
                  <option value="success">Force success (authoring test)</option>
                  <option value="failure">Force failure (guaranteed items still succeed)</option>
                </select>
              </label>
              {charms.data?.items
                .filter((i) => i.enabled)
                .map((i) => (
                  <label className="flex gap-2 text-xs" key={i.slug}>
                    <Input
                      type="number"
                      min={0}
                      max={999}
                      step={1}
                      className="w-20"
                      aria-label={`Simulated charm quantity ${i.name}`}
                      value={settings.inventory[i.slug] ?? 0}
                      onChange={(e) =>
                        change({
                          ...settings,
                          inventory: {
                            ...settings.inventory,
                            [i.slug]: clampInt(Number(e.target.value), 0, 999),
                          },
                        })
                      }
                    />
                    {i.name}
                  </label>
                ))}
              {encounterSlugs.map((slug) => (
                <div className="space-y-1 border-t border-border pt-2" key={slug}>
                  <p className={hint}>
                    {result?.encounterDiagnostics?.find((d) => d.species === slug)?.name ?? slug}
                  </p>
                  <label className="flex gap-2 text-xs">
                    <Input
                      className="w-20"
                      aria-label={`Simulated acquisitions ${slug}`}
                      type="number"
                      min={0}
                      max={1000000}
                      value={settings.encounterScenario.acquisitions?.[slug] ?? 0}
                      onChange={(e) =>
                        change({
                          ...settings,
                          encounterScenario: {
                            ...settings.encounterScenario,
                            acquisitions: {
                              ...settings.encounterScenario.acquisitions,
                              [slug]: clampInt(Number(e.target.value), 0, 1000000),
                            },
                          },
                        })
                      }
                    />
                    Copies acquired from this dungeon across runs
                  </label>
                  {(['disabledSpecies', 'ownedSpecies'] as const).map((key) => (
                    <label className="flex gap-2 text-xs" key={key}>
                      <input
                        type="checkbox"
                        aria-label={`${key === 'disabledSpecies' ? 'Simulate disabled' : 'Simulate already owned'} ${slug}`}
                        checked={settings.encounterScenario[key]?.includes(slug) ?? false}
                        onChange={(e) =>
                          change({
                            ...settings,
                            encounterScenario: {
                              ...settings.encounterScenario,
                              [key]: e.target.checked
                                ? [...(settings.encounterScenario[key] ?? []), slug]
                                : (settings.encounterScenario[key]?.filter((s) => s !== slug) ??
                                  []),
                            },
                          })
                        }
                      />
                      {key === 'disabledSpecies'
                        ? 'Unavailable species (simulated disable)'
                        : 'Already in collection (no new-dex XP)'}
                    </label>
                  ))}
                </div>
              ))}
              {definition.flags
                .filter((f) => f.scope === 'run')
                .map((f) => (
                  <label className="flex gap-2 text-xs" key={f.key}>
                    <input
                      type="checkbox"
                      aria-label={`Simulated run flag ${f.description || f.key}`}
                      checked={settings.encounterScenario.flags?.includes(f.key) ?? false}
                      onChange={(e) =>
                        change({
                          ...settings,
                          encounterScenario: {
                            ...settings.encounterScenario,
                            flags: e.target.checked
                              ? [...(settings.encounterScenario.flags ?? []), f.key]
                              : (settings.encounterScenario.flags?.filter((s) => s !== f.key) ??
                                []),
                          },
                        })
                      }
                    />
                    Initially remembers: {f.description || f.key}
                  </label>
                ))}
              {definition.rooms
                .filter((r) => r.id !== definition.entranceRoomId)
                .map((r) => (
                  <label className="flex gap-2 text-xs" key={r.id}>
                    <input
                      type="checkbox"
                      aria-label={`Simulated completed room ${r.name || r.id}`}
                      checked={settings.encounterScenario.completedRooms?.includes(r.id) ?? false}
                      onChange={(e) =>
                        change({
                          ...settings,
                          encounterScenario: {
                            ...settings.encounterScenario,
                            completedRooms: e.target.checked
                              ? [...(settings.encounterScenario.completedRooms ?? []), r.id]
                              : (settings.encounterScenario.completedRooms?.filter(
                                  (s) => s !== r.id,
                                ) ?? []),
                          },
                        })
                      }
                    />
                    Initially completed: {r.name || r.id}
                  </label>
                ))}
            </fieldset>
          )}

          {problem && (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          )}
          {!view && !problem && <p role="status">Starting the run…</p>}
          {view && (
            <section aria-label="What the player sees" className="space-y-3" aria-busy={busy}>
              <div>
                <h3 className="text-sm font-semibold" data-testid="sandbox-room">
                  {view.room.name || 'Unnamed room'}
                </h3>
                {view.room.description && <p className={hint}>{view.room.description}</p>}
                <p className={hint}>
                  HP {view.hp} / {view.maxHp}
                  {remembered.length > 0 && ` · Remembers: ${remembered.join(', ')}`}
                </p>
              </div>
              {notice && (
                <p role="status" className="text-sm text-danger" data-testid="sandbox-notice">
                  {notice}
                </p>
              )}
              {((result?.eventResults.length ?? 0) > 0 || nothing.length > 0) && (
                <ul
                  className="space-y-1 rounded-md border border-border p-2 text-sm"
                  data-testid="sandbox-results"
                >
                  {result!.eventResults.map((r, n) => (
                    <li key={n}>
                      <strong className="font-medium">
                        {r.eventTitle} — {r.choiceLabel}
                      </strong>
                      {r.text && <span className="text-ink-muted"> {r.text}</span>}
                    </li>
                  ))}
                  {checks.map((line) => (
                    <li key={line} className="text-ink-muted">
                      {line}
                    </li>
                  ))}
                  {nothing.map((entry, n) => (
                    <li key={`n${n}`} className="text-ink-muted">
                      The random pool came up with nothing here.
                      {typeof entry.text === 'string' && entry.text ? ` “${entry.text}”` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {event && (
                <div
                  className="space-y-2 rounded-md border-l-4 border-accent bg-surface-sunken p-3"
                  data-testid="sandbox-event"
                >
                  <p className="font-semibold break-words">{event.title}</p>
                  <p className="text-sm whitespace-pre-wrap break-words text-ink-muted">
                    {event.text}
                  </p>
                  <ul className="space-y-2">
                    {event.choices.map((choice) => (
                      <li key={choice.id}>
                        <Button
                          size="sm"
                          variant={choice.walksAway ? 'outline' : 'accent'}
                          disabled={busy || !choice.available}
                          onClick={() => press({ type: 'choose', choiceId: choice.id })}
                        >
                          {choice.label}
                          {choice.check
                            ? ` (${percentOfBasisPoints(choice.check.chanceBasisPoints)})`
                            : ''}
                        </Button>
                        {choiceNotes(choice, itemName).map((note, n) => (
                          <p
                            key={n}
                            className={`text-xs ${note.strong ? 'font-semibold' : 'text-ink-muted'}`}
                          >
                            {note.text}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {encounter && (
                <section
                  aria-label="Sandbox encounter"
                  className="space-y-2 rounded border-l-4 border-accent p-2"
                >
                  <p className="font-semibold">
                    {encounter.name} · {encounter.rarity}
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{encounter.intro}</p>
                  <p className={hint}>
                    {encounter.available
                      ? 'Eligible for this encounter'
                      : `Unavailable: ${encounter.unavailableReason}`}
                    .{' '}
                    {encounter.mode === 'direct'
                      ? 'Direct rescue: no charm.'
                      : `${encounter.attemptsLeft} attempts left.`}
                  </p>
                  {encounter.available ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {encounter.mode === 'direct' ? (
                          <Button
                            disabled={busy}
                            size="sm"
                            onClick={() => press({ type: 'rescue' })}
                          >
                            Simulate direct rescue
                          </Button>
                        ) : (
                          <>
                            <select
                              aria-label="Sandbox capture charm"
                              className={select}
                              disabled={busy}
                              value={encounter.selectedItem ?? ''}
                              onChange={(e) => press({ type: 'select_item', item: e.target.value })}
                            >
                              <option value="">Choose a charm…</option>
                              {encounter.items.map((i) => (
                                <option key={i.item} value={i.item}>
                                  {itemName(i.item)} · {i.owned} held ·{' '}
                                  {i.guaranteed
                                    ? 'guaranteed'
                                    : `${Number((i.chance * 100).toFixed(2))}%`}
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              disabled={busy || !encounter.selectedItem}
                              onClick={() => press({ type: 'capture' })}
                            >
                              Simulate capture attempt
                            </Button>
                          </>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => press({ type: 'leave_encounter' })}
                        >
                          Leave her
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => press({ type: 'dismiss_encounter' })}
                    >
                      Continue without granting
                    </Button>
                  )}
                  {result?.encounterDiagnostics
                    ?.find((d) => d.species === encounter.species)
                    ?.items.filter((i) => encounter.items.some((e) => e.item === i.item))
                    .map((i) => (
                      <details key={i.item}>
                        <summary className={hint}>
                          {itemName(i.item)} probability and modifiers
                        </summary>
                        <dl className={hint}>
                          {Object.entries(i.breakdown).map(([key, value]) => (
                            <div key={key}>
                              <dt className="inline">{key}: </dt>
                              <dd className="inline">{String(value)}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ))}
                </section>
              )}
              {(view.recent ?? [])
                .filter((e) => e.kind === 'encounter')
                .map((e, n) => (
                  <p
                    className="text-sm whitespace-pre-wrap"
                    data-testid="sandbox-encounter-result"
                    key={n}
                  >
                    Encounter: {String(e.species ?? 'Nothing')} — {String(e.outcome)}.{' '}
                    {String(e.text ?? '')}
                  </p>
                ))}
              {result?.simulatedGrants?.map((g, n) => (
                <p className={hint} data-testid="sandbox-simulated-grant" key={n}>
                  Simulated only: {g.species}, {g.copies} ownership{' '}
                  {g.copies === 1 ? 'grant' : 'grants'}, {g.xp} XP
                  {g.item ? `; consumed 1× ${itemName(g.item)}` : '; no charm consumed'}. No
                  database changes.
                </p>
              ))}
              {result?.effects
                .filter((e) => e.type === 'capture_attempt')
                .map(
                  (e, n) =>
                    e.type === 'capture_attempt' && (
                      <p className={hint} key={`attempt-${n}`} data-testid="sandbox-capture-roll">
                        Simulated attempt {e.attempt.n}: {e.species} ·{' '}
                        {Number((e.attempt.chance * 100).toFixed(2))}% capture chance · roll{' '}
                        {Number((e.attempt.roll * 100).toFixed(2))}% ·{' '}
                        {e.attempt.success ? 'success' : 'failure'}
                        {e.consumesMicrodose ? ' · would consume a Microdose charge' : ''}.
                      </p>
                    ),
                )}
              {Object.keys(view.flags).length > 0 && (
                <p className={hint} data-testid="sandbox-result-flags">
                  Resulting run flags:{' '}
                  {Object.entries(view.flags)
                    .map(
                      ([key, value]) =>
                        `${definition.flags.find((f) => f.key === key)?.description || key}=${value}`,
                    )
                    .join(', ')}
                  .
                </p>
              )}
              {result?.encounterDiagnostics
                ?.filter((d) => !d.available || d.directReason)
                .map((d) => (
                  <p className={hint} key={d.species}>
                    {d.name}: {d.reason ? `unavailable (${d.reason})` : 'capture eligible'};{' '}
                    {d.directReason
                      ? `direct rescue unavailable (${d.directReason})`
                      : 'direct rescue eligible'}
                    ; {d.acquisitions} acquisitions from this dungeon.
                  </p>
                ))}
              {(view.recent ?? [])
                .filter((e) => e.kind === 'puzzle')
                .map((e, n) => (
                  <p className="text-sm" key={`puzzle-${n}`}>
                    {e.result === 'solved' ? '✅ Solved' : e.result === 'exhausted' ? '🔒 Out of attempts' : '❌ Incorrect'}
                    {typeof e.text === 'string' && e.text ? ` — ${e.text}` : ''}
                  </p>
                ))}
              {view.phase === 'action' && view.action && puzzle && (
                <SandboxPuzzle
                  key={view.step}
                  prompt={puzzle.prompt}
                  remaining={puzzle.attemptsRemaining}
                  optional={view.action.optional}
                  busy={busy}
                  onAnswer={(answer) => press({ type: 'answer', answer })}
                  onSkip={() => press({ type: 'decline' })}
                />
              )}
              {view.phase === 'action' && view.action && !event && !encounter && !puzzle && (
                <div className="flex flex-wrap items-center gap-2">
                  {view.action.wave && (
                    <span className="text-sm">
                      Wave {view.action.wave.index + 1} of {view.action.wave.count}
                      {view.action.wave.enemy.name ? `: ${view.action.wave.enemy.name}` : ''}
                    </span>
                  )}
                  <Button size="sm" disabled={busy} onClick={() => press({ type: 'advance' })}>
                    {view.action.label || ACTION_BUTTON[view.action.type] || 'Continue'}
                  </Button>
                  {view.action.optional && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => press({ type: 'decline' })}
                    >
                      Skip it
                    </Button>
                  )}
                </div>
              )}
              {view.phase === 'connections' && (
                <div className="space-y-1">
                  <p className={hint}>The room is finished. Where next?</p>
                  <div className="flex flex-wrap gap-2">
                    {view.connections.map((c) => (
                      <Button
                        key={c.id}
                        size="sm"
                        variant="outline"
                        disabled={busy || !c.open}
                        title={c.open ? undefined : c.lockedText || 'Locked.'}
                        onClick={() => press({ type: 'move', connectionId: c.id })}
                      >
                        {c.label || `Go to ${c.toRoomName}`}
                        {c.open ? '' : ' (locked)'}
                      </Button>
                    ))}
                    {view.canExtract && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => press({ type: 'extract' })}
                      >
                        Leave the dungeon here
                      </Button>
                    )}
                  </div>
                  {view.stuck && (
                    <p role="status" className="text-sm text-danger">
                      There is no way on from here: a player could only abandon the run.
                    </p>
                  )}
                </div>
              )}
              {view.phase === 'ended' && (
                <p role="status" className="text-sm font-medium" data-testid="sandbox-ended">
                  {ENDINGS[view.end?.outcome ?? ''] ?? 'The run is over.'}
                </p>
              )}
              <p className={hint} data-testid="sandbox-would">
                {used.size === 0 && paid === 0
                  ? 'So far a real run would have given and used nothing.'
                  : `In a real run this would have ${[
                      used.size > 0 &&
                        `used up ${[...used].map(([slug, n]) => `${n}× ${itemName(slug)}`).join(', ')}`,
                      paid > 0 && `paid rewards ${paid} ${paid === 1 ? 'time' : 'times'}`,
                    ]
                      .filter(Boolean)
                      .join(' and ')}. Here, nothing was.`}
              </p>
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {view.phase !== 'ended' && !event && !encounter && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void skipAhead()}
                  >
                    Skip ahead to the next event
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || inputs.length === 0}
                  onClick={() => void play(inputs.slice(0, -1), settings)}
                >
                  Back one step
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || inputs.length === 0}
                  onClick={() => void play([], settings)}
                >
                  Start again
                </Button>
              </div>
            </section>
          )}
        </Card>
      </DialogContent>
    </Dialog>
  );
}
