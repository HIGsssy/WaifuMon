/**
 * ResultPresentationService — reads authored presentation variants and
 * resolves how an already-decided outcome is shown.
 *
 * Deliberately narrow and independent of World Encounters: one table, no
 * lifecycle, no choices, checks, effects, cooldowns or history.
 *
 * ## Randomness is presentation-only
 *
 * The service owns its own `Rng` (Math.random in production, injectable for
 * tests). It is never the hunt's RNG, and it is only consulted *after* the
 * gameplay transaction has returned. Adding, disabling or reweighting a
 * variant therefore cannot move a single gameplay roll.
 *
 * ## Reads are cached
 *
 * Every non-encounter hunt and every release asks for variants, so reads go
 * through a short TTL cache (the World Encounter settings pattern): one query
 * loads every enabled variant, and `createVariant` refreshes this process's
 * cache immediately. The TTL bounds staleness when another process writes.
 *
 * ## Failure never costs the player a screen
 *
 * If the table cannot be read, the service logs and answers with no variants,
 * so the caller renders the built-in presentation.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  resultPresentationVariants,
  type ResultPresentationVariantRow,
} from '../../db/schema';
import type { Logger } from '../../shared/logger';
import { defaultRng, type Rng } from '../../shared/random';
import {
  ARTWORK_MODES,
  isResultPresentationKey,
  type ArtworkMode,
  type ResultPresentationKey,
} from './keys';
import {
  resolveResultPresentation,
  type ResolvedResultPresentation,
  type ResultPresentationVariant,
} from './resolver';
import { parseResultPresentationVariantInput } from './validation';

export interface ResolvePresentationOptions {
  /** Built-in lines for this key (e.g. the legacy `tables.hunt.flavor`). */
  fallbackFlavorLines?: readonly string[] | undefined;
}

export interface ResultPresentationService {
  /** Enabled, well-formed variants for one key. Cached; never throws. */
  getEnabledVariants(key: ResultPresentationKey): Promise<ResultPresentationVariant[]>;
  /**
   * Choose the presentation for one already-resolved outcome, once. Uses the
   * service's presentation RNG. Never throws: a read failure resolves to the
   * built-in presentation.
   */
  resolve(
    key: ResultPresentationKey,
    options?: ResolvePresentationOptions,
  ): Promise<ResolvedResultPresentation>;
  /**
   * Validate and store a variant. Minimal internal write path for tests and
   * the future authoring API; throws `ResultPresentationValidationError`.
   */
  createVariant(raw: unknown): Promise<ResultPresentationVariant>;
  /** Force the next read to hit the database. */
  invalidate(): void;
}

export interface ResultPresentationServiceDeps {
  db: Db;
  logger: Logger;
  /** Cache lifetime. Short by design — see the module comment. */
  ttlMs?: number | undefined;
  /** Presentation randomness. Never pass the gameplay RNG here. */
  rng?: Rng | undefined;
}

const DEFAULT_TTL_MS = 5_000;

function rowToVariant(row: ResultPresentationVariantRow): ResultPresentationVariant | null {
  if (!isResultPresentationKey(row.presentationKey)) return null;
  if (!(ARTWORK_MODES as readonly string[]).includes(row.artworkMode)) return null;
  return {
    id: row.id,
    presentationKey: row.presentationKey,
    enabled: row.enabled,
    weight: row.weight,
    flavorText: row.flavorText,
    artworkPath: row.artworkPath,
    artworkMode: row.artworkMode as ArtworkMode,
  };
}

export function createResultPresentationService(
  deps: ResultPresentationServiceDeps,
): ResultPresentationService {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const rng = deps.rng ?? defaultRng();
  let cache = new Map<ResultPresentationKey, ResultPresentationVariant[]>();
  let expiresAt = 0;
  let inFlight: Promise<Map<ResultPresentationKey, ResultPresentationVariant[]>> | null = null;

  async function load(): Promise<Map<ResultPresentationKey, ResultPresentationVariant[]>> {
    const rows = await deps.db
      .select()
      .from(resultPresentationVariants)
      .where(eq(resultPresentationVariants.enabled, true))
      .orderBy(resultPresentationVariants.id);
    const byKey = new Map<ResultPresentationKey, ResultPresentationVariant[]>();
    for (const row of rows) {
      const variant = rowToVariant(row);
      if (!variant) {
        deps.logger.warn(
          { tag: 'result-presentation/unusable-row', id: row.id, key: row.presentationKey },
          'ignoring result presentation row with an unknown key or artwork mode',
        );
        continue;
      }
      const list = byKey.get(variant.presentationKey) ?? [];
      list.push(variant);
      byKey.set(variant.presentationKey, list);
    }
    return byKey;
  }

  async function current(): Promise<Map<ResultPresentationKey, ResultPresentationVariant[]>> {
    if (Date.now() < expiresAt) return cache;
    if (!inFlight) {
      inFlight = load()
        .then((fresh) => {
          cache = fresh;
          expiresAt = Date.now() + ttl;
          return fresh;
        })
        .catch((err: unknown) => {
          // Keep serving whatever we last had (or nothing), and back off for
          // one TTL so a broken table is not queried on every hunt.
          deps.logger.warn(
            { tag: 'result-presentation/load-failed', err },
            'result presentation variants could not be loaded — using built-in presentation',
          );
          expiresAt = Date.now() + ttl;
          return cache;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    async getEnabledVariants(key) {
      return [...((await current()).get(key) ?? [])];
    },

    async resolve(key, options = {}) {
      let variants: ResultPresentationVariant[] = [];
      try {
        variants = await this.getEnabledVariants(key);
      } catch (err) {
        deps.logger.warn({ tag: 'result-presentation/resolve-failed', key, err }, 'variant read failed');
      }
      return resolveResultPresentation({
        key,
        variants,
        fallbackFlavorLines: options.fallbackFlavorLines,
        rng,
      });
    },

    async createVariant(raw) {
      const input = parseResultPresentationVariantInput(raw);
      const [row] = await deps.db
        .insert(resultPresentationVariants)
        .values(input)
        .returning();
      expiresAt = 0;
      const variant = row ? rowToVariant(row) : null;
      if (!variant) throw new Error('result presentation variant could not be stored');
      return variant;
    },

    invalidate() {
      expiresAt = 0;
    },
  };
}
