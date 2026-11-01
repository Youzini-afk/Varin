import type { ModelMetadata } from '@/types';

type LiveProviderModel = Record<string, unknown> & { id?: string; name?: string };

const normalizePositiveInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const firstPositiveInteger = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const normalized = normalizePositiveInteger(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
};

const readLimitObject = (model: LiveProviderModel): Record<string, unknown> => (
  model.limit && typeof model.limit === 'object' && !Array.isArray(model.limit)
    ? model.limit as Record<string, unknown>
    : {}
);

const getLiveContextLimit = (model: LiveProviderModel): number | undefined => {
  const limit = readLimitObject(model);
  return firstPositiveInteger(
    limit.context,
    limit.contextLimit,
    limit.context_limit,
    limit.contextWindow,
    limit.context_window,
    limit.contextLength,
    limit.context_length,
    limit.maxContext,
    limit.max_context,
    limit.maxContextLength,
    limit.max_context_length,
    limit.inputTokenLimit,
    limit.input_token_limit,
    model.context,
    model.contextLimit,
    model.context_limit,
    model.contextWindow,
    model.context_window,
    model.contextLength,
    model.context_length,
    model.maxContext,
    model.max_context,
    model.maxContextLength,
    model.max_context_length,
    model.inputTokenLimit,
    model.input_token_limit,
  );
};

const getLiveOutputLimit = (model: LiveProviderModel): number | undefined => {
  const limit = readLimitObject(model);
  return firstPositiveInteger(
    limit.output,
    limit.outputLimit,
    limit.output_limit,
    limit.outputTokenLimit,
    limit.output_token_limit,
    limit.maxOutput,
    limit.max_output,
    limit.maxOutputTokens,
    limit.max_output_tokens,
    model.output,
    model.outputLimit,
    model.output_limit,
    model.outputTokenLimit,
    model.output_token_limit,
    model.maxOutput,
    model.max_output,
    model.maxOutputTokens,
    model.max_output_tokens,
  );
};

export const mergeModelMetadataWithLiveModel = (
  providerId: string,
  model: LiveProviderModel,
  metadata?: ModelMetadata,
): ModelMetadata | undefined => {
  const liveContextLimit = getLiveContextLimit(model);
  const liveOutputLimit = getLiveOutputLimit(model);
  const contextLimit = liveContextLimit ?? metadata?.limit?.context;
  const outputLimit = liveOutputLimit ?? metadata?.limit?.output;
  const pricing = model.pricing && typeof model.pricing === 'object' ? model.pricing as Record<string, unknown> : undefined;
  const price = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const cost = pricing ? {
    input: price(pricing.inputPerMillion), output: price(pricing.outputPerMillion),
    cache_read: price(pricing.cacheReadPerMillion), cache_write: price(pricing.cacheWritePerMillion),
  } : metadata?.cost;

  if (contextLimit === undefined && outputLimit === undefined && !cost) return metadata;

  return {
    ...(metadata ?? {
      id: typeof model.id === 'string' ? model.id : '',
      providerId,
      name: typeof model.name === 'string' ? model.name : undefined,
    }),
    ...(cost ? { cost } : {}),
    limit: {
      ...metadata?.limit,
      ...(contextLimit !== undefined ? { context: contextLimit } : {}),
      ...(outputLimit !== undefined ? { output: outputLimit } : {}),
    },
  };
};
