import type { HarnessKnowledgeScope } from './harnessKnowledgePresentation';

/**
 * An explicit user "remember" commits immediately through the unified memory
 * service (BC1). `scope: "user"` writes the user store; omitting it writes the
 * session's owning scope (Bot memory for Bot entry chats, workspace memory for
 * bound sessions).
 */
export const knowledgeRememberEndpoint = (sessionId: string): string => (
  `/api/harness/sessions/${encodeURIComponent(sessionId)}/knowledge/remember`
);

export const knowledgeRememberPayload = (
  scope: HarnessKnowledgeScope,
  content: string,
  kind: string,
): Record<string, string> => ({
  content,
  // Provenance of the marked material (e.g. "tool-result:bash", "message:user").
  ...(kind ? { kind } : {}),
  ...(scope === 'user' ? { scope: 'user' } : {}),
});
