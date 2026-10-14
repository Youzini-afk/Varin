import type { ChannelTypeInfo, ModelChannel } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';

export interface ChannelType extends ChannelTypeInfo {
  adapter?: { id: string; version: string; endpointPath: string; bindingId: string; identity: string; capture(): Promise<() => void> };
  credentialHeader?: { name: string; prefix: string };
  discoveryRequest?(channel: ModelChannel): { url: string; headers?: Record<string, string> };
  parseDiscovery?(response: unknown): Array<{ id: string; name: string }>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function list(response: unknown) {
  if (!object(response) || !Array.isArray(response.data)) throw new Error('Model discovery returned an invalid list');
  return response.data.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !item.id) throw new Error('Model discovery returned an invalid model');
    return { id: item.id, name: typeof item.name === 'string' ? item.name : item.id };
  });
}
const schema = (properties: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ type: 'object', properties, additionalProperties: false });
const string = { type: 'string' };
const direct = (id: string, name: string, protocol: string, defaultBaseUrl?: string): ChannelType => ({
  id, name, protocol, ...(defaultBaseUrl === undefined ? {} : { defaultBaseUrl }), authentication: ['credential', 'environment', 'none'], operations: ['chat'], discovery: true,
  parametersSchema: schema(), discoveryRequest: channel => ({ url: `${channel.baseUrl.replace(/\/+$/, '')}/models` }), parseDiscovery: list,
});

export const BUILTIN_CHANNEL_TYPES: readonly ChannelType[] = [
  { ...direct('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1'), operations: ['chat', 'embedding', 'image-generation', 'image-editing'] },
  { ...direct('openai-codex', 'ChatGPT / Codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api'), authentication: ['credential'], discovery: false,
    oauthProviders: [{ id: 'openai-codex', name: 'ChatGPT / Codex' }] },
  { ...direct('openai-compatible', 'OpenAI compatible', 'openai-completions'), operations: ['chat', 'embedding', 'rerank', 'image-generation', 'image-editing'], parametersSchema: schema({ imageApi: { enum: ['openai-images', 'openrouter-images'] } }) },
  direct('deepseek', 'DeepSeek', 'openai-completions', 'https://api.deepseek.com/v1'),
  { ...direct('openrouter', 'OpenRouter', 'openai-completions', 'https://openrouter.ai/api/v1'), operations: ['chat', 'image-generation', 'image-editing'], parametersSchema: schema({ imageApi: { enum: ['openrouter-images'] } }), oauthProviders: [{ id: 'openrouter', name: 'OpenRouter' }] },
  { ...direct('anthropic', 'Anthropic', 'anthropic-messages', 'https://api.anthropic.com/v1'), oauthProviders: [{ id: 'anthropic', name: 'Claude Pro / Max' }], discoveryRequest: channel => ({ url: `${channel.baseUrl.replace(/\/+$/, '')}/models`, headers: { 'anthropic-version': '2023-06-01' } }) },
  { ...direct('gemini', 'Google Gemini', 'google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta'), parseDiscovery: response => {
    if (!object(response) || !Array.isArray(response.models)) throw new Error('Model discovery returned an invalid list');
    return response.models.map(item => {
      if (!object(item) || typeof item.name !== 'string') throw new Error('Model discovery returned an invalid model');
      return { id: item.name.replace(/^models\//, ''), name: typeof item.displayName === 'string' ? item.displayName : item.name };
    });
  } },
  { ...direct('azure', 'Azure OpenAI', 'azure-openai-responses'), discovery: false, authentication: ['credential', 'environment'],
    parametersSchema: schema({ deployment: string, apiVersion: string }) },
  { ...direct('vertex', 'Google Vertex', 'google-vertex', 'https://aiplatform.googleapis.com/v1'), discovery: false,
    authentication: ['google-adc', 'credential', 'environment'], parametersSchema: schema({ project: string, location: string }) },
  { ...direct('bedrock', 'Amazon Bedrock', 'bedrock-converse-stream', 'https://bedrock-runtime.us-east-1.amazonaws.com'), discovery: false,
    authentication: ['aws-chain'], parametersSchema: schema({ region: string }) },
  { ...direct('local', 'Local service', 'openai-completions', 'http://localhost:8080/v1'), operations: ['chat', 'embedding', 'rerank'], authentication: ['none', 'credential', 'environment'] },
  { ...direct('rerank', 'Rerank API', 'http-rerank'), operations: ['rerank'], discovery: false },
  ...(['typesafe-system-one', 'cloudflare-workers-ai-system-one', 'llama-cpp-classify'] as const).map(id => ({
    ...direct(id, id, id), operations: ['decision' as const], discovery: false,
  })),
];

export class ChannelTypes {
  readonly #types = new Map<string, ChannelType>();
  readonly #owners = new Map<string, string>();
  constructor() { for (const type of BUILTIN_CHANNEL_TYPES) this.register(type); }
  register(type: ChannelType) {
    if (this.#types.has(type.id)) throw new Error(`Channel type already registered: ${type.id}`);
    this.#types.set(type.id, type);
    return () => { if (this.#types.get(type.id) === type) this.#types.delete(type.id); };
  }
  prepareReplacement(owner: string, types: readonly ChannelType[]): () => void {
    const next = new Map<string, ChannelType>();
    for (const type of types) {
      if (next.has(type.id) || this.#types.has(type.id) && this.#owners.get(type.id) !== owner) throw new Error(`Channel type already registered: ${type.id}`);
      next.set(type.id, type);
    }
    return () => {
      for (const [id, current] of this.#owners) if (current === owner) { this.#types.delete(id); this.#owners.delete(id); }
      for (const [id, type] of next) { this.#types.set(id, type); this.#owners.set(id, owner); }
    };
  }
  get(id: string) { return this.#types.get(id); }
  list(): ChannelTypeInfo[] { return [...this.#types.values()].map(({ discoveryRequest: _request, parseDiscovery: _parse, adapter: _adapter, credentialHeader: _credential, ...info }) => structuredClone(info)); }
}
