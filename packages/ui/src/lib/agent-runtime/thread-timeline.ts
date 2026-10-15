import type { HistoryItem, OperationCallCompletion } from '@varin/protocol';

/** These fields belong to the public semantic history envelope, never to tool output data. */
export type HistorySemantic =
  | { kind: 'tool_call'; call: { call_id: string; name: string; arguments: unknown } }
  | { kind: 'tool_result'; result: { call_id: string; request_id: string; completion: OperationCallCompletion } }
  | { kind: 'text' | 'reasoning_summary' | 'media' | 'output' | 'provider_only' };

export function historySemantic(item: HistoryItem): HistorySemantic | undefined {
  if (item.source === 'user' || !item.content || typeof item.content !== 'object') return undefined;
  return (item.content as { content?: HistorySemantic }).content;
}

export interface TimelineEntry { item: HistoryItem; result?: HistoryItem }

/** A model step closes its calls before the next step. Match only preceding calls in
 * the same Run; a paged-in result without its call remains visible on its own. */
export function projectTimeline(history: readonly HistoryItem[]): TimelineEntry[] {
  const rows: TimelineEntry[] = [];
  const pending = new Map<string, TimelineEntry>();
  for (const item of history) {
    const content = historySemantic(item);
    if (content?.kind === 'tool_result') {
      const key = JSON.stringify([item.run_id, content.result.call_id]);
      const call = pending.get(key);
      if (call) { call.result = item; pending.delete(key); continue; }
    }
    const row = { item };
    rows.push(row);
    if (content?.kind === 'tool_call') pending.set(JSON.stringify([item.run_id, content.call.call_id]), row);
  }
  return rows;
}
