/**
 * Success response envelope (plan §8.3).
 *
 *   { "data": … , "meta"?: { … } }
 *   { "data": [ … ], "page": 1, "pageSize": 20, "total": 42, "meta"?: { … } }
 *
 * `meta` is a forward-compatible extension slot: clients must tolerate it
 * being absent, present, or carrying fields they do not know. v1 populates
 * `requestId` today (Further Considerations #3) so correlation works from the
 * first client, and reserves `apiVersion` / `generatedAt` for later.
 *
 * The `*Schema` helpers exist so a route declares its payload shape once and
 * gets both the runtime serializer and the OpenAPI document from it.
 */
import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

export interface ResponseMeta {
  requestId?: string;
  apiVersion?: string;
  generatedAt?: string;
}

export interface DataEnvelope<T> {
  data: T;
  meta?: ResponseMeta;
}

export interface PaginatedEnvelope<T> extends DataEnvelope<T[]> {
  page: number;
  pageSize: number;
  total: number;
}

export const metaSchema = z
  .object({
    requestId: z.string().optional(),
    apiVersion: z.string().optional(),
    generatedAt: z.string().optional(),
  })
  .describe('Forward-compatible metadata. Tolerate absent and unknown fields.');

export function dataSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({ data: payload, meta: metaSchema.optional() });
}

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    total: z.number().int().min(0),
    meta: metaSchema.optional(),
  });
}

export function envelope<T>(data: T, meta?: ResponseMeta): DataEnvelope<T> {
  return meta ? { data, meta } : { data };
}

export function paginated<T>(
  data: T[],
  page: number,
  pageSize: number,
  total: number,
  meta?: ResponseMeta,
): PaginatedEnvelope<T> {
  const base: PaginatedEnvelope<T> = { data, page, pageSize, total };
  return meta ? { ...base, meta } : base;
}

/** The `meta` v1 routes attach — just the correlation id for now. */
export function requestMeta(requestId: string): ResponseMeta {
  return { requestId };
}

/**
 * Route-level shorthand: wrap a payload and stamp the request's correlation id
 * into `meta`. Every v1 handler returns through `ok` or `okPage` so the
 * envelope can never drift endpoint to endpoint.
 */
export function ok<T>(req: { id: string | number }, data: T): DataEnvelope<T> {
  return envelope(data, requestMeta(String(req.id)));
}

export function okPage<T>(
  req: { id: string | number },
  data: T[],
  page: number,
  pageSize: number,
  total: number,
): PaginatedEnvelope<T> {
  return paginated(data, page, pageSize, total, requestMeta(String(req.id)));
}
