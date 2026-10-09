/** Trusted catalog -> native model binding. Renderer input consists only of registered IDs. */
import { createHash } from 'node:crypto';
import { ExistingHostCredentialOwner, type ExistingModelAuthRuntime, type NativeCredentialScope, type NativeCredentialDispatch } from './native-credential-owner.js';
import type { NativeModelSessionConfiguration } from './protocol.generated.js';
interface SelectedModel { providerId: string; modelId: string; name: string; api: string; baseUrl: string; maxTokens: number; input?: readonly string[]; compat?: Record<string, unknown> }
interface ModelAuthority extends ExistingModelAuthRuntime {
  selectedModel(providerId: string, modelId: string): Promise<SelectedModel>;
  listModels(): Promise<SelectedModel[]>;
  getAuth(providerId: string, modelId?: string, dispatch?: NativeCredentialDispatch): ReturnType<ExistingModelAuthRuntime['getAuth']>;
  currentScope(providerId: string, modelId?: string): Promise<NativeCredentialScope>;
  currentProviderAccount(providerId: string): Promise<string | undefined>;
  routingEnvironment(providerId: string): Promise<Record<string, string>>;
  vertexAuthentication?(providerId: string, modelId?: string): Promise<'api-key' | 'adc'>;
}
const families = new Set(['openai-responses', 'openai-completions', 'anthropic-messages', 'azure-openai-responses',
  'google-generative-ai', 'google-vertex', 'mistral-conversations', 'openai-codex-responses', 'bedrock-converse-stream']);
