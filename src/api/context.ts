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

export interface ApiContext {
  services: AppServices;
  /** Read at call time, never cached — see the note above. */
  getContent: () => LoadedContent;
}
