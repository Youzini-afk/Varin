import { captureLocalInference } from './local-inference.js';
import type { SemanticEmbedder } from './embedder.js';
import { createInferenceRequests, type InferenceCall, type InferenceRequestsOptions } from './inference-requests.js';
import { createRerankInference, type RerankInferenceAuthority, type RerankInferenceCapture } from './rerank-inference.js';
/** Application Host inference leases. No Pi worker, project configuration or secret DTOs. */
import { createDecisionInference, type DecisionInferenceAuthority, type DecisionInferenceCapture } from './decision-inference.js';
import { createHash } from 'node:crypto';
import {
  HarnessInferenceSettingsValidationError, parseHarnessEmbeddingSettings,
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS, remoteEmbeddingSpaceParts,
  type HarnessEmbeddingSettings, type HarnessResolvedEmbeddingBinding,
  type HarnessEmbedParams, type HarnessEmbedResult,
} from '@varin/protocol';
import { EmbeddingResponseError, requestOpenAICompatibleEmbeddings, parseOpenAICompatibleEmbeddings, embeddingWireUsage, type EmbeddingUsage } from '@varin/protocol/node/embeddings';
import { classifyEgressError, type EgressOverride } from '../../harness/egress.js';
import { waitWithSignal } from '../../cancellation.js';
import { semanticInferenceOperationKey, type SemanticInferenceLedger, type SemanticInferenceLedgerIdentity, type SemanticInferenceOperation, type SemanticInferenceFactFilter } from './inference-ledger-contract.js';
import { ExistingHostCredentialOwner, type CredentialScope, type ExistingModelAuthRuntime } from '../../kernel/credential-owner.js';
import { acquireTokenCounter } from '../../models/token-count.js';

export interface SemanticProviderBinding {
  providerId: string;
  modelId: string;
  baseUrl: string;
  endpoint?: string;
  requestUrl: string;
  configurationId: string;
  credentialRef: string;
  credentialScope: CredentialScope;
  assertAvailable(): Promise<void>;
  currentScope(): Promise<CredentialScope>;
  getAuth(): ReturnType<ExistingModelAuthRuntime['getAuth']>;
  allowAnonymous?: boolean;
  requestModelId?: string;
  contextWindow?: number;
  tokenizer?: import('../../kernel/protocol.generated.js').TokenizerBinding;
  release?(): void;
  headers?: Record<string, string>;
  egressOverride?: EgressOverride;
}
export interface SemanticInferenceAuthority extends Partial<DecisionInferenceAuthority>, Partial<RerankInferenceAuthority> {
  resolveEmbeddingBinding(providerId: string, modelId: string): Promise<SemanticProviderBinding>;
  readGlobalInferenceSettings(): Promise<unknown>;
}
export interface SemanticInferenceSettingsOwner { readGlobalSettings(): Promise<unknown> }
export interface SemanticInferenceIdentity {
  providerId: string;
  modelId: string;
  protocol: 'openai-compatible';
  configurationId: string;
  endpoint: string;
  credentialScope: CredentialScope;
}
export interface SemanticInferenceReceipt {
  batchId: string;
  providerId: string;
  modelId: string;
  configurationId: string;
  purpose: 'index-document-embedding';
  inputItems: number;
  inputBytes: number;
  attempts: number;
  /** False only for an unresolved durable dispatch intent after interruption/restart. */
  attemptsKnown: boolean;
  reused?: true;
  state: 'not-started' | 'succeeded' | 'failed' | 'indeterminate' | 'delivery-blocked';
  usage: { status: 'unknown' } | ({ status: 'known' } & EmbeddingUsage);
  httpStatus?: number;
  attemptDetails?: Array<{ status?: number; code?: string; requestId?: string; usage?: EmbeddingUsage }>;
}
export interface SemanticInferenceRequest extends HarnessEmbedParams {
  operationIdentity: SemanticInferenceOperation;
  signal?: AbortSignal;
  /** The Run's grant owner, checked at dispatch and after the response. */
  guard?(): Promise<void>;
  onReceipt?(receipt: SemanticInferenceReceipt): void;
}
export interface SemanticQueryEmbeddingRequest extends HarnessEmbedParams {
  /** Original Catalog parent domain; Knowledge work never impersonates code retrieval. */
  domain?: 'knowledge';
  /** Candidate from the credential-scoped query cache; original source fences still apply. */
  cachedResult?: HarnessEmbedResult;
  signal?: AbortSignal;
  guard(): Promise<void>;
  /** Source document revisions are expensive; check once at the actual egress boundary. */
  beforeDispatch?(signal: AbortSignal): Promise<void>;
}
export interface SemanticInferenceLease {
  readonly binding: HarnessResolvedEmbeddingBinding;
  readonly identity: SemanticInferenceIdentity;
  assertAvailable(signal?: AbortSignal): Promise<void>;
  retain(): SemanticInferenceLease;
  release(): void;
  countTokens(texts: readonly string[]): Promise<number[]>;
  embed(params: SemanticInferenceRequest): Promise<HarnessEmbedResult & { receipt: SemanticInferenceReceipt }>;
  /** Native retrieval consumes its original Catalog request session, never the index ledger. */
  consume(call: InferenceCall, params: SemanticQueryEmbeddingRequest): Promise<HarnessEmbedResult>;
}
export type SemanticInferenceStatus = 'unconfigured' | 'disabled' | 'invalid' | 'unavailable';
export type SemanticInferenceDescription = { status: 'ready'; binding: HarnessResolvedEmbeddingBinding }
  | { status: SemanticInferenceStatus; reason: string };
