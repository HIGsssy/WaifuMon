/**
 * Expedition display vocabulary — wording only, no rules.
 *
 * Mirrors the Discord screens (`waifumonExpeditions.ts`) so a player reads the
 * same words in both places. Nothing here decides anything: match quality is
 * the server's verdict, the reward preview is the content's promise, and the
 * Portal only chooses how to print them.
 */
import type { ExpeditionRewardPreview, MatchQuality } from '@/api/types';
import { titleCase } from '@/lib/format';

/** Best to worst. Describes *fit*, never the hidden success chance. */
export const MATCH_LABEL: Readonly<Record<MatchQuality, { icon: string; label: string }>> = {
  PERFECT_MATCH: { icon: '★', label: 'Perfect match' },
  STRONG_MATCH: { icon: '✦', label: 'Strong match' },
  PARTIAL_MATCH: { icon: '✧', label: 'Partial match' },
  WEAK_MATCH: { icon: '·', label: 'Weak match' },
  POOR_MATCH: { icon: '✗', label: 'Poor match' },
};

export const PREVIEW_LABEL: Readonly<Record<ExpeditionRewardPreview, string>> = {
  waifubux: '💰 WaifuBux',
  essence: '✨ Essence',
  salvage: '📦 Salvage',
  charms: '🎀 Charms',
  consumables: '🧃 Consumables',
  waifu_xp: '📈 WaifuMon XP',
  rare_find: '🌟 Rare find',
  key_item: '🔑 Key item',
};

/** `salvage_dive` → `Salvage Dive`. */
export function expeditionTypeLabel(type: string): string {
  return titleCase(type);
}

/** `demi-human` → `Demi-Human` — the Discord spelling, hyphen kept. */
export function raceLabel(race: string): string {
  return race
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}
