/** Application Host inference leases. No Pi worker, project configuration or secret DTOs. */
import { createHash } from 'node:crypto';
import {
  HarnessInferenceSettingsValidationError, parseHarnessEmbeddingSettings,
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS, remoteEmbeddingSpaceParts,
  type HarnessEmbeddingSettings, type HarnessResolvedEmbeddingBinding,
  type HarnessEmbedParams, type HarnessEmbedResult,
} from '@varin/protocol';
import { EmbeddingResponseError, requestOpenAICompatibleEmbeddings, type EmbeddingUsage } from '@varin/protocol/node/embeddings';
import { waitWithSignal } from '../../cancellation.js';
import { semanticInferenceOperationKey, type SemanticInferenceLedger, type SemanticInferenceLedgerIdentity, type SemanticInferenceOperation, type SemanticInferenceFactFilter } from './inference-ledger-contract.js';
import { ExistingHostCredentialOwner, type NativeCredentialScope, type ExistingModelAuthRuntime } from '../../kernel/native-credential-owner.js';

export interface NativeSemanticProviderBinding {
  providerId: string;
  modelId: string;
  baseUrl: string;
  endpoint?: string;
  requestUrl: string;
  configurationId: string;
  credentialRef: string;
  credentialScope: NativeCredentialScope;
  assertAvailable(): Promise<void>;
  currentScope(): Promise<NativeCredentialScope>;
  getAuth(): ReturnType<ExistingModelAuthRuntime['getAuth']>;
}
export interface NativeSemanticInferenceAuthority {
  resolveEmbeddingBinding(providerId: string, modelId: string): Promise<NativeSemanticProviderBinding>;
  readGlobalInferenceSettings(): Promise<unknown>;
}
export interface NativeSemanticInferenceSettingsOwner { readGlobalSettings(): Promise<unknown> }
export interface NativeSemanticInferenceIdentity {
  providerId: string;
  modelId: string;
  protocol: 'openai-compatible';
  configurationId: string;
  endpoint: string;
  credentialScope: NativeCredentialScope;
}
export interface NativeSemanticInferenceReceipt {
  batchId: string;
  providerId: string;
  modelId: string;
  configurationId: string;
  purpose: 'index-document-embedding' | 'query-embedding';
  inputItems: number;
  inputBytes: number;
  attempts: number;
  /** False only for an unresolved durable dispatch intent after interruption/restart. */
  attemptsKnown: boolean;
  reused?: true;
  state: 'not-started' | 'succeeded' | 'failed' | 'indeterminate' | 'delivery-blocked';
  usage: { status: 'unknown' } | ({ status: 'known' } & EmbeddingUsage);
  httpStatus?: number;
}
export interface NativeSemanticInferenceRequest extends HarnessEmbedParams {
  operationIdentity: SemanticInferenceOperation;
  /** Candidate from the existing vector cache; admission still precedes reuse. */
  cachedResult?: HarnessEmbedResult;
  signal?: AbortSignal;
  /** The native Run's grant owner, checked at dispatch and after the response. */
  guard?(): Promise<void>;
  onReceipt?(receipt: NativeSemanticInferenceReceipt): void;
}
export interface NativeSemanticInferenceLease {
  readonly binding: HarnessResolvedEmbeddingBinding;
  readonly identity: NativeSemanticInferenceIdentity;
  assertAvailable(signal?: AbortSignal): Promise<void>;
  retain(): NativeSemanticInferenceLease;
  release(): void;
  embed(params: NativeSemanticInferenceRequest): Promise<HarnessEmbedResult & { receipt: NativeSemanticInferenceReceipt }>;
}
export type NativeSemanticInferenceStatus = 'unconfigured' | 'disabled' | 'invalid' | 'unavailable';
export type NativeSemanticInferenceDescription = { status: 'ready'; binding: HarnessResolvedEmbeddingBinding }
  | { status: NativeSemanticInferenceStatus; reason: string };
