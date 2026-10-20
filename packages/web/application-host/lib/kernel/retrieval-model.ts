/** Native code retrieval's selected model stage. The existing user settings choose its duty. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseHarnessModelSlots, resolveHarnessModelSlot, parseHarnessRerankSettings, resolveHarnessCodeRetrievalSettings,
  runExploreModelLoop, resolveExploreDuties, EXPLORE_PLAN_SYSTEM, parseExplorePlan, ExploreEvidenceChanged,
  type ExploreModelComplete, type ExploreQueryStartResult, type HarnessExploreDecisionMode } from '@varin/protocol';
import type { ThreadModelAuthority } from './thread-adapter.js';
import { acquireTokenCounter } from '../models/token-count.js';
import type { DecisionInferenceCapture } from '../knowledge/semantic/decision-inference.js';
import { runExploreFastDecisionLoop } from '../harness/explore-fast-decision.js';
import { ResearchDecisionFailure } from '../harness/research-decide.js';
import type { SemanticInference } from '../knowledge/semantic/runtime-inference.js';
import type { RetrievalModelLease } from './retrieval-composition.js';
import type { KernelClient } from './kernel-client.js';
import type { RetrievalSourceOwner } from './retrieval-source.js';
import type { RetrievalQuery } from './protocol.generated.js';
import type { InferenceCall } from '../knowledge/semantic/inference-requests.js';
import { waitForModelBinding } from './model-binding-lifetime.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createRetrievalModelStage(options: {
  inference: Pick<SemanticInference, 'captureRerank' | 'captureDecision'>;
  models?: ThreadModelAuthority;
  readGlobalSettings(): Promise<unknown>;
  kernel: Pick<KernelClient, 'registerCredentialOwner' | 'unregisterCredentialOwner' | 'kernelEpoch' | 'agentRuntimeRequest'>;
  sources: Pick<RetrievalSourceOwner, 'validate' | 'read'>;
}) {
  return { async prepare(query: RetrievalQuery, signal: AbortSignal, call?: InferenceCall): Promise<RetrievalModelLease> {
    let released = false;
    let mode: HarnessExploreDecisionMode;
    let harness: Record<string, unknown>;
    const assertAvailable = () => { signal.throwIfAborted(); if (released) throw new Error('Retrieval model binding was released'); };
    const validateAvailable = async (active: AbortSignal = signal) => {
      active.throwIfAborted(); assertAvailable(); await options.sources.validate(query, active); assertAvailable();
    };
    const unavailable = (providerId: string, status: 'disabled' | 'unavailable' | 'unsupported', configuration: unknown): RetrievalModelLease => ({
      stage: { providerId, status, configurationId: identity(configuration) }, assertAvailable, validateAvailable,
      release() { released = true; },
    });
    try {
      const document = await options.readGlobalSettings();
      if (!object(document) || document.harness !== undefined && !object(document.harness)) throw new Error('Invalid settings');
      harness = object(document.harness) ? document.harness : {};
      mode = resolveHarnessCodeRetrievalSettings(harness.codeRetrieval).decision;
    } catch { return unavailable('settings', 'unavailable', ['invalid']); }
    if (mode === 'source') return unavailable('none', 'disabled', [mode]);
    let exploreSelection: ReturnType<typeof resolveHarnessModelSlot> = null;
    let exploreDisabled = false;
    let exploreInvalid = false;
    if (mode === 'auto' || mode === 'llm' || mode === 'fast-decision') {
      try {
        if (harness.models !== undefined && !object(harness.models)) throw new Error('Invalid Explore model settings');
        const raw = object(harness.models) ? harness.models.explore : undefined;
        const slots = parseHarnessModelSlots(raw === undefined ? undefined : { explore: raw });
        exploreDisabled = slots.explore?.enabled === false;
        exploreSelection = resolveHarnessModelSlot('explore', slots, null);
      } catch { exploreInvalid = true; }
    }
    if (mode === 'llm' && exploreInvalid) return unavailable('llm', 'unavailable', [mode, 'invalid-explore-slot']);
    if (!call) return unavailable('inference', 'unavailable', ['original-session-unavailable']);
    const verifySelection = async () => {
      assertAvailable();
      const verified = await options.readGlobalSettings();
      const current = object(verified) && object(verified.harness) ? verified.harness : {};
      if (!isDeepStrictEqual(current.codeRetrieval, harness.codeRetrieval)
        || mode === 'auto' && !isDeepStrictEqual(current.fastDecision, harness.fastDecision)
        || (mode === 'auto' || mode === 'llm' || mode === 'fast-decision') && !isDeepStrictEqual(object(current.models) ? current.models.explore : current.models,
          object(harness.models) ? harness.models.explore : harness.models)) {
        throw new Error('Retrieval model selection changed during preparation');
      }
      if (query.inferenceOwner.kind !== 'external') throw new Error('Original inference delegation is unavailable');
    };
    // Explore is an independent, tool-free model role. Never inherit the main model.
    let explore: Awaited<ReturnType<ThreadModelAuthority['resolveModel']>> | undefined;
    let exploreScope: Awaited<ReturnType<NonNullable<typeof explore>['credentialOwner']['scope']>> | undefined;
    if (exploreSelection) {
      try {
        if (!options.models) throw new Error('Explore model owner unavailable');
        explore = await waitForModelBinding(options.models.resolveModel(exploreSelection), model => model.credentialOwner.release(), signal);
        exploreScope = await explore.credentialOwner.scope();
      } catch { explore?.credentialOwner.release(); explore = undefined; exploreScope = undefined; signal.throwIfAborted(); }
    } else if (mode === 'llm') return unavailable('llm', exploreDisabled ? 'disabled' : 'unavailable', [mode, exploreDisabled ? 'disabled' : 'unconfigured']);
    let decision: DecisionInferenceCapture = { status: 'unconfigured' };
    try {
      if (mode === 'auto' || mode === 'fast-decision') decision = await options.inference.captureDecision('explore');
    } catch (error) { explore?.credentialOwner.release(); throw error; }
    // Invalid/unavailable selected classifiers remain an explicit failure in auto.
    // Only an absent or disabled binding lets admission choose another strategy.
    if (mode === 'auto' && ['invalid', 'unavailable'].includes(decision.status)) {
      explore?.credentialOwner.release();
      return unavailable('fast-decision', 'unavailable', [mode, decision.status]);
    }
    if (mode === 'fast-decision' && decision.status !== 'ready') {
      explore?.credentialOwner.release();
      return unavailable('fast-decision', decision.status === 'disabled' ? 'disabled' : 'unavailable', [mode, decision.status]);
    }
    if (exploreInvalid && decision.status !== 'ready') return unavailable('llm', 'unavailable', [mode, 'invalid-explore-slot']);
    if (exploreSelection && !explore && decision.status !== 'ready') return unavailable(exploreSelection.providerId, 'unavailable', [mode, exploreSelection]);
    if (explore || decision.status === 'ready') {
      const lease = decision.status === 'ready' ? decision.lease : undefined;
      const llm = explore;
      const scope = exploreScope;
      let tokenizer: Awaited<ReturnType<typeof acquireTokenCounter>> | undefined;
      let tokenizerDescription: string | undefined;
      const inputCounts = new Map<string, number>();
      let revoked = false;
      try {
        await verifySelection();
        const validate = validateAvailable;
        const validateLLM = async (active: AbortSignal = signal) => {
          await validateAvailable(active);
          if (llm) {
            let current: unknown;
            try { current = await options.readGlobalSettings(); } catch { /* Invalid candidates do not replace this binding. */ }
            if (object(current) && (current.harness === undefined || object(current.harness))) {
              const currentHarness = object(current.harness) ? current.harness : {};
              const models = currentHarness.models;
              if (models === undefined || object(models) && (models.explore === undefined || object(models.explore) && models.explore.enabled === false)) revoked = true;
              if (object(currentHarness.codeRetrieval) && currentHarness.codeRetrieval.decision === 'source') revoked = true;
            }
            if (revoked || !isDeepStrictEqual(await llm.credentialOwner.scope(), scope)) throw new Error('Original Explore model authority was revoked');
          }
          active.throwIfAborted();
        };
        await validate(signal);
        return {
          stage: { providerId: lease?.binding.providerId ?? exploreSelection!.providerId,
            configurationId: identity([mode, exploreSelection, llm?.configuration, scope, lease?.binding]), status: 'ready',
            implementation: { kind: 'progressive', select: async ({ run, validateMaterials, progress }, active) => {
              await validate(active);
              const execute = async () => {
                const duties = resolveExploreDuties({ mode, llm: !!exploreSelection, fastDecision: !!lease, rerank: false });
                const generation = async () => {
                    if (llm && !tokenizer) tokenizer = await acquireTokenCounter(options.kernel, llm.configuration);
                    const complete: ExploreModelComplete | undefined = llm && scope ? Object.assign(async (input: Parameters<ExploreModelComplete>[0]) => {
                      if (!await complete!.fitsInput!(input)) throw new Error('Retrieval request exceeds its selected model input capacity');
                      const generatedSignal = input.signal ? AbortSignal.any([active, input.signal]) : active;
                      const materials = (input.materials ?? []).map(view => ({
                        id: view.viewId, text: view.text, revision: view.revision, label: `${view.path}:${view.startLine}-${view.endLine}`,
                      }));
                      const epoch = options.kernel.kernelEpoch;
                      const evidenceVersion = run.evidenceVersion();
                      return call.generate({ signal: generatedSignal,
                        request: { configuration: llm.configuration, credentialScope: scope, purpose: 'explore', systemPrompt: input.systemPrompt, user: input.user },
                        check: async () => { generatedSignal.throwIfAborted(); await validateLLM(generatedSignal); await validateMaterials(materials); generatedSignal.throwIfAborted(); },
                        register: async (id, originalSignal) => {
                          await options.kernel.registerCredentialOwner(query.runId, llm.credentialOwner, originalSignal, id,
                            { kind: 'operation', operationId: id, assertLive: async () => { await validateLLM(generatedSignal); await validateMaterials(materials); } });
                        },
                        release: id => { if (options.kernel.kernelEpoch === epoch) options.kernel.unregisterCredentialOwner(query.runId, id); },
                      }).then(async result => {
                        await validateMaterials(materials);
                        return result;
                      }).catch(error => { if (run.evidenceVersion() !== evidenceVersion) throw new ExploreEvidenceChanged(); throw error; });
                    }, { fitsInput: async (input: { systemPrompt: string; user: string }) => {
                      const key = identity([input.systemPrompt, input.user]);
                      let count = inputCounts.get(key);
                      if (count === undefined) {
                        const measured = await tokenizer!.count([JSON.stringify({ messages: [
                          { role: 'system', content: input.systemPrompt }, { role: 'user', content: input.user },
                        ] })]);
                        tokenizerDescription = measured.tokenizer;
                        count = measured.counts[0]!;
                        inputCounts.set(key, count);
                      }
                      return !llm.configuration.contextWindowTokens ||
                        count + (llm.configuration.maxOutputTokens ?? 0) <= llm.configuration.contextWindowTokens;
                    } }) : undefined;
                    return complete;
                };
                if (lease && duties.selection === 'fast-decision') {
                  const fastDecision = await lease.consume(call, session => runExploreFastDecisionLoop({
                    run, binding: lease.binding, signal: active, deadlineAt: run.deadlineAt,
                    closing: { promise: new Promise<void>(() => {}), requested: () => !!run.deliveryReason() },
                    countInput: batch => lease.countInput(batch),
                    ...(llm ? { expand: async (views: import('@varin/protocol').ExploreQueryView[]) => {
                      progress?.phase('planning');
                      const complete = (await generation())!;
                      const request = { systemPrompt: EXPLORE_PLAN_SYSTEM,
                        user: JSON.stringify({ question: run.question, vocabulary: run.vocab(),
                          evidence: views.map(view => ({ id: view.viewId, path: view.path, text: view.text, why: view.why })),
                          sources: run.sourceStates() }) };
                      if (!await complete.fitsInput!(request)) throw new Error('Query expansion context exceeds its model input capacity');
                      const plan = parseExplorePlan(await complete({ ...request, materials: views, signal: active }));
                      if (!plan) throw new Error('Query expansion did not return usable search expressions');
                      await run.submitPlan(plan);
                    } } : {}),
                    call: async batch => {
                      progress?.phase('selecting');
                      const evidenceVersion = run.evidenceVersion();
                      try {
                        const result = await session.decide({ purpose: 'explore', goal: batch.goal, context: batch.context, materials: batch.materials,
                          questions: batch.questions }, () => validate(active), () => validateMaterials(batch.materials));
                        await validateMaterials(batch.materials);
                        return result;
                      } catch (error) {
                        if (run.evidenceVersion() !== evidenceVersion) throw new ExploreEvidenceChanged();
                        if (!(error instanceof ResearchDecisionFailure) || !error.result) throw error;
                        return { ...error.result, failure: { status: error.cancelled ? 'cancelled' : 'failed', note: error.message } };
                      } finally { if (!active.aborted) progress?.phase('collecting'); }
                    },
                  }));
                  if (exploreInvalid) fastDecision.note = [fastDecision.note, 'Optional query expansion is unavailable because its model configuration is invalid.'].filter(Boolean).join(' ');
                  return { fastDecision };
                }
                if (exploreSelection) {
                    const complete = await generation();
                    const queryId = call.operationId;
                    const started: ExploreQueryStartResult = { queryId, question: run.question, deadlineAt: run.deadlineAt,
                      parsed: { objects: run.parsed.objects, relation: run.parsed.relation, domain: run.parsed.domain },
                      vocab: run.vocab(), sources: run.sourceStates(), inputSource: query.source.mode === 'live_root' ? 'disk' : query.source.mode, decisionMode: mode, duties,
                      fastDecision: { status: decision.status } };
                    const guard = async () => { await validate(active); await validateMaterials([]); };
                    const model = await runExploreModelLoop({ started, ...(complete ? { complete } : {}), ...(progress ? { progress } : {}), signal: active, ...(query.limit === undefined ? {} : { limit: query.limit }), port: {
                      plan: async plan => { await validateLLM(active); await guard(); return { queryId, ...await run.submitPlan(plan), sources: run.sourceStates() }; },
                      views: async input => {
                        await guard();
                        const actions = duties.actions === 'llm' && !run.signal.aborted ? await run.actionCandidates() : [];
                        const views = run.collect(input);
                        return { queryId, question: run.question, ...views, sources: run.sourceStates(), deadlineAt: run.deadlineAt, actions };
                      },
                      wait: after => run.waitForProgress(after, active),
                      select: async groups => { await validateLLM(active); await guard(); return { ...run.applySelection(groups), queryId }; },
                      followup: async request => { await validateLLM(active); await guard(); return { queryId, ...await run.followup(request), sources: run.sourceStates() }; },
                      deliver: () => run.requestDelivery('decision'),
                      retained: () => run.selectedViews(),
                    } });
                    if (!llm) { model.plan = 'failed'; model.select = 'failed'; model.note = 'The selected Explore model is unavailable; source material was kept.'; }
                    if (tokenizerDescription) model.tokenizer = tokenizerDescription;
                    return { model };
                }
                return {};
              };
              return execute();
            } },
          },
          assertAvailable, validateAvailable: validate,
          release() { if (released) return; released = true; llm?.credentialOwner.release(); lease?.release(); void tokenizer?.release().catch(() => {}); },
        };
      } catch (error) { llm?.credentialOwner.release(); lease?.release(); throw error; }
    }
    if (mode === 'fast-decision' || !['disabled', 'unconfigured'].includes(decision.status)) {
      return unavailable('fast-decision', decision.status === 'disabled' ? 'disabled' : 'unavailable', [mode, decision.status]);
    }
    let configured;
    try { configured = parseHarnessRerankSettings(harness.rerank); }
    catch { return unavailable('rerank', 'unavailable', [mode, 'invalid']); }
    if (!configured) return unavailable('rerank', mode === 'auto' ? 'disabled' : 'unavailable', [mode, 'unconfigured']);

    const selected = await options.inference.captureRerank(configured);
    if (selected.status !== 'ready') return unavailable(configured.providerId, selected.status === 'unconfigured' && mode === 'auto' ? 'disabled' : 'unavailable', [mode, configured, selected.status]);
    const lease = selected.lease;
    try {
      await verifySelection();
      const validate = async (active: AbortSignal = signal) => { await validateAvailable(active); await lease.assertAvailable(active); };
      await validate(signal);
      return {
        stage: { providerId: lease.binding.providerId, configurationId: identity([mode, lease.binding]), status: 'ready',
          implementation: { kind: 'snippets', select: async (input, active) => {
            await validate(active);
            const counts = lease.binding.maxDocumentTokens === undefined ? undefined
              : await lease.countDocuments(input.snippets.map(snippet => snippet.content));
            const eligible = input.snippets.map((snippet, index) => ({ id: String(index), text: snippet.content, revision: snippet.revision }))
              .filter((_, index) => lease.binding.maxDocumentTokens === undefined || counts![index]! <= lease.binding.maxDocumentTokens);
            const original = input.snippets.map((_, index) => index);
            if (!eligible.length) return { indices: original, status: 'partial' };
            const guard = async () => {
              await validate(active);
              for (const path of new Set(input.snippets.map(item => item.path))) {
                const current = await options.sources.read(query, path, active);
                if (current.status !== 'ready') throw new Error('Original rerank source is unavailable');
                const lines = current.content.split('\n');
                for (const snippet of input.snippets.filter(item => item.path === path)) {
                  if (snippet.revision !== current.revision || lines.slice(snippet.startLine - 1, snippet.endLine).join('\n') !== snippet.content) throw new Error('Original rerank material version changed');
                }
              }
              await validate(active);
            };
            const result = await lease.consume(call, { query: input.question, documents: eligible,
              provenance: { source: query.source, physicalRoot: query.physicalRoot,
              candidates: eligible.map(document => {
                const snippet = input.snippets[Number(document.id)]!;
                return { id: document.id, path: snippet.path, revision: snippet.revision, startLine: snippet.startLine, endLine: snippet.endLine };
              }) } }, guard);
            const ordered = [...result.scores].sort((a, b) => b.score - a.score || a.index - b.index).map(row => Number(row.id));
            const ranked = new Set(ordered);
            return { indices: [...ordered, ...original.filter(index => !ranked.has(index))],
              status: ranked.size === original.length ? 'ready' : 'partial' };
          } } },
        assertAvailable, validateAvailable: validate,
        release() { if (released) return; released = true; lease.release(); },
      };
    } catch (error) { lease.release(); throw error; }
  } };
}
