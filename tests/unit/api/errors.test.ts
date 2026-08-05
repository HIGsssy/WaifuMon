/**
 * The error contract (plan §8.2, §8.3). Two properties matter here: every
 * `AppError` the service layer can throw has a deliberate status, and a 500
 * never leaks internals to the caller.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiNotFoundError,
  ApiValidationError,
  MAPPED_ERROR_CODES,
  UnauthorizedError,
  mapAppErrorToStatus,
  toErrorBody,
} from '../../../src/api/errors';
import * as errors from '../../../src/shared/errors';
import { AppError } from '../../../src/shared/errors';

describe('mapAppErrorToStatus', () => {
  it('maps unknown resources to 404', () => {
    expect(mapAppErrorToStatus(new errors.PlayerNotFoundError(1))).toBe(404);
    expect(mapAppErrorToStatus(new errors.ItemNotFoundError('x'))).toBe(404);
    expect(mapAppErrorToStatus(new errors.EncounterNotFoundError())).toBe(404);
    expect(mapAppErrorToStatus(new errors.WaifuNotOwnedError(1))).toBe(404);
  });

  it('maps state conflicts to 409', () => {
    expect(mapAppErrorToStatus(new errors.ActiveEncounterError(7))).toBe(409);
    expect(mapAppErrorToStatus(new errors.AlreadyClaimedError(new Date()))).toBe(409);
    expect(mapAppErrorToStatus(new errors.EncounterExpiredError())).toBe(409);
    expect(mapAppErrorToStatus(new errors.WaifuIsBuddyError())).toBe(409);
  });

  it('maps refused business rules to 422', () => {
    expect(mapAppErrorToStatus(new errors.InsufficientEnergyError())).toBe(422);
    expect(mapAppErrorToStatus(new errors.InsufficientFundsError(10, 2))).toBe(422);
    expect(mapAppErrorToStatus(new errors.InventoryCapacityError(20))).toBe(422);
  });

  it('maps request-level and infrastructure errors', () => {
    expect(mapAppErrorToStatus(new UnauthorizedError())).toBe(401);
    expect(mapAppErrorToStatus(new ApiValidationError('bad'))).toBe(400);
    expect(mapAppErrorToStatus(new ApiNotFoundError('no route'))).toBe(404);
    expect(mapAppErrorToStatus(new errors.DatabaseUnavailableError('down'))).toBe(503);
    expect(mapAppErrorToStatus(new errors.ContentValidationError('bad'))).toBe(500);
  });

  it('falls back to 500 for a code it has not classified', () => {
    expect(mapAppErrorToStatus(new AppError('BRAND_NEW_CODE', 'internal detail'))).toBe(500);
  });

  /**
   * The §12 Phase 4 consistency sweep says an unmapped code is a defect. This
   * catches it the moment a new AppError subclass lands, rather than in
   * production as a surprise 500.
   */
  it('classifies every AppError subclass exported by the service layer', () => {
    const unmapped: string[] = [];
    for (const [name, exported] of Object.entries(errors)) {
      if (typeof exported !== 'function' || !(exported.prototype instanceof AppError)) continue;
      // Throwaway arguments: every constructor only interpolates its inputs
      // into strings, and a Date also satisfies the two that call getTime().
      const arg = new Date(0);
      const instance = new (exported as new (...args: never[]) => AppError)(
        ...([arg, arg, arg] as unknown as never[]),
      );
      if (!MAPPED_ERROR_CODES.includes(instance.code)) unmapped.push(`${name} (${instance.code})`);
    }
    expect(unmapped).toEqual([]);
  });
});

describe('toErrorBody', () => {
  it('renders the user-facing message, never the internal one', () => {
    const err = new errors.InsufficientFundsError(100, 5);
    const body = toErrorBody(err, 422, 'req-1');
    expect(body).toEqual({
      error: {
        code: 'INSUFFICIENT_FUNDS',
        message: 'You need 100 WaifuBux but only have 5.',
      },
      requestId: 'req-1',
    });
    expect(JSON.stringify(body)).not.toContain(err.message);
  });

  it('carries details when supplied', () => {
    const body = toErrorBody(new ApiValidationError('bad'), 400, 'req-2', {
      issues: [{ path: '/body/quantity', message: 'Expected number' }],
    });
    expect(body.error.details).toEqual({
      issues: [{ path: '/body/quantity', message: 'Expected number' }],
    });
  });

  it('flattens anything 500 to INTERNAL_ERROR and drops the details', () => {
    const body = toErrorBody(new AppError('SECRET_CODE', 'connection string leaked'), 500, 'req-3', {
      table: 'players',
    });
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal error.' },
      requestId: 'req-3',
    });
  });
});
