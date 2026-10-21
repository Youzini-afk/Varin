import { setTimeout as sleep } from 'node:timers/promises';
import { parseModelRetrySettings, type ModelRetryDecision, type ModelRetryFailure, type ModelRetrySettings } from '@varin/protocol';
import type { KernelClient } from '../kernel/kernel-client.js';

export async function evaluateRetry(kernel: Pick<KernelClient, 'agentRuntimeRequest'>, settings: unknown, failure: ModelRetryFailure, retriesUsed = 0) {
  return kernel.agentRuntimeRequest<ModelRetryDecision, 'runtime.retry.evaluate'>('runtime.retry.evaluate', {
    settings: parseModelRetrySettings(settings), failure, retriesUsed,
  });
}
export function responseRetryFailure(response: Response, body: unknown): ModelRetryFailure {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const error = record(body) && record(body.error) ? body.error : record(body) ? body : {};
  const afterMs = response.headers.get('retry-after-ms'), after = response.headers.get('retry-after');
  const delay = afterMs !== null ? Number(afterMs) : after === null ? NaN : /^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
  const should = response.headers.get('x-should-retry');
  return { status: response.status, code: typeof error.code === 'string' ? error.code : `http_${response.status}`,
    message: typeof error.message === 'string' ? error.message : typeof (record(body) && body.error) === 'string' ? String((body as Record<string, unknown>).error) : '',
    ...(Number.isFinite(delay) ? { retryAfterMs: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(delay))) } : {}),
    ...(should === 'true' || should === 'false' ? { shouldRetry: should === 'true' } : {}) };
}
export async function waitForRetry(kernel: Pick<KernelClient, 'agentRuntimeRequest'>, settings: ModelRetrySettings, failure: ModelRetryFailure, retriesUsed: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const decision = await evaluateRetry(kernel, settings, failure, retriesUsed);
  if (!decision.retry) return false;
  // Node timers are signed 32-bit; chunk long server delays rather than overflowing to 1ms.
  let remaining = decision.delayMs;
  while (remaining > 0) {
    const part = Math.min(remaining, 2_147_483_647);
    await sleep(part, undefined, { signal });
    remaining -= part;
  }
  signal.throwIfAborted();
  return true;
}
