import type { ThreadHistoryItem } from '@varin/application-client';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
/** Tool source comes from the call's frozen request, never a name prefix or current server list. */
export function contextMessageKinds(items: readonly ThreadHistoryItem[]): Map<string, string> {
  const kinds = new Map(items.map(item => [item.id, item.source as string]));
  const mcpCalls = new Set<string>();
  for (const item of items) {
    const call = record(record(record(item.content).content).call);
    const name = call.name === 'tool_invoke' ? record(record(call.arguments).reference).name : call.name;
    if (typeof name === 'string' && item.modelRequest?.mcpTools?.includes(name)) {
      kinds.set(item.id, 'mcp'); mcpCalls.add(JSON.stringify([item.run_id, item.modelRequest.requestId, call.call_id]));
    }
  }
  for (const item of items) {
    const result = record(record(record(item.content).content).result);
    if (typeof result.call_id === 'string' && mcpCalls.has(JSON.stringify([item.run_id, result.request_id, result.call_id]))) kinds.set(item.id, 'mcp');
  }
  return kinds;
}
