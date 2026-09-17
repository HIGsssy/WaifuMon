/**
 * Authored artwork → Discord attachment.
 *
 * The one place that turns a path an author typed (a World Encounter's
 * `artworkPath`, a Result Presentation variant's `artwork_path`) into an
 * `AttachmentBuilder` an embed can reference. Species artwork does not come
 * through here — it has its own `AssetId` resolver with appearance fallbacks.
 *
 * The checks themselves live in `locateArtworkFile`, shared with the admin
 * artwork routes and the presentation preview; this module only decides what
 * a Discord screen does with each answer.
 *
 * Always best-effort: a missing file, an unsafe path or an unsupported format
 * logs once and returns null, and the caller renders text-only. Authored
 * artwork is optional decoration and must never cost a player their screen.
 */
import { AttachmentBuilder } from 'discord.js';
import { artworkAttachmentFilename } from '../../modules/assets/artworkPath';
import { locateArtworkFile } from '../../modules/assets/artworkFile';
import type { Logger } from '../../shared/logger';

export interface ArtworkAttachmentContext {
  config: { assetsDir: string };
  logger: Pick<Logger, 'warn' | 'error'>;
}

export interface ResolvedArtworkAttachment {
  file: AttachmentBuilder;
  /** `attachment://<name>` — what `EmbedBuilder.setImage` should receive. */
  url: string;
}

export interface ArtworkAttachmentRequest {
  /** Authored path relative to `ASSETS_DIR`, or null for "no artwork". */
  relativePath: string | null | undefined;
  /** Attachment filename stem; the source file's extension is appended. */
  stem: string;
  /** Log tag prefix, e.g. `world-encounter` → `world-encounter/artwork-missing`. */
  logTag: string;
  /** Extra structured fields for the log line (slug, variant id, …). */
  logFields?: Record<string, unknown>;
}

export function resolveArtworkAttachment(
  ctx: ArtworkAttachmentContext,
  request: ArtworkAttachmentRequest,
): ResolvedArtworkAttachment | null {
  const { relativePath, stem, logTag, logFields = {} } = request;
  if (!relativePath) return null;
  const fields = { ...logFields, artwork: relativePath };

  const located = locateArtworkFile(ctx.config.assetsDir, relativePath);
  if (located.status === 'unsafe') {
    ctx.logger.error(
      { tag: `${logTag}/artwork-unsafe`, ...fields, reason: located.reason },
      'artwork path rejected — rendering text-only',
    );
    return null;
  }
  if (located.status === 'missing') {
    ctx.logger.warn(
      { tag: `${logTag}/artwork-missing`, ...fields },
      'artwork file missing under ASSETS_DIR — rendering text-only. Copy the file into assets/ or fix the path.',
    );
    return null;
  }

  const filename = artworkAttachmentFilename(stem, relativePath)!;
  return {
    file: new AttachmentBuilder(located.absolutePath, { name: filename }),
    url: `attachment://${filename}`,
  };
}
