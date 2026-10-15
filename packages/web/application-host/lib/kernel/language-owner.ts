import { createHash } from 'node:crypto';
import { languageIdForPath } from '@varin/protocol';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import type { DocumentAuthority } from '../documents/authority.js';
import { createLanguageViewBinder } from '../lsp/language-view.js';
import type { createLanguageSupervisor } from '../lsp/supervisor.js';
import type { SourceQueryOwner, ManagedSourceQueryTransport } from './source-query.js';
import type { LanguageQuery, LaunchSource, LiveRoot, KernelMaterializedView } from './protocol.generated.js';


export interface LanguageResult {
  status: 'ready' | 'partial' | 'pending' | 'unsupported' | 'unavailable' | 'stale' | 'cancelled';
  source?: {
    selection: LaunchSource;
    physicalRoot: LiveRoot | null;
    derivedView?: KernelMaterializedView;
    resourceId: string; revision: string; view: string; documentVersion: number; generation: number;
    providerId?: string; dependencies: { source: 'fixed_branch' | 'live'; external: 'provider_environment' };
  };
  items: Array<Record<string, unknown>>;
  omissions: { outOfScope: number; unmappable: number; stale: number; unavailable: number };
  diagnosticVerification?: 'unversioned';
  message?: string;
}
export type LanguageToolOwner = ((query: LanguageQuery, signal: AbortSignal) => Promise<LanguageResult>) & {
  releaseSource?(match: { runId?: string; grantId?: string }): Promise<void>;
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const failure = (status: LanguageResult['status'], message?: string): LanguageResult => ({ status, items: [], omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 }, ...(message ? { message } : {}) });

/** Adapter onto the selected language owner, not a server/configuration or source-view owner.
 * Rust admits the input before dispatch and every returned location before committing the receipt.
 * Captured project files resolve through the derived tree for fixed sources; provider
 * libraries and explicit external configuration retain their real environment semantics.
 */
