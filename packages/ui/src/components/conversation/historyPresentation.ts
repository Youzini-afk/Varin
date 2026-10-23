import type { JsonValue, Operation, OutputBody } from '@varin/protocol';
import type { ThreadSnapshot, ThreadHistoryItem as HistoryItem, ThreadRunUsage } from '@varin/application-client';
import type { ChatAssistantMessage, ChatSessionEntry, ChatToolExecutionState, ChatUserContent } from './types';
import { presentInvocation, invocationData, invocationGateway, operationStatus } from './toolInvocation';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown): JsonValue => value as JsonValue;

// Dedicated cards keep their original call/history identity through the gateway.
const presentedCall = presentInvocation<Record<string, unknown>>;

function chatThinking(value: Record<string, unknown>): { key: string; text: string } | undefined {
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof value[key] === 'string') return { key, text: value[key] };
  }
  const parts = Array.isArray(value.reasoning_details) ? value.reasoning_details.flatMap(part => {
    const detail = object(part);
    const text = detail.type === 'reasoning.text' ? detail.text : detail.type === 'reasoning.summary' ? detail.summary : undefined;
    return typeof text === 'string' ? [text] : [];
  }) : [];
  return parts.length ? { key: 'reasoning-details', text: parts.join('') } : undefined;
}

function thinkingIdentity(envelope: Record<string, unknown>, fallback: string): string {
  const id = typeof envelope.id === 'string' ? envelope.id : fallback;
  const opaque = object(envelope.opaque);
  // Chat adapters stream these fields as separate items, then retain them in
  // the completed :message envelope. Match that original public stream key.
  if (['openai-completions', 'mistral-conversations'].includes(String(opaque.family)) && id.endsWith(':message')) {
    const thinking = chatThinking(object(opaque.value));
    if (thinking) return id.slice(0, -'message'.length) + thinking.key;
  }
  return id;
}

/** Display only the public thinking text stored in the original provider item. Opaque
 * signatures/encrypted payloads stay untouched; this does not change model replay content. */
function thinkingText(envelope: Record<string, unknown>): string {
  const opaque = object(envelope.opaque), value = object(opaque.value);
  let text: unknown;
  switch (opaque.family) {
    case 'openai-completions': case 'mistral-conversations': text = chatThinking(value)?.text; break;
    case 'anthropic-messages': if (value.type === 'thinking') text = value.thinking; break;
    case 'openai-responses': case 'openai-codex-responses': case 'azure-openai-responses':
      if (value.type === 'reasoning' && Array.isArray(value.summary)) text = value.summary.map(part => object(part).text).filter(part => typeof part === 'string').join('\n');
      break;
    case 'google-generative-ai': case 'google-vertex': { const part = object(value.part); if (part.thought === true) text = part.text; break; }
    case 'bedrock-converse-stream': text = object(object(object(value.block).reasoningContent).reasoningText).text; break;
    case 'pi-messages': { const block = object(value.block); if (block.type === 'thinking' && block.redacted !== true) text = block.thinking; break; }
  }
  return typeof text === 'string' ? text : '';
}

function requestId(item: HistoryItem): string | undefined {
  const id = object(item.content).id;
  if (typeof id !== 'string') return undefined;
  const prefix = /^model-item:(\d+):/.exec(id);
  return prefix ? id.slice(prefix[0].length, prefix[0].length + Number(prefix[1])) : undefined;
}
const callKey = (runId: string | null, request: string, id: string) => JSON.stringify([runId, request, id]);
export function assistant(id: string, content: ChatAssistantMessage['content'], configuration: unknown, pending = false): ChatAssistantMessage {
  const model = object(configuration);
  // providerId is a channel identity, not a display name. Like durable request
  // history, live text shows its accepted request model rather than today's catalog.
  return { id, role: 'assistant', api: '', model: String(model.model ?? ''), provider: '',
    content, timestamp: 0, stopReason: pending ? 'pending' : 'stop' };
}

function outputParts(output: OutputBody | undefined): ChatUserContent[] {
  return output?.parts.flatMap(part => part.kind === 'text' ? [{ type: 'text' as const, text: part.text }] : []) ?? [];
}

