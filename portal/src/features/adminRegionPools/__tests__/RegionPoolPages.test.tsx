/**
 * Region Pools pages against the API client (spied, never the network):
 * the overview, permissions, editing rows by rarity, the draft lifecycle,
 * stale drafts, the publish review and its fingerprint, shipped content,
 * history and rollback, probability scenarios and exclusive conflicts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import * as api from '@/api/adminRegionPools';
import type { RegionPoolEntry, RegionPoolView } from '@/api/adminRegionPools';
import { PortalApiError } from '@/api/client';
import { expectNoAxeViolations } from '@/test/axe';

import {
  ALL,
  BELT,
  CATALOGUE,
  LIST,
  PUBLISHED_ENTRIES,
  analysis,
  distribution,
  poolView,
  renderRegionPools,
  review,
  shipped,
} from './regionPoolFixtures';

const EDITOR = '/admin/region-pools/twin-peeks';

let current: RegionPoolView;
let saveSpy: MockInstance<typeof api.saveRegionPoolDraft>;
let discardSpy: MockInstance<typeof api.discardRegionPoolDraft>;
let publishSpy: MockInstance<typeof api.publishRegionPool>;
let reviewSpy: MockInstance<typeof api.reviewRegionPoolPublish>;
let analyseSpy: MockInstance<typeof api.analyseRegionPool>;
let mergeSpy: MockInstance<typeof api.mergeShippedIntoDraft>;
let loadShippedSpy: MockInstance<typeof api.loadShippedIntoDraft>;
let rollbackSpy: MockInstance<typeof api.rollbackRegionPool>;
let validateSpy: MockInstance<typeof api.validateRegionPoolEntries>;
let artworkSpy: MockInstance<typeof api.regionSpeciesArtworkBlob>;

/** What the server does with a save: a new draft revision holding exactly these entries. */
function savedAs(entries: RegionPoolEntry[]): RegionPoolView {
  const next = poolView(entries, { draftRevision: current.draft.revision + 1 });
  next.draft.updatedBy = '333';
  return next;
}

function staleError() {
  return new PortalApiError({
    status: 409,
    code: 'REGION_POOL_STALE',
    message: 'Someone else changed this draft.',
    details: {
      expectedDraftRevision: 4,
      currentDraftRevision: 5,
      updatedBy: '999',
      updatedAt: '2026-10-02T12:00:00.000Z',
    },
  });
}

