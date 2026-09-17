/**
 * Result screens as data — the one statement of how a lightweight outcome
 * (a hunt find, "nothing found", a released Waifumon) is laid out.
 *
 * Discord renders these into embeds (`discord/huntResultPresenter.ts`) and the
 * Portal's Result Presentation preview renders the very same model, so an
 * author previews exactly the layout, titles and mechanical wording a player
 * will see. Pure and Discord-free.
 *
 * Two inputs, two owners:
 *
 *   - the **facts** are gameplay's: amounts, balances, the item and quantity,
 *     level-ups, Energy. Every mechanical line is generated here from them,
 *     and nothing authored can replace or template them;
 *   - the **presentation** is authored and already resolved: optional prose
 *     shown *alongside* the mechanical lines, and an optional image.
 */
import type { ResultPresentationKey } from './keys';
import type { ResolvedResultPresentation } from './resolver';

/** What a filler hunt screen needs to know about the committed result. */
export type HuntScreenFacts = {
  energyRemaining: number;
  levelUps: ReadonlyArray<{ toLevel: number; rewardLabels: readonly string[] }>;
} & (
  | { kind: 'waifubux_find'; amount: number; balanceAfter: number }
  | { kind: 'essence_find'; amount: number; balanceAfter: number }
  | {
      kind: 'item_find' | 'rare_item_find';
      item: { name: string; emoji: string | null };
      quantity: number;
    }
  | { kind: 'flavor' }
);

export type HuntScreenKind = HuntScreenFacts['kind'];

/** What a release screen needs to know about the Waifumon let go. */
export interface ReleaseScreenFacts {
  species: { name: string; rarity: string } | null;
}

/**
 * One block of the screen body, tagged with its owner so a preview can mark
 * gameplay values as sample data.
 */
export type ScreenSection =
  | { kind: 'flavor'; text: string }
  | { kind: 'mechanical'; text: string }
  | { kind: 'level_up'; text: string }
  | { kind: 'buddy'; text: string };

export type ScreenArtwork =
  | { kind: 'none' }
  | { kind: 'custom'; path: string }
  /** The released Waifumon's canonical artwork. */
  | { kind: 'encountered' };

export interface ResultScreen {
  key: ResultPresentationKey;
  title: string;
  sections: ScreenSection[];
  /** `sections` joined exactly as the Discord embed description shows them. */
  description: string;
  color: number;
  footer: string | null;
  artwork: ScreenArtwork;
}

const RARITY_COLORS: Record<string, number> = {
  N: 0xb8b8b8,
  R: 0x6fb1ff,
  SR: 0xa66fff,
  SSR: 0xffc46f,
  UR: 0xff6fa5,
  LR: 0xff3d7f,
  EX: 0xffffff,
};

/** Embed accent for a species rarity. */
export function rarityColor(rarity: string): number {
  return RARITY_COLORS[rarity] ?? 0xff6fa5;
}

/** Accent shared by every hunt filler screen. */
export const HUNT_RESULT_COLOR = 0xff6fa5;

export const HUNT_RESULT_TITLES: Readonly<Record<HuntScreenKind, string>> = {
  item_find: '🎒 Item Found',
  rare_item_find: '🌟 Rare Find!',
  waifubux_find: '💰 WaifuBux Found',
  essence_find: '✨ Essence Found',
  flavor: '🍃 Nothing but wind…',
};

/** Shown on a "nothing found" screen when no line exists anywhere. */
export const NOTHING_FOUND_DEFAULT_LINE = 'Nothing turned up this time.';

/** Built-in release copy, used when no authored variant supplies text. */
export const RELEASE_FALLBACK_LINES: readonly string[] = ['You let her slip back into the neon~'];

/** The presentation key a filler hunt result is shown under. */
export function huntPresentationKey(kind: HuntScreenKind): ResultPresentationKey {
  switch (kind) {
    case 'waifubux_find':
      return 'hunt.waifubux_find';
    case 'essence_find':
      return 'hunt.essence_find';
    case 'item_find':
      return 'hunt.item_find';
    case 'rare_item_find':
      return 'hunt.rare_item_find';
    case 'flavor':
      return 'hunt.nothing_found';
  }
}

