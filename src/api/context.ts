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
import type { LoadedContent } from '../modules/content/schemas';
import type { IdentityResolver } from './identity';

export interface ApiContext {
  services: AppServices;
  /** Read at call time, never cached — see the note above. */
  getContent: () => LoadedContent;
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
