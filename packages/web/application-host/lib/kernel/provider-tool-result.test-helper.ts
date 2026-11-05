import { responsesMetadataText } from './responses-wire.test-helper.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the matched gateway call can own a named invocation envelope. Direct
 * tool data and gateway failures remain intact, even when they contain name. */
export function invokedToolResult(value: Record<string, unknown> | undefined, callName: unknown, args: unknown) {
  const content = value?.content;
  if (callName !== 'tool_invoke' || !record(args) || typeof args.name !== 'string'
    || !record(content) || content.name !== args.name || typeof content.operationId !== 'string'
    || !record(content.completion) || !Object.hasOwn(content, 'result')) return value;
  const completion = content.completion;
  if (!['result', 'job_accepted', 'not_dispatched'].includes(String(completion.kind))
    || completion.kind === 'job_accepted' && typeof completion.operationId !== 'string') return value;
  return { ...completion, operation_id: completion.operationId, content: content.result };
}

export function responsesToolResult(body: Record<string, unknown>, name?: string) {
  const items = body.input as Array<Record<string, unknown>>;
  const selected = name ? items.findLast(item => item.type === 'function_call' && (item.name === name
    || item.name === 'tool_invoke' && JSON.parse(String(item.arguments)).name === name)) : undefined;
  if (name && !selected) return undefined;
  const output = items.findLast(item => item.type === 'function_call_output' && (!selected || item.call_id === selected.call_id));
  if (!output) return undefined;
  const call = items.findLast(item => item.type === 'function_call' && item.call_id === output.call_id);
  const value = JSON.parse(responsesMetadataText(output.output)) as Record<string, unknown>;
  return invokedToolResult(value, call?.name, call?.name === 'tool_invoke' ? JSON.parse(String(call.arguments)) : undefined);
}
