import { contentHashOf } from '../knowledge/semantic/identity.js';
import type { DocumentAuthority } from '../documents/authority.js';
import { createExploreQueryRun, DEFAULT_BYTE_BUDGET, DEFAULT_EXCERPT_LIMIT, type ExploreDeps } from '../harness/explore.js';
import type { ExploreFileSnapshot } from '../harness/explore-file-reader.js';
import type { BoundRetrievalPipeline, PipelinePlan, RetrievalPipelineOwner, RetrievalSnippet, RetrievalStageKind, RetrievalStageStatus } from '../harness/retrieval-pipeline.js';
import { waitWithSignal } from '../cancellation.js';
import { decodeNativeSearchHit, CONTENT_SEARCH_EXCLUDED_DIRS } from '../search/content.js';
import { runKernelCompute } from './compute-runner.js';
import type { KernelClient } from './kernel-client.js';
import type { NativeLiveSourceResolver } from './native-live-source.js';
import type { NativeLiveRoot, NativeRetrievalQuery } from './protocol.generated.js';
import type { NativeSemanticInferenceReceipt } from '../knowledge/semantic/native-inference.js';

export interface NativeRetrievalResult {
  status: Exclude<RetrievalStageStatus, 'disabled'>;
  plan?: PipelinePlan;
  source?: { mode: 'live_root'; workspaceId: string; executionWorkspaceId: string; liveRoot: NativeLiveRoot };
  snippets: RetrievalSnippet[];
  omissions: { outOfScope: number; stale: number; unavailable: number };
  stages: Array<{ kind: RetrievalStageKind; status: RetrievalStageStatus }>;
  message?: string;
  inferenceReceipts?: readonly NativeSemanticInferenceReceipt[];
}
export type NativeRetrievalOwner = (query: NativeRetrievalQuery, signal: AbortSignal) => Promise<NativeRetrievalResult>;
const relative = (path: string): string => {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/') || path.includes(':') || path.includes('\0') || path.split('/').includes('..')) throw new Error('Invalid retrieval resource path');
  return path.split('/').filter(part => part && part !== '.').join('/');
};
const within = (path: string, roots: readonly string[]): boolean => roots.some(root => !root || path === root || path.startsWith(`${root}/`));
const rank: Record<RetrievalStageStatus, number> = { disabled: 0, empty: 1, ready: 2, unsupported: 3, unavailable: 4, partial: 5, stale: 6, failed: 7, cancelled: 8 };

/** Native identity is explicit. Explore algorithms are reused without a Pi actor/session/store.
 * Search and per-path admission use the original Run grant; Documents remains the text owner.
 * Providers only receive text after admission. Rust independently verifies all returned snippets.
 */
