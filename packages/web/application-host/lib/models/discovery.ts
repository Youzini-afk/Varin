import { discoveredTokenizer } from './tokenizer-metadata.js';
/** Provider directory responses are normalized to the same editable model metadata as presets. */
import type { DiscoveredModel, ModelOperation } from '@varin/application-client';
import { MODEL_THINKING_EFFORTS } from '@varin/protocol';
import { object } from './configuration.js';

const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
function capacity(context: unknown, output: unknown): Pick<DiscoveredModel, 'contextWindow' | 'maxOutputTokens'> {
  const contextWindow = number(context), maxOutputTokens = number(output);
  return { ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
}
export function modelList(response: unknown): DiscoveredModel[] {
  if (!object(response) || !Array.isArray(response.data)) throw new Error('Model discovery returned an invalid list');
  return response.data.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !item.id) throw new Error('Model discovery returned an invalid model');
    const tokenizer = discoveredTokenizer(item);
    return { ...(tokenizer ? { tokenizer } : {}), id: item.id, name: typeof item.display_name === 'string' ? item.display_name : typeof item.name === 'string' ? item.name : item.id };
  });
}
export function openRouterModels(response: unknown): DiscoveredModel[] {
  const basic = modelList(response);
  const data = (response as { data: Record<string, unknown>[] }).data;
  return basic.flatMap((model, index) => {
    const item = data[index]!, architecture = object(item.architecture) ? item.architecture : {};
    const top = object(item.top_provider) ? item.top_provider : {};
    const reasoning = object(item.reasoning) ? item.reasoning : {};
    const input = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : undefined;
    const output = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
    const parameters = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
    const operations: ModelOperation[] = [];
    if (output.includes('text') || output.length === 0) operations.push('chat');
    if (output.includes('image')) { operations.push('image-generation'); if (input?.includes('image')) operations.push('image-editing'); }
    if (!operations.length) return [];
    const supportsReasoning = Object.keys(reasoning).length > 0 ? true : Array.isArray(item.supported_parameters) ? parameters.includes('reasoning') || parameters.includes('reasoning_effort') : undefined;
    const levels = MODEL_THINKING_EFFORTS.filter(level => Array.isArray(reasoning.supported_efforts) && reasoning.supported_efforts.includes(level));
    const modalities: ('text' | 'image')[] = input?.includes('image') ? ['text', 'image'] : ['text'];
    return [{ ...model, protocol: 'openai-completions', operations, ...(input ? { input: modalities } : {}),
      ...capacity(item.context_length ?? top.context_length, top.max_completion_tokens),
      ...(supportsReasoning === undefined ? {} : { reasoning: supportsReasoning }),
      ...(supportsReasoning ? { thinking: levels.length ? { mode: 'levels' as const, levels, allowOff: reasoning.mandatory !== true }
        : reasoning.mandatory === true ? { mode: 'fixed' as const } : { mode: 'switch' as const } } : {}),
      compat: { thinkingFormat: 'openrouter', maxTokensField: 'max_tokens', reasoningDetails: true },
    }];
  });
}
export function geminiModels(response: unknown): DiscoveredModel[] {
  if (!object(response) || !Array.isArray(response.models)) throw new Error('Model discovery returned an invalid list');
  return response.models.flatMap(item => {
    if (!object(item) || typeof item.name !== 'string') throw new Error('Model discovery returned an invalid model');
    const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
    if (methods.length && !methods.includes('generateContent')) return [];
    return [{ id: item.name.replace(/^models\//, ''), name: typeof item.displayName === 'string' ? item.displayName : item.name,
      ...capacity(item.inputTokenLimit, item.outputTokenLimit), operations: ['chat'] as ModelOperation[],
      ...(typeof item.thinking === 'boolean' ? { reasoning: item.thinking } : {}) }];
  });
}
export function copilotModels(response: unknown): DiscoveredModel[] {
  const basic = modelList(response), data = (response as { data: Record<string, unknown>[] }).data;
  return basic.flatMap((model, index) => {
    const item = data[index]!, capabilities = object(item.capabilities) ? item.capabilities : {};
    const supports = object(capabilities.supports) ? capabilities.supports : {};
    const limits = object(capabilities.limits) ? capabilities.limits : {};
    if (supports.tool_calls === false || object(item.policy) && item.policy.state === 'disabled' || item.model_picker_enabled === false) return [];
    const endpoints = Array.isArray(item.supported_endpoints) ? item.supported_endpoints : [];
    const protocol = endpoints.includes('/responses') ? 'openai-responses' : endpoints.includes('/v1/messages') ? 'anthropic-messages'
      : endpoints.includes('/chat/completions') ? 'openai-completions' : /^claude-/.test(model.id) ? 'anthropic-messages'
        : /^(gpt-|grok-|oswe|mai-)/.test(model.id) ? 'openai-responses' : 'openai-completions';
    return [{ ...model, protocol, operations: ['chat'] as ModelOperation[],
      ...(typeof supports.vision === 'boolean' ? { input: supports.vision ? ['text', 'image'] as ('text' | 'image')[] : ['text'] as ('text' | 'image')[] } : {}),
      ...capacity(limits.max_context_window_tokens, limits.max_output_tokens), compat: { copilot: true } }];
  });
}

export function commandCodeModels(response: unknown): DiscoveredModel[] {
  const basic = modelList(response), data = (response as { data: Record<string, unknown>[] }).data;
  return basic.flatMap((model, index) => {
    const item = data[index]!, endpoints = Array.isArray(item.supported_endpoints) ? item.supported_endpoints : [];
    const has = (path: string) => endpoints.includes(path) || endpoints.includes(`/v1${path}`);
    const protocol = has('/messages') ? 'anthropic-messages' : has('/responses') ? 'openai-responses' : has('/chat/completions') ? 'openai-completions' : undefined;
    if (!protocol) return [];
    return [{ ...model, protocol, operations: ['chat'] as ModelOperation[], ...capacity(item.context_length, item.max_output_tokens) }];
  });
}

export function clineModels(response: unknown): DiscoveredModel[] {
  return modelList(response).map(model => ({ ...model, protocol: 'openai-completions', operations: ['chat'], compat: { thinkingFormat: 'openrouter', reasoningDetails: true } }));
}

/** Only supplied directory facts replace presets; missing fields remain unknown. */
export function enrichModel(preset: DiscoveredModel | undefined, model: DiscoveredModel): DiscoveredModel {
  const fields = Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined));
  const merged = { ...preset, ...fields, id: model.id, name: model.name === model.id ? preset?.name ?? model.name : model.name,
    ...(preset?.compat || model.compat ? { compat: { ...preset?.compat, ...model.compat } } : {}) };
  if (model.reasoning === false) { delete merged.thinking; delete merged.thinkingLevelMap; }
  return merged;
}
