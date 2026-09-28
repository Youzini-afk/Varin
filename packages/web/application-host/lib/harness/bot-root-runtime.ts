import type {
  SessionEntriesResult,
  SessionSnapshot,
  SessionStats,
} from "@varin/protocol";
import { createAttachedRootRuntime } from "./attached-root-runtime.js";
import { botScopeId } from "./owner-scope.js";
import type { ThreadRegistry } from "./thread-registry.js";

export interface BotRootRuntimeOptions {
  /**
   * Resolve which Bot identity this session is an entry chat for, or null
   * when the session is not a Bot entry. The Bot record — not the cwd,
   * work focus, or project directory — carries this association.
   */
  botForSession(sessionId: string): Promise<{ id: string } | null>;
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
 * The Bot root specialization of the shared attached-root lifecycle. A Bot's
 * entry session attaches to a durable `bot-root` Thread under the `bot:<id>`
 * owner scope, so the conversation's turns become ordinary Runs and work it
 * dispatches lands inside the Bot's scope regardless of project bindings.
 */
export function createBotRootRuntime(options: BotRootRuntimeOptions) {
  return createAttachedRootRuntime({
    ...options,
    purpose: "bot-root",
    resolveTarget: async (sessionId) => {
      const bot = await options.botForSession(sessionId);
      if (!bot) return null;
      return {
        scopeId: botScopeId(bot.id),
        workFocus: "code",
        createdBy: "agent",
      };
    },
  });
}

export type BotRootRuntime = ReturnType<typeof createBotRootRuntime>;