beforeEach(() => {
  current = poolView();
  const statics = URL as unknown as { createObjectURL?: () => string; revokeObjectURL?: () => void };
  statics.createObjectURL = () => 'blob:mock';
  statics.revokeObjectURL = () => {};
  // Alley Catgirl has no artwork (404); Shrine Assistant's is refused (403).
  artworkSpy = vi.spyOn(api, 'regionSpeciesArtworkBlob').mockImplementation(async (slug) => {
    if (slug === 'alley_cat') throw new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'No artwork for that WaifuMon.' });
    if (slug === 'shrine_girl') throw new PortalApiError({ status: 403, code: 'PORTAL_PERMISSION_DENIED', message: 'Denied.' });
    return new Blob(['png'], { type: 'image/png' });
  });
  vi.spyOn(api, 'listRegionPools').mockImplementation(async () => ({ regions: LIST }));
  vi.spyOn(api, 'getRegionPoolSpecies').mockResolvedValue({ species: CATALOGUE });
  vi.spyOn(api, 'getRegionPool').mockImplementation(async () => current);
  vi.spyOn(api, 'getRegionPoolDrift').mockResolvedValue({
    status: 'clean',
    publishedRevision: 2,
    species: [],
    exclusiveConflicts: [],
    emptyTiers: [],
    shipped: { available: true, differs: false, diff: null },
  });
  analyseSpy = vi
    .spyOn(api, 'analyseRegionPool')
    .mockImplementation(async (_r, req) =>
      analysis({ source: req.source, result: distribution({ mode: req.mode, level: req.level }) }),
    );
  validateSpy = vi.spyOn(api, 'validateRegionPoolEntries').mockResolvedValue({ issues: [] });
  saveSpy = vi.spyOn(api, 'saveRegionPoolDraft').mockImplementation(async (_r, entries) => {
    current = savedAs(entries);
    return current;
  });
  discardSpy = vi.spyOn(api, 'discardRegionPoolDraft').mockImplementation(async () => {
    current = poolView(PUBLISHED_ENTRIES, { draftRevision: current.draft.revision + 1 });
    return current;
  });
  reviewSpy = vi.spyOn(api, 'reviewRegionPoolPublish').mockResolvedValue(review());
  publishSpy = vi.spyOn(api, 'publishRegionPool').mockImplementation(async () => {
    current = poolView(current.draft.entries, { publishedNumber: 3 });
    return current;
  });
  vi.spyOn(api, 'getRegionPoolShipped').mockResolvedValue(shipped());
  mergeSpy = vi.spyOn(api, 'mergeShippedIntoDraft').mockImplementation(async () => {
    current = savedAs([...PUBLISHED_ENTRIES, { species: 'new_r', weight: 4 }]);
    return current;
  });
  loadShippedSpy = vi.spyOn(api, 'loadShippedIntoDraft').mockImplementation(async () => {
    current = savedAs(shipped().entries);
    return current;
  });
  vi.spyOn(api, 'getRegionPoolHistory').mockResolvedValue({
    revisions: [
      { ...current.published!, current: true },
      { ...current.published!, number: 1, source: 'bootstrap', publishedBy: null, current: false },
    ],
  });
  vi.spyOn(api, 'getRegionPoolRevision').mockImplementation(async (_r, n) => ({
    ...current.published!,
    number: n,
    current: n === 2,
    entries: (n === 1 ? PUBLISHED_ENTRIES.slice(1) : PUBLISHED_ENTRIES).map((e) =>
      current.published!.entries.find((v) => v.species === e.species)!,
    ),
    speciesManifest: [],
  }));
  vi.spyOn(api, 'getRegionPoolEvents').mockResolvedValue({
    events: [
      {
        cursor: '9',
        action: 'published',
        actor: '222',
        details: { revisionNumber: 2, draftRevision: 3 },
        createdAt: '2026-09-30T09:00:00.000Z',
      },
      {
        cursor: '8',
        action: 'bootstrapped',
        actor: null,
        details: {},
        createdAt: '2026-09-01T09:00:00.000Z',
      },
    ],
  });
  vi.spyOn(api, 'previewRegionPoolRollback').mockResolvedValue(
    review({
      purpose: 'rollback:1',
      reviewHash: 'sha256:rollback',
      issues: [],
      requiredAcknowledgements: [],
      diffFromPublished: {
        added: [],
        removed: [{ species: 'cafe_maid', weight: 3 }],
        reweighted: [],
      },
    }),
  );
  rollbackSpy = vi.spyOn(api, 'rollbackRegionPool').mockImplementation(async () => {
    current = poolView(PUBLISHED_ENTRIES.slice(1), { publishedNumber: 3, draftRevision: 5 });
    return current;
  });
});
afterEach(() => vi.restoreAllMocks());

async function openEditor(permissions = ALL) {
  const user = userEvent.setup();
  renderRegionPools(EDITOR, permissions);
  await screen.findByRole('heading', { name: 'Region Pool — Twin Peeks' });
  return user;
}

