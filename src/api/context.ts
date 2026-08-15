/**
 * What the Platform API needs from the host process (plan §5).
 *
 * Deliberately narrow: the service registry and a *getter* for the content
 * snapshot. The getter matters — the admin panel republishes `ctx.content` on
 * "Save + Reload", so capturing the snapshot once at wiring time would serve
 * stale species/items until the next restart. Every content read calls this.
 *
 * `AppServices` is the process-wide service registry. It is declared in
 * `src/discord/types.ts` for historical reasons; this is a type-only import
 * with no runtime coupling to Discord, and the API never touches anything
 * Discord-specific on it.
 */
import type { AppServices } from '../discord/types';
import type { CardRenderer } from '../modules/cards';
import type { LoadedContent } from '../modules/content/schemas';
import type { IdentityResolver } from './identity';

export interface ApiContext {
  services: AppServices;
  /** Read at call time, never cached — see the note above. */
  getContent: () => LoadedContent;
  /**
   * Assets root, for the one surface that serves bytes rather than JSON: the
   * card routes resolve artwork through the shared appearance resolver, which
   * needs to know where artwork lives.
   *
   * Optional because every other route is path-free by design — the API never
   * leaks a filesystem location, and a context without this simply cannot
   * register cards.
   */
  assetsDir?: string | undefined;
  /**
   * Card renderer instance. Omitted in production, where the process-wide
   * renderer over the shipped kit is correct; injected by tests so a suite can
   * point at a temp cache root instead of writing into `assets/.card-cache/`.
   */
  cardRenderer?: CardRenderer | undefined;
  /**
   * Optional. Resolves a Discord snowflake to a display name and avatar for
   * presentation only (`src/api/identity.ts`). Injected by the host, which owns
   * the gateway client — the same arrangement as `ReadinessProbes`, and for the
   * same reason: this layer holds no Discord types.
   *
   * Omitted in tests and in any process without a Discord client, in which case
   * every player resource reports `identity: null`. No endpoint's behaviour
   * depends on it.
   */
  resolveIdentity?: IdentityResolver;
}
