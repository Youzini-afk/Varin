import type { HarnessServiceMap, MemoryItem, AgentMemoryNote, AgentMemoryScope } from '@varin/protocol';
import type { HarnessService } from './router.js';
import type { HarnessServiceHost } from './service-host.js';
import { HarnessServiceError } from './service-error.js';

type Method = 'memory.remember' | 'memory.get' | 'memory.search' | 'memory.correct' | 'memory.forget';
const item = (note: AgentMemoryNote): MemoryItem => ({ id: note.id, content: note.content, trigger: '', status: 'accepted',
  scope: note.scope.kind === 'global' ? 'user' : note.scope.kind === 'project' ? 'workspace' : 'session',
  createdAt: Date.parse(note.updatedAt), recallCount: 0,
  ...(note.source ? { source: { kind: note.source.label, ...(note.source.sessionId ? { sessionId: note.source.sessionId } : {}) } } : {}),
});
/** Ordinary notes are always present in context; only Bot calls use the recall store. */
export function withAgentMemory<M extends Method>(host: HarnessServiceHost, method: M, botService: HarnessService<M>): HarnessService<M> {
  return { ...botService, handle: async (params, ctx) => {
    const service = host.agentPersonalization;
    if (!service) return botService.handle(params, ctx);
    const context = await service.context(ctx.sessionId);
    if (context.mode === 'bot') return botService.handle(params, ctx);
    const input = params as { id?: number; scope?: string; content?: string; query?: string; k?: number };
    const scope = (): AgentMemoryScope => {
      if (input.scope === 'user') return { kind: 'global' };
      if (input.scope === 'workspace') {
        if (!context.projectId) throw new HarnessServiceError('unavailable', 'This conversation has no project');
        return { kind: 'project', id: context.projectId };
      }
      if (input.scope !== undefined && input.scope !== 'session') throw new HarnessServiceError('invalid-params', 'Unknown assistant memory scope');
      return { kind: 'session', id: ctx.sessionId };
    };
    const notes = input.scope === undefined ? context.memories : context.memories.filter(note => JSON.stringify(note.scope) === JSON.stringify(scope()));
    const found = notes.find(note => note.id === input.id);
    let result: unknown;
    switch (method) {
      case 'memory.remember': {
        const target = scope();
        const duplicate = notes.find(note => note.content === input.content?.trim() && JSON.stringify(note.scope) === JSON.stringify(target));
        if (duplicate) result = { created: false, duplicate: true, item: item(duplicate) };
        else {
          const saved = await service.saveNote({ scope: target, content: input.content ?? '', source: { label: 'agent', sessionId: ctx.sessionId } });
          result = { created: true, item: item(saved.result) };
        }
        break;
      }
      case 'memory.search': {
        const query = input.query?.trim().toLowerCase();
        if (!query) throw new HarnessServiceError('invalid-params', 'A search query is required');
        result = { results: notes.filter(note => note.content.toLowerCase().includes(query)).slice(0, input.k ?? 8)
          .map(note => ({ item: item(note), score: 1 })) };
        break;
      }
      case 'memory.get': result = { item: found ? item(found) : null, chain: found ? [item(found)] : [] }; break;
      case 'memory.correct': {
        if (!found) throw new HarnessServiceError('not-found', 'Memory is not in this conversation’s scopes');
        const saved = await service.saveNote({ id: found.id, scope: found.scope, content: input.content ?? '' });
        result = { corrected: true, id: saved.result.id };
        break;
      }
      case 'memory.forget':
        if (!found) throw new HarnessServiceError('not-found', 'Memory is not in this conversation’s scopes');
        await service.removeNote(found.id);
        result = { forgotten: true };
        break;
    }
    return result as HarnessServiceMap[M]['result'];
  } };
}
