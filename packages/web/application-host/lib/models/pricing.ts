import { createHash } from 'node:crypto';
import type { ChannelModel, ModelChannel, ModelPricing } from '@varin/application-client';

const fields = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'reasoningPerMillion'] as const;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const price = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validModelPricing(value: unknown): value is ModelPricing {
  if (!record(value) || Object.keys(value).some(key => ![...fields, 'longContext', 'contextTiers'].includes(key))) return false;
  if (fields.some(key => value[key] !== undefined && !price(value[key]))) return false;
  if (value.contextTiers !== undefined && !Array.isArray(value.contextTiers)) return false;
  const tiers = [...(value.longContext === undefined ? [] : [value.longContext]), ...(Array.isArray(value.contextTiers) ? value.contextTiers : [])];
  const thresholds = new Set<number>();
  for (const tier of tiers) {
    if (!record(tier) || !Number.isSafeInteger(tier.aboveInputTokens) || Number(tier.aboveInputTokens) <= 0
      || Object.keys(tier).some(key => !['aboveInputTokens', ...fields.slice(0, 4)].includes(key))
      || fields.slice(0, 4).some(key => tier[key] !== undefined && !price(tier[key]))) return false;
    if (thresholds.has(Number(tier.aboveInputTokens))) return false;
    thresholds.add(Number(tier.aboveInputTokens));
  }
  return true;
}
/** Read only explicit directory prices; absent prices remain absent. */
export function directoryPricing(value: unknown): ModelPricing | undefined {
  if (!record(value)) return;
  const read = (cost: Record<string, unknown>) => Object.fromEntries([
    ['inputPerMillion', cost.input], ['outputPerMillion', cost.output], ['cacheReadPerMillion', cost.cache_read],
    ['cacheWritePerMillion', cost.cache_write], ['reasoningPerMillion', cost.reasoning],
  ].filter(([, value]) => price(value))) as ModelPricing;
  const result = read(value);
  const tiers = Array.isArray(value.tiers) ? value.tiers.filter(record) : [];
  const context = tiers.filter(tier => record(tier.tier) && tier.tier.type === 'context' && Number.isSafeInteger(tier.tier.size) && Number(tier.tier.size) > 0);
  const contexts = context.map(tier => {
    const { reasoningPerMillion: _reasoning, ...cost } = read(tier);
    return { aboveInputTokens: Number((tier.tier as Record<string, unknown>).size), ...cost };
  }).sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
  if (contexts.length > 1) result.contextTiers = contexts;
  else if (contexts[0]) result.longContext = contexts[0];
  else if (record(value.context_over_200k)) {
    const { reasoningPerMillion: _reasoning, ...cost } = read(value.context_over_200k);
    result.longContext = { aboveInputTokens: 200_000, ...cost };
  }
  return Object.keys(result).length ? result : undefined;
}
export function frozenModelPricing(channel: ModelChannel, model: ChannelModel) {
  const billing = model.billing ?? (['local', 'ollama', 'lmstudio', 'lm-studio'].includes(channel.type) ? 'local'
    : ['openai-codex', 'github-copilot', 'kimi-coding', 'zai', 'zai-coding-cn', 'qwen-token-plan', 'qwen-token-plan-cn', 'alibaba-coding-plan', 'alibaba-coding-plan-cn'].includes(channel.type) ? 'subscription' : 'metered');
  const source = model.catalog?.overrides.includes('pricing') || !model.catalog && model.pricing ? 'custom' as const : 'directory' as const;
  const content = { currency: 'USD' as const, billing, source, ...model.pricing };
  return { ...content, version: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}
