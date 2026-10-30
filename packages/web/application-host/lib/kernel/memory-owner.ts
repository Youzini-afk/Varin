import { agentScopeKey, type AgentMemoryScope } from '@varin/protocol';
import type { ContextCheckpoint } from '@varin/application-client';
import { AgentPersonalizationError, type AgentPersonalization } from '../memory/agent-personalization.js';
import type { ContextPreparer } from './thread-context.js';

export interface MemoryQuery {
  action: 'synchronize' | 'tool' | 'receipt';
  runId: string;
  scope: { mode: 'agent' | 'bot'; threadId: string; projectId: string | null; botId?: string | null; branchId?: string; threadRole?: string };
  previousState?: unknown;
  origin?: string;
  arguments?: {
    action: 'read' | 'search' | 'save' | 'delete' | 'get' | 'recall' | 'remember' | 'correct' | 'forget' | 'archive';
    scope?: 'global' | 'project' | 'currentThread' | 'bot' | 'user' | 'session';
    id?: number; content?: string; query?: string; revision?: number; k?: number;
    trigger?: string; nature?: string; sourceText?: string; sourceItemId?: string; includeSource?: boolean;
    sources?: Array<{ itemId: string; quote: string }>;
    derivedFrom?: Array<{ id: number; revision: string }>;
    expected?: import('../knowledge/store.js').KnowledgeExpectedRevision;
  };
  checkpoint?: ContextCheckpoint;
}
export type MemoryResult = { status: 'ready'; [key: string]: unknown } | { status: 'rejected' | 'unknown'; message: string; mutationNotStarted?: true };
export type MemoryToolOwner = (query: MemoryQuery, signal: AbortSignal) => Promise<MemoryResult>;
/** Called only by the private bridge with Rust-resolved admission identity. */
export function createMemoryOwner(options: { personalization: AgentPersonalization; prepareContext: ContextPreparer; bot?: MemoryToolOwner }): MemoryToolOwner {
  return async (query, signal) => {
    try {
      if (query.scope.botId) {
        if (!options.bot) throw new AgentPersonalizationError('Bot memory owner is unavailable');
        return options.bot(query, signal);
      }
      if (query.action !== 'receipt') signal.throwIfAborted();
      const admitted = query.scope;
      if (!admitted || !['agent', 'bot'].includes(admitted.mode) || !admitted.threadId
        || (admitted.projectId !== null && (typeof admitted.projectId !== 'string' || !admitted.projectId))) throw new AgentPersonalizationError('Invalid admitted memory scope');
      if (admitted.mode === 'bot') throw new AgentPersonalizationError('Bot memory requires its original Catalog binding');
      const allowed = (scope: AgentMemoryScope) => scope.kind === 'global' || (scope.kind === 'thread' && scope.id === admitted.threadId)
        || (scope.kind === 'project' && scope.id === admitted.projectId);
      if (query.action === 'synchronize') {
        const checkpoint = query.checkpoint;
        if (!checkpoint?.personalization || !options.prepareContext.refresh
          || checkpoint.personalization.threadId !== admitted.threadId || checkpoint.personalization.projectId !== admitted.projectId
          || checkpoint.personalization.mode !== admitted.mode) throw new AgentPersonalizationError('Context does not identify the admitted memory owner');
        const context = await options.prepareContext.refresh(checkpoint, signal);
        const state = await options.personalization.runtimeState();
        signal.throwIfAborted();
        return { status: 'ready', context, state: { revision: state.catalog.revision,
          memories: state.catalog.memories.filter(note => allowed(note.scope)),
          noteRevisions: state.noteRevisions } };
      }
      if (admitted.mode !== 'agent') throw new AgentPersonalizationError('Bot memory has its own owner');
      const args = query.arguments as { action: 'read' | 'search' | 'save' | 'delete'; scope?: 'global' | 'project' | 'currentThread'; id?: number; content?: string; query?: string; revision?: number } | undefined;
      if (!args) throw new AgentPersonalizationError('Memory arguments are required');
      const scope: AgentMemoryScope = args.scope === 'global' ? { kind: 'global' }
        : args.scope === 'project' ? admitted.projectId ? { kind: 'project', id: admitted.projectId }
          : (() => { throw new AgentPersonalizationError('This conversation has no project'); })()
          : { kind: 'thread', id: admitted.threadId };
      if (args.action === 'read' || args.action === 'search') {
        if (query.action !== 'tool') throw new AgentPersonalizationError('Reads have no mutation receipt');
        const catalog = await options.personalization.catalog();
        const term = args.query?.toLocaleLowerCase() ?? '';
        return { status: 'ready', revision: catalog.revision, notes: catalog.memories.filter(note => allowed(note.scope)
          && (!args.scope || agentScopeKey(note.scope) === agentScopeKey(scope))
          && (args.id === undefined || args.id === note.id) && (args.action !== 'search' || note.content.toLocaleLowerCase().includes(term))) };
      }
      if (!query.origin || (args.revision !== undefined && !Number.isSafeInteger(args.revision))
        || ((args.action === 'delete' || args.id !== undefined) && args.revision === undefined))
        throw new AgentPersonalizationError('Updating or deleting a note requires its current revision');
      const input = { origin: query.origin, action: args.action, ...(args.id === undefined ? {} : { id: args.id }), scope,
        ...(args.content === undefined ? {} : { content: args.content }), ...(args.revision === undefined ? {} : { revision: args.revision }) };
      const memoryReceipt = query.action === 'receipt'
        ? await options.personalization.mutationReceipt(query.origin, { ...input, admitted })
        : await options.personalization.mutation(input, admitted);
      return { status: 'ready', memoryReceipt };
    } catch (error) {
      return { status: error instanceof AgentPersonalizationError && error.status < 500 ? 'rejected' : 'unknown',
        message: error instanceof Error ? error.message : 'Memory owner could not confirm the result' };
    }
  };
}
