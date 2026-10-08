import type { EngineInput, EngineResult } from './types.js';
import { feasibility } from './feasibility.js';
import { allocate, allocateStrictRollOrder } from './allocate.js';
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
  const strictRollOrder = input.config.strictRollOrder === true;
  // Strict roll order must stay ordered, so the shuffle-and-improve phases are
  // bypassed entirely rather than run and then undone.
  let res = strictRollOrder ? allocateStrictRollOrder(input) : allocate(input);
  const allocateMs = Date.now() - a0;
  if (!res.ok) return res;

  const i0 = Date.now();
  if (!strictRollOrder) {
    res = improve(input, res);
    if (!res.ok) return res;
  }
  const improveMs = Date.now() - i0;

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
