import type { ChatToolCall, ChatToolExecutionState } from './types';
import { toolRecord } from './toolInvocation';

/** Existing collaboration, user input and usable output views stay independent. */
export const isStandaloneTool = (name: string) => ['dispatch', 'ask_user', 'render_ui', 'image_generate', 'image_edit'].includes(name);

/** Already observed descendants only. No extra reads to fill a heading. */
export function standaloneDescendants(executions: Record<string, ChatToolExecutionState> = {}): Map<string, ChatToolCall[]> {
  const groups = new Map<string, ChatToolCall[]>(), seen = new Set<string>();
  for (const execution of Object.values(executions)) {
    if (!isStandaloneTool(execution.name) || !execution.parentToolCallId
      || toolRecord(toolRecord(execution.operation?.intent).call).name === 'tool_invoke') continue;
    let root = execution.parentToolCallId;
    const visited = new Set([execution.toolCallId]);
    while (!visited.has(root) && executions[root]?.parentToolCallId) { visited.add(root); root = executions[root]!.parentToolCallId!; }
    const operation = execution.operationId ?? execution.toolCallId;
    if (visited.has(root) || seen.has(operation) || execution.operationId && executions[root]?.operationId === execution.operationId) continue;
    seen.add(operation);
    const calls = groups.get(root) ?? [];
    calls.push({ type: 'toolCall', id: execution.toolCallId, name: execution.name, arguments: execution.args ?? {} });
    groups.set(root, calls);
  }
  return groups;
}
