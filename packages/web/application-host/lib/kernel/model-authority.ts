import type { ModelTokenizer } from '@varin/application-client';
import type { TokenizerBinding } from './protocol.generated.js';
import { modelCredentialBindingIdentity } from './model-binding-lifetime.js';
/** Trusted catalog -> model binding. Renderer input consists only of registered IDs. */
import { createHash } from 'node:crypto';
import { ExistingHostCredentialOwner, type ExistingModelAuthRuntime, type CredentialScope, type CredentialDispatch } from './credential-owner.js';
import type { ModelSessionConfiguration } from './protocol.generated.js';
import { appendModelPath } from '../models/connection.js';
import type { ModelConnectionOptions, ModelThinkingConfiguration, ThreadModel, ThreadModelInfo, ThreadThinkingLevel } from '@varin/application-client';
import { modelOptions, thinkingLevels } from './model-options.js';
export interface SelectedModel {
  tokenizer?: ModelTokenizer;
  providerId: string; modelId: string; name: string; api: string; baseUrl: string; maxTokens: number;
  input?: readonly string[]; contextWindow?: number; reasoning?: boolean;
  thinking?: ModelThinkingConfiguration;
  thinkingLevelMap?: Partial<Record<ThreadThinkingLevel, string | null>>;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: Partial<Record<ThreadThinkingLevel, Record<string, unknown>>>;
  compat?: Record<string, unknown>;
  requestModelId?: string;
  allowAnonymous?: boolean;
  connection?: ModelConnectionOptions;
  requestProfile?: 'opencode';
  adapterId?: string; adapterVersion?: string; adapterIdentity?: string; adapterBindingId?: string; endpointPath?: string;
}
export interface ModelExecutionAuthority extends ExistingModelAuthRuntime {
  prepareTokenizer?(source: ModelTokenizer): Promise<TokenizerBinding | undefined>;
  cachedTokenizer?(source: ModelTokenizer): Promise<TokenizerBinding | undefined>;
  getAuth(providerId: string, modelId?: string, dispatch?: CredentialDispatch): ReturnType<ExistingModelAuthRuntime['getAuth']>;
  currentScope(providerId: string, modelId?: string): Promise<CredentialScope>;
  currentProviderAccount(providerId: string): Promise<string | undefined>;
  routingEnvironment(providerId: string): Promise<Record<string, string>>;
  anthropicAuthentication?(providerId: string, modelId?: string): Promise<'oauth' | 'api-key'>;
  vertexAuthentication?(providerId: string, modelId?: string): Promise<'api-key' | 'adc'>;
}
interface ModelAuthority extends ModelExecutionAuthority {
  selectedModel(providerId: string, modelId: string): Promise<SelectedModel>;
  listModels(): Promise<SelectedModel[]>;
  captureModel?(providerId: string, modelId: string, original?: ModelSessionConfiguration): Promise<{ model: SelectedModel; authority: ModelExecutionAuthority; release?: () => void }>;
}
const families = new Set(['openai-responses', 'openai-completions', 'anthropic-messages', 'azure-openai-responses',
  'google-generative-ai', 'google-vertex', 'mistral-conversations', 'openai-codex-responses', 'bedrock-converse-stream', 'pi-messages']);
