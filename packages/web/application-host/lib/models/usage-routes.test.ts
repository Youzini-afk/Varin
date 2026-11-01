import { EventEmitter } from 'node:events';
import type { Express, RequestHandler } from 'express';
import { expect, test, vi } from 'vitest';
import { registerUsageRoutes } from './usage-routes.js';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ModelsService } from './service.js';

test('usage HTTP uses the native owner, original channel prices and rejects ambiguous aliases', async () => {
  const request = vi.fn(async (_method: string, _params: unknown, _signal?: AbortSignal) => ({ throughCursor: 4, rows: [], threads: [], external: [], recordingStartedAtMs: 1 }));
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: request } as unknown as KernelClient);
  const models = { read: async () => ({ channels: [{ id: 'channel', type: 'openai-compatible', models: [
    { id: 'alias-a', requestModelId: 'wire', pricing: { inputPerMillion: 1, outputPerMillion: 4 } },
    { id: 'alias-b', requestModelId: 'wire', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
  ] }] }) } as unknown as ModelsService;
  let handler: (...args: unknown[]) => Promise<void> = async () => {};
  const auth: RequestHandler = vi.fn();
  const app = { post(path: string, guard: unknown, run: typeof handler) { expect(path).toBe('/api/usage/summary'); expect(guard).toBe(auth); handler = run; } };
  registerUsageRoutes(app as unknown as Express, runtime, models, auth);
  const response = new EventEmitter() as EventEmitter & { json: (value: unknown) => void; status: (value: number) => unknown };
  response.json = vi.fn(); response.status = vi.fn(() => response);
  await handler({ body: { fromMs: 0, toMs: 100, utcOffsetMinutes: 345, days: [{ day: '1970-01-01', fromMs: 0, toMs: 100 }], currentPrices: [{ providerId: 'forged' }] } }, response);
  expect(request).toHaveBeenCalledWith('runtime.usage.summary', expect.objectContaining({ fromMs: 0, toMs: 100, utcOffsetMinutes: 345 }), expect.any(AbortSignal));
  const query = request.mock.calls[0]![1] as { currentPrices: { modelId: string; providerId: string }[] };
  expect(query.currentPrices.map(price => price.modelId)).toEqual(['alias-a', 'alias-b']);
  expect(query.currentPrices.every(price => price.providerId === 'channel')).toBe(true);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ throughCursor: 4 }));
});
