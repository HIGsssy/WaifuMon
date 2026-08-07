/**
 * The image loading state machine.
 *
 * Every test here exists because of one bug: artwork that had already been
 * downloaded once stayed on its skeleton forever when you navigated back to it.
 *
 * Two things caused it, and both are structural rather than incidental:
 *
 *  1. **`<img onLoad>` was the only way out of the loading state.** A cached
 *     image attached to the DOM may already be `complete` — the browser has
 *     nothing left to do, so it has no reason to fire `load` again in time for
 *     a listener that attached afterwards. The state machine waited for an
 *     event that had, in effect, already happened.
 *  2. **An effect reset the state after the fact.** `setIsLoaded(false)` ran in
 *     a passive effect keyed on the asset. Passive effects are flushed after
 *     paint, so a cached image could load *first* and get reset to loading
 *     immediately afterwards — permanently, because no second load event was
 *     coming. `<StrictMode>`'s mount → cleanup → mount cycle runs that effect
 *     twice, which is why development made it so easy to hit.
 *
 * The invariant the whole file defends: **an `<img>` reporting
 * `complete === true` and `naturalWidth > 0` must never be shown as loading.**
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Artwork } from '@/components/media/Artwork';
import { createLocalDevAssetsProvider } from '../providers/localDevAssets';
import { createSilhouetteProvider } from '../providers/silhouette';
import { setImageProviderChain } from '../provider';

/**
 * jsdom never fetches, so `complete` is always false and `naturalWidth` always
 * zero — the exact opposite of the situation under test. These getters make the
 * prototype answer the way a browser does for an image already in cache.
 */
const cached = new Set<string>();

function markCached(...urls: string[]): void {
  for (const url of urls) cached.add(url);
}

beforeEach(() => {
  cached.clear();
  setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);

  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get(this: HTMLImageElement) {
      return cached.has(this.getAttribute('src') ?? '');
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get(this: HTMLImageElement) {
      return cached.has(this.getAttribute('src') ?? '') ? 300 : 0;
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLImageElement.prototype, 'complete');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
});

/** The skeleton is the visible symptom: present means "still loading". */
function isShowingSkeleton(): boolean {
  return document.querySelector('.skeleton') !== null;
}

const NYX = '/dev-assets/t/256/waifumon/nyx/standard.png';
const LILITH = '/dev-assets/t/256/waifumon/lilith/standard.png';

