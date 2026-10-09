import type { AgentPersonalizationContext } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { AgentPersonalizationError } from './agent-personalization.js';

type Scope = { bot: boolean; projectId?: string; threadRole?: AgentPersonalizationContext['threadRole'] };
/** Runtime namespace chooses a lookup, never a role. Identity and scope must be
 * proven by persisted Thread/checkpoint ownership; failures never fall through to Pi. */
export function createPersonalizationContextResolver(options: {
  runtime(): Pick<AgentRuntimeClient, 'thread' | 'context'> | undefined;
  legacy(sessionId: string): Promise<Scope>;
}): (sessionId: string) => Promise<Scope> {
  return async sessionId => {
    if (!sessionId.startsWith('thread:')) return options.legacy(sessionId);
    const runtime = options.runtime();
    if (!runtime) throw new AgentPersonalizationError('Personalization owner is not ready', 503);
    const thread = await runtime.thread(sessionId);
    if (thread.thread_id !== sessionId) throw new AgentPersonalizationError('Thread ownership changed', 409);
    const checkpoints = await Promise.all(thread.branches.map(branch => runtime.context(branch.branch_id)));
    const bases = checkpoints.flatMap(checkpoint => checkpoint?.personalization ? [checkpoint.personalization] : []);
    const basis = bases[0];
    if (!basis) throw new AgentPersonalizationError('Thread has no admitted personalization scope', 409);
    if (basis.sessionId !== sessionId || !['agent', 'bot'].includes(basis.mode)
      || !['main', 'worker', 'read-only'].includes(basis.threadRole)
      || bases.some(candidate => candidate.sessionId !== sessionId || candidate.mode !== basis.mode
        || candidate.threadRole !== basis.threadRole || candidate.projectId !== basis.projectId)) {
      throw new AgentPersonalizationError('Personalization scope is inconsistent', 409);
    }
    return { bot: basis.mode === 'bot', threadRole: basis.threadRole as AgentPersonalizationContext['threadRole'],
      ...(basis.projectId ? { projectId: basis.projectId } : {}) };
  };
}