export class SemanticInferenceError extends Error {
  constructor(readonly status: SemanticInferenceStatus, readonly code: string,
    readonly receipt?: SemanticInferenceReceipt, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SemanticInferenceError';
  }
}
const fail = (status: SemanticInferenceStatus, code: string): never => { throw new SemanticInferenceError(status, code); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function settingsFrom(document: unknown): HarnessEmbeddingSettings {
  if (!record(document) || (document.harness !== undefined && !record(document.harness))) return fail('invalid', 'embedding-settings-invalid');
  const raw = record(document.harness) ? document.harness.embedding : undefined;
  if (record(raw) && raw.enabled === false) return fail('disabled', 'embedding-disabled');
  const settings = parseHarnessEmbeddingSettings(raw);
  if (!settings) return fail('unconfigured', 'embedding-unconfigured');
  return settings;
}
const invalidSettings = (error: unknown): boolean => error instanceof HarnessInferenceSettingsValidationError
  || error instanceof SyntaxError || record(error) && ['invalid_settings', 'embedding-settings-invalid'].includes(String(error.code));
function safeFailure(error: unknown): SemanticInferenceError {
  if (error instanceof SemanticInferenceError) return error;
  if (error instanceof EmbeddingResponseError) {
    const code = error.capacity ? `embedding-${error.capacity}-limit`
      : error.status && error.status >= 400 ? `embedding-http-${error.status}` : 'embedding-response-invalid';
    return new SemanticInferenceError('unavailable', code, undefined, error.message);
  }
  if (invalidSettings(error)) return new SemanticInferenceError('invalid', 'embedding-settings-invalid');
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'model-channel-disabled' || code === 'model-disabled') return new SemanticInferenceError('disabled', code);
  if (code === 'model-endpoint-invalid' || code === 'models-config-invalid' || code === 'channel-invalid' || code === 'channel-model-invalid') {
    return new SemanticInferenceError('invalid', 'embedding-provider-invalid');
  }
  return new SemanticInferenceError('unavailable', 'embedding-binding-unavailable');
}
const frozenReceipt = (receipt: SemanticInferenceReceipt): SemanticInferenceReceipt => Object.freeze({ ...receipt, usage: Object.freeze({ ...receipt.usage }) });

