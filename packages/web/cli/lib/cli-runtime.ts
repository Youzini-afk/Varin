import type { Run } from '@varin/protocol';
import { randomUUID } from 'node:crypto';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';
import type { CliOptions } from './cli-types.js';

export const requestVarinApi = async <T = Record<string, unknown>>(
  port: number, endpoint: string, options: CliOptions = {},
): Promise<T> => {
  const { response, body, value } = await requestJson(port, endpoint, options);
  if (response.ok) return value as T;
  const message = typeof body?.error === 'string' ? body.error
    : typeof body?.code === 'string' ? body.code : `Varin API request failed: ${endpoint}`;
  throw new TunnelCliError(message, response.status === 400 || response.status === 404 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR);
};

export const requestThreadApi = <T>(port: number, method: string, body: unknown, options: CliOptions = {}): Promise<T> =>
  requestVarinApi<T>(port, `/api/threads/${method}`, { ...options, timeoutMs: options.timeoutMs ?? 60_000,
    method: 'POST', body: JSON.stringify(body) });

/** Allocate once per command and expose it even when acceptance is uncertain. */
export const commandKey = (options: CliOptions): string => {
  const key = typeof options.key === 'string' && options.key.trim() ? options.key.trim() : randomUUID();
  process.stderr.write(`Request key: ${key} (reuse with --key to retry)\n`);
  return key;
};

/** Wait for this original receipt's Run, never a later branch's idle state. */
export const waitForRun = async (port: number, runId: string, options: CliOptions = {}): Promise<Run> => {
  const timeoutSeconds = Number(options.timeout) > 0 ? Number(options.timeout) : 600;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const run = await requestThreadApi<Run>(port, 'run', { runId }, options);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new TunnelCliError(`Run ${runId} has not reached a terminal state within ${timeoutSeconds}s.`, EXIT_CODE.GENERAL_ERROR);
};
