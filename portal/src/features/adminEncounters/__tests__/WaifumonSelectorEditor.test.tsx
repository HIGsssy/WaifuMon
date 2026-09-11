/**
 * Authoring a Waifumon sighting through the real {@link EffectEditor}.
 *
 * What is pinned: each storage generation opens in the right mode, untouched
 * legacy effects are not rewritten, every edit saves one structurally valid
 * shape (canonical lowercase values, no empty arrays, nothing from the other
 * mode), and the candidate preview renders the server's answer — with its
 * region — rather than computing one.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import * as adminEncounters from '@/api/adminEncounters';
import type {
  AdminEncounterReference,
  SelectorPreviewEncounter,
  SelectorPreviewResponse,
} from '@/api/adminEncounters';

import { EffectEditor, type EffectShape } from '../EffectEditor';

const T = 'trigger_waifumon_encounter';

const REFERENCE: AdminEncounterReference = {
  regions: ['waifu-valley', 'twin-peeks'],
  regionNames: { 'waifu-valley': 'Waifu Valley', 'twin-peeks': 'Twin Peeks' },
  speciesRarities: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'],
  affinities: ['dominant', 'submissive', 'caregiver', 'primal', 'switch'],
  races: ['angel', 'demon', 'demi-human', 'human', 'spirit', 'valkyrie', 'android'],
  items: [{ slug: 'basic_charm', name: 'Basic Charm', category: 'capture' }],
  encounters: [],
  species: [
    { slug: 'lilith', name: 'Lilith', rarity: 'LR' },
    { slug: 'pixie', name: 'Pixie', rarity: 'N' },
  ],
  vendors: [],
  types: [],
  rarities: [],
  lifecycles: [],
};

const PREVIEW: SelectorPreviewResponse = {
  mode: 'random',
  specific: null,
  regions: [
    {
      regionId: 'waifu-valley',
      regionName: 'Waifu Valley',
      candidateCount: 2,
      candidates: [
        { slug: 'lilith', name: 'Lilith', rarity: 'LR' },
        { slug: 'morgana', name: 'Morgana', rarity: 'LR' },
      ],
    },
    { regionId: 'twin-peeks', regionName: 'Twin Peeks', candidateCount: 0, candidates: [] },
  ],
  matchesAnywhere: true,
};

let previewSpy: MockInstance<typeof adminEncounters.previewSpeciesSelector>;
beforeEach(() => {
  previewSpy = vi.spyOn(adminEncounters, 'previewSpeciesSelector').mockResolvedValue(PREVIEW);
});
afterEach(() => vi.restoreAllMocks());

function setup(initial: EffectShape, encounterContext?: SelectorPreviewEncounter) {
  const onChange = vi.fn<(next: EffectShape) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [effect, setEffect] = useState<EffectShape>(initial);
    return (
      <EffectEditor
        effect={effect}
        reference={REFERENCE}
        encounterContext={encounterContext}
        onChange={(next) => {
          onChange(next);
          setEffect(next);
        }}
        onRemove={vi.fn()}
      />
    );
  }
  const utils = render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  const last = () => onChange.mock.calls.at(-1)?.[0];
  return { onChange, last, user: userEvent.setup(), ...utils };
}

const pressed = (name: string | RegExp) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed');

describe('opening existing content', () => {
  it('legacy specific opens as Specific Species with the species selected', () => {
    const { onChange } = setup({ type: T, speciesSlug: 'lilith' });
    expect(pressed('Specific Species')).toBe('true');
    expect(screen.getByLabelText('Species')).toHaveValue('lilith');
    expect(screen.getByTestId('selector-summary')).toHaveTextContent('Specific Waifumon: Lilith');
    // Opening is not editing: an untouched legacy effect is never rewritten.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('legacy random opens as Random on the hunt draw, filters disabled', () => {
    const { onChange } = setup({ type: T });
    expect(pressed('Random')).toBe('true');
    expect(pressed('Hunt draw')).toBe('true');
    expect(screen.getByRole('button', { name: 'LR' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    // No fixed candidate set to ask the server about.
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('new specific opens as Specific Species', () => {
    setup({ type: T, selection: { mode: 'specific', speciesSlug: 'pixie' } });
    expect(pressed('Specific Species')).toBe('true');
    expect(screen.getByLabelText('Species')).toHaveValue('pixie');
  });

  it('new random opens with its pool and filters pressed', () => {
    setup({ type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } });
    expect(pressed('Random')).toBe('true');
    expect(pressed('Current Region')).toBe('true');
    expect(pressed('LR')).toBe('true');
    expect(pressed('UR')).toBe('false');
    expect(screen.getByTestId('selector-summary')).toHaveTextContent(
      'Random LR Waifumon from current region',
    );
  });
});

describe('editing', () => {
  it('filters serialize canonical values; labels stay human-friendly', async () => {
    const { user, last } = setup({ type: T, selection: { mode: 'random', poolScope: 'region' } });
    await user.click(screen.getByRole('button', { name: 'LR' }));
    await user.click(screen.getByRole('button', { name: 'Demon' }));
    await user.click(screen.getByRole('button', { name: 'Spirit' }));
    await user.click(screen.getByRole('button', { name: 'Primal' }));

    expect(last()).toEqual({
      type: T,
      selection: {
        mode: 'random',
        poolScope: 'region',
        rarities: ['LR'],
        races: ['demon', 'spirit'],
        affinities: ['primal'],
      },
    });
    expect(screen.getByTestId('selector-summary')).toHaveTextContent(
      'Random LR Primal Demon or Spirit Waifumon from current region',
    );
  });

  it('clearing the last value of a filter omits it rather than saving []', async () => {
    const { user, last } = setup({
      type: T,
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
    });
    await user.click(screen.getByRole('button', { name: 'LR' }));
    expect(last()).toEqual({ type: T, selection: { mode: 'random', poolScope: 'region' } });
  });

  it('pool saves as poolScope', async () => {
    const { user, last } = setup({ type: T, selection: { mode: 'random', poolScope: 'region' } });
    await user.click(screen.getByRole('button', { name: 'Global' }));
    expect(last()).toEqual({ type: T, selection: { mode: 'random', poolScope: 'global' } });
    expect(
      screen.getByText('Enabled non-region-exclusive Waifumon, plus species from the current region.'),
    ).toBeInTheDocument();
  });

  it('choosing a pool on a legacy hunt draw converts it to a strict selector', async () => {
    const { user, last } = setup({ type: T });
    await user.click(screen.getByRole('button', { name: 'Current Region' }));
    expect(last()).toEqual({ type: T, selection: { mode: 'random', poolScope: 'region' } });
    expect(
      screen.getByText("Only Waifumon in the encounter's current region pool."),
    ).toBeInTheDocument();
  });

  it('picking a species on legacy specific saves the new specific shape', async () => {
    const { user, last } = setup({ type: T, speciesSlug: 'lilith' });
    await user.selectOptions(screen.getByLabelText('Species'), 'pixie');
    expect(last()).toEqual({ type: T, selection: { mode: 'specific', speciesSlug: 'pixie' } });
  });

  it('the species list is searchable by name', async () => {
    const { user } = setup({ type: T, selection: { mode: 'specific', speciesSlug: '' } });
    await user.type(screen.getByLabelText('Search species'), 'pix');
    const options = Array.from(
      (screen.getByLabelText('Species') as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toEqual(['— pick a species —', 'Pixie (N)']);
  });
});

describe('mode switching never leaves stale fields', () => {
  it('Specific → Random: no speciesSlug, a valid random shape', async () => {
    const { user, last } = setup({ type: T, speciesSlug: 'lilith' });
    await user.click(screen.getByRole('button', { name: 'Random' }));
    expect(last()).toEqual({ type: T, selection: { mode: 'random', poolScope: 'region' } });
  });

  it('Random → Specific: no poolScope or filters; the random settings come back on return', async () => {
    const { user, last } = setup({
      type: T,
      selection: { mode: 'random', poolScope: 'global', rarities: ['LR'], races: ['demon'] },
    });
    await user.click(screen.getByRole('button', { name: 'Specific Species' }));
    // Unchosen: no speciesSlug at all — never `""`.
    expect(last()).toEqual({ type: T, selection: { mode: 'specific' } });
    expect(screen.getByText('Pick a species to preview this sighting.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Species'), 'lilith');
    expect(last()).toEqual({ type: T, selection: { mode: 'specific', speciesSlug: 'lilith' } });

    await user.click(screen.getByRole('button', { name: 'Random' }));
    expect(last()).toEqual({
      type: T,
      selection: { mode: 'random', poolScope: 'global', rarities: ['LR'], races: ['demon'] },
    });
  });

  it('the old editor’s speciesSlug-on-top-of-selection is cleaned up by any edit', async () => {
    const { user, last } = setup({
      type: T,
      speciesSlug: 'lilith',
      selection: { mode: 'random', poolScope: 'region' },
    });
    expect(pressed('Random')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'LR' }));
    expect(last()).toEqual({
      type: T,
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
    });
  });

  it('switching another effect type into a sighting starts clean', async () => {
    const { user, last } = setup({ type: 'give_item', slug: 'basic_charm', quantity: 2 });
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, T);
    expect(last()).toEqual({ type: T });
  });

  it('switching a sighting to another type drops the selector', async () => {
    const { user, last } = setup({
      type: T,
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
    });
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'waifubux_gain');
    expect(last()).toEqual({ type: 'waifubux_gain' });
  });
});

describe('save → reload stability', () => {
  it('reopening the saved effect shows exactly the same selector', async () => {
    const first = setup({ type: T });
    await first.user.click(screen.getByRole('button', { name: 'Global' }));
    await first.user.click(screen.getByRole('button', { name: 'UR' }));
    await first.user.click(screen.getByRole('button', { name: 'LR' }));
    await first.user.click(screen.getByRole('button', { name: 'Demi Human' }));
    // "Save": the API stores the JSON as sent and hands it back.
    const saved = JSON.parse(JSON.stringify(first.last())) as EffectShape;
    first.unmount();

    const reopened = setup(saved);
    expect(pressed('Global')).toBe('true');
    expect(pressed('UR')).toBe('true');
    expect(pressed('LR')).toBe('true');
    expect(pressed('Demi Human')).toBe('true');
    expect(saved).toEqual({
      type: T,
      selection: { mode: 'random', poolScope: 'global', rarities: ['UR', 'LR'], races: ['demi-human'] },
    });
    expect(reopened.onChange).not.toHaveBeenCalled();
  });
});

describe('candidate preview', () => {
  const context: SelectorPreviewEncounter = {
    huntEligible: true,
    travelEligible: false,
    regions: ['waifu-valley', 'twin-peeks'],
    routes: [],
  };

  it('asks the server with the canonical selection and the encounter’s regions', async () => {
    setup({ type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } }, context);
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    expect(previewSpy).toHaveBeenLastCalledWith({
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
      encounter: context,
    });
  });

  it('shows a per-region count, and a clear warning where nothing matches', async () => {
    setup({ type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } }, context);
    expect(await screen.findByText('Waifu Valley: 2 eligible')).toBeInTheDocument();
    expect(screen.getByText(/each region this encounter can fire in/)).toBeInTheDocument();
    expect(
      screen.getByText(/No Waifumon currently match this selector in\s+Twin Peeks/),
    ).toBeInTheDocument();
  });

  it('flags a selector that matches nothing anywhere as blocking', async () => {
    previewSpy.mockResolvedValue({
      ...PREVIEW,
      regions: PREVIEW.regions.map((r) => ({ ...r, candidateCount: 0, candidates: [] })),
      matchesAnywhere: false,
    });
    setup({ type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['EX'] } });
    expect(
      await screen.findByText(/does not match any enabled Waifumon in any valid region/),
    ).toBeInTheDocument();
    expect(screen.getByText(/importing an encounter carrying it is blocked/)).toBeInTheDocument();
  });

  it('confirms a specific species, and warns about one that is not enabled', async () => {
    previewSpy.mockResolvedValue({
      mode: 'specific',
      specific: { slug: 'ghost', name: 'ghost', rarity: '', found: false },
      regions: [],
      matchesAnywhere: false,
    });
    setup({ type: T, selection: { mode: 'specific', speciesSlug: 'ghost' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not an enabled species');
  });
});

describe('regression: other effect editors', () => {
  it('amount effects still patch in place', async () => {
    const { user, last } = setup({ type: 'affection_gain', amount: 25 });
    const amount = screen.getByLabelText(/amount/i);
    await user.clear(amount);
    await user.type(amount, '30');
    expect(last()).toEqual({ type: 'affection_gain', amount: 30 });
  });

  it('switching between two non-sighting types still keeps the patch behaviour', async () => {
    const { user, last } = setup({ type: 'waifubux_gain', amount: 10 });
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'essence_gain');
    expect(last()).toEqual({ type: 'essence_gain', amount: 10 });
  });
});
