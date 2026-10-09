import { agentScopeKey, type AgentMemoryScope } from '@varin/protocol';
import type { NativeContextCheckpoint } from '@varin/application-client';
import { AgentPersonalizationError, type AgentPersonalization } from '../memory/agent-personalization.js';
import type { NativeContextPreparer } from './native-thread-context.js';

export interface NativeMemoryQuery {
  action: 'synchronize' | 'tool' | 'receipt';
  runId: string;
  scope: { mode: 'agent' | 'bot'; sessionId: string; projectId: string | null };
  origin?: string;
  arguments?: { action: 'read' | 'search' | 'save' | 'delete'; scope?: 'global' | 'project' | 'currentThread'; id?: number; content?: string; query?: string; revision?: number };
  checkpoint?: NativeContextCheckpoint;
}
export type NativeMemoryResult = { status: 'ready'; [key: string]: unknown } | { status: 'rejected' | 'unknown'; message: string };
export type NativeMemoryOwner = (query: NativeMemoryQuery, signal: AbortSignal) => Promise<NativeMemoryResult>;
/** Called only by the private native bridge with Rust-resolved admission identity. */
export function createNativeMemoryOwner(options: { personalization: AgentPersonalization; prepareContext: NativeContextPreparer }): NativeMemoryOwner {
  return async (query, signal) => {
    try {
      signal.throwIfAborted();
      const admitted = query.scope;
      if (!admitted || !['agent', 'bot'].includes(admitted.mode) || !admitted.sessionId
        || (admitted.projectId !== null && (typeof admitted.projectId !== 'string' || !admitted.projectId))) throw new AgentPersonalizationError('Invalid admitted memory scope');
      const allowed = (scope: AgentMemoryScope) => scope.kind === 'global' || (scope.kind === 'session' && scope.id === admitted.sessionId)
        || (scope.kind === 'project' && scope.id === admitted.projectId);
      if (query.action === 'synchronize') {
        const checkpoint = query.checkpoint;
        if (!checkpoint?.personalization || !options.prepareContext.refresh
          || checkpoint.personalization.sessionId !== admitted.sessionId || checkpoint.personalization.projectId !== admitted.projectId
          || checkpoint.personalization.mode !== admitted.mode) throw new AgentPersonalizationError('Context does not identify the admitted memory owner');
        const context = await options.prepareContext.refresh(checkpoint);
        const state = await options.personalization.nativeState();
        signal.throwIfAborted();
        return { status: 'ready', context, state: { revision: state.catalog.revision,
          memories: admitted.mode === 'bot' ? [] : state.catalog.memories.filter(note => allowed(note.scope)),
          noteRevisions: admitted.mode === 'bot' ? {} : state.noteRevisions } };
      }
      if (admitted.mode !== 'agent') throw new AgentPersonalizationError('Bot memory has its own owner');
      const args = query.arguments;
      if (!args) throw new AgentPersonalizationError('Memory arguments are required');
      const scope: AgentMemoryScope = args.scope === 'global' ? { kind: 'global' }
        : args.scope === 'project' ? admitted.projectId ? { kind: 'project', id: admitted.projectId }
          : (() => { throw new AgentPersonalizationError('This conversation has no project'); })()
          : { kind: 'session', id: admitted.sessionId };
      if (args.action === 'read' || args.action === 'search') {
        if (query.action !== 'tool') throw new AgentPersonalizationError('Reads have no mutation receipt');
        const catalog = await options.personalization.catalog();
        const term = args.query?.toLocaleLowerCase() ?? '';
        return { status: 'ready', revision: catalog.revision, notes: catalog.memories.filter(note => allowed(note.scope)
          && (!args.scope || agentScopeKey(note.scope) === agentScopeKey(scope))
          && (args.id === undefined || args.id === note.id) && (args.action !== 'search' || note.content.toLocaleLowerCase().includes(term))) };
      }
      if (!query.origin || !Number.isSafeInteger(args.revision)) throw new AgentPersonalizationError('Memory mutation origin and current revision are required');
      const input = { origin: query.origin, action: args.action, ...(args.id === undefined ? {} : { id: args.id }), scope,
        ...(args.content === undefined ? {} : { content: args.content }), revision: args.revision! };
      const memoryReceipt = query.action === 'receipt'
        ? await options.personalization.mutationReceipt(query.origin, { ...input, admitted })
        : await options.personalization.nativeMutation(input, admitted);
      return { status: 'ready', memoryReceipt };
    } catch (error) {
      return { status: error instanceof AgentPersonalizationError && error.status < 500 ? 'rejected' : 'unknown',
        message: error instanceof Error ? error.message : 'Memory owner could not confirm the result' };
    }
  };
}