/** Pure read projection. Each message/action retains the original native HistoryItem ID. */
export class HistoryPresentation {
  constructor(readonly identity: string) {}
  private entries = new Map<string, ChatSessionEntry>();
  project(history: readonly HistoryItem[], snapshot: Pick<ThreadSnapshot, 'operations' | 'activeRun' | 'children' | 'childExecutions' | 'childActivity'> | undefined, runUsage: readonly ThreadRunUsage[] = [],
    progress: readonly import('@/lib/agent-runtime/thread-projection').ToolExecutionProgress[] = []) {
    const result: ChatSessionEntry[] = [];
    const toolExecutions: Record<string, ChatToolExecutionState> = {};
    const calls = new Map<string, { id: string; name: string; gateway?: unknown }>();
    const operationCalls = new Map<string, string>();
    const children = new Map(snapshot?.children?.map(child => [child.operation_id, child]));
    const live = new Map(progress.map(item => [item.operationId, item]));
    const completed = new Map<string, Record<string, unknown>>(history.flatMap(item => {
      const result = object(object(item.content).content).result;
      const tool = object(result);
      return typeof tool.request_id === 'string' && typeof tool.call_id === 'string'
        ? [[`${tool.request_id}:tool:${tool.call_id}`, object(tool.completion)] as const] : [];
    }));
    for (const item of history) {
      const metadata = item.modelRequest;
      const configuration = metadata ? { model: metadata.modelId } : undefined;
      const envelope = object(item.content);
      const content = object(envelope.content);
      const thinking = thinkingText(envelope);
      const request = metadata?.requestId ?? requestId(item);
      const call = presentedCall(object(content.call));
      if (content.kind === 'tool_call' && typeof call.call_id === 'string') {
        const id = callKey(item.run_id, request ?? item.id, call.call_id);
        calls.set(id, { id: item.id, name: String(call.name), gateway: call.gateway });
        let operation = snapshot?.operations.find(operation => operation.run_id === item.run_id
          && operation.id === `${request}:tool:${call.call_id}`);
        if (operation) toolExecutions[id] = projectExecution(operation, id, call);
        const operationId = `${request}:tool:${call.call_id}`;
        operationCalls.set(operationId, id);
        const receipt = completed.get(operationId);
        const gateway = invocationGateway(object(receipt?.content).data, call);
        const targetOperationId = gateway?.operationId ?? operationId;
        if (gateway) {
          operation = snapshot?.operations.find(value => value.id === targetOperationId && value.run_id === item.run_id);
          toolExecutions[id] = operation ? projectExecution(operation, id, call) : {
            toolCallId: id, operationId: targetOperationId, name: String(call.name), args: json(call.arguments),
            status: gateway.completion.kind === 'job_accepted' ? 'background' : outcomeStatus(gateway.completion.outcome),
          };
          operationCalls.set(targetOperationId, id);
        }
        const candidate = live.get(targetOperationId);
        const update = candidate?.toolName === call.name ? candidate : undefined;
        if ((!operation && !receipt && snapshot?.activeRun?.id === item.run_id) || (update && update.runId === item.run_id)) {
          const running = !receipt && snapshot?.activeRun?.id === item.run_id;
          toolExecutions[id] ??= { toolCallId: id, operationId, name: String(call.name), args: json(call.arguments),
            status: receipt ? outcomeStatus(receipt.outcome) : running ? 'running' : 'unknown' };
          if (update?.runId === item.run_id) toolExecutions[id]!.partialResult = json({ details: update.details });
        }
        const child = children.get(targetOperationId);
        if (child) {
          toolExecutions[id] ??= { toolCallId: id, name: String(call.name), args: json(call.arguments), status: receipt ? outcomeStatus(receipt.outcome) : 'background' };
          toolExecutions[id]!.agent = { threadId: child.child_thread_id, ...(child.avatar ? { avatar: child.avatar } : {}) };
          const execution = snapshot?.childExecutions?.find(row => row.execution_id === targetOperationId);
          toolExecutions[id]!.child = { task: child, execution, activity: snapshot?.childActivity?.[targetOperationId] };
          toolExecutions[id]!.operationId ??= targetOperationId;
        }
      }
      let entry = this.entries.get(item.id);
      if (!entry) {
        const base = { id: item.id, parentId: item.parent, timestamp: '', runId: item.run_id };
        if (item.source === 'user') {
          const text = typeof item.content === 'string' ? item.content : typeof envelope.text === 'string' ? envelope.text : '';
          entry = typeof object(envelope.questionAnswer).operationId === 'string'
            ? { ...base, type: 'custom_message', customType: 'question-answer', display: true, content: text, details: json(envelope.questionAnswer) }
            : { ...base, type: 'message', message: { role: 'user', content: text, timestamp: 0 } };
        } else if (item.source !== 'assistant' && (content.kind === 'text' || content.kind === 'reasoning_summary')) {
          const sender = object(envelope.provenance).thread_id;
          entry = { ...base, type: 'custom_message', customType: item.source === 'agent' ? 'thread-message' : item.source, display: true, content: String(content.text ?? ''),
            ...(item.source === 'agent' && typeof sender === 'string' ? { details: { senderThreadId: sender } } : {}) };
        } else if (content.kind === 'text' || content.kind === 'reasoning_summary') {
          const text = String(content.text ?? '');
          const id = typeof envelope.id === 'string' ? envelope.id : item.id;
          entry = { ...base, type: 'message', message: assistant(item.id, [content.kind === 'text' ? { type: 'text', id, text } : { type: 'thinking', id, thinking: text }], configuration) };
        } else if (content.kind === 'tool_call') {
          entry = { ...base, type: 'message', message: assistant(item.id, [{ type: 'toolCall', id: callKey(item.run_id, request ?? item.id, String(call.call_id)),
            name: String(call.name), arguments: json(call.arguments),
            ...(call.gateway ? { gateway: call.gateway as import('./types').ChatToolCall['gateway'] } : {}) }], configuration) };
        } else if (content.kind === 'tool_result') {
          const toolResult = object(content.result);
          const completion = object(toolResult.completion);
          const id = callKey(item.run_id, String(toolResult.request_id), String(toolResult.call_id));
          const output = completion.content as OutputBody | undefined;
          const gateway = invocationGateway(output?.data, calls.get(id));
          entry = { ...base, type: 'message', message: { role: 'toolResult', historyId: item.id, toolCallId: id, toolName: calls.get(id)?.name ?? 'tool', timestamp: 0,
            isError: completion.kind === 'not_dispatched' || completion.outcome === 'failed',
            ...(completion.kind === 'not_dispatched' ? { notDispatched: true } : {}),
            status: completion.kind === 'not_dispatched' ? 'error' : completion.kind === 'job_accepted' || gateway?.completion.kind === 'job_accepted' ? 'background' : outcomeStatus(completion.outcome),
            content: completion.kind === 'not_dispatched' ? [{ type: 'text', text: String(completion.reason ?? '') }] : outputParts(output),
            ...(output?.data == null ? {} : { details: json(invocationData(output.data, calls.get(id))), originalDetails: json(output.data) }) } };
        } else if (content.kind === 'output') {
          entry = { ...base, type: 'message', message: { role: 'custom', customType: item.source, display: true, timestamp: 0,
            content: outputParts(content.output as OutputBody) } };
        } else if (content.kind === 'provider_only' && thinking) {
          entry = { ...base, type: 'message', message: assistant(item.id, [{ type: 'thinking', id: thinkingIdentity(envelope, item.id), thinking }], configuration) };
        } else if (content.kind === 'provider_only') continue;
        else if (content.kind === 'media') {
          entry = { ...base, type: 'message', message: { role: 'custom', customType: 'media', content: '', display: true, timestamp: 0 } };
        } else {
          entry = { ...base, type: 'custom_message', customType: item.source, display: true,
            content: typeof item.content === 'string' ? item.content : typeof envelope.text === 'string' ? envelope.text : '',
            ...(typeof item.content === 'string' || typeof envelope.text === 'string' ? {} : { details: json(item.content) }) };
        }
        if (entry.type === 'message' && entry.message.role === 'assistant' && thinking && content.kind !== 'provider_only' && content.kind !== 'reasoning_summary') {
          entry.message.content.unshift({ type: 'thinking', id: thinkingIdentity(envelope, item.id), thinking });
        }
        this.entries.set(item.id, entry);
      }
      result.push(entry);
    }
    const nestedByParent = new Map<string, Operation[]>();
    for (const operation of snapshot?.operations ?? []) {
      const origin = object(object(operation.intent).origin);
      if (origin.kind !== 'nested_call' || typeof origin.parent_operation_id !== 'string') continue;
      const siblings = nestedByParent.get(origin.parent_operation_id) ?? [];
      siblings.push(operation); nestedByParent.set(origin.parent_operation_id, siblings);
    }
    const parents = [...operationCalls.keys()];
    for (let index = 0; index < parents.length; index++) {
      const parent = parents[index]!;
      for (const operation of nestedByParent.get(parent) ?? []) {
        if (operationCalls.has(operation.id)) continue;
        const call = presentedCall(object(object(operation.intent).call));
        if (typeof call.name !== 'string') continue;
        operationCalls.set(operation.id, operation.id); parents.push(operation.id);
        toolExecutions[operation.id] = { ...projectExecution(operation, operation.id, call), parentToolCallId: operationCalls.get(parent)! };
        const child = children.get(operation.id);
        if (child) {
          toolExecutions[operation.id]!.agent = { threadId: child.child_thread_id, ...(child.avatar ? { avatar: child.avatar } : {}) };
          toolExecutions[operation.id]!.child = { task: child,
            execution: snapshot?.childExecutions?.find(row => row.execution_id === operation.id),
            activity: snapshot?.childActivity?.[operation.id] };
        }
      }
    }
    const joinedAnswers = new Set<string>();
    for (const entry of result) {
      if (entry.type !== 'custom_message' || entry.customType !== 'question-answer') continue;
      const response = object(entry.details), operationId = response.operationId;
      const callId = typeof operationId === 'string' ? operationCalls.get(operationId) : undefined;
      if (!callId) continue;
      const execution = toolExecutions[callId] ??= { toolCallId: callId, operationId: String(operationId), name: 'ask_user', args: {},
        status: response.cancelled ? 'cancelled' : 'success' };
      execution.questionResponse = json({ ...(response.cancelled ? { cancelled: true } : { answer: entry.content, answers: response.answers }) });
      joinedAnswers.add(entry.id);
    }
    // Keep an answer visible on its own at a paginated boundary. Once its
    // original question is loaded, that row owns the answer disclosure.
    const presented = result.filter(entry => !joinedAnswers.has(entry.id));
    const visible = new Set(presented.map(entry => entry.id));
    const lastByRun = new Map<string, string>();
    const cutByRun = new Map(history.map(item => [item.run_id, item.id]));
    for (const item of history) if (visible.has(item.id)) lastByRun.set(item.run_id, item.id);
    const footers = new Map(runUsage.flatMap(run => {
      const after = lastByRun.get(run.runId);
      if (!after || cutByRun.get(run.runId) !== run.throughId || !run.requests.length) return [];
      const footer: ChatSessionEntry = { id: `run-usage:${run.runId}`, parentId: after, timestamp: '', type: 'run_usage', runId: run.runId,
        usages: run.requests.map(({ requestId, usage, completeInputTokens }) => ({ requestId, measurement: usage.measurement,
          unknownReceipts: usage.measurement === 'missing' || usage.inputTokens === null || usage.outputTokens === null ? 1 : 0,
          ...(completeInputTokens == null ? usage.inputTokens === null ? {} : { input: usage.inputTokens } : { input: completeInputTokens, completeInput: completeInputTokens }),
          ...(usage.outputTokens === null ? {} : { output: usage.outputTokens }),
          ...(usage.cachedInputTokens === null ? {} : { cacheRead: usage.cachedInputTokens }),
          ...(usage.cacheWriteTokens === null ? {} : { cacheWrite: usage.cacheWriteTokens }),
          ...(usage.reasoningTokens === null ? {} : { reasoning: usage.reasoningTokens }),
        })) };
      return [[after, footer] as const];
    }));
    return { entries: presented.flatMap(entry => footers.has(entry.id) ? [entry, footers.get(entry.id)!] : [entry]), toolExecutions };
  }
}

function projectExecution(operation: Operation, id: string, call: Record<string, unknown>): ChatToolExecutionState {
  const completion = operation.call_completion;
  const output = completion && completion.kind !== 'not_dispatched' ? completion.content : undefined;
  return { toolCallId: id, operationId: operation.id, revision: operation.revision, name: String(call.name), args: json(call.arguments),
    status: operationStatus(operation), operation,
    ...(output?.data == null ? {} : { result: json(invocationData(output.data, call)) }) };
}

function outcomeStatus(outcome: unknown): ChatToolExecutionState['status'] {
  return outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'error' : outcome === 'cancelled' ? 'cancelled' : 'unknown';
}
