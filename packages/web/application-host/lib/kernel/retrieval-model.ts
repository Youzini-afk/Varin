/** Native code retrieval's selected model stage. The existing user settings choose its duty. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseHarnessModelSlots, resolveHarnessModelSlot, parseHarnessRerankSettings, resolveHarnessCodeRetrievalSettings,
  runExploreModelLoop, resolveExploreDuties,
  type ExploreModelComplete, type ExploreQueryStartResult, type HarnessExploreDecisionMode } from '@varin/protocol';
import type { ThreadModelAuthority } from './thread-adapter.js';
import { DEFAULT_BYTE_BUDGET } from '../harness/explore.js';
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
  kernel: Pick<KernelClient, 'registerCredentialOwner' | 'unregisterCredentialOwner' | 'kernelEpoch'>;
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
    if (mode === 'auto' || mode === 'llm') {
      try {
        if (harness.models !== undefined && !object(harness.models)) throw new Error('Invalid Explore model settings');
        const raw = object(harness.models) ? harness.models.explore : undefined;
        const slots = parseHarnessModelSlots(raw === undefined ? undefined : { explore: raw });
        exploreDisabled = slots.explore?.enabled === false;
        exploreSelection = resolveHarnessModelSlot('explore', slots, null);
      } catch { return unavailable('llm', 'unavailable', [mode, 'invalid-explore-slot']); }
    }
    if (!call) return unavailable('inference', 'unavailable', ['original-session-unavailable']);
    const verifySelection = async () => {
      assertAvailable();
      const verified = await options.readGlobalSettings();
      const current = object(verified) && object(verified.harness) ? verified.harness : {};
      if (!isDeepStrictEqual(current.codeRetrieval, harness.codeRetrieval)
        || mode === 'auto' && !isDeepStrictEqual(current.fastDecision, harness.fastDecision)
        || (mode === 'auto' || mode === 'llm') && !isDeepStrictEqual(object(current.models) ? current.models.explore : current.models,
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
    if (exploreSelection && !explore && decision.status !== 'ready') return unavailable(exploreSelection.providerId, 'unavailable', [mode, exploreSelection]);
    if (explore || decision.status === 'ready') {
      const lease = decision.status === 'ready' ? decision.lease : undefined;
      const llm = explore;
      const scope = exploreScope;
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
          stage: { providerId: exploreSelection?.providerId ?? lease!.binding.providerId,
            configurationId: identity([mode, exploreSelection, llm?.configuration, scope, lease?.binding]), status: 'ready',
            implementation: { kind: 'progressive', select: async ({ run, validateMaterials, progress }, active) => {
              await validate(active);
              const execute = async () => {
                const duties = resolveExploreDuties({ mode, llm: !!exploreSelection, fastDecision: !!lease, rerank: false });
                let closing = false;
                let settle!: () => void;
                const settled = new Promise<void>(resolve => { settle = resolve; });
                const loopAbort = new AbortController();
                const loopSignal = AbortSignal.any([active, call.signal, loopAbort.signal]);
                const fd = lease?.consume(call, session => runExploreFastDecisionLoop({
                  run, binding: lease.binding, signal: loopSignal, deadlineAt: run.deadlineAt,
                  judgeMaterials: duties.selection === 'fast-decision', waitForLaterProgress: !!exploreSelection,
                  closing: { promise: settled, requested: () => closing },
                  call: async batch => {
                    if (!exploreSelection) progress?.phase('selecting');
                    try {
                      return await session.decide({ purpose: 'explore', goal: batch.goal,
                        materials: batch.materials, questions: batch.questions,
                        ...(lease.binding.endpoint ? { endpoint: lease.binding.endpoint } : {}) }, async () => {
                        await validate(active); await validateMaterials(batch.materials); await validate(active);
                      });
                    } catch (error) {
                      if (!(error instanceof ResearchDecisionFailure) || !error.result) throw error;
                      return { ...error.result, failure: { status: error.cancelled ? 'cancelled' : 'failed', note: error.message } };
                    } finally { if (!exploreSelection && !active.aborted) progress?.phase('collecting'); }
                  },
                }));
                void fd?.catch(() => {});
                let model: import('@varin/protocol').ExploreModelParticipation | undefined;
                let fastDecision: Awaited<NonNullable<typeof fd>> | undefined;
                try {
                  if (exploreSelection) {
                    await run.refreshVocab();
                    const complete: ExploreModelComplete | undefined = llm && scope ? Object.assign(async (input: Parameters<ExploreModelComplete>[0]) => {
                      const generatedSignal = input.signal ? AbortSignal.any([active, input.signal]) : active;
                      const epoch = options.kernel.kernelEpoch;
                      return call.generate({ signal: generatedSignal,
                        request: { configuration: llm.configuration, credentialScope: scope, purpose: 'explore', systemPrompt: input.systemPrompt, user: input.user },
                        check: async () => { generatedSignal.throwIfAborted(); await validateLLM(generatedSignal); await validateMaterials([]); generatedSignal.throwIfAborted(); },
                        register: async (id, originalSignal) => {
                          await options.kernel.registerCredentialOwner(query.runId, llm.credentialOwner, originalSignal, id,
                            { kind: 'operation', operationId: id, assertLive: async () => { await validateLLM(generatedSignal); await validateMaterials([]); } });
                        },
                        release: id => { if (options.kernel.kernelEpoch === epoch) options.kernel.unregisterCredentialOwner(query.runId, id); },
                      });
                    }, llm.configuration.contextWindowTokens ? { inputBytes: llm.configuration.contextWindowTokens } : {}) : undefined;
                    const queryId = call.operationId;
                    const started: ExploreQueryStartResult = { queryId, question: run.question, deadlineAt: run.deadlineAt,
                      parsed: { objects: run.parsed.objects, relation: run.parsed.relation, domain: run.parsed.domain },
                      vocab: run.vocab(), sources: run.sourceStates(), inputSource: query.source.mode === 'live_root' ? 'disk' : query.source.mode, decisionMode: mode, duties,
                      fastDecision: { status: decision.status } };
                    const guard = async () => { await validate(active); await validateMaterials([]); };
                    model = await runExploreModelLoop({ started, ...(complete ? { complete } : {}), ...(progress ? { progress } : {}), signal: active, ...(query.limit === undefined ? {} : { limit: query.limit }), port: {
                      plan: async plan => { await validateLLM(active); await guard(); return { queryId, ...await run.submitPlan(plan), sources: run.sourceStates() }; },
                      views: async input => {
                        await guard();
                        const actions = duties.actions === 'llm' && !run.signal.aborted ? await run.actionCandidates() : [];
                        const views = run.collect(input);
                        return { queryId, question: run.question, ...views, sources: run.sourceStates(), deadlineAt: run.deadlineAt, actions, outputByteBudget: DEFAULT_BYTE_BUDGET };
                      },
                      wait: after => run.waitForProgress(after, active),
                      select: async groups => { await validateLLM(active); await guard(); return { ...run.applySelection(groups), queryId }; },
                      followup: async request => { await validateLLM(active); await guard(); return { queryId, ...await run.followup(request), sources: run.sourceStates() }; },
                    } });
                    if (!llm) { model.plan = 'failed'; model.select = 'failed'; model.note = 'The selected Explore model is unavailable; source material was kept.'; }
                  }
                } finally {
                  if (exploreSelection) { closing = true; settle(); }
                  try { fastDecision = await fd; }
                  finally { loopAbort.abort(); }
                }
                return { ...(model ? { model } : {}), ...(fastDecision ? { fastDecision } : {}) };
              };
              return execute();
            } },
          },
          assertAvailable, validateAvailable: validate,
          release() { if (released) return; released = true; llm?.credentialOwner.release(); lease?.release(); },
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
            // Keep exact spans and revisions. The inherited user budget uses the original
            // character estimate; it is a selection budget, not provider usage accounting.
            const eligible = input.snippets.map((snippet, index) => ({ id: String(index), text: snippet.content, revision: snippet.revision }))
              .filter(document => lease.binding.maxDocumentTokens === undefined || Math.max(1, document.text.length) <= lease.binding.maxDocumentTokens);
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
