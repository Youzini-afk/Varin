import { languageIdForPath } from '@varin/protocol';
import type { DocumentAuthority } from '../documents/authority.js';
import { createLanguageViewBinder } from '../lsp/language-view.js';
import type { createLanguageSupervisor } from '../lsp/supervisor.js';
import type { NativeLiveSourceResolver } from './native-live-source.js';
import type { NativeLanguageQuery, NativeLiveRoot } from './protocol.generated.js';

type SnapshotResult = Awaited<ReturnType<DocumentAuthority['readSnapshot']>>;

export interface NativeLanguageResult {
  status: 'ready' | 'partial' | 'pending' | 'unsupported' | 'unavailable' | 'stale' | 'cancelled';
  source?: {
    mode: 'live_root'; workspaceId: string; executionWorkspaceId: string; liveRoot: NativeLiveRoot;
    resourceId: string; revision: string; view: string; documentVersion: number; generation: number;
    providerId?: string; dependencies: 'live';
  };
  items: Array<Record<string, unknown>>;
  omissions: { outOfScope: number; unmappable: number; stale: number; unavailable: number };
  diagnosticVerification?: 'unversioned';
  message?: string;
}
export type NativeLanguageOwner = (query: NativeLanguageQuery, signal: AbortSignal) => Promise<NativeLanguageResult>;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const failure = (status: NativeLanguageResult['status'], message?: string): NativeLanguageResult => ({ status, items: [], omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 }, ...(message ? { message } : {}) });

/** Adapter onto the selected language owner, not a server/configuration or source-view owner.
 * Rust admits the input before dispatch and every returned location before committing the receipt.
 * Unopened files, configuration, imports and compiler libraries remain live server dependencies.
 */
export function createNativeLanguageOwner({ documents, supervisor, validateSource }: {
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'readAgentInputSnapshot'>;
  supervisor: ReturnType<typeof createLanguageSupervisor>;
  validateSource: NativeLiveSourceResolver;
}): NativeLanguageOwner {
  return async (query, signal) => {
    signal.throwIfAborted();
    await validateSource(query, signal);
    const languageId = languageIdForPath(query.path);
    if (!languageId) return failure('unsupported', 'No language is known for this file');
    if (!['definition', 'references', 'diagnostics'].includes(query.method)) return failure('unsupported', 'Unsupported native language query');
    let observed: SnapshotResult | undefined;
    // Capture the very snapshot the existing binder sends, without reading the file twice or
    // inventing a second revision/encoding contract. This object is local to this one query.
    const binder = createLanguageViewBinder({ supervisor, documents: {
      readAgentInputSnapshot: documents.readAgentInputSnapshot,
      readSnapshot: async (resource, options) => { observed = await documents.readSnapshot(resource, options); return observed; },
    } });
    const bound = await binder.bind({ workspaceId: query.workspaceId, resourceId: query.path, languageId, text: 'disk', signal });
    if (bound.status !== 'bound') return failure('unavailable', bound.message);
    if (observed?.status !== 'ready') return failure('unavailable', 'The language source snapshot is unavailable');
    if (query.method !== 'diagnostics') {
      const row = Number.isSafeInteger(query.line) && query.line! >= 0 ? observed.content.split('\n')[query.line!] : undefined;
      const text = row?.endsWith('\r') ? row.slice(0, -1) : row;
      if (text === undefined || !Number.isSafeInteger(query.character) || query.character! < 0 || query.character! > text.length) {
        return failure('unavailable', 'The zero-based UTF-16 position is outside the source document');
      }
    }
    const result: NativeLanguageResult = { ...failure('ready'), source: {
      mode: 'live_root', workspaceId: query.workspaceId, executionWorkspaceId: query.executionWorkspaceId,
      liveRoot: query.liveRoot, resourceId: bound.resource.resourceId, revision: bound.revision,
      view: bound.view, documentVersion: bound.documentVersion, generation: bound.generation,
      dependencies: 'live',
    } };
    const request = { view: bound.view, resource: bound.resource, languageId,
      expectedRevision: bound.languageRevision, generation: bound.generation,
      documentVersion: bound.documentVersion, expectedViewRevision: bound.viewRevision,
      ...(query.method !== 'diagnostics' ? { position: { line: query.line, character: query.character } } : {}),
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
    } else response = record(await supervisor[query.method === 'definition' ? 'definition' : 'references'](request, options));
    signal.throwIfAborted();
    await validateSource(query, signal);
    const current = await documents.readSnapshot(bound.resource, { signal });
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
    result.items = (Array.isArray(response.value) ? response.value : []).map(value => {
      const item = { ...record(value) };
      // Diagnostics expose their primary location. Related messages remain an editor projection,
      // rather than smuggling unadmitted nested resources into a native tool result.
      if (query.method === 'diagnostics') delete item.relatedInformation;
      return item;
    });
    if (!unversioned && (result.omissions.outOfScope || result.omissions.unmappable)) result.status = 'partial';
    return result;
  };
}