const failed = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function trustedUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { return failed('native-model-endpoint-missing'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return failed('native-model-endpoint-invalid');
  for (const key of url.searchParams.keys()) {
    if (/^(key|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|signature|sig)$/i.test(key)) return failed('native-model-endpoint-contains-credentials');
  }
  return url;
}
function append(url: URL, suffix: string): string {
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(`/${suffix}`)) url.pathname = `${path}/${suffix}`;
  return url.toString();
}
function sameScope(left: NativeCredentialScope, right: NativeCredentialScope): boolean {
  return left.reference === right.reference && left.authority === right.authority && left.account === right.account && left.generation === right.generation;
}
export function createNativeModelAuthority(authority: ModelAuthority) {
  async function configurationFor(model: SelectedModel): Promise<NativeModelSessionConfiguration> {
    if (!families.has(model.api)) return failed('native-model-protocol-unavailable');
    const env = await authority.routingEnvironment(model.providerId);
    const vertexAdc = model.api === 'google-vertex' && await authority.vertexAuthentication?.(model.providerId, model.modelId) === 'adc';
    const vertexDefault = model.api === 'google-vertex' && (!model.baseUrl.trim() || model.baseUrl.includes('{location}'));
    const vertexLocation = env.GOOGLE_CLOUD_LOCATION;
    const vertexProject = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
    if (vertexAdc && vertexDefault && (!vertexLocation || !vertexProject)) return failed('native-vertex-project-location-required');
    if (vertexAdc && vertexDefault && !/^[a-z0-9-]+$/.test(vertexLocation!)) return failed('native-vertex-location-invalid');
    let endpoint: string; let deployment: string | undefined; let apiVersion: string | undefined;
    if (model.api === 'azure-openai-responses') {
      const base = env.AZURE_OPENAI_BASE_URL || (env.AZURE_OPENAI_RESOURCE_NAME
        ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : model.baseUrl);
      const url = trustedUrl(base);
      if (['', '/', '/openai'].includes(url.pathname)) url.pathname = '/openai/v1';
      endpoint = append(url, 'responses');
      for (const entry of (env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? '').split(',')) {
        const equal = entry.indexOf('=');
        if (equal > 0 && entry.slice(0, equal).trim() === model.modelId) deployment = entry.slice(equal + 1).trim();
      }
      if (!deployment) return failed('native-azure-deployment-required');
      apiVersion = env.AZURE_OPENAI_API_VERSION || 'v1';
    } else {
      const url = trustedUrl(vertexDefault
        ? vertexAdc && vertexLocation !== 'global' ? `https://${vertexLocation}-aiplatform.googleapis.com`
          : 'https://aiplatform.googleapis.com' : model.baseUrl);
      switch (model.api) {
        case 'openai-responses': endpoint = append(url, 'responses'); break;
        case 'openai-completions': endpoint = append(url, 'chat/completions'); break;
        case 'anthropic-messages': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/v1') ? 'messages' : 'v1/messages'); break;
        case 'mistral-conversations': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/v1') ? 'chat/completions' : 'v1/chat/completions'); break;
        case 'openai-codex-responses': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/codex') ? 'responses' : 'codex/responses'); break;
        case 'bedrock-converse-stream': {
          // Preserve explicit VPC/proxy endpoints. Standard catalog endpoints use the selected
          // model ARN's region, then the owner's explicit region, matching the existing SDK.
          const region = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/.exec(model.modelId)?.[1]
            || env.AWS_REGION || env.AWS_DEFAULT_REGION;
          if (region && /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname)) {
            if (!/^[a-z0-9-]+$/.test(region)) return failed('native-bedrock-region-invalid');
            url.hostname = `bedrock-runtime.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
          }
          endpoint = append(url, `model/${encodeURIComponent(model.modelId)}/converse-stream`); break;
        }
        case 'google-generative-ai':
          endpoint = append(url, `models/${encodeURIComponent(model.modelId.replace(/^models\//, ''))}:streamGenerateContent`); break;
        case 'google-vertex': {
          // Cloud API keys use express mode; ADC uses the selected project/location. A custom collection
          // base URL retains its path, matching the SDK's ResourceScope.COLLECTION contract.
          if (url.pathname.endsWith(':streamGenerateContent')) { endpoint = url.toString(); break; }
          if (!url.pathname.split('/').some(part => /^v\d+(?:beta\d*)?$/.test(part))) append(url, 'v1');
          let modelPath = /^(publishers|projects|models)\//.test(model.modelId) ? model.modelId
            : model.modelId.includes('/') ? `publishers/${model.modelId.split('/')[0]}/models/${model.modelId.split('/')[1]}`
              : `publishers/google/models/${model.modelId}`;
          if (vertexAdc && vertexDefault && !modelPath.startsWith('projects/')) {
            modelPath = `projects/${vertexProject}/locations/${vertexLocation}/${modelPath}`;
          }
          endpoint = append(url, `${modelPath.split('/').map(encodeURIComponent).join('/')}:streamGenerateContent`); break;
        }
        default: return failed('native-model-protocol-unavailable');
      }
    }
    const max = model.api === 'openai-codex-responses' ? null
      : Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;
    if (model.api === 'anthropic-messages' && max === null) return failed('native-anthropic-output-capacity-required');
    const acceptsImages = model.input?.includes('image') ?? false;
    const legacy = model.compat?.maxTokensField === 'max_tokens';
    const streamUsage = model.compat?.supportsUsageInStreaming !== false;
    const generation = Number.parseInt(createHash('sha256').update(JSON.stringify({ providerId: model.providerId,
      family: model.api, model: model.modelId, endpoint, max, deployment, apiVersion, legacy, streamUsage, acceptsImages })).digest('hex').slice(0, 12), 16);
    return { providerId: model.providerId, providerFamily: model.api, model: model.modelId, endpoint,
      credentialEnvironment: null, allowAnonymous: false, acceptsImages, configurationGeneration: generation, maxOutputTokens: max,
      ...(deployment ? { azureDeployment: deployment } : {}), ...(apiVersion ? { azureApiVersion: apiVersion } : {}),
      ...(model.api === 'openai-completions' ? { legacyMaxTokens: legacy, includeStreamUsage: streamUsage } : {}) };
  }
  function ownerFor(configuration: NativeModelSessionConfiguration): ExistingHostCredentialOwner {
    const providerId = configuration.providerId || failed('native-provider-identity-required');
    return new ExistingHostCredentialOwner({ runtime: { getAuth: (provider) => authority.getAuth(provider, configuration.model),
      resolveRequest: (provider, dispatch) => authority.getAuth(provider, configuration.model, dispatch) }, providerId,
      providerFamily: configuration.providerFamily, endpoint: configuration.endpoint,
      currentScope: () => authority.currentScope(providerId, configuration.model),
      currentProviderAccount: () => authority.currentProviderAccount(providerId) });
  }
  return {
    async listModels(): Promise<Array<{ providerId: string; modelId: string; name?: string; acceptsImages: boolean }>> {
      return (await authority.listModels()).filter(model => families.has(model.api))
        .map(model => ({ providerId: model.providerId, modelId: model.modelId, name: model.name, acceptsImages: model.input?.includes('image') ?? false }));
    },
    async resolveModel(selection: { providerId: string; modelId: string }) {
      const model = await authority.selectedModel(selection.providerId, selection.modelId);
      const configuration = await configurationFor(model);
      const credentialOwner = ownerFor(configuration);
      await credentialOwner.scope();
      return { configuration, credentialOwner, acceptsImages: configuration.acceptsImages ?? false };
    },
    async rebindModel(configuration: NativeModelSessionConfiguration, expectedScope: NativeCredentialScope) {
      if (!expectedScope) return failed('native-credential-selection-missing');
      const providerId = configuration.providerId || failed('native-provider-identity-required');
      const current = await configurationFor(await authority.selectedModel(providerId, configuration.model));
      if (current.configurationGeneration !== configuration.configurationGeneration || current.endpoint !== configuration.endpoint
        || current.providerFamily !== configuration.providerFamily) return failed('native-model-configuration-changed');
      const owner = ownerFor(configuration);
      if (!sameScope(await owner.scope(), expectedScope)) return failed('credential-scope-changed');
      return owner;
    },
  };
}