export class NativeSemanticInferenceError extends Error {
  constructor(readonly status: NativeSemanticInferenceStatus, readonly code: string,
    readonly receipt?: NativeSemanticInferenceReceipt) {
    super(code);
    this.name = 'NativeSemanticInferenceError';
  }
}
const fail = (status: NativeSemanticInferenceStatus, code: string): never => { throw new NativeSemanticInferenceError(status, code); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function settingsFrom(document: unknown): HarnessEmbeddingSettings {
  if (!record(document) || (document.harness !== undefined && !record(document.harness))) return fail('invalid', 'embedding-settings-invalid');
  const raw = record(document.harness) ? document.harness.embedding : undefined;
  if (record(raw) && raw.enabled === false) return fail('disabled', 'embedding-disabled');
  const settings = parseHarnessEmbeddingSettings(raw);
  if (!settings) return fail('unconfigured', 'embedding-unconfigured');
  return settings;
}
function safeFailure(error: unknown): NativeSemanticInferenceError {
  if (error instanceof NativeSemanticInferenceError) return error;
  if (error instanceof HarnessInferenceSettingsValidationError) return new NativeSemanticInferenceError('invalid', 'embedding-settings-invalid');
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'inference-settings-invalid') return new NativeSemanticInferenceError('invalid', 'embedding-settings-invalid');
  if (code === 'embedding-provider-disabled') return new NativeSemanticInferenceError('disabled', code);
  if (code === 'embedding-endpoint-invalid' || code === 'embedding-protocol-invalid' || code === 'provider_config_invalid') {
    return new NativeSemanticInferenceError('invalid', 'embedding-provider-invalid');
  }
  return new NativeSemanticInferenceError('unavailable', 'embedding-binding-unavailable');
}
const frozenReceipt = (receipt: NativeSemanticInferenceReceipt): NativeSemanticInferenceReceipt => Object.freeze({ ...receipt, usage: Object.freeze({ ...receipt.usage }) });

