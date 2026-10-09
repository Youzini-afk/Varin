import { NativeAnthropicCredentialOwner, type AnthropicFederationSource } from './native-anthropic-auth.js';
import { NativeAwsCredentialOwner, type NativeCredentialDispatch } from './native-aws-auth.js';
import { NativeGoogleCredentialOwner } from './native-google-auth.js';
import { credentialValueResolver } from './credential-value-resolver.js';
/** Application-Host-owned credential storage and relink metadata.
 * Uses the existing AuthStorage transaction; never creates a second secret file or token hash.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { FileAuthStorageBackend, ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AuthOperationOptions, AuthResult, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

export interface HostSelectedModel { providerId: string; modelId: string; name: string; api: string; baseUrl: string; maxTokens: number; input: readonly string[]; compat?: Record<string, unknown> }
export interface HostCredentialScope { reference: string; authority: string; account: string; generation: number }
interface BindingMetadata { schema: 1; handle: string; generation: number; providerAccount?: string }
type Stored = Credential & { $varinCredentialBinding?: BindingMetadata };
export type CredentialMutationIntent = 'refresh' | 'replace';
const publicFailure = (code: string): Error => Object.assign(new Error(code), { code });
const plain = (credential: Stored | undefined): Credential | undefined => {
  if (!credential) return undefined;
  const { $varinCredentialBinding: _metadata, ...value } = credential;
  return value as Credential;
};
function metadata(value: Stored | undefined): BindingMetadata | undefined {
  const data = value?.$varinCredentialBinding;
  if (data === undefined) return undefined;
  if (data.schema !== 1 || typeof data.handle !== 'string' || !data.handle
    || !Number.isSafeInteger(data.generation) || data.generation < 1
    || (data.providerAccount !== undefined && (typeof data.providerAccount !== 'string' || !data.providerAccount))) {
    throw publicFailure('credential-metadata-invalid');
  }
  return data;
}
function providerAccount(credential: Credential): string | undefined {
  // Provider login/refresh handlers supply this metadata. Never derive it by hashing a token.
  const value = (credential as Credential & { accountId?: unknown }).accountId;
  return typeof value === 'string' && value ? value : undefined;
}
export class HostCredentialAuthority implements CredentialStore {
  readonly #intent = new AsyncLocalStorage<CredentialMutationIntent>();
  // Values are compared only in owner memory. A restart intentionally requires dynamic-source
  // rebinding; no token-derived identity or resolved secret is persisted.
  readonly #anthropicCredentials = new NativeAnthropicCredentialOwner();
  readonly #awsCredentials = new NativeAwsCredentialOwner();
  readonly #googleCredentials = new NativeGoogleCredentialOwner();
  readonly #ambientBindings = new Map<string, { value: string; handle: string; result: AuthResult }>();
  readonly #dynamicLeases = new Map<string, { source: string; value: string; handle: string }>();
  readonly #headerBindings = new Map<string, { source: string; values: Record<string, string>; handle: string; generatedAuthorization: boolean; headerOnly: boolean }>();
  readonly #store: CredentialStore;
  readonly authorityId: string;
  #runtime: Promise<ModelRuntime> | undefined;
  readonly #modelsPath: string | null;
  constructor(options: { store: CredentialStore; authorityId: string; modelsPath?: string | null }) {
    if (!options.authorityId) throw publicFailure('credential-authority-invalid');
    this.#store = options.store;
    this.#modelsPath = options.modelsPath ?? null;
    this.authorityId = options.authorityId;
  }
  static open(agentDir = getAgentDir()): HostCredentialAuthority {
    const directory = resolve(agentDir);
    return new HostCredentialAuthority({ store: new ExistingBackendCredentialStore(join(directory, 'auth.json')),
      authorityId: `varin-store-${createHash('sha256').update(directory).digest('hex')}`, modelsPath: join(directory, 'models.json') });
  }
  async #record(providerId: string, options?: AuthOperationOptions): Promise<Stored | undefined> {
    const record = await this.#store.modify(providerId, async current => {
      const value = current as Stored | undefined;
      if (!value || metadata(value)) return undefined;
      const account = providerAccount(value);
      return { ...value, $varinCredentialBinding: { schema: 1, handle: randomUUID(), generation: 1,
        ...(account ? { providerAccount: account } : {}) } } as Stored;
    }, options);
    return record as Stored | undefined;
  }
  async readRaw(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return plain(await this.#record(providerId, options));
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const value = await this.readRaw(providerId, options);
    if (value?.type !== 'api_key' || value.key === undefined) return value;
    const resolver = await credentialValueResolver();
    // Delegated Pi workers retain their existing execution environment. Native dispatch pins
    // an owner-local resolved-value lease separately; enumeration never executes a helper.
    if (resolver.isCommandConfigValue(value.key) || resolver.getConfigValueEnvVarNames(value.key).length) return value;
    const resolved = resolver.resolveConfigValue(value.key, value.env);
    const { key: _key, ...rest } = value;
    return resolved === undefined ? rest : { ...rest, key: resolved };
  }
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> { return this.#store.list(options); }
  async currentScope(providerId: string, modelId?: string): Promise<HostCredentialScope> {
    const record = await this.#record(providerId);
    const binding = metadata(record);
    const configured = this.#modelsPath
      ? await (await import('./provider-configuration.js')).configuredCredentialBinding(this.#modelsPath, providerId,
        { includeKey: !binding, ...(modelId === undefined ? {} : { modelId }) }) : undefined;
    let scope: HostCredentialScope;
    if (!binding) {
      if (!configured) {
        this.#headerBindings.delete(JSON.stringify([providerId, modelId ?? null]));
        if (await this.#isVertexAdc(providerId, modelId)) return this.#googleScope(providerId);
        if (await this.#isBedrockChain(providerId, modelId)) return this.#awsScope(providerId);
        const federation = await this.#anthropicSource(providerId, modelId);
        if (federation) return this.#anthropicScope(providerId, federation);
        return this.#ambientScope(providerId);
      }
      scope = { reference: `provider:${providerId}`, authority: `${this.authorityId}:models`,
        account: `${configured.handle}:${createHash('sha256').update(configured.revision).digest('hex')}`, generation: 1 };
      if (configured.key) scope = await this.#sourceScope(providerId, scope, configured.key);
      else if (!['authorization', 'x-goog-api-key'].some(name => configured.headers[name]) && await this.#isVertexAdc(providerId, modelId)) {
        scope = await this.#googleScope(providerId, scope);
      } else if (!configured.headers.authorization && await this.#isBedrockChain(providerId, modelId)) {
        scope = await this.#awsScope(providerId, scope);
      } else if (!['authorization', 'x-api-key'].some(name => configured.headers[name])) {
        const federation = await this.#anthropicSource(providerId, modelId);
        if (federation) scope = this.#anthropicScope(providerId, federation, scope);
      }
    } else {
      scope = { reference: `provider:${providerId}`, authority: this.authorityId, account: binding.handle, generation: binding.generation };
      if (record?.type === 'api_key') {
        if (record.key) scope = await this.#sourceScope(providerId, scope, record.key, record.env);
        else if (await this.#isVertexAdc(providerId, modelId)) scope = await this.#googleScope(providerId, scope, record.env);
        else if (await this.#isBedrockChain(providerId, modelId)) scope = await this.#awsScope(providerId, scope, record.env);
        else if ((await this.#modelRuntime()).getModels(providerId).some(model => model.api === 'bedrock-converse-stream')
          && (record.env?.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_BEARER_TOKEN_BEDROCK)) {
          scope = await this.#sourceScope(providerId, scope, '$AWS_BEARER_TOKEN_BEDROCK', record.env);
        } else {
          const federation = await this.#anthropicSource(providerId, modelId, record.env);
          if (!federation) throw publicFailure('credential-source-binding-required');
          scope = this.#anthropicScope(providerId, federation, scope);
        }
      }
    }
    const id = JSON.stringify([providerId, modelId ?? null]);
    if (!configured || !Object.keys(configured.headers).length) { this.#headerBindings.delete(id); return scope; }
    // A stored credential with configured headers has TWO credential sources. Only these
    // bindings include the models-file revision; unrelated ordinary stored keys stay stable.
    if (binding) scope = { ...scope, account: `${scope.account}:headers:${configured.handle}:${createHash('sha256').update(configured.revision).digest('hex')}` };
    const resolver = await credentialValueResolver();
    const values: Record<string, string> = Object.create(null);
    const env = record && typeof record.env === 'object' && record.env !== null ? record.env as Record<string, string> : undefined;
    let dynamic = false;
    for (const name of Object.keys(configured.headers).sort()) {
      const expression = configured.headers[name]!;
      dynamic ||= resolver.isCommandConfigValue(expression) || resolver.getConfigValueEnvVarNames(expression).length > 0;
      let value: string | undefined;
      try { value = resolver.resolveConfigValueUncached(expression, env); }
      catch { throw publicFailure('credential-source-resolution-failed'); }
      if (value === undefined) throw publicFailure('credential-source-resolution-failed');
      try { values[name] = new Headers([[name, value]]).get(name)!; }
      catch { throw publicFailure('configured-header-invalid'); }
    }
    const source = JSON.stringify(scope);
    const old = this.#headerBindings.get(id);
    const handle = old?.source === source && JSON.stringify(old.values) === JSON.stringify(values) ? old.handle : randomUUID();
    if (dynamic) scope = { ...scope, account: `${scope.account}:header-lease:${handle}` };
    this.#headerBindings.set(id, { source, values, handle, headerOnly: !binding && configured.key === undefined && !scope.account.includes(':adc:') && !scope.account.includes(':aws:') && !scope.account.includes(':federation:'), generatedAuthorization: configured.generatedAuthorization });
    return scope;
  }
  async #anthropicSource(providerId: string, modelId?: string, env?: Record<string, string>): Promise<AnthropicFederationSource | undefined> {
    // The locked SDK enables this first-party exchange only for Anthropic, never a custom
    // provider that happens to speak Messages. Resolved key/bearer sources retain precedence.
    if (providerId !== 'anthropic' || ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .some(name => env?.[name] || process.env[name])) return undefined;
    const runtime = await this.#modelRuntime();
    const model = modelId ? runtime.getModel(providerId, modelId) : runtime.getModels(providerId)[0];
    if (model?.api !== 'anthropic-messages') return undefined;
    return this.#anthropicCredentials.source(model.baseUrl, env);
  }
  #anthropicScope(providerId: string, source: AnthropicFederationSource, scope?: HostCredentialScope): HostCredentialScope {
    return scope ? { ...scope, account: `${scope.account}:federation:${source.identity}` }
      : { reference: `provider:${providerId}`, authority: `${this.authorityId}:anthropic-federation`, account: source.identity, generation: 1 };
  }
  /** The locked Messages adapter selects the Claude subscription wire contract by token kind. */
  async anthropicAuthentication(providerId: string, modelId?: string): Promise<'oauth' | 'api-key'> {
    if (providerId === 'github-copilot') return 'api-key';
    const stored = await this.readRaw(providerId);
    let key: string | undefined;
    if (stored?.type === 'oauth') key = typeof stored.access === 'string' ? stored.access : undefined;
    else if (stored?.type === 'api_key') {
      if (stored.key) key = (await credentialValueResolver()).resolveConfigValue(stored.key, stored.env);
    } else {
      const configured = this.#modelsPath ? await (await import('./provider-configuration.js'))
        .configuredCredentialBinding(this.#modelsPath, providerId, modelId === undefined ? {} : { modelId }) : undefined;
      if (configured?.key) key = (await credentialValueResolver()).resolveConfigValue(configured.key);
      else if (providerId === 'anthropic' && !process.env.ANTHROPIC_AUTH_TOKEN) {
        key = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
      }
    }
    return key?.includes('sk-ant-oat') ? 'oauth' : 'api-key';
  }
  async #nativeAuthResult(providerId: string, modelId: string | undefined, result: AuthResult | undefined): Promise<AuthResult | undefined> {
    if (!result?.auth.apiKey?.includes('sk-ant-oat') || providerId === 'github-copilot') return result;
    const runtime = await this.#modelRuntime();
    const model = modelId ? runtime.getModel(providerId, modelId) : runtime.getModels(providerId)[0];
    if (model?.api !== 'anthropic-messages') return result;
    // Defaults match the locked SDK's Claude OAuth client; explicit configured headers win.
    const headers = new Headers({ authorization: `Bearer ${result.auth.apiKey}`, accept: 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true', 'user-agent': 'claude-cli/2.1.280', 'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' });
    for (const [name, value] of Object.entries(result.auth.headers ?? {})) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    return { ...result, auth: { ...result.auth, headers: Object.fromEntries(headers) } };
  }
  async #isBedrockChain(providerId: string, modelId?: string): Promise<boolean> {
    const runtime = await this.#modelRuntime();
    const models = modelId ? [runtime.getModel(providerId, modelId)] : runtime.getModels(providerId);
    if (!models.some(model => model?.api === 'bedrock-converse-stream')) return false;
    const stored = await this.readRaw(providerId);
    if (stored && (stored.type !== 'api_key' || stored.key)) return false;
    return !(stored?.type === 'api_key' && stored.env?.AWS_BEARER_TOKEN_BEDROCK) && !process.env.AWS_BEARER_TOKEN_BEDROCK;
  }
  async #awsScope(providerId: string, scope?: HostCredentialScope, env?: Record<string, string>): Promise<HostCredentialScope> {
    const source = await this.#awsCredentials.source(providerId, env);
    return scope ? { ...scope, account: `${scope.account}:aws:${source.identity}` }
      : { reference: `provider:${providerId}`, authority: `${this.authorityId}:aws`, account: source.identity, generation: 1 };
  }
  async #isVertexAdc(providerId: string, modelId?: string): Promise<boolean> {
    const runtime = await this.#modelRuntime();
    const models = modelId ? [runtime.getModel(providerId, modelId)] : runtime.getModels(providerId);
    if (!models.some(model => model?.api === 'google-vertex')) return false;
    const stored = await this.readRaw(providerId);
    if (stored) return stored.type === 'api_key' && !stored.key;
    return !process.env.GOOGLE_CLOUD_API_KEY;
  }
  async #googleScope(providerId: string, scope?: HostCredentialScope, env?: Record<string, string>): Promise<HostCredentialScope> {
    const source = await this.#googleCredentials.source(env);
    return scope ? { ...scope, account: `${scope.account}:adc:${source.identity}` }
      : { reference: `provider:${providerId}`, authority: `${this.authorityId}:google-adc`, account: source.identity, generation: 1 };
  }
  /** Routing needs the auth mode, never token material, before a native request is admitted. */
  async vertexAuthentication(providerId: string, modelId?: string): Promise<'api-key' | 'adc'> {
    const stored = await this.readRaw(providerId);
    if (stored?.type === 'api_key' && stored.key) return 'api-key';
    if (!stored && this.#modelsPath) {
      const configured = await (await import('./provider-configuration.js')).configuredCredentialBinding(this.#modelsPath, providerId, modelId === undefined ? {} : { modelId });
      if (configured?.key || configured?.headers['x-goog-api-key']) return 'api-key';
    }
    return await this.#isVertexAdc(providerId, modelId) ? 'adc' : 'api-key';
  }
  async #ambientScope(providerId: string): Promise<HostCredentialScope> {
    const runtime = await this.#modelRuntime();
    const result = await this.#intent.run('refresh', () => runtime.getAuth(providerId));
    if (!result) throw publicFailure('credential-missing');
    // Bedrock's SDK transports an ambient bearer separately from ModelAuth. Bring only that
    // documented bearer mode into the private header seam; IAM signing is a separate owner.
    if (providerId === 'amazon-bedrock' && result.source === 'AWS_BEARER_TOKEN_BEDROCK') {
      const key = process.env.AWS_BEARER_TOKEN_BEDROCK;
      if (key) result.auth = { ...result.auth, apiKey: key };
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.auth.headers ?? {})) if (value !== null) headers.set(name, value);
    if (!result.auth.apiKey && !['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].some(name => headers.has(name))) {
      throw publicFailure('credential-cloud-adapter-required');
    }
    // Ambient values have no durable account record. Pin their exact resolved auth only in
    // owner memory; rotations and owner restart require an explicit new native selection.
    const value = JSON.stringify(result.auth);
    let lease = this.#ambientBindings.get(providerId);
    if (!lease || lease.value !== value) {
      lease = { value, handle: randomUUID(), result };
      this.#ambientBindings.set(providerId, lease);
    }
    return { reference: `provider:${providerId}`, authority: `${this.authorityId}:ambient`, account: lease.handle, generation: 1 };
  }
  async #sourceScope(providerId: string, scope: HostCredentialScope, expression: string, env?: Record<string, string>): Promise<HostCredentialScope> {
    const resolver = await credentialValueResolver();
    if (!resolver.isCommandConfigValue(expression) && !resolver.getConfigValueEnvVarNames(expression).length) return scope;
    let value: string | undefined;
    try { value = resolver.resolveConfigValue(expression, env); }
    catch { throw publicFailure('credential-source-resolution-failed'); }
    if (!value) throw publicFailure('credential-missing');
    const source = JSON.stringify(scope);
    let lease = this.#dynamicLeases.get(providerId);
    if (!lease || lease.source !== source || lease.value !== value) {
      lease = { source, value, handle: randomUUID() };
      this.#dynamicLeases.set(providerId, lease);
    }
    return { ...scope, account: `${scope.account}:lease:${lease.handle}` };
  }
  async currentProviderAccount(providerId: string): Promise<string | undefined> {
    return metadata(await this.#record(providerId))?.providerAccount;
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.modifyWithIntent(providerId, this.#intent.getStore() ?? 'replace', fn, options);
  }
  async modifyWithIntent(providerId: string, intent: CredentialMutationIntent,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const result = await this.#store.modify(providerId, async current => {
      const old = current as Stored | undefined;
      const oldMetadata = metadata(old);
      const next = await fn(plain(old));
      if (next === undefined) {
        if (!old || oldMetadata) return undefined;
        return { ...old, $varinCredentialBinding: { schema: 1, handle: randomUUID(), generation: 1,
          ...(providerAccount(old) ? { providerAccount: providerAccount(old) } : {}) } } as Stored;
      }
      if (next.type !== 'api_key' && next.type !== 'oauth') throw publicFailure('credential-type-invalid');
      if (intent === 'refresh' && (old?.type !== 'oauth' || next.type !== 'oauth')) throw publicFailure('credential-refresh-type-changed');
      const incomingAccount = providerAccount(next);
      const account = intent === 'refresh' ? incomingAccount ?? oldMetadata?.providerAccount : incomingAccount;
      const changedAccount = Boolean(incomingAccount && oldMetadata?.providerAccount && incomingAccount !== oldMetadata.providerAccount);
      const increment = intent === 'replace' || changedAccount;
      const generation = oldMetadata ? oldMetadata.generation + (increment ? 1 : 0) : 1;
      if (!Number.isSafeInteger(generation)) throw publicFailure('credential-generation-exhausted');
      // Credential and nonsecret relink metadata are one atomic existing-store modification.
      return { ...next, $varinCredentialBinding: { schema: 1, handle: oldMetadata?.handle ?? randomUUID(), generation,
        ...(account ? { providerAccount: account } : {}) } } as Stored;
    }, options);
    if (intent === 'replace') this.#dynamicLeases.delete(providerId);
    return plain(result as Stored | undefined);
  }
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#store.delete(providerId, options); this.#dynamicLeases.delete(providerId);
  }
  async #modelRuntime(): Promise<ModelRuntime> {
    this.#runtime ??= ModelRuntime.create({ credentials: this, modelsPath: this.#modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    return this.#runtime;
  }
  /** Existing SDK resolution uses this SAME authority; no independent authPath store is opened. */
  async getAuth(providerId: string, modelId?: string, dispatch?: NativeCredentialDispatch): Promise<AuthResult | undefined> {
    const scope = await this.currentScope(providerId, modelId);
    if (scope.authority === `${this.authorityId}:ambient`) return this.#nativeAuthResult(providerId, modelId, this.#ambientBindings.get(providerId)!.result);
    const headerBinding = this.#headerBindings.get(JSON.stringify([providerId, modelId ?? null]));
    const lease = this.#dynamicLeases.get(providerId);
    const pinned = lease && scope.account.includes(`:lease:${lease.handle}`) ? lease.value : undefined;
    const stored = await this.readRaw(providerId);
    const runtime = await this.#modelRuntime();
    // Refresh registered configuration before dispatch; the owner checks the pinned source
    // revision again after resolution, so an edit cannot send a key under an old binding.
    await runtime.refresh({ allowNetwork: false });
    // Passing the pinned value prevents the SDK's configured-key path from executing an
    // uncached helper a second time and returning another account under this lease identity.
    const overrides = pinned === undefined ? {} : { apiKey: pinned, ...(stored?.type === 'api_key' ? { env: stored.env } : {}) };
    const model = modelId ? runtime.getModel(providerId, modelId) : undefined;
    if (modelId && !model) throw publicFailure('registered-model-not-found');
    // A header-only custom connection has no SDK API-key/OAuth resolution. Its configured
    // headers are already resolved and pinned by this same owner, with no ambient fallback.
    const headerOnly = !stored && headerBinding?.headerOnly ? headerBinding : undefined;
    if (headerOnly) {
      if (headerOnly.generatedAuthorization) throw publicFailure('configured-authorization-key-required');
      return { auth: { headers: { ...headerOnly.values } }, source: 'configured headers' };
    }
    let result: AuthResult | undefined;
    if (scope.authority === `${this.authorityId}:anthropic-federation` || scope.account.includes(':federation:')) {
      if (headerBinding?.generatedAuthorization) throw publicFailure('configured-authorization-key-required');
      const source = await this.#anthropicSource(providerId, modelId, stored?.type === 'api_key' ? stored.env : undefined);
      if (!source || (scope.account !== source.identity && !scope.account.includes(`:federation:${source.identity}`))) {
        throw publicFailure('anthropic-federation-source-changed');
      }
      const headers = await this.#anthropicCredentials.headers(source);
      const configuredBeta = headerBinding?.values['anthropic-beta'];
      const beta = [...new Set([...(configuredBeta?.split(',').map(value => value.trim()).filter(Boolean) ?? []), headers['anthropic-beta']!])].join(',');
      result = { auth: { headers: { ...headers, ...headerBinding?.values, 'anthropic-beta': beta } }, source: 'Anthropic federation' };
    } else if (scope.authority === `${this.authorityId}:aws` || scope.account.includes(':aws:')) {
      if (!dispatch) throw publicFailure('aws-signed-request-required');
      if (headerBinding?.generatedAuthorization) throw publicFailure('configured-authorization-key-required');
      const source = await this.#awsCredentials.source(providerId, stored?.type === 'api_key' ? stored.env : undefined);
      if (scope.account !== source.identity && !scope.account.includes(`:aws:${source.identity}`)) throw publicFailure('credential-source-changed');
      const region = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/.exec(modelId ?? '')?.[1];
      const headers = await this.#awsCredentials.sign(source, dispatch, headerBinding?.values ?? {}, region);
      result = { auth: { headers }, source: 'AWS SigV4' };
    } else if (scope.authority === `${this.authorityId}:google-adc` || scope.account.includes(':adc:')) {
      if (headerBinding?.generatedAuthorization) throw publicFailure('configured-authorization-key-required');
      const source = await this.#googleCredentials.source(stored?.type === 'api_key' ? stored.env : undefined);
      if (scope.account !== source.identity && !scope.account.includes(`:adc:${source.identity}`)) throw publicFailure('credential-source-changed');
      const headers = await this.#googleCredentials.headers(source);
      result = { auth: { headers: { ...headers, ...headerBinding?.values } },
        ...(stored?.type === 'api_key' && stored.env ? { env: stored.env } : {}), source: 'Google ADC' };
    } else {
      result = await this.#intent.run('refresh', () => model ? runtime.getAuth(model, overrides) : runtime.getAuth(providerId, overrides));
    }
    if (result && headerBinding) {
      const actual = new Headers();
      for (const [name, value] of Object.entries(result.auth.headers ?? {})) if (value !== null) actual.set(name, value);
      for (const [name, value] of Object.entries(headerBinding.values)) {
        if (name === 'authorization' && headerBinding.generatedAuthorization) continue;
        if (name === 'anthropic-beta' && result.source === 'Anthropic federation') {
          const actualValues = new Set(actual.get(name)?.split(',').map(value => value.trim()));
          if (value.split(',').map(value => value.trim()).filter(Boolean).every(value => actualValues.has(value))) continue;
        }
        // Header helpers follow the SDK's uncached semantics. If a helper changes account
        // between binding and dispatch, do not send its result with the old opaque snapshot.
        if (actual.get(name) !== value) throw publicFailure('credential-source-changed');
      }
    }
    return this.#nativeAuthResult(providerId, modelId, result);
  }
  async selectedModel(providerId: string, modelId: string): Promise<HostSelectedModel> {
    const runtime = await this.#modelRuntime();
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel(providerId, modelId);
    if (!model) throw publicFailure('registered-model-not-found');
    return { providerId, modelId: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl,
      maxTokens: model.maxTokens, input: model.input, ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}) };
  }
  async listModels(): Promise<HostSelectedModel[]> {
    const runtime = await this.#modelRuntime();
    await runtime.refresh({ allowNetwork: false });
    const configured = new Set((await this.list()).map(entry => entry.providerId));
    const models = runtime.getModels();
    const configuredModels = this.#modelsPath
      ? await (await import('./provider-configuration.js')).configuredCredentialModels(this.#modelsPath, models) : new Set<string>();
    return models.filter(model => configured.has(model.provider) || runtime.hasConfiguredAuth(model.provider)
      || configuredModels.has(JSON.stringify([model.provider, model.id]))).map(model => ({ providerId: model.provider,
        modelId: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl, maxTokens: model.maxTokens, input: model.input,
        ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}) }));
  }
  async routingEnvironment(providerId: string): Promise<Record<string, string>> {
    const credential = await this.readRaw(providerId);
    const stored = credential?.type === 'api_key' ? credential.env : undefined;
    const names = ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
      'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION'];
    const result: Record<string, string> = Object.create(null);
    for (const name of names) { const value = stored?.[name] ?? process.env[name]; if (value) result[name] = value; }
    if (await this.#isBedrockChain(providerId)) {
      const source = await this.#awsCredentials.source(providerId, stored);
      result.AWS_REGION = await this.#awsCredentials.region(source);
    }
    return result;
  }
}

