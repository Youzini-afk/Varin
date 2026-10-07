import type { ComputerActor } from '@varin/protocol';
import { isAttachedRootPurpose } from '@varin/protocol';
import { ThreadRegistryError, type ThreadRegistry } from '../harness/thread-registry.js';

/** Follows durable task relationships; no worker-supplied parent or UI selection is authority. */
export async function resolveComputerActor(registry: ThreadRegistry, sessionId: string): Promise<ComputerActor | null> {
  const binding = await registry.getSessionBinding(sessionId).catch(error => {
    if (error instanceof ThreadRegistryError && error.code === 'stale-binding') return null;
    throw error;
  });
  if (!binding) return null;
  const thread = await registry.getThreadById(binding.owningScopeId, binding.threadId);
  const run = await registry.getActiveRun(binding.owningScopeId, binding.threadId);
  if (!thread || !run || run.id !== binding.runId || run.outcome !== null) return null;
  let parent = thread;
  const visited = new Set<string>();
  let rootSessionId = sessionId;
  let rootRunId = run.id;
  for (;;) {
    if (visited.has(parent.id)) return null;
    visited.add(parent.id);
    if (isAttachedRootPurpose(parent.purpose)) {
      const root = await registry.getActiveRun(binding.owningScopeId, parent.id);
      rootSessionId = root?.sessionId ?? (parent.parent.kind === 'session' ? parent.parent.id : sessionId);
      rootRunId = root?.id ?? `idle:${parent.id}`;
      break;
    }
    if (parent.parent.kind === 'session') {
      rootSessionId = parent.parent.id;
      const ancestor = await registry.resolveSessionOwner(rootSessionId);
      if (!ancestor) { rootRunId = `idle:${rootSessionId}`; break; }
      const next = await registry.getThreadById(ancestor.owningScopeId, ancestor.threadId);
      if (!next || ancestor.owningScopeId !== binding.owningScopeId) return null;
      parent = next;
    } else {
      const next = await registry.getThreadById(binding.owningScopeId, parent.parent.id);
      if (!next) return null;
      parent = next;
    }
  }
  return { sessionId, runId: run.id, threadId: thread.id, scopeId: binding.owningScopeId, rootSessionId, rootRunId,
    label: sessionId === rootSessionId ? 'Main agent' : thread.brief.split(/\r?\n/u)[0]?.trim() || 'Worker',
    readOnly: thread.preset === 'retrieval' || thread.kind === 'discussion' && !isAttachedRootPurpose(thread.purpose) };
}