export function createNativeSemanticInference(
  authority: NativeSemanticInferenceAuthority,
  settingsOwner: NativeSemanticInferenceSettingsOwner = { readGlobalSettings: () => authority.readGlobalInferenceSettings() },
  options: { ledger?: SemanticInferenceLedger; fetchImpl?: typeof fetch; onReceipt?(receipt: NativeSemanticInferenceReceipt): void } = {},
) {
  let closed = false;
  let closing: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  const transports = new Set<Promise<unknown>>();
  let pendingSettlements = 0;
  let disabled = false;
  let revocationGeneration = 0;
  const readGlobalSettings = async () => {
    const settings = await settingsOwner.readGlobalSettings();
    const nextDisabled = record(settings) && record(settings.harness) && record(settings.harness.embedding)
      && settings.harness.embedding.enabled === false;
    if (nextDisabled && !disabled) revocationGeneration++;
    disabled = nextDisabled;
    return settings;
  };
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const capture = async (): Promise<NativeSemanticInferenceLease> => {
    try {
      if (closed) return fail('unavailable', 'embedding-owner-closed');
      const settings = settingsFrom(await readGlobalSettings());
      const capturedRevocation = revocationGeneration;
      const ledger = options.ledger;
      if (!ledger) return fail('unavailable', 'embedding-ledger-unavailable');
      const provider = await authority.resolveEmbeddingBinding(settings.providerId, settings.modelId);
      if (JSON.stringify(settingsFrom(await readGlobalSettings())) !== JSON.stringify(settings) || capturedRevocation !== revocationGeneration) return fail('unavailable', 'embedding-selection-changed');
      const binding: HarnessResolvedEmbeddingBinding = Object.freeze({ ...settings,
        maxTokens: settings.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS, configurationId: provider.configurationId });
      const identity: NativeSemanticInferenceIdentity = Object.freeze({ providerId: binding.providerId,
        modelId: binding.modelId, protocol: binding.protocol, configurationId: binding.configurationId,
        endpoint: provider.requestUrl, credentialScope: Object.freeze({ ...provider.credentialScope }) });
      const credentials = new ExistingHostCredentialOwner({ providerId: provider.credentialRef,
        providerFamily: 'openai-completions', endpoint: provider.requestUrl,
        currentScope: provider.currentScope, runtime: { getAuth: provider.getAuth } });
      let references = 0;
      let revoked = false;
      const retain = (): NativeSemanticInferenceLease => {
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
          catch (error) { if (!record(error) || error.code !== 'inference-settings-invalid') throw error; }
          if (record(current) && record(current.harness) && record(current.harness.embedding)
            && current.harness.embedding.enabled === false) revoked = true;
          if (revoked || capturedRevocation !== revocationGeneration) return fail('disabled', 'embedding-disabled');
          try { await provider.assertAvailable(); }
          catch (error) {
            const code = record(error) ? error.code : undefined;
            if (code === 'embedding-provider-disabled' || code === 'embedding-provider-removed' || code === 'credential-scope-changed') revoked = true;
            throw error;
          }
          signal?.throwIfAborted();
          if (closed || released) return fail('unavailable', 'embedding-lease-released');
        };
        return {
          binding, identity, assertAvailable,
          retain: () => { if (closed || released) return fail('unavailable', 'embedding-lease-released'); return retain(); },
          release: () => { if (released) return; released = true; references--; controller.abort(); controllers.delete(controller); },
          embed: async (params) => {
            let finish!: () => void;
            const completion = new Promise<void>(resolve => { finish = resolve; });
            pending.add(completion);
            let receipt: NativeSemanticInferenceReceipt = { batchId: params.batchId, providerId: binding.providerId,
              modelId: binding.modelId, configurationId: binding.configurationId,
              purpose: params.purpose === 'query' ? 'query-embedding' : 'index-document-embedding',
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
            const settle = (value: NativeSemanticInferenceReceipt, result?: HarnessEmbedResult, noDispatchFinalized?: true): Promise<void> => {
              pendingSettlements++;
              const task = settlementTail.then(() => ledger.settle(token!, { receipt: frozenReceipt(value), ...(result ? { result } : {}), ...(noDispatchFinalized ? { noDispatchFinalized } : {}) }));
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
              if (!params.operationIdentity || (params.purpose === 'query'
                ? params.operationIdentity.kind !== 'native-query' || params.operationIdentity.stage !== 'native-code-retrieval.semantic.query-embedding'
                : params.operationIdentity.kind !== 'index-build' || params.operationIdentity.stage !== 'document-embedding')) {
                return fail('invalid', 'embedding-operation-identity-invalid');
              }
              if (params.purpose === 'query' && typeof params.guard !== 'function') return fail('invalid', 'embedding-run-authorization-required');
              await validateDelivery();
              const operation: SemanticInferenceLedgerIdentity = {
                providerId: binding.providerId, modelId: binding.modelId, protocol: binding.protocol,
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
                  throw new NativeSemanticInferenceError('unavailable', admission.status === 'terminal'
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
              if (params.cachedResult) {
                const cached = params.cachedResult;
                const space = cached.space;
                const expectedSpace = digest(JSON.stringify(remoteEmbeddingSpaceParts({ protocol: binding.protocol,
                  providerId: binding.providerId, modelId: binding.modelId, configurationId: binding.configurationId,
                  maxTokens: binding.maxTokens!, dimensions: space.dim }))).slice(0, 16);
                if (space.protocol !== binding.protocol || space.providerId !== binding.providerId || space.modelId !== binding.modelId
                  || space.configurationId !== binding.configurationId || space.maxTokens !== binding.maxTokens
                  || space.spaceId !== expectedSpace || !Number.isSafeInteger(space.dim) || space.dim <= 0
                  || (binding.dimensions !== undefined && binding.dimensions !== space.dim)
                  || cached.items.length !== params.items.length || cached.items.some((item, index) => item.index !== index
                    || item.id !== params.items[index]!.id || item.vector.length !== space.dim || item.vector.some(value => !Number.isFinite(value)))) {
                  return fail('invalid', 'embedding-cache-binding-mismatch');
                }
                await validateDelivery();
                const response = { ...cached, batchId: params.batchId };
                receipt = { ...receipt, state: 'succeeded' };
                pendingSettlements++;
                try { await ledger.settle(token, { receipt: frozenReceipt(receipt), result: response }); }
                finally { pendingSettlements--; }
                terminalStored = true;
                deliveryCheck = true;
                await validateDelivery();
                receipt = { ...receipt, reused: true };
                return { ...response, receipt: publish() };
              }
              transportConstructed = true;
              const request = requestOpenAICompatibleEmbeddings({ baseUrl: provider.baseUrl,
                ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), model: binding.modelId,
                input: params.items.map(item => item.text), ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }),
                signal, maxRetries: 0, redirect: 'error', ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                beforeDispatch: async request => {
                  await assertAvailable(signal);
                  const auth = await credentials.resolve(identity.credentialScope, signal, { method: 'POST', endpoint: request.url,
                    payloadSha256: digest(request.body) });
                  await validateDelivery();
                  return auth.headers;
                },
                onDispatch: attempt => { if (!finished) { receipt = { ...receipt, attempts: attempt, attemptsKnown: true, state: 'indeterminate' }; publish(); } },
                onResponse: response => { receivedResponse = true; receipt = { ...receipt, httpStatus: response.status }; if (!finished) publish(); },
                onUsage: usage => { receipt = { ...receipt, usage: { status: 'known', ...usage } }; if (!finished) publish(); },
              });
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
                const actualReceipt: NativeSemanticInferenceReceipt = { ...receipt, attemptsKnown: true, state: 'succeeded' };
                receipt = actualReceipt;
                transportSettlement = settle(actualReceipt, response);
                await transportSettlement;
                terminalStored = true;
                if (finished) { try { options.onReceipt?.(frozenReceipt(actualReceipt)); } catch { /* observation only */ } }
                return response;
              }, async error => {
                transportCompleted = true;
                const actualReceipt: NativeSemanticInferenceReceipt = { ...receipt, attemptsKnown: true, state: !receipt.attempts ? 'not-started'
                  : receivedResponse && error instanceof EmbeddingResponseError ? 'failed'
                  : signal.aborted || !receivedResponse ? 'indeterminate' : 'failed' };
                receipt = actualReceipt;
                transportSettlement = settle(actualReceipt, undefined, actualReceipt.state === 'not-started' && actualReceipt.attempts === 0 ? true : undefined);
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
                const interrupted: NativeSemanticInferenceReceipt = { ...receipt,
                  attemptsKnown: receipt.attempts > 0 || noDispatchFinalized,
                  state: !receipt.attempts ? noDispatchFinalized ? 'not-started' : 'indeterminate'
                    : signal.aborted || !receivedResponse ? 'indeterminate' : 'failed' };
                try { await settle(interrupted, undefined,
                  interrupted.state === 'not-started' && noDispatchFinalized ? true : undefined); }
                catch { settlementFailed = true; }
                if (!transportSettlement) receipt = interrupted;
              }
              if (!(error instanceof NativeSemanticInferenceError && error.receipt && receipt.reused)) {
                receipt = { ...receipt, state: deliveryCheck || terminalStored && receipt.state === 'succeeded' ? 'delivery-blocked'
                  : receipt.state };
              }
              if (settlementFailed) receipt = { ...receipt, state: 'indeterminate' };
              const snapshot = publish();
              if (signal.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError', receipt: snapshot });
              const failure = safeFailure(error);
              throw new NativeSemanticInferenceError(failure.status, settlementFailed ? 'embedding-settlement-unavailable'
                : receipt.state === 'indeterminate' ? 'embedding-dispatch-indeterminate' : failure.code, snapshot);
            } finally { finished = true; pending.delete(completion); finish(); }
          },
        };
      };
      return retain();
    } catch (error) { throw safeFailure(error); }
  };
  return {
    readGlobalSettings, capture,
    inferenceFacts: (filter?: SemanticInferenceFactFilter) => options.ledger
      ? options.ledger.list(filter) : Promise.reject(new NativeSemanticInferenceError('unavailable', 'embedding-ledger-unavailable')),
    stats: () => ({ activeLeases: controllers.size, activeRequests: transports.size,
      activeCalls: pending.size, pendingSettlements }),
    describe: async (): Promise<NativeSemanticInferenceDescription> => {
      try { const lease = await capture(); const binding = lease.binding; lease.release(); return { status: 'ready', binding }; }
      catch (error) { const failure = safeFailure(error); return { status: failure.status, reason: failure.code }; }
    },
    close: (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const controller of controllers) controller.abort();
        controllers.clear();
        await Promise.all([...pending]);
        await Promise.allSettled([...transports]);
        await options.ledger?.close();
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
  };
}
export type NativeSemanticInference = ReturnType<typeof createNativeSemanticInference>;
