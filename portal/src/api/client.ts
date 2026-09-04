/**
 * The Portal's single HTTP seam onto the Platform API (plan §11).
 *
 * Responsibilities, all of them cross-cutting so no per-resource helper repeats
 * them:
 *
 *  - Base URL and the `Authorization: Bearer …` header.
 *  - Credentials. Dev builds may attach the shared bearer token; production
 *    sends only same-origin cookies and CSRF for writes.
 *  - Error normalisation: the API's `{ error: { code, message }, requestId }`
 *    envelope becomes a `PortalApiError`, and network/timeout failures become
 *    one too so callers only ever handle a single error type.
 *  - Dev-only request timing into the telemetry ring buffer (§23).
 *  - Remembering the last `x-waifumon-api-version` header and the last decoded
 *    error, both of which the diagnostics page reports.
 */
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';

import { portalEnv } from '@/lib/env';
import { noteRequestCompleted, recordRequest } from './telemetry';
import type { ApiErrorBody, DataEnvelope, Page, PaginatedEnvelope } from './types';

/**
 * How a request failed, as a thing the UI can branch on.
 *
 * `status: 0` used to carry all three of these at once, which meant "the server
 * is down", "the server is slow" and "React aborted this on unmount" rendered
 * the same sentence. On a high-latency link — the Portal is developed across
 * Tailscale — those are three genuinely different problems and only one of them
 * is worth showing a person.
 *
 *   http      the API answered with a 4xx/5xx envelope
 *   timeout   the request was still outstanding when the client gave up
 *   network   no response and no timeout: DNS, refused, proxy down, offline
 *   canceled  *we* aborted it (unmount, key change, StrictMode remount)
 */
export type ApiFailureKind = 'http' | 'timeout' | 'network' | 'canceled';

/**
 * The one error type the Portal's UI handles.
 *
 * `code` is the API's stable machine-readable code (`PLAYER_NOT_FOUND`,
 * `BUDDY_NOT_SET`, …); `message` is its `userMessage`, which the API documents
 * as safe to render. `status` is `0` for transport failures; `kind` says which
 * kind of transport failure it was.
 */
export class PortalApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: ApiFailureKind;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    kind?: ApiFailureKind | undefined;
    requestId?: string | undefined;
    details?: Record<string, unknown> | undefined;
  }) {
    super(init.message);
    this.name = 'PortalApiError';
    this.status = init.status;
    this.code = init.code;
    this.kind = init.kind ?? (init.status === 0 ? 'network' : 'http');
    this.requestId = init.requestId;
    this.details = init.details;
  }

  /**
   * No response arrived and it was not a timeout — the API is unreachable, not
   * refusing (§19). A timeout is deliberately *excluded*: "can't reach the
   * server" is the wrong thing to tell someone whose server answered fine but
   * took too long.
   */
  get isNetworkError(): boolean {
    return this.kind === 'network';
  }

  /** The client gave up waiting. Distinct from unreachable — see `kind`. */
  get isTimeout(): boolean {
    return this.kind === 'timeout';
  }

  /** Transport-level failure of any kind: nothing came back from the API. */
  get isTransportError(): boolean {
    return this.status === 0;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isPortalApiError(error: unknown): error is PortalApiError {
  return error instanceof PortalApiError;
}

/**
 * A request the Portal itself aborted.
 *
 * React Query passes an `AbortSignal` into every `queryFn` and fires it on
 * unmount, on a query-key change, and — twice per mount in dev — under
 * `<StrictMode>`. Axios surfaces that as a rejection with no response, which is
 * indistinguishable from a dead server *unless* you check the code. Treating
 * one as the other is what produced intermittent "Can't reach the Waifumon
 * server" banners on a perfectly healthy API.
 */
export function isCanceledRequest(error: unknown): boolean {
  if (error instanceof PortalApiError) return error.kind === 'canceled';
  if (axios.isCancel(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_CANCELED';
}

const CSRF_COOKIE = 'wm_portal_csrf';
const CSRF_HEADER = 'x-portal-csrf';

function csrfTokenFromCookie(): string | undefined {
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(CSRF_COOKIE.length + 1)) : undefined;
}

// ── Diagnostics-facing observations ─────────────────────────────────────────

let lastApiVersion: string | null = null;
let lastError: PortalApiError | null = null;

export function getLastApiVersion(): string | null {
  return lastApiVersion;
}

export function getLastApiError(): PortalApiError | null {
  return lastError;
}

// ── Error decoding ──────────────────────────────────────────────────────────

function looksLikeErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { code?: unknown }).code === 'string' &&
    typeof (candidate as { message?: unknown }).message === 'string'
  );
}

