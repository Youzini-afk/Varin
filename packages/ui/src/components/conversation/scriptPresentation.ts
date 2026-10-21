import type { OperationCallSummary } from '@varin/protocol';
import type { I18nKey } from '@/lib/i18n';
import type { ChatToolCall, ChatToolExecutionState } from './types';

export const scriptArguments = (call: ChatToolCall): Record<string, unknown> =>
  call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {};
export function scriptOperationId(call: ChatToolCall, execution?: ChatToolExecutionState): string | undefined {
  if (execution?.operationId) return execution.operationId;
  try {
    const value: unknown = JSON.parse(call.id);
    if (Array.isArray(value) && value.length === 3 && typeof value[1] === 'string' && typeof value[2] === 'string') return `${value[1]}:tool:${value[2]}`;
  } catch { /* Preview-only calls have no durable owner. */ }
  return undefined;
}
export const scriptToolLabels: Partial<Record<string, I18nKey>> = {
  script_open: 'chat.script.open', script_run: 'chat.script.run', script_close: 'chat.script.close',
  file_read: 'chat.script.read', file_search: 'chat.script.search', file_list: 'chat.script.list',
  code_retrieval: 'chat.script.search', file_write: 'chat.script.edit', file_edit: 'chat.script.edit',
  process_spawn: 'chat.script.command',
};
export function scriptTitleKey(call: ChatToolCall, calls: readonly OperationCallSummary[]): I18nKey {
  if (call.name !== 'script_run') return scriptToolLabels[call.name] ?? 'chat.script.run';
  const labels = new Set(calls.map(item => scriptToolLabels[item.name]));
  if (labels.size === 1 && !labels.has(undefined)) return [...labels][0]!;
  if (labels.size === 2 && labels.has('chat.script.read') && labels.has('chat.script.search')) return 'chat.script.readSearch';
  return 'chat.script.run';
}
export function scriptCallStatus(call: OperationCallSummary): ChatToolExecutionState['status'] {
  return call.phase !== 'terminal' ? 'running' : call.outcome === 'failed' ? 'error'
    : call.outcome === 'cancelled' ? 'cancelled' : call.outcome === 'succeeded' ? 'success' : 'unknown';
}
export function orderScriptCalls(calls: readonly OperationCallSummary[]): OperationCallSummary[] {
  const ids = new Set(calls.map(call => call.operationId));
  const children = new Map<string, OperationCallSummary[]>();
  for (const call of calls) {
    const siblings = children.get(call.parentOperationId) ?? [];
    siblings.push(call); children.set(call.parentOperationId, siblings);
  }
  const result: OperationCallSummary[] = []; const visited = new Set<string>();
  const visit = (call: OperationCallSummary) => {
    if (visited.has(call.operationId)) return;
    visited.add(call.operationId); result.push(call);
    for (const child of children.get(call.operationId) ?? []) visit(child);
  };
  for (const call of calls) if (!ids.has(call.parentOperationId)) visit(call);
  for (const call of calls) visit(call);
  return result;
}
export function scriptDescendants(root: string, executions: Record<string, ChatToolExecutionState>) {
  const selected = new Set([root]); const children: ChatToolExecutionState[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of Object.values(executions)) if (item.parentToolCallId && selected.has(item.parentToolCallId) && !selected.has(item.toolCallId)) {
      selected.add(item.toolCallId); children.push(item); changed = true;
    }
  }
  return children;
}
