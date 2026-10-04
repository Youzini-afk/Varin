import { getCurrentSystemPrompt, normalizeContext, type Context } from "@earendil-works/pi-ai";

export function providerSystemPrompt(context: Context | undefined): string {
  return context ? getCurrentSystemPrompt(normalizeContext(context).messages) : "";
}

type ProviderMessage = Context["messages"][number];

export function providerMessageText(message: ProviderMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function serializedToolResult(context: Context, toolName: string): string {
  const result = context.messages.findLast((message) => (
    message.role === "toolResult" && message.toolName === toolName
  ));
  if (!result) throw new Error(`Expected a ${toolName} tool result in the provider context`);
  return JSON.stringify(result);
}

function isTransientRequestObservation(message: ProviderMessage): boolean {
  if (message.role !== "user") return false;
  const text = providerMessageText(message).trimStart();
  return /<varin-status(?:\s|>)/u.test(text)
    || text.startsWith('<varin-context status="unavailable"');
}

/**
 * 7G appends request-scoped environment availability and the current roster
 * after durable history. Remove only that trailing request material when a
 * test needs to compare the persistent message prefix across provider calls.
 */
export function persistentProviderMessages(context: Context): ProviderMessage[] {
  let end = context.messages.length;
  while (end > 0 && isTransientRequestObservation(context.messages[end - 1]!)) end -= 1;
  return context.messages.slice(0, end);
}

export function providerRosterMessages(context: Context): ProviderMessage[] {
  return context.messages.filter((message) => (
    message.role === "user" && /<varin-status(?:\s|>)/u.test(providerMessageText(message))
  ));
}
