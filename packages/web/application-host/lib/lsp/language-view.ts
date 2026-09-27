import type { AgentInputContext } from '@varin/protocol';
import type { DocumentAuthority } from '../documents/authority.js';
import type { HarnessDocumentReadSource } from '../harness/service-host.js';
import { AGENT_LANGUAGE_VIEW, type createLanguageSupervisor } from './supervisor.js';

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>, 'syncDocument'>;

export type LanguageTextSource = 'disk' | 'surface-draft' | 'working-branch';

export interface BoundLanguageDocument {
  status: 'bound';
  documentVersion: number;
  revision: string;
  source: LanguageTextSource;
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
}

interface LanguageViewBinderDeps {
  documents: Pick<DocumentAuthority, 'read' | 'readAgentInputSnapshot'>;
  supervisor: LanguageSupervisor;
  readSource?: HarnessDocumentReadSource;
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
        ? await deps.readSource(input.sessionId, input.inputContext, input.resourceId, input.workspaceId)
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
    const snapshot = await deps.documents.read(resource);
    if (snapshot.status !== 'ready') {
      return { status: 'unavailable', message: `Document cannot be read (${snapshot.status}).` };
    }
    return { content: snapshot.content, revision: snapshot.revision, source: 'disk' };
  };

  const bind = async (input: BindLanguageDocumentInput): Promise<BindLanguageDocumentResult> => {
    const text = await resolveText(input);
    if ('status' in text) return text;
    const synced = recordOf(await deps.supervisor.syncDocument({
      view: AGENT_LANGUAGE_VIEW,
      resource: { workspaceId: input.workspaceId, resourceId: input.resourceId },
      languageId: input.languageId,
      content: text.content,
      contentRevision: text.revision,
      reason: 'open',
    }));
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
      source: text.source,
    };
  };

  return { bind };
}

export type LanguageViewBinder = ReturnType<typeof createLanguageViewBinder>;
