import { createHash } from "node:crypto";

/**
 * HR0 owner scopes. Durable owners (thread catalogs, session bindings,
 * knowledge stores) are addressed by scope id, not by directory: a project
 * workspace keeps its `workspaceId`; records owned by a session itself use
 * `session:<sessionId>`. BC0 adds `bot:<botId>` — a long-lived Bot's records
 * and work Threads belong to its identity, not to whichever session happened
 * to act as its entry chat.
 */
export const SESSION_SCOPE_PREFIX = "session:";
export const BOT_SCOPE_PREFIX = "bot:";

export const sessionScopeId = (sessionId: string): string => `${SESSION_SCOPE_PREFIX}${sessionId}`;

export const isSessionScopeId = (value: unknown): value is string => (
  typeof value === "string" && value.startsWith(SESSION_SCOPE_PREFIX)
);

export const sessionIdFromScopeId = (scopeId: string): string => scopeId.slice(SESSION_SCOPE_PREFIX.length);

export const botScopeId = (botId: string): string => `${BOT_SCOPE_PREFIX}${botId}`;

export const isBotScopeId = (value: unknown): value is string => (
  typeof value === "string" && value.startsWith(BOT_SCOPE_PREFIX)
);

export const botIdFromScopeId = (scopeId: string): string => scopeId.slice(BOT_SCOPE_PREFIX.length);

/**
 * Filename-safe store key for a scope id. Workspace ids are already UUIDs;
 * session and bot scope keys hash the owner id so `session:`/`bot:` never
 * reaches a filesystem path.
 */
export const knowledgeStoreKeyForScope = (scopeId: string): string => {
  if (isSessionScopeId(scopeId)) {
    return `session-${createHash("sha256").update(sessionIdFromScopeId(scopeId)).digest("hex").slice(0, 32)}`;
  }
  if (isBotScopeId(scopeId)) {
    return `bot-${createHash("sha256").update(botIdFromScopeId(scopeId)).digest("hex").slice(0, 32)}`;
  }
  return scopeId;
};

/** True for the hashed filename-safe form — session store keys are not resource roots. */
export const isSessionStoreKey = (value: unknown): value is string => (
  typeof value === "string" && /^session-[0-9a-f]{32}$/.test(value)
);

/** True for the hashed filename-safe form — bot store keys are not resource roots. */
export const isBotStoreKey = (value: unknown): value is string => (
  typeof value === "string" && /^bot-[0-9a-f]{32}$/.test(value)
);
