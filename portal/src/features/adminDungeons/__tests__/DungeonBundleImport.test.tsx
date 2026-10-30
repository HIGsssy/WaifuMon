/**
 * Complete Dungeon Bundles (Content Portability CP-4B) in the Portal: the two
 * import formats named apart on the Dungeons list, the bundle review in
 * editor words (no ids or hashes outside Technical details), explicit
 * conflict decisions, "Review choices" before import, readiness, stale and
 * invalid bundles, permissions, the result's link to the draft, and the
 * editor's bundle exports.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import * as bundles from '@/api/adminDungeonBundles';
import type { DungeonBundleImportResult, DungeonBundlePreview } from '@/api/adminDungeonBundles';
import type * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';

import { DungeonBundleImportPanel } from '../DungeonBundleImportPanel';
import { install, PERMISSIONS, renderAt, renderWith } from './dungeonFixtures';

const hash = `sha256:${'b'.repeat(64)}`;
const ASSET_ID = '0b9e8d3c-1111-4222-8333-444455556666';
const WRITE = [...PERMISSIONS, 'enemies.write', 'artwork.write'];

const plan = (over: Partial<api.DungeonImportPlan> = {}): api.DungeonImportPlan => ({
  validPackage: true,
  packageId: 'source-package',
  packageHash: hash,
  sourceEnvironment: 'staging',
  dungeonKey: 'vault',
  contentHash: hash,
  planHash: hash,
  target: { status: 'different', expectedRevision: 3, currentContentHash: hash, changedFields: ['name'], enabled: true, publishedRevision: 2 },
  enemies: [],
  issues: [],
  publishable: true,
  lootTables: [],
  equipmentChanges: [],
  ...over,
});

function previewOf(over: Partial<DungeonBundlePreview> = {}): DungeonBundlePreview {
  return {
    bundle: {
      format: 'waifumon-dungeon-bundle', version: 1, exportedAt: '2026-10-29T12:00:00Z', sourceEnvironment: 'staging',
      origin: 'draft', draftRevision: 4, publishedRevision: 1, packageSchemaVersion: 4, sceneSpriteEvidence: 'catalogue', bundleHash: hash, warnings: [],
    },
    dungeon: { key: 'vault', name: 'The Vault', decision: 'replace', plan: plan() },
    artwork: {
      dungeon: [
        { usage: ['Room “Lair” background'], source: 'shipped', path: 'dungeons/backgrounds/lair.webp', asset: 'asset-001', destination: 'create', rebound: true },
        { usage: ['Dungeon cover'], source: 'managed', path: null, asset: 'asset-002', destination: 'reuse', rebound: false },
      ],
      assets: [
        { id: 'asset-001', category: 'dungeon_background', sha256: 'c'.repeat(64), bytes: 2048, mimeType: 'image/webp', width: 160, height: 90, name: 'lair.webp', action: 'create', reuse: [], usedBy: ['Room “Lair” background'] },
        { id: 'asset-002', category: 'dungeon_zone', sha256: 'd'.repeat(64), bytes: 1024, mimeType: 'image/webp', width: 96, height: 54, name: 'cover.webp', action: 'reuse', reuse: [ASSET_ID], usedBy: ['Dungeon cover'] },
      ],
    },
    sceneSprites: [
      {
        key: 'golden_chest', name: 'Golden chest', outcome: 'conflict', changedFields: ['placement'], archivedHere: false,
        references: [{ dungeonKey: 'other', name: 'Other Dungeon', source: 'draft' }], suggestedCopyKey: 'golden_chest_imported',
        decision: null, resultKey: 'golden_chest', asset: 'asset-003', assetDestination: 'not_needed',
      },
    ],
    sharedPools: [
      {
        key: 'exclusives', name: 'Shared exclusives', outcome: 'create', changedFields: [], enabledHere: null, enabledAfterImport: false,
        currentRevision: null, otherDungeons: [], decision: null, uses: 'bundled', species: [{ slug: 'android', status: 'available' }],
      },
    ],
    enemies: [
      {
        key: 'guard', name: 'Vault Guard', outcome: 'conflict', changedFields: ['attack'], activation: null,
        references: [{ kind: 'dungeon_zone', key: 'other', name: 'Other Dungeon', usage: 'hall' }], issues: [],
        artwork: { source: 'managed', destination: { kind: 'reuse', asset: 'asset-004', assetId: ASSET_ID }, notes: [] },
        sprite: { source: 'managed', destination: { kind: 'create', asset: 'asset-005' }, notes: [] }, decision: null,
      },
    ],
    prerequisites: [
      { kind: 'species', key: 'android', name: 'Exclusive Android', status: 'available', notes: ['Dungeon-exclusive: only this dungeon’s own Species access (and any central access) can grant it.'] },
      { kind: 'item', key: 'sticky_joystick', name: 'Sticky Joystick', status: 'available', notes: [] },
    ],
    remainsDisabled: [{ kind: 'shared_pool', key: 'exclusives', name: 'Shared exclusives', requiredForPublication: true }],
    issues: [{ code: 'artwork_rebound', severity: 'warning', path: 'artwork.asset-001', message: 'Room “Lair” background: the bundled copy is used.' }],
    decisionsRequired: ['enemy:guard', 'sprite:golden_chest'],
    readiness: 'needs_enabling',
    planHash: hash,
    ...over,
  };
}

const result: DungeonBundleImportResult = {
  importId: 7, requestId: 'r', replayed: false, dungeonKey: 'vault', dungeonResult: 'replaced', draftRevision: 4, dungeonImportId: 9,
  enabled: true, publishedRevision: 2, readiness: 'needs_enabling',
  enemies: { created: [], updated: ['guard'], skipped: [], unchanged: [] },
  sceneSprites: { created: [], updated: [], copied: [{ from: 'golden_chest', to: 'golden_chest_imported' }], reused: [], kept: [] },
  sharedPools: { created: ['exclusives'], updated: [], reused: [], kept: [] },
  assets: { created: 2, reused: 1 }, createdLootTables: [],
  remainsDisabled: [{ kind: 'shared_pool', key: 'exclusives', name: 'Shared exclusives', requiredForPublication: true }], issues: [],
};

const zip = () => new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'vault.bundle.zip', { type: 'application/zip' });

beforeEach(() => {
  install();
  stubObjectUrls();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555');
});

describe('the Dungeons list', () => {
  it('names the two formats apart and opens the bundle import beside the JSON one', async () => {
    const user = userEvent.setup();
    renderAt('/admin/dungeons', WRITE);
    const json = await screen.findByRole('button', { name: 'Import Dungeon' });
    const bundle = screen.getByRole('button', { name: 'Import Complete Dungeon Bundle (ZIP)' });
    expect(json).toHaveAttribute('title', expect.stringContaining('Dungeon JSON'));
    expect(bundle).toHaveAttribute('title', expect.stringContaining('artwork'));
    await user.click(bundle);
    expect(await screen.findByRole('heading', { name: 'Import Complete Dungeon Bundle (ZIP)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Dungeon bundle file')).toBeInTheDocument();
  });
});

describe('reviewing and importing a bundle', () => {
  it('shows the review in editor words, requires decisions and a fresh review of them, then imports exactly that', async () => {
    const previewSpy = vi.spyOn(bundles, 'previewDungeonBundle').mockResolvedValueOnce(previewOf()).mockResolvedValueOnce(previewOf({ decisionsRequired: [] }));
    const applySpy = vi.spyOn(bundles, 'applyDungeonBundle').mockResolvedValue(result);
    const user = userEvent.setup();
    renderWith(<DungeonBundleImportPanel onCancel={() => {}} />, WRITE);
    await user.upload(screen.getByLabelText('Dungeon bundle file'), zip());
    const review = await screen.findByTestId('bundle-review');
    expect(within(review).getByText(/Replaces this dungeon’s draft/)).toBeInTheDocument();
    expect(within(review).getByText(/Revision 2 stays live for players, active runs and acquisition terms/)).toBeInTheDocument();
    expect(screen.getByTestId('bundle-readiness')).toHaveTextContent('Complete — enable dependencies before publishing');
    expect(within(review).getByRole('region', { name: 'Enemies' })).toHaveTextContent('Vault Guard');
    expect(within(review).getByRole('region', { name: 'Enemies' })).toHaveTextContent('Used here by Other Dungeon');
    expect(within(review).getByRole('region', { name: 'Shared WaifuMon pools' })).toHaveTextContent('Disabled after import');
    expect(within(review).getByRole('region', { name: 'Artwork' })).toHaveTextContent('1 images to add · 1 already here');
    expect(within(review).getByRole('region', { name: 'Artwork' })).toHaveTextContent('bundled copy is used as managed artwork');
    expect(within(review).getByRole('region', { name: 'Required content on this server' })).toHaveTextContent('WaifuMon Exclusive Android: available here');
    expect(within(review).getByRole('region', { name: 'After import' })).toHaveTextContent('Shared pool Shared exclusives remains disabled — enable it before publishing.');
    // Ids and hashes stay under Technical details.
    const outside = review.cloneNode(true) as HTMLElement;
    outside.querySelector('[data-testid="bundle-technical"]')?.remove();
    expect(outside.textContent).not.toContain(ASSET_ID);
    expect(outside.textContent).not.toContain('b'.repeat(64));
    expect(within(screen.getByTestId('bundle-technical')).getByText(new RegExp(ASSET_ID))).toBeInTheDocument();

    const importButton = screen.getByRole('button', { name: 'Import bundle' });
    expect(importButton).toBeDisabled();
    expect(screen.getByText(/Choose what to do with: Vault Guard, Golden chest/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Decision for enemy guard'), 'update');
    await user.selectOptions(screen.getByLabelText('Decision for Scene Sprite golden_chest'), 'copy');
    // A changed choice must be reviewed before it can be imported.
    await user.click(screen.getByRole('button', { name: 'Review choices' }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));
    expect(previewSpy.mock.calls[1]![1]).toMatchObject({ enemies: { guard: 'update' }, sceneSprites: { golden_chest: 'copy' } });
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this/ }));
    await user.click(screen.getByRole('button', { name: 'Import bundle' }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0]![1]).toEqual({
      expectedPlanHash: hash,
      requestId: '11111111-2222-4333-8444-555555555555',
      decisions: { dungeon: 'replace', enemies: { guard: 'update' }, sceneSprites: { golden_chest: 'copy' }, sharedPools: {}, allowIncomplete: false },
    });
    const done = await screen.findByTestId('bundle-import-result');
    expect(done).toHaveTextContent('The draft was replaced. Published revision 2 is still live; the dungeon is enabled.');
    expect(within(done).getByRole('link', { name: 'Open imported draft' })).toHaveAttribute('href', '/admin/dungeons/definitions/vault');
    expect(within(done).getByRole('link', { name: 'Dungeon WaifuMon Pools' })).toBeInTheDocument();
  });

  it('a stale review offers a fresh review; nothing is imported', async () => {
    vi.spyOn(bundles, 'previewDungeonBundle').mockResolvedValue(previewOf({ decisionsRequired: [], sceneSprites: [], enemies: [] }));
    vi.spyOn(bundles, 'applyDungeonBundle').mockRejectedValue(new PortalApiError({ status: 409, code: 'DUNGEON_BUNDLE_STALE', message: 'stale' }));
    const user = userEvent.setup();
    renderWith(<DungeonBundleImportPanel onCancel={() => {}} />, WRITE);
    await user.upload(screen.getByLabelText('Dungeon bundle file'), zip());
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this/ }));
    await user.click(screen.getByRole('button', { name: 'Import bundle' }));
    expect(await screen.findByText(/changed since you reviewed it\. Nothing was imported/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review again' }));
    await waitFor(() => expect(bundles.previewDungeonBundle).toHaveBeenCalledTimes(2));
  });

  it('an incomplete bundle imports only as an explicitly accepted repair draft; a blocked one never', async () => {
    vi.spyOn(bundles, 'previewDungeonBundle').mockResolvedValue(previewOf({
      decisionsRequired: [], sceneSprites: [], enemies: [], readiness: 'incomplete',
      issues: [{ code: 'species_missing', severity: 'error', path: 'dungeon.rooms[0]', message: 'WaifuMon “Ghost” is missing here.' }],
    }));
    const user = userEvent.setup();
    renderWith(<DungeonBundleImportPanel onCancel={() => {}} />, WRITE);
    await user.upload(screen.getByLabelText('Dungeon bundle file'), zip());
    expect(await screen.findByTestId('bundle-readiness')).toHaveTextContent('Incomplete — repair draft only');
    expect(screen.getByRole('region', { name: 'Problems' })).toHaveTextContent('WaifuMon “Ghost” is missing here.');
    expect(screen.getByRole('checkbox', { name: /I reviewed this/ })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /incomplete draft for repair/ }));
    // Accepting repair mode clears any earlier confirmation; the editor confirms again.
    await user.click(screen.getByRole('checkbox', { name: /I reviewed this/ }));
    expect(screen.getByRole('button', { name: 'Import bundle' })).toBeEnabled();
  });

  it('a bundle the server refuses lists why, and nothing else is shown', async () => {
    vi.spyOn(bundles, 'previewDungeonBundle').mockRejectedValue(
      new PortalApiError({ status: 400, code: 'DUNGEON_BUNDLE_INVALID', message: 'bad', details: { issues: [{ path: 'artwork/asset-001.webp', message: 'does not match its declared sha256' }] } }),
    );
    const user = userEvent.setup();
    renderWith(<DungeonBundleImportPanel onCancel={() => {}} />, WRITE);
    await user.upload(screen.getByLabelText('Dungeon bundle file'), zip());
    expect(await screen.findByTestId('bundle-invalid')).toHaveTextContent('does not match its declared sha256');
    expect(screen.queryByTestId('bundle-review')).not.toBeInTheDocument();
  });

  it('without enemies.write and artwork.write the bundle can be reviewed but not imported', async () => {
    vi.spyOn(bundles, 'previewDungeonBundle').mockResolvedValue(previewOf({ decisionsRequired: [], sceneSprites: [], enemies: [] }));
    const user = userEvent.setup();
    renderWith(<DungeonBundleImportPanel onCancel={() => {}} />, PERMISSIONS);
    expect(screen.getByRole('note')).toHaveTextContent('also needs enemies.write and artwork.write');
    await user.upload(screen.getByLabelText('Dungeon bundle file'), zip());
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed this/ }));
    expect(screen.getByRole('button', { name: 'Import bundle' })).toBeDisabled();
  });
});

describe('exporting from the editor', () => {
  it('offers draft, published and revision bundles, and lists why an export was refused', async () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const exportSpy = vi
      .spyOn(bundles, 'exportDungeonBundle')
      .mockResolvedValueOnce({ blob: new Blob(['zip']), filename: 'tunnels.aaaa.bundle.zip' })
      .mockRejectedValueOnce(
        new PortalApiError({ status: 422, code: 'DUNGEON_BUNDLE_EXPORT_REFUSED', message: 'refused', details: { reason: 'artwork_unavailable', issues: [{ path: 'Room “Hall” background', message: 'is not stored here' }] } }),
      )
      .mockResolvedValueOnce({ blob: new Blob(['zip']), filename: 'tunnels.r1.bundle.zip' });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'History & export' }));
    expect(screen.getByText(/includes its artwork, enemies, Scene/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Export draft as Complete Bundle (ZIP)' }));
    await screen.findByText('Download started: tunnels.aaaa.bundle.zip');
    await user.click(screen.getByRole('button', { name: 'Export published revision as Complete Bundle (ZIP)' }));
    expect(await screen.findByTestId('bundle-export-refusal')).toHaveTextContent('Room “Hall” background: is not stored here');
    await user.click(screen.getByRole('button', { name: 'Export revision 1 as Complete Bundle (ZIP)' }));
    await screen.findByText('Download started: tunnels.r1.bundle.zip');
    expect(exportSpy.mock.calls.map((c) => c[1])).toEqual(['draft', 'published', { revision: 1 }]);
    expect(clicks).toEqual(['tunnels.aaaa.bundle.zip', 'tunnels.r1.bundle.zip']);
  });

  it('without enemies.read and artwork.read only Dungeon JSON is offered', async () => {
    const user = userEvent.setup();
    renderAt(undefined, ['dungeons.read', 'dungeons.write']);
    await user.click(await screen.findByRole('button', { name: 'History & export' }));
    expect(screen.queryByRole('button', { name: /Complete Bundle/ })).not.toBeInTheDocument();
    expect(screen.getByText('Complete Dungeon Bundles also need enemies.read and artwork.read.')).toBeInTheDocument();
  });
});

describe('decision encoding', () => {
  it('is base64url JSON the server decodes', () => {
    const encoded = bundles.encodeBundleDecisions({ dungeon: 'create', sceneSprites: { 'chest_ü': 'copy' } });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const json = new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)));
    expect(JSON.parse(json)).toEqual({ dungeon: 'create', sceneSprites: { 'chest_ü': 'copy' } });
  });
});
