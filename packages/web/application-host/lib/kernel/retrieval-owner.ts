import { sourceFailureCode } from './source-admission-error.js';
import type { SourceFailureCode } from './protocol.generated.js';
import { ExploreEvidenceChanged, type FastDecisionMaterial } from '@varin/protocol';
import type { ExploreToolProgress } from '@varin/protocol';
import { createExploreProgress } from '../harness/explore-progress.js';
import { contentHashOf } from '../knowledge/semantic/identity.js';
import { createExploreQueryRun, DEFAULT_READ_PARALLELISM, requiredExploreComponents, type ExploreDeps, type RgSearchReturn } from '../harness/explore.js';
import type { ExploreFileSnapshot } from '../harness/file-snapshot.js';
import type { BoundRetrievalPipeline, PipelinePlan, RetrievalPipelineOwner, RetrievalSnippet, RetrievalStageKind, RetrievalStageStatus } from '../harness/retrieval-pipeline.js';
import { waitWithSignal } from '../cancellation.js';
import { decodeSearchHit, CONTENT_SEARCH_EXCLUDED_DIRS } from '../search/content.js';
import type { KernelClient } from './kernel-client.js';
import type { RetrievalSourceOwner } from './retrieval-source.js';
import { toolOperationId, type LiveRoot, type LaunchSource, type RetrievalQuery } from './protocol.generated.js';
import type { InferenceCall, InferenceRequests } from '../knowledge/semantic/inference-requests.js';

/** Use the existing source-read parallelism, draining every admitted read even
 * when a sibling fails. Native leases still serialize overlapping files. */
