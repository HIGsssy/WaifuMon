/**
 * The master render key — the identity of one canonical full-size card.
 *
 * Two rules define what belongs in it:
 *
 * - **In:** everything that changes the pixels of the master. Metadata, the
 *   artwork's *content* hash, the kit VERSION, the renderer version.
 * - **Out:** anything about how the bytes were requested or where they happen
 *   to live. Absolute path, mtime, size, and — importantly — the requested
 *   display width. A 512px request is a resize of the same card, not a
 *   different card, so it must not fork the master.
 *
 * Keys are canonicalized (recursively sorted, blanks normalized to absent)
 * before hashing so key order in a caller's object literal can never produce
 * two names for one card.
 */
import { sha256Hex } from './hashMemo';
import { CARD_RENDERER_VERSION } from '../version';
import type { CardRenderInput, SpeciesCardMeta } from '../types';

/**
 * The card-metadata fields the current card face actually draws.
 *
 * `SpeciesCardMeta` still carries `subtitle`, `ability`, `flavorQuote` and
 * `cardNumber` for the content contract, but the production frame draws none of
 * them, so they cannot change a single pixel. Keying on them would fork the
 * cache every time an author edited a line that never appears — this narrows
 * the key to what is genuinely drawn, which today is the artist credit alone.
 *
 * Anything added back to the card face must be added back here, and that is
 * exactly the kind of change `CARD_RENDERER_VERSION` exists to cover.
 */
export interface RenderedCardMeta {
  artist?: string | undefined;
}

/** Hex characters kept from the digest. 64 bits is ample for a filename stem. */
const KEY_LENGTH = 16;

export interface MasterKeyMaterial {
  species: {
    slug: string;
    name: string;
    rarity: string;
    race: string;
    affinity: string;
  };
  card: RenderedCardMeta;
  /** The flavour line drawn in the information panel. */
  description: string;
  /** Whether the ownership badge is composited. */
  owned: boolean;
  level: number;
  appearanceId: string;
  artworkContentHash: string;
  kitVersion: string;
  rendererVersion: string;
}

/** Merges the species' card block with any per-render overrides. */
export function effectiveCardMeta(input: CardRenderInput): SpeciesCardMeta {
  return { ...(input.species.card ?? {}), ...(input.overrides ?? {}) };
}

/** True when this render should composite the ownership badge. */
export function effectiveOwned(input: CardRenderInput): boolean {
  return input.context?.owned === true;
}

/** Level printed on the card. Absent, non-finite, or < 1 all mean level 1. */
export function effectiveLevel(input: CardRenderInput): number {
  const level = input.progress?.level;
  if (typeof level !== 'number' || !Number.isFinite(level)) return 1;
  return Math.max(1, Math.trunc(level));
}

export function buildMasterKeyMaterial(
  input: CardRenderInput,
  artworkContentHash: string,
  kitVersion: string,
): MasterKeyMaterial {
  return {
    species: {
      slug: input.species.slug,
      name: input.species.name,
      rarity: input.species.rarity,
      race: input.species.race,
      affinity: input.species.affinity,
    },
    card: renderedCardMeta(effectiveCardMeta(input)),
    description: input.species.description ?? '',
    owned: effectiveOwned(input),
    level: effectiveLevel(input),
    appearanceId: input.variant.appearanceId,
    artworkContentHash,
    kitVersion,
    rendererVersion: CARD_RENDERER_VERSION,
  };
}

/** Narrows a full metadata block to the fields the card face draws. */
function renderedCardMeta(card: SpeciesCardMeta): RenderedCardMeta {
  return { artist: card.artist };
}

/**
 * Deterministic JSON: object keys sorted, `undefined`/`null`/empty-string
 * dropped so `{subtitle: ''}` and `{}` are the same card, arrays kept in order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length === 0 ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v) ?? null);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const canonical = canonicalize((value as Record<string, unknown>)[key]);
      if (canonical !== undefined) out[key] = canonical;
    }
    return out;
  }
  return undefined;
}

export function computeMasterRenderKey(material: MasterKeyMaterial): string {
  return sha256Hex(canonicalJson(material)).slice(0, KEY_LENGTH);
}
