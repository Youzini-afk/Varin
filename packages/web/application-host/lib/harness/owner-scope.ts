import { createHash } from "node:crypto";

/**
 * HR0 owner scopes. Durable owners (thread catalogs, session bindings,
 * knowledge stores) are addressed by scope id, not by directory: a project
 * workspace keeps its `workspaceId`; records owned by a session itself use
 * `session:<sessionId>`. Storage internals may partition by scope id, but
 * owner resolution never requires a directory to exist.
 */
export const SESSION_SCOPE_PREFIX = "session:";

export const sessionScopeId = (sessionId: string): string => `${SESSION_SCOPE_PREFIX}${sessionId}`;

export const isSessionScopeId = (value: unknown): value is string => (
  typeof value === "string" && value.startsWith(SESSION_SCOPE_PREFIX)
);

export const sessionIdFromScopeId = (scopeId: string): string => scopeId.slice(SESSION_SCOPE_PREFIX.length);

/**
 * Filename-safe store key for a scope id. Workspace ids are already UUIDs;
 * session scope keys hash the session id so `session:` never reaches a
 * filesystem path.
 */
export const knowledgeStoreKeyForScope = (scopeId: string): string => (
  isSessionScopeId(scopeId)
    ? `session-${createHash("sha256").update(sessionIdFromScopeId(scopeId)).digest("hex").slice(0, 32)}`
    : scopeId
);