function levelUpText(levelUps: HuntScreenFacts['levelUps']): string | null {
  if (levelUps.length === 0) return null;
  return levelUps
    .map(
      (l) =>
        `⬆️ **Level ${l.toLevel}!**${l.rewardLabels.length ? ` — ${l.rewardLabels.join(', ')}` : ''}`,
    )
    .join('\n');
}

/** The code-generated line that states what the find *was*. */
export function huntMechanicalLine(facts: HuntScreenFacts): string | null {
  switch (facts.kind) {
    case 'item_find':
    case 'rare_item_find':
      return `${facts.item.emoji ?? '•'} **${facts.item.name}** ×${facts.quantity}`;
    case 'waifubux_find':
      return `+**${facts.amount}** WaifuBux (balance: ${facts.balanceAfter})`;
    case 'essence_find':
      return `+**${facts.amount}** Essence (balance: ${facts.balanceAfter})`;
    case 'flavor':
      return null;
  }
}

function artworkOf(presentation: ResolvedResultPresentation): ScreenArtwork {
  if (presentation.artworkMode === 'custom' && presentation.artworkPath) {
    return { kind: 'custom', path: presentation.artworkPath };
  }
  if (presentation.artworkMode === 'encountered') return { kind: 'encountered' };
  return { kind: 'none' };
}

function joinSections(sections: readonly ScreenSection[]): string {
  return sections.map((s) => s.text).join('\n\n');
}

/**
 * The screen for a non-encounter hunt result.
 *
 * Layout: authored prose (if any), then the mechanical find, then level-ups,
 * then Buddy lines; footer is the Energy left. A "nothing found" screen's
 * prose *is* its body. `buddyLines` are pre-formatted by the caller, which
 * owns Buddy Bonus wording.
 */
export function buildHuntResultScreen(
  facts: HuntScreenFacts,
  presentation: ResolvedResultPresentation,
  buddyLines: readonly string[] = [],
): ResultScreen {
  const prose =
    facts.kind === 'flavor'
      ? (presentation.flavorText ?? NOTHING_FOUND_DEFAULT_LINE)
      : presentation.flavorText;
  const mechanical = huntMechanicalLine(facts);
  const levelUps = levelUpText(facts.levelUps);
  const sections: ScreenSection[] = [];
  if (prose) sections.push({ kind: 'flavor', text: prose });
  if (mechanical) sections.push({ kind: 'mechanical', text: mechanical });
  if (levelUps) sections.push({ kind: 'level_up', text: levelUps });
  if (buddyLines.length > 0) sections.push({ kind: 'buddy', text: buddyLines.join('\n') });

  const artwork = artworkOf(presentation);
  return {
    key: huntPresentationKey(facts.kind),
    title: HUNT_RESULT_TITLES[facts.kind],
    sections,
    description: joinSections(sections),
    color: HUNT_RESULT_COLOR,
    footer: `Energy left: ${facts.energyRemaining}`,
    // Hunt finds have no Waifumon to show.
    artwork: artwork.kind === 'encountered' ? { kind: 'none' } : artwork,
  };
}

/** The screen after Let Her Go. The release itself has already committed. */
export function buildReleaseScreen(
  facts: ReleaseScreenFacts,
  presentation: ResolvedResultPresentation,
): ResultScreen {
  const { species } = facts;
  const sections: ScreenSection[] = [
    { kind: 'flavor', text: presentation.flavorText ?? RELEASE_FALLBACK_LINES[0]! },
  ];
  const artwork = artworkOf(presentation);
  return {
    key: 'encounter.released',
    title: species ? `👋 You let ${species.name} go` : '👋 You let her go',
    sections,
    description: joinSections(sections),
    color: species ? rarityColor(species.rarity) : HUNT_RESULT_COLOR,
    footer: null,
    // Nobody to show when her row could not be read.
    artwork: artwork.kind === 'encountered' && !species ? { kind: 'none' } : artwork,
  };
}
