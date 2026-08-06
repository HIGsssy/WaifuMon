/**
 * The Portal's single HTTP seam onto the Platform API (plan §11).
 *
 * Responsibilities, all of them cross-cutting so no per-resource helper repeats
 * them:
 *
 *  - Base URL and the `Authorization: Bearer …` header.
 *  - **Read-only enforcement.** Any non-GET request is rejected before it
 *    leaves the process. v1 is browse-only (§4) and this is what makes success
 *    criterion §24.6 mechanically true rather than a convention.
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
import { recordRequest } from './telemetry';
import type { ApiErrorBody, DataEnvelope, Page, PaginatedEnvelope } from './types';

/**
 * The one error type the Portal's UI handles.
 *
 * `code` is the API's stable machine-readable code (`PLAYER_NOT_FOUND`,
 * `BUDDY_NOT_SET`, …); `message` is its `userMessage`, which the API documents
 * as safe to render. `status` is `0` for transport failures, which is what
 * `isNetworkError` keys off.
 */
export class PortalApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string | undefined;
    details?: Record<string, unknown> | undefined;
  }) {
    super(init.message);
    this.name = 'PortalApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
  }

  /** No response arrived — the API is unreachable, not refusing (§19). */
  get isNetworkError(): boolean {
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

/** Raised when read-only enforcement trips — a Portal bug, never an API state. */
export class ReadOnlyViolationError extends Error {
  constructor(method: string, url: string) {
    super(
      `The Portal is read-only (plan §4): refusing ${method.toUpperCase()} ${url}. ` +
        'Gameplay actions belong in Discord.',
    );
    this.name = 'ReadOnlyViolationError';
  }
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
    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    return new PortalApiError({
      status: 0,
      code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: timedOut
        ? 'The Waifumon server took too long to respond.'
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
    timeout: 15_000,
    headers: { Accept: 'application/json' },
  });

  instance.interceptors.request.use((config: TimedConfig) => {
    const method = (config.method ?? 'get').toLowerCase();
    if (method !== 'get') {
      throw new ReadOnlyViolationError(method, pathOf(config));
    }

    if (portalEnv.apiToken) {
      config.headers.set('Authorization', `Bearer ${portalEnv.apiToken}`);
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
        recordRequest({
          method: (response.config.method ?? 'get').toUpperCase(),
          path: pathOf(response.config),
          status: response.status,
          durationMs: performance.now() - started,
          ...(typeof response.data?.meta?.requestId === 'string'
            ? { requestId: response.data.meta.requestId as string }
            : {}),
        });
      }
      return response;
    },
    (error: unknown) => {
      // A read-only violation never reached the network — surface it as-is so
      // the stack points at the offending call site rather than at Axios.
      if (error instanceof ReadOnlyViolationError) return Promise.reject(error);

      const axiosError = error as AxiosError;
      const decoded = decodeError(axiosError);
      lastError = decoded;

      const config = axiosError.config as TimedConfig | undefined;
      const started = config?.__startedAt;
      if (started !== undefined && config) {
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
        console.warn('[portal error]', decoded.status, decoded.code, decoded.message);
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
