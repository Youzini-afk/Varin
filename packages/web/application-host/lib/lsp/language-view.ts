import { waitWithSignal } from '../cancellation.js';
import type { DocumentAuthority } from '../documents/authority.js';
import { AGENT_LANGUAGE_VIEW, type LanguageViewId, type createLanguageSupervisor } from './supervisor.js';

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>, 'syncDocument'>;

export type LanguageTextSource = 'disk' | 'working-branch';

export interface BoundLanguageDocument {
  status: 'bound';
  documentVersion: number;
  revision: string;
  languageRevision: string;
  source: LanguageTextSource;
  view: LanguageViewId;
  resource: { workspaceId: string; resourceId: string };
  generation: number;
  viewRevision: number;
}

export type BindLanguageDocumentResult =
  | BoundLanguageDocument
  | { status: 'unavailable'; message: string };

export interface BindLanguageDocumentInput {
  workspaceId: string;
  resourceId: string;
  languageId: string;
  /** Saved text, or admitted bytes from the original native source owner. */
  text: 'disk';
  signal?: AbortSignal;
  reportPhase?: (phase: string) => void;
  warmOnly?: boolean;
  /** Host-private admitted bytes and view; never interpreted as a Documents registration. */
  sourceView?: { view: LanguageViewId; content: string; revision: string; source: LanguageTextSource };
}

interface LanguageViewBinderDeps {
  documents: Pick<DocumentAuthority, 'readSnapshot'>;
  supervisor: LanguageSupervisor;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/**
 * Binds one document in the Host-owned language view to a named text identity
 * (D-087). The editor view keeps its live buffer; a Host caller states which
 * text it wants and receives the revision the server was actually given, so a
 * range can be attributed afterwards. Native source admission and complete
 * source-view preparation stay with the original source owner.
 */
export function createLanguageViewBinder(deps: LanguageViewBinderDeps) {
  const resolveText = async (
    input: BindLanguageDocumentInput,
  ): Promise<{ content: string; revision: string; source: LanguageTextSource } | { status: 'unavailable'; message: string }> => {
    if (input.sourceView) return input.sourceView;
    const resource = { workspaceId: input.workspaceId, resourceId: input.resourceId };
    const snapshot = await deps.documents.readSnapshot(resource, input);
    if (snapshot.status !== 'ready') {
      return { status: 'unavailable', message: `Document cannot be read (${snapshot.status}).` };
    }
    return { content: snapshot.content, revision: snapshot.revision, source: 'disk' };
  };

  const bind = async (input: BindLanguageDocumentInput): Promise<BindLanguageDocumentResult> => {
    input.signal?.throwIfAborted();
    input.reportPhase?.('lsp:source');
    // File acquisition keeps its existing 30s budget independently of a
    // shared language startup or an installer that may legitimately take longer.
    const sourceDeadline = AbortSignal.timeout(30_000);
    const sourceInput = { ...input, signal: input.signal ? AbortSignal.any([input.signal, sourceDeadline]) : sourceDeadline };
    const text = await waitWithSignal(resolveText(sourceInput), sourceInput.signal);
    input.signal?.throwIfAborted();
    if ('status' in text) return text;
    const view = input.sourceView?.view ?? AGENT_LANGUAGE_VIEW;
    input.reportPhase?.('lsp:sync');
    const request = {
      view,
      resource: { workspaceId: input.workspaceId, resourceId: input.resourceId },
      languageId: input.languageId,
      content: text.content,
      contentRevision: text.revision,
      fixed: input.sourceView?.source === 'working-branch',
      reason: 'open',
      ...(input.warmOnly ? { warmOnly: true } : {}),
    };
    const synced = recordOf(await (input.signal
      ? deps.supervisor.syncDocument(request, { signal: input.signal })
      : deps.supervisor.syncDocument(request)));
    if (synced.status !== 'synced') {
      const message = typeof synced.message === 'string' && synced.message
        ? synced.message
        : `document sync ${String(synced.status ?? 'failed')}`;
      return { status: 'unavailable', message };
    }
    return {
      status: 'bound',
      documentVersion: typeof synced.documentVersion === 'number' ? synced.documentVersion : 0,
      revision: text.revision,
      languageRevision: text.revision,
      source: text.source,
      view,
      resource: request.resource,
      generation: typeof synced.generation === 'number' ? synced.generation : 0,
      viewRevision: typeof synced.viewRevision === 'number' ? synced.viewRevision : 0,
    };
  };

  return { bind };
}

export type LanguageViewBinder = ReturnType<typeof createLanguageViewBinder>;