describe('Region Pools overview', () => {
  it('lists every region with release state, revisions, coverage and drift, linking to the editor', async () => {
    renderRegionPools('/admin/region-pools', ['regions.read']);
    const peaks = await screen.findByTestId('region-card-twin-peeks');
    expect(within(peaks).getByRole('link', { name: 'Twin Peeks' })).toHaveAttribute(
      'href',
      '/admin/region-pools/twin-peeks',
    );
    expect(within(peaks).getByText('Released')).toBeInTheDocument();
    expect(within(peaks).getByText('Unpublished draft changes')).toBeInTheDocument();
    expect(within(peaks).getByText('#2')).toBeInTheDocument();
    const belt = screen.getByTestId('region-card-assteroid-belt');
    expect(within(belt).getByText('Unreleased')).toBeInTheDocument();
    expect(within(belt).getByText('Drift')).toBeInTheDocument();
    expect(within(belt).getByText(/empty — falls back/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('region-card-waifu-valley')).getByText('Default / fallback region'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('region-pools-access')).toHaveTextContent('read only');
    await expectNoAxeViolations();
  });
});

describe('permissions', () => {
  it('read-only: inspects everything with no enabled mutation controls', async () => {
    const user = await openEditor(['regions.read']);
    expect(screen.getByTestId('read-only-note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review & publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add species' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Weight for Cafe Maid')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Remove Cafe Maid/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByTestId('revision-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Roll back to revision/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Shipped content' }));
    expect(await screen.findByTestId('shipped-merge-candidates')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Merge/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load shipped pool into draft' }),
    ).not.toBeInTheDocument();
  });

  it('write without publish: edits drafts, cannot publish', async () => {
    await openEditor(['regions.read', 'regions.write']);
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review & publish/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('Publishing needs the regions.publish permission.'),
    ).toBeInTheDocument();
  });

  it('publish without write: publishes the saved draft, edits nothing', async () => {
    await openEditor(['regions.read', 'regions.publish']);
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review & publish/ })).toBeEnabled();
    expect(screen.getByLabelText('Weight for Cafe Maid')).toBeDisabled();
  });
});

describe('species thumbnails', () => {
  it('loads artwork through the Region Pools route on regions.read alone', async () => {
    await openEditor(['regions.read']);
    const thumb = screen.getByTestId('region-species-cafe_maid-thumbnail');
    expect(await within(thumb).findByTestId('artwork-thumbnail-image')).toHaveAttribute('alt', 'Cafe Maid');
    expect(artworkSpy).toHaveBeenCalledWith('cafe_maid');
  });

  it('shows a placeholder for missing or refused artwork and the editor keeps working', async () => {
    const user = await openEditor();
    for (const slug of ['alley_cat', 'shrine_girl']) {
      const thumb = screen.getByTestId(`region-species-${slug}-thumbnail`);
      expect(await within(thumb).findByTestId('artwork-thumbnail-missing')).toHaveTextContent('Preview unavailable');
    }
    const weight = screen.getByLabelText('Weight for Alley Catgirl');
    await user.clear(weight);
    await user.type(weight, '2');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    expect(saveSpy.mock.calls[0]![1]).toContainEqual({ species: 'alley_cat', weight: 2 });
  });
});