export function createLanguageOwner({ documents, supervisor, sources, remote, targetAuthority }: {
  documents: Pick<DocumentAuthority, 'readSnapshot'>;
  supervisor: ReturnType<typeof createLanguageSupervisor>;
  sources: Pick<SourceQueryOwner, 'validateLanguage' | 'read' | 'processAdmission' | 'prepareLanguageView' | 'dispose'>;
  remote?: ManagedSourceQueryTransport;
  /** Target execution uses a real admitted resource grant, without a local Catalog Run. */
  targetAuthority?: true;
}): LanguageToolOwner {
  const owner: LanguageToolOwner = async (query, signal) => {
    try {
    signal.throwIfAborted();
    if (query.source.resource_owner.kind === 'managed_host' && !targetAuthority) {
      if (!remote) return failure('unavailable', 'The original managed language service is unavailable');
      const { runId: _runId, threadId: _threadId, grantId: _grantId, source: _source, physicalRoot: _physicalRoot, ...request } = query;
      return await remote.service(query, { kind: 'language', query: request }, signal);
    }
    await sources.validateLanguage(query, signal);
    const languageId = languageIdForPath(query.path);
    if (!languageId) return failure('unsupported', 'No language is known for this file');
    const observed = await sources.read(query, query.path, signal);
    if (observed.status !== 'ready') return failure(observed.status === 'stale' ? 'stale' : 'unavailable', observed.message);
    // Same actual environment across Runs shares one service. Provider/configuration generations
    // remain solely in the supervisor; neither Run identity nor grant ID enters this view key.
    const view = `agent:source:${createHash('sha256').update(JSON.stringify([
      query.source.resource_owner, query.source.mode, query.source.workspace_id, query.source.execution_workspace_id,
      ...(query.source.mode === 'fixed_branch' ? [query.source.branch_id, query.source.revision]
        : [query.physicalRoot?.hostId, query.physicalRoot?.rootId, query.physicalRoot ? normalizePathIdentity(query.physicalRoot.canonicalRoot) : null]),
    ])).digest('hex')}` as const;
    const environment = await supervisor.retainSourceView({ view, workspaceId: query.source.workspace_id, root: query.physicalRoot?.canonicalRoot ?? '',
      runId: query.runId, grantId: query.grantId, executionWorkspaceId: query.source.execution_workspace_id,
      prepare: (viewId, active) => sources.prepareLanguageView(query, viewId, active),
      admitProcess: (active, prepared) => sources.processAdmission(query, prepared)(active),
      read: (resourceId, active) => sources.read(query, resourceId, active) }, signal);
    signal.throwIfAborted();
    const binder = createLanguageViewBinder({ supervisor, documents });
    const bound = await binder.bind({ workspaceId: query.source.workspace_id, resourceId: query.path, languageId, text: 'disk', signal,
      sourceView: { view, content: observed.content, revision: observed.revision, source: query.source.mode === 'fixed_branch' ? 'working-branch' : 'disk' } });
    if (bound.status !== 'bound') return failure('unavailable', bound.message);
    const positional = query.method === 'definition' || query.method === 'references' || query.method === 'hover' || query.method === 'call_hierarchy';
    if (positional) {
      const row = Number.isSafeInteger(query.line) && query.line! >= 0 ? observed.content.split('\n')[query.line!] : undefined;
      const text = row?.endsWith('\r') ? row.slice(0, -1) : row;
      if (text === undefined || !Number.isSafeInteger(query.character) || query.character! < 0 || query.character! > text.length) {
        return failure('unavailable', 'The zero-based UTF-16 position is outside the source document');
      }
    }
    const result: LanguageResult = { ...failure('ready'), source: {
      selection: query.source, physicalRoot: query.physicalRoot, resourceId: bound.resource.resourceId, revision: bound.revision,
      view: bound.view, documentVersion: bound.documentVersion, generation: bound.generation,
      ...(environment.derivedView ? { derivedView: environment.derivedView } : {}),
      dependencies: { source: query.source.mode === 'fixed_branch' ? 'fixed_branch' : 'live', external: 'provider_environment' },
    } };
    const request = { view: bound.view, resource: bound.resource, languageId,
      expectedRevision: bound.languageRevision, generation: bound.generation,
      documentVersion: bound.documentVersion, expectedViewRevision: bound.viewRevision,
      ...(positional ? { position: { line: query.line, character: query.character } } : {}),
      ...(query.method === 'workspace_symbols' ? { query: query.query } : {}),
      ...(query.method === 'references' ? { includeDeclaration: true } : {}),
    };
    const options = { signal, onRejectedLocation: (reason: 'outOfScope' | 'unmappable') => { result.omissions[reason] += 1; } };
    let response: Record<string, unknown>;
    if (query.method === 'diagnostics') {
      response = record(await supervisor.pullDiagnostics(request, options));
      if (response.reason === 'unsupported') {
        response = record(supervisor.diagnosticsSnapshot(request));
        const omissions = record(response.omissions);
        result.omissions.outOfScope += typeof omissions.outOfScope === 'number' ? omissions.outOfScope : 0;
        result.omissions.unmappable += typeof omissions.unmappable === 'number' ? omissions.unmappable : 0;
      }
      // Pull "unchanged" without a previous resultId is not evidence of clean diagnostics.
      if (response.status === 'ready' && !Array.isArray(response.value)) response = { status: 'pending' };
    } else if (query.method === 'call_hierarchy') {
      response = record(await supervisor.sourceCallHierarchy(request, { ...options, direction: query.direction!,
        admitSource: async () => {
          // The shared view may be retained by another Run. Every RPC in this query
          // still needs this caller's current grant and exact derived source.
          await sources.validateLanguage(query, signal);
          await supervisor.checkSourceView(query.source.workspace_id, view, environment, signal);
        },
      }));
    } else {
      const method = query.method === 'document_symbols' ? 'documentSymbols'
        : query.method === 'workspace_symbols' ? 'workspaceSymbols' : query.method;
      response = record(await supervisor[method](request, options));
    }
    signal.throwIfAborted();
    await sources.validateLanguage(query, signal);
    try { await supervisor.checkSourceView(query.source.workspace_id, view, environment, signal); }
    catch (error) { signal.throwIfAborted(); return { ...result, status: 'stale', message: error instanceof Error ? error.message : 'Source language view changed' }; }
    const current = await sources.read(query, bound.resource.resourceId, signal);
    if (current.status !== 'ready' || current.revision !== bound.revision) {
      return { ...result, status: 'stale', message: 'The queried source changed while the language server was answering' };
    }
    if (typeof response.providerId === 'string') result.source!.providerId = response.providerId;
    const unversioned = query.method === 'diagnostics' && response.status === 'pending' && response.diagnosticVerification === 'unversioned' && Array.isArray(response.value);
    if (unversioned) { result.status = 'pending'; result.diagnosticVerification = 'unversioned'; }
    if (response.status !== 'ready' && !unversioned) {
      const status = response.status === 'pending' || response.status === 'stale' ? response.status
        : response.reason === 'unsupported' ? 'unsupported' : 'unavailable';
      return { ...result, status, ...(typeof response.message === 'string' ? { message: response.message } : {}) };
    }
    const values = query.method === 'hover' ? (response.value === null ? [] : [{ ...record(response.value), resource: bound.resource }])
      : Array.isArray(response.value) ? response.value : [];
    result.items = values.map(value => {
      const item = { ...record(value) };
      // Diagnostics expose their primary location. Related messages remain an editor projection,
      // rather than smuggling unadmitted nested resources into a tool result.
      if (query.method === 'diagnostics') delete item.relatedInformation;
      return item;
    });
    if (!unversioned && (result.omissions.outOfScope || result.omissions.unmappable)) result.status = 'partial';
    return result;
    } catch (error) { signal.throwIfAborted(); return failure('unavailable', error instanceof Error ? error.message : 'Language source is unavailable'); }
  };
  owner.releaseSource = async match => {
    await supervisor.releaseSourceViews(match);
    if (match.runId === undefined && match.grantId === undefined) await sources.dispose();
  };
  return owner;
}
