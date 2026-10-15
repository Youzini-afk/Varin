import type { AgentPersonalizationContext } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { AgentPersonalizationError } from './agent-personalization.js';

type Scope = { bot: boolean; projectId?: string; threadRole?: AgentPersonalizationContext['threadRole'] };
/** Identity and scope are proven by persisted native Thread/checkpoint ownership. */
export function createPersonalizationContextResolver(options: {
  runtime(): Pick<AgentRuntimeClient, 'thread' | 'context'> | undefined;
}): (threadId: string) => Promise<Scope> {
  return async threadId => {
    if (!threadId.startsWith('thread:')) throw new AgentPersonalizationError('A native Thread identity is required', 400);
    const runtime = options.runtime();
    if (!runtime) throw new AgentPersonalizationError('Personalization owner is not ready', 503);
    const thread = await runtime.thread(threadId);
    if (thread.thread_id !== threadId) throw new AgentPersonalizationError('Thread ownership changed', 409);
    const checkpoints = await Promise.all(thread.branches.map(branch => runtime.context(branch.branch_id)));
    const bases = checkpoints.flatMap(checkpoint => checkpoint?.personalization ? [checkpoint.personalization] : []);
    const basis = bases[0];
    if (!basis) throw new AgentPersonalizationError('Thread has no admitted personalization scope', 409);
    if (basis.threadId !== threadId || !['agent', 'bot'].includes(basis.mode)
      || !['main', 'worker', 'read-only'].includes(basis.threadRole)
      || bases.some(candidate => candidate.threadId !== threadId || candidate.mode !== basis.mode
        || candidate.threadRole !== basis.threadRole || candidate.projectId !== basis.projectId)) {
      throw new AgentPersonalizationError('Personalization scope is inconsistent', 409);
    }
    return { bot: basis.mode === 'bot', threadRole: basis.threadRole as AgentPersonalizationContext['threadRole'],
      ...(basis.projectId ? { projectId: basis.projectId } : {}) };
  };
}