describe('editor', () => {
  it('groups by rarity with server odds, and explains EX', async () => {
    await openEditor();
    const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(sections.filter((s) => s?.endsWith('species'))).toEqual([
      'N species',
      'R species',
      'SR species',
      'SSR species',
      'UR species',
      'LR species',
      'EX — Not Huntable species',
    ]);
    expect(await screen.findByTestId('rarity-chance-SR')).toHaveTextContent('10.0%');
    const idol = screen.getByTestId('pool-row-sr_idol-odds');
    expect(idol).toHaveTextContent('Share of rarity75.0%');
    expect(idol).toHaveTextContent('Per encounter7.50%');
    expect(idol).toHaveTextContent('Per Hunt5.55%');
    expect(screen.getByTestId('ex-explanation')).toHaveTextContent('never rolls EX');
    expect(screen.queryByTestId('pool-row-ex_goddess-odds')).not.toBeInTheDocument();
    expect(screen.getByTestId('how-odds-work')).toHaveTextContent('not a probability');
    expect(analyseSpy).toHaveBeenCalledWith(
      'twin-peeks',
      { source: 'draft', mode: 'hunt', level: 1, compare: false },
      expect.anything(),
    );
    await expectNoAxeViolations();
  });

  it('adds, reweights and removes species, then saves exactly that with the loaded revision', async () => {
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: '+ Add species' }));
    const picker = screen.getByTestId('region-species-picker');
    // Dungeon-exclusive is shown and never selectable; a listed species says so.
    expect(
      within(picker).getByRole('button', { name: 'Add Delve Wraith to this pool' }),
    ).toBeDisabled();
    expect(within(picker).getByTestId('region-species-option-delve_wraith')).toHaveTextContent(
      'Dungeon-exclusive',
    );
    expect(
      within(picker).getByRole('button', { name: 'Add Cafe Maid to this pool' }),
    ).toBeDisabled();
    expect(within(picker).getByTestId('region-species-option-sleepy_r')).toHaveTextContent(
      'Disabled',
    );
    await user.selectOptions(within(picker).getByLabelText('Filter species by rarity'), 'R');
    await user.type(within(picker).getByLabelText('Search species'), 'fresh');
    await user.click(
      within(picker).getByRole('button', { name: 'Add Fresh Recruit to this pool' }),
    );

    await user.clear(screen.getByLabelText('Weight for Stage Idol'));
    await user.type(screen.getByLabelText('Weight for Stage Idol'), '5');
    await user.click(screen.getByRole('button', { name: 'Remove Alley Catgirl from this pool' }));

    expect(screen.getByTestId('status-local')).toHaveTextContent(
      '1 added, 1 removed, 1 reweighted',
    );
    expect(screen.getByTestId('rarity-stale-SR')).toBeInTheDocument();
    expect(screen.getByTestId('pool-row-sr_idol-odds')).toHaveTextContent('Save to recalculate');
    // Unchanged rarities keep the server's numbers.
    expect(screen.getByTestId('pool-row-ssr_knight-odds')).toHaveTextContent(
      'Share of rarity100.0%',
    );
    expect(screen.getByRole('button', { name: /Review & publish/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    expect(saveSpy).toHaveBeenCalledWith(
      'twin-peeks',
      [
        { species: 'cafe_maid', weight: 3 },
        { species: 'shrine_girl', weight: 1 },
        { species: 'sr_idol', weight: 5 },
        { species: 'sr_nurse', weight: 1 },
        { species: 'ssr_knight', weight: 1 },
        { species: 'ur_witch', weight: 1 },
        { species: 'lr_queen', weight: 1 },
        { species: 'ex_goddess', weight: 1 },
        { species: 'new_r', weight: 1 },
      ],
      4,
    );
    expect(await screen.findByTestId('region-pool-notice')).toHaveTextContent(
      'Hunting is unchanged',
    );
    expect(screen.getByTestId('status-local')).toHaveTextContent('None');
    expect(screen.getByTestId('status-draft')).toHaveTextContent('Revision 5');
  });

  it('refuses an invalid weight before the round trip and asks the server about unsaved rows', async () => {
    const user = await openEditor();
    validateSpy.mockResolvedValue({
      issues: [
        {
          id: 'rarity_tier_empty:UR',
          code: 'rarity_tier_empty',
          severity: 'warning',
          message:
            'No huntable UR species here: UR rolls will draw Waifu Valley’s UR species instead.',
          acknowledgementRequired: false,
          rarity: 'UR',
        },
      ],
    });
    await user.clear(screen.getByLabelText('Weight for Stage Idol'));
    await user.type(screen.getByLabelText('Weight for Stage Idol'), '0');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByText(/whole number from 1 to 1,000,000/)).toBeInTheDocument();
    await waitFor(() => expect(validateSpy).toHaveBeenCalled());
    expect(
      await within(screen.getByTestId('rarity-section-UR')).findByText(/No huntable UR species/),
    ).toBeInTheDocument();
  });

  it('explains the consequence before removing the last species of a rarity', async () => {
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Remove Rose Knight from this pool' }));
    const dialog = await screen.findByTestId('region-pool-confirm');
    expect(dialog).toHaveTextContent('Remove the last SSR species?');
    expect(dialog).toHaveTextContent('only SSR species');
    expect(dialog).toHaveTextContent('default region');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('pool-row-ssr_knight')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Rose Knight from this pool' }));
    await user.click(
      within(await screen.findByTestId('region-pool-confirm')).getByRole('button', {
        name: 'Remove Rose Knight',
      }),
    );
    expect(screen.queryByTestId('pool-row-ssr_knight')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('rarity-section-SSR')).getByText('No SSR species in this pool.'),
    ).toBeInTheDocument();
  });

  it('warns before discarding unsaved edits, and resets the saved draft to published only on confirmation', async () => {
    current = poolView([...PUBLISHED_ENTRIES.slice(0, -1)]);
    const user = await openEditor();
    await user.clear(screen.getByLabelText('Weight for Cafe Maid'));
    await user.type(screen.getByLabelText('Weight for Cafe Maid'), '9');
    await user.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
    await user.click(
      within(await screen.findByTestId('region-pool-confirm')).getByRole('button', {
        name: 'Discard unsaved edits',
      }),
    );
    expect(screen.getByLabelText('Weight for Cafe Maid')).toHaveValue('3');
    expect(saveSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reset draft to published' }));
    const confirm = await screen.findByTestId('region-pool-confirm');
    expect(confirm).toHaveTextContent('published revision #2');
    await user.click(within(confirm).getByRole('button', { name: 'Reset draft' }));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('twin-peeks', 4));
  });

  it('shows who changed a stale draft and reloads their version on request', async () => {
    const user = await openEditor();
    saveSpy.mockRejectedValueOnce(staleError());
    await user.clear(screen.getByLabelText('Weight for Cafe Maid'));
    await user.type(screen.getByLabelText('Weight for Cafe Maid'), '7');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const banner = await screen.findByTestId('stale-banner');
    expect(banner).toHaveTextContent('Another administrator changed this draft.');
    expect(banner).toHaveTextContent('now at revision 5, saved by 999');
    expect(screen.getByLabelText('Weight for Cafe Maid')).toHaveValue('7');

    current = poolView([{ species: 'cafe_maid', weight: 2 }], { draftRevision: 5 });
    await user.click(within(banner).getByRole('button', { name: 'Reload latest draft' }));
    await waitFor(() => expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Weight for Cafe Maid')).toHaveValue('2');
    expect(screen.getByTestId('status-draft')).toHaveTextContent('Revision 5');
  });

  it('names an unreleased region in a region-exclusive conflict, as the server reports it', async () => {
    current = poolView([...PUBLISHED_ENTRIES, { species: 'belt_empress', weight: 1 }]);
    current.issues = [
      {
        id: 'region_exclusive_conflict:belt_empress',
        code: 'region_exclusive_conflict',
        severity: 'warning',
        message: 'Belt Empress is region-exclusive and already published in assteroid-belt.',
        acknowledgementRequired: false,
        species: 'belt_empress',
        regions: ['assteroid-belt'],
      },
    ];
    await openEditor();
    const row = screen.getByTestId('pool-row-belt_empress');
    expect(within(row).getByText(/already published in assteroid-belt/)).toBeInTheDocument();
    expect(await within(row).findByTestId('exclusive-conflict-regions')).toHaveTextContent(
      `Conflicts with: ${BELT.name} (unreleased)`,
    );
    expect(row).toHaveTextContent('Also published in Assteroid Belt');
  });
});

