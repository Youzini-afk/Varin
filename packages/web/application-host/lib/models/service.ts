import { join } from 'node:path';
import type { ModelChannel, ModelConnectionOptions, ChannelModel, ModelConnectionsSnapshot, ModelOperation, ConnectionAuthentication } from '@varin/application-client';
import { imageModelInfo, imageToolContract, type ImageModelInfo, type ImageToolPurpose } from '@varin/protocol';
import { embeddingRequestUrl } from '@varin/protocol/node/embeddings';
import { ChannelTypes, type ChannelType } from './channel-types.js';
import { ConfigurationFile, ModelConfigurationError, object, revisionOf } from './configuration.js';
import { CredentialService, fileSecretStore, type ResolvedCredential } from './credentials.js';
import { AgentSettingsService } from './settings.js';
import { compileToolJsonSchema } from './schema.js';
import { appendModelPath, modelEgressOverride, validateModelConnection } from './connection.js';
import type { EgressFetch, EgressOverride } from '../harness/egress.js';
import { AwsCredentialOwner } from './aws-auth.js';
import { GoogleCredentialOwner } from './google-auth.js';
import { AnthropicCredentialOwner, validateAnthropicFederation } from './anthropic-auth.js';
import { rerankRequestUrl } from './rerank.js';
import { modelOAuthProviders, type ModelOAuthProvider } from './oauth.js';
import { AuthorizationFlows } from '../authorization-flows.js';
import { ConfigWatchManager } from '../configuration-watch.js';
import type { CredentialScope, CredentialDispatch } from '../kernel/credential-owner.js';
import type { SelectedModel, ModelExecutionAuthority } from '../kernel/model-authority.js';

