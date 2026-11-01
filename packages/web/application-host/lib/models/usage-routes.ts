import type { Express, RequestHandler } from 'express';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ModelsService } from './service.js';
import type { UsageSummaryParams } from '../kernel/protocol.generated.js';
import { frozenModelPricing } from './pricing.js';

export function registerUsageRoutes(app: Express, runtime: AgentRuntimeClient, models: ModelsService, requireAuth: RequestHandler) {
  app.post('/api/usage/summary', requireAuth, async (request, response) => {
    const abort = new AbortController();
    const disconnect = () => { if (!response.writableEnded) abort.abort(); };
    response.once('close', disconnect);
    try {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Usage range is required'), { statusCode: 400 });
      const catalog = await models.read();
      // Fallback prices estimate formerly unpriced receipts. Original snapshots stay authoritative.
      const candidates = new Map<string, { providerId: string; modelId: string; pricing: ReturnType<typeof frozenModelPricing> }[]>();
      for (const channel of catalog.channels) for (const model of channel.models) if (model.pricing) {
        const pricing = frozenModelPricing(channel, model);
        for (const modelId of new Set([model.id, model.requestModelId ?? model.id])) {
          const key = JSON.stringify([channel.id, modelId]);
          candidates.set(key, [...candidates.get(key) ?? [], { providerId: channel.id, modelId, pricing }]);
        }
      }
      const currentPrices = [...candidates.values()].filter(items => new Set(items.map(item => item.pricing.version)).size === 1).map(items => items[0]!);
      const query: UsageSummaryParams = { fromMs: body.fromMs, toMs: body.toMs, utcOffsetMinutes: body.utcOffsetMinutes, days: body.days, currentPrices };
      response.json(await runtime.usageSummary(query, abort.signal));
    } catch (error) {
      if (!abort.signal.aborted) {
        const detail = error && typeof error === 'object' ? error as { code?: unknown; statusCode?: unknown } : {};
        response.status(typeof detail.statusCode === 'number' ? detail.statusCode : 500).json({ code: typeof detail.code === 'string' ? detail.code : 'usage-unavailable', error: error instanceof Error ? error.message : String(error) });
      }
    } finally { response.off('close', disconnect); }
  });
}