describe('publication review', () => {
  it('publishes with the exact server fingerprint and acknowledged warning ids', async () => {
    current = poolView(
      PUBLISHED_ENTRIES.map((e) => (e.species === 'sr_idol' ? { ...e, weight: 5 } : e)),
    );
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: /Review & publish/ }));
    const dialog = await screen.findByTestId('region-pool-review');
    expect(await within(dialog).findByTestId('review-hash')).toHaveTextContent('sha256:review-one');
    expect(within(dialog).getByTestId('review-diff')).toHaveTextContent('Stage Idol 3 → 5');
    expect(within(dialog).getByTestId('review-coverage')).toBeInTheDocument();
    expect(await within(dialog).findByTestId('review-probability')).toBeInTheDocument();
    const publish = within(dialog).getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /Ex Goddess is EX/ }));
    expect(publish).toBeEnabled();
    await user.click(publish);
    await waitFor(() =>
      expect(publishSpy).toHaveBeenCalledWith('twin-peeks', {
        expectedDraftRevision: 4,
        reviewHash: 'sha256:review-one',
        acknowledgedWarnings: ['species_not_huntable:ex_goddess'],
      }),
    );
    expect(await screen.findByTestId('region-pool-notice')).toHaveTextContent(
      'Published revision #3',
    );
    expect(screen.getByTestId('status-published')).toHaveTextContent('Revision #3');
  });

  it('never retries a stale review: it asks for a fresh one, which needs new acknowledgements', async () => {
    current = poolView(
      PUBLISHED_ENTRIES.map((e) => (e.species === 'sr_idol' ? { ...e, weight: 5 } : e)),
    );
    publishSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'REGION_POOL_REVIEW_STALE',
        message: 'Validate again.',
        details: { issues: [], reviewHash: 'sha256:server-fresh' },
      }),
    );
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: /Review & publish/ }));
    const dialog = await screen.findByTestId('region-pool-review');
    await user.click(await within(dialog).findByRole('checkbox', { name: /Ex Goddess is EX/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByTestId('review-refusal')).toHaveTextContent(
      'This review is out of date.',
    );
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Publish' })).toBeDisabled();

    reviewSpy.mockResolvedValueOnce(review({ reviewHash: 'sha256:review-two' }));
    await user.click(within(dialog).getByRole('button', { name: 'Start a fresh review' }));
    expect(await within(dialog).findByText('sha256:review-two')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Ex Goddess is EX/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /Ex Goddess is EX/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2));
    expect(publishSpy.mock.calls[1]![1].reviewHash).toBe('sha256:review-two');
    expect(publishSpy.mock.calls.some((c) => c[1].reviewHash === 'sha256:server-fresh')).toBe(
      false,
    );
  });

  it('shows blocking errors and disables publishing', async () => {
    reviewSpy.mockResolvedValue(
      review({
        canPublish: false,
        requiredAcknowledgements: [],
        issues: [
          {
            id: 'region_exclusive_conflict:lr_queen',
            code: 'region_exclusive_conflict',
            severity: 'error',
            message: 'Peak Queen is region-exclusive and already published in assteroid-belt.',
            acknowledgementRequired: false,
            species: 'lr_queen',
            regions: ['assteroid-belt'],
          },
        ],
      }),
    );
    const user = await openEditor();
    await user.click(screen.getByRole('button', { name: /Review & publish/ }));
    const dialog = await screen.findByTestId('region-pool-review');
    const errors = await within(dialog).findByTestId('review-errors');
    expect(errors).toHaveTextContent('Peak Queen is region-exclusive');
    expect(within(errors).getByTestId('exclusive-conflict-regions')).toHaveTextContent(
      'Assteroid Belt (unreleased)',
    );
    expect(within(dialog).getByRole('button', { name: 'Publish' })).toBeDisabled();
  });
});

