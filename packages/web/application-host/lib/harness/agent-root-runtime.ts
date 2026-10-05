import { createAttachedRootRuntime } from "./attached-root-runtime.js";
import type { ResearchRootRuntimeOptions } from "./research-root-runtime.js";
import { sessionScopeId } from "./owner-scope.js";

/** Normal user conversations share the existing attached Thread/Run authority. */
export function createAgentRootRuntime(options: ResearchRootRuntimeOptions) {
  return createAttachedRootRuntime({ ...options, purpose: "agent-root", resolveTarget: (sessionId, snapshot) => {
    if (snapshot.workFocus?.active.id === "research") return null;
    return { scopeId: snapshot.workspace?.kind === "workspace" ? snapshot.workspace.authorityId?.trim() || snapshot.workspace.id?.trim() || sessionScopeId(sessionId) : sessionScopeId(sessionId),
      workFocus: "code", createdBy: "user" };
  } });
}
