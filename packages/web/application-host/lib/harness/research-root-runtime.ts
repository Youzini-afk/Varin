import type {
  SessionEntriesResult,
  SessionSnapshot,
  SessionStats,
} from "@varin/protocol";
import { createAttachedRootRuntime } from "./attached-root-runtime.js";
import type { ThreadRegistry } from "./thread-registry.js";

export interface ResearchRootRuntimeOptions {
  registry: ThreadRegistry;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> | SessionSnapshot | null;
  sessions: {
    entries(sessionId: string, scope?: "branch" | "all"): Promise<SessionEntriesResult>;
    snapshot(sessionId: string): Promise<SessionSnapshot>;
    stats(sessionId: string): Promise<SessionStats>;
  };
  onError?(error: unknown): void;
  rejectHarnessRequest?(sessionId: string, requestId: string, message: string): Promise<void>;
}

/**
 * The research root is the research-purpose specialization of the shared
 * attached-root lifecycle: a research work-focus session bound to a project
 * workspace attaches to a durable `research-root` Thread. The generic
 * attach/track/finish machinery lives in `attached-root-runtime.ts`.
 */
export function createResearchRootRuntime(options: ResearchRootRuntimeOptions) {
  return createAttachedRootRuntime({
    ...options,
    purpose: "research-root",
    resolveTarget: (_sessionId, snapshot) => {
      if (snapshot.workFocus?.active.id !== "research") return null;
      if (snapshot.workspace?.kind !== "workspace") return null;
      return {
        scopeId: snapshot.workspace.authorityId ?? snapshot.workspace.id,
        workFocus: "research",
        createdBy: "user",
      };
    },
  });
}

export type ResearchRootRuntime = ReturnType<typeof createResearchRootRuntime>;