export interface InferenceProviderBinding {
  providerId: string; modelId: string; baseUrl: string; endpoint?: string; requestUrl: string; api: string;
  configurationId: string; credentialRef: string; credentialScope: CredentialScope; allowAnonymous?: boolean;
  routes: readonly { requestUrl: string; requestKind: 'model_compute' | 'preparation' }[];
  imageModel?: ImageModelInfo;
  requestModelId?: string;
  connection?: ModelConnectionOptions;
  headers?: Record<string, string>;
  egressOverride?: EgressOverride;
  assertAvailable(): Promise<void>;
  currentScope(): Promise<CredentialScope>;
  getAuth(): Promise<ResolvedCredential | undefined>;
  /** Captured authentication implementation, retained by the original purpose lease. */
  retain?(): () => void;
  release?(): void;
}
interface ModelsDocument extends Record<string, unknown> { channels: ModelChannel[] }
const fail = (code: string, message: string): never => { throw new ModelConfigurationError(code, message); };
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sameScope = (a: CredentialScope, b: CredentialScope) => a.authority === b.authority && a.reference === b.reference && a.account === b.account && a.generation === b.generation;
function endpoint(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return fail('model-endpoint-invalid', 'Enter a complete model endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return fail('model-endpoint-invalid', 'Use an HTTP endpoint without embedded credentials');
  return url;
}

/** Shared model configuration and immutable execution selections for this Application Host. */
export class ModelsService {
  readonly types = new ChannelTypes();
  readonly credentials: CredentialService;
  readonly settings: AgentSettingsService;
  readonly file: ConfigurationFile<ModelsDocument>;
  readonly credentialPath: string;
  readonly #aws = new AwsCredentialOwner();
  readonly #google = new GoogleCredentialOwner();
  readonly #anthropic: AnthropicCredentialOwner;
  readonly #listeners = new Set<(kind: 'channels' | 'credentials' | 'authorization') => void>();
  readonly #parameterValidators = new Map<string, ReturnType<typeof compileToolJsonSchema>>();
  readonly #acceptedChannels = new Map<string, ModelChannel>();
  readonly #oauth = new Map<string, ModelOAuthProvider>();
  readonly #extensionOAuthIds = new Set<string>();
  #contributionIssue: string | undefined;
  readonly #credentialWatch = new ConfigWatchManager(() => this.#changed('credentials'));
  #stopWatching: (() => void) | undefined;
  readonly authorizations = new AuthorizationFlows(() => this.#changed('authorization'));
  constructor(readonly directory: string, options: { projectTrusted(cwd: string): boolean; credentials?: CredentialService; fetch?: typeof fetch }) {
    this.#anthropic = new AnthropicCredentialOwner(options.fetch ?? globalThis.fetch);
    this.credentialPath = join(directory, 'model-auth.json');
    this.credentials = options.credentials ?? new CredentialService(`varin-models:${directory}`, fileSecretStore(this.credentialPath));
    this.settings = new AgentSettingsService(directory, options.projectTrusted);
    for (const provider of modelOAuthProviders(options.fetch ?? globalThis.fetch)) { this.#oauth.set(provider.id, provider); this.credentials.registerOAuth(provider.id, provider); }
    this.file = new ConfigurationFile(join(directory, 'models.json'), document => {
      if (document.channels !== undefined && !Array.isArray(document.channels)) return fail('models-config-invalid', 'channels must be an array');
      return { ...document, channels: (document.channels ?? []) as ModelChannel[] };
    });
  }
  prepareContributions(types: readonly ChannelType[], providers: readonly ModelOAuthProvider[]): () => void {
    for (const type of types) compileToolJsonSchema(type.parametersSchema);
    const commitTypes = this.types.prepareReplacement('extensions', types);
    const ids = new Set<string>();
    for (const provider of providers) {
      if (ids.has(provider.id) || this.#oauth.has(provider.id) && !this.#extensionOAuthIds.has(provider.id)) throw new Error(`Authentication provider already registered: ${provider.id}`);
      ids.add(provider.id);
    }
    const commitCredentials = this.credentials.prepareOAuthReplacement('extensions', providers.map(provider => ({ id: provider.id, provider })));
    return () => {
      commitTypes(); commitCredentials();
      for (const id of this.#extensionOAuthIds) this.#oauth.delete(id);
      this.#extensionOAuthIds.clear();
      for (const provider of providers) { this.#oauth.set(provider.id, provider); this.#extensionOAuthIds.add(provider.id); }
      this.#parameterValidators.clear(); this.#contributionIssue = undefined; this.#changed('channels');
    };
  }
  contributionIssue(message: string) { this.#contributionIssue = message; this.#changed('channels'); }
  validate(value: unknown): asserts value is ModelChannel {
    if (!object(value) || !nonempty(value.id) || !nonempty(value.name) || !nonempty(value.type) || typeof value.enabled !== 'boolean'
      || typeof value.baseUrl !== 'string' || !object(value.authentication) || !object(value.parameters) || !Array.isArray(value.models)) return fail('channel-invalid', 'Complete the channel name, type, endpoint, authentication and models');
    endpoint(value.baseUrl);
    const type = this.types.get(value.type);
    if (!type) return fail('channel-type-unavailable', `Channel type is unavailable: ${value.type}`);
    validateModelConnection(value.connection, type.operations, type.credentialHeader?.name);
    for (const path of Object.values(value.connection?.paths ?? {})) appendModelPath(value.baseUrl, path);
    if (type.protocol === 'llama-cpp-classify' && value.connection?.paths?.decision !== undefined) return fail('model-connection-invalid', 'llama.cpp classification requires its tokenize, apply-template and completion routes; configure the server base URL instead');
    const auth = value.authentication;
    if (!type.authentication.includes(auth.kind as ConnectionAuthentication['kind'])
      || auth.kind === 'credential' && !nonempty(auth.reference)
      || auth.kind === 'environment' && !nonempty(auth.variable)
      || auth.kind === 'google-adc' && auth.file !== undefined && !nonempty(auth.file)
      || auth.kind === 'aws-chain' && auth.profile !== undefined && !nonempty(auth.profile)) return fail('channel-auth-invalid', 'Select a supported authentication source');
    if (auth.kind === 'anthropic-federation') validateAnthropicFederation(auth, value.baseUrl);
    const schemaKey = revisionOf(type.parametersSchema);
    let validate = this.#parameterValidators.get(schemaKey);
    if (!validate) { validate = compileToolJsonSchema(type.parametersSchema); this.#parameterValidators.set(schemaKey, validate); }
    if (!validate(value.parameters)) return fail('channel-parameters-invalid', 'Channel parameters do not match its type');
    const ids = new Set<string>();
    for (const model of value.models) {
      if (!object(model) || !nonempty(model.id) || !nonempty(model.name) || typeof model.enabled !== 'boolean'
        || !Array.isArray(model.operations) || model.operations.length === 0 || model.operations.some(op => !type.operations.includes(op))
        || model.requestModelId !== undefined && !nonempty(model.requestModelId)
        || model.contextWindow !== undefined && !positive(model.contextWindow)
        || model.maxOutputTokens !== undefined && !positive(model.maxOutputTokens)
        || model.input !== undefined && (!Array.isArray(model.input) || model.input.some(item => item !== 'text' && item !== 'image'))
        || model.reasoning !== undefined && typeof model.reasoning !== 'boolean'
        || model.thinkingLevelMap !== undefined && (!object(model.thinkingLevelMap) || Object.entries(model.thinkingLevelMap).some(([level, value]) =>
          !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level) || value !== null && typeof value !== 'string'))
        || model.parameters !== undefined && !object(model.parameters) || model.compat !== undefined && !object(model.compat)) return fail('channel-model-invalid', 'Model fields or operations are invalid');
      if (model.image !== undefined) {
        if (!object(model.image) || Object.keys(model.image).some(key => key !== 'mask' && key !== 'parameters')
          || model.image.mask !== undefined && typeof model.image.mask !== 'boolean'
          || model.image.parameters !== undefined && !object(model.image.parameters)
          || !model.operations.some(operation => operation === 'image-generation' || operation === 'image-editing')) return fail('image-capabilities-invalid', 'Image capabilities must describe an image model');
        const info = this.#imageInfo(value as unknown as ModelChannel, model as unknown as ChannelModel);
        try { compileToolJsonSchema(imageToolContract(info.supportsEditing ? 'editing' : 'generation', info).inputSchema); }
        catch { return fail('image-capabilities-invalid', 'Image parameter constraints are invalid'); }
      }
      if (ids.has(model.id)) return fail('channel-model-invalid', 'Model IDs must be unique within a channel');
      ids.add(model.id);
    }
  }
  async read(): Promise<ModelConnectionsSnapshot> {
    const snapshot = await this.file.read();
    const { channels, issues } = this.#resolved(snapshot.document);
    if (this.#contributionIssue) issues.push({ code: 'model-contributions-unavailable', message: this.#contributionIssue });
    return { revision: snapshot.revision, channels, types: this.types.list(), ...(issues.length ? { issues } : {}) };
  }
  #resolved(document: ModelsDocument, accepted = false) {
    const channels: ModelChannel[] = [], issues: NonNullable<ModelConnectionsSnapshot['issues']> = [];
    const ids = new Set<string>();
    const counts = new Map<string, number>();
    for (const candidate of document.channels) if (object(candidate) && typeof candidate.id === 'string') counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
    for (const candidate of document.channels) {
      const id = object(candidate) && typeof candidate.id === 'string' ? candidate.id : undefined;
      try {
        this.validate(candidate);
        if (counts.get(candidate.id) !== 1) return fail('channel-id-conflict', 'Channel IDs must be unique');
        const previous = this.#acceptedChannels.get(candidate.id);
        if (previous?.authentication.kind === 'anthropic-federation'
          && (revisionOf(previous.authentication) !== revisionOf(candidate.authentication) || previous.baseUrl !== candidate.baseUrl || previous.enabled !== candidate.enabled)) this.#anthropic.forget(candidate.id);
        ids.add(candidate.id); channels.push(candidate); this.#acceptedChannels.set(candidate.id, structuredClone(candidate));
      } catch (error) {
        issues.push({ ...(id === undefined ? {} : { channelId: id }), code: error instanceof ModelConfigurationError ? error.code : 'channel-invalid', message: error instanceof ModelConfigurationError ? error.message : 'Channel configuration is invalid' });
        if (accepted && id && !ids.has(id)) { const previous = this.#acceptedChannels.get(id); if (previous) { channels.push(previous); ids.add(id); } }
      }
    }
    return { channels, issues };
  }
  async save(channel: ModelChannel, expectedRevision: string) {
    this.validate(channel);
    await this.file.update(expectedRevision, document => {
      const index = document.channels.findIndex(entry => object(entry) && entry.id === channel.id);
      if (index < 0) document.channels.push(channel); else document.channels[index] = channel;
      return document;
    });
    return this.read();
  }
  async remove(id: string, expectedRevision: string) {
    await this.file.update(expectedRevision, document => ({ ...document, channels: document.channels.filter(channel => !object(channel) || channel.id !== id) }));
    this.#anthropic.forget(id);
    return this.read();
  }
  #changed(kind: 'channels' | 'credentials' | 'authorization' = 'channels') { for (const listener of this.#listeners) { try { listener(kind); } catch { console.error('[Models] Change observer failed'); } } }
  subscribe(listener: (kind: 'channels' | 'credentials' | 'authorization') => void) {
    this.#listeners.add(listener);
    if (!this.#stopWatching) {
      const stop = this.file.subscribe(() => this.#changed('channels'));
      const path = this.credentialPath; let stopped = false;
      const credentialWatch = this.#credentialWatch.watch({ kind: 'document', path, scope: 'global' }, [path]);
      void credentialWatch.then(subscription => { if (stopped) this.#credentialWatch.unwatch(subscription.watchId); }, () => console.error('[Models] Credential changes could not be observed'));
      this.#stopWatching = () => { stopped = true; stop(); this.#credentialWatch.close(); };
    }
    return () => { this.#listeners.delete(listener); if (!this.#listeners.size) { this.#stopWatching?.(); this.#stopWatching = undefined; } };
  }
  async storeCredential(secret: string, reference?: string) { const saved = await this.credentials.put(secret, reference); this.#changed('credentials'); return saved; }
  async removeCredential(reference: string) { await this.credentials.remove(reference); this.#changed('credentials'); }
  signIn(providerId: string, reference: string) {
    const provider = this.#oauth.get(providerId);
    if (!provider || !reference) return fail('oauth-provider-unavailable', 'Select a supported account provider');
    const captured = provider.captureLogin?.();
    try {
      return this.authorizations.start(async prompt => {
        try {
          const expected = await this.credentials.identity(reference); prompt.signal.throwIfAborted();
          const value = await (captured ?? provider).login(prompt); prompt.signal.throwIfAborted();
          await this.credentials.acceptOAuth(value, reference, expected);
          this.#changed('credentials');
        } finally { captured?.release(); }
      });
    } catch (error) { captured?.release(); throw error; }
  }
  async #channel(id: string, accepted = false): Promise<ModelChannel> {
    const current = await (accepted ? this.file.current() : this.file.read());
    const channel = this.#resolved(current.document, accepted).channels.find(entry => entry.id === id);
    if (!channel) { this.#anthropic.forget(id); return fail('model-channel-unavailable', 'The selected channel is missing'); }
    if (!channel.enabled) { this.#anthropic.forget(id); return fail('model-channel-disabled', 'The selected channel is disabled'); }
    return channel;
  }
  #model(channel: ModelChannel, id: string, operation: ModelOperation) {
    const model = channel.models.find(model => model.id === id);
    if (!model) return fail('model-unavailable', 'The selected model is missing');
    if (!model.enabled) return fail('model-disabled', 'The selected model is disabled');
    if (!model.operations.includes(operation)) return fail('model-operation-unavailable', `The selected model does not support ${operation}`);
    return model;
  }
  async #scope(channel: ModelChannel): Promise<CredentialScope> {
    const auth = channel.authentication;
    if (auth.kind === 'anthropic-federation') {
      const source = await this.#anthropic.source(channel.id, channel.baseUrl, auth);
      return { reference: channel.id, authority: this.credentials.authorityId, account: source.identity, generation: 0 };
    }
    if (auth.kind === 'google-adc') {
      const source = await this.#google.source(auth.file ? { GOOGLE_APPLICATION_CREDENTIALS: auth.file } : undefined);
      return { reference: channel.id, authority: this.credentials.authorityId, account: source.identity, generation: 0 };
    }
    if (auth.kind === 'aws-chain') {
      const source = await this.#aws.source(channel.id, { ...(auth.profile ? { AWS_PROFILE: auth.profile } : {}) });
      return { reference: channel.id, authority: this.credentials.authorityId, account: source.identity, generation: 0 };
    }
    return this.credentials.scope(auth, channel.id);
  }
  #credentialHeaders(type: ChannelType, resolved: ResolvedCredential): ResolvedCredential {
    if (!type.adapter) return resolved;
    if (resolved.auth.apiKey) {
      if (!type.credentialHeader) return fail('model-credential-header-missing', 'This protocol requires an explicit credential header');
      return { auth: { headers: { ...resolved.auth.headers, [type.credentialHeader.name]: `${type.credentialHeader.prefix}${resolved.auth.apiKey}` } }, source: 'configured headers' };
    }
    return resolved.auth.headers ? { ...resolved, source: 'configured headers' } : resolved;
  }
  async #auth(channel: ModelChannel, dispatch?: CredentialDispatch): Promise<ResolvedCredential> {
    const auth = channel.authentication;
    if (auth.kind === 'anthropic-federation') {
      const source = await this.#anthropic.source(channel.id, channel.baseUrl, auth);
      return { auth: { headers: await this.#anthropic.headers(channel.id, source) }, source: 'anthropic-federation' };
    }
    if (auth.kind === 'google-adc') {
      const source = await this.#google.source(auth.file ? { GOOGLE_APPLICATION_CREDENTIALS: auth.file } : undefined);
      return { auth: { headers: await this.#google.headers(source) }, source: 'google-adc' };
    }
    if (auth.kind === 'aws-chain') {
      if (!dispatch) return fail('aws-dispatch-required', 'AWS authentication requires the original serialized request');
      const source = await this.#aws.source(channel.id, { ...(auth.profile ? { AWS_PROFILE: auth.profile } : {}) });
      return { auth: { headers: await this.#aws.sign(source, dispatch, channel.connection?.headers ?? {}, typeof channel.parameters.region === 'string' ? channel.parameters.region : undefined) }, source: 'aws-chain' };
    }
    return this.#credentialHeaders(this.types.get(channel.type)!, await this.credentials.resolve(auth, channel.id, undefined, dispatch));
  }
  currentScope(providerId: string) { return this.#channel(providerId, true).then(channel => this.#scope(channel)); }
  async currentProviderAccount(providerId: string): Promise<string | undefined> { const auth = (await this.#channel(providerId, true)).authentication; return auth.kind === 'credential' ? this.credentials.providerAccount(auth.reference) : undefined; }
  getAuth(providerId: string, _modelId?: string, dispatch?: CredentialDispatch) { return this.#channel(providerId, true).then(channel => this.#auth(channel, dispatch)); }
  async mcpBearerToken(providerId: string): Promise<string | undefined> {
    const resolved = await this.getAuth(providerId);
    if (resolved.auth.apiKey) return resolved.auth.apiKey;
    const authorization = new Headers(Object.fromEntries(Object.entries(resolved.auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null))).get('authorization');
    if (!authorization) return undefined;
    const bearer = /^Bearer (.+)$/i.exec(authorization);
    if (!bearer) return fail('mcp-authentication-unsupported', 'The selected account does not provide bearer authentication');
    return bearer[1];
  }
  async anthropicAuthentication(providerId: string): Promise<'oauth' | 'api-key'> { return (await this.getAuth(providerId)).source === 'oauth' ? 'oauth' : 'api-key'; }
  async vertexAuthentication(providerId: string): Promise<'api-key' | 'adc'> { return (await this.#channel(providerId)).authentication.kind === 'google-adc' ? 'adc' : 'api-key'; }
  async routingEnvironment(providerId: string): Promise<Record<string, string>> { return this.#routingEnvironment(await this.#channel(providerId)); }
  #routingEnvironment(channel: ModelChannel): Record<string, string> {
    const p = channel.parameters;
    return { ...(typeof p.region === 'string' ? { AWS_REGION: p.region } : {}),
      ...(typeof p.project === 'string' ? { GOOGLE_CLOUD_PROJECT: p.project } : {}), ...(typeof p.location === 'string' ? { GOOGLE_CLOUD_LOCATION: p.location } : {}),
      ...(typeof p.apiVersion === 'string' ? { AZURE_OPENAI_API_VERSION: p.apiVersion } : {}),
      ...(typeof p.deployment === 'string' ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: channel.models.map(model => `${model.id}=${p.deployment}`).join(',') } : {}) };
  }
  #selected(channel: ModelChannel, model: ChannelModel): SelectedModel {
    const adapter = this.types.get(channel.type)!.adapter;
    return { providerId: channel.id, modelId: model.id, requestModelId: model.requestModelId ?? model.id, name: model.name,
      ...(adapter ? { adapterId: adapter.id, adapterVersion: adapter.version, adapterIdentity: adapter.identity, adapterBindingId: adapter.bindingId, endpointPath: adapter.endpointPath } : {}),
      api: this.types.get(channel.type)!.protocol, baseUrl: channel.baseUrl, maxTokens: model.maxOutputTokens ?? 0,
      ...(channel.connection === undefined ? {} : { connection: structuredClone(channel.connection) }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }), input: model.input ?? ['text'],
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
      ...(model.parameters === undefined ? {} : { samplingParams: model.parameters }),
      ...(model.compat === undefined ? {} : { compat: model.compat }), allowAnonymous: channel.authentication.kind === 'none' };
  }
  async listModels(): Promise<SelectedModel[]> {
    return (await this.read()).channels.filter(channel => channel.enabled)
      .flatMap(channel => channel.models.filter(model => model.enabled && model.operations.includes('chat')).map(model => this.#selected(channel, model)));
  }
  async captureModel(providerId: string, modelId: string, original?: import('../kernel/protocol.generated.js').ModelSessionConfiguration): Promise<{ model: SelectedModel; authority: ModelExecutionAuthority; release(): void }> {
    const channel = await this.#channel(providerId);
    const model = this.#model(channel, modelId, 'chat');
    const selected = this.#selected(channel, model);
    const type = this.types.get(channel.type)!;
    const scope = await this.#scope(channel);
    const captured = channel.authentication.kind === 'credential' || channel.authentication.kind === 'environment' || channel.authentication.kind === 'none'
      ? await this.credentials.captureResolver(channel.authentication, channel.id) : undefined;
    let releaseAdapter: (() => void) | undefined;
    try { releaseAdapter = await type.adapter?.capture(); } catch (error) { captured?.release(); throw error; }
    const assertAvailable = async () => {
      const current = await this.#channel(providerId, true);
      this.#model(current, modelId, 'chat');
      if (revisionOf(current.authentication) !== revisionOf(channel.authentication)
        || !sameScope(await this.#scope(current), scope)) return fail('credential-scope-changed', 'The selected account changed');
    };
    const requestChannel: ModelChannel = original ? { ...channel, connection: original.connection ?? {},
      parameters: { ...channel.parameters, ...(original.awsRegion ? { region: original.awsRegion } : {}) } } : channel;
    const getAuth = async (_provider: string, _model?: string, dispatch?: CredentialDispatch) => {
      await assertAvailable();
      const result = captured ? this.#credentialHeaders(type, await captured.resolve(undefined, dispatch)) : await this.#auth(requestChannel, dispatch);
      await assertAvailable();
      return result;
    };
    try { await assertAvailable(); } catch (error) { captured?.release(); releaseAdapter?.(); throw error; }
    return { model: selected, release: () => { captured?.release(); releaseAdapter?.(); }, authority: {
      getAuth,
      currentScope: async () => { await assertAvailable(); return scope; },
      currentProviderAccount: async () => {
        await assertAvailable();
        return channel.authentication.kind === 'credential' ? this.credentials.providerAccount(channel.authentication.reference) : undefined;
      },
      routingEnvironment: async () => this.#routingEnvironment(channel),
      anthropicAuthentication: async () => (await getAuth(providerId)).source === 'oauth' ? 'oauth' : 'api-key',
      vertexAuthentication: async () => channel.authentication.kind === 'google-adc' ? 'adc' : 'api-key',
    } };
  }
  async selectedModel(providerId: string, modelId: string) { const channel = await this.#channel(providerId); return this.#selected(channel, this.#model(channel, modelId, 'chat')); }
  readGlobalInferenceSettings() { return this.settings.read().then(snapshot => snapshot.document); }
  async listImageModels() {
    return (await this.read()).channels.filter(channel => channel.enabled).flatMap(channel => channel.models.filter(model => model.enabled && (model.operations.includes('image-generation') || model.operations.includes('image-editing'))).map(model => this.#imageInfo(channel, model)));
  }
  #imageInfo(channel: ModelChannel, model: ChannelModel): ImageModelInfo {
    const api = typeof channel.parameters.imageApi === 'string' ? channel.parameters.imageApi : channel.type === 'openrouter' ? 'openrouter-images' : 'openai-images';
    const info = imageModelInfo({ provider: channel.id, id: model.id, name: model.name, api, input: model.operations.includes('image-editing') ? ['text', 'image'] : ['text'] });
    if (!info) return fail('image-api-unavailable', 'The selected image protocol is unavailable');
    const parameters = model.image?.parameters === undefined ? [] : Object.keys(model.image.parameters);
    if (parameters.some(name => !info.parameters.includes(name))) return fail('image-capabilities-invalid', 'The image protocol does not support a configured parameter');
    if (model.image?.mask && !info.supportsMask) return fail('image-capabilities-invalid', 'The image protocol does not support masks');
    return { ...info, supportsGeneration: model.operations.includes('image-generation'), supportsMask: info.supportsMask && model.image?.mask === true,
      parameters, ...(model.image?.parameters ? { parameterSchemas: structuredClone(model.image.parameters) } : {}) };
  }
  resolveEmbeddingBinding(providerId: string, modelId: string) { return this.#binding(providerId, modelId, 'embedding'); }
  resolveRerankBinding(providerId: string, modelId: string, endpoint?: string) { return this.#binding(providerId, modelId, 'rerank', endpoint); }
  resolveDecisionBinding(providerId: string, modelId: string, endpoint?: string) { return this.#binding(providerId, modelId, 'decision', endpoint); }
  resolveImageBinding(providerId: string, modelId: string, purpose: ImageToolPurpose) { return this.#binding(providerId, modelId, purpose === 'editing' ? 'image-editing' : 'image-generation'); }
  async #binding(providerId: string, modelId: string, operation: ModelOperation, override?: string): Promise<InferenceProviderBinding> {
    const channel = await this.#channel(providerId);
    const model = this.#model(channel, modelId, operation);
    const type = this.types.get(channel.type)!;
    const image = operation === 'image-generation' || operation === 'image-editing';
    const api = image ? this.#imageInfo(channel, model).api : type.protocol;
    const baseUrl = channel.baseUrl;
    const configuredPath = override ?? channel.connection?.paths?.[operation];
    const routes = configuredPath !== undefined ? [{ requestUrl: appendModelPath(baseUrl, configuredPath), requestKind: 'model_compute' as const }]
      : image ? (api === 'openrouter-images' ? ['chat/completions'] : [operation === 'image-editing' ? 'images/edits' : 'images/generations']).map(path => ({ requestUrl: `${baseUrl.replace(/\/+$/, '')}/${path}`, requestKind: 'model_compute' as const }))
      : operation === 'embedding' ? [{ requestUrl: embeddingRequestUrl(baseUrl), requestKind: 'model_compute' as const }]
        : operation === 'rerank' ? [{ requestUrl: rerankRequestUrl(baseUrl, override), requestKind: 'model_compute' as const }]
          : api === 'llama-cpp-classify' ? ['tokenize', 'apply-template', 'completion'].map(path => ({ requestUrl: `${baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/${path}`, requestKind: path === 'completion' ? 'model_compute' as const : 'preparation' as const }))
            : [{ requestUrl: `${baseUrl.replace(/\/+$/, '')}${override ?? (api === 'typesafe-system-one' ? '/systemone' : '/run')}`, requestKind: 'model_compute' as const }];
    routes.forEach(route => endpoint(route.requestUrl));
    const credentialScope = await this.#scope(channel);
    const assertAvailable = async () => {
      const current = await this.#channel(providerId, true);
      this.#model(current, modelId, operation);
      if (revisionOf(current.authentication) !== revisionOf(channel.authentication) || !sameScope(await this.#scope(current), credentialScope)) return fail('credential-scope-changed', 'The selected account changed');
    };
    const captured = channel.authentication.kind === 'credential' || channel.authentication.kind === 'environment' || channel.authentication.kind === 'none'
      ? await this.credentials.captureResolver(channel.authentication, channel.id) : undefined;
    let references = 1, active = 0, baseReleased = false, disposed = false;
    const dispose = () => { if (!references && !active && !disposed) { disposed = true; captured?.release(); } };
    const retain = () => {
      if (!references) throw new Error('The original model binding was released');
      references += 1; let released = false;
      return () => { if (released) return; released = true; references -= 1; dispose(); };
    };
    const release = () => { if (baseReleased) return; baseReleased = true; references -= 1; dispose(); };
    const getAuth = async () => {
      if (!references) throw new Error('The original model binding was released');
      active += 1;
      try {
        await assertAvailable();
        const auth = captured ? this.#credentialHeaders(type, await captured.resolve()) : await this.#auth(channel);
        await assertAvailable(); return auth;
      } finally { active -= 1; dispose(); }
    };
    const { name: _channelName, models: _models, enabled: _channelEnabled, ...connection } = channel;
    const { name: _modelName, enabled: _modelEnabled, ...selection } = model;
    const configurationId = revisionOf({ channel: connection, model: selection, routes });
    const egressOverride = modelEgressOverride(channel.connection);
    return { providerId, modelId, requestModelId: model.requestModelId ?? model.id, baseUrl, api, routes, requestUrl: routes[0]!.requestUrl, ...(configuredPath === undefined ? {} : { endpoint: configuredPath }), configurationId,
      ...(channel.connection === undefined ? {} : { connection: structuredClone(channel.connection) }),
      ...(channel.connection?.headers === undefined ? {} : { headers: structuredClone(channel.connection.headers) }),
      ...(egressOverride === undefined ? {} : { egressOverride }),
      credentialRef: providerId, credentialScope, allowAnonymous: channel.authentication.kind === 'none',
      ...(image ? { imageModel: this.#imageInfo(channel, model) } : {}),
      assertAvailable, currentScope: async () => { await assertAvailable(); return credentialScope; },
      getAuth, retain, release };
  }
  async discover(id: string, fetchImpl: EgressFetch, signal?: AbortSignal) {
    const channel = await this.#channel(id);
    const type = this.types.get(channel.type)!;
    if (!type.discovery || !type.discoveryRequest || !type.parseDiscovery) {
      if (type.catalog) return { models: structuredClone(type.catalog) };
      return fail('model-discovery-unavailable', 'Add models manually for this channel type');
    }
    const request = type.discoveryRequest(channel);
    endpoint(request.url);
    const expected = await this.#scope(channel);
    const auth = await this.#auth(channel);
    if (!sameScope(expected, await this.currentScope(id))) return fail('credential-scope-changed', 'The account changed during model discovery');
    const headers = new Headers(request.headers);
    for (const [key, value] of Object.entries(channel.connection?.headers ?? {})) headers.set(key, value);
    for (const [key, value] of Object.entries(auth.auth.headers ?? {})) if (value !== null) headers.set(key, value);
    if (auth.auth.apiKey) headers.set(type.protocol === 'anthropic-messages' ? 'x-api-key' : type.protocol.startsWith('google-') ? 'x-goog-api-key' : 'authorization', type.protocol === 'anthropic-messages' || type.protocol.startsWith('google-') ? auth.auth.apiKey : `Bearer ${auth.auth.apiKey}`);
    const response = await fetchImpl(request.url, { headers, ...(signal ? { signal } : {}), redirect: 'manual' }, modelEgressOverride(channel.connection));
    if (!response.ok) return fail('model-discovery-failed', `Model discovery failed (${response.status})`);
    const models = type.parseDiscovery(await response.json());
    if (!sameScope(expected, await this.currentScope(id))) return fail('credential-scope-changed', 'The account changed during model discovery');
    return { models };
  }
}