function decodeError(error: AxiosError): PortalApiError {
  const response = error.response;

  if (!response) {
    if (isCanceledRequest(error)) {
      return new PortalApiError({
        status: 0,
        code: 'CANCELED',
        kind: 'canceled',
        message: 'The request was cancelled.',
      });
    }

    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    return new PortalApiError({
      status: 0,
      code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      kind: timedOut ? 'timeout' : 'network',
      message: timedOut
        ? `The Waifumon server did not answer within ${Math.round(requestTimeoutMs() / 1000)}s.`
        : "Can't reach the Waifumon server.",
    });
  }

  if (looksLikeErrorBody(response.data)) {
    const body = response.data;
    return new PortalApiError({
      status: response.status,
      code: body.error.code,
      message: body.error.message,
      requestId: body.requestId,
      details: body.error.details,
    });
  }

  // A response the API did not shape — a proxy 502, an HTML error page, …
  return new PortalApiError({
    status: response.status,
    code: 'UNEXPECTED_RESPONSE',
    message: 'The Waifumon server returned an unexpected response.',
  });
}

// ── Instance ────────────────────────────────────────────────────────────────

/**
 * How long to wait before giving up on a request.
 *
 * 30 seconds, not the 15 this used to be. The Portal is developed against an
 * API reached over Tailscale, where a request can legitimately spend seconds
 * queued behind artwork on the same HTTP/1.1 origin (see §12 and the dev
 * server's asset route). A timeout shorter than the worst honest latency does
 * not protect anyone — it just converts slowness into a false "server is down".
 *
 * This is a backstop, **not** the fix for that queueing: the real work is the
 * thumbnail pipeline and the cache validators that stop artwork monopolising
 * the connection pool in the first place.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export function requestTimeoutMs(): number {
  const configured = Number(portalEnv.apiTimeoutMs);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

/** A request slower than this is worth a dev console line. Never in production. */
const SLOW_REQUEST_MS = 2_000;

interface TimedConfig extends InternalAxiosRequestConfig {
  /** Stamped on the way out, read on the way back. Dev telemetry only. */
  __startedAt?: number;
}

/** Path without the query string — what the telemetry table shows. */
function pathOf(config: { url?: string | undefined; baseURL?: string | undefined }): string {
  const url = config.url ?? '';
  const base = config.baseURL ?? '';
  const full = url.startsWith('http') ? url : `${base}${url}`;
  return full.split('?')[0] ?? full;
}

