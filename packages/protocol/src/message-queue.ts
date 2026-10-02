import type { HostMethodParams } from "./methods.js";

export function parseQueuedMessageUpdate(value: unknown): HostMethodParams<"agent.queue.update"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()
    || typeof input.id !== "string" || !input.id.trim()
    || typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0
    || (input.action !== "edit" && input.action !== "remove" && input.action !== "steer")
    || (input.action === "edit" ? typeof input.text !== "string" : input.text !== undefined)) return undefined;
  return {
    sessionId: input.sessionId, id: input.id, revision: input.revision, action: input.action,
    ...(input.action === "edit" ? { text: input.text as string } : {}),
  };
}
