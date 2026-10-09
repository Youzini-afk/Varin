import { createHash, randomUUID } from 'node:crypto';
import { agentScopeKey, type AgentMemoryScope, type AgentMemoryNote, type AgentPersonalizationCatalog,
  type AgentPersonalizationContext, type AgentPromptProfile } from '@varin/protocol';
import type { KernelClient, KernelScopedClient } from '../kernel/kernel-client.js';

const WORKSPACE = '__varin_agent_personalization__';
const RECORD = 'agent.personalization';
export interface AgentNoteReceipt {
  origin: string;
  revision: number;
  changes: Array<{ id: number; scope: AgentMemoryScope; note: AgentMemoryNote | null }>;
}
interface MutationReceipt { intent: string; result: unknown; receipt: AgentNoteReceipt }
// A single current document, not a growing receipt log. Older mutations remain in the
// existing Rust operation owner; its atomic put result contains that mutation's receipt.
type Document = Omit<AgentPersonalizationCatalog, 'revision'> & {
  nextId: number;
  noteRevisions?: Record<string, number>;
  lastMutation?: MutationReceipt;
};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
});
const operationId = (origin: string) => `agent-personalization:${createHash('sha256').update(origin).digest('hex')}`;
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
  const read = async () => {
    const record = await (await client()).getRecord(WORKSPACE, RECORD);
    if (!record) return { document: { memories: [], prompts: {}, nextId: 1 } as Document, revision: 0 };
    const document = JSON.parse(record.payloadJson) as Document;
    if (!Array.isArray(document.memories) || !document.prompts || !Number.isSafeInteger(document.nextId)
      || (document.noteRevisions !== undefined && (!document.noteRevisions || typeof document.noteRevisions !== 'object'
        || Object.values(document.noteRevisions).some(value => !Number.isSafeInteger(value) || value < 1)))) {
      throw new Error('Agent personalization is malformed');
    }
    return { document, revision: record.recordRevision };
  };
  const findMutation = async (origin: string, intent?: unknown): Promise<MutationReceipt | null> => {
    const operation = await (await client()).getOperation(operationId(origin));
    if (!operation) return null;
    if (operation.kind === 'storage.record.put' && operation.state === 'failed') {
      throw new AgentPersonalizationError('Memory mutation was rejected; reload before retrying with a new invocation', 409);
    }
    if (operation.kind !== 'storage.record.put' || operation.state !== 'committed') {
      throw new AgentPersonalizationError('Memory mutation outcome is not confirmed', 503);
    }
    const result = operation.result as { recordId?: string; workspaceId?: string; payloadJson?: string; recordRevision?: number } | undefined;
    if (result?.recordId !== RECORD || result.workspaceId !== WORKSPACE || typeof result.payloadJson !== 'string') {
      throw new Error('Memory operation belongs to another record');
    }
    const document = JSON.parse(result.payloadJson) as Document;
    const mutation = document.lastMutation;
    if (!mutation || mutation.receipt.origin !== origin || mutation.receipt.revision !== result.recordRevision) {
      throw new Error('Memory operation has no matching atomic receipt');
    }
    if (intent !== undefined && mutation.intent !== canonical(intent)) throw new AgentPersonalizationError('Memory mutation origin has different input', 409);
    return structuredClone(mutation);
  };
  let tail: Promise<unknown> = Promise.resolve();
  const mutate = <T>(expected: number | undefined, edit: (document: Document) => T,
    identity?: { origin: string; intent: unknown }) => {
    const origin = identity?.origin ?? `ui:${randomUUID()}`;
    const intent = identity?.intent ?? { origin };
    const task = tail.catch(() => undefined).then(async () => {
      const previous = await findMutation(origin, intent);
      if (previous) return { result: previous.result as T, revision: previous.receipt.revision, receipt: previous.receipt };
      const current = await read();
      if (expected !== undefined && expected !== current.revision) throw new AgentPersonalizationError('Content changed; reload before saving', 409);
      const document = structuredClone(current.document);
      const result = edit(document);
      const revision = current.revision + 1;
      const changes: AgentNoteReceipt['changes'] = [];
      const ids = new Set([...current.document.memories, ...document.memories].map(note => note.id));
      for (const id of ids) {
        const before = current.document.memories.find(note => note.id === id);
        const after = document.memories.find(note => note.id === id);
        if (canonical(before) === canonical(after)) continue;
        document.noteRevisions ??= {};
        document.noteRevisions[String(id)] = revision;
        if (before && (!after || agentScopeKey(before.scope) !== agentScopeKey(after.scope))) changes.push({ id, scope: before.scope, note: null });
        if (after) changes.push({ id, scope: after.scope, note: after });
      }
      const receipt: AgentNoteReceipt = { origin, revision, changes };
      document.lastMutation = { intent: canonical(intent), result, receipt };
      try {
        const record = await (await client()).putRecord({ operationId: operationId(origin),
          workspaceId: WORKSPACE, recordId: RECORD, recordType: RECORD, state: 'active',
          payloadJson: JSON.stringify(document), ownerIds: [], references: [],
          ...(current.revision ? { expectedRecordRevision: current.revision } : {}),
        });
        if (record.recordRevision !== revision) throw new Error('Memory record committed an unexpected revision');
      } catch (error) {
        if (error instanceof Error && error.message.includes('record revision conflict')) {
          throw new AgentPersonalizationError('Content changed; reload before saving', 409);
        }
        // The record and its operation result commit in one Rust transaction. A dropped
        // transport reply is reconciled by reading that exact origin, never by writing again.
        const committed = await findMutation(origin, intent);
        if (!committed) throw error;
        options.onChanged?.();
        return { result: committed.result as T, revision: committed.receipt.revision, receipt: committed.receipt };
      }
      options.onChanged?.();
      return { result: structuredClone(result), revision, receipt: structuredClone(receipt) };
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
  const saveNote = async (input: { id?: number; scope: AgentMemoryScope; content: string; source?: AgentMemoryNote['source']; revision?: number }, identity?: { origin: string; intent: unknown; native: true }) => {
    const scope = parseAgentScope(input.scope);
    if (!identity && scope.kind === 'session' && (await options.context(scope.id)).bot) throw new AgentPersonalizationError('Manage this Bot’s memory in its own settings');
    if (typeof input.content !== 'string' || !input.content.trim()) throw new AgentPersonalizationError('Memory content is required');
    return mutate(input.revision, document => {
      const previous = input.id === undefined ? undefined : document.memories.find(note => note.id === input.id);
      if (input.id !== undefined && !previous) throw new AgentPersonalizationError('Memory no longer exists', 404);
      const source = previous?.source ?? input.source;
      const note: AgentMemoryNote = { id: previous?.id ?? document.nextId++, scope, content: input.content.trim(),
        ...(source ? { source } : {}), updatedAt: new Date().toISOString() };
      document.memories = previous ? document.memories.map(item => item.id === previous.id ? note : item) : [...document.memories, note];
      return note;
    }, identity);
  };
  return { catalog, context, saveNote,
    async nativeState() {
      const { document, revision } = await read();
      return structuredClone({ catalog: { memories: document.memories, prompts: document.prompts, revision }, noteRevisions: document.noteRevisions ?? {} });
    },
    async mutationReceipt(origin: string, intent?: unknown) { return (await findMutation(origin, intent))?.receipt ?? null; },
    async nativeMutation(input: { origin: string; action: 'save' | 'delete'; id?: number; scope: AgentMemoryScope; content?: string; revision: number },
      admitted: { mode: 'agent' | 'bot'; sessionId: string; projectId: string | null }) {
      if (admitted.mode !== 'agent') throw new AgentPersonalizationError('Bot memory has its own owner');
      const scope = parseAgentScope(input.scope);
      const allowed = (candidate: AgentMemoryScope) => candidate.kind === 'global'
        || (candidate.kind === 'project' && candidate.id === admitted.projectId)
        || (candidate.kind === 'session' && candidate.id === admitted.sessionId);
      if (!allowed(scope)) throw new AgentPersonalizationError('Memory scope is outside this conversation', 403);
      if (!input.origin || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new AgentPersonalizationError('Stable mutation origin and revision are required');
      const intent = { ...input, scope, admitted };
      const previous = await findMutation(input.origin, intent);
      if (previous) return previous.receipt;
      const current = await read();
      const note = input.id === undefined ? undefined : current.document.memories.find(item => item.id === input.id);
      if (input.action === 'delete' && note && agentScopeKey(note.scope) !== agentScopeKey(scope)) throw new AgentPersonalizationError('Memory does not belong to the selected scope', 403);
      if (input.id !== undefined && (!note || !allowed(note.scope))) throw new AgentPersonalizationError('Memory is unavailable in this conversation', 404);
      const identity = { origin: input.origin, intent, native: true as const };
      if (input.action === 'save') return (await saveNote({ ...(input.id === undefined ? {} : { id: input.id }), scope, content: input.content ?? '', revision: input.revision,
        source: { sessionId: admitted.sessionId, label: 'agent' } }, identity)).receipt;
      return (await mutate(input.revision, document => {
        if (input.id === undefined || !document.memories.some(item => item.id === input.id)) throw new AgentPersonalizationError('Memory no longer exists', 404);
        document.memories = document.memories.filter(item => item.id !== input.id);
        return { removed: true };
      }, identity)).receipt;
    },
    async removeNote(id: number, revision?: number) {
      const existing = (await read()).document.memories.find(note => note.id === id);
      if (existing?.scope.kind === 'session' && (await options.context(existing.scope.id)).bot) throw new AgentPersonalizationError('Manage this Bot’s memory in its own settings');
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