/** Reuses the existing SDK lock authority and path, replacing its truncating writes with an
 * atomic same-file replacement. There is no parallel credential cache or journal store.
 */
export class ExistingBackendCredentialStore implements CredentialStore {
  readonly #backend: FileAuthStorageBackend;
  readonly #path: string;
  constructor(path: string) { this.#path = path; this.#backend = new FileAuthStorageBackend(path); }
  #parse(content: string | undefined): Record<string, Credential> {
    if (content === undefined) return {};
    let value: unknown;
    try { value = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw publicFailure('credential-store-corrupt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw publicFailure('credential-store-corrupt');
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== 'object' || !['api_key', 'oauth'].includes((entry as { type?: string }).type ?? '')) throw publicFailure('credential-store-corrupt');
    }
    return value as Record<string, Credential>;
  }
  async #syncDirectory(): Promise<void> {
    // Windows does not support opening directories through this API; file replacement remains
    // atomic there, while the Unix path also flushes the containing directory entry.
    if (process.platform === 'win32') return;
    const directory = await fs.open(dirname(this.#path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async #write(value: Record<string, Credential>): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const original = await fs.stat(this.#path);
    const handle = await fs.open(temporary, 'wx', original.mode & 0o777);
    try {
      // Creation applies umask; restore the existing mode rather than silently changing it.
      await handle.chmod(original.mode & 0o777);
      if (process.platform !== 'win32') {
        const created = await handle.stat();
        if (created.uid !== original.uid || created.gid !== original.gid) await handle.chown(original.uid, original.gid);
      }
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, this.#path);
      await this.#syncDirectory();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async #locked<T>(fn: (current: Record<string, Credential>) => Promise<{ result: T; next?: Record<string, Credential> }>, options?: AuthOperationOptions): Promise<T> {
    return this.#backend.withLockAsync(async content => {
      const current = this.#parse(content);
      const { result, next } = await fn(current);
      if (next) await this.#write(next);
      // Deliberately omit SDK `next`: the existing lock remains held through our atomic commit.
      return { result };
    }, options);
  }
  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#locked(async current => ({ result: current[providerId] }), options);
  }
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#locked(async current => ({ result: Object.entries(current).map(([providerId, credential]) => ({ providerId, type: credential.type })) }), options);
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#locked(async current => {
      const next = await fn(current[providerId]);
      return next === undefined ? { result: current[providerId] } : { result: next, next: { ...current, [providerId]: next } };
    }, options);
  }
  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#locked(async current => { const next = { ...current }; delete next[providerId]; return { result: undefined, next }; }, options);
  }
}

const sharedAuthorities = new Map<string, HostCredentialAuthority>();
/** One authority per configured store in the Application Host process, shared across runtimes. */
export function sharedHostCredentialAuthority(agentDir = getAgentDir()): HostCredentialAuthority {
  const directory = resolve(agentDir);
  let authority = sharedAuthorities.get(directory);
  if (!authority) { authority = HostCredentialAuthority.open(directory); sharedAuthorities.set(directory, authority); }
  return authority;
}

export { CredentialStoreServer } from "./credential-store-rpc.js";
