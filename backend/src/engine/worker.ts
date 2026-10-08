import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { generateSeating } from './index.js';
import type { EngineInput, EngineResult, FailureCode } from './types.js';

function failure(code: FailureCode, message: string): EngineResult {
  return { ok: false, failure: { code, message } };
}

/**
 * The worker entry point: when this module loads inside a worker thread it runs
 * the engine and posts the result back. Running on a thread keeps the Express
 * event loop responsive during generation (guide §7).
 */
if (!isMainThread && parentPort) {
  const port = parentPort;
  const input = workerData;
  port.postMessage(generateSeating(input));
}

/**
 * Run the engine off the main thread with a hard timeout.
 *
 * - Compiled builds (`dist/`) spawn a real `worker_threads` Worker executing
 *   `worker.js`; TS sources (`src/`, tests) spawn it with the `tsx` loader.
 * - If the thread cannot start or crashes, the input is processed inline so a
 *   transient threading problem can never produce a fake failure.
 * - Exceeding `timeBudgetMs` (plus a small grace period) returns a structured
 *   TIMEOUT failure rather than hanging the request.
 */
export function runInWorker(input: EngineInput): Promise<EngineResult> {
  if (!isMainThread) return Promise.resolve(generateSeating(input));

  const fromSource = import.meta.url.endsWith('.ts');
  const entry = new URL(fromSource ? './worker.ts' : './worker.js', import.meta.url);
  const timeoutMs = Math.max(1000, input.config.timeBudgetMs) + 5000;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: EngineResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let worker: Worker;
    try {
      worker = new Worker(entry, {
        workerData: input,
        ...(fromSource ? { execArgv: ['--import', 'tsx'] } : {}),
      });
    } catch {
      settle(generateSeating(input));
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      settle(
        failure(
          'TIMEOUT',
          `Seating generation exceeded its time budget of ${input.config.timeBudgetMs} ms.`,
        ),
      );
    }, timeoutMs);

    worker.once('message', (result: EngineResult) => {
      clearTimeout(timer);
      void worker.terminate();
      settle(result);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      settle(generateSeating(input));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      if (!settled) settle(generateSeating(input));
    });
  });
}
