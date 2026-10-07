import { randomUUID } from 'node:crypto';
import { agentScopeKey, type AgentMemoryScope, type AgentMemoryNote, type AgentPersonalizationCatalog,
  type AgentPersonalizationContext, type AgentPromptProfile } from '@varin/protocol';
import type { KernelClient, KernelScopedClient } from '../kernel/kernel-client.js';

const WORKSPACE = '__varin_agent_personalization__';
const RECORD = 'agent.personalization';
type Document = Omit<AgentPersonalizationCatalog, 'revision'> & { nextId: number };
export class AgentPersonalizationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function parseAgentScope(value: unknown): AgentMemoryScope {
  if (!value || typeof value !== 'object') throw new AgentPersonalizationError('Choose a memory scope');
  const scope = value as AgentMemoryScope;
  if (scope.kind === 'global') return { kind: 'global' };
  if ((scope.kind === 'project' || scope.kind === 'session') && typeof scope.id === 'string' && scope.id.trim()) {
    return { kind: scope.kind, id: scope.id };
  }
  throw new AgentPersonalizationError('Invalid memory scope');
}
export function createAgentPersonalization(options: {
  client: KernelClient;
  context(sessionId: string): Promise<{ bot: boolean; projectId?: string; threadRole?: AgentPersonalizationContext['threadRole'] }>;
  onChanged?(): void;
}) {
  let connection: Promise<KernelScopedClient> | undefined;
  const client = () => connection ??= options.client.issueGrant({ grantId: `agent-personalization:${randomUUID()}`,
    owningWorkspace: WORKSPACE, executionWorkspace: WORKSPACE, capabilities: ['storage.read', 'storage.write'], pathScopes: [''],
  }).then(grant => options.client.scoped(grant)).catch(error => { connection = undefined; throw error; });
  let loaded: Promise<{ document: Document; revision: number }> | undefined;
  const read = () => loaded ??= (async () => {
    const record = await (await client()).getRecord(WORKSPACE, RECORD);
    if (!record) return { document: { memories: [], prompts: {}, nextId: 1 }, revision: 0 };
    const document = JSON.parse(record.payloadJson) as Document;
    if (!Array.isArray(document.memories) || !document.prompts || !Number.isSafeInteger(document.nextId)) {
      throw new Error('Agent personalization is malformed');
    }
    return { document, revision: record.recordRevision };
  })().catch(error => { loaded = undefined; throw error; });
  let tail: Promise<unknown> = Promise.resolve();
  const mutate = <T>(expected: number | undefined, edit: (document: Document) => T) => {
    const task = tail.catch(() => undefined).then(async () => {
      const current = await read();
      if (expected !== undefined && expected !== current.revision) throw new AgentPersonalizationError('Content changed; reload before saving', 409);
      const document = structuredClone(current.document);
      const result = edit(document);
      const record = await (await client()).putRecord({ operationId: `agent-personalization:${randomUUID()}`,
        workspaceId: WORKSPACE, recordId: RECORD, recordType: RECORD, state: 'active',
        payloadJson: JSON.stringify(document), ownerIds: [], references: [],
        ...(current.revision ? { expectedRecordRevision: current.revision } : {}),
      });
      loaded = Promise.resolve({ document, revision: record.recordRevision });
      options.onChanged?.();
      return { result: structuredClone(result), revision: record.recordRevision };
    });
    tail = task;
    return task;
  };
  const catalog = async (): Promise<AgentPersonalizationCatalog> => {
    const { document, revision } = await read();
    return structuredClone({ memories: document.memories, prompts: document.prompts, revision });
  };
  const context = async (sessionId: string): Promise<AgentPersonalizationContext> => {
    const owner = await options.context(sessionId);
    if (owner.bot) return { mode: 'bot', revision: 0, threadRole: owner.threadRole ?? 'main', sessionId, profiles: [], memories: [] };
    const scopes: AgentMemoryScope[] = [{ kind: 'global' }, ...(owner.projectId ? [{ kind: 'project' as const, id: owner.projectId }] : []), { kind: 'session', id: sessionId }];
    const keys = new Set(scopes.map(agentScopeKey));
    const { document, revision } = await read();
    return structuredClone({ mode: 'agent', revision, threadRole: owner.threadRole ?? 'main', sessionId, ...(owner.projectId ? { projectId: owner.projectId } : {}),
      profiles: scopes.flatMap(scope => document.prompts[agentScopeKey(scope)] ? [{ scope, profile: document.prompts[agentScopeKey(scope)]! }] : []),
      memories: document.memories.filter(note => keys.has(agentScopeKey(note.scope))),
    });
  };
  const saveNote = async (input: { id?: number; scope: AgentMemoryScope; content: string; source?: AgentMemoryNote['source']; revision?: number }) => {
    const scope = parseAgentScope(input.scope);
    if (scope.kind === 'session' && (await options.context(scope.id)).bot) throw new AgentPersonalizationError('Manage this Bot’s memory in its own settings');
    if (typeof input.content !== 'string' || !input.content.trim()) throw new AgentPersonalizationError('Memory content is required');
    return mutate(input.revision, document => {
      const previous = input.id === undefined ? undefined : document.memories.find(note => note.id === input.id);
      if (input.id !== undefined && !previous) throw new AgentPersonalizationError('Memory no longer exists', 404);
      const source = previous?.source ?? input.source;
      const note: AgentMemoryNote = { id: previous?.id ?? document.nextId++, scope, content: input.content.trim(),
        ...(source ? { source } : {}), updatedAt: new Date().toISOString() };
      document.memories = previous ? document.memories.map(item => item.id === previous.id ? note : item) : [...document.memories, note];
      return note;
    });
  };
  return { catalog, context, saveNote,
    async removeNote(id: number, revision?: number) {
      return mutate(revision, document => {
        if (!document.memories.some(note => note.id === id)) throw new AgentPersonalizationError('Memory no longer exists', 404);
        document.memories = document.memories.filter(note => note.id !== id);
        return { removed: true };
      });
    },
    async savePrompt(scopeInput: AgentMemoryScope, profile: AgentPromptProfile | null, revision: number) {
      const scope = parseAgentScope(scopeInput);
      if (scope.kind === 'session' && (await options.context(scope.id)).bot) throw new AgentPersonalizationError('Manage this Bot’s instructions in its own settings');
      if (profile !== null && (!profile || !profile.sections || typeof profile.sections !== 'object' || Array.isArray(profile.sections)
        || Object.entries(profile.sections).some(([key, value]) => !/^[a-z][a-z0-9_-]*$/.test(key)
          || key.startsWith('agent_memory_') || (value !== null && typeof value !== 'string')))) {
        throw new AgentPersonalizationError('Invalid system prompt sections');
      }
      return mutate(revision, document => {
        if (profile === null) delete document.prompts[agentScopeKey(scope)];
        else document.prompts[agentScopeKey(scope)] = structuredClone(profile);
        return profile;
      });
    },
  };
}
export type AgentPersonalization = ReturnType<typeof createAgentPersonalization>;
