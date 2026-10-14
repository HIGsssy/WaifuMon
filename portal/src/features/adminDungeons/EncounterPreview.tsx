import { useEffect, useState } from 'react';
import {
  previewDungeonEncounter,
  previewDungeonScene,
  type DungeonDiscordEncounterPreview,
  type DungeonAction,
  type DungeonDefinition,
  type DungeonRoom,
  type DungeonSpeciesRef,
} from '@/api/adminDungeons';
import { LoadedArtwork } from '@/components/media/LoadedArtwork';

export function EncounterPreview({
  action,
  room,
  definition,
  species,
}: {
  action: DungeonAction;
  room: DungeonRoom;
  definition: DungeonDefinition;
  species: DungeonSpeciesRef[];
}) {
  const [selected, setSelected] = useState('');
  const [stage, setStage] = useState('offered');
  const [answer, setAnswer] = useState<{ key: string; data: DungeonDiscordEncounterPreview }>();
  const [scene, setScene] = useState<{ key: string; url: string; mode: string }>();
  const [problem, setProblem] = useState<string>();
  const slugs =
    action.source?.kind === 'species'
      ? [action.source.species].filter(Boolean)
      : action.source?.kind === 'pool'
        ? (definition.speciesPools
            ?.find((p) => p.id === (action.source?.kind === 'pool' ? action.source.poolId : ''))
            ?.entries.flatMap((e) => ('species' in e ? [e.species] : [])) ?? [])
        : [];
  const slug = slugs.includes(selected) ? selected : (slugs[0] ?? '');
  const direct = action.type === 'rescue' && action.mode === 'direct';
  const stages = [
    'offered',
    action.type === 'rescue' ? 'rescued' : 'captured',
    ...(!direct ? ['failure', 'escaped'] : []),
    'left',
    'nothing',
    'unavailable',
  ];
  const actualStage = stages.includes(stage) ? stage : 'offered';
  const key = JSON.stringify([definition, room.id, action.id, slug, actualStage]);
  const sceneKey = JSON.stringify({
    encounter: {
      species: slug,
      ...(action.placement ? { placement: action.placement } : {}),
      mirror: action.mirror ?? false,
      stage: actualStage,
    },
    backgrounds: [
      room.background ?? null,
      definition.background ?? null,
      definition.artwork ?? null,
    ],
    roomSprites: room.sceneSprites ?? [],
    activitySprites: action.sceneSprites ?? [],
  });
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () =>
        void previewDungeonEncounter(
          { definition, roomId: room.id, actionId: action.id, species: slug, stage: actualStage },
          controller.signal,
        )
          .then((data) => {
            if (!controller.signal.aborted) setAnswer({ key, data });
          })
          .catch(() => {
            if (!controller.signal.aborted) setProblem(key);
          }),
      300,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    let url: string | null = null;
    const timer = window.setTimeout(
      () =>
        void previewDungeonScene(JSON.parse(sceneKey), controller.signal)
          .then((image) => {
            if (!controller.signal.aborted) {
              url = URL.createObjectURL(image.image);
              setScene({ key: sceneKey, url, mode: image.mode });
            }
          })
          .catch(() => {
            if (!controller.signal.aborted) setScene(undefined);
          }),
      300,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey]);
  const preview = answer?.key === key ? answer.data : undefined;
  const picture = scene?.key === sceneKey ? scene : undefined;
  const names: Record<string, string> = {
    offered: 'Offered',
    captured: 'Capture success',
    rescued: 'Rescue success',
    failure: 'Failed attempt',
    escaped: 'Escape',
    left: 'Leave',
    nothing: 'Nothing',
    unavailable: 'Unavailable',
  };
  return (
    <section
      aria-label="Discord encounter preview"
      className="min-w-0 space-y-2 rounded border border-border p-2"
      data-testid="encounter-discord-preview"
    >
      <h3 className="text-sm font-semibold">Discord encounter preview</h3>
      <p className="text-xs text-ink-muted">
        Simulated context. Text and buttons come from the production Discord presenter. The scene
        uses a stand-in for the pinned Buddy with no capture modifiers. Success uses production
        repaint artwork; first-acquisition cards require a real owned copy. Nothing is spent,
        granted or saved.
      </p>
      {slugs.length > 1 && (
        <select
          className="w-full rounded border border-border bg-surface p-2 text-sm"
          aria-label="Preview pool species"
          value={slug}
          onChange={(e) => setSelected(e.target.value)}
        >
          {slugs.map((s) => (
            <option key={s} value={s}>
              {species.find((p) => p.slug === s)?.name ?? s}
            </option>
          ))}
        </select>
      )}
      <select
        className="w-full rounded border border-border bg-surface p-2 text-sm"
        aria-label="Preview encounter state"
        value={actualStage}
        onChange={(e) => setStage(e.target.value)}
      >
        {stages.map((s) => (
          <option key={s} value={s}>
            {names[s]}
          </option>
        ))}
      </select>
      {!slug && (
        <p className="text-xs">Choose a species or repair the pool to preview this encounter.</p>
      )}
      {problem === key && (
        <p role="alert" className="text-xs">
          Preview unavailable. Your authored settings are kept.
        </p>
      )}
      {slug && !preview && problem !== key && (
        <p role="status" className="text-xs">
          Preparing production presentation…
        </p>
      )}
      {preview?.embeds.map((embed, n) => (
        <div
          className="space-y-2 rounded border-l-4 border-accent bg-surface-sunken p-2 text-sm break-words"
          key={n}
        >
          <p className="font-semibold">{embed.title}</p>
          <p className="whitespace-pre-wrap">{embed.description}</p>
          {embed.fields?.map((f, i) => (
            <div key={i}>
              <p className="font-semibold">{f.name}</p>
              <p className="whitespace-pre-wrap">{f.value}</p>
            </div>
          ))}
          {preview?.context && <p className="text-xs text-ink-muted">{preview.context}</p>}
        </div>
      ))}
      {preview?.components.map((row, n) => (
        <div className="flex flex-wrap gap-1" key={n}>
          {row.components.map((c, i) => (
            <span
              key={i}
              aria-disabled={c.disabled}
              className="max-w-full rounded bg-surface-raised p-1 text-xs break-words"
            >
              {c.label ?? c.placeholder}
              {c.options?.map((o, j) => (
                <span className="block" key={j}>
                  {o.label} · {o.description}
                </span>
              ))}
            </span>
          ))}
        </div>
      ))}
      {picture && (
        <>
          <div className="aspect-video overflow-hidden rounded">
            <LoadedArtwork
              url={picture.url}
              alt={`Encounter scene: ${species.find((s) => s.slug === slug)?.name ?? slug}`}
            />
          </div>
          <p className="text-xs text-ink-muted">
            {picture.mode === 'full-art'
              ? 'No usable dungeon sprite: production standard artwork fallback.'
              : 'Background → background Scene Sprites → stand-in pinned Buddy → encountered WaifuMon → foreground Scene Sprites.'}
          </p>
        </>
      )}
    </section>
  );
}