describe('shipped content', () => {
  it('compares shipped with draft and published, merges selected species and applies chosen changes as edits', async () => {
    const user = await openEditor();
    await user.click(screen.getByRole('tab', { name: 'Shipped content' }));
    expect(await screen.findByTestId('shipped-vs-published')).toHaveTextContent(
      'Added (1): Fresh Recruit (weight 4)',
    );
    expect(screen.getByTestId('shipped-vs-published')).toHaveTextContent(
      'Removed (1): Alley Catgirl',
    );
    expect(screen.getByText(/ghost_slug/)).toBeInTheDocument();
    expect(screen.getByTestId('shipped-portal-only')).toHaveTextContent('Alley Catgirl');

    // Weight conflict: applied only when ticked, as an unsaved edit.
    await user.click(screen.getByRole('checkbox', { name: /Use shipped weight for Cafe Maid/ }));
    await user.click(screen.getByRole('button', { name: 'Use shipped weights for selected' }));
    await user.click(screen.getByRole('tab', { name: 'Pool editor' }));
    expect(screen.getByLabelText('Weight for Cafe Maid')).toHaveValue('2');
    expect(saveSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
    await user.click(
      within(await screen.findByTestId('region-pool-confirm')).getByRole('button', {
        name: 'Discard unsaved edits',
      }),
    );

    await user.click(screen.getByRole('tab', { name: 'Shipped content' }));
    await user.click(await screen.findByRole('checkbox', { name: /Merge Fresh Recruit/ }));
    await user.click(screen.getByRole('button', { name: 'Merge selected into draft' }));
    await waitFor(() => expect(mergeSpy).toHaveBeenCalledWith('twin-peeks', 4, ['new_r']));
    expect(await screen.findByTestId('region-pool-notice')).toHaveTextContent('Not published');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('confirms before loading the shipped pool into the draft', async () => {
    const user = await openEditor();
    await user.click(screen.getByRole('tab', { name: 'Shipped content' }));
    await user.click(await screen.findByRole('button', { name: 'Load shipped pool into draft' }));
    const confirm = await screen.findByTestId('region-pool-confirm');
    expect(confirm).toHaveTextContent('Nothing is published');
    expect(loadShippedSpy).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Load shipped pool' }));
    await waitFor(() => expect(loadShippedSpy).toHaveBeenCalledWith('twin-peeks', 4));
  });
});

describe('history and rollback', () => {
  it('shows revisions, their changes and the audit trail', async () => {
    const user = await openEditor(['regions.read']);
    await user.click(screen.getByRole('tab', { name: 'History' }));
    const live = await screen.findByTestId('revision-2');
    expect(live).toHaveTextContent('Live');
    expect(live).toHaveTextContent('by 222');
    expect(screen.getByTestId('revision-1')).toHaveTextContent('Shipped content (first start)');
    await user.click(within(live).getByRole('button', { name: 'Show changes' }));
    expect(await screen.findByTestId('revision-2-changes')).toHaveTextContent(
      'Added (1): Cafe Maid',
    );
    const audit = screen.getByTestId('region-pool-audit');
    expect(await within(audit).findByText('Published')).toBeInTheDocument();
    expect(audit).toHaveTextContent('revisionNumber: 2');
  });

  it('explains a rollback and requires confirmation of losing unsaved edits', async () => {
    current = poolView(PUBLISHED_ENTRIES.slice(0, -1));
    const user = await openEditor();
    await user.clear(screen.getByLabelText('Weight for Cafe Maid'));
    await user.type(screen.getByLabelText('Weight for Cafe Maid'), '8');
    await user.click(screen.getByRole('tab', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: 'Roll back to revision 1' }));
    const dialog = await screen.findByTestId('region-pool-review');
    expect(dialog).toHaveTextContent('creates a new published revision');
    expect(dialog).toHaveTextContent('updates the live hunting pool');
    expect(dialog).toHaveTextContent('replaces the saved draft');
    expect(dialog).toHaveTextContent('saved, unpublished draft changes will be lost');
    expect(dialog).toHaveTextContent('does not erase any historical revision');
    expect(await within(dialog).findByTestId('review-hash')).toHaveTextContent('sha256:rollback');
    const go = within(dialog).getByRole('button', { name: 'Roll back to revision #1' });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /Discard the unsaved edits/ }));
    await user.click(go);
    await waitFor(() =>
      expect(rollbackSpy).toHaveBeenCalledWith('twin-peeks', {
        revision: 1,
        expectedDraftRevision: 4,
        reviewHash: 'sha256:rollback',
        acknowledgedWarnings: [],
      }),
    );
    expect(await screen.findByTestId('region-pool-notice')).toHaveTextContent('Rolled back');
    expect(screen.getByTestId('status-local')).toHaveTextContent('None');
  });
});