export function createNativeRetrievalOwner({ documents, kernel, validateSource, pipelines, preparePipeline }: {
  documents: Pick<DocumentAuthority, 'readSnapshot'>;
  kernel: KernelClient;
  validateSource: NativeLiveSourceResolver;
  pipelines?: Pick<RetrievalPipelineOwner, 'capture'>;
  preparePipeline?: (query: NativeRetrievalQuery, signal: AbortSignal) => Promise<BoundRetrievalPipeline>;
}): NativeRetrievalOwner {
  return async (query, signal) => {
    // Bind before source I/O. A later settings publication cannot replace this query's selected stages.
    let binding: BoundRetrievalPipeline;
    try {
      if (preparePipeline) {
        const preparing = preparePipeline(query, signal);
        try { binding = await waitWithSignal(preparing, signal); }
        catch (error) { void preparing.then(late => late.release?.(), () => {}); throw error; }
      } else {
        if (!pipelines) throw new Error('Retrieval selection is unavailable');
        binding = pipelines.capture();
      }
    } catch {
      return { status: signal.aborted ? 'cancelled' : 'failed', snippets: [], stages: [],
        omissions: { outOfScope: 0, stale: 0, unavailable: 0 }, message: 'Selected retrieval configuration could not be prepared' };
    }
    try {
      const result: NativeRetrievalResult = { status: 'empty', plan: binding.plan,
        source: { mode: 'live_root', workspaceId: query.workspaceId, executionWorkspaceId: query.executionWorkspaceId, liveRoot: { ...query.liveRoot } },
        snippets: [], omissions: { outOfScope: 0, stale: 0, unavailable: 0 },
        stages: binding.plan.stages.map(stage => ({ kind: stage.kind, status: stage.status === 'ready' ? 'empty' : stage.status })),
      };
      const stage = (kind: RetrievalStageKind, status: RetrievalStageStatus): void => {
        const entry = result.stages.find(item => item.kind === kind)!;
        if (rank[status] > rank[entry.status]) entry.status = status;
      };
      signal.throwIfAborted();
      binding.assertAvailable?.();
      await waitWithSignal(validateSource(query, signal), signal);
      const grant = kernel.nativeRetrievalGrant(query);
      const client = kernel.scoped(grant);
      const validateBinding = async (): Promise<void> => {
        signal.throwIfAborted();
        binding.assertAvailable?.();
        kernel.nativeRetrievalGrant(query);
        if (binding.validateAvailable) await waitWithSignal(binding.validateAvailable(signal), signal);
        signal.throwIfAborted();
        binding.assertAvailable?.();
        kernel.nativeRetrievalGrant(query);
      };
      await validateBinding();
      const grantedRoots = grant.pathScopes.map(relative);
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
            const address = { workspaceId: query.workspaceId, rootId: query.liveRoot.rootId, path };
            const before = await client.fileReadCheck(address, signal);
            await validateBinding();
            const snapshot = await documents.readSnapshot({ workspaceId: query.workspaceId, resourceId: path }, { signal });
            const after = await client.fileReadCheck(address, signal);
            await validateBinding();
            if (before.resourceKey !== after.resourceKey) { result.omissions.stale++; return { status: 'stale', message: 'Resource identity changed during retrieval' }; }
            if (snapshot.status !== 'ready') { result.omissions.unavailable++; return { status: 'unavailable', message: 'Candidate text is unavailable' }; }
            return { status: 'ready', content: snapshot.content, revision: snapshot.revision, source: 'disk' };
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
          const page = await runKernelCompute(client, {
            workspaceId: query.workspaceId, rootId: query.liveRoot.rootId, operation: 'search', lane: 'foreground',
            paths: options.paths?.map(relative) ?? roots, query: pattern, fixedStrings: options.fixedStrings,
            ignoreCase: true, includeHidden: true, respectGitignore: true, excludeDirectories: CONTENT_SEARCH_EXCLUDED_DIRS,
            maxResults: options.candidateBudget ?? 200,
          }, { signal });
          signal.throwIfAborted();
          if (page.status === 'failed' || page.status === 'cancelled') {
            stage('keyword', page.status);
            throw new Error('Native keyword search did not complete');
          }
          stage('keyword', page.status === 'partial' ? 'partial' : page.records.length ? 'ready' : 'empty');
          const hits = [];
          for (const record of page.records) {
            const hit = decodeNativeSearchHit(record, query.workspaceId);
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
              const response = await waitWithSignal(structure.outline({ ...request, workspaceId: query.workspaceId, signal }), signal);
              stage('structure', response.status);
              return response;
            } catch (error) { stage('structure', signal.aborted ? 'cancelled' : 'failed'); throw error; }
          },
          classifyHits: async request => {
            try {
              const response = await waitWithSignal(structure.classifyHits({ ...request, workspaceId: query.workspaceId, signal }), signal);
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
      try {
        run.start();
        await waitWithSignal(run.waitForViews(), signal);
        const explored = run.finish();
        let bytes = 0;
        for (const snippet of explored.snippets) {
          const snapshot = await read(snippet.path);
          if (snapshot.status !== 'ready' || snapshot.revision !== snippet.revision) continue;
          const lines = snapshot.content.split('\n');
          // A structure window may contain signature + focus blocks, not one contiguous range.
          // Preserve the slicer's omitted spans; never refill its omitted body and truncate away the hit.
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
            if (result.snippets.length >= (query.limit ?? DEFAULT_EXCERPT_LIMIT)) { stage('keyword', 'partial'); break; }
            let end = range.startLine - 1;
            let content = '';
            for (let index = range.startLine - 1; index < Math.min(range.endLine, lines.length); index++) {
              const next = `${content}${end >= range.startLine ? '\n' : ''}${lines[index]!}`;
              if (bytes + Buffer.byteLength(next, 'utf8') > DEFAULT_BYTE_BUDGET) break;
              content = next; end = index + 1;
            }
            if (end < range.endLine) stage('keyword', 'partial');
            if (end < range.startLine) continue;
            bytes += Buffer.byteLength(content, 'utf8');
            result.snippets.push({ path: snippet.path, revision: snippet.revision, startLine: range.startLine, endLine: end, content });
          }
        }
        binding.assertAvailable?.();
        kernel.nativeRetrievalGrant(query);
        if (binding.model && result.snippets.length) {
          // Recheck the exact permit immediately before sending any source to a selected model.
          for (const path of new Set(result.snippets.map(item => item.path))) {
            await client.fileReadCheck({ workspaceId: query.workspaceId, rootId: query.liveRoot.rootId, path }, signal);
          }
          await validateBinding();
          try {
            const selection = await waitWithSignal(binding.model({ question: query.question, snippets: Object.freeze(result.snippets.map(item => Object.freeze({ ...item }))) }, signal), signal);
            if (!Array.isArray(selection) || selection.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.snippets.length) || new Set(selection).size !== selection.length) throw new Error('Invalid retrieval selection');
            result.snippets = selection.map(index => result.snippets[index]!);
            stage('model', result.snippets.length ? 'ready' : 'empty');
          } catch { signal.throwIfAborted(); stage('model', 'failed'); }
        }
        signal.throwIfAborted();
        await waitWithSignal(validateSource(query, signal), signal);
        await validateBinding();
        for (const path of new Set(result.snippets.map(item => item.path))) {
          await client.fileReadCheck({ workspaceId: query.workspaceId, rootId: query.liveRoot.rootId, path }, signal);
        }
        await validateBinding();
        const incomplete = explored.partial || explored.searchIncomplete || Object.values(result.omissions).some(count => count > 0)
          || result.stages.some(entry => !['ready','empty','disabled'].includes(entry.status));
        result.status = incomplete ? 'partial' : result.snippets.length ? 'ready' : 'empty';
        if (!result.snippets.length && result.stages.find(entry => entry.kind === 'keyword')?.status === 'failed') result.status = 'failed';
        return result;
      } catch {
        result.status = signal.aborted ? 'cancelled' : 'failed'; result.snippets = [];
        return result;
      } finally {
        if (run.terminal() === 'active') run.cancel();
        if (binding.inferenceReceipts) result.inferenceReceipts = binding.inferenceReceipts();
      }
    } finally { binding.release?.(); }
  };
}