function renderArt(slug: string, options: { strict?: boolean } = {}) {
  const tree = <Artwork asset={{ kind: 'species', slug }} name={slug} displayWidth={128} />;
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('image loading lifecycle', () => {
  it('starts on the skeleton and reveals the artwork when it loads', () => {
    renderArt('nyx');
    expect(isShowingSkeleton()).toBe(true);

    fireEvent.load(screen.getByAltText('nyx'));
    expect(isShowingSkeleton()).toBe(false);
  });

  it('shows a cached image immediately, without waiting for a load event', () => {
    // The core regression. No `fireEvent.load` here on purpose: a browser has
    // no reason to fire one for an image it already has.
    markCached(NYX);
    renderArt('nyx');

    expect(isShowingSkeleton()).toBe(false);
    expect(screen.getByAltText('nyx')).toHaveClass('opacity-100');
  });

  it('never reports loading for an image the DOM says is complete', () => {
    markCached(NYX);
    renderArt('nyx');

    const img = screen.getByAltText('nyx') as HTMLImageElement;
    expect(img.complete && img.naturalWidth > 0).toBe(true);
    expect(isShowingSkeleton()).toBe(false);
  });

  it('survives StrictMode’s mount → cleanup → mount cycle', () => {
    // The double invoke is what made the old reset-in-an-effect bug bite: the
    // second pass ran after the image had already settled.
    markCached(NYX);
    renderArt('nyx', { strict: true });

    expect(isShowingSkeleton()).toBe(false);
  });

  it('renders immediately on remount — the navigate-away-and-back case', () => {
    const first = renderArt('nyx');
    fireEvent.load(screen.getByAltText('nyx'));
    expect(isShowingSkeleton()).toBe(false);

    // Leaving the route makes the image cache-resident; coming back mounts a
    // brand-new component against that cache.
    markCached(NYX);
    first.unmount();

    renderArt('nyx');
    expect(isShowingSkeleton()).toBe(false);
  });

  it('remounts cleanly under StrictMode too', () => {
    const first = renderArt('nyx', { strict: true });
    fireEvent.load(screen.getByAltText('nyx'));
    markCached(NYX);
    first.unmount();

    renderArt('nyx', { strict: true });
    expect(isShowingSkeleton()).toBe(false);
  });

  it('returns to loading when the asset changes, and does not inherit the old state', () => {
    const { rerender } = render(
      <Artwork asset={{ kind: 'species', slug: 'nyx' }} name="nyx" displayWidth={128} />,
    );
    fireEvent.load(screen.getByAltText('nyx'));
    expect(isShowingSkeleton()).toBe(false);

    rerender(
      <Artwork asset={{ kind: 'species', slug: 'lilith' }} name="lilith" displayWidth={128} />,
    );
    // A recycled card must not claim the new artwork is ready.
    expect(isShowingSkeleton()).toBe(true);

    fireEvent.load(screen.getByAltText('lilith'));
    expect(isShowingSkeleton()).toBe(false);
  });

  it('adopts a newly cached asset on a source change without an event', () => {
    markCached(LILITH);
    const { rerender } = render(
      <Artwork asset={{ kind: 'species', slug: 'nyx' }} name="nyx" displayWidth={128} />,
    );
    expect(isShowingSkeleton()).toBe(true);

    rerender(
      <Artwork asset={{ kind: 'species', slug: 'lilith' }} name="lilith" displayWidth={128} />,
    );
    expect(isShowingSkeleton()).toBe(false);
  });

  it('requests a different rendition per width, and tracks each separately', () => {
    const { rerender } = render(
      <Artwork asset={{ kind: 'species', slug: 'nyx' }} name="nyx" displayWidth={128} />,
    );
    fireEvent.load(screen.getByAltText('nyx'));
    expect(isShowingSkeleton()).toBe(false);

    // A larger rendition is a different file — being done with the small one
    // says nothing about this one.
    rerender(<Artwork asset={{ kind: 'species', slug: 'nyx' }} name="nyx" displayWidth={1024} />);
    expect(isShowingSkeleton()).toBe(true);
  });
});

describe('fallback lifecycle', () => {
  it('reaches the loaded state through the silhouette when a rendition fails', () => {
    renderArt('nyx');
    const img = screen.getByAltText('nyx');
    expect(img).toHaveAttribute('src', NYX);

    fireEvent.error(img);

    const fallback = screen.getByAltText('nyx');
    expect(fallback.getAttribute('src')).toContain('data:image/svg+xml');
    // The failure swapped the source; the component is loading the *new* one.
    expect(isShowingSkeleton()).toBe(true);

    fireEvent.load(fallback);
    expect(isShowingSkeleton()).toBe(false);
  });

  it('does not leave stale state from the failed rendition behind', () => {
    renderArt('nyx');
    fireEvent.error(screen.getByAltText('nyx'));
    fireEvent.load(screen.getByAltText('nyx'));

    expect(isShowingSkeleton()).toBe(false);
    expect(screen.getByAltText('nyx')).toHaveClass('opacity-100');
  });

  it('shows a previously cached fallback immediately on remount', () => {
    const first = renderArt('nyx');
    fireEvent.error(screen.getByAltText('nyx'));
    const fallbackUrl = screen.getByAltText('nyx').getAttribute('src') ?? '';
    fireEvent.load(screen.getByAltText('nyx'));
    first.unmount();

    // Remount: the rendition fails again, and the silhouette data URI is
    // instantly available. Neither step may strand the component.
    markCached(fallbackUrl);
    renderArt('nyx');
    fireEvent.error(screen.getByAltText('nyx'));

    expect(isShowingSkeleton()).toBe(false);
  });
});

describe('load identity', () => {
  it('does not adopt a completed image whose source is not the one being rendered', () => {
    // React reuses one `<img>` across a source change, so "is the element
    // complete?" is not the same question as "is *this* artwork ready?". Only
    // lilith is in cache; rendering nyx must stay on the skeleton.
    markCached(LILITH);
    renderArt('nyx');

    expect(isShowingSkeleton()).toBe(true);
  });

  it('settles the new source, not the old one, when a swap lands on a cached image', () => {
    markCached(LILITH);
    const { rerender } = render(
      <Artwork asset={{ kind: 'species', slug: 'nyx' }} name="nyx" displayWidth={128} />,
    );
    expect(isShowingSkeleton()).toBe(true);

    rerender(
      <Artwork asset={{ kind: 'species', slug: 'lilith' }} name="lilith" displayWidth={128} />,
    );

    expect(isShowingSkeleton()).toBe(false);
    expect(screen.getByAltText('lilith')).toHaveAttribute('src', LILITH);
  });
});
