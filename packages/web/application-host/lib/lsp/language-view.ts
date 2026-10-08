import { languageIdForPath, type AgentInputContext } from '@varin/protocol';
import { createHash } from 'node:crypto';
import { waitWithSignal } from '../cancellation.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { HarnessDocumentReadSource } from '../harness/service-host.js';
import { AGENT_LANGUAGE_VIEW, type LanguageViewId, type createLanguageSupervisor } from './supervisor.js';

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>, 'syncDocument'>;

export type LanguageTextSource = 'disk' | 'surface-draft' | 'working-branch';

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
  /** `input-context` follows the turn's fixed draft; `disk` never reads a buffer. */
  text: 'disk' | 'input-context';
  sessionId?: string;
  inputContext?: AgentInputContext;
  signal?: AbortSignal;
  reportPhase?: (phase: string) => void;
  warmOnly?: boolean;
}

export type ResolveLanguageTarget = (input: BindLanguageDocumentInput) => Promise<{
  workspaceId: string; resourceId: string; source?: LanguageTextSource; inputContext?: AgentInputContext;
  sourceRevision?: (diskRevision: string) => string;
}>;

interface LanguageViewBinderDeps {
  documents: Pick<DocumentAuthority, 'readSnapshot' | 'readAgentInputSnapshot'>;
  supervisor: LanguageSupervisor;
  readSource?: HarnessDocumentReadSource;
  resolveTarget?: ResolveLanguageTarget;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/**
 * Binds one document in the Host-owned language view to a named text identity
 * (D-087). The editor view keeps its live buffer; a Host caller states which
 * text it wants and receives the revision the server was actually given, so a
 * range can be attributed afterwards. A known dirty path whose fixed draft is
 * unavailable never falls back to disk.
 */
export function createLanguageViewBinder(deps: LanguageViewBinderDeps) {
  const resolveText = async (
    input: BindLanguageDocumentInput,
  ): Promise<{ content: string; revision: string; source: LanguageTextSource } | { status: 'unavailable'; message: string }> => {
    const resource = { workspaceId: input.workspaceId, resourceId: input.resourceId };
    if (input.text === 'input-context' && input.sessionId && input.inputContext) {
      const draft = deps.readSource
        ? await deps.readSource(input.sessionId, input.inputContext, input.resourceId, input.workspaceId, input)
        : deps.documents.readAgentInputSnapshot(input.sessionId, input.inputContext, input.resourceId, input.workspaceId);
      if (draft.status === 'unavailable') return draft;
      if (draft.status === 'working-branch') {
        if (draft.message || draft.missing || draft.base64 === undefined) {
          return { status: 'unavailable', message: draft.message ?? 'The working-branch document is missing' };
        }
        return { content: Buffer.from(draft.base64, 'base64').toString('utf8'), revision: draft.revision, source: 'working-branch' };
      }
      if (draft.status === 'ready') {
        return { content: draft.content, revision: draft.revision, source: 'surface-draft' };
      }
    }
    const snapshot = await deps.documents.readSnapshot(resource, input);
    if (snapshot.status !== 'ready') {
      return { status: 'unavailable', message: `Document cannot be read (${snapshot.status}).` };
    }
    return { content: snapshot.content, revision: snapshot.revision, source: 'disk' };
  };

  const bind = async (input: BindLanguageDocumentInput): Promise<BindLanguageDocumentResult> => {
    input.signal?.throwIfAborted();
    const target = await deps.resolveTarget?.(input);
    if (target) input = { ...input, ...target };
    input.reportPhase?.('lsp:source');
    // File acquisition keeps its existing 30s budget independently of a
    // shared language startup or an installer that may legitimately take longer.
    const sourceDeadline = AbortSignal.timeout(30_000);
    const sourceInput = { ...input, signal: input.signal ? AbortSignal.any([input.signal, sourceDeadline]) : sourceDeadline };
    const text = await waitWithSignal(resolveText(sourceInput), sourceInput.signal);
    input.signal?.throwIfAborted();
    if ('status' in text) return text;
    const context = input.text === 'input-context' ? input.inputContext : undefined;
    const dirtyPaths = context?.source === 'surface'
      ? context.roots.filter(root => root.workspaceId === input.workspaceId).flatMap(root => root.dirtyPaths)
      : [];
    const drafts = new Map<string, { content: string; revision: string; source: LanguageTextSource }>();
    for (const resourceId of [...new Set(dirtyPaths)].sort()) {
      const draft = resourceId === input.resourceId ? text : await waitWithSignal(resolveText({ ...sourceInput, resourceId }), sourceInput.signal);
      if ('status' in draft) return draft;
      drafts.set(resourceId, draft);
    }
    const view: LanguageViewId = drafts.size
      ? `agent:${createHash('sha256').update(JSON.stringify([...drafts].map(([resourceId, draft]) => [resourceId, draft.content]))).digest('hex')}`
      : AGENT_LANGUAGE_VIEW;
    const revisionFor = (document: { content: string; revision: string }): string => view === AGENT_LANGUAGE_VIEW
      ? document.revision : `language:${createHash('sha256').update(document.content).digest('hex')}`;
    input.reportPhase?.('lsp:sync');
    // A draft view includes the other captured buffers too: imported files
    // must not depend on which one happened to be queried first.
    for (const [resourceId, draft] of drafts) {
      if (resourceId === input.resourceId) continue;
      const synced = recordOf(await deps.supervisor.syncDocument({
        view, resource: { workspaceId: input.workspaceId, resourceId }, languageId: input.languageId,
        documentLanguageId: languageIdForPath(resourceId) ?? input.languageId,
        content: draft.content, contentRevision: revisionFor(draft), fixed: true, reason: 'open',
        ...(input.warmOnly ? { warmOnly: true } : {}),
      }, input));
      if (synced.status !== 'synced') return { status: 'unavailable', message: String(synced.message ?? 'Draft synchronization failed') };
    }
    const request = {
      view,
      resource: { workspaceId: input.workspaceId, resourceId: input.resourceId },
      languageId: input.languageId,
      content: text.content,
      contentRevision: revisionFor(text),
      fixed: dirtyPaths.includes(input.resourceId),
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
      revision: target?.sourceRevision?.(text.revision) ?? text.revision,
      languageRevision: revisionFor(text),
      source: target?.source ?? text.source,
      view,
      resource: request.resource,
      generation: typeof synced.generation === 'number' ? synced.generation : 0,
      viewRevision: typeof synced.viewRevision === 'number' ? synced.viewRevision : 0,
    };
  };

  return { bind };
}

export type LanguageViewBinder = ReturnType<typeof createLanguageViewBinder>;
