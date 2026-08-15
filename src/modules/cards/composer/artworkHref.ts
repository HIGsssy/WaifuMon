/**
 * The sentinel href the composer writes into `#character-art`.
 *
 * resvg resolves *local* image hrefs itself against a resources directory and
 * silently drops the node when the file is not there — which would mean either
 * baking an absolute filesystem path into the SVG document or letting a
 * missing file degrade into a blank art window. Neither is acceptable.
 *
 * Remote hrefs, by contrast, are handed back through `imagesToResolve()` for
 * the host to satisfy. Pointing the artwork at a non-routable sentinel URL and
 * answering it with the bytes we already read gives us an explicit,
 * fully-in-process image loader: nothing on disk is reachable from the
 * document, and unresolvable artwork fails earlier with a typed error rather
 * than rendering an empty card. No network request is ever made.
 */
export const ARTWORK_HREF = 'https://card-renderer.waifumon.invalid/artwork';
