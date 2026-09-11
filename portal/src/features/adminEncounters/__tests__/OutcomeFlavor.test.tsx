/**
 * Authored outcome flavor in the Portal: the choice editor fields, what the
 * draft saves, the preview panel and the simulator card.
 *
 * Which authored field wins is decided on the server; the preview and
 * simulator tests feed in server-resolved values and check they are shown
 * where Discord shows them. The editor tests pin the one piece of rule the
 * Portal owns: branch text survives a check being switched off and on.
 */
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import type { AdminEncounter, SimulateResponse } from '@/api/adminEncounters';

import { ChoiceEditor, type ChoiceDraft } from '../ChoiceEditor';
import { OutcomeFlavorPreview } from '../AdminEncounterPreviewPanel';
import { AdminEncounterPreviewPage } from '../AdminEncounterPreviewPage';
import { EMPTY_DRAFT, draftFrom, flavorPayload, toPayload } from '../encounterDraft';

const SUCCESS = 'You make it across just as the final plank gives way behind you.';
const FAILURE = 'The bridge snaps beneath your feet, forcing a frantic retreat.';
const GENERIC = 'You continue deeper into the ruins.';

afterEach(() => vi.restoreAllMocks());

const base = (check: ChoiceDraft['check'], extra: Partial<ChoiceDraft> = {}): ChoiceDraft => ({
  label: 'Cross',
  emoji: null,
  requirements: {},
  check,
  successEffects: [],
  failureEffects: [],
  ...extra,
});

