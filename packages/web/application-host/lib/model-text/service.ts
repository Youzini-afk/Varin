/** Product utility requests use the original native inference executor and Catalog receipts. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { createModelAuthority } from '../kernel/model-authority.js';
import type { ExecutorOwner, ModelTextView, ModelTextStatus, Operation } from '../kernel/protocol.generated.js';

export type ModelTextPurpose = 'git-commit' | 'review' | 'title' | 'text';
export interface ModelTextSelection { providerId: string; modelId: string }
export interface ModelTextInput {
  key: string;
  purpose: ModelTextPurpose;
  prompt: string;
  system?: string | undefined;
  model?: ModelTextSelection | undefined;
  maxOutputTokens?: number | undefined;
  responseSchema?: unknown;
  retryOf?: string | undefined;
  signal?: AbortSignal | undefined;
}
export interface ModelTextResult { requestId: string; text: string; providerId: string; modelId: string }
/** Trusted callers can supply a captured draft through the same inference owner. */
export interface PreparedTextModel {
  identity: string;
  resolve(): ReturnType<ReturnType<typeof createModelAuthority>['resolveModel']>;
}
export interface ModelTextDescription {
  providerID: string; modelID: string; source: 'request' | 'utility' | 'default';
  inputCharBudget: number; contextTokens: number; contextKnown: boolean;
  outputTokens: number | null; outputTokenLimit: number | null; structuredOutput: boolean | null; hasLogin?: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fail = (code: string, message: string, statusCode = 409, requestId?: string): never => { throw Object.assign(new Error(message), { code, statusCode, ...(requestId ? { requestId } : {}) }); };
const state = (op: Operation | null) => record(op?.result?.kind === 'control' ? op.result.value : undefined);
const statusDrained = (status: ModelTextStatus) => !status.inference ? status.cancelled : status.inference.phase === 'terminal' && (status.inference.receipt?.localExecutorStopped === true || !status.inference.dispatched);
const drained = (op: Operation | null) => Boolean(op?.phase === 'terminal' && (record(state(op).receipt).localExecutorStopped === true || state(op).dispatched === false));
export function parseModelTextSelection(value: unknown): ModelTextSelection {
  const selection = record(value);
  if (typeof selection.providerId !== 'string' || !selection.providerId.trim() || typeof selection.modelId !== 'string' || !selection.modelId.trim()) {
    return fail('model-selection-invalid', 'Choose an explicit provider and model.', 400);
  }
  return { providerId: selection.providerId.trim(), modelId: selection.modelId.trim() };
}
export function createModelTextService(options: {
  kernel: KernelClient;
  runtime: Pick<AgentRuntimeClient, 'onEvent' | 'onReady' | 'onExit'>;
  models: ReturnType<typeof createModelAuthority>;
  readSettings(): Promise<unknown>;
}) {
  const owner: ExecutorOwner = { kind: 'external', identity: 'model.text.v1', epoch: randomUUID() };
  // These are concurrent observers/controls only. Admission, inputs, receipts and replay decisions live in Catalog.
  const pending = new Map<string, { fingerprint: string; controller: AbortController; promise: Promise<ModelTextResult> }>();
  const drains = new Map<string, Promise<void>>();
  let closed = false;
  let revision = 0;
  const waiters = new Set<() => void>();
  const wake = () => { revision++; for (const resolve of [...waiters]) resolve(); };
  const removers = [options.runtime.onEvent(wake), options.runtime.onReady(wake), options.runtime.onExit(wake)];
  const wait = async (observed: number) => {
    if (observed !== revision) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
      // A lost observation must not release a live original request. Retry only its read.
      const timer = setTimeout(done, 1000);
      waiters.add(done);
      if (observed !== revision) done();
    });
  };
  async function selection(explicit?: ModelTextSelection) {
    if (explicit) return { ...parseModelTextSelection(explicit), source: 'request' as const };
    const settings = record(await options.readSettings());
    if (settings.utilityModel !== undefined && settings.utilityModel !== null) return { ...parseModelTextSelection(settings.utilityModel), source: 'utility' as const };
    if (typeof settings.defaultProvider !== 'string' || typeof settings.defaultModel !== 'string' || !settings.defaultProvider.trim() || !settings.defaultModel.trim()) {
      return fail('model-not-configured', 'Select a utility model or configure the default provider and model.', 409);
    }
    return { ...parseModelTextSelection({ providerId: settings.defaultProvider, modelId: settings.defaultModel }), source: 'default' as const };
  }
  const read = (requestId: string, allowMissing = false, signal?: AbortSignal) => options.kernel.agentRuntimeRequest<ModelTextView | null, 'runtime.model_text.read'>('runtime.model_text.read', { requestId, allowMissing }, signal);
  const status = (requestId: string, allowMissing = false, signal?: AbortSignal) => options.kernel.agentRuntimeRequest<ModelTextStatus | null, 'runtime.model_text.status'>('runtime.model_text.status', {requestId,allowMissing}, signal);
  const cancel = (requestId: string) => options.kernel.agentRuntimeRequest<ModelTextStatus, 'runtime.model_text.cancel'>('runtime.model_text.cancel', { requestId });
  function retainDrain(requestId: string, runId: string, operationId: string, epoch: string | null) {
    if (drains.has(requestId)) return;
    const task = (async () => {
      while (options.kernel.kernelEpoch === epoch) {
        const observed = revision;
        try {
          const work = await status(requestId);
          if (work && statusDrained(work)) {
            options.kernel.unregisterCredentialOwner(runId, operationId);
            return;
          }
          if (closed) await cancel(requestId);
        } catch { /* Keep the captured owner until original drain or actual epoch loss. */ }
        await wait(observed);
      }
    })().finally(() => { drains.delete(requestId); });
    drains.set(requestId, task);
  }
  const identity = (work: ModelTextView) => ({ requestId: work.requestId, providerId: work.generation.configuration.providerId!,
    modelId: work.generation.configuration.catalogModelId ?? work.generation.configuration.model });
  function result(work: ModelTextView): ModelTextResult {
    const op = work.inference;
    if (op?.phase !== 'terminal') return fail('model-text-pending', 'The original text request is still running.', 409, work.requestId);
    const response = record(state(op).response);
    if (op.outcome === 'succeeded' && drained(op) && typeof response.text === 'string' && response.text.trim()) return { ...identity(work), text: response.text.trim() };
    if (record(response.providerOutput).finishReason === 'length') return fail('output-exhausted', 'The original response reached its output limit. Choose more output capacity for an explicit new request.', 409, work.requestId);
    return fail(op.effect === 'unknown' || !drained(op) ? 'model-text-indeterminate' : 'model-text-failed',
      !drained(op) ? 'The original request has no confirmed executor stop. Inspect it before retrying.'
        : op.effect === 'unknown' ? 'The original request stopped locally, but provider completion and billing are unconfirmed. An explicit retry creates a new request.'
          : 'The original request stopped without a complete result. An explicit retry creates a new request.', 409, work.requestId);
  }
  async function loadResult(requestId: string): Promise<ModelTextResult> {
    let work: ModelTextView | null;
    try { work = await read(requestId); }
    catch { return fail('model-text-output-unavailable', 'The original request stopped, but its retained output could not be read. Inspect this original request; it will not be replayed.', 503, requestId); }
    if (!work) return fail('model-text-missing', 'Original output is unavailable.', 404, requestId);
    return result(work);
  }
  function projection(work: ModelTextStatus) {
    const op = work.inference;
    return { requestId: work.requestId, providerId: work.providerId, modelId: work.modelId, purpose: work.purpose,
      phase: op?.phase ?? (work.cancelled ? 'terminal' : 'accepted'), outcome: op?.outcome ?? (work.cancelled ? 'cancelled' : null),
      effect: work.effect, cancelRequested: work.cancelled || op?.cancelRequested === true, retryAllowed: work.retryAllowed,
      executorStopped: statusDrained(work), receipt: op?.receipt ?? null };
  }
  async function observe(requestId: string, epoch: string | null, signal: AbortSignal): Promise<ModelTextStatus> {
    let cancelRequested = false;
    while (true) {
      if (options.kernel.kernelEpoch !== epoch) return fail('model-text-indeterminate', 'The original native executor was lost. Its request will not be replayed.', 409, requestId);
      const observed = revision;
      if (signal.aborted && !cancelRequested) {
        try { await cancel(requestId); cancelRequested = true; } catch { /* Retry the original cancellation intent, never generation. */ }
      }
      let work: ModelTextStatus | null;
      try { work = await status(requestId); } catch { await wait(observed); continue; }
      if (!work) return fail('model-text-missing', 'The original text request is unavailable.', 404, requestId);
      if (work.inference?.phase === 'terminal') return work;
      if (!work.inference && work.cancelled) return work;
      await wait(observed);
    }
  }
  async function execute(input: ModelTextInput, fingerprint: string, signal: AbortSignal, prepared?: PreparedTextModel): Promise<ModelTextResult> {
    const requestId = `model-text:${input.key}`;
    const original = await status(requestId, true);
    if (original) {
      if (original.requestFingerprint !== fingerprint) return fail('model-text-key-conflict', 'This request key already belongs to different input.', 409, requestId);
      const work = original.inference?.phase === 'terminal' || original.cancelled ? original : await observe(requestId, options.kernel.kernelEpoch, signal);
      if (!work.inference) return fail('model-text-cancelled', 'The original request was cancelled before inference started.', 409, requestId);
      return loadResult(requestId);
    }
    if (closed) return fail('model-text-closed', 'Text generation is shutting down.', 503);
    signal.throwIfAborted();
    const chosen = await selection(input.model);
    const model = await (prepared ? prepared.resolve() : options.models.resolveModel(chosen));
    let registered = false;
    let admitted = false;
    let safelyReleased = false;
    let epoch = options.kernel.kernelEpoch;
    const runId = `${requestId}:run`, operationId = `inference:${requestId}:1`;
    try {
      const configuration = { ...model.configuration };
      if (input.maxOutputTokens !== undefined) configuration.maxOutputTokens = configuration.maxOutputTokens ? Math.min(configuration.maxOutputTokens, input.maxOutputTokens) : input.maxOutputTokens;
      const credentialScope = await model.credentialOwner.scope();
      const systemPrompt = `${input.system?.trim() || 'Complete the requested text task. Return only the requested answer.'}${input.responseSchema === undefined ? '' : `\nReturn JSON conforming to this schema:\n${JSON.stringify(input.responseSchema)}`}`;
      const generation = { parentOperationId: requestId, callerOwner: owner, ordinal: 1, configuration, credentialScope,
        purpose: input.purpose, systemPrompt, user: input.prompt.trim() };
      signal.throwIfAborted();
      try { await options.kernel.agentRuntimeRequest('runtime.model_text.admit', { key: input.key, requestFingerprint: fingerprint, retryOf: input.retryOf ?? null, generation }); admitted = true; }
      catch (error) {
        // Resolve lost admission through the same durable key before releasing its binding.
        while (true) {
          if (options.kernel.kernelEpoch !== epoch) throw error;
          try { const work = await status(requestId, true); if (!work) { safelyReleased = true; throw error; } admitted = true; break; }
          catch (readError) { if (readError === error) throw error; await wait(revision); }
        }
      }
      epoch = options.kernel.kernelEpoch;
      const work = await status(requestId);
      if (!work || work.requestFingerprint !== fingerprint) return fail('model-text-key-conflict', 'This key belongs to another request.', 409, requestId);
      if (!isDeepStrictEqual(work.executionOwner, owner)) {
        safelyReleased = true;
        await observe(requestId, epoch, signal);
        return await loadResult(requestId);
      }
      await options.kernel.registerCredentialOwner(runId, model.credentialOwner, undefined, operationId, {
        kind: 'operation', operationId, assertLive: async () => { signal.throwIfAborted(); if (closed) fail('model-text-closed', 'Text generation is shutting down.', 503); }
      });
      registered = true;
      try { await options.kernel.agentRuntimeRequest('runtime.inference.generate', generation); }
      catch (error) {
        const current = await status(requestId);
        if (!current?.inference) { await cancel(requestId); safelyReleased = true; throw error; }
      }
      const final = await observe(requestId, epoch, signal);
      safelyReleased = statusDrained(final);
      return await loadResult(requestId);
    } catch (error) {
      if (admitted && !safelyReleased && options.kernel.kernelEpoch === epoch) {
        // Any infrastructure failure still owns cancellation and drain of this exact request.
        while (options.kernel.kernelEpoch === epoch) {
          try { await cancel(requestId); break; } catch { await wait(revision); }
        }
        if (options.kernel.kernelEpoch === epoch) {
          const final = await observe(requestId, epoch, signal);
          safelyReleased = statusDrained(final);
          if (final.inference?.outcome === 'succeeded') return await loadResult(requestId);
        }
      }
      throw error;
    } finally {
      // Never release a live original registration because an HTTP observer failed or aborted.
      if (registered && options.kernel.kernelEpoch === epoch) {
        if (safelyReleased) options.kernel.unregisterCredentialOwner(runId, operationId);
        else retainDrain(requestId, runId, operationId, epoch);
      }
      model.credentialOwner.release();
    }
  }
  const generate = (input: ModelTextInput, prepared?: PreparedTextModel): Promise<ModelTextResult> => {
    if (!input || typeof input.key !== 'string' || !input.key.trim() || !['git-commit', 'review', 'title', 'text'].includes(input.purpose)
      || typeof input.prompt !== 'string' || !input.prompt.trim() || (input.system !== undefined && typeof input.system !== 'string')
      || (input.retryOf !== undefined && (typeof input.retryOf !== 'string' || !input.retryOf.startsWith('model-text:')))
      || (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0))) return Promise.reject(Object.assign(new Error('A request key, purpose and prompt are required.'), { statusCode: 400, code: 'model-text-input-invalid' }));
    const fingerprint = createHash('sha256').update(JSON.stringify({ purpose: input.purpose, prompt: input.prompt, system: input.system ?? null,
      model: input.model ? parseModelTextSelection(input.model) : null, ...(prepared ? { preparedIdentity: prepared.identity } : {}), maxOutputTokens: input.maxOutputTokens ?? null, responseSchema: input.responseSchema ?? null, schemaProvided: input.responseSchema !== undefined, retryOf: input.retryOf ?? null })).digest('hex');
    const existing = pending.get(input.key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('This request key already belongs to different input.'), { statusCode: 409, code: 'model-text-key-conflict' }));
      return existing.promise;
    }
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const promise = execute(input, fingerprint, signal, prepared).finally(() => { pending.delete(input.key); });
    pending.set(input.key, { fingerprint, controller, promise });
    return promise;
  };
  return {
    async original(key: string, signal?: AbortSignal) {
      const work = await read(`model-text:${key}`, true, signal);
      return work ? { purpose: work.generation.purpose, prompt: work.generation.user } : null;
    },
    /** Resume only an admission which Catalog proves never reached inference.
     * Completed output is reused; sent/uncertain requests are never regenerated here. */
    async resumeUnsent(key: string, signal?: AbortSignal): Promise<ModelTextResult | null> {
      let current = await status(`model-text:${key}`, true, signal);
      while (current) {
        signal?.throwIfAborted();
        if (current.inference?.outcome === 'succeeded' && statusDrained(current)) return loadResult(current.requestId);
        if (current.inference || !current.cancelled || !current.retryAllowed) return null;
        const nextKey = `model-text-resume:${createHash('sha256').update(current.requestId).digest('hex')}`;
        const next = await status(`model-text:${nextKey}`, true, signal);
        if (next) { current = next; continue; }
        const original = await read(current.requestId, false, signal);
        if (!original) return null;
        signal?.throwIfAborted();
        // This is a new, linked admission using current auxiliary settings. Only
        // an unsent original permits it; the native owner rechecks that fence.
        return generate({ key: nextKey, retryOf: current.requestId, purpose: original.generation.purpose as ModelTextPurpose,
          prompt: original.generation.user, system: original.generation.systemPrompt, signal });
      }
      return null;
    },
    async describe(input: { model?: ModelTextSelection | undefined; purpose?: ModelTextPurpose; outputReserveTokens?: number | ((limits: { contextTokens: number; outputTokenLimit: number | null }) => number) } = {}): Promise<ModelTextDescription> {
      const chosen = await selection(input.model);
      const model = await options.models.describeModel(chosen);
      const contextTokens = model.contextWindowTokens ?? 0;
      const outputTokenLimit = model.maxOutputTokens;
      const requested = typeof input.outputReserveTokens === 'function' ? input.outputReserveTokens({ contextTokens, outputTokenLimit }) : input.outputReserveTokens;
      const outputTokens = requested === undefined ? outputTokenLimit : outputTokenLimit === null ? requested : Math.min(requested, outputTokenLimit);
      return { providerID: chosen.providerId, modelID: chosen.modelId, source: chosen.source, contextTokens, contextKnown: contextTokens > 0,
        inputCharBudget: contextTokens ? Math.max(0, contextTokens - (outputTokens ?? 0)) * 4 : Number.MAX_SAFE_INTEGER,
        outputTokens, outputTokenLimit, structuredOutput: null };
    },
    async inspect(requestId: string) {
      const work = await status(requestId);
      if (!work) return fail('model-text-missing', 'Text request not found.', 404);
      const metadata = projection(work);
      if (work.inference?.outcome !== 'succeeded') return metadata;
      try { return { ...metadata, text: (await loadResult(requestId)).text, outputStatus: 'available' as const }; }
      catch { return { ...metadata, outputStatus: 'unavailable' as const }; }
    },
    async cancel(requestId: string) { return projection(await cancel(requestId)); },
    generate,
    async close() { closed = true; for (const task of pending.values()) task.controller.abort(); wake(); await Promise.allSettled([...pending.values()].map(task => task.promise)); await Promise.allSettled([...drains.values()]); for (const remove of removers) remove(); },
  };
}
export type ModelTextService = ReturnType<typeof createModelTextService>;
