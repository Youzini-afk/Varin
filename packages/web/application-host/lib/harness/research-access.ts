import { isAttachedRootPurpose, type Thread, type ThreadParent } from "@varin/protocol";
import type { ExperimentCaller } from "./experiments.js";
import type { ThreadRegistry } from "./thread-registry.js";
import { HarnessServiceError } from "./service-error.js";

type ResearchRegistry = Pick<ThreadRegistry, "getSessionBinding" | "getThreadById" | "listThreads">;

/** Derive research access from the same durable relationships as thread messaging. */
export async function resolveResearchCaller(
  registry: ResearchRegistry,
  input: {
    sessionId: string;
    workspaceId: string;
    executionWorkspaceId?: string;
    workspaceScope?: readonly string[];
    user?: boolean;
  },
): Promise<ExperimentCaller> {
  const binding = await registry.getSessionBinding(input.sessionId);
  const workspaceId = binding?.owningScopeId ?? input.workspaceId;
  const visible = new Map<string, Thread>();
  let rootSessionId = input.sessionId;
  const children = (parent: ThreadParent) => registry.listThreads(workspaceId, parent);
  const include = (thread: Thread) => { visible.set(thread.id, thread); };
  const descendants = async (thread: Thread): Promise<void> => {
    if (visible.has(thread.id)) return;
    include(thread);
    for (const child of await children({ kind: "thread", id: thread.id })) await descendants(child);
  };
  if (binding) {
    const owner = await registry.getThreadById(workspaceId, binding.threadId);
    if (!owner) throw new HarnessServiceError("denied", "Research caller has no owning Thread");
    let ancestor = owner;
    const seen = new Set<string>();
    while (ancestor.parent.kind === "thread") {
      if (seen.has(ancestor.id)) throw new HarnessServiceError("denied", "Research ancestry is cyclic");
      seen.add(ancestor.id);
      const parent = await registry.getThreadById(workspaceId, ancestor.parent.id);
      if (!parent) throw new HarnessServiceError("denied", "Research ancestry is unavailable");
      ancestor = parent;
    }
    rootSessionId = ancestor.parent.id;
    if (input.user && rootSessionId === input.sessionId) {
      for (const child of await children({ kind: "session", id: rootSessionId })) await descendants(child);
    } else {
      include(owner);
      for (const child of await children({ kind: "thread", id: owner.id })) include(child);
      for (const sibling of await children(owner.parent)) include(sibling);
      if (owner.parent.kind === "thread") {
        const parent = await registry.getThreadById(workspaceId, owner.parent.id);
        if (parent) include(parent);
      }
    }
  } else {
    for (const thread of await children({ kind: "session", id: input.sessionId })) {
      if (input.user && isAttachedRootPurpose(thread.purpose)) await descendants(thread);
      else include(thread);
    }
  }
  return {
    workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? input.workspaceId,
    sessionId: input.sessionId,
    rootSessionId,
    allowedThreadIds: [...visible.keys()],
    ...(binding ? { threadId: binding.threadId, runId: binding.runId } : {}),
    ...(input.workspaceScope ? { workspaceScope: input.workspaceScope } : {}),
  };
}
