/** Trusted catalog -> native model binding. Renderer input consists only of registered IDs. */
import { createHash } from 'node:crypto';
import { ExistingHostCredentialOwner, type ExistingModelAuthRuntime, type NativeCredentialScope } from './native-credential-owner.js';
import type { NativeModelSessionConfiguration } from './protocol.generated.js';
interface SelectedModel { providerId: string; modelId: string; name: string; api: string; baseUrl: string; maxTokens: number; compat?: Record<string, unknown> }
interface ModelAuthority extends ExistingModelAuthRuntime {
  selectedModel(providerId: string, modelId: string): Promise<SelectedModel>;
  listModels(): Promise<SelectedModel[]>;
  currentScope(providerId: string): Promise<NativeCredentialScope>;
  currentProviderAccount(providerId: string): Promise<string | undefined>;
  routingEnvironment(providerId: string): Promise<Record<string, string>>;
}
const families = new Set(['openai-responses', 'openai-completions', 'anthropic-messages', 'azure-openai-responses',
  'google-generative-ai', 'google-vertex', 'mistral-conversations', 'openai-codex-responses']);
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
      const url = trustedUrl(model.baseUrl);
      switch (model.api) {
        case 'openai-responses': endpoint = append(url, 'responses'); break;
        case 'openai-completions': endpoint = append(url, 'chat/completions'); break;
        case 'anthropic-messages': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/v1') ? 'messages' : 'v1/messages'); break;
        case 'mistral-conversations': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/v1') ? 'chat/completions' : 'v1/chat/completions'); break;
        case 'openai-codex-responses': endpoint = append(url, url.pathname.replace(/\/+$/, '').endsWith('/codex') ? 'responses' : 'codex/responses'); break;
        case 'google-generative-ai':
          endpoint = append(url, `models/${encodeURIComponent(model.modelId.replace(/^models\//, ''))}:streamGenerateContent`); break;
        case 'google-vertex':
          // Cloud project/location/ADC routing must be explicitly registered by the cloud owner.
          if (!url.pathname.endsWith(':streamGenerateContent')) return failed('native-vertex-endpoint-binding-required');
          endpoint = url.toString(); break;
        default: return failed('native-model-protocol-unavailable');
      }
    }
    const max = model.api === 'openai-codex-responses' ? null
      : Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;
    if (model.api === 'anthropic-messages' && max === null) return failed('native-anthropic-output-capacity-required');
    const legacy = model.compat?.maxTokensField === 'max_tokens';
    const streamUsage = model.compat?.supportsUsageInStreaming !== false;
    const generation = Number.parseInt(createHash('sha256').update(JSON.stringify({ providerId: model.providerId,
      family: model.api, model: model.modelId, endpoint, max, deployment, apiVersion, legacy, streamUsage })).digest('hex').slice(0, 12), 16);
    return { providerId: model.providerId, providerFamily: model.api, model: model.modelId, endpoint,
      credentialEnvironment: null, allowAnonymous: false, configurationGeneration: generation, maxOutputTokens: max,
      ...(deployment ? { azureDeployment: deployment } : {}), ...(apiVersion ? { azureApiVersion: apiVersion } : {}),
      ...(model.api === 'openai-completions' ? { legacyMaxTokens: legacy, includeStreamUsage: streamUsage } : {}) };
  }
  function ownerFor(configuration: NativeModelSessionConfiguration): ExistingHostCredentialOwner {
    const providerId = configuration.providerId || failed('native-provider-identity-required');
    return new ExistingHostCredentialOwner({ runtime: authority, providerId,
      providerFamily: configuration.providerFamily, endpoint: configuration.endpoint,
      currentScope: () => authority.currentScope(providerId),
      currentProviderAccount: () => authority.currentProviderAccount(providerId) });
  }
  return {
    async listModels(): Promise<Array<{ providerId: string; modelId: string; name?: string }>> {
      return (await authority.listModels()).filter(model => families.has(model.api))
        .map(model => ({ providerId: model.providerId, modelId: model.modelId, name: model.name }));
    },
    async resolveModel(selection: { providerId: string; modelId: string }) {
      const model = await authority.selectedModel(selection.providerId, selection.modelId);
      const configuration = await configurationFor(model);
      const credentialOwner = ownerFor(configuration);
      await credentialOwner.scope();
      return { configuration, credentialOwner };
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