export function createSemanticInference(
  authority: SemanticInferenceAuthority,
  settingsOwner: SemanticInferenceSettingsOwner = { readGlobalSettings: () => authority.readGlobalInferenceSettings() },
  options: { requests?: InferenceRequestsOptions; ledger?: SemanticInferenceLedger; fetchImpl?: typeof fetch; onReceipt?(receipt: SemanticInferenceReceipt): void } = {},
) {
  const requests = options.requests ? createInferenceRequests({ ...options.requests, readRetrySettings: async () => { const settings = await settingsOwner.readGlobalSettings(); return record(settings) ? settings.retry : undefined; } }) : undefined;
  const rerank = options.requests && requests && authority.resolveRerankBinding ? createRerankInference({ resolveRerankBinding: authority.resolveRerankBinding.bind(authority) },
    () => settingsOwner.readGlobalSettings(), options.requests, requests) : undefined;
  const decision = options.requests && requests && authority.resolveDecisionBinding ? createDecisionInference({ resolveDecisionBinding: authority.resolveDecisionBinding.bind(authority) },
    () => settingsOwner.readGlobalSettings(), options.requests, requests) : undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const leases = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  const transports = new Set<Promise<unknown>>();
  let pendingSettlements = 0;
  let disabled = false;
  let revocationGeneration = 0;
  const readGlobalSettings = async () => {
    let settings: unknown;
    try { settings = await settingsOwner.readGlobalSettings(); }
    catch (error) { throw safeFailure(error); }
    const nextDisabled = record(settings) && record(settings.harness) && record(settings.harness.embedding)
      && settings.harness.embedding.enabled === false;
    if (nextDisabled && !disabled) revocationGeneration++;
    disabled = nextDisabled;
    return settings;
  };
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const capture = async (): Promise<SemanticInferenceLease> => {
    let capturedProvider: SemanticProviderBinding | undefined;
    let capturedCredentials: ExistingHostCredentialOwner | undefined;
    let transferred = false;
    try {
      if (closed) return fail('unavailable', 'embedding-owner-closed');
      const settings = settingsFrom(await readGlobalSettings());
      if (settings.protocol === 'local') return fail('unconfigured', 'embedding-local-selected');
      const capturedRevocation = revocationGeneration;
      const ledger = options.ledger;
      const provider = capturedProvider = await authority.resolveEmbeddingBinding(settings.providerId, settings.modelId);
      if (JSON.stringify(settingsFrom(await readGlobalSettings())) !== JSON.stringify(settings) || capturedRevocation !== revocationGeneration) return fail('unavailable', 'embedding-selection-changed');
      // Keep room for model-added tokens and reference-tokenizer differences.
      // A caller's preferred chunk size cannot exceed the selected model window.
      const capacity = provider.contextWindow ?? settings.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
      const binding: HarnessResolvedEmbeddingBinding = Object.freeze({ ...settings,
        maxTokens: Math.min(settings.maxTokens ?? Infinity, Math.max(1, Math.floor(capacity * 0.9))),
        configurationId: provider.tokenizer ? digest(JSON.stringify([provider.configurationId, provider.tokenizer])).slice(0, 16) : provider.configurationId });
      const identity: SemanticInferenceIdentity = Object.freeze({ providerId: binding.providerId,
        modelId: binding.modelId, protocol: 'openai-compatible', configurationId: binding.configurationId,
        endpoint: provider.requestUrl, credentialScope: Object.freeze({ ...provider.credentialScope }) });
      const credentials = capturedCredentials = new ExistingHostCredentialOwner({ providerId: provider.credentialRef,
        providerFamily: 'openai-completions', endpoint: provider.requestUrl,
        currentScope: provider.currentScope, runtime: { getAuth: provider.getAuth }, allowAnonymous: provider.allowAnonymous ?? false,
        release: () => provider.release?.() });
      let references = 0;
      let counter: Promise<Awaited<ReturnType<typeof acquireTokenCounter>>> | undefined;
      const countTokens = async (texts: readonly string[]) => {
        if (!options.requests) return texts.map(text => Buffer.byteLength(text, 'utf8'));
        counter ??= acquireTokenCounter(options.requests.kernel, { model: provider.requestModelId ?? binding.modelId,
          ...(provider.tokenizer ? { tokenizer: provider.tokenizer } : {}) }).catch(error => {
          counter = undefined;
          throw error;
        });
        const counted = await (await counter).count(texts);
        // Reference vocabularies can undercount another model's multilingual
        // text. Use a byte upper bound until that model's tokenizer is available.
        return counted.tokenizer.includes('reference tokenizer')
          ? texts.map(text => Buffer.byteLength(text, 'utf8')) : counted.counts;
      };
      let revoked = false;
      const retain = (): SemanticInferenceLease => {
        if (closed) return fail('unavailable', 'embedding-owner-closed');
        references++;
        const controller = new AbortController();
        controllers.add(controller);
        let released = false;
        const assertAvailable = async (signal?: AbortSignal) => {
          if (closed || released || references <= 0) return fail('unavailable', 'embedding-lease-released');
          signal?.throwIfAborted();
          // Failed candidates cannot replace accepted configuration. Explicit disabling is a
          // revocation and remains latched even if a later candidate re-enables the capability.
          let current: unknown;
          try { current = await readGlobalSettings(); }
          catch (error) { if (!invalidSettings(error)) throw error; }
          if (record(current) && record(current.harness) && record(current.harness.embedding)
            && current.harness.embedding.enabled === false) revoked = true;
          if (revoked || capturedRevocation !== revocationGeneration) return fail('disabled', 'embedding-disabled');
          try { await provider.assertAvailable(); }
          catch (error) {
            const code = record(error) ? error.code : undefined;
            if (code === 'model-channel-disabled' || code === 'model-channel-unavailable' || code === 'model-disabled'
              || code === 'model-unavailable' || code === 'model-operation-unavailable' || code === 'credential-scope-changed'
              || code === 'credential-missing') revoked = true;
            throw error;
          }
          signal?.throwIfAborted();
          if (closed || released) return fail('unavailable', 'embedding-lease-released');
        };
        const release = () => {
          if (released) return;
          released = true; references--; controller.abort(); controllers.delete(controller); leases.delete(release);
          if (references === 0) { credentials.release(); void counter?.then(value => value.release()).catch(() => {}); }
        };
        leases.add(release);
        return {
          binding, identity, assertAvailable, countTokens: async texts => { await assertAvailable(); return countTokens(texts); },
          retain: () => { if (closed || released) return fail('unavailable', 'embedding-lease-released'); return retain(); },
          release,
          consume: async (call, params) => {
            if (!options.requests) return fail('unavailable', 'embedding-request-owner-unavailable');
            const signal = AbortSignal.any([call.signal, controller.signal, ...(params.signal ? [params.signal] : [])]);
            const validate = async () => { await assertAvailable(signal); await params.guard?.(); signal.throwIfAborted(); };
            if (!['query', 'document'].includes(params.purpose) || typeof params.guard !== 'function') return fail('invalid', 'embedding-run-authorization-required');
            if (params.providerId !== binding.providerId || params.modelId !== binding.modelId || params.protocol !== binding.protocol
              || params.configurationId !== binding.configurationId || params.dimensions !== binding.dimensions
              || params.maxTokens !== binding.maxTokens) return fail('invalid', 'embedding-binding-mismatch');
            if (!Array.isArray(params.items) || !params.items.length || params.items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string')
              || new Set(params.items.map(item => item.id)).size !== params.items.length) return fail('invalid', 'embedding-input-invalid');
            await validate();
            if (params.cachedResult) {
              const cached = params.cachedResult;
              const expectedSpace = digest(JSON.stringify(remoteEmbeddingSpaceParts({ protocol: binding.protocol,
                providerId: binding.providerId, modelId: binding.modelId, configurationId: binding.configurationId,
                maxTokens: binding.maxTokens!, dimensions: cached.space.dim }))).slice(0, 16);
              if (cached.space.spaceId !== expectedSpace || cached.space.providerId !== binding.providerId || cached.space.modelId !== binding.modelId
                || cached.space.protocol !== binding.protocol || cached.space.configurationId !== binding.configurationId
                || cached.space.maxTokens !== binding.maxTokens || !Number.isSafeInteger(cached.space.dim) || cached.space.dim <= 0
                || (binding.dimensions !== undefined && cached.space.dim !== binding.dimensions)
                || cached.items.length !== params.items.length || cached.items.some((item, index) => item.index !== index
                  || item.id !== params.items[index]!.id || item.vector.length !== cached.space.dim || item.vector.some(value => !Number.isFinite(value)))) {
                return fail('invalid', 'embedding-cache-binding-mismatch');
              }
              await validate();
              return { ...cached, batchId: params.batchId };
            }
            const connection = await options.requests.egress.prepare(provider.requestUrl, provider.egressOverride);
            const result = await requestOpenAICompatibleEmbeddings({ baseUrl: provider.baseUrl,
              ...(provider.headers ? { headers: provider.headers } : {}),
              ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), model: provider.requestModelId ?? binding.modelId,
              input: params.items.map(item => item.text), ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }),
              signal, maxRetries: 0, redirect: 'manual',
              beforeDispatch: async request => {
                await validate();
                const auth = await credentials.resolve(identity.credentialScope, signal, { method: 'POST', endpoint: request.url,
                  payloadSha256: digest(request.body) });
                await validate();
                return auth.headers;
              },
              fetchImpl: async (url, init) => {
                const destination = new URL(String(url)).toString();
                if (destination !== provider.requestUrl || init?.method !== 'POST' || typeof init.body !== 'string') return fail('invalid', 'embedding-request-binding-mismatch');
                return call.request({ binding: { requestKind: 'model_compute', purpose: params.purpose === 'document'
                  ? params.domain === 'knowledge' ? 'knowledge-document-embedding' : 'code-retrieval-document-embedding'
                  : params.domain === 'knowledge' ? 'knowledge-query-embedding' : 'code-retrieval-query-embedding',
                  providerId: binding.providerId, modelId: binding.modelId, configurationId: binding.configurationId,
                  executor: { kind: 'http', api: binding.protocol, endpoint: destination, credentialScope: identity.credentialScope } },
                  request: { purpose: params.purpose, wire: JSON.parse(init.body) }, destination, init, connection,
                  prepareHeaders: async active => {
                    const auth = await credentials.resolve(identity.credentialScope, active, { method: 'POST', endpoint: destination, payloadSha256: digest(String(init.body)) });
                    await validate();
                    return { 'content-type': 'application/json', ...provider.headers, ...auth.headers };
                  },
                  check: validate,
                  ...(params.beforeDispatch ? { beforeDispatch: params.beforeDispatch } : {}),
                  observe: raw => {
                    const usage = embeddingWireUsage(raw);
                    let valid = false;
                    try { parseOpenAICompatibleEmbeddings(raw, { input: params.items.map(item => item.text), model: provider.requestModelId ?? binding.modelId,
                      ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }) }); valid = true; } catch { /* Original usage precedes vector validation. */ }
                    return { valid, rawUsage: record(raw) ? raw.usage ?? null : null,
                      ...(usage ? { usage: { measurement: 'actual' as const, inputTokens: usage.inputTokens ?? null, outputTokens: null } } : {}) };
                  },
                });
              },
            });
            await validate();
            return { batchId: params.batchId,
              space: { providerId: binding.providerId, modelId: binding.modelId, protocol: binding.protocol,
                configurationId: binding.configurationId, maxTokens: binding.maxTokens!, dim: result.dim,
                spaceId: digest(JSON.stringify(remoteEmbeddingSpaceParts({ protocol: binding.protocol,
                  providerId: binding.providerId, modelId: binding.modelId, configurationId: binding.configurationId,
                  maxTokens: binding.maxTokens!, dimensions: result.dim }))).slice(0, 16) },
              items: result.vectors.map((vector, index) => ({ id: params.items[index]!.id, index, vector })) };
          },
          embed: async (params) => {
            if (!ledger) return fail('unavailable', 'embedding-ledger-unavailable');
            let finish!: () => void;
            const completion = new Promise<void>(resolve => { finish = resolve; });
            pending.add(completion);
            let receipt: SemanticInferenceReceipt = { batchId: params.batchId, providerId: binding.providerId,
              modelId: binding.modelId, configurationId: binding.configurationId,
              purpose: 'index-document-embedding',
              inputItems: Array.isArray(params.items) ? params.items.length : 0,
              inputBytes: Array.isArray(params.items) ? params.items.reduce((total, item) => total + (typeof item?.text === 'string' ? Buffer.byteLength(item.text, 'utf8') : 0), 0) : 0,
              attempts: 0, attemptsKnown: true, state: 'not-started', usage: { status: 'unknown' } };
            let token: string | undefined;
            let receivedResponse = false;
            let deliveryCheck = false;
            let finished = false;
            let terminalStored = false;
            let transportConstructed = false;
            let transportCompleted = false;
            let transportSettlement: Promise<void> | undefined;
            let settlementTail: Promise<void> = Promise.resolve();
            const settle = (value: SemanticInferenceReceipt, result?: HarnessEmbedResult, noDispatchFinalized?: true, transportStopped?: true): Promise<void> => {
              pendingSettlements++;
              const task = settlementTail.then(() => ledger.settle(token!, { receipt: frozenReceipt(value), ...(result ? { result } : {}), ...(noDispatchFinalized ? { noDispatchFinalized } : {}), ...(transportStopped ? { transportStopped } : {}) }));
              settlementTail = task.catch(() => undefined);
              void task.then(() => { pendingSettlements--; }, () => { pendingSettlements--; });
              return task;
            };
            const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
            const publish = () => {
              const snapshot = frozenReceipt(receipt);
              try { options.onReceipt?.(snapshot); } catch { /* observation only */ }
              try { params.onReceipt?.(snapshot); } catch { /* receipt observation cannot authorize or replay work */ }
              return snapshot;
            };
            const validateDelivery = async () => { await assertAvailable(signal); await params.guard?.(); signal.throwIfAborted(); };
            try {
              if (params.providerId !== binding.providerId || params.modelId !== binding.modelId || params.protocol !== binding.protocol
                || params.configurationId !== binding.configurationId || params.dimensions !== binding.dimensions
                || params.maxTokens !== binding.maxTokens) return fail('invalid', 'embedding-binding-mismatch');
              if (!Array.isArray(params.items) || !params.items.length || params.items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string')
                || new Set(params.items.map(item => item.id)).size !== params.items.length) return fail('invalid', 'embedding-input-invalid');
              if (params.purpose !== 'document' || !params.operationIdentity || params.operationIdentity.kind !== 'index-build'
                || params.operationIdentity.stage !== 'document-embedding') return fail('invalid', 'embedding-operation-identity-invalid');
              await validateDelivery();
              const operation: SemanticInferenceLedgerIdentity = {
                providerId: binding.providerId, modelId: binding.modelId, protocol: 'openai-compatible',
                configurationId: binding.configurationId, endpointHash: digest(provider.requestUrl),
                credentialScopeHash: digest(JSON.stringify(identity.credentialScope)),
                ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }),
                maxTokens: binding.maxTokens!, operation: params.operationIdentity,
                inputHashes: params.items.map(item => digest(item.text)),
              };
              const admission = await ledger.admit({ key: semanticInferenceOperationKey(operation, receipt.purpose),
                identity: operation, receipt: { ...receipt, attemptsKnown: false, state: 'indeterminate' } });
              if (admission.status !== 'admitted') {
                receipt = { ...admission.receipt, reused: true };
                publish();
                if (admission.status === 'indeterminate' || admission.status === 'terminal') {
                  throw new SemanticInferenceError('unavailable', admission.status === 'terminal'
                    ? 'embedding-operation-terminal' : 'embedding-operation-unresolved', frozenReceipt(receipt));
                }
                deliveryCheck = true;
                await validateDelivery();
                // Durable result identity belongs to the original dispatch. Only the response
                // envelope is adapted to this caller's ephemeral transport batch and item IDs.
                return { ...admission.result, batchId: params.batchId,
                  items: admission.result.items.map((item, index) => ({ ...item, id: params.items[index]!.id })), receipt: frozenReceipt(receipt) };
              }
              token = admission.token;
              const connection = options.requests ? await options.requests.egress.prepare(provider.requestUrl, provider.egressOverride) : undefined;
              if (!connection && provider.egressOverride) return fail('unavailable', 'embedding-egress-owner-unavailable');
              const fetchImpl: typeof fetch | undefined = options.fetchImpl ?? (connection
                ? (input, init) => {
                  // Only the captured Egress connection may choose the dispatcher.
                  const { dispatcher: _dispatcher, ...requestInit }: RequestInit & { dispatcher?: unknown } = init ?? {};
                  return connection.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, requestInit);
                }
                : undefined);
              const settings = await readGlobalSettings();
              const retrySettings = parseModelRetrySettings(record(settings) ? settings.retry : undefined);
              const attemptDetails: NonNullable<SemanticInferenceReceipt['attemptDetails']> = [];
              const updateUsage = () => {
                const known = attemptDetails.length > 0 && attemptDetails.every(attempt => attempt.usage);
                const inputKnown = known && attemptDetails.every(attempt => attempt.usage?.inputTokens !== undefined);
                const totalKnown = known && attemptDetails.every(attempt => attempt.usage?.totalTokens !== undefined);
                receipt = { ...receipt, attemptDetails: attemptDetails.map(attempt => ({ ...attempt })),
                  usage: inputKnown || totalKnown ? { status: 'known',
                    ...(inputKnown ? { inputTokens: attemptDetails.reduce((sum, attempt) => sum + attempt.usage!.inputTokens!, 0) } : {}),
                    ...(totalKnown ? { totalTokens: attemptDetails.reduce((sum, attempt) => sum + attempt.usage!.totalTokens!, 0) } : {}) } : { status: 'unknown' } };
              };
              transportConstructed = true;
              const request = (async () => {
                for (let retriesUsed = 0; ; retriesUsed++) {
                  let retryFailure: ModelRetryFailure | undefined;
                  receivedResponse = false;
                  try {
                    return await requestOpenAICompatibleEmbeddings({ baseUrl: provider.baseUrl,
                        ...(provider.headers ? { headers: provider.headers } : {}),
                        ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), model: provider.requestModelId ?? binding.modelId,
                        input: params.items.map(item => item.text), ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }),
                        signal, maxRetries: 0, redirect: 'error', fetchImpl: async (url, init) => {
                          let response: Response;
                          let bytes: ArrayBuffer;
                          try { response = await (fetchImpl ?? fetch)(url, init); bytes = await response.arrayBuffer(); }
                          catch (error) {
                            retryFailure = { code: 'transport_failed', message: error instanceof Error ? error.message : String(error) };
                            attemptDetails.push({ code: 'transport_failed' }); updateUsage(); throw error;
                          }
                          let raw: unknown; try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Keep invalid response diagnosis with the original parser. */ }
                          retryFailure = response.ok ? undefined : responseRetryFailure(response, raw);
                          const code = retryFailure?.code;
                          const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
                          const usage = embeddingWireUsage(raw);
                          attemptDetails.push({ status: response.status, ...(code && /^[a-z0-9._-]+$/i.test(code) ? { code } : {}),
                            ...(requestId ? { requestId } : {}), ...(usage ? { usage } : {}) });
                          updateUsage();
                          return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
                        },
                        beforeDispatch: async request => {
                          await assertAvailable(signal);
                          const auth = await credentials.resolve(identity.credentialScope, signal, { method: 'POST', endpoint: request.url,
                            payloadSha256: digest(request.body) });
                          await validateDelivery();
                          return auth.headers;
                        },
                        onDispatch: () => { if (!finished) { receipt = { ...receipt, attempts: receipt.attempts + 1, attemptsKnown: true, state: 'indeterminate' }; publish(); } },
                        onResponse: response => { receivedResponse = true; receipt = { ...receipt, httpStatus: response.status }; if (!finished) publish(); },
                        onUsage: () => { updateUsage(); if (!finished) publish(); },
                      });
                  } catch (error) {
                    if (!retryFailure || !options.requests || signal.aborted) throw error;
                    // Keep this original token live across attempts. Each drained attempt is
                    // durable before waiting; unknown usage remains unknown in the total.
                    await settle({ ...receipt, state: 'indeterminate', attemptsKnown: true });
                    if (!await waitForRetry(options.requests.kernel, retrySettings, retryFailure, retriesUsed, signal)) throw error;
                    await validateDelivery();
                    await settle({ ...receipt, state: 'indeterminate', attemptsKnown: false });
                  }
                }
              })();
              // The transport, not the cancelled waiter, owns its eventual receipt. A late
              // real response settles cost/result facts without delivering to a cancelled Run.
              const observed = request.then(async result => {
                transportCompleted = true;
                const dim = result.dim;
                const response: HarnessEmbedResult = { batchId: params.batchId,
                  space: { providerId: binding.providerId, modelId: binding.modelId, protocol: binding.protocol,
                    configurationId: binding.configurationId, maxTokens: binding.maxTokens!, dim,
                    spaceId: digest(JSON.stringify(remoteEmbeddingSpaceParts({ protocol: binding.protocol,
                      providerId: binding.providerId, modelId: binding.modelId, configurationId: binding.configurationId,
                      maxTokens: binding.maxTokens!, dimensions: dim }))).slice(0, 16) },
                  items: result.vectors.map((vector, index) => ({ id: params.items[index]!.id, index, vector })) };
                const actualReceipt: SemanticInferenceReceipt = { ...receipt, attemptsKnown: true, state: 'succeeded' };
                receipt = actualReceipt;
                transportSettlement = settle(actualReceipt, response, undefined, true);
                await transportSettlement;
                terminalStored = true;
                if (finished) { try { options.onReceipt?.(frozenReceipt(actualReceipt)); } catch { /* observation only */ } }
                return response;
              }, async error => {
                transportCompleted = true;
                const actualReceipt: SemanticInferenceReceipt = { ...receipt, attemptsKnown: true, state: !receipt.attempts ? 'not-started'
                  : receivedResponse && error instanceof EmbeddingResponseError ? 'failed'
                  : signal.aborted || !receivedResponse ? 'indeterminate' : 'failed' };
                receipt = actualReceipt;
                transportSettlement = settle(actualReceipt, undefined, actualReceipt.state === 'not-started' && actualReceipt.attempts === 0 ? true : undefined, true);
                await transportSettlement;
                terminalStored = actualReceipt.state !== 'indeterminate';
                if (finished) { try { options.onReceipt?.(frozenReceipt(actualReceipt)); } catch { /* observation only */ } }
                throw error;
              });
              transports.add(observed);
              void observed.then(() => transports.delete(observed), () => transports.delete(observed));
              const response = await waitWithSignal(observed, signal);
              deliveryCheck = true;
              await validateDelivery();
              return { ...response, receipt: publish() };
            } catch (error) {
              finished = true;
              let settlementFailed = false;
              // If an actual response already exists, wait only for its durable write, never
              // replace that known provider completion with a cancellation/delivery receipt.
              if (transportSettlement) {
                try { await transportSettlement; } catch { settlementFailed = true; }
              } else if (token && !terminalStored) {
                const noDispatchFinalized = !transportConstructed || transportCompleted;
                const interrupted: SemanticInferenceReceipt = { ...receipt,
                  attemptsKnown: receipt.attempts > 0 || noDispatchFinalized,
                  state: !receipt.attempts ? noDispatchFinalized ? 'not-started' : 'indeterminate'
                    : signal.aborted || !receivedResponse ? 'indeterminate' : 'failed' };
                try { await settle(interrupted, undefined,
                  interrupted.state === 'not-started' && noDispatchFinalized ? true : undefined); }
                catch { settlementFailed = true; }
                if (!transportSettlement) receipt = interrupted;
              }
              if (!(error instanceof SemanticInferenceError && error.receipt && receipt.reused)) {
                receipt = { ...receipt, state: deliveryCheck || terminalStored && receipt.state === 'succeeded' ? 'delivery-blocked'
                  : receipt.state };
              }
              if (settlementFailed) receipt = { ...receipt, state: 'indeterminate' };
              const snapshot = publish();
              if (signal.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError', receipt: snapshot });
              let failure = safeFailure(error);
              if (!(error instanceof SemanticInferenceError) && !(error instanceof EmbeddingResponseError) && receipt.attempts > 0) {
                const network = classifyEgressError(error);
                failure = new SemanticInferenceError('unavailable', `embedding-network-${network.kind}`, undefined, network.message);
              }
              throw new SemanticInferenceError(failure.status, settlementFailed ? 'embedding-settlement-unavailable'
                : failure.code, snapshot, settlementFailed ? undefined : failure.detail);
            } finally { finished = true; pending.delete(completion); finish(); }
          },
        };
      };
      const lease = retain(); transferred = true;
      return lease;
    } catch (error) { throw safeFailure(error); }
    finally {
      if (!transferred) {
        if (capturedCredentials) capturedCredentials.release();
        else capturedProvider?.release?.();
      }
    }
  };
  return {
    readGlobalSettings, capture,
    captureLocal: async (embedder: SemanticEmbedder) => {
      if (closed) return fail('unavailable', 'embedding-owner-closed');
      try { settingsFrom(await readGlobalSettings()); return fail('invalid', 'embedding-local-selection-mismatch'); }
      catch (error) { if (!(error instanceof SemanticInferenceError) || error.status !== 'unconfigured') throw error; }
      const capturedRevocation = revocationGeneration;
      return captureLocalInference(embedder, async signal => {
        if (closed) return fail('unavailable', 'embedding-owner-closed');
        signal?.throwIfAborted();
        // Ordinary edits retain the accepted model; explicit disable remains latched.
        try { await readGlobalSettings(); }
        catch (error) { if (!invalidSettings(error)) throw error; }
        if (disabled || capturedRevocation !== revocationGeneration) return fail('disabled', 'embedding-disabled');
      });
    },
    requests,
    captureRerank: (expected?: import('@varin/protocol').HarnessRerankSettings): Promise<RerankInferenceCapture> => rerank ? rerank.capture(expected) : Promise.resolve({ status: 'unavailable', message: 'Rerank inference is unavailable.' }),
    captureDecision: (purpose: import("@varin/protocol").HarnessFastDecisionPurpose): Promise<DecisionInferenceCapture> => decision
      ? decision.capture(purpose) : Promise.resolve({ status: "unavailable", message: "Native decision inference is unavailable." }),
    inferenceFacts: (filter?: SemanticInferenceFactFilter) => options.ledger
      ? options.ledger.list(filter) : Promise.reject(new SemanticInferenceError('unavailable', 'embedding-ledger-unavailable')),
    stats: () => ({ activeLeases: controllers.size, activeRequests: transports.size,
      activeCalls: pending.size, pendingSettlements }),
    describe: async (): Promise<SemanticInferenceDescription> => {
      try { const lease = await capture(); const binding = lease.binding; lease.release(); return { status: 'ready', binding }; }
      catch (error) { const failure = safeFailure(error); return { status: failure.status, reason: failure.code }; }
    },
    close: (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const release of [...leases]) release();
        decision?.close();
        rerank?.close();
        await Promise.all([...pending]);
        await Promise.allSettled([...transports]);
        await requests?.close();
        await options.ledger?.close();
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
  };
}
export type SemanticInference = ReturnType<typeof createSemanticInference>;
import { parseModelRetrySettings, type ModelRetryFailure } from '@varin/protocol';
import { responseRetryFailure, waitForRetry } from '../../models/retry.js';
