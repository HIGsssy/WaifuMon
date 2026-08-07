/**
 * The single place `import.meta.env` is read.
 *
 * Everything else in the Portal imports `portalEnv`, which means the set of
 * environment inputs is greppable in one file and the diagnostics page (§23)
 * can enumerate them without duplicating the list.
 *
 * Nothing here throws. A missing `VITE_DEFAULT_PLAYER_ID` is a normal state
 * that resolves to the `/select-player` screen (§8.11), not a crash (§19).
 */

/** Injected by Vite's `define` — see vite.config.ts. */
declare const __APP_VERSION__: string;

function str(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface PortalEnv {
  /** Base URL prefixed onto every API request. `/api` in dev (proxied). */
  apiUrl: string;
  /** Shared bearer token. Dev-only, and present in the bundle — see §26. */
  apiToken: string | undefined;
  /** Raw env value for the acting player, before resolution. */
  defaultPlayerId: string | undefined;
  /** Presentation-only Discord identifiers, when the operator supplies them. */
  defaultDiscordGuildId: string | undefined;
  defaultDiscordUserId: string | undefined;
  /** Ordered image-provider ids for the resolver chain (§12). */
  imageProviders: string[] | undefined;
  /**
   * CDN origin for the (disabled by default) `platformCdn` provider. Set it
   * *and* list `platformCdn` in `VITE_IMAGE_PROVIDERS` to migrate artwork off
   * local dev assets — no API change is involved.
   */
  assetCdnUrl: string | undefined;
  /** Vite mode + build identity, surfaced on the diagnostics page. */
  mode: string;
  isDev: boolean;
  appVersion: string;
}

const raw = import.meta.env;

export const portalEnv: PortalEnv = {
  apiUrl: str(raw.VITE_PLATFORM_API_URL) ?? '/api',
  apiToken: str(raw.VITE_PLATFORM_API_TOKEN),
  defaultPlayerId: str(raw.VITE_DEFAULT_PLAYER_ID),
  defaultDiscordGuildId: str(raw.VITE_DEFAULT_DISCORD_GUILD_ID),
  defaultDiscordUserId: str(raw.VITE_DEFAULT_DISCORD_USER_ID),
  imageProviders: str(raw.VITE_IMAGE_PROVIDERS)
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  assetCdnUrl: str(raw.VITE_ASSET_CDN_URL),
  mode: raw.MODE,
  isDev: raw.DEV,
  appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev',
};

/**
 * `VITE_*` values that influence Portal behaviour, for the diagnostics page.
 * Secrets are reported as presence only — the token is never rendered (§23).
 */
export function describeEnv(): Array<{ key: string; value: string; secret?: boolean }> {
  return [
    { key: 'MODE', value: portalEnv.mode },
    { key: 'VITE_PLATFORM_API_URL', value: portalEnv.apiUrl },
    {
      key: 'VITE_PLATFORM_API_TOKEN',
      value: portalEnv.apiToken ? '••••••••' : '(unset)',
      secret: true,
    },
    { key: 'VITE_DEFAULT_PLAYER_ID', value: portalEnv.defaultPlayerId ?? '(unset)' },
    { key: 'VITE_DEFAULT_DISCORD_GUILD_ID', value: portalEnv.defaultDiscordGuildId ?? '(unset)' },
    { key: 'VITE_DEFAULT_DISCORD_USER_ID', value: portalEnv.defaultDiscordUserId ?? '(unset)' },
    { key: 'VITE_IMAGE_PROVIDERS', value: portalEnv.imageProviders?.join(',') ?? '(default)' },
    { key: 'VITE_ASSET_CDN_URL', value: portalEnv.assetCdnUrl ?? '(unset)' },
  ];
}
