/**
 * Saving a file the API will only hand over to an authenticated request.
 *
 * A plain `<a href="/api/…" download>` cannot work here: the Platform API
 * accepts exactly one credential, `Authorization: Bearer …`, and a navigation
 * started by the browser sends no such header. (Adding the token to the query
 * string would put a shared secret into history and access logs; weakening the
 * route's auth is not on the table.)
 *
 * So the bytes come through the same Axios instance every other request uses,
 * and the download is driven from the blob. The object URL is revoked
 * afterwards — each one pins its blob in memory until it is.
 */
import { apiClient } from '@/api/client';

export interface DownloadResult {
  /** Bytes actually received, for the caller to log or assert on. */
  bytes: number;
  contentType: string;
}

/**
 * Fetches `url` with the API client's credentials and saves it as `filename`.
 *
 * Rejects on transport or HTTP failure — the caller decides what a failed save
 * looks like, because "nothing happened" is a different UX problem from "the
 * image would not render".
 */
export async function downloadAuthenticatedFile(
  url: string,
  filename: string,
): Promise<DownloadResult> {
  const response = await apiClient.get<Blob>(url, {
    responseType: 'blob',
    // `url` is already origin-absolute — it is the same string the image
    // provider hands an `<img>`, and it therefore already carries the API
    // prefix. The client's own `baseURL` would prepend it a second time.
    baseURL: '',
  });
  const blob = response.data;

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    // Firefox requires the element to be in the document for a synthetic click.
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return {
    bytes: blob.size,
    contentType: blob.type,
  };
}

/**
 * A filesystem-safe filename for a rendered card, e.g.
 * `waifumon-alley_catgirl-level_20.webp`.
 *
 * Slug and variant only — no player id, no owned-copy id. Those are internal
 * identifiers with no meaning outside the database, and a file landing in
 * someone's Downloads folder should not carry them.
 */
export function cardFilename(slug: string, variant?: string | undefined): string {
  const parts = ['waifumon', slug, variant].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return `${parts.join('-').replace(/[^a-zA-Z0-9._-]/g, '_')}.webp`;
}
