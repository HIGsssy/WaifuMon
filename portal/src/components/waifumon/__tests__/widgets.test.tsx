/**
 * Domain widget tests (plan §22.1).
 *
 * The theme running through these: nothing carries meaning by colour alone, and
 * nothing computes a gameplay value.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { OwnedEntry } from '@/api/types';
import * as fixtures from '../../../../msw/fixtures';
import { CurrencyTile } from '../CurrencyChip';
import { DexProgressRing } from '../DexProgressRing';
import { AffectionMeter, XpBar } from '../Meters';
import { AffinityPill, TypePill } from '../Pills';
import { RarityBadge } from '../RarityBadge';
import { WaifumonCard } from '../WaifumonCard';

const entry: OwnedEntry = fixtures.ownedEntries[0]!;

describe('RarityBadge', () => {
  it('names the rarity for assistive tech, not just the tier code', () => {
    render(<RarityBadge rarity="SSR" />);
    expect(screen.getByLabelText('Rarity: Super Special Rare')).toHaveTextContent('SSR');
  });

  it("renders EX, which the game has but the plan's colour list omitted", () => {
    render(<RarityBadge rarity="EX" />);
    expect(screen.getByLabelText('Rarity: Exotic')).toBeInTheDocument();
  });

  it('degrades to the common tier for an unknown rarity rather than crashing', () => {
    render(<RarityBadge rarity="???" />);
    expect(screen.getByLabelText('Rarity: Common')).toBeInTheDocument();
  });
});

describe('XpBar', () => {
  it('renders the API-supplied progress and never recomputes a curve', () => {
    render(
      <XpBar
        progress={{ level: 9, xp: 820, xpIntoLevel: 120, xpToNext: 300, atMaxLevel: false }}
      />,
    );
    // 120 into a 420-wide level; the caption restates the API's own numbers.
    expect(screen.getByText('120 / 420 XP to level 10')).toBeInTheDocument();
    expect(screen.getByLabelText('Experience to next level')).toHaveAttribute(
      'aria-valuenow',
      '29',
    );
  });

  it('says "Max level" rather than showing a misleading bar', () => {
    render(
      <XpBar progress={{ level: 50, xp: 9999, xpIntoLevel: 0, xpToNext: 0, atMaxLevel: true }} />,
    );
    expect(screen.getByText('Max level')).toBeInTheDocument();
  });
});

describe('AffectionMeter', () => {
  it('always shows the raw value beside the bar, since there is no API maximum', () => {
    render(<AffectionMeter affection={137} />);
    expect(screen.getByText('137')).toBeInTheDocument();
    expect(screen.getByLabelText('Affection: 137')).toBeInTheDocument();
  });
});

describe('DexProgressRing', () => {
  it('restates the figures in text so the graphic is not the only source', () => {
    render(<DexProgressRing distinctSpecies={18} totalSpecies={58} />);
    expect(screen.getByText('31%')).toBeInTheDocument();
    expect(screen.getByText('18 / 58')).toBeInTheDocument();
  });

  it('handles a zero denominator without dividing by zero', () => {
    render(<DexProgressRing distinctSpecies={0} totalSpecies={0} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});

describe('CurrencyTile', () => {
  it('shows the current value only — no regeneration countdown (§16)', () => {
    render(<CurrencyTile kind="energy" value={34} caption="For hunting" />);
    expect(screen.getByText('34')).toBeInTheDocument();
    expect(screen.queryByText(/full in/i)).toBeNull();
  });
});

describe('Pills', () => {
  it('labels archetype as "Type" for the reader and for assistive tech', () => {
    render(<TypePill archetype="demi-human" />);
    expect(screen.getByText('Type:')).toBeInTheDocument();
    expect(screen.getByText('Demi Human')).toBeInTheDocument();
  });

  it('labels affinity distinctly from type', () => {
    render(<AffinityPill affinity="submissive" />);
    expect(screen.getByText('Affinity:')).toBeInTheDocument();
    expect(screen.getByText('Submissive')).toBeInTheDocument();
  });
});

describe('WaifumonCard', () => {
  function renderCard(props: Partial<Parameters<typeof WaifumonCard>[0]> = {}) {
    return render(
      <MemoryRouter>
        <WaifumonCard entry={entry} {...props} />
      </MemoryRouter>,
    );
  }

  it('is a single link with a descriptive accessible name', () => {
    renderCard();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/collection/101');
    expect(link).toHaveAccessibleName('Nyx, Ultra Rare, level 22');
  });

  it('titles by nickname and keeps the species name as a subtitle', () => {
    renderCard();
    expect(screen.getByTitle('Nyx')).toBeInTheDocument();
    expect(screen.getByTitle('Void Empress')).toBeInTheDocument();
  });

  it('titles by species name when there is no nickname', () => {
    renderCard({ entry: fixtures.ownedEntries[1]! });
    expect(screen.getByTitle('Neon Kitsune')).toBeInTheDocument();
  });

  it('marks favourite and buddy status in text, not only by icon', () => {
    renderCard({ isBuddy: true });
    expect(screen.getByText('Favourite')).toBeInTheDocument();
    expect(screen.getByText('Your buddy')).toBeInTheDocument();
  });

  it('routes artwork through the resolver with generated alt text', () => {
    renderCard();
    expect(screen.getByAltText('Void Empress — Ultra Rare')).toBeInTheDocument();
  });
});
