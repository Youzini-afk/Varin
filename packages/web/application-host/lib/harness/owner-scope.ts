import { createHash } from "node:crypto";

/** Knowledge owners are workspace, user, native Thread, or Bot identities. */
export const THREAD_SCOPE_PREFIX = "thread:";
export const threadScopeId = (threadId: string): string => `${THREAD_SCOPE_PREFIX}${threadId}`;
export const isThreadScopeId = (value: unknown): value is string => typeof value === 'string' && value.startsWith(THREAD_SCOPE_PREFIX);
export const threadIdFromScopeId = (scopeId: string): string => scopeId.slice(THREAD_SCOPE_PREFIX.length);
export const BOT_SCOPE_PREFIX = "bot:";

export const botScopeId = (botId: string): string => `${BOT_SCOPE_PREFIX}${botId}`;

export const isBotScopeId = (value: unknown): value is string => (
  typeof value === "string" && value.startsWith(BOT_SCOPE_PREFIX)
);

export const botIdFromScopeId = (scopeId: string): string => scopeId.slice(BOT_SCOPE_PREFIX.length);

/**
 * Filename-safe store key for a scope id. Workspace ids are already UUIDs;
 * Thread and Bot scope keys hash the owner id so `thread:`/`bot:` never
 * reaches a filesystem path.
 */
export const knowledgeStoreKeyForScope = (scopeId: string): string => {
  if (isThreadScopeId(scopeId)) return `thread-${createHash('sha256').update(threadIdFromScopeId(scopeId)).digest('hex').slice(0, 32)}`;
  if (isBotScopeId(scopeId)) {
    return `bot-${createHash("sha256").update(botIdFromScopeId(scopeId)).digest("hex").slice(0, 32)}`;
  }
  return scopeId;
};

/** Thread-owned stores are never resource roots. */
export const isThreadStoreKey = (value: unknown): value is string => typeof value === 'string' && /^thread-[0-9a-f]{32}$/.test(value);

/** True for the hashed filename-safe form — bot store keys are not resource roots. */
export const isBotStoreKey = (value: unknown): value is string => (
  typeof value === "string" && /^bot-[0-9a-f]{32}$/.test(value)
);

/** The KnowledgeScope an owning scope id addresses: bot:/thread: prefixes, `user`, else a workspace. */
export const scopeOfScopeId = (scopeId: string): "workspace" | "user" | "session" | "bot" => (
  isBotScopeId(scopeId) ? "bot" : isThreadScopeId(scopeId) ? "session" : scopeId === "user" ? "user" : "workspace"
);
