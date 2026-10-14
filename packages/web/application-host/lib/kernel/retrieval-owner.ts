import { sourceFailureCode } from './source-admission-error.js';
import type { SourceFailureCode } from './protocol.generated.js';
import type { FastDecisionMaterial } from '@varin/protocol';
import { contentHashOf } from '../knowledge/semantic/identity.js';
import { createExploreQueryRun, formatExploreOutput, requiredExploreComponents, DEFAULT_BYTE_BUDGET, DEFAULT_EXCERPT_LIMIT, type ExploreDeps } from '../harness/explore.js';
import type { ExploreFileSnapshot } from '../harness/file-snapshot.js';
import type { BoundRetrievalPipeline, PipelinePlan, RetrievalPipelineOwner, RetrievalSnippet, RetrievalStageKind, RetrievalStageStatus } from '../harness/retrieval-pipeline.js';
import { waitWithSignal } from '../cancellation.js';
import { decodeSearchHit, CONTENT_SEARCH_EXCLUDED_DIRS } from '../search/content.js';
import type { KernelClient } from './kernel-client.js';
import type { RetrievalSourceOwner } from './retrieval-source.js';
import { toolOperationId, type LiveRoot, type LaunchSource, type RetrievalQuery } from './protocol.generated.js';
import type { InferenceCall, InferenceRequests } from '../knowledge/semantic/inference-requests.js';

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
}
export type RetrievalOwner = (query: RetrievalQuery, signal: AbortSignal) => Promise<RetrievalResult>;
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
export function createRetrievalOwner({ sources, kernel, pipelines, preparePipeline, inferenceRequests }: {
  sources: RetrievalSourceOwner;
  kernel: KernelClient;
  pipelines?: Pick<RetrievalPipelineOwner, 'capture'>;
  inferenceRequests?: Pick<InferenceRequests, 'run'>;
  preparePipeline?: (query: RetrievalQuery, signal: AbortSignal, inference?: InferenceCall) => Promise<BoundRetrievalPipeline>;
}): RetrievalOwner {
  const execute = async (query: RetrievalQuery, signal: AbortSignal, inference?: InferenceCall): Promise<RetrievalResult> => {
    // Bind before source I/O. A later settings publication cannot replace this query's selected stages.
    let binding: BoundRetrievalPipeline;
    try {
      if (preparePipeline) {
        const preparing = preparePipeline(query, signal, inference);
        try { binding = await waitWithSignal(preparing, signal); }
        catch (error) { void preparing.then(late => late.release?.(), () => {}); throw error; }
      } else {
        if (!pipelines) throw new Error('Retrieval selection is unavailable');
        binding = pipelines.capture();
      }
    } catch (error) {
      const failure = signal.aborted ? undefined : sourceFailureCode(error);
      return { status: signal.aborted ? 'cancelled' : 'failed', ...(failure ? { sourceFailure: failure } : {}), snippets: [], stages: [],
        omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, message: 'Selected retrieval configuration could not be prepared' };
    }
    try {
      const result: RetrievalResult = { status: 'empty', plan: binding.plan,
        source: query.source, physicalRoot: query.physicalRoot,
        snippets: [], omissions: { outOfScope: 0, stale: 0, unavailable: 0 },
        stages: binding.plan.stages.map(stage => ({ kind: stage.kind, status: stage.status === 'ready' ? 'empty' : stage.status })),
      };
      const stage = (kind: RetrievalStageKind, status: RetrievalStageStatus): void => {
        const entry = result.stages.find(item => item.kind === kind)!;
        if (rank[status] > rank[entry.status]) entry.status = status;
      };
      signal.throwIfAborted();
      binding.assertAvailable?.();
      await waitWithSignal(sources.validate(query, signal), signal);
      const pathScopes = await sources.pathScopes(query, signal);
      const validateBinding = async (): Promise<void> => {
        signal.throwIfAborted();
        binding.assertAvailable?.();
        await sources.validate(query, signal);
        if (binding.validateAvailable) await waitWithSignal(binding.validateAvailable(signal), signal);
        signal.throwIfAborted();
        binding.assertAvailable?.();
        await sources.validate(query, signal);
      };
      await validateBinding();
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
            await validateBinding();
            const snapshot = await sources.read(query, path, signal);
            await validateBinding();
            if (snapshot.status === 'stale') result.omissions.stale++;
            else if (snapshot.status !== 'ready') result.omissions.unavailable++;
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
          const page = await sources.compute(query, { operation: 'search', lane: 'foreground',
            paths: options.paths?.map(relative) ?? roots, query: pattern, fixedStrings: options.fixedStrings,
            ignoreCase: true, includeHidden: true, respectGitignore: true, excludeDirectories: CONTENT_SEARCH_EXCLUDED_DIRS,
            maxResults: options.candidateBudget ?? 200,
          }, { signal });
          signal.throwIfAborted();
          if (page.status === 'failed' || page.status === 'cancelled') {
            stage('keyword', page.status);
            throw new Error('Keyword search did not complete');
          }
          stage('keyword', page.status === 'partial' ? 'partial' : page.records.length ? 'ready' : 'empty');
          const hits = [];
          for (const record of page.records) {
            const hit = decodeSearchHit(record, query.source.workspace_id);
            if (!hit) continue;
            const snapshot = await read(hit.resource.resourceId);
            if (snapshot.status !== 'ready') continue;
            if (snapshot.revision !== hit.revision) { result.omissions.stale++; continue; }
            const line = snapshot.content.split('\n')[hit.line - 1];
            if (line === undefined) { result.omissions.stale++; continue; }
            focus(hit.resource.resourceId, hit.line);
            hits.push({ path: hit.resource.resourceId, line: hit.line, text: line.replace(/\r$/u, '') });
          }
          return { hits, partial: page.status === 'partial' || Object.values(result.omissions).some(count => count > 0) };
        },
      };
      if (binding.structure) {
        const structure = binding.structure;
        deps.structure = {
          outline: async request => {
            try {
              const response = await waitWithSignal(structure.outline({ ...request, workspaceId: query.source.workspace_id, signal }), signal);
              stage('structure', response.status);
              return response;
            } catch (error) { stage('structure', signal.aborted ? 'cancelled' : 'failed'); throw error; }
          },
          classifyHits: async request => {
            try {
              const response = await waitWithSignal(structure.classifyHits({ ...request, workspaceId: query.source.workspace_id, signal }), signal);
              stage('structure', response.status);
              return response;
            } catch (error) { stage('structure', signal.aborted ? 'cancelled' : 'failed'); throw error; }
          },
        };
      }
      if (binding.semantic) deps.semantic = { search: async (question, limit) => {
        try {
          // This checks the original Run, source and backend owner before query embedding.
          await validateBinding();
          const response = await waitWithSignal(binding.semantic!.search(question, limit, signal), signal);
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
          stage('semantic', response.status === 'ready' ? (response.coverage === 'complete' ? 'ready' : 'partial') : response.status === 'empty' ? (response.coverage === 'complete' ? 'empty' : 'partial') : response.status === 'incomplete' ? 'partial' : response.status === 'failed' ? 'failed' : response.status === 'stale' ? 'stale' : 'unavailable');
          return { ...response, hits };
        } catch (error) { stage('semantic', signal.aborted ? 'cancelled' : 'failed'); throw error; }
      } };
      const run = createExploreQueryRun({ question: query.question, paths: roots.length === 1 && roots[0] === '' ? ['.'] : roots,
        ...(query.limit === undefined ? {} : { limit: query.limit }) }, deps, { signal });
      // Only this query owner can resolve the loop's material identities back to
      // admitted views. Re-read the same selected source at HTTP/delivery fences;
      // structure views retain their own legitimate omitted-range text.
      const validateMaterials = async (materials: readonly FastDecisionMaterial[]) => {
        await validateBinding();
        await waitWithSignal(sources.validate(query, signal), signal);
        const views = new Map([...run.collect().views, ...run.selectedViews()].map(view => [view.viewId, view]));
        for (const material of materials) {
          const view = views.get(material.id);
          if (!view || material.revision !== view.revision || material.text !== view.text
            || material.label !== `${view.path}:${view.startLine}-${view.endLine}`) throw new Error('Original retrieval view changed');
        }
        // Action questions also disclose names discovered in admitted source, even
        // when no new material is offered. Their original snapshots remain fenced.
        const paths = new Map([...views.values()].map(view => [view.path, view.revision]));
        for (const [path, revision] of paths) {
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
            result.omissions.stale++;
            throw new Error('Retrieval material version changed');
          }
        }
        await waitWithSignal(sources.validate(query, signal), signal);
        await validateBinding();
      };
      let modelParticipation: import('@varin/protocol').ExploreModelParticipation | undefined;
      try {
        run.start();
        if (binding.model?.kind === 'progressive') {
          try {
            // The query observer may detach immediately on cancel. This real owner
            // awaits its session so HTTP bodies and receipts retain their lifetime.
            const details = await binding.model.select({ run, validateMaterials }, signal);
            modelParticipation = details.model;
            if (details.fastDecision) {
              const decision = details.fastDecision;
              run.applyFastDecision(decision);
              stage('model', decision.status === 'failed' || decision.status === 'cancelled' ? decision.status
                : decision.missing || decision.unevaluatedMaterials ? 'partial' : decision.status === 'used' ? 'ready' : 'empty');
            }
            if (details.model) {
              const phases = [details.model.plan, details.model.select, details.model.followup, details.model.fastDecision];
              stage('model', phases.includes('failed') ? 'failed' : phases.includes('cancelled') ? 'cancelled'
                : phases.includes('used') ? 'ready' : 'empty');
            }
          } catch { signal.throwIfAborted(); stage('model', 'failed'); }
        }
        await waitWithSignal(run.waitForViews(), signal);
        const explored = run.finish(modelParticipation);
        const packed = modelParticipation?.select === 'used' ? formatExploreOutput(explored)
          : { snippets: explored.snippets, omitted: explored.omitted };
        if (packed.omitted.length > explored.omitted.length) stage('model', 'partial');
        let bytes = 0;
        for (const component of requiredExploreComponents(packed.snippets)) {
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
                ...(snippet.required ? { required: true } : {}), ...(snippet.requiredGroups?.length ? { requiredGroups: snippet.requiredGroups } : {}) });
            }
          }
          const remaining = (query.limit ?? DEFAULT_EXCERPT_LIMIT) - result.snippets.length;
          const componentBytes = candidates.reduce((total, snippet) => total + Buffer.byteLength(snippet.content, 'utf8'), 0);
          if (required && (invalid || candidates.length > remaining || bytes + componentBytes > DEFAULT_BYTE_BUDGET)) {
            result.omissions.unavailable++; stage('model', 'partial'); continue;
          }
          for (const candidate of candidates) {
            if (result.snippets.length >= (query.limit ?? DEFAULT_EXCERPT_LIMIT)) { stage('keyword', 'partial'); continue; }
            let snippet = candidate;
            if (bytes + Buffer.byteLength(snippet.content, 'utf8') > DEFAULT_BYTE_BUDGET) {
              // Optional source ranges retain the original line-bound byte-budget behavior.
              // Required components were checked in full above and are never truncated.
              stage('keyword', 'partial');
              let content = '';
              let endLine = snippet.startLine - 1;
              for (const line of snippet.content.split('\n')) {
                const next = `${content}${endLine >= snippet.startLine ? '\n' : ''}${line}`;
                if (bytes + Buffer.byteLength(next, 'utf8') > DEFAULT_BYTE_BUDGET) break;
                content = next; endLine++;
              }
              if (endLine < snippet.startLine) continue;
              snippet = { ...snippet, content, endLine };
            }
            bytes += Buffer.byteLength(snippet.content, 'utf8');
            result.snippets.push(snippet);
          }
        }
        binding.assertAvailable?.();
        await sources.validate(query, signal);
        if (binding.model?.kind === 'snippets' && result.snippets.length) {
          // Recheck the exact permit immediately before sending any source to a selected model.
          for (const path of new Set(result.snippets.map(item => item.path))) {
            await sources.checkPath(query, path, signal);
          }
          await validateBinding();
          try {
            // The private query observer may detach, but this owner retains the original
            // model lease through actual body drain and receipt publication.
            const selected = await binding.model.select({ question: query.question, snippets: Object.freeze(result.snippets.map(item => Object.freeze({ ...item }))) }, signal);
            const selection = selected.indices;
            if (!Array.isArray(selection) || selection.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.snippets.length) || new Set(selection).size !== selection.length) throw new Error('Invalid retrieval selection');
            result.snippets = selection.map(index => result.snippets[index]!);
            stage('model', selected.status);
          } catch { signal.throwIfAborted(); stage('model', 'failed'); }
        }
        signal.throwIfAborted();
        await waitWithSignal(sources.validate(query, signal), signal);
        await validateBinding();
        for (const path of new Set(result.snippets.map(item => item.path))) {
          await sources.checkPath(query, path, signal);
        }
        await validateBinding();
        const incomplete = explored.partial || explored.searchIncomplete || Object.values(result.omissions).some(count => count > 0)
          || result.stages.some(entry => !['ready','empty','disabled'].includes(entry.status));
        result.status = incomplete ? 'partial' : result.snippets.length ? 'ready' : 'empty';
        if (!result.snippets.length && result.stages.find(entry => entry.kind === 'keyword')?.status === 'failed') result.status = 'failed';
        return result;
      } catch (error) {
        const failure = signal.aborted ? undefined : sourceFailureCode(error);
        if (failure) result.sourceFailure = failure;
        result.status = signal.aborted ? 'cancelled' : 'failed'; result.snippets = [];
        return result;
      } finally {
        if (run.terminal() === 'active') run.cancel();
      }
    } finally { binding.release?.(); }
  };
  return (query, signal) => {
    if (!inferenceRequests) return execute(query, signal);
    const invocation = query.invocation;
    const origin = invocation.kind === 'model_step' ? { kind: 'model_step' as const, request_id: invocation.requestId }
      : invocation.kind === 'policy_action' ? { kind: 'policy_action' as const, action_id: invocation.actionId, node_id: invocation.nodeId }
        : { kind: 'nested_call' as const, parent_operation_id: invocation.parentOperationId };
    return inferenceRequests.run({ operationId: toolOperationId(origin, invocation.toolCallId), executorOwner: query.inferenceOwner }, signal,
      async call => {
        await call.assertFresh();
        return execute(query, call.signal, call);
      });
  };
}
