import type { JsonValue, Operation } from '@varin/protocol';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';

export const toolRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const toolText = (value: unknown): string => typeof value === 'string' ? value : '';

/** The gateway is a transport for the named call. Preserve its original input for inspection. */
export function presentInvocation<T extends { name?: unknown; arguments?: unknown }>(call: T): T {
  const args = toolRecord(call.arguments), reference = toolRecord(args.reference);
  if (call.name !== 'tool_invoke' || typeof reference.name !== 'string' || !reference.name
    || reference.name === 'tool_invoke' || !Object.hasOwn(args, 'arguments')) return call;
  return { ...call, name: reference.name, arguments: args.arguments,
    gateway: { name: call.name, arguments: call.arguments } };
}

/** Only unwrap an actual gateway receipt matching this call; arbitrary output data stays opaque. */
export function invocationData(data: unknown, call?: { name?: unknown; gateway?: unknown }): unknown {
  const value = toolRecord(data);
  return call?.gateway && toolRecord(value.reference).name === call.name && Object.hasOwn(value, 'result')
    ? value.result : data;
}

export function invocationGateway(data: unknown, call?: { name?: unknown; gateway?: unknown }) {
  const value = toolRecord(data);
  return call?.gateway && toolRecord(value.reference).name === call.name && typeof value.operationId === 'string'
    ? { operationId: value.operationId, completion: toolRecord(value.completion) } : undefined;
}

export function invocationOperationId(call: ChatToolCall, execution?: ChatToolExecutionState): string | undefined {
  if (execution?.operationId) return execution.operationId;
  try {
    const identity: unknown = JSON.parse(call.id);
    if (Array.isArray(identity) && identity.length === 3 && typeof identity[1] === 'string' && typeof identity[2] === 'string')
      return identity[1] + ':tool:' + identity[2];
  } catch { /* Preview-only calls and nested operations retain their own identities. */ }
  return undefined;
}

export function operationStatus(operation: Operation): ChatToolExecutionState['status'] {
  if (operation.phase !== 'terminal') return operation.executor === 'ask_user' || operation.waiting_on?.startsWith('permission:') ? 'waiting' : 'running';
  return operation.outcome === 'succeeded' ? 'success' : operation.outcome === 'failed' ? 'error'
    : operation.outcome === 'cancelled' ? 'cancelled' : 'unknown';
}

export function invocationStatus(result?: ChatToolResultMessage, execution?: ChatToolExecutionState, generating = false): ChatToolExecutionState['status'] {
  if (generating && !result && !execution) return 'running';
  if (result?.status === 'background') return execution?.status ?? 'background';
  return result ? result.status ?? (result.isError ? 'error' : 'success') : execution?.status ?? 'unknown';
}

/** Script detail consumes the original Operation, including its retained media holder. */
export function operationInvocation(operation: Operation, target?: Operation) {
  const source = toolRecord(toolRecord(operation.intent).call);
  const call: ChatToolCall = presentInvocation({ type: 'toolCall' as const, id: operation.id,
    name: toolText(source.name) || operation.executor || 'tool', arguments: (source.arguments ?? {}) as JsonValue });
  const completion = operation.call_completion;
  const output = completion && completion.kind !== 'not_dispatched' ? completion.content : undefined;
  const gateway = invocationGateway(output?.data, call);
  const resolved = target && gateway?.operationId === target.id ? target : undefined;
  const status = resolved ? operationStatus(resolved) : gateway?.completion.kind === 'job_accepted' ? 'background' : operationStatus(operation);
  const result: ChatToolResultMessage | undefined = completion ? {
    role: 'toolResult', toolCallId: operation.id, toolName: call.name, timestamp: 0, operation,
    isError: completion.kind === 'not_dispatched' || completion.kind === 'result' && completion.outcome === 'failed',
    status: completion.kind === 'not_dispatched' ? 'error' : completion.kind === 'job_accepted' || gateway?.completion.kind === 'job_accepted' ? 'background' : status,
    notDispatched: completion.kind === 'not_dispatched',
    content: completion.kind === 'not_dispatched' ? [{ type: 'text', text: completion.reason }]
      : output?.parts.flatMap(part => part.kind === 'text' ? [{ type: 'text' as const, text: part.text }] : []) ?? [],
    ...(output?.data == null ? {} : { details: invocationData(output.data, call) as JsonValue, originalDetails: output.data as JsonValue }),
  } : undefined;
  const execution: ChatToolExecutionState = { toolCallId: operation.id, operationId: gateway?.operationId ?? operation.id,
    name: call.name, args: call.arguments, status, revision: (resolved ?? operation).revision,
    operation: gateway ? resolved : operation };
  return { call, result, execution };
}
