/**
 * Authored artwork → Discord attachment.
 *
 * The one place that turns a path an author typed (a World Encounter's
 * `artworkPath`, a Result Presentation variant's `artwork_path`) into an
 * `AttachmentBuilder` an embed can reference. Species artwork does not come
 * through here — it has its own `AssetId` resolver with appearance fallbacks.
 *
 * Always best-effort: a missing file, an unsafe path or an unsupported format
 * logs once and returns null, and the caller renders text-only. Authored
 * artwork is optional decoration and must never cost a player their screen.
 */
import fs from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import {
  artworkAttachmentFilename,
  isSafeRelativeArtworkPath,
} from '../../modules/assets/artworkPath';
import { resolveAssetPath } from '../../modules/content/loader';
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

  const filename = isSafeRelativeArtworkPath(relativePath)
    ? artworkAttachmentFilename(stem, relativePath)
    : null;
  if (!filename) {
    ctx.logger.error(
      { tag: `${logTag}/artwork-unsafe`, ...fields },
      'artwork path rejected (must be a relative path to a .png/.webp/.jpg/.jpeg/.gif under assets/) — rendering text-only',
    );
    return null;
  }

  let absolute: string;
  try {
    absolute = resolveAssetPath(ctx.config.assetsDir, relativePath);
  } catch (err) {
    ctx.logger.error(
      { tag: `${logTag}/artwork-unsafe`, ...fields, err },
      'artwork path resolves outside the assets directory — rendering text-only',
    );
    return null;
  }

  if (!fs.existsSync(absolute)) {
    ctx.logger.warn(
      { tag: `${logTag}/artwork-missing`, ...fields },
      'artwork file missing under ASSETS_DIR — rendering text-only. Copy the file into assets/ or fix the path.',
    );
    return null;
  }

  return {
    file: new AttachmentBuilder(absolute, { name: filename }),
    url: `attachment://${filename}`,
  };
}
