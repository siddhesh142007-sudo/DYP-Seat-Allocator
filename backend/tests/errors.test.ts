import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  UnprocessableError,
} from '../src/common/errors.js';

describe('AppError classes', () => {
  it('maps each helper class to the correct status and code', () => {
    const cases: Array<[AppError, number, string]> = [
      [new ValidationError(), 400, 'VALIDATION_ERROR'],
      [new NotFoundError(), 404, 'NOT_FOUND'],
      [new ForbiddenError(), 403, 'FORBIDDEN'],
      [new ConflictError(), 409, 'CONFLICT'],
      [new UnprocessableError(), 422, 'UNPROCESSABLE_ENTITY'],
    ];
    for (const [err, status, code] of cases) {
      expect(err.statusCode).toBe(status);
      expect(err.code).toBe(code);
      expect(err.details).toBeNull();
      expect(err.expose).toBe(true);
    }
  });

  it('carries structured details', () => {
    const err = new UnprocessableError('Allocation Failed', {
      required: 428,
      available: 400,
      additionalSeatsRequired: 28,
    });
    expect(err.details).toEqual({ required: 428, available: 400, additionalSeatsRequired: 28 });
    expect(err.message).toBe('Allocation Failed');
  });

  it('does not expose 5xx messages', () => {
    const err = new AppError(500, 'INTERNAL_ERROR', 'secret internal detail');
    expect(err.expose).toBe(false);
  });
});
