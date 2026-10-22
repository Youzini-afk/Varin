import React from 'react';
import type { ChatSessionEntry, ChatToolCall, ChatToolExecutionState } from './types';
import { invocationData, invocationGateway, invocationOperationId, presentInvocation, toolRecord, toolText } from './toolInvocation';

export interface ToolTargets { processes: Map<string, string>; children: Map<string, string>; threads: Map<string, string> }
export const ToolTargetContext = React.createContext<ToolTargets | null>(null);
export const useToolTargets = () => React.useContext(ToolTargetContext);
export const processCommand = (args: Record<string, unknown>) => [toolText(args.command),
  ...(Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === 'string') : [])].filter(Boolean).join(' ');

/** Resolve human-readable targets from already loaded calls. No extra history reads or global cache. */
export function collectToolTargets(entries: readonly ChatSessionEntry[], executions: Record<string, ChatToolExecutionState>): ToolTargets {
  const targets: ToolTargets = { processes: new Map(), children: new Map(), threads: new Map() };
  const receipts = new Map(entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult'
    ? [[entry.message.toolCallId, entry.message.details] as const] : []));
  const add = (original: ChatToolCall, execution?: ChatToolExecutionState) => {
    const call = presentInvocation(original), args = toolRecord(call.arguments);
    const receipt = receipts.get(call.id) ?? execution?.result;
    const data = toolRecord(invocationData(receipt, call));
    const id = invocationGateway(receipt, call)?.operationId ?? invocationOperationId(call, execution);
    if (call.name === 'process_spawn') {
      const command = processCommand(args);
      if (command) for (const key of [id, toolText(data.processId), toolText(toolRecord(data.process).processId)]) if (key) targets.processes.set(key, command);
    }
    if (call.name === 'dispatch') {
      const name = toolText(args.name) || toolText(args.task);
      if (id && name) targets.children.set(id, name);
      if (typeof data.threadId === 'string' && name) targets.threads.set(data.threadId, name);
    }
    const child = execution?.child?.task, delegated = execution?.child?.execution;
    if (id && child?.name) targets.children.set(id, child.name);
    if (delegated?.name) targets.children.set(delegated.execution_id, delegated.name);
    if (child?.name && child.child_thread_id) targets.threads.set(child.child_thread_id, child.name);
    if (call.name === 'threads' && Array.isArray(data.members)) for (const item of data.members) {
      const member = toolRecord(item);
      if (typeof member.threadId === 'string' && typeof member.name === 'string') targets.threads.set(member.threadId, member.name);
    }
  };
  for (const entry of entries) if (entry.type === 'message' && entry.message.role === 'assistant') {
    for (const content of entry.message.content) if (content.type === 'toolCall') add(content, executions[content.id]);
  }
  for (const execution of Object.values(executions)) add({ type: 'toolCall', id: execution.toolCallId,
    name: execution.name, arguments: execution.args ?? {} }, execution);
  return targets;
}

