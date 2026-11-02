/** The Host prepares one choice; Catalog and original inference Operations own durability. */
import { randomUUID } from 'node:crypto';
import { DEFAULT_COMPACTION_RESERVE_RATIO, resolveHarnessDelegationModelSelectionSettings } from '@varin/protocol';
import type { ThreadThinkingLevel } from '@varin/application-client';
import type { ModelsService } from '../models/service.js';
import { delegationModelIdentity, readDelegationModelCatalog } from '../models/delegation-catalog.js';
import type { createModelAuthority } from './model-authority.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { DelegatedExecution, DelegationModelChoice, DelegationModelSelection, ExecutorOwner, Operation } from './protocol.generated.js';
import { createInferenceRequests, type InferenceRequestsOptions } from '../knowledge/semantic/inference-requests.js';
import { createDecisionInference } from '../knowledge/semantic/decision-inference.js';
import { restoreClassifierResult } from '../models/classifier.js';
import { acquireTokenCounter } from '../models/token-count.js';
import { modelTextSystem } from '../model-text/service.js';
import { DELEGATION_SELECTION_SCHEMA, DELEGATION_SELECTION_SYSTEM, packDelegationSelection, selectionQuestions, validateDelegationChoice } from './delegation-selection-context.js';
import { waitForModelBinding } from './model-binding-lifetime.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const state = (op: Operation) => object(op.result?.kind === 'control' ? op.result.value : undefined);
const stopped = (op: Operation) => op.phase === 'terminal' && (object(state(op).receipt).localExecutorStopped === true || state(op).dispatched === false);
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const purpose = 'delegation-model-selection' as const;
export function createDelegationModelSelection(options: {
  kernel: KernelClient; runtime: AgentRuntimeClient; models: ReturnType<typeof createModelAuthority>; authority: ModelsService;
  inference: InferenceRequestsOptions;
}) {
  const owner: ExecutorOwner = { kind: 'external', identity: 'delegation.model.selection.v1', epoch: randomUUID() };
  const requests = createInferenceRequests(options.inference);
  function chatChoice(work: DelegationModelSelection, operation: Operation | undefined): DelegationModelChoice {
    const response = operation && object(state(operation).response);
    const failure = object(response?.failure);
    if (operation && stopped(operation) && operation.outcome !== 'succeeded' && typeof failure.code === 'string') {
      return fail(failure.code, failure.code.startsWith('delegation-selection-capacity-') && typeof failure.message === 'string'
        ? failure.message : `The original selector failed (${failure.code}); inspect its retained inference evidence.`);
    }
    if (!operation || !stopped(operation) || operation.outcome !== 'succeeded' || typeof response?.text !== 'string'
      || object(response.providerOutput).finishReason === 'length') return fail('delegation-selection-failed', 'The original selection did not return a complete choice.');
    let choice: unknown;
    try { choice = JSON.parse(response.text); }
    catch { return fail('delegation-selection-invalid-response', 'The original selection response is not valid JSON.'); }
    return validateDelegationChoice(choice, work.recipe.choices);
  }
  async function restore(work: DelegationModelSelection): Promise<DelegationModelChoice | null> {
    if (work.result) return validateDelegationChoice(work.result, work.recipe.choices);
    if (!work.inference.length) return null;
    if (work.inference.some(op => !stopped(op))) return fail('delegation-selection-indeterminate', 'The original selection request has no confirmed executor stop; it will not be replayed.');
    if (work.recipe.catalog.selector?.operation === 'chat') {
      return chatChoice(work, work.inference.at(-1));
    }
    const first = work.inference[0]!;
    const binding = object(object(first.intent).binding), executor = object(binding.executor);
    const input = object(object(object(first.intent).request).input);
    let result: ReturnType<typeof restoreClassifierResult>;
    try { result = restoreClassifierResult({ api: String(executor.api), modelId: String(binding.modelId),
      state: { goal: input.goal, materials: input.materials, ...(input.context === undefined ? {} : { context: input.context }) },
      questions: selectionQuestions(work.recipe.choices), requests: work.inference.map(op => {
        const intent = object(op.intent), binding = object(intent.binding), response = object(state(op).response);
        let body: unknown = null;
        if (typeof response.bodyBase64 === 'string') {
          try { body = JSON.parse(Buffer.from(response.bodyBase64, 'base64').toString('utf8')); }
          catch { /* Failed transport attempts may contain non-JSON bytes; their original receipts remain intact. */ }
        }
        return { endpoint: String(object(binding.executor).endpoint), wire: object(intent.request).wire,
          response: body,
          succeeded: op.outcome === 'succeeded' };
      }) }); }
    catch { return fail('delegation-selection-invalid-response', 'The original classifier response cannot be interpreted as a selection.'); }
    return classifierChoice(work, result);
  }
  function classifierChoice(work: DelegationModelSelection, result: { answers: import('@varin/protocol').FastDecisionAnswer[]; missing: string[] }) {
    const answer = result.answers.find(answer => answer.id === 'execution');
    const choice = answer?.kind === 'choose' && answer.choice !== null ? work.recipe.choices.find((_, index) => `choice:${index}` === answer.choice) : undefined;
    if (!choice || result.missing.length) return fail('delegation-selection-invalid-response', 'The classifier did not select a valid execution combination.');
    return choice;
  }
  async function select(work: DelegationModelSelection, signal: AbortSignal): Promise<DelegationModelChoice> {
    const restored = await restore(work);
    if (restored) return restored;
    if (work.recipe.choices.length === 1) return work.recipe.choices[0]!;
    const selector = work.recipe.catalog.selector;
    if (!selector) return fail('delegation-selector-unconfigured', 'There is no configured selector for the remaining execution choices.');
    const invocation = { operationId: work.operationId, executorOwner: owner };
    if (selector.operation === 'decision') {
      const decisions = createDecisionInference({ resolveDecisionBinding: (provider, model, endpoint) => options.authority.resolveDecisionBinding(provider, model, endpoint, selector.configurationFingerprint) },
        async () => ({ harness: { fastDecision: { purposes: { [purpose]: { protocol: 'typed-classifier', providerId: selector.providerId, modelId: selector.modelId } } } } }), options.inference, requests);
      let capture: Awaited<ReturnType<typeof decisions.capture>>;
      try {
        capture = await waitForModelBinding(decisions.capture(purpose), value => { if (value.status === 'ready') value.lease.release(); }, signal);
      } catch (error) { decisions.close(); throw error; }
      if (capture.status !== 'ready') { decisions.close(); return fail('delegation-selector-unavailable', capture.message ?? 'The configured decision selector is unavailable.'); }
      const lease = capture.lease;
      try {
        const choices = work.recipe.choices;
        if (lease.binding.maxChoiceOptions !== undefined && choices.length > lease.binding.maxChoiceOptions) return fail('delegation-selection-options-exceeded', `The selector interface supports ${lease.binding.maxChoiceOptions} choices, but this dispatch has ${choices.length} valid combinations.`);
        const capacity = lease.binding.contextWindowTokens;
        if (!capacity) return fail('delegation-selection-capacity-unknown', 'Configure the selector model context capacity.');
        const questions = selectionQuestions(choices);
        const input = (context: unknown) => ({ purpose, goal: DELEGATION_SELECTION_SYSTEM, materials: [], context, questions });
        const material = await packDelegationSelection(work.recipe, async material => {
          const counted = await lease.countInput(input(material));
          return counted.tokens <= Math.floor(capacity * (1 - DEFAULT_COMPACTION_RESERVE_RATIO))
            && (lease.binding.perQuestionContextWindowTokens === undefined || (counted.perQuestionTokens ?? counted.tokens) <= Math.floor(lease.binding.perQuestionContextWindowTokens * (1 - DEFAULT_COMPACTION_RESERVE_RATIO)));
        }, signal);
        try {
          const result = await lease.run(invocation, signal, session => session.decide(input(material)));
          return classifierChoice(work, result);
        } catch (error) {
          signal.throwIfAborted();
          if (typeof object(error).code === 'string') throw error;
          return fail('delegation-selection-failed', error instanceof Error ? error.message : 'The original classifier selection failed.');
        }
      } finally { lease.release(); decisions.close(); }
    }
    const model = await waitForModelBinding(options.models.resolveModel({ providerId: selector.providerId, modelId: selector.modelId,
      ...(selector.thinkingLevel ? { thinkingLevel: selector.thinkingLevel as ThreadThinkingLevel } : {}) }, undefined, selector.configurationFingerprint), value => value.credentialOwner.release(), signal);
    let counter: Awaited<ReturnType<typeof acquireTokenCounter>> | undefined;
    try {
      const configuration = model.configuration;
      const capacity = configuration.contextWindowTokens;
      if (!capacity) return fail('delegation-selection-capacity-unknown', 'Configure the selector model context capacity.');
      const reserve = Math.max(configuration.maxOutputTokens ?? 2048, Math.ceil(capacity * DEFAULT_COMPACTION_RESERVE_RATIO));
      const system = modelTextSystem({ system: DELEGATION_SELECTION_SYSTEM, responseSchema: DELEGATION_SELECTION_SCHEMA });
      counter = await acquireTokenCounter(options.kernel, configuration);
      const material = await packDelegationSelection(work.recipe, async material => {
        const texts = [system, JSON.stringify({ ...material, choices: work.recipe.choices })];
        const counted = await counter!.count(texts);
        const counts = counted.tokenizer.includes('reference tokenizer') ? texts.map(text => Buffer.byteLength(text, 'utf8')) : counted.counts;
        return counts.reduce((sum, count) => sum + count, 64) <= capacity - reserve;
      }, signal);
      const scope = await model.credentialOwner.scope();
      return await requests.run(invocation, signal, async call => {
        await call.assertFresh();
        let operationId: string | undefined;
        try { await call.generate({ request: { configuration, credentialScope: scope, purpose, systemPrompt: system,
          user: JSON.stringify({ ...material, choices: work.recipe.choices }) },
          check: async active => { active.throwIfAborted(); },
          register: async (id, active) => { operationId = id; await options.kernel.registerCredentialOwner(work.runId, model.credentialOwner, undefined, id,
            { kind: 'operation', operationId: id, assertLive: async () => { active.throwIfAborted(); } }); },
          release: id => options.kernel.unregisterCredentialOwner(work.runId, id),
        }); } catch (error) {
          signal.throwIfAborted();
          if (operationId) {
            const original = await options.kernel.agentRuntimeRequest<Operation | null, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId, allowMissing: true });
            if (original && stopped(original)) return chatChoice(work, original);
          }
          throw error;
        }
        // Completion and parsing use the original durable response, including its finish reason.
        // A truncated or malformed response never authorizes another paid generation.
        const original = await options.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: operationId! });
        signal.throwIfAborted();
        return chatChoice(work, original);
      });
    } finally { try { await counter?.release(); } finally { model.credentialOwner.release(); } }
  }
  return {
    async prepare(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
      if (child.trigger.kind !== 'dispatch' || !child.selected_profile.model_selection_required) return child;
      const original = await options.kernel.agentRuntimeRequest<DelegationModelSelection | null, 'runtime.child.model.read'>('runtime.child.model.read', { executionId: child.execution_id }, signal);
      let catalog: DelegationModelSelection['recipe']['catalog'] | undefined;
      if (!original) {
        const input = object(child.input);
        if (input.model !== undefined && input.thinking !== undefined) {
          // Both dimensions are fixed: even a disabled/unavailable selector cannot interfere.
          catalog = await readDelegationModelCatalog(options.authority, { enabled: false }, input.model as string);
        } else {
          const document = await options.authority.readGlobalInferenceSettings();
          const settings = resolveHarnessDelegationModelSelectionSettings(object(object(document).harness).delegationModelSelection);
          let fixedModel = input.model as string | undefined;
          if (!settings.enabled && fixedModel === undefined && input.thinking !== undefined) {
            const inherited = object(child.configuration), modelId = inherited.catalogModelId ?? inherited.model;
            if (typeof inherited.providerId !== 'string' || !inherited.providerId.trim() || typeof modelId !== 'string' || !modelId.trim()) {
              return fail('delegation-inherited-model-unavailable', 'The original inherited execution model identity is unavailable.');
            }
            fixedModel = delegationModelIdentity(inherited.providerId, modelId);
          }
          // Disabled implicit inheritance must not consult unrelated model configurations.
          catalog = !settings.enabled && input.model === undefined && input.thinking === undefined
            ? { candidates: [], selector: null } : await readDelegationModelCatalog(options.authority, settings, fixedModel);
        }
      }
      signal.throwIfAborted();
      const work = await options.kernel.agentRuntimeRequest<DelegationModelSelection, 'runtime.child.model.prepare'>('runtime.child.model.prepare', {
        executionId: child.execution_id, executionOwner: owner, ...(catalog ? { catalog } : {}),
      }, signal);
      if (work.result) return options.runtime.childExecution(child.execution_id, signal);
      const choice = await select(work, signal);
      signal.throwIfAborted();
      if (work.recipe.inheritedBinding) {
        await options.kernel.agentRuntimeRequest('runtime.child.model.commit', { executionId: child.execution_id, executionOwner: owner,
          choice, binding: work.recipe.inheritedBinding }, signal);
        return options.runtime.childExecution(child.execution_id, signal);
      }
      const candidate = work.recipe.catalog.candidates.find(candidate => candidate.id === choice.model);
      if (!candidate) return fail('delegation-selection-unknown-choice', 'The selected model is not in the original candidate catalog.');
      const selected = await waitForModelBinding(options.models.resolveModel({ providerId: candidate.providerId, modelId: candidate.modelId, thinkingLevel: choice.thinking as ThreadThinkingLevel }, undefined, candidate.configurationFingerprint), value => value.credentialOwner.release(), signal);
      try {
        signal.throwIfAborted();
        const scope = await options.kernel.retainSelectedChildModel(child, selected.credentialOwner, signal);
        signal.throwIfAborted();
        await options.kernel.agentRuntimeRequest('runtime.child.model.commit', { executionId: child.execution_id, executionOwner: owner,
          choice, binding: { configuration: selected.configuration, credential_scope: scope } }, signal);
        return await options.runtime.childExecution(child.execution_id, signal);
      } finally { selected.credentialOwner.release(); }
    },
    close: () => requests.close(),
  };
}
