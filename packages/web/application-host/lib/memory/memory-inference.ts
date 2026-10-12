import { sourceIdentity } from './memory-sources.js';
/** Bot MemoryWork admission and original native inference receipts. Knowledge is not written here. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { restoreClassifierResult } from '@varin/pi-host/classifier';
import type { ModelSelection, HarnessFastDecisionParams, HarnessFastDecisionPurposeStatus, MemorySourceSpan } from '@varin/protocol';
import type { HostCredentialAuthority } from '@varin/pi-host/credentials';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { createModelAuthority } from '../kernel/model-authority.js';
import type { ExecutorOwner, ModelSessionConfiguration, CredentialScope, Operation, InferenceStatus, MemoryWorkClaim, MemoryWorkStatus } from '../kernel/protocol.generated.js';
import type { SemanticInference } from '../knowledge/semantic/runtime-inference.js';
import type { DecisionInferenceLease } from '../knowledge/semantic/decision-inference.js';
export interface MemoryInferenceBinding {
  configuration: ModelSessionConfiguration;
  credentialScope: CredentialScope;
}
export interface MemoryWork<R = unknown> {
  workId: string;
  scopeId: string;
  mode: 'automatic' | 'selection';
  runId: string;
  revision: number;
  executionOwner: ExecutorOwner;
  cancelled: boolean;
  consumed: boolean;
  consumerFailed: boolean;
  claims: MemoryWorkClaim[];
  decision: number[] | null;
  inference: Operation[];
  recipe: R & {
    binding: MemoryInferenceBinding;
  };
}
export interface MemorySelectionRequest {
  requestKey: string;
  retryOf?: string;
  conversation: { runtime: 'pi'; sessionId: string } | { runtime: 'agent'; threadId: string; branchId: string; headId: string };
  sources: MemorySourceSpan[];
}
export class MemoryInferenceError extends Error {
  constructor(readonly code: string, message: string, readonly retryDisposition: 'observe' | 'new_attempt' | 'none' = 'observe') {
    super(message);
  }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const state = (op: Operation) => object(op.result?.kind === 'control' ? op.result.value : undefined);
const stopped = (op: Operation) => op.phase === 'terminal' && (object(state(op).receipt).localExecutorStopped === true || state(op).dispatched === false);
const noTransport = (op: Operation) => state(op).dispatched === false || object(state(op).receipt).requestStarted === false;
const fail = (code: string, message: string, retryDisposition: 'observe' | 'new_attempt' | 'none' = 'observe'): never => {
  throw new MemoryInferenceError(code, message, retryDisposition);
};
export const memorySourceClaims = (spans: readonly MemorySourceSpan[]): MemoryWorkClaim[] => spans.map(span => ({
  source: JSON.stringify([...sourceIdentity(span), span.revision]), start: span.start, end: span.end,
}));
export function createMemoryInference(options: {
  kernel: KernelClient;
  runtime: AgentRuntimeClient;
  models: ReturnType<typeof createModelAuthority>;
  authority: HostCredentialAuthority;
  decision: Pick<SemanticInference, 'captureDecision'>;
  /** Registry lookup, not a scope-string test. Sleep/enable authority stays with BotService. */
  validateScope(scopeId: string): Promise<void>;
  canExecuteScope(scopeId: string): Promise<boolean>;
}) {
  const owner: ExecutorOwner = { kind: 'external', identity: 'memory.organizer.v1', epoch: randomUUID() };
  const retained = new Map<string, Awaited<ReturnType<typeof options.models.resolveModel>>>();
  const decisions = new Map<string, DecisionInferenceLease>();
  const active = new Map<string, AbortController>();
  const generations = new Map<string, Promise<{
    work: MemoryWork<unknown>;
    text: string;
  }>>();
  const suspended = new Set<string>();
  let closed = false;
  let change = 0;
  const waiters = new Set<() => void>();
  const notify = () => {
    change++;
    for (const wake of [...waiters])
      wake();
  };
  const waitForChange = (observed: number): Promise<void> => change !== observed ? Promise.resolve() : new Promise(resolve => {
    const wake = () => {
      waiters.delete(wake);
      resolve();
    };
    waiters.add(wake);
    if (change !== observed)
      wake();
  });
  const removers = [options.runtime.onEvent(notify), options.runtime.onReady(notify), options.runtime.onExit(() => {
    for (const controller of active.values())
      controller.abort();
    notify();
  })];
  const settings = () => options.authority.readGlobalInferenceSettings();
  async function guard(work: Pick<MemoryWork, 'scopeId' | 'mode'>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await options.validateScope(work.scopeId);
    if (closed || suspended.has(work.scopeId) || !await options.canExecuteScope(work.scopeId))
      fail('memory-work-suspended', 'Bot memory work is suspended. Wake the Bot before continuing.');
    const document = object(await settings());
    const harness = object(document.harness);
    if (object(object(harness.models).memoryOrganizer).enabled === false)
      fail('memory-organizer-disabled', 'The memory organizer model is disabled.');
    if (work.mode === 'automatic' && object(object(harness.knowledge).autoOrganize).bot === false)
      fail('memory-organizer-disabled', 'Automatic Bot memory organization is disabled.');
    signal?.throwIfAborted();
  }
  async function read<R>(workId: string): Promise<MemoryWork<R>> {
    return options.kernel.agentRuntimeRequest<MemoryWork<R>, 'runtime.memory_work.read'>('runtime.memory_work.read', { workId });
  }
  async function find<R>(key: string): Promise<MemoryWork<R> | null> {
    const id = `memory-work:${key}`;
    const found = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: id, allowMissing: true });
    return found ? read<R>(id) : null;
  }
  async function list<R>(scopeId: string): Promise<MemoryWork<R>[]> {
    await options.validateScope(scopeId);
    const ids = await options.kernel.agentRuntimeRequest<string[], 'runtime.memory_work.list'>('runtime.memory_work.list', { scopeId });
    return Promise.all(ids.map(id => read<R>(id)));
  }
  async function update<R>(work: MemoryWork<R>, action: 'claim' | 'resume' | 'decision' | 'finish' | 'reject', value: unknown = null): Promise<MemoryWork<R>> {
    await options.kernel.agentRuntimeRequest('runtime.memory_work.update', { workId: work.workId, executionOwner: owner, expectedRevision: work.revision, action: action === 'decision' ? { kind: action, keep: value as number[] } : { kind: action } });
    return read<R>(work.workId);
  }
  async function claim<R>(work: MemoryWork<R>, execute = false): Promise<MemoryWork<R>> {
    if (execute)
      await guard(work);
    if (work.inference.some(op => !stopped(op)))
      fail('memory-work-indeterminate', 'The original memory request has no confirmed stop receipt. Its work and provider evidence were retained; inspect or stop that original execution before retrying.');
    work = await update(work, 'claim');
    if (execute && work.mode === 'automatic' && work.cancelled && work.inference.every(op => stopped(op) && op.effect !== 'unknown' && (object(op.intent).parentOperationId === `${work.workId}:decision` || noTransport(op)))) {
      await guard(work);
      work = await update(work, 'resume');
    }
    return work;
  }
  async function bind(selection: ModelSelection, maxOutputTokens?: number): Promise<MemoryInferenceBinding> {
    const model = await options.models.resolveModel(selection);
    const configuration = { ...model.configuration, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
    const credentialScope = await model.credentialOwner.scope();
    retained.set(JSON.stringify([configuration, credentialScope]), model);
    return { configuration, credentialScope };
  }
  async function admit<R extends {
    binding: MemoryInferenceBinding;
  }>(input: {
    key: string;
    scopeId: string;
    mode: 'automatic' | 'selection';
    spans: MemorySourceSpan[];
    recipe: R;
    retryOf?: string;
  }): Promise<MemoryWork<R>> {
    await guard(input);
    const original = await find<R>(input.key);
    if (original)
      return original;
    const workId = `memory-work:${input.key}`;
    try {
      await options.kernel.agentRuntimeRequest('runtime.memory_work.admit', {
        key: input.key, scopeId: input.scopeId, mode: input.mode,
        executionOwner: owner, claims: memorySourceClaims(input.spans), retryOf: input.retryOf ? `memory-work:${input.retryOf}` : null, recipe: input.recipe
      });
    }
    catch (error) {
      const original = await find<R>(input.key);
      if (original)
        return original;
      throw error;
    }
    return read<R>(workId);
  }
  async function describeDecision(): Promise<HarnessFastDecisionPurposeStatus> {
    const captured = await options.decision.captureDecision('memory-organization');
    if (captured.status !== 'ready')
      return captured;
    const result = { status: 'ready' as const, binding: captured.lease.binding };
    captured.lease.release();
    return result;
  }
  async function decide<R>(work: MemoryWork<R>, input: Omit<HarnessFastDecisionParams, 'batchId' | 'configurationId' | 'providerId' | 'modelId' | 'protocol'>, expected: HarnessFastDecisionPurposeStatus | null): Promise<MemoryWork<R>> {
    if (work.decision !== null)
      return work;
    work = await claim(work, true);
    await guard(work);
    const all = input.materials.map((_, index) => index);
    const previous = work.inference.filter(op => object(op.intent).parentOperationId === `${work.workId}:decision`);
    // A failed/lost advisory result keeps the sources. It never replays a paid classifier.
    if (previous.length) {
      if (previous.some(op => !stopped(op)))
        fail('memory-work-indeterminate', 'The original classifier has not confirmed transport drain.');
      const complete = previous.filter(op => op.outcome === 'succeeded');
      if (!complete.length)
        return update(work, 'decision', all);
      try {
        const firstBinding = object(complete[0]!.intent).binding as {
          modelId: string;
          executor: {
            api: string;
          };
        };
        const result = restoreClassifierResult({
          api: firstBinding.executor.api, modelId: firstBinding.modelId,
          state: { goal: input.goal, materials: input.materials }, questions: input.questions,
          requests: previous.map(op => {
            const intent = object(op.intent);
            const binding = object(intent.binding);
            const response = object(state(op).response);
            return {
              endpoint: String(object(binding.executor).endpoint), wire: object(intent.request).wire,
              response: typeof response.bodyBase64 === 'string' ? JSON.parse(Buffer.from(response.bodyBase64, 'base64').toString('utf8')) : null, succeeded: op.outcome === 'succeeded'
            };
          })
        });
        const answers = new Map(result.answers.filter(answer => answer.kind === 'judge').map(answer => [answer.id, answer.value]));
        return update(work, 'decision', all.filter(index => result.missing.includes(`u${index}`) || !answers.has(`u${index}`) || answers.get(`u${index}`)! >= 0.5));
      }
      catch {
        return update(work, 'decision', all);
      }
    }
    if (expected?.status !== 'ready')
      return update(work, 'decision', all);
    const capture = await options.decision.captureDecision('memory-organization');
    if (capture.status !== 'ready')
      return update(work, 'decision', all);
    const lease = capture.lease;
    const controller = new AbortController();
    active.set(work.workId, controller);
    decisions.set(work.workId, lease);
    let keep = all;
    try {
      if (isDeepStrictEqual(lease.binding, expected.binding)) {
        const result = await lease.run({ operationId: `${work.workId}:decision`, executorOwner: owner }, controller.signal, session => session.decide(input, () => guard(work, controller.signal)));
        const answers = new Map(result.answers.filter(answer => answer.kind === 'judge').map(answer => [answer.id, answer.value]));
        keep = all.filter(index => result.missing.includes(`u${index}`) || !answers.has(`u${index}`) || answers.get(`u${index}`)! >= 0.5);
      }
    }
    catch { /* advisory failure keeps every source, after the original request owner has drained */
    }
    finally {
      active.delete(work.workId);
      decisions.delete(work.workId);
      lease.release();
    }
    work = await read<R>(work.workId);
    if (work.inference.some(op => !stopped(op)))
      fail('memory-work-indeterminate', 'The original classifier receipt or transport drain is unresolved.');
    await guard(work);
    return update(work, 'decision', keep);
  }
  async function generateOwned<R>(work: MemoryWork<R>, system: string, prompt: string, signal?: AbortSignal, assertSource?: () => Promise<void>): Promise<{
    work: MemoryWork<R>;
    text: string;
  }> {
    const parentOperationId = `${work.workId}:generation`;
    const prior = work.inference.filter(op => object(op.intent).parentOperationId === parentOperationId);
    const completed = prior.find(op => op.outcome === 'succeeded');
    const output = (op: Operation): string => {
      const response = object(state(op).response);
      const provider = object(response.providerOutput);
      if (provider.finishReason !== 'stop' || typeof response.text !== 'string' || !response.text.trim())
        fail('memory-work-failed', 'The original memory generation was incomplete. Its text and usage were retained.');
      return response.text as string;
    };
    // Read completed original output before consulting today's model selection or credential configuration.
    if (completed) {
      await guard(work, signal);
      await assertSource?.();
      return { work, text: output(completed) };
    }
    const running = prior.find(op => op.phase !== 'terminal');
    if (running) {
      const originalOwner = object(running.intent).callerOwner as ExecutorOwner;
      const cancel = () => {
        void options.kernel.agentRuntimeRequest('runtime.operation.cancel', { operationId: running.id }).catch(() => {
        });
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          if (signal?.aborted)
            cancel();
          const observed = change;
          const status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.status'>('runtime.inference.status', { operationId: running.id, executionOwner: originalOwner });
          if (status.phase === 'terminal') {
            work = await read<R>(work.workId);
            const final = work.inference.find(op => op.id === running.id)!;
            if (!stopped(final))
              fail('memory-work-indeterminate', 'The original generation has no confirmed stop receipt.');
            if (final.outcome === 'succeeded') {
              await guard(work, signal);
              await assertSource?.();
              return { work, text: output(final) };
            }
            fail(final.effect === 'unknown' ? 'memory-work-indeterminate' : 'memory-work-failed', final.effect === 'unknown' ? 'The original request stopped locally, but provider billing is unconfirmed. An explicit Retry starts a new request.' : 'The original generation stopped without a complete result.', 'new_attempt');
          }
          await waitForChange(observed);
        }
      }
      finally {
        signal?.removeEventListener('abort', cancel);
      }
    }
    if (prior.some(op => !noTransport(op)))
      fail(prior.some(op => op.effect === 'unknown' || !stopped(op)) ? 'memory-work-indeterminate' : 'memory-work-failed', 'The original generation did not complete successfully. Its provider evidence was retained. Provider billing may be unconfirmed; an explicit Retry starts a new request.', prior.every(stopped) ? 'new_attempt' : 'observe');
    work = await claim(work, true);
    await guard(work, signal);
    await assertSource?.();
    if (work.cancelled)
      fail('memory-work-failed', 'This original memory work was cancelled.', work.inference.every(stopped) ? 'new_attempt' : 'observe');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    active.set(work.workId, controller);
    const ordinal = prior.length + 1;
    const operationId = `inference:${parentOperationId}:${ordinal}`;
    const binding = work.recipe.binding;
    const epoch = options.kernel.kernelEpoch;
    let registered = false;
    let admitted = false;
    const cancel = () => {
      if (admitted)
        void options.kernel.agentRuntimeRequest('runtime.operation.cancel', { operationId }).catch(() => {
        });
    };
    combined.addEventListener('abort', cancel);
    try {
      let model = retained.get(JSON.stringify([binding.configuration, binding.credentialScope]));
      if (!model) {
        const credentialOwner = await options.models.rebindModel(binding.configuration, binding.credentialScope);
        model = { configuration: binding.configuration, credentialOwner, acceptsImages: false };
      }
      await options.kernel.registerCredentialOwner(work.runId, model.credentialOwner, combined, operationId, {
        kind: 'operation', operationId, assertLive: async () => {
          await guard(work, combined);
          await assertSource?.();
          combined.throwIfAborted();
        }
      });
      registered = true;
      await guard(work, combined);
      await assertSource?.();
      try {
        await options.kernel.agentRuntimeRequest('runtime.inference.generate', {
          parentOperationId, callerOwner: owner, ordinal,
          configuration: binding.configuration, credentialScope: binding.credentialScope, purpose: 'memory-organizer', systemPrompt: system, user: prompt
        });
        admitted = true;
      }
      catch (error) {
        const original = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId, allowMissing: true });
        if (!original)
          throw error;
        admitted = true;
      }
      while (true) {
        if (options.kernel.kernelEpoch !== epoch)
          fail('memory-work-indeterminate', 'The original generation owner was lost. The request will not be replayed.');
        if (combined.aborted)
          cancel();
        try {
          await guard(work, combined);
        }
        catch {
          controller.abort();
          cancel();
        }
        const observed = change;
        const status = await options.kernel.agentRuntimeRequest<InferenceStatus, 'runtime.inference.status'>('runtime.inference.status', { operationId, executionOwner: owner });
        if (status.phase === 'terminal') {
          if (!status.receipt?.localExecutorStopped || status.recovered)
            fail('memory-work-indeterminate', 'The original generation has no confirmed stop receipt.');
          work = await read<R>(work.workId);
          if (combined.aborted)
            fail('memory-work-failed', 'The original generation was cancelled and stopped locally. Provider billing may be unconfirmed; an explicit Retry starts a new request.', 'new_attempt');
          await guard(work, combined);
          const op = work.inference.find(op => op.id === operationId)!;
          if (op.outcome !== 'succeeded')
            fail(op.effect === 'unknown' ? 'memory-work-indeterminate' : 'memory-work-failed', 'Memory generation failed and stopped locally. Its evidence was retained. Provider billing may be unconfirmed; an explicit Retry starts a new request.', 'new_attempt');
          return { work, text: output(op) };
        }
        await waitForChange(observed);
      }
    }
    finally {
      combined.removeEventListener('abort', cancel);
      active.delete(work.workId);
      if (registered && options.kernel.kernelEpoch === epoch)
        options.kernel.unregisterCredentialOwner(work.runId, operationId);
    }
  }
  async function generate<R>(work: MemoryWork<R>, system: string, prompt: string, signal?: AbortSignal, assertSource?: () => Promise<void>): Promise<{
    work: MemoryWork<R>;
    text: string;
  }> {
    const existing = generations.get(work.workId);
    if (existing) {
      const result = await existing;
      await guard(work, signal);
      await assertSource?.();
      return result as {
        work: MemoryWork<R>;
        text: string;
      };
    }
    const task = generateOwned(work, system, prompt, signal, assertSource);
    generations.set(work.workId, task);
    try {
      return await task;
    }
    finally {
      if (generations.get(work.workId) === task)
        generations.delete(work.workId);
    }
  }
  async function finish<R>(work: MemoryWork<R>): Promise<void> {
    work = await read<R>(work.workId);
    if (work.consumed)
      return;
    work = await claim(work);
    await update(work, 'finish');
  }
  async function reject<R>(work: MemoryWork<R>): Promise<void> {
    work = await read<R>(work.workId);
    if (work.consumerFailed)
      return;
    work = await claim(work);
    await update(work, 'reject');
  }
  async function suspendScope(scopeId: string): Promise<void> {
    suspended.add(scopeId);
    // Existing work may belong to an archived Bot. Stopping it needs no new-work permission or content.
    const ids = await options.kernel.agentRuntimeRequest<string[], 'runtime.memory_work.list'>('runtime.memory_work.list', { scopeId });
    const errors: unknown[] = [];
    const status = (workId: string) => options.kernel.agentRuntimeRequest<MemoryWorkStatus, 'runtime.memory_work.status'>('runtime.memory_work.status', { workId });
    const statusStopped = (value: InferenceStatus) => value.phase === 'terminal' && (value.receipt?.localExecutorStopped === true || !value.dispatched);
    for (const id of ids) {
      active.get(id)?.abort();
      try {
        const work = await status(id);
        await options.kernel.agentRuntimeRequest('runtime.run.cancel', { runId: work.runId });
      }
      catch (error) {
        errors.push(error);
      }
    }
    for (const id of ids) {
      try {
        while (true) {
          const observed = change;
          const work = await status(id);
          if (work.inference.every(statusStopped))
            break;
          if (work.inference.some(op => op.recovered && !statusStopped(op)))
            fail('memory-work-indeterminate', 'Bot sleep cannot confirm that the original memory executor stopped. Inspect its retained operation receipt.');
          await waitForChange(observed);
        }
      }
      catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Bot memory stop could not confirm every original executor drained');
  }
  return {
    settings, bind, admit, find, read, list, decide, generate, finish, reject, describeDecision,
    model: (selection: ModelSelection) => options.authority.selectedModel(selection.providerId, selection.modelId),
    suspendScope, resumeScope(scope: string) {
      suspended.delete(scope);
    },
    async close(scopes: string[]) {
      closed = true;
      const results = await Promise.allSettled(scopes.map(suspendScope));
      for (const lease of decisions.values())
        lease.release();
      retained.clear();
      for (const remove of removers)
        remove();
      notify();
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length)
        throw new AggregateError(errors, 'Memory shutdown could not confirm every original executor drained');
    },
  };
}
export type MemoryInference = ReturnType<typeof createMemoryInference>;
