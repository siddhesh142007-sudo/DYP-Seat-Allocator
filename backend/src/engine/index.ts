import type { EngineInput, EngineResult } from './types.js';
import { feasibility } from './feasibility.js';
import { allocate } from './allocate.js';
import { improve } from './improve.js';
import { validate } from './validate.js';

/**
 * Pipeline (guide §4.1): feasibility -> allocate -> improve -> validate.
 * If the independent validator reports INVALID the generation fails outright —
 * a plan is never returned, never mind saved.
 */
export function generateSeating(input: EngineInput): EngineResult {
  const t0 = Date.now();
  const feas = feasibility(input);
  if (feas) return feas;

  const a0 = Date.now();
  let res = allocate(input);
  const allocateMs = Date.now() - a0;
  if (!res.ok) return res;

  const i0 = Date.now();
  res = improve(input, res);
  const improveMs = Date.now() - i0;
  if (!res.ok) return res;

  const v0 = Date.now();
  const report = validate(input, res.assignments);
  const validateMs = Date.now() - v0;

  if (report.status === 'INVALID') {
    return {
      ok: false,
      failure: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed after generation.',
        details: { report },
      },
    };
  }

  const totalMs = Date.now() - t0;
  return {
    ...res,
    stats: { ...res.stats, timeMs: totalMs },
    timing: { totalMs, allocateMs, improveMs, validateMs },
  };
}