describe('probability analysis', () => {
  it('sends the scenario to the server and shows its numbers, assumptions and exclusions', async () => {
    const user = await openEditor(['regions.read']);
    await user.click(screen.getByRole('tab', { name: 'Probability' }));
    const panel = await screen.findByTestId('region-pool-analysis');
    expect(await within(panel).findByTestId('analysis-assumptions')).toHaveTextContent(
      'Player level 1.',
    );
    expect(within(panel).getByTestId('analysis-species-sr_idol')).toHaveTextContent('7.50%');
    expect(within(panel).getByTestId('analysis-excluded')).toHaveTextContent(
      'Rarity never hunted (EX)',
    );

    await user.click(within(panel).getByRole('button', { name: 'Level 40' }));
    await user.selectOptions(within(panel).getByLabelText('Buddy species'), 'ur_witch');
    await waitFor(() =>
      expect(analyseSpy).toHaveBeenLastCalledWith(
        'twin-peeks',
        { source: 'published', mode: 'hunt', level: 40, compare: false, buddySpecies: 'ur_witch' },
        expect.anything(),
      ),
    );

    await user.click(within(panel).getByRole('tab', { name: 'Scripted spawns' }));
    await waitFor(() =>
      expect(analyseSpy).toHaveBeenLastCalledWith(
        'twin-peeks',
        { source: 'published', mode: 'scripted_spawn', level: 40, compare: false },
        expect.anything(),
      ),
    );

    await user.click(
      within(panel).getByRole('tab', { name: 'Filtered World Encounter selectors' }),
    );
    await user.click(within(panel).getByRole('checkbox', { name: 'Filter rarities SR' }));
    await waitFor(() =>
      expect(analyseSpy).toHaveBeenLastCalledWith(
        'twin-peeks',
        {
          source: 'published',
          mode: 'filtered_selector',
          level: 40,
          compare: false,
          filter: { poolScope: 'region', rarities: ['SR'] },
        },
        expect.anything(),
      ),
    );
  });

  it('shows the server reason when a scenario cannot be analysed, and the unsafe share without odds', async () => {
    analyseSpy.mockImplementation(async (_r, req) => {
      if (req.level === 40)
        throw new PortalApiError({
          status: 400,
          code: 'REGION_POOL_SCENARIO_INVALID',
          message: 'No Waifumon "ghost" exists to be the Buddy.',
        });
      return analysis({
        result: distribution({
          errorProbability: 0.1,
          rarities: distribution().rarities.map((r) =>
            r.rarity === 'SR' ? { ...r, unsafe: true } : r,
          ),
          issues: [
            {
              code: 'unsafe_species_weights',
              severity: 'error',
              message: 'SR weights would make the draw fail.',
              rarity: 'SR',
            },
          ],
          exhausted: { probability: 0.002, fallback: 'default_pool_arbitrary' },
        }),
      });
    });
    const user = await openEditor(['regions.read']);
    await user.click(screen.getByRole('tab', { name: 'Probability' }));
    expect(await screen.findByTestId('analysis-unsafe')).toHaveTextContent('10.0%');
    expect(
      within(screen.getByTestId('analysis-rarity-SR')).getByText('Unsafe — no odds'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('analysis-exhausted')).toHaveTextContent(
      'an arbitrary species from the default region',
    );
    await user.click(screen.getByRole('button', { name: 'Level 40' }));
    expect(await screen.findByTestId('analysis-error')).toHaveTextContent(
      'This scenario cannot be analysed: No Waifumon "ghost" exists to be the Buddy.',
    );
  });

  it('shows draft-versus-published differences from the server comparison', async () => {
    analyseSpy.mockResolvedValue(
      analysis({
        source: 'published',
        comparison: {
          against: 'draft',
          result: distribution(),
          diff: {
            species: [{ slug: 'sr_idol', before: 0.075, after: 0.08333, delta: 0.00833 }],
            rarities: [{ rarity: 'SSR', tierBefore: 'region', tierAfter: 'default_region' }],
          },
        },
      }),
    );
    const user = await openEditor(['regions.read']);
    await user.click(screen.getByRole('tab', { name: 'Probability' }));
    const panel = await screen.findByTestId('region-pool-analysis');
    expect(await within(panel).findByTestId('analysis-species-sr_idol')).toHaveTextContent(
      '+0.833 pts',
    );
  });
});