export function createApiClient(): AxiosInstance {
  const instance = axios.create({
    baseURL: portalEnv.apiUrl,
    timeout: requestTimeoutMs(),
    headers: { Accept: 'application/json' },
    withCredentials: true,
  });

  instance.interceptors.request.use((config: TimedConfig) => {
    const method = (config.method ?? 'get').toLowerCase();
    if (config.url?.startsWith('/auth/')) {
      config.baseURL = '';
    }

    if (portalEnv.apiToken) {
      config.headers.set('Authorization', `Bearer ${portalEnv.apiToken}`);
    } else if (method !== 'get' && method !== 'head') {
      const csrf = csrfTokenFromCookie();
      if (csrf) config.headers.set(CSRF_HEADER, csrf);
    }
    if (portalEnv.isDev) {
      config.__startedAt = performance.now();
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      const version = response.headers['x-waifumon-api-version'];
      if (typeof version === 'string') lastApiVersion = version;

      const started = (response.config as TimedConfig).__startedAt;
      if (started !== undefined) {
        const durationMs = performance.now() - started;
        const path = pathOf(response.config);
        noteRequestCompleted(path);
        recordRequest({
          method: (response.config.method ?? 'get').toUpperCase(),
          path,
          status: response.status,
          durationMs,
          ...(typeof response.data?.meta?.requestId === 'string'
            ? { requestId: response.data.meta.requestId as string }
            : {}),
        });
        // `import.meta.env.DEV` rather than `portalEnv.isDev`: the former is a
        // compile-time constant, so the whole branch — and its string — leaves
        // the production bundle instead of merely never running.
        if (import.meta.env.DEV && durationMs >= SLOW_REQUEST_MS) {
          console.warn(`[portal slow] ${path} took ${Math.round(durationMs)}ms`);
        }
      }
      return response;
    },
    (error: unknown) => {
      const axiosError = error as AxiosError;
      const decoded = decodeError(axiosError);

      // A cancellation is the Portal's own doing — an unmount, a query-key
      // change, a StrictMode remount. It is not a fault, so it must not become
      // "the last error" on the diagnostics page, must not be logged as one,
      // and must not sit in the request log looking like a failed call.
      if (decoded.kind === 'canceled') return Promise.reject(decoded);

      lastError = decoded;

      const config = axiosError.config as TimedConfig | undefined;
      const started = config?.__startedAt;
      if (started !== undefined && config) {
        // A settled failure still consumed a round trip, so it counts toward
        // duplicate detection. Cancellations returned above and never do.
        noteRequestCompleted(pathOf(config));
        recordRequest({
          method: (config.method ?? 'get').toUpperCase(),
          path: pathOf(config),
          status: decoded.status === 0 ? null : decoded.status,
          durationMs: performance.now() - started,
          errorCode: decoded.code,
          ...(decoded.requestId ? { requestId: decoded.requestId } : {}),
        });
      }

      if (portalEnv.isDev) {
        console.warn('[portal error]', decoded.kind, decoded.code, decoded.message);
      }
      return Promise.reject(decoded);
    },
  );

  return instance;
}

/**
 * The shared instance every resource helper uses.
 *
 * Exported as a mutable binding rather than a hook so helpers stay plain
 * functions; tests swap it via `setApiClient`.
 */
export let apiClient: AxiosInstance = createApiClient();

/** Test seam — replaces the instance the resource helpers close over. */
export function setApiClient(next: AxiosInstance): void {
  apiClient = next;
}

// ── Envelope unwrapping ─────────────────────────────────────────────────────

/** `GET` returning `{ data }` — hands back just the payload. */
export async function getData<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response = await apiClient.get<DataEnvelope<T>>(url, config);
  return response.data.data;
}

/** `GET` returning `{ data, page, pageSize, total }` — flattened to a `Page`. */
export async function getPage<T>(url: string, config?: AxiosRequestConfig): Promise<Page<T>> {
  const response = await apiClient.get<PaginatedEnvelope<T>>(url, config);
  const { data, page, pageSize, total } = response.data;
  return { items: data, page, pageSize, total };
}

/** `POST` returning `{ data }`. Attaches CSRF automatically via the request interceptor. */
export async function postData<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const response = await apiClient.post<DataEnvelope<T>>(url, body ?? {}, config);
  return response.data.data;
}

export async function putData<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const response = await apiClient.put<DataEnvelope<T>>(url, body ?? {}, config);
  return response.data.data;
}

export async function patchData<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const response = await apiClient.patch<DataEnvelope<T>>(url, body ?? {}, config);
  return response.data.data;
}

export async function deleteData<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response = await apiClient.delete<DataEnvelope<T>>(url, config);
  return response.data.data;
}
