/** Recall hints are a projection of original matters and conversation identities, never grants. */
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { MemoryRecallAssociation } from '../knowledge/vectors/index.js';

export interface BotRecallWork { threadId?: string | undefined; branchId?: string | undefined; matterId?: string | undefined }
export interface BotRecallContext { query: string; associated: MemoryRecallAssociation; revision: string }

const mentions = (query: string, label: string): boolean => {
  const text = label.trim().toLowerCase();
  if (!text) return false;
  if (!/^[a-z0-9_].*[a-z0-9_]$|^[a-z0-9_]$/i.test(text)) return query.toLowerCase().includes(text);
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu').test(query);
};

export function createBotRecallContext(owners: {
  runtime: Pick<AgentRuntimeClient, 'thread' | 'botScope' | 'botMatters'>;
  projects(): Promise<Array<{ id: string; path: string; label?: string }>>;
}) {
  return async (input: { threadId: string; query: string; work?: readonly BotRecallWork[]; signal?: AbortSignal }): Promise<BotRecallContext> => {
    const thread = await owners.runtime.thread(input.threadId, input.signal);
    if (!thread.bot_id) return { query: input.query, associated: {}, revision: '' };
    const [scope, matters, projects] = await Promise.all([
      owners.runtime.botScope(thread.bot_id, input.signal, true),
      owners.runtime.botMatters(thread.bot_id, input.signal), owners.projects(),
    ]);
    input.signal?.throwIfAborted();
    const active = matters.filter(matter => !matter.archived);
    const byId = new Map(scope.threads.map(row => [row.thread_id, row]));
    // The entry conversation is not an association with every task it has ever launched.
    const seeds = new Set<string>([input.threadId]);
    for (const work of input.work ?? []) if (work.threadId) seeds.add(work.threadId);
    const related = active.filter(matter => input.work?.some(work => work.matterId === matter.id)
      || matter.threads.some(link => seeds.has(link.threadId))
      || input.query.includes(`[matter ${matter.id}]`) || mentions(input.query, matter.title))
      .sort((left, right) => left.id.localeCompare(right.id));
    // Entry history spans many matters. Search it normally instead of pinning
    // every memory ever produced in the assistant's main conversation.
    const associated = new Set<string>();
    for (const id of seeds) if (byId.get(id)?.parent_thread_id) associated.add(id);
    for (const matter of related) for (const link of matter.threads) {
      // Reading/following a conversation and using its history for memory remain separate choices.
      if (link.memory || byId.has(link.threadId)) associated.add(link.threadId);
    }
    // Walk only selected work's descendants, using the already authorized metadata projection.
    const descendants = new Set([...associated].filter(id => byId.get(id)?.parent_thread_id));
    for (;;) {
      const before = descendants.size;
      for (const row of scope.threads) if (row.parent_thread_id && descendants.has(row.parent_thread_id)) descendants.add(row.thread_id);
      if (before === descendants.size) break;
    }
    for (const id of descendants) associated.add(id);
    const projectIds = new Set([...associated].flatMap(id => byId.get(id)?.observer_project_ids ?? []));
    const selectedProjects = projects.filter(project => projectIds.has(project.id)
      || input.query.includes(`[project ${project.id}]`) || mentions(input.query, project.path) || Boolean(project.label && mentions(input.query, project.label)))
      .map(project => ({ id: project.id, path: project.path, ...(project.label ? { label: project.label } : {}) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const hints = [
      ...related.map(matter => `[matter ${matter.id}] ${matter.title}\n${matter.description}`),
      ...selectedProjects.map(project => `[project ${project.id}] ${project.label || project.path}\n${project.path}`),
    ];
    const threadIds = [...associated].sort();
    return { query: [input.query, ...hints].filter(Boolean).join('\n\n'), associated: { threadIds },
      revision: JSON.stringify([threadIds, related.map(matter => [matter.id, matter.revision]), selectedProjects]) };
  };
}
