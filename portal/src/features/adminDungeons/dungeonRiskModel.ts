/**
 * Currency Risk: how much of the Baddie Shards and WaifuBux earned in a run
 * the player keeps when it ends badly. Authors see percentages; the definition
 * stores basis points.
 */
import type { DungeonDefinition } from '@/api/adminDungeons';

type Settings = DungeonDefinition['settings'];

export const RISK_PRESETS = [
  { basisPoints: 10000, label: 'Keep everything' },
  { basisPoints: 5000, label: 'Keep half' },
  { basisPoints: 0, label: 'Keep nothing' },
] as const;

/** Written explicitly for a new dungeon; the schema's own defaults stay as they are. */
export const NEW_DUNGEON_RISK = {
  defeatCurrencyRetentionBasisPoints: 5000,
  abandonCurrencyRetentionBasisPoints: 0,
} as const;

/** 2550 → "25.5". */
export const retentionPercent = (basisPoints: number) =>
  String(Number((basisPoints / 100).toFixed(2)));

/** "Keep half (50%)", or "Keep 25.5%" for a custom value. */
export function retentionLabel(basisPoints: number): string {
  const preset = RISK_PRESETS.find((p) => p.basisPoints === basisPoints);
  const percent = `${retentionPercent(basisPoints)}%`;
  return preset ? `${preset.label} (${percent})` : `Keep ${percent}`;
}

export const isPreset = (basisPoints: number) =>
  RISK_PRESETS.some((p) => p.basisPoints === basisPoints);

/** What abandoning keeps: its own setting, or the defeat setting when none is stored. */
export const effectiveAbandon = (settings: Settings) =>
  settings.abandonCurrencyRetentionBasisPoints ?? settings.defeatCurrencyRetentionBasisPoints;

export type ParsedRetention = { ok: true; basisPoints: number } | { ok: false; message: string };

/** A typed percentage, 0 to 100 with at most two decimal places. */
export function parseRetention(text: string): ParsedRetention {
  const trimmed = text.trim().replace(/%$/, '').trim();
  if (trimmed === '') return { ok: false, message: 'Enter a percentage from 0 to 100.' };
  if (!/^\d+(\.\d+)?$/.test(trimmed))
    return { ok: false, message: 'Use a number from 0 to 100, such as 25 or 12.5.' };
  if (/\.\d{3,}$/.test(trimmed)) return { ok: false, message: 'Use at most two decimal places.' };
  const value = Number(trimmed);
  if (value > 100) return { ok: false, message: 'A player cannot keep more than 100%.' };
  return { ok: true, basisPoints: Math.round(value * 100) };
}

export const withDefeat = (settings: Settings, basisPoints: number): Settings => ({
  ...settings,
  defeatCurrencyRetentionBasisPoints: basisPoints,
});

/** `null` removes the separate abandon setting, so abandoning follows defeat again. */
export function withAbandon(settings: Settings, basisPoints: number | null): Settings {
  const rest = { ...settings };
  delete rest.abandonCurrencyRetentionBasisPoints;
  return basisPoints === null
    ? rest
    : { ...rest, abandonCurrencyRetentionBasisPoints: basisPoints };
}

/** Allowed, but worth a second look: giving up would pay better than losing. */
export const abandonKeepsMore = (settings: Settings) =>
  effectiveAbandon(settings) > settings.defeatCurrencyRetentionBasisPoints;