const failed = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function trustedUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { return failed('model-endpoint-missing'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return failed('model-endpoint-invalid');
  for (const key of url.searchParams.keys()) {
    if (/^(key|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|signature|sig)$/i.test(key)) return failed('model-endpoint-contains-credentials');
  }
  return url;
}
function append(url: URL, suffix: string): string {
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(`/${suffix}`)) url.pathname = `${path}/${suffix}`;
  return url.toString();
}
function sameScope(left: CredentialScope, right: CredentialScope): boolean {
  return left.reference === right.reference && left.authority === right.authority && left.account === right.account && left.generation === right.generation;
}
export function createModelAuthority(authority: ModelAuthority, options: { outputVisibleBytes?: () => Promise<number> } = {}) {
  async function configurationFor(model: SelectedModel, thinkingLevel?: ThreadThinkingLevel, temperature?: number, source: ModelExecutionAuthority = authority, inheritedOutputBytes?: number, inheritedTokenizer?: Pick<ModelSessionConfiguration, 'tokenizer'>): Promise<ModelSessionConfiguration> {
    if (!families.has(model.api) && !(model.adapterId && model.adapterVersion && model.endpointPath)) return failed('model-protocol-unavailable');
    if (model.compat?.copilot === true) {
      const resolved = await source.getAuth(model.providerId, model.modelId);
      if (resolved?.auth.baseUrl) model = { ...model, baseUrl: resolved.auth.baseUrl };
    }
    const env = await source.routingEnvironment(model.providerId);
    const requestModelId = model.requestModelId ?? model.modelId;
    const anthropicOauth = model.api === 'anthropic-messages' && await source.anthropicAuthentication?.(model.providerId, model.modelId) === 'oauth';
    const vertexAdc = model.api === 'google-vertex' && await source.vertexAuthentication?.(model.providerId, model.modelId) === 'adc';
    const vertexEndpoint = model.api === 'google-vertex' && model.baseUrl.trim() && !model.baseUrl.includes('{location}') ? trustedUrl(model.baseUrl) : undefined;
    const vertexDefault = model.api === 'google-vertex' && (!vertexEndpoint
      || /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(vertexEndpoint.hostname)
        && /^\/(?:v\d+(?:beta\d*)?)?\/?$/.test(vertexEndpoint.pathname));
    const vertexLocation = env.GOOGLE_CLOUD_LOCATION;
    const vertexProject = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
    if (vertexAdc && vertexDefault && (!vertexLocation || !vertexProject)) return failed('vertex-project-location-required');
    if (vertexAdc && vertexDefault && !/^[a-z0-9-]+$/.test(vertexLocation!)) return failed('vertex-location-invalid');
    let endpoint: string; let deployment: string | undefined; let apiVersion: string | undefined;
    if (model.endpointPath) {
      const suffix = model.endpointPath;
      if (!suffix.startsWith('/') || suffix.startsWith('//') || /[?#\\\s]/.test(suffix) || suffix.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) return failed('model-endpoint-invalid');
      const url = trustedUrl(model.baseUrl); url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`; endpoint = url.toString();
    } else if (model.api === 'azure-openai-responses') {
      const base = env.AZURE_OPENAI_BASE_URL || (env.AZURE_OPENAI_RESOURCE_NAME
        ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : model.baseUrl);
      const url = trustedUrl(base);
      if (['', '/', '/openai'].includes(url.pathname)) url.pathname = '/openai/v1';
      endpoint = append(url, 'responses');
      for (const entry of (env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? '').split(',')) {
        const equal = entry.indexOf('=');
        if (equal > 0 && entry.slice(0, equal).trim() === model.modelId) deployment = entry.slice(equal + 1).trim();
      }
      if (!deployment) return failed('azure-deployment-required');
      apiVersion = env.AZURE_OPENAI_API_VERSION || 'v1';
    } else {
      const url = trustedUrl(vertexDefault
        ? vertexAdc && vertexLocation !== 'global' ? `https://${vertexLocation}-aiplatform.googleapis.com`
          : 'https://aiplatform.googleapis.com' : model.baseUrl);
      switch (model.api) {
        case 'openai-responses': endpoint = append(url, 'responses'); break;
        case 'openai-completions': endpoint = append(url, 'chat/completions'); break;
        case 'pi-messages': endpoint = append(url, 'messages'); break;
        case 'anthropic-messages': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/v1') ? 'messages' : 'v1/messages'); break;
        case 'mistral-conversations': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/v1') ? 'chat/completions' : 'v1/chat/completions'); break;
        case 'openai-codex-responses': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/codex') ? 'responses' : 'codex/responses'); break;
        case 'bedrock-converse-stream': {
          // Preserve explicit VPC/proxy endpoints. Standard catalog endpoints use the selected
          // model ARN's region, then the owner's explicit region, matching the existing SDK.
          const region = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/.exec(requestModelId)?.[1]
            || env.AWS_REGION || env.AWS_DEFAULT_REGION;
          if (region && /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname)) {
            if (!/^[a-z0-9-]+$/.test(region)) return failed('bedrock-region-invalid');
            url.hostname = `bedrock-runtime.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
          }
          endpoint = append(url, `model/${encodeURIComponent(requestModelId)}/converse-stream`); break;
        }
        case 'google-generative-ai':
          endpoint = append(url, `models/${encodeURIComponent(requestModelId.replace(/^models\//, ''))}:streamGenerateContent`); break;
        case 'google-vertex': {
          // Cloud API keys use express mode; ADC uses the selected project/location. A custom collection
          // base URL retains its path, matching the SDK's ResourceScope.COLLECTION contract.
          if (url.pathname.endsWith(':streamGenerateContent')) { endpoint = url.toString(); break; }
          if (!url.pathname.split('/').some(part => /^v\d+(?:beta\d*)?$/.test(part))) append(url, 'v1');
          let modelPath = /^(publishers|projects|models)\//.test(requestModelId) ? requestModelId
            : requestModelId.includes('/') ? `publishers/${requestModelId.split('/')[0]}/models/${requestModelId.split('/')[1]}`
              : `publishers/google/models/${requestModelId}`;
          if (vertexAdc && vertexDefault && !modelPath.startsWith('projects/')) {
            modelPath = `projects/${vertexProject}/locations/${vertexLocation}/${modelPath}`;
          }
          endpoint = append(url, `${modelPath.split('/').map(encodeURIComponent).join('/')}:streamGenerateContent`); break;
        }
        default: return failed('model-protocol-unavailable');
      }
    }
    if (model.connection?.paths?.chat) endpoint = appendModelPath(model.baseUrl, model.connection.paths.chat);
    const max = model.api === 'openai-codex-responses' ? null
      : Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;
    if (model.api === 'anthropic-messages' && max === null) return failed('anthropic-output-capacity-required');
    const acceptsImages = model.input?.includes('image') ?? false;
    const toolOutputVisibleBytes = inheritedOutputBytes ?? await options.outputVisibleBytes?.() ?? 32768;
    const legacy = model.compat?.maxTokensField === 'max_tokens';
    const streamUsage = model.compat?.supportsUsageInStreaming !== false;
    if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) return failed('model-context-capacity-invalid');
    const resolved = modelOptions(model, thinkingLevel, max, temperature);
    const awsRegion = model.api === 'bedrock-converse-stream' ? env.AWS_REGION || env.AWS_DEFAULT_REGION : undefined;
    const tokenizer = inheritedTokenizer ? inheritedTokenizer.tokenizer : model.tokenizer ? await authority.prepareTokenizer?.(model.tokenizer) : undefined;
    const generation = Number.parseInt(createHash('sha256').update(JSON.stringify({ providerId: model.providerId, requestModelId: model.requestModelId, allowAnonymous: model.allowAnonymous, awsRegion,
      adapterId: model.adapterId, adapterVersion: model.adapterVersion, adapterIdentity: model.adapterIdentity, connection: model.connection, family: model.api, model: model.modelId, endpoint, max, deployment, apiVersion, legacy, streamUsage, acceptsImages,
      tokenizer: model.tokenizer, contextWindow: model.contextWindow, toolOutputVisibleBytes, ...resolved, ...(model.api === 'anthropic-messages' ? { anthropicOauth } : {}) })).digest('hex').slice(0, 12), 16);
    return { ...(tokenizer ? { tokenizer } : {}), providerId: model.providerId, providerFamily: model.api, model: model.requestModelId ?? model.modelId, endpoint,
      ...(awsRegion ? { awsRegion } : {}),
      ...(model.connection ? { connection: { ...(model.connection.headers ? { headers: model.connection.headers } : {}), ...(model.connection.proxy ? { proxy: model.connection.proxy } : {}) } } : {}),
      credentialEnvironment: null, allowAnonymous: model.allowAnonymous ?? false, acceptsImages, toolOutputVisibleBytes, configurationGeneration: generation, maxOutputTokens: max,
      adapterId: model.adapterId ?? model.api, adapterVersion: model.adapterVersion ?? '1', ...(model.adapterIdentity ? { adapterIdentity: model.adapterIdentity, adapterBindingId: model.adapterBindingId } : {}), ...resolved,
      catalogModelId: model.modelId,
      ...(model.contextWindow === undefined ? {} : { contextWindowTokens: model.contextWindow }),
      ...(model.api === 'anthropic-messages' ? { anthropicOauth } : {}),
      ...(deployment ? { azureDeployment: deployment } : {}), ...(apiVersion ? { azureApiVersion: apiVersion } : {}),
      ...(model.api === 'openai-completions' ? { legacyMaxTokens: legacy, includeStreamUsage: streamUsage } : {}) };
  }
  function ownerFor(configuration: ModelSessionConfiguration, source: ModelExecutionAuthority = authority, release?: () => void): ExistingHostCredentialOwner {
    const providerId = configuration.providerId || failed('provider-identity-required');
    const getAuth = async (provider: string, dispatch?: CredentialDispatch) => {
      const checkMode = async () => {
        if (configuration.providerFamily === 'anthropic-messages' && source.anthropicAuthentication) {
          const oauth = await source.anthropicAuthentication(provider, configuration.model) === 'oauth';
          if (oauth !== (configuration.anthropicOauth ?? false)) failed('model-auth-mode-changed');
        }
      };
      await checkMode();
      const result = await source.getAuth(provider, configuration.model, dispatch);
      await checkMode();
      return result;
    };
    return new ExistingHostCredentialOwner({ runtime: { getAuth, resolveRequest: getAuth }, providerId,
      providerFamily: configuration.providerFamily, endpoint: configuration.endpoint, bindingIdentity: modelCredentialBindingIdentity(configuration),
      allowAnonymous: configuration.allowAnonymous ?? false,
      currentScope: () => source.currentScope(providerId, configuration.model),
      currentProviderAccount: () => source.currentProviderAccount(providerId), ...(release ? { release } : {}) });
  }
  return {
    async resolveCaptured(captured: { model: SelectedModel; authority: ModelExecutionAuthority; release(): void }, selection: ThreadModel) {
      try {
        const configuration = await configurationFor(captured.model, selection.thinkingLevel, selection.temperature, captured.authority);
        const credentialOwner = ownerFor(configuration, captured.authority, captured.release);
        await credentialOwner.scope();
        return { configuration, credentialOwner, acceptsImages: configuration.acceptsImages ?? false };
      } catch (error) { captured.release(); throw error; }
    },
    async listModels(): Promise<ThreadModelInfo[]> {
      return (await authority.listModels()).filter(model => families.has(model.api) || Boolean(model.adapterId && model.adapterVersion && model.endpointPath))
        .map(model => ({ providerId: model.providerId, modelId: model.modelId, name: model.name, acceptsImages: model.input?.includes('image') ?? false,
          ...(model.contextWindow === undefined ? {} : { contextWindowTokens: model.contextWindow }), thinkingLevels: thinkingLevels(model) }));
    },
    /** Public model metadata for pure planning. Never consult auth mode, routing
     * environment, account scopes, credential helpers or a provider connection. */
    async describeModel(selection: ThreadModel) {
      const model = await authority.selectedModel(selection.providerId, selection.modelId);
      if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) return failed('model-context-capacity-invalid');
      const max = model.api === 'openai-codex-responses' ? null
        : Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;
      const resolved = modelOptions(model, selection.thinkingLevel, max, selection.temperature);
      const tokenizer = model.tokenizer ? await authority.cachedTokenizer?.(model.tokenizer) : undefined;
      return { ...(tokenizer ? { tokenizer } : {}), providerId: model.providerId, model: model.requestModelId ?? model.modelId, ...resolved,
        contextWindowTokens: model.contextWindow ?? null, maxOutputTokens: max };
    },
    async resolveModel(selection: ThreadModel, inherited?: { configuration: ModelSessionConfiguration; credentialScope: CredentialScope }) {
      const captured = authority.captureModel ? await authority.captureModel(selection.providerId, selection.modelId, inherited?.configuration)
        : { model: await authority.selectedModel(selection.providerId, selection.modelId), authority };
      try {
        if (inherited) {
          const original = inherited.configuration;
          const base = await configurationFor(captured.model, original.thinkingLevel as ThreadThinkingLevel | undefined,
            (original.modelOptions as { temperature?: number } | undefined)?.temperature, captured.authority, original.toolOutputVisibleBytes, original);
          // Deriving new overrides needs the original normalization metadata, unlike
          // simply rebinding an already-normalized request. Never mix today's defaults.
          if (base.configurationGeneration !== original.configurationGeneration) return failed('model-configuration-changed');
        }
        const configuration = await configurationFor(captured.model, selection.thinkingLevel, selection.temperature, captured.authority, inherited?.configuration.toolOutputVisibleBytes, inherited?.configuration);
        const credentialOwner = ownerFor(configuration, captured.authority, captured.release);
        const scope = await credentialOwner.scope();
        if (inherited && !sameScope(scope, inherited.credentialScope)) return failed('credential-scope-changed');
        return { configuration, credentialOwner, acceptsImages: configuration.acceptsImages ?? false };
      } catch (error) { captured.release?.(); throw error; }
    },
    async rebindModel(configuration: ModelSessionConfiguration, expectedScope: CredentialScope) {
      if (!expectedScope) return failed('credential-selection-missing');
      const providerId = configuration.providerId || failed('provider-identity-required');
      const catalogModelId = configuration.catalogModelId ?? configuration.model;
      const captured = authority.captureModel ? await authority.captureModel(providerId, catalogModelId, configuration)
        : { model: await authority.selectedModel(providerId, catalogModelId), authority };
      try {
      if (captured.model.api !== configuration.providerFamily
        || (captured.model.adapterId ?? captured.model.api) !== configuration.adapterId
        || (captured.model.adapterVersion ?? '1') !== configuration.adapterVersion
        || (captured.model.adapterIdentity ?? null) !== (configuration.adapterIdentity ?? null)) return failed('model-configuration-changed');
      const owner = ownerFor(configuration, captured.authority, captured.release);
      if (!sameScope(await owner.scope(), expectedScope)) return failed('credential-scope-changed');
      return owner;
      } catch (error) { captured.release?.(); throw error; }
    },
  };
}
