import type { ThreadIdentity, ThreadRememberInput, ThreadRememberReceipt, ThreadRememberScope } from '@varin/application-client';
import { agentScopeKey } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KnowledgeMutationError } from '../knowledge/store.js';
import type { MemoryOwner, MemoryService } from './memory-service.js';
import type { AgentPersonalization } from './agent-personalization.js';

/** Explicit composer saves use the same original note/knowledge writer as settings and tools. */
export function createThreadRemember(options: {
  runtime: Pick<AgentRuntimeClient, 'thread'>;
  memory: MemoryService;
  personalization: AgentPersonalization;
}) {
  const owner = async (identity: ThreadIdentity) => {
    if (identity?.runtime !== 'agent' || !identity.threadId || !identity.branchId) throw new KnowledgeMutationError('invalid', 'Choose a Thread and branch');
    const thread = await options.runtime.thread(identity.threadId);
    if (thread.deleted_at_ms != null || !thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new KnowledgeMutationError('not-found', 'The selected conversation is no longer available');
    return thread;
  };
  const memoryOwner = (destination: ThreadRememberInput['destination']): MemoryOwner => destination.kind === 'bot'
    ? { scope: 'bot', ownerId: destination.id } : { scope: 'user', ownerId: null };
  const scopes = async (identity: ThreadIdentity): Promise<ThreadRememberScope[]> => {
    const thread = await owner(identity);
    if (thread.bot_id) return Promise.all([{ kind: 'bot' as const, id: thread.bot_id }, { kind: 'user' as const }].map(async destination => ({ destination, revision: await options.memory.revision(memoryOwner(destination)) })));
    const context = await options.personalization.context(identity.threadId);
    if (context.mode !== 'agent') throw new KnowledgeMutationError('conflict', 'The conversation memory owner changed');
    return [{ kind: 'thread' as const, id: identity.threadId }, ...(context.projectId ? [{ kind: 'project' as const, id: context.projectId }] : []), { kind: 'global' as const }]
      .map(destination => ({ destination, revision: context.revision }));
  };
  const remember = async (input: ThreadRememberInput): Promise<ThreadRememberReceipt> => {
    const thread = await owner(input);
    if (typeof input.key !== 'string' || !input.key.trim() || typeof input.content !== 'string' || !input.content.trim()
      || input.trigger !== undefined && typeof input.trigger !== 'string' || !input.destination) throw new KnowledgeMutationError('invalid', 'A stable save key, destination and memory text are required');
    const destination = input.destination;
    const origin = `thread-remember:${JSON.stringify([input.threadId, input.branchId, input.key])}`;
    // Replays ask the original writer for its receipt before testing a stale displayed revision.
    if (thread.bot_id) {
      if (destination.kind !== 'user' && (destination.kind !== 'bot' || destination.id !== thread.bot_id)) throw new KnowledgeMutationError('conflict', 'The Bot memory destination changed');
      if (typeof input.revision !== 'string') throw new KnowledgeMutationError('invalid', 'Select the current memory revision');
      const result = await options.memory.remember(memoryOwner(destination), { content: input.content, ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
        expectedRevision: input.revision, source: { kind: 'user-extracted', threadId: input.threadId } },
      { id: origin, intent: JSON.stringify({ destination, revision: input.revision, content: input.content, trigger: input.trigger ?? '' }) });
      return { id: result.item.id, destination, content: result.item.content, created: result.created };
    }
    if (!['thread', 'project', 'global'].includes(destination.kind)) throw new KnowledgeMutationError('invalid', 'Choose an ordinary Agent note scope');
    const context = await options.personalization.context(input.threadId);
    if (context.mode !== 'agent' || typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision)) throw new KnowledgeMutationError('conflict', 'The conversation memory owner changed');
    const selected = (await scopes(input)).find(scope => agentScopeKey(scope.destination as import('@varin/protocol').AgentMemoryScope) === agentScopeKey(destination as import('@varin/protocol').AgentMemoryScope));
    if (!selected) throw new KnowledgeMutationError('invalid', 'The memory scope is outside this conversation');
    const result = await options.personalization.saveNote({ scope: destination as import('@varin/protocol').AgentMemoryScope,
      content: input.content, revision: input.revision, source: { label: 'user', threadId: input.threadId } },
    { origin, intent: { destination, revision: input.revision, content: input.content }, native: true });
    return { id: result.result.id, destination, content: result.result.content, created: true };
  };
  return { scopes, remember };
}
