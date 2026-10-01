/**
 * "Frequency" — rarity, weight and this encounter's repeat cooldown, with the
 * global pacing it sits inside stated from the live settings.
 *
 * What the engine actually does (audited, not assumed):
 *
 *   - There is **no global "World Encounter cooldown"**. Each hunt/travel
 *     rolls the global Hunt/Travel chance; a player with an encounter still
 *     open cannot get another. That is the whole global pacing.
 *   - The repeat cooldown here is per player and per encounter: written when
 *     the player resolves this encounter, it removes it from their random pool
 *     until it expires.
 *   - A chain follow-up is opened directly: no chance roll, and its own repeat
 *     cooldown is not checked (it is still written when it resolves). It
 *     does have to be `active` — a draft or disabled follow-up never opens.
 */
import type { AdminEncounterReference, AdminEncounterSettings } from '@/api/adminEncounters';
import { Input } from '@/components/ui/input';
import { DurationInput } from './DurationInput';
import { formatDuration } from './duration';
import { selectClass } from './EntitySelect';
import type { EncounterRole } from './encounterGraph';

/** Mirrors `RARITY_MULTIPLIERS` in `src/modules/worldEncounters/engine.ts`. */
const RARITY_MULTIPLIER: Record<string, number> = {
  common: 100,
  uncommon: 40,
  rare: 10,
  mythic: 2,
};

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

interface Props {
  rarity: string;
  weight: number;
  cooldownSeconds: number;
  spawns: boolean;
  role: EncounterRole | null;
  onChange: (patch: { rarity?: string; weight?: number; cooldownSeconds?: number }) => void;
  reference: AdminEncounterReference | undefined;
  settings: AdminEncounterSettings | undefined;
}

export function CooldownExplanation({
  cooldownSeconds,
  spawns,
  role,
  settings,
}: Pick<Props, 'cooldownSeconds' | 'spawns' | 'role' | 'settings'>) {
  const lines: string[] = [];
  if (settings) {
    lines.push(
      settings.forceTrigger
        ? 'Force Trigger is on, so every eligible hunt and travel produces a World Encounter.'
        : `There is no global World Encounter cooldown: every hunt has a ${pct(settings.huntChance)} ` +
            `chance, and every travel ${pct(settings.travelChance)}, of producing one — as long as ` +
            'the player has no World Encounter still open.',
    );
  } else {
    lines.push(
      'There is no global World Encounter cooldown: each hunt and travel rolls its own chance, as ' +
        'long as the player has no World Encounter still open.',
    );
  }
  if (spawns) {
    lines.push(
      cooldownSeconds > 0
        ? `After a player resolves this encounter, it cannot appear for them on its own again for ${formatDuration(cooldownSeconds)}.`
        : 'This encounter can appear again for the same player as soon as it is rolled.',
    );
  }
  if (role && role.parents.length > 0) {
    lines.push(
      'This encounter is triggered as part of a chain, and the chain opens it directly: it is not ' +
        'blocked by the Hunt/Travel chance or by its own repeat cooldown' +
        (cooldownSeconds > 0 ? ' (the cooldown still starts when the player resolves it).' : '.'),
    );
    lines.push(
      'It only opens while its status is Active — as a draft or disabled, the chain ends at the encounter before it.',
    );
  }
  if (settings) {
    lines.push(
      `Players have ${formatDuration(settings.defaultExpirySeconds)} to answer before it expires.`,
    );
  }
  return (
    <ul
      className="space-y-1 rounded-md bg-surface-sunken p-3 text-xs text-ink-muted"
      data-testid="cooldown-explanation"
    >
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

export function FrequencyEditor({
  rarity,
  weight,
  cooldownSeconds,
  spawns,
  role,
  onChange,
  reference,
  settings,
}: Props) {
  const multiplier = RARITY_MULTIPLIER[rarity] ?? 1;
  return (
    <div className="space-y-3">
      {spawns ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-ink-muted">
            Rarity
            <select
              value={rarity}
              onChange={(e) => onChange({ rarity: e.target.value })}
              className={selectClass}
            >
              {(reference?.rarities ?? ['common', 'uncommon', 'rare', 'mythic']).map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Weight
            <Input
              type="number"
              min="1"
              step="1"
              value={weight}
              onChange={(e) => onChange({ weight: Number(e.target.value) })}
            />
          </label>
          <DurationInput
            label="Repeat cooldown for this encounter"
            seconds={cooldownSeconds}
            onChange={(s) => onChange({ cooldownSeconds: s })}
          />
          <p className="text-[11px] text-ink-muted sm:col-span-3">
            When a World Encounter is rolled, each eligible encounter’s share is its weight × its
            rarity ({rarity} ×{multiplier}) — here {(weight * multiplier).toLocaleString('en-US')}.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <DurationInput
            label="Repeat cooldown for this encounter"
            seconds={cooldownSeconds}
            onChange={(s) => onChange({ cooldownSeconds: s })}
          />
          <p className="text-xs text-ink-muted sm:col-span-2">
            Rarity and weight only matter for encounters that appear on their own; a chain opens
            this one directly.
          </p>
        </div>
      )}
      <CooldownExplanation
        cooldownSeconds={cooldownSeconds}
        spawns={spawns}
        role={role}
        settings={settings}
      />
    </div>
  );
}
