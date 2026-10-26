import { discoveredTokenizer } from './tokenizer-metadata.js';
/** models.dev is metadata. SDK labels select installed codecs; they never load packages. */
import type { ChannelModel, DiscoveredModel } from '@varin/application-client';
import { MODEL_CATALOG_FIELDS } from '@varin/application-client';
import { MODEL_THINKING_EFFORTS } from '@varin/protocol';
import { object } from './configuration.js';
import { enrichModel } from './discovery.js';
import type { ChannelType } from './channel-types.js';

const codecs: Record<string, string> = {
  '@ai-sdk/openai': 'openai-responses', '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/anthropic': 'anthropic-messages', '@ai-sdk/google': 'google-generative-ai',
};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const sourceIds: Record<string, string> = { gemini: 'google', vertex: 'google-vertex', bedrock: 'amazon-bedrock', zai: 'zai-coding-plan',
  'zai-coding-cn': 'zhipuai-coding-plan', 'qwen-token-plan': 'alibaba-token-plan', 'qwen-token-plan-cn': 'alibaba-token-plan-cn', 'kimi-coding': 'kimi-code-plan-cn' };
export const metadataProviderId = (type: ChannelType) => type.metadataId ?? sourceIds[type.id] ?? type.id;

export function directoryModels(data: Record<string, unknown>, type: ChannelType): ChannelModel[] | undefined {
  const provider = data[metadataProviderId(type)];
  if (!object(provider) || !object(provider.models)) return undefined;
  const presets = new Map(type.catalog?.map(model => [model.id, model]));
  const models: ChannelModel[] = [];
  for (const [id, raw] of Object.entries(provider.models)) {
    if (!object(raw) || raw.status === 'deprecated') continue;
    const preset = presets.get(id);
    let canonical: Record<string, unknown> = {};
    if (typeof raw.canonical_model_id === 'string') {
      const slash = raw.canonical_model_id.indexOf('/');
      const owner = data[raw.canonical_model_id.slice(0, slash)];
      const candidate = object(owner) && object(owner.models) ? owner.models[raw.canonical_model_id.slice(slash + 1)] : undefined;
      if (object(candidate)) canonical = candidate;
    }
    const model = { ...canonical, ...raw };
    const supplied = object(raw.provider) ? raw.provider : {};
    const protocol = type.id === 'openai-codex' ? type.protocol : codecs[String(supplied.npm ?? provider.npm)] ?? type.protocol;
    if (!(type.protocols ?? [type.protocol]).includes(protocol)) continue;
    const modalities = { ...(object(canonical.modalities) ? canonical.modalities : {}), ...(object(raw.modalities) ? raw.modalities : {}) };
    const output = Array.isArray(modalities.output) ? modalities.output : [];
    const operations: ChannelModel['operations'] = [];
    // Text modalities alone do not establish a chat endpoint (embeddings may also report text).
    const knownChat = preset?.operations.includes('chat');
    const language = model.type === 'language' || !model.type && (knownChat || model.tool_call !== false && !preset);
    if (language && output.includes('text') && type.operations.includes('chat')) operations.push('chat');
    if ((model.type === 'embedding' || !model.type && preset?.operations.includes('embedding')) && type.operations.includes('embedding')) operations.push('embedding');
    if ((model.type === 'rerank' || !model.type && preset?.operations.includes('rerank')) && type.operations.includes('rerank')) operations.push('rerank');
    if (output.includes('image') && type.operations.includes('image-generation')) {
      operations.push('image-generation');
      if (Array.isArray(modalities.input) && modalities.input.includes('image') && type.operations.includes('image-editing')) operations.push('image-editing');
    }
    if (!operations.length) continue;
    const ownLimit = object(raw.limit) ? raw.limit : {}, canonicalLimit = object(canonical.limit) ? canonical.limit : {};
    const context = positive(ownLimit.context) ? ownLimit.context : canonicalLimit.context;
    const outputLimit = positive(ownLimit.output) ? ownLimit.output : canonicalLimit.output;
    const tokenizer = discoveredTokenizer(model);
    const parsed: DiscoveredModel = { ...(tokenizer ? { tokenizer } : {}), id, name: typeof model.name === 'string' ? model.name : id, protocol, operations,
      ...(Array.isArray(modalities.input) ? { input: modalities.input.includes('image') ? ['text', 'image'] : ['text'] } : {}),
      ...(positive(context) ? { contextWindow: context } : {}),
      ...(positive(outputLimit) ? { maxOutputTokens: outputLimit } : {}),
      ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    };
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.filter(object) : [];
    const effort = options.find(option => option.type === 'effort');
    const values = effort && Array.isArray(effort.values) ? effort.values : [];
    const levels = MODEL_THINKING_EFFORTS.filter(level => values.includes(level));
    const toggle = options.some(option => option.type === 'toggle');
    if (model.reasoning === true && levels.length) {
      parsed.thinking = { mode: 'levels', levels, allowOff: toggle || values.includes('none') || values.includes('off') };
      parsed.thinkingLevelMap = Object.fromEntries(levels.map(level => [level, level]));
      if (values.includes('none')) parsed.thinkingLevelMap.off = 'none';
    } else if (model.reasoning === true && options.some(option => option.type === 'budget_tokens') && preset?.thinking?.mode === 'budget') {
      parsed.thinking = { ...preset.thinking, allowOff: toggle };
    } else if (model.reasoning === true && toggle) parsed.thinking = { mode: 'switch' };
    else if (model.reasoning === true && Array.isArray(model.reasoning_options) && !options.length) parsed.thinking = { mode: 'fixed' };
    const compat: Record<string, import('@varin/protocol').JsonValue> = {};
    if (protocol === 'openai-completions') compat.maxTokensField = 'max_tokens';
    if (object(model.interleaved) && model.interleaved.field === 'reasoning_content' && protocol === 'openai-completions') compat.requiresReasoningContentOnAssistantMessages = true;
    if (protocol === 'anthropic-messages' && levels.length) compat.forceAdaptiveThinking = true;
    if (protocol === 'google-generative-ai' && levels.length) compat.thinkingFormat = 'google-level';
    if (['openrouter', 'cline', 'cline-pass'].includes(type.id)) { compat.thinkingFormat = 'openrouter'; compat.reasoningDetails = true; }
    if (type.id === 'deepseek') { compat.thinkingFormat = 'deepseek'; compat.maxTokensField = 'max_tokens'; }
    if (['alibaba', 'alibaba-cn', 'alibaba-coding-plan', 'alibaba-coding-plan-cn', 'qwen-token-plan', 'qwen-token-plan-cn'].includes(type.id)) { compat.thinkingFormat = 'qwen'; if (!levels.length) compat.supportsReasoningEffort = false; }
    if (['zhipuai', 'zai', 'zai-api', 'zai-coding-cn'].includes(type.id)) { compat.thinkingFormat = 'zai'; if (!levels.length) compat.supportsReasoningEffort = false; }
    if (Object.keys(compat).length) parsed.compat = compat;
    models.push({ ...enrichModel(preset, parsed), enabled: preset?.enabled ?? false, operations, catalog: { overrides: [] } });
  }
  return models;
}

/** Saved values are also the offline fallback when a model leaves its directory. */
export { applyModelDirectoryDefaults as followDirectory } from '@varin/application-client';

export function validCatalogOverrides(value: unknown): value is NonNullable<ChannelModel['catalog']> {
  return object(value) && Object.keys(value).every(key => key === 'overrides' || key === 'source' || key === 'match')
    && (value.match === undefined || object(value.match) && Object.keys(value.match).every(key => key === 'requestModelId' || key === 'protocol')
      && typeof value.match.requestModelId === 'string' && value.match.requestModelId.trim().length > 0 && (value.match.protocol === undefined || typeof value.match.protocol === 'string'))
    && (value.source === undefined || value.source === 'service') && Array.isArray(value.overrides)
    && new Set(value.overrides).size === value.overrides.length && value.overrides.every(field => MODEL_CATALOG_FIELDS.includes(field));
}