async function readBatches<T>(items: readonly T[], read: (item: T) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < items.length; start += DEFAULT_READ_PARALLELISM) {
    const batch = await Promise.allSettled(items.slice(start, start + DEFAULT_READ_PARALLELISM).map(read));
    const failed = batch.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

export interface RetrievalResult {
  status: Exclude<RetrievalStageStatus, 'disabled'>;
  plan?: PipelinePlan;
  source?: LaunchSource;
  physicalRoot?: LiveRoot | null;
  snippets: RetrievalSnippet[];
  omissions: { outOfScope: number; stale: number; unavailable: number };
  stages: Array<{ kind: RetrievalStageKind; status: RetrievalStageStatus }>;
  message?: string;
  sourceFailure?: SourceFailureCode;
  diagnostics?: import('./protocol.generated.js').CodeRetrievalDiagnostic[];
  coverage?: import('./protocol.generated.js').CodeRetrievalCoverage;
  completion?: import('./protocol.generated.js').CodeRetrievalCompletion;
}
export type RetrievalMaterialReader = (viewId: string) => Promise<import('@varin/protocol').ExploreQueryView>;
export type RetrievalOwner = (query: RetrievalQuery, signal: AbortSignal, progress?: (value: ExploreToolProgress) => void,
  delivery?: AbortSignal, observe?: (reader: RetrievalMaterialReader) => void) => Promise<RetrievalResult>;
const relative = (path: string): string => {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/') || path.includes(':') || path.includes('\0') || path.split('/').includes('..')) throw new Error('Invalid retrieval resource path');
  return path.split('/').filter(part => part && part !== '.').join('/');
};
const within = (path: string, roots: readonly string[]): boolean => roots.some(root => !root || path === root || path.startsWith(`${root}/`));
const rank: Record<RetrievalStageStatus, number> = { disabled: 0, empty: 1, ready: 2, unsupported: 3, unavailable: 4, partial: 5, stale: 6, failed: 7, cancelled: 8 };

/** Identity is explicit. Explore algorithms are reused without a Pi actor/session/store.
 * Search/read admission uses the original Run grant and source; Documents owns text decoding.
 * Providers only receive text after admission. Rust independently verifies all returned snippets.
 */
export function createRetrievalOwner({ sources, pipelines, preparePipeline, inferenceRequests, graph }: {
  sources: RetrievalSourceOwner;
  kernel: KernelClient;
  pipelines?: Pick<RetrievalPipelineOwner, 'capture'>;
  inferenceRequests?: Pick<InferenceRequests, 'run'>;
  preparePipeline?: (query: RetrievalQuery, signal: AbortSignal, inference?: InferenceCall) => Promise<BoundRetrievalPipeline>;
  graph?: (query: RetrievalQuery, roots: string[], read: ExploreDeps['readFile']) => ExploreDeps['graph'];
}): RetrievalOwner {
  const execute = async (query: RetrievalQuery, signal: AbortSignal, progress: ReturnType<typeof createExploreProgress>, inference?: InferenceCall, delivery?: AbortSignal,
    observeMaterials?: (reader: RetrievalMaterialReader) => void): Promise<RetrievalResult> => {
    const sourceWork = new AbortController();
    const workSignal = AbortSignal.any([signal, sourceWork.signal, ...(delivery ? [delivery] : [])]);
    const outstanding = new Set<Promise<unknown>>();
    const own = <T>(promise: Promise<T>): Promise<T> => {
      outstanding.add(promise);
      void promise.then(() => outstanding.delete(promise), () => outstanding.delete(promise));
      return promise;
    };
    // Bind before source I/O. A later settings publication cannot replace this query's selected stages.
    let binding: BoundRetrievalPipeline;
    try {
      if (preparePipeline) {
        const preparing = preparePipeline(query, signal, inference);
        try { binding = await waitWithSignal(preparing, workSignal); }
        catch (error) { void preparing.then(late => late.release?.(), () => {}); throw error; }
      } else {
        if (!pipelines) throw new Error('Retrieval selection is unavailable');
        binding = pipelines.capture();
      }
    } catch (error) {
      if (delivery?.aborted && !signal.aborted) return { status: 'empty', snippets: [], stages: [],
        omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, completion: { reason: 'user' } };
      const failure = signal.aborted ? undefined : sourceFailureCode(error);
      return { status: signal.aborted ? 'cancelled' : 'failed', ...(failure ? { sourceFailure: failure } : {}), snippets: [], stages: [],
        omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, message: 'Selected retrieval configuration could not be prepared' };
    }
    try {
      const result: RetrievalResult = { status: 'empty', plan: binding.plan,
        source: query.source, physicalRoot: query.physicalRoot,
        snippets: [], omissions: { outOfScope: 0, stale: 0, unavailable: 0 },
        stages: binding.plan.stages.map(stage => ({ kind: stage.kind, status: stage.status === 'ready' ? 'empty' : stage.status })),
        diagnostics: [],
      };
      const stage = (kind: RetrievalStageKind, status: RetrievalStageStatus): void => {
        const entry = result.stages.find(item => item.kind === kind)!;
        if (rank[status] > rank[entry.status]) entry.status = status;
      };
      signal.throwIfAborted();
      binding.assertAvailable?.();
      await waitWithSignal(own(sources.validate(query, workSignal)), workSignal);
      const pathScopes = await waitWithSignal(own(sources.pathScopes(query, workSignal)), workSignal);
      const validateBinding = async (): Promise<void> => {
        signal.throwIfAborted();
        binding.assertAvailable?.();
        if (binding.validateAvailable) await waitWithSignal(binding.validateAvailable(signal), signal);
        signal.throwIfAborted();
        binding.assertAvailable?.();
        await sources.validate(query, signal);
      };
      await waitWithSignal(own(validateBinding()), workSignal);
      const grantedRoots = pathScopes.map(relative);
      const roots = query.paths ? query.paths.map(relative) : grantedRoots;
      if (!roots.length || roots.some(root => !within(root, grantedRoots))) throw new Error('Retrieval roots are outside the Run grant');
      const focuses = new Map<string, Set<number>>();
      const focus = (path: string, line: number): void => { const lines = focuses.get(path) ?? new Set<number>(); lines.add(line); focuses.set(path, lines); };
      const snapshots = new Map<string, Promise<ExploreFileSnapshot>>();
      const read = (inputPath: string): Promise<ExploreFileSnapshot> => {
        let path: string;
        try { path = relative(inputPath); if (!path || !within(path, roots)) throw new Error('outside scope'); }
        catch { result.omissions.outOfScope++; return Promise.resolve({ status: 'forbidden', message: 'Candidate is outside the selected retrieval scope' }); }
        const existing = snapshots.get(path);
        if (existing) return existing;
        const work = (async (): Promise<ExploreFileSnapshot> => {
          try {
            const snapshot = await own(sources.read(query, path, workSignal));
            if (snapshot.status === 'stale') result.omissions.stale++;
            else if (snapshot.status !== 'ready') result.omissions.unavailable++;
            if (snapshot.status !== 'ready') result.diagnostics!.push({ kind: snapshot.status, path, message: snapshot.message });
            return snapshot;
          } catch (error) {
            signal.throwIfAborted();
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            if (['forbidden','authorization','unauthorized'].includes(code)) { result.omissions.outOfScope++; return { status: 'forbidden', message: 'Candidate is outside the Run grant' }; }
            result.omissions.unavailable++;
            return { status: 'unavailable', message: 'Candidate text could not be admitted' };
          }
        })();
        snapshots.set(path, work);
        return work;
      };
      const deps: ExploreDeps = {
        readFile: read,
        rgSearch: async (pattern, options) => {
          const page = await own(sources.compute(query, { operation: 'search', lane: 'foreground',
            paths: options.paths?.map(relative) ?? roots, query: pattern, fixedStrings: options.fixedStrings,
            ignoreCase: true, includeHidden: true, respectGitignore: !query.paths?.length,
            excludeDirectories: query.paths?.length ? [] : CONTENT_SEARCH_EXCLUDED_DIRS,
            maxResults: options.candidateBudget ?? 200,
          }, { signal: workSignal }));
          signal.throwIfAborted();
          if (page.status === 'failed' || page.status === 'cancelled') {
            stage('keyword', page.status);
            throw new Error('Keyword search did not complete');
          }
          stage('keyword', page.status === 'partial' ? 'partial' : page.records.length ? 'ready' : 'empty');
          const hits = [];
          const candidates = page.records.flatMap(record => {
            const hit = decodeSearchHit(record, query.source.workspace_id); return hit ? [hit] : [];
          });
          await readBatches([...new Set(candidates.map(hit => hit.resource.resourceId))], read);
          const lines = new Map<string, string[]>();
          for (const hit of candidates) {
            const snapshot = await read(hit.resource.resourceId);
            if (snapshot.status !== 'ready') continue;
            if (snapshot.revision !== hit.revision) { result.omissions.stale++; continue; }
            let text = lines.get(hit.resource.resourceId);
            if (!text) { text = snapshot.content.split('\n'); lines.set(hit.resource.resourceId, text); }
            const line = text[hit.line - 1];
            if (line === undefined) { result.omissions.stale++; continue; }
            focus(hit.resource.resourceId, hit.line);
            hits.push({ path: hit.resource.resourceId, line: hit.line, text: line.replace(/\r$/u, '') });
          }
          return { hits, partial: page.status === 'partial' || Object.values(result.omissions).some(count => count > 0) };
        },
      };
      const relations = graph?.(query, roots, read);
      if (relations) deps.graph = relations;
      deps.rgSearchMany = async (patterns, options) => {
        if (patterns.length === 1) return new Map([[patterns[0]!, await deps.rgSearch(patterns[0]!, options)]]);
        const escaped = patterns.map(pattern => pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const found = await deps.rgSearch(escaped.join('|'), { ...options, fixedStrings: false,
          candidateBudget: (options.candidateBudget ?? 200) * patterns.length });
        const hits = Array.isArray(found) ? found : found.hits;
        return new Map(patterns.map((pattern, index) => [pattern, {
          hits: hits.filter(hit => new RegExp(escaped[index]!, 'iu').test(hit.text)),
          ...(!Array.isArray(found) ? { partial: found.partial, filesDropped: found.filesDropped, fileCoverage: found.fileCoverage } : {}),
        } satisfies RgSearchReturn]));
      };
      if (binding.structure) {
        const structure = binding.structure;
        deps.structure = {
          outline: async request => {
            try {
              const response = await waitWithSignal(own(structure.outline({ ...request, workspaceId: query.source.workspace_id, signal: workSignal })), workSignal);
              stage('structure', response.status);
              return response;
            } catch (error) { if (!workSignal.aborted) stage('structure', 'failed'); throw error; }
          },
          classifyHits: async request => {
            try {
              const response = await waitWithSignal(own(structure.classifyHits({ ...request, workspaceId: query.source.workspace_id, signal: workSignal })), workSignal);
              stage('structure', response.status);
              return response;
            } catch (error) { if (!workSignal.aborted) stage('structure', 'failed'); throw error; }
          },
        };
      }
      if (binding.semantic) deps.semantic = { search: async (question, limit) => {
        try {
          // This checks the original Run, source and backend owner before query embedding.
          await validateBinding();
          const response = await waitWithSignal(own(binding.semantic!.search(question, limit, workSignal)), workSignal);
          await validateBinding();
          const hits = [];
          for (const hit of response.hits) {
            const snapshot = await read(hit.documentId);
            if (snapshot.status !== 'ready') continue;
            if (hit.revision !== snapshot.revision) { result.omissions.stale++; continue; }
            const lines = snapshot.content.split('\n');
            if (!Number.isSafeInteger(hit.startLine) || !Number.isSafeInteger(hit.endLine) || hit.startLine < 1 || hit.endLine < hit.startLine || hit.endLine > lines.length) { result.omissions.stale++; continue; }
            const body = lines.slice(hit.startLine - 1, hit.endLine).join('\n');
            if (contentHashOf(body) !== hit.contentHash) { result.omissions.stale++; continue; }
            focus(hit.documentId, hit.startLine);
            hits.push({ ...hit, body });
          }
          stage('semantic', ['ready', 'empty', 'incomplete'].includes(response.status) ? (hits.length ? 'ready' : 'empty')
            : response.status === 'failed' ? 'failed' : response.status === 'stale' ? 'stale' : 'unavailable');
          for (const gap of response.gaps ?? []) result.diagnostics!.push({ kind: gap.reason, path: gap.path,
            message: gap.reason === 'index-not-ready' ? 'No published semantic index is available for this source; current text search remains available.'
              : `Semantic coverage for this source is incomplete: ${gap.reason}.` });
          return { ...response, hits };
        } catch (error) { if (!workSignal.aborted) stage('semantic', 'failed'); throw error; }
      } };
      const run = createExploreQueryRun({ question: query.question, paths: roots.length === 1 && roots[0] === '' ? ['.'] : roots,
        ...(query.limit === undefined ? {} : { limit: query.limit }) }, deps, { signal, guided: binding.model?.kind === 'progressive' });
      const finishRequested = () => { run.requestDelivery('user'); sourceWork.abort(); };
      delivery?.addEventListener('abort', finishRequested, { once: true });
      if (delivery?.aborted) finishRequested();
      observeMaterials?.(async viewId => {
        await validateBinding();
        const view = run.view(viewId);
        if (!view) throw new Error('Retrieval material is no longer available in this query');
        await sources.checkPath(query, view.path, signal);
        return structuredClone(view);
      });
      const observing = new AbortController();
      const observe = async () => {
        try {
          while (!observing.signal.aborted) {
            const collected = run.collect();
            progress.observe({ sources: run.sourceStates(), views: collected.views, selected: run.selectedViews() });
            if (run.terminal() !== 'active') break;
            await run.waitForProgress(collected.sequence, observing.signal);
          }
        } catch (error) { if (!observing.signal.aborted) throw error; }
      };
      // Only this query owner can resolve the loop's material identities back to
      // admitted views. Re-read the same selected source at HTTP/delivery fences;
      // structure views retain their own legitimate omitted-range text.
      const validateMaterials = async (materials: readonly FastDecisionMaterial[]) => {
        await validateBinding();
        const views = new Map(materials.flatMap(material => {
          const view = run.view(material.id); return view ? [[view.viewId, view] as const] : [];
        }));
        for (const material of materials) {
          const view = views.get(material.id);
          if (!view || material.revision !== view.revision || material.text !== view.text
            || material.label !== `${view.path}:${view.startLine}-${view.endLine}`) throw new Error('Original retrieval view changed');
        }
        // Action questions also disclose names discovered in admitted source, even
        // when no new material is offered. Their original snapshots remain fenced.
        const paths = new Map(materials.map(material => views.get(material.id)!).map(view => [view.path, view.revision]));
        await readBatches([...paths], async ([path, revision]) => {
          const original = await read(path);
          if (original.status !== 'ready' || original.revision !== revision) throw new Error('Original retrieval snapshot changed');
          const lines = original.content.split(/\r\n|\n|\r/);
          for (const view of views.values()) if (view.path === path
            && (!Number.isSafeInteger(view.startLine) || !Number.isSafeInteger(view.endLine)
              || view.startLine < 1 || view.endLine < view.startLine || view.endLine > lines.length)) {
            throw new Error('Original retrieval view range changed');
          }
          const current = await sources.read(query, path, signal);
          if (current.status !== 'ready' || current.revision !== original.revision || current.content !== original.content) {
            snapshots.set(path, Promise.resolve(current));
            await run.refreshSnapshot(path, current);
            result.diagnostics!.push({ kind: 'source-updated', path, message: 'The source changed during judgment; affected evidence was refreshed.' });
            throw new ExploreEvidenceChanged();
          }
        });
      };
      let modelParticipation: import('@varin/protocol').ExploreModelParticipation | undefined;
      try {
        progress.phase('collecting');
        run.start();
        void observe().catch(() => {});
        if (binding.model?.kind === 'progressive') {
          try {
            // The query observer may detach immediately on cancel. This real owner
            // awaits its session so HTTP bodies and receipts retain their lifetime.
            const details = await waitWithSignal(own(binding.model.select({ run, validateMaterials, progress }, workSignal)), workSignal);
            modelParticipation = details.model;
            if (details.fastDecision) {
              const decision = details.fastDecision;
              run.applyFastDecision(decision);
              stage('model', decision.status === 'failed' || decision.status === 'cancelled' ? decision.status
                : decision.missing || decision.unevaluatedMaterials ? 'partial' : decision.status === 'used' ? 'ready' : 'empty');
              if (decision.status === 'failed') run.requestDelivery('failed');
              if (decision.missing && decision.status !== 'failed' && decision.status !== 'cancelled') result.diagnostics!.push({ kind: 'decision-incomplete',
                message: `The selected model left ${decision.missing} judgments unanswered; available evidence and valid decisions were kept.` });
            }
            if (details.model) {
              const phases = [details.model.plan, details.model.select, details.model.followup, details.model.fastDecision];
              stage('model', phases.includes('failed') ? 'failed' : phases.includes('cancelled') ? 'cancelled'
                : phases.includes('used') ? 'ready' : 'empty');
              if (phases.includes('failed')) run.requestDelivery('failed');
            }
          } catch (error) {
            signal.throwIfAborted();
            if (!delivery?.aborted) {
              stage('model', 'failed'); run.requestDelivery('failed');
              result.diagnostics!.push({ kind: 'model', message: error instanceof Error ? error.message : 'Selected material judgment failed.' });
            }
          }
        }
        if (!run.deliveryReason()) {
          try { await waitWithSignal(run.waitForViews(), workSignal); }
          catch (error) { if (!delivery?.aborted || signal.aborted) throw error; }
        }
        progress.phase('finishing');
        const explored = run.finish(modelParticipation);
        sourceWork.abort();
        result.coverage = { sources: run.sourceStates(), semantic: explored.details.semantic?.coverage ?? 'empty',
          unexamined: explored.notRequested.count };
        result.completion = { reason: run.deliveryReason() ?? 'sources-exhausted' };
        result.diagnostics!.push(...explored.issues.map(issue => ({ kind: issue.status, path: issue.path, message: issue.message })));
        if (modelParticipation?.note) result.diagnostics!.push({ kind: 'model', message: modelParticipation.note });
        if (explored.details.fastDecision?.note) result.diagnostics!.push({ kind: 'decision', message: explored.details.fastDecision.note });
        for (const component of requiredExploreComponents(explored.snippets)) {
          const required = component.some(snippet => snippet.required || snippet.requiredGroups?.length);
          const candidates: RetrievalSnippet[] = [];
          let invalid = false;
          for (const snippet of component) {
            const snapshot = await read(snippet.path);
            if (snapshot.status !== 'ready' || snapshot.revision !== snippet.revision) { invalid = true; continue; }
            const lines = snapshot.content.split('\n');
            const ranges: Array<{ startLine: number; endLine: number }> = [];
            let cursor = snippet.startLine;
            for (const omitted of [...(snippet.unit?.omitted ?? [])].sort((a, b) => a.startLine - b.startLine)) {
              if (omitted.endLine < cursor || omitted.startLine > snippet.endLine) continue;
              if (omitted.startLine > cursor) ranges.push({ startLine: cursor, endLine: Math.min(snippet.endLine, omitted.startLine - 1) });
              cursor = Math.max(cursor, omitted.endLine + 1);
            }
            if (cursor <= snippet.endLine) ranges.push({ startLine: cursor, endLine: snippet.endLine });
            const isFocus = (range: { startLine: number; endLine: number }): boolean => [...(focuses.get(snippet.path) ?? [])].some(line => line >= range.startLine && line <= range.endLine);
            ranges.sort((a, b) => Number(isFocus(b)) - Number(isFocus(a)) || a.startLine - b.startLine);
            for (const range of ranges) {
              if (range.startLine < 1 || range.endLine > lines.length) { invalid = true; continue; }
              candidates.push({ path: snippet.path, revision: snippet.revision, ...range,
                content: lines.slice(range.startLine - 1, range.endLine).join('\n'),
                why: snippet.why,
                ...(snippet.required ? { required: true } : {}), ...(snippet.requiredGroups?.length ? { requiredGroups: snippet.requiredGroups } : {}) });
            }
          }
          if (required && invalid) {
            result.diagnostics!.push({ kind: 'stale', message: 'A required evidence group contains an invalid source range.' });
            stage('model', 'partial'); continue;
          }
          result.snippets.push(...candidates);
        }
        if (binding.model?.kind === 'snippets' && result.snippets.length && !delivery?.aborted) {
          progress.phase('selecting');
          // Recheck the exact permit immediately before sending any source to a selected model.
          for (const path of new Set(result.snippets.map(item => item.path))) {
            await sources.checkPath(query, path, signal);
          }
          await validateBinding();
          try {
            // The private query observer may detach, but this owner retains the original
            // model lease through actual body drain and receipt publication.
            const selected = await waitWithSignal(own(binding.model.select({ question: query.question, snippets: Object.freeze(result.snippets.map(item => Object.freeze({ ...item }))) },
              delivery ? AbortSignal.any([signal, delivery]) : signal)), delivery ? AbortSignal.any([signal, delivery]) : signal);
            const selection = selected.indices;
            if (!Array.isArray(selection) || selection.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.snippets.length) || new Set(selection).size !== selection.length) throw new Error('Invalid retrieval selection');
            result.snippets = selection.map(index => result.snippets[index]!);
            stage('model', selected.status);
          } catch { signal.throwIfAborted(); if (!delivery?.aborted) stage('model', 'failed'); }
        }
        signal.throwIfAborted();
        await validateBinding();
        for (const path of new Set(result.snippets.map(item => item.path))) {
          await sources.checkPath(query, path, signal);
        }
        const incomplete = explored.issues.length > 0 || Object.values(result.omissions).some(count => count > 0)
          || result.stages.some(entry => !['ready','empty','disabled'].includes(entry.status));
        result.status = incomplete ? 'partial' : result.snippets.length ? 'ready' : 'empty';
        if (!result.snippets.length && result.stages.some(entry => entry.status === 'failed'
          && (entry.kind === 'keyword' || entry.kind === 'model'))) result.status = 'failed';
        return structuredClone(result);
      } catch (error) {
        const failure = signal.aborted ? undefined : sourceFailureCode(error);
        if (failure) result.sourceFailure = failure;
        result.status = signal.aborted ? 'cancelled' : 'failed'; result.snippets = [];
        return result;
      } finally {
        delivery?.removeEventListener('abort', finishRequested);
        observing.abort();
        if (run.terminal() === 'active') run.cancel();
      }
    } catch (error) {
      if (delivery?.aborted && !signal.aborted) return { status: 'empty', snippets: [], stages: [],
        omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, completion: { reason: 'user' } };
      throw error;
    } finally {
      sourceWork.abort();
      if (outstanding.size) void Promise.allSettled([...outstanding]).then(() => binding.release?.());
      else binding.release?.();
    }
  };
  return async (query, signal, emit, delivery, observeMaterials) => {
    const progress = createExploreProgress(emit);
    progress.phase('starting');
    const withInference = () => {
      const invocation = query.invocation;
      const origin = invocation.kind === 'model_step' ? { kind: 'model_step' as const, request_id: invocation.requestId }
        : invocation.kind === 'policy_action' ? { kind: 'policy_action' as const, action_id: invocation.actionId, node_id: invocation.nodeId }
          : { kind: 'nested_call' as const, parent_operation_id: invocation.parentOperationId };
      return inferenceRequests!.run({ operationId: toolOperationId(origin, invocation.toolCallId), executorOwner: query.inferenceOwner }, signal,
        async call => { await call.assertFresh(); return execute(query, call.signal, progress, call, delivery, observeMaterials); }, { deliverBeforeDrain: true });
    };
    try {
      const result = inferenceRequests ? await withInference() : await execute(query, signal, progress, undefined, delivery, observeMaterials);
      progress.phase(result.status === 'ready' ? 'complete' : result.status === 'unsupported' ? 'unavailable'
        : result.status === 'stale' ? 'partial' : result.status);
      return result;
    } catch (error) { progress.phase(signal.aborted ? 'cancelled' : 'failed'); throw error; }
  };
}