/** Render the editor against real state, exposing the latest draft. */
function renderEditor(initial: ChoiceDraft) {
  const latest: { current: ChoiceDraft } = { current: initial };
  function Harness() {
    const [choice, setChoice] = useState(initial);
    return (
      <ChoiceEditor
        index={0}
        choice={choice}
        reference={undefined}
        onChange={(next) => {
          latest.current = next;
          setChoice(next);
        }}
        onRemove={() => {}}
        onMoveUp={undefined}
        onMoveDown={undefined}
      />
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  return { user, latest };
}

describe('choice editor: flavor fields', () => {
  it('a no-check choice shows only Outcome Text', () => {
    renderEditor(base({ type: 'none' }));
    expect(screen.getByLabelText('Outcome Text')).toBeInTheDocument();
    expect(screen.queryByLabelText('Success Text')).toBeNull();
    expect(screen.queryByLabelText('Failure Text')).toBeNull();
  });

  it('a checked choice shows Outcome, Success and Failure Text with the helper', () => {
    renderEditor(base({ type: 'sp', baseChance: 0.55 }));
    expect(screen.getByLabelText('Outcome Text').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Success Text').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Failure Text').tagName).toBe('TEXTAREA');
    expect(
      screen.getByText(/Success\/Failure Text overrides Outcome Text for that result\./),
    ).toBeInTheDocument();
  });

  it('edits each field', async () => {
    const { user, latest } = renderEditor(base({ type: 'sp', baseChance: 0.55 }));
    await user.type(screen.getByLabelText('Outcome Text'), 'Onward.');
    await user.type(screen.getByLabelText('Success Text'), 'Made it.');
    await user.type(screen.getByLabelText('Failure Text'), 'Fell.');
    expect(latest.current).toMatchObject({
      outcomeText: 'Onward.',
      successText: 'Made it.',
      failureText: 'Fell.',
    });
  });

  it('switching the check off hides branch text without destroying it, and switching back restores it', async () => {
    const { user, latest } = renderEditor(
      base({ type: 'sp', baseChance: 0.55 }, { successText: SUCCESS, failureText: FAILURE }),
    );
    await user.selectOptions(screen.getByLabelText('Type'), 'none');
    expect(screen.queryByLabelText('Success Text')).toBeNull();
    expect(latest.current.successText).toBe(SUCCESS);
    expect(latest.current.failureText).toBe(FAILURE);

    await user.selectOptions(screen.getByLabelText('Type'), 'sp');
    expect(screen.getByLabelText('Success Text')).toHaveValue(SUCCESS);
    expect(screen.getByLabelText('Failure Text')).toHaveValue(FAILURE);
  });

  it('deliberately clearing a field removes it from what is saved', async () => {
    const { user, latest } = renderEditor(
      base({ type: 'sp', baseChance: 0.55 }, { outcomeText: GENERIC, successText: SUCCESS }),
    );
    await user.clear(screen.getByLabelText('Success Text'));
    expect(latest.current.successText).toBe('');
    expect(flavorPayload(latest.current)).toEqual({ outcomeText: GENERIC });
  });
});

describe('draft serialization', () => {
  it('saves trimmed text and omits blanks', () => {
    expect(
      flavorPayload(
        base({ type: 'sp', baseChance: 0.5 }, { outcomeText: `  ${GENERIC}  `, successText: '   ', failureText: FAILURE }),
      ),
    ).toEqual({ outcomeText: GENERIC, failureText: FAILURE });
  });

  it('does not save hidden branch text on a no-check choice', () => {
    expect(
      flavorPayload(base({ type: 'none' }, { outcomeText: GENERIC, successText: SUCCESS, failureText: FAILURE })),
    ).toEqual({ outcomeText: GENERIC });
  });

  it('saves nothing when nothing is authored, keeping legacy payloads identical', () => {
    const payload = toPayload({ ...EMPTY_DRAFT, choices: [base({ type: 'none' })] });
    expect(Object.keys(payload.choices[0]!)).toEqual([
      'label',
      'emoji',
      'requirements',
      'check',
      'successEffects',
      'failureEffects',
    ]);
  });

  it('round-trips server flavor through the draft', () => {
    const server = {
      ...EMPTY_DRAFT,
      id: 1,
      choices: [
        {
          id: 3,
          sortOrder: 0,
          label: 'Cross',
          emoji: null,
          requirements: {},
          check: { type: 'sp', baseChance: 0.55 },
          successEffects: [],
          failureEffects: [],
          outcomeText: GENERIC,
          successText: SUCCESS,
          failureText: null,
        },
      ],
    } as AdminEncounter;
    const choice = toPayload(draftFrom(server)).choices[0]!;
    expect(choice).toMatchObject({ outcomeText: GENERIC, successText: SUCCESS });
    expect('failureText' in choice).toBe(false);
  });
});

describe('preview: flavor per outcome', () => {
  it('success preview shows the server-resolved success text', () => {
    render(
      <OutcomeFlavorPreview
        label="Cross"
        chance={0.55}
        flavors={[
          { outcome: 'success', resolvedOutcomeText: SUCCESS },
          { outcome: 'failure', resolvedOutcomeText: FAILURE },
        ]}
      />,
    );
    expect(screen.getByTestId('flavor-text')).toHaveTextContent(SUCCESS);
    expect(screen.getByText('✅ Success')).toBeInTheDocument();
  });

  it('failure preview shows the failure text', async () => {
    const user = userEvent.setup();
    render(
      <OutcomeFlavorPreview
        label="Cross"
        chance={0.55}
        flavors={[
          { outcome: 'success', resolvedOutcomeText: SUCCESS },
          { outcome: 'failure', resolvedOutcomeText: FAILURE },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Failure' }));
    expect(screen.getByTestId('flavor-text')).toHaveTextContent(FAILURE);
    expect(screen.getByText('❌ Failure')).toBeInTheDocument();
  });

  it('shows the outcomeText fallback the server resolved for each branch', async () => {
    const user = userEvent.setup();
    render(
      <OutcomeFlavorPreview
        label="Cross"
        chance={0.5}
        flavors={[
          { outcome: 'success', resolvedOutcomeText: GENERIC },
          { outcome: 'failure', resolvedOutcomeText: GENERIC },
        ]}
      />,
    );
    expect(screen.getByTestId('flavor-text')).toHaveTextContent(GENERIC);
    await user.click(screen.getByRole('button', { name: 'Failure' }));
    expect(screen.getByTestId('flavor-text')).toHaveTextContent(GENERIC);
  });

  it('a no-check preview shows outcomeText with no outcome toggle or check line', () => {
    render(
      <OutcomeFlavorPreview label="Follow" chance={1} flavors={[{ outcome: 'auto', resolvedOutcomeText: GENERIC }]} />,
    );
    expect(screen.getByTestId('flavor-text')).toHaveTextContent(GENERIC);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/🎲/)).toBeNull();
  });

  it('places flavor between the outcome line and the check line, like Discord', () => {
    render(
      <OutcomeFlavorPreview
        label="Cross"
        chance={0.55}
        flavors={[
          { outcome: 'success', resolvedOutcomeText: SUCCESS },
          { outcome: 'failure', resolvedOutcomeText: null },
        ]}
      />,
    );
    const text = screen.getByTestId('flavor-preview').textContent ?? '';
    expect(text.indexOf('Outcome:')).toBeLessThan(text.indexOf(SUCCESS));
    expect(text.indexOf(SUCCESS)).toBeLessThan(text.indexOf('🎲 Check'));
  });

  it('renders nothing when no outcome has flavor, preserving the current preview', () => {
    const { container } = render(
      <OutcomeFlavorPreview
        label="Cross"
        chance={0.5}
        flavors={[
          { outcome: 'success', resolvedOutcomeText: null },
          { outcome: 'failure', resolvedOutcomeText: null },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/* ─────────────────────── Simulator ─────────────────────── */

const ENCOUNTER: AdminEncounter = {
  ...EMPTY_DRAFT,
  id: 7,
  slug: 'crumbling_bridge',
  name: 'Crumbling Bridge',
  choices: [
    {
      id: 70,
      sortOrder: 0,
      label: 'Cross',
      emoji: null,
      requirements: {},
      check: { type: 'sp', baseChance: 0.55 },
      successEffects: [],
      failureEffects: [],
    },
  ],
};

function simResponse(outcomeTexts?: NonNullable<SimulateResponse['aggregate']['outcomeTexts']>): SimulateResponse {
  return {
    encounter: ENCOUNTER,
    choiceId: 70,
    aggregate: {
      rolls: 100,
      successes: 60,
      failures: 40,
      successRate: 0.6,
      expectedSuccessRate: 0.55,
      successRateDeviation: 0.05,
      successRateStdError: 0.05,
      waifubuxGained: 0,
      waifubuxLost: 0,
      netWaifubux: 0,
      netWaifubuxPerRoll: 0,
      expectedNetWaifubuxPerRoll: 0,
      essenceGained: 0,
      essenceLost: 0,
      netEssence: 0,
      affectionGranted: 0,
      itemFrequency: {},
      followUpFrequency: {},
      ...(outcomeTexts ? { outcomeTexts } : {}),
      seed: 1,
    },
    sightings: [],
  };
}

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/encounters/7/preview']}>
        <Routes>
          <Route path="/admin/encounters/:id/preview" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function simulate(response: SimulateResponse) {
  vi.spyOn(adminEncounters, 'getAdminEncounter').mockResolvedValue(ENCOUNTER);
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue({
    regions: [],
    affinities: [],
    races: [],
    items: [],
    encounters: [],
    species: [],
    vendors: [],
    types: [],
    rarities: [],
    lifecycles: [],
  });
  vi.spyOn(adminEncounters, 'simulateAdminEncounter').mockResolvedValue(response);
  const user = userEvent.setup();
  render(<AdminEncounterPreviewPage />, { wrapper: Providers });
  await screen.findByText('Preview — Crumbling Bridge');
  await user.selectOptions(screen.getByLabelText('Choice'), '70');
  await user.click(screen.getByRole('button', { name: /^Run .* rolls$/ }));
  await screen.findByText('Outcome distribution');
}

describe('simulator: outcome flavor', () => {
  it('shows the flavor for each actual outcome with its count', async () => {
    await simulate(
      simResponse([
        { outcome: 'success', count: 60, resolvedOutcomeText: SUCCESS },
        { outcome: 'failure', count: 40, resolvedOutcomeText: FAILURE },
      ]),
    );
    const card = within(screen.getByTestId('sim-outcome-flavor'));
    expect(card.getByText(SUCCESS)).toBeInTheDocument();
    expect(card.getByText(FAILURE)).toBeInTheDocument();
    expect(card.getByText('× 60')).toBeInTheDocument();
    expect(card.getByText('× 40')).toBeInTheDocument();
  });

  it('shows a fallback line the server resolved', async () => {
    await simulate(
      simResponse([
        { outcome: 'success', count: 60, resolvedOutcomeText: GENERIC },
        { outcome: 'failure', count: 40, resolvedOutcomeText: null },
      ]),
    );
    const card = within(screen.getByTestId('sim-outcome-flavor'));
    expect(card.getByText(GENERIC)).toBeInTheDocument();
    expect(card.getByText('— none —')).toBeInTheDocument();
  });

  it('shows no flavor card when nothing is authored', async () => {
    await simulate(
      simResponse([
        { outcome: 'success', count: 60, resolvedOutcomeText: null },
        { outcome: 'failure', count: 40, resolvedOutcomeText: null },
      ]),
    );
    expect(screen.queryByTestId('sim-outcome-flavor')).toBeNull();
  });

  it('still renders against an older server that sends no flavor', async () => {
    await simulate(simResponse());
    expect(screen.queryByTestId('sim-outcome-flavor')).toBeNull();
  });
});
