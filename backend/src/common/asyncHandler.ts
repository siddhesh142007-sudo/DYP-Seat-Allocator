import type { RequestHandler } from 'express';

/**
 * Wraps an async route handler so rejections reach the central error
 * handler (Express 4 does not catch async errors on its own).
 */
export const asyncHandler =
  (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };
