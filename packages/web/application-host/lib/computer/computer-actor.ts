import type { ComputerActor, ComputerExecutionRef, ComputerWorkRef, ComputerWorkScope } from '@varin/protocol';
import { isAttachedRootPurpose } from '@varin/protocol';
import type { ThreadRegistry } from '../harness/thread-registry.js';

export interface ComputerWorkResolution {
  scope: ComputerWorkScope;
  actor: ComputerActor | null;
}

/** Registry is the Pi identity owner, including known work whose latest Run ended.
 * Native work is resolved independently by Catalog and never inserted into Registry. */
export async function resolvePiComputerWork(registry: ThreadRegistry, sessionId: string): Promise<ComputerWorkResolution | null> {
  const owner = await registry.resolveSessionOwner(sessionId);
  if (!owner) return null;
  const thread = await registry.getThreadById(owner.owningScopeId, owner.threadId);
  if (!thread) return null;
  const active = await registry.getActiveRun(owner.owningScopeId, thread.id);
  const work: ComputerWorkRef = { runtime: 'pi', sessionId };
  const execution: ComputerExecutionRef | null = active?.outcome === null && active.sessionId === sessionId
    ? { work, runId: active.id } : null;
  let parent = thread;
  const visited = new Set<string>();
  let rootWork = work;
  let rootExecution = execution;
  for (;;) {
    if (visited.has(parent.id)) throw new Error('computer_pi_family_cycle');
    visited.add(parent.id);
    if (isAttachedRootPurpose(parent.purpose)) {
      const root = await registry.getActiveRun(owner.owningScopeId, parent.id);
      const rootSessionId = root?.sessionId ?? (parent.parent.kind === 'session' ? parent.parent.id : undefined);
      if (!rootSessionId) throw new Error('computer_pi_root_identity_unavailable');
      rootWork = { runtime: 'pi', sessionId: rootSessionId };
      rootExecution = root?.outcome === null && root.sessionId === rootSessionId ? { work: rootWork, runId: root.id } : null;
      break;
    }
    if (parent.parent.kind === 'session') {
      rootWork = { runtime: 'pi', sessionId: parent.parent.id };
      const ancestor = await registry.resolveSessionOwner(parent.parent.id);
      if (!ancestor) { rootExecution = null; break; }
      const next = await registry.getThreadById(ancestor.owningScopeId, ancestor.threadId);
      if (!next || ancestor.owningScopeId !== owner.owningScopeId) throw new Error('computer_pi_family_unavailable');
      parent = next;
    } else {
      const next = await registry.getThreadById(owner.owningScopeId, parent.parent.id);
      if (!next) throw new Error('computer_pi_family_unavailable');
      parent = next;
    }
  }
  return {
    scope: { work, rootWork, currentExecution: execution, currentRootExecution: rootExecution },
    actor: execution ? { execution, rootWork, rootExecution,
      registry: { scopeId: owner.owningScopeId, threadId: thread.id },
      label: sessionId === rootWork.sessionId ? 'Main agent' : thread.brief.split(/\r?\n/u)[0]?.trim() || 'Worker',
      roleAccess: { kind: 'pi-role', readOnly: thread.preset === 'retrieval' || thread.kind === 'discussion' && !isAttachedRootPurpose(thread.purpose) } } : null,
  };
}
