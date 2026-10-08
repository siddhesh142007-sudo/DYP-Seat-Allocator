import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../logger.js';
import { AppError, NotFoundError, type ErrorPayload } from '../errors.js';

/**
 * Request-id + structured access logging in one middleware.
 * Propagates an incoming X-Request-Id or generates one, echoes it on the
 * response, and logs every request with pino.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  autoLogging: {
    ignore: (req) => req.url === '/api/v1/health',
  },
  serializers: {
    req(req) {
      return { method: req.method, url: req.url, id: req.id };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

/** 404 fallback for unmatched routes. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
};

function toPayload(err: AppError): ErrorPayload {
  return {
    error: {
      code: err.code,
      message: err.expose ? err.message : 'Internal server error',
      details: err.expose ? err.details : null,
    },
  };
}

/** Central error handler: always responds { error: { code, message, details } }. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const reqId = res.getHeader('X-Request-Id');

  if (res.headersSent) {
    logger.error({ err, reqId }, 'error after headers sent');
    res.end();
    return;
  }

  if (err instanceof ZodError) {
    const payload: ErrorPayload = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      },
    };
    logger.warn({ reqId, issues: payload.error.details }, 'validation error');
    res.status(400).json(payload);
    return;
  }

  if (err instanceof AppError) {
    const payload = toPayload(err);
    if (err.statusCode >= 500) {
      logger.error({ reqId, err, code: err.code }, 'server error');
    } else {
      logger.info({ reqId, code: err.code, message: err.message }, 'request error');
    }
    res.status(err.statusCode).json(payload);
    return;
  }

  // Body-parser JSON syntax error
  const type = (err as { type?: string }).type;
  if (type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', details: null },
    } satisfies ErrorPayload);
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', details: null },
    } satisfies ErrorPayload);
    return;
  }

  logger.error({ reqId, err }, 'unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null },
  } satisfies ErrorPayload);
};
