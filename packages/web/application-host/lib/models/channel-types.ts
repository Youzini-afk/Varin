import type { ChannelTypeInfo, ChannelModel, DiscoveredModel, ModelChannel } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';
import { MODEL_PRESETS } from './catalog.js';
import { modelList, openRouterModels, geminiModels, copilotModels, commandCodeModels, clineModels } from './discovery.js';
import { COPILOT_HEADERS } from './oauth-device.js';
import { BUNDLED_CHANNEL_DIRECTORY, parseChannelDirectory, directoryChannel, type ChannelDirectoryEntry } from './channel-directory.js';

export interface ChannelType extends ChannelTypeInfo {
  adapter?: { id: string; version: string; endpointPath: string; bindingId: string; identity: string; capture(): Promise<() => void> };
  credentialHeader?: { name: string; prefix: string };
  /** Installed behavior, confined to this channel; never inferred from an endpoint hostname. */
  requestProfile?: 'opencode';
  modelBasePaths?: Record<string, string>;
  publicDirectory?: string;
  metadataId?: string;
  discoveryRequest?(channel: ModelChannel, cursor?: string): { url: string; headers?: Record<string, string> };
  discoveryCursor?(response: unknown): string | undefined;
  parseDiscovery?(response: unknown): DiscoveredModel[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const schema = (properties: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ type: 'object', properties, additionalProperties: false });
const string = { type: 'string' };
const decisionApi = { enum: ['typesafe-system-one', 'cloudflare-workers-ai-system-one', 'llama-cpp-classify'] };
const modelListUrl = (channel: ModelChannel, parameter: string, cursor?: string) => {
  const url = new URL(`${channel.baseUrl.replace(/\/+$/, '')}/models`);
  if (cursor !== undefined) url.searchParams.set(parameter, cursor);
  return url.href;
};
const direct = (id: string, name: string, protocol: string, defaultBaseUrl?: string): ChannelType => ({
  id, name, protocol, ...(defaultBaseUrl === undefined ? {} : { defaultBaseUrl }), authentication: ['credential', 'environment', 'none'], operations: ['chat'], discovery: true,
  parametersSchema: schema(), discoveryRequest: channel => ({ url: `${channel.baseUrl.replace(/\/+$/, '')}/models` }), parseDiscovery: modelList,
});

const channelTypes: ChannelType[] = [
  { ...direct('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1'), operations: ['chat', 'embedding', 'image-generation', 'image-editing'] },
  { ...direct('openai-codex', 'ChatGPT / Codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api'), authentication: ['credential'], discovery: false,
    oauthProviders: [{ id: 'openai-codex', name: 'ChatGPT / Codex' }] },
  { ...direct('openai-compatible', 'OpenAI compatible', 'openai-completions'), operations: ['chat', 'embedding', 'rerank', 'decision', 'image-generation', 'image-editing'],
    parametersSchema: schema({ imageApi: { enum: ['openai-images', 'openrouter-images'] }, decisionApi }), defaultParameters: { decisionApi: 'typesafe-system-one' } },
  direct('deepseek', 'DeepSeek', 'openai-completions', 'https://api.deepseek.com/v1'),
  ...(['opencode', 'opencode-go'] as const).map(id => ({
    ...direct(id, id === 'opencode' ? 'OpenCode Zen' : 'OpenCode Go', 'openai-completions', `https://opencode.ai/inference${id === 'opencode-go' ? '/go' : ''}`),
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'],
    credentialHeader: { name: 'authorization', prefix: 'Bearer ' }, requestProfile: 'opencode' as const,
    modelBasePaths: { 'openai-completions': '/openai/v1', 'openai-responses': '/openai/v1', 'anthropic-messages': '/anthropic/v1', 'google-generative-ai': '/google/v1beta' },
    publicDirectory: `https://opencode.ai/inference${id === 'opencode-go' ? '/go' : ''}/v1/models`,
    discoveryRequest: (channel: ModelChannel) => ({ url: `${channel.baseUrl.replace(/\/+$/, '')}/v1/models` }),
    oauthProviders: [{ id: 'opencode', name: 'OpenCode' }],
  })),
  { ...direct('commandcode', 'Command Code', 'openai-completions', 'https://api.commandcode.ai/provider/v1'),
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'], credentialHeader: { name: 'authorization', prefix: 'Bearer ' },
    publicDirectory: 'https://api.commandcode.ai/provider/v1/models', parseDiscovery: commandCodeModels },
  ...(['cline', 'cline-pass'] as const).map(id => ({ ...direct(id, id === 'cline' ? 'Cline' : 'ClinePass', 'openai-completions', 'https://api.cline.bot/api/v1'),
    publicDirectory: 'https://api.cline.bot/api/v1/models', parseDiscovery: (response: unknown) => clineModels(response).filter(model => model.id.startsWith('cline-pass/') === (id === 'cline-pass')) })),
  { ...direct('openrouter', 'OpenRouter', 'openai-completions', 'https://openrouter.ai/api/v1'), operations: ['chat', 'image-generation', 'image-editing'], parametersSchema: schema({ imageApi: { enum: ['openrouter-images'] } }), oauthProviders: [{ id: 'openrouter', name: 'OpenRouter' }], parseDiscovery: openRouterModels, credentialHeader: { name: 'authorization', prefix: 'Bearer ' } },
  { ...direct('anthropic', 'Anthropic', 'anthropic-messages', 'https://api.anthropic.com/v1'), authentication: ['credential', 'environment', 'anthropic-federation', 'none'], oauthProviders: [{ id: 'anthropic', name: 'Claude Pro / Max' }], discoveryRequest: (channel, cursor) => ({ url: modelListUrl(channel, 'after_id', cursor), headers: { 'anthropic-version': '2023-06-01' } }),
    discoveryCursor: response => {
      if (!object(response) || response.has_more !== undefined && typeof response.has_more !== 'boolean') throw new Error('Model discovery returned invalid pagination');
      if (!response.has_more) return undefined;
      if (typeof response.last_id !== 'string' || !response.last_id) throw new Error('Model discovery returned invalid pagination');
      return response.last_id;
    } },
  { ...direct('gemini', 'Google Gemini', 'google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta'),
    discoveryRequest: (channel, cursor) => ({ url: modelListUrl(channel, 'pageToken', cursor) }),
    discoveryCursor: response => {
      if (!object(response) || response.nextPageToken != null && typeof response.nextPageToken !== 'string') throw new Error('Model discovery returned invalid pagination');
      return typeof response.nextPageToken === 'string' && response.nextPageToken ? response.nextPageToken : undefined;
    }, parseDiscovery: geminiModels },
  { ...direct('azure', 'Azure OpenAI', 'azure-openai-responses'), discovery: false, authentication: ['credential', 'environment'],
    parametersSchema: schema({ deployment: string, apiVersion: string }), defaultParameters: { apiVersion: 'v1' } },
  { ...direct('vertex', 'Google Vertex', 'google-vertex', 'https://aiplatform.googleapis.com/v1'), discovery: false,
    authentication: ['google-adc', 'credential', 'environment'], parametersSchema: schema({ project: string, location: string }), defaultParameters: { location: 'global' } },
  { ...direct('bedrock', 'Amazon Bedrock', 'bedrock-converse-stream', 'https://bedrock-runtime.us-east-1.amazonaws.com'), discovery: false,
    authentication: ['aws-chain'], parametersSchema: schema({ region: string }), defaultParameters: { region: 'us-east-1' } },
  { ...direct('github-copilot', 'GitHub Copilot', 'openai-responses', 'https://api.individual.githubcopilot.com'),
    authentication: ['credential'], oauthProviders: [{ id: 'github-copilot', name: 'GitHub Copilot' }],
    discoveryRequest: channel => ({ url: `${channel.baseUrl.replace(/\/+$/, '')}/models`, headers: COPILOT_HEADERS }), parseDiscovery: copilotModels },
  { ...direct('kimi-coding', 'Kimi Code', 'openai-completions', 'https://api.kimi.com/coding/v1'), oauthProviders: [{ id: 'kimi-coding', name: 'Kimi Code' }] },
  { ...direct('xai', 'xAI', 'openai-responses', 'https://api.x.ai/v1'), oauthProviders: [{ id: 'xai', name: 'Grok' }] },
  { ...direct('meta', 'Meta', 'openai-responses', 'https://api.meta.ai/v1'), oauthProviders: [{ id: 'meta', name: 'Meta' }] },
  direct('groq', 'Groq', 'openai-completions', 'https://api.groq.com/openai/v1'),
  direct('cerebras', 'Cerebras', 'openai-completions', 'https://api.cerebras.ai/v1'),
  { ...direct('mistral', 'Mistral', 'mistral-conversations', 'https://api.mistral.ai/v1') },
  { ...direct('minimax', 'MiniMax', 'anthropic-messages', 'https://api.minimax.io/anthropic'), discovery: false },
  { ...direct('minimax-cn', 'MiniMax 中国', 'anthropic-messages', 'https://api.minimaxi.com/anthropic'), discovery: false },
  direct('moonshotai', 'Moonshot AI', 'openai-completions', 'https://api.moonshot.ai/v1'),
  direct('moonshotai-cn', 'Moonshot 中国', 'openai-completions', 'https://api.moonshot.cn/v1'),
  { ...direct('zai', 'Z.AI Coding Plan', 'openai-completions', 'https://api.z.ai/api/coding/paas/v4'), discovery: false },
  { ...direct('zai-coding-cn', '智谱 Coding Plan', 'openai-completions', 'https://open.bigmodel.cn/api/coding/paas/v4'), discovery: false },
  { ...direct('qwen-token-plan', 'Qwen Token Plan', 'openai-completions', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'), discovery: false },
  { ...direct('qwen-token-plan-cn', '通义千问 Token Plan', 'openai-completions', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), discovery: false },
  { ...direct('fireworks', 'Fireworks AI', 'openai-completions', 'https://api.fireworks.ai/inference/v1'), credentialHeader: { name: 'authorization', prefix: 'Bearer ' } },
  direct('together', 'Together AI', 'openai-completions', 'https://api.together.ai/v1'),
  direct('nvidia', 'NVIDIA NIM', 'openai-completions', 'https://integrate.api.nvidia.com/v1'),
  direct('ant-ling', 'Ling / Ring', 'openai-completions', 'https://api.ant-ling.com/v1'),
  direct('xiaomi', '小米 MiMo', 'openai-completions', 'https://api.xiaomimimo.com/v1'),
  { ...direct('vercel-ai-gateway', 'Vercel AI Gateway', 'anthropic-messages', 'https://ai-gateway.vercel.sh/v1'), credentialHeader: { name: 'authorization', prefix: 'Bearer ' } },
  { ...direct('local', 'Local service', 'openai-completions', 'http://localhost:8080/v1'), operations: ['chat', 'embedding', 'rerank', 'decision'], authentication: ['none', 'credential', 'environment'],
    parametersSchema: schema({ decisionApi }), defaultParameters: { decisionApi: 'typesafe-system-one' } },
  { ...direct('rerank', 'Rerank API', 'http-rerank'), operations: ['rerank'], discovery: false },
  ...([['typesafe-system-one', 'Typesafe System One'], ['cloudflare-workers-ai-system-one', 'Cloudflare Workers AI · Classifier'], ['llama-cpp-classify', 'llama.cpp · Classifier']] as const).map(([id, name]) => ({
    ...direct(id, name, id), operations: ['decision' as const], discovery: false,
  })),
];

const environmentVariables: Record<string, string> = {
  openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY', groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY', mistral: 'MISTRAL_API_KEY', minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY', 'moonshotai-cn': 'MOONSHOT_API_KEY', zai: 'ZAI_API_KEY', 'zai-coding-cn': 'ZAI_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY', 'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_API_KEY', fireworks: 'FIREWORKS_API_KEY', together: 'TOGETHER_API_KEY',
  nvidia: 'NVIDIA_API_KEY', 'kimi-coding': 'KIMI_API_KEY', 'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  opencode: 'OPENCODE_API_KEY', 'opencode-go': 'OPENCODE_API_KEY', commandcode: 'CMD_API_KEY', cline: 'CLINE_API_KEY', 'cline-pass': 'CLINE_API_KEY',
};
export const BUILTIN_CHANNEL_TYPES: readonly ChannelType[] = channelTypes.map(type => {
  const catalog = MODEL_PRESETS[type.id];
  return { ...type, ...(catalog ? { catalog, protocols: [...new Set([...(type.protocols ?? [type.protocol]), ...catalog.flatMap(model => model.protocol ? [model.protocol] : [])])],
    defaultModelIds: catalog.filter(model => model.enabled).slice(0, 3).map(model => model.id) } : {}),
    ...(environmentVariables[type.id] ? { defaultEnvironmentVariable: environmentVariables[type.id] } : {}) };
});

export class ChannelTypes {
  readonly #types = new Map<string, ChannelType>();
  readonly #owners = new Map<string, string>();
  constructor() { for (const type of BUILTIN_CHANNEL_TYPES) this.register(type); this.prepareDirectory(parseChannelDirectory(BUNDLED_CHANNEL_DIRECTORY))(); }
  prepareDirectory(entries: ChannelDirectoryEntry[]) {
    const templates: Record<string, string> = { 'openai-completions': 'openai-compatible', 'openai-responses': 'openai', 'anthropic-messages': 'anthropic', 'google-generative-ai': 'gemini', 'mistral-conversations': 'mistral' };
    const types = entries.map(entry => {
      const previous = this.get(entry.id);
      if (previous && previous.protocol !== entry.protocol) throw new Error('A channel directory update cannot replace an installed protocol');
      return { ...directoryChannel(entry, this.get(templates[entry.protocol]!)), ...(previous?.catalog ? { catalog: previous.catalog } : {}) };
    });
    return this.prepareReplacement('directory', types);
  }
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
  entries() { return [...this.#types.values()]; }
  followsDirectory(id: string) { const owner = this.#owners.get(id); return owner === undefined || owner === 'directory'; }
  setCatalog(id: string, catalog: ChannelModel[]) {
    const type = this.#types.get(id);
    if (type) this.#types.set(id, { ...type, catalog });
  }
  list(): ChannelTypeInfo[] { return this.entries().map(({ discoveryRequest: _request, discoveryCursor: _cursor, parseDiscovery: _parse, adapter: _adapter, credentialHeader: _credential,
    requestProfile: _profile, modelBasePaths: _paths, publicDirectory: _public, metadataId: _metadata, catalog: _catalog, ...info }) => structuredClone(info)); }
}
