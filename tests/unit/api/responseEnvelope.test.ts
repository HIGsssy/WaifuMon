/**
 * Success envelope (plan §8.3). `meta` is optional on the wire — it must be
 * absent rather than `undefined` so the serialized JSON stays clean.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  dataSchema,
  envelope,
  paginated,
  paginatedSchema,
  requestMeta,
} from '../../../src/api/plugins/responseEnvelope';

describe('envelope', () => {
  it('wraps a payload under data with no meta key by default', () => {
    const body = envelope({ id: 1 });
    expect(body).toEqual({ data: { id: 1 } });
    expect(JSON.stringify(body)).toBe('{"data":{"id":1}}');
  });

  it('attaches meta when supplied', () => {
    expect(envelope({ id: 1 }, requestMeta('req-1'))).toEqual({
      data: { id: 1 },
      meta: { requestId: 'req-1' },
    });
  });
});

describe('paginated', () => {
  it('puts pagination beside data, not inside meta', () => {
    expect(paginated([{ id: 1 }], 1, 20, 42)).toEqual({
      data: [{ id: 1 }],
      page: 1,
      pageSize: 20,
      total: 42,
    });
  });
});

describe('schemas', () => {
  it('accepts a response with and without meta', () => {
    const schema = dataSchema(z.object({ id: z.number() }));
    expect(schema.safeParse({ data: { id: 1 } }).success).toBe(true);
    expect(schema.safeParse({ data: { id: 1 }, meta: { requestId: 'r' } }).success).toBe(true);
  });

  it('caps pageSize at 100', () => {
    const schema = paginatedSchema(z.object({ id: z.number() }));
    const page = { data: [], page: 1, total: 0 };
    expect(schema.safeParse({ ...page, pageSize: 100 }).success).toBe(true);
    expect(schema.safeParse({ ...page, pageSize: 101 }).success).toBe(false);
  });
});
