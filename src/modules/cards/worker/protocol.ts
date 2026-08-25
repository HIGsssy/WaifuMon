/**
 * The main thread ↔ render worker message contract.
 *
 * Deliberately tiny and deliberately plain data. Nothing that crosses this
 * boundary may be a service, a logger, a sharp pipeline, a resvg handle or a
 * loader — those are all either non-cloneable or meaningless in another
 * thread. What crosses is a `CardRenderInput` (already plain JSON by
 * construction, because it is what the disk-cache key is computed from) plus
 * the asset root as a string.
 *
 * **The worker loads its own assets.** The alternative — shipping the frame,
 * three icons, the badge and five fonts across the boundary on every job — is
 * several megabytes copied per card, for files that never change. Instead each
 * worker builds its own `CardAssetLoader`, which memoizes the kit after the
 * first render; the per-job payload stays a few hundred bytes and the only
 * large thing that crosses is the finished master coming back.
 *
 * ## Errors
 *
 * A structured clone of an `Error` keeps `message` and `stack` but loses the
 * prototype, so a `CardAssetMissingError` would arrive as a plain `Error` and
 * every `instanceof` upstack would quietly stop matching — including the ones
 * the HTTP layer uses to choose between 404 and 500. So errors are serialized
 * by `code` and rebuilt on the far side into the same class they left as.
 */
import {
  CardArtworkMissingError,
  CardAssetMissingError,
  CardOutputWidthError,
  CardRenderError,
  CardTemplateError,
} from '../errors';
import type { CardRenderInput } from '../types';

/** One master render, addressed by an id the pool generates. */
export interface CardRenderJob {
  id: number;
  /** Kit root; the worker memoizes one loader per distinct root. */
  assetRoot: string;
  input: CardRenderInput;
}

export interface SerializedCardError {
  /** Constructor name, kept for unknown errors so the message still reads right. */
  name: string;
  /** `AppError.code`, or `null` for something that was not an `AppError`. */
  code: string | null;
  message: string;
  userMessage: string | null;
  stack: string | undefined;
  /** `CardAssetMissingError.assetPath` / `CardArtworkMissingError.artworkPath`. */
  path: string | null;
}

export interface CardRenderOk {
  id: number;
  ok: true;
  /** The encoded master. Sent as a transfer, so the worker's copy is detached. */
  bytes: Uint8Array;
}

export interface CardRenderFailed {
  id: number;
  ok: false;
  error: SerializedCardError;
}

export type CardRenderResponse = CardRenderOk | CardRenderFailed;

function readString(err: object, key: string): string | null {
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export function serializeCardError(err: unknown): SerializedCardError {
  if (err instanceof Error) {
    return {
      name: err.name,
      code: readString(err, 'code'),
      message: err.message,
      userMessage: readString(err, 'userMessage'),
      stack: err.stack,
      path: readString(err, 'assetPath') ?? readString(err, 'artworkPath'),
    };
  }
  return {
    name: 'Error',
    code: null,
    message: String(err),
    userMessage: null,
    stack: undefined,
    path: null,
  };
}

/**
 * Rebuilds the error the worker threw.
 *
 * The typed constructors compose their own messages from their arguments, so
 * each is built with the fields it carries and then has the original message
 * reinstated — that way `instanceof` matches *and* the text is the one the
 * worker actually produced, rather than a reconstruction that could drift from
 * it.
 */
export function reviveCardError(s: SerializedCardError): Error {
  const err = instantiate(s);
  err.message = s.message;
  if (s.stack !== undefined) err.stack = s.stack;
  return err;
}

function instantiate(s: SerializedCardError): Error {
  switch (s.code) {
    case 'CARD_ASSET_MISSING':
      return new CardAssetMissingError(s.path ?? '', '');
    case 'CARD_ARTWORK_MISSING':
      return new CardArtworkMissingError(s.path ?? '', '', '');
    case 'CARD_TEMPLATE_INVALID':
      return new CardTemplateError(s.message);
    case 'CARD_OUTPUT_WIDTH_INVALID':
      return new CardOutputWidthError(0, 0, 0);
    default:
      break;
  }

  // Some other `AppError` from deeper down — keep its code and user-facing
  // text, which is the part callers branch on, under the card error family.
  if (s.code !== null) {
    return new CardRenderError(s.code, s.message, s.userMessage ?? undefined);
  }

  // Genuinely unexpected (a TypeError, an ENOENT that escaped a typed path).
  // Reported as-is rather than dressed up as a card error it is not.
  const plain = new Error(s.message);
  plain.name = s.name;
  return plain;
}
