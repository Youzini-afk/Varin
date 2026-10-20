import type { JsonValue, Operation, OutputBody } from '@varin/protocol';
import type { ThreadSnapshot, ThreadHistoryItem as HistoryItem, ThreadRunUsage } from '@varin/application-client';
import type { ChatAssistantMessage, ChatSessionEntry, ChatToolExecutionState, ChatUserContent } from './types';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown): JsonValue => value as JsonValue;

// Dedicated cards keep their original call/history identity through the gateway.
function presentedCall(call: Record<string, unknown>): Record<string, unknown> {
  const args = object(call.arguments);
  const name = object(args.reference).name;
  return call.name === 'tool_invoke' && (name === 'render_ui' || name === 'code_retrieval')
    ? { ...call, name, arguments: args.arguments }
    : call;
}
function presentedOutput(data: unknown): unknown {
  const value = object(data);
  const name = object(value.reference).name;
  return (name === 'render_ui' && object(value.result).kind === 'ui')
    || (name === 'code_retrieval' && typeof object(value.result).status === 'string')
    ? value.result : data;
}

/** Display only the public thinking text stored in the original provider item. Opaque
 * signatures/encrypted payloads stay untouched; this does not change model replay content. */
function thinkingText(envelope: Record<string, unknown>): string {
  const opaque = object(envelope.opaque), value = object(opaque.value);
  let text: unknown;
  switch (opaque.family) {
    case 'openai-completions': case 'mistral-conversations': text = value.reasoning_content ?? value.reasoning; break;
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
  project(history: readonly HistoryItem[], snapshot: ThreadSnapshot | undefined, runUsage: readonly ThreadRunUsage[] = [],
    progress: readonly import('@/lib/agent-runtime/thread-projection').ToolExecutionProgress[] = []) {
    const result: ChatSessionEntry[] = [];
    const toolExecutions: Record<string, ChatToolExecutionState> = {};
    const calls = new Map<string, { id: string; name: string }>();
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
        calls.set(id, { id: item.id, name: String(call.name) });
        const operation = snapshot?.operations.find(operation => operation.run_id === item.run_id
          && operation.id === `${request}:tool:${call.call_id}`);
        if (operation) toolExecutions[id] = projectExecution(operation, id, call);
        const operationId = `${request}:tool:${call.call_id}`;
        const receipt = completed.get(operationId);
        const candidate = live.get(operationId);
        const update = candidate?.toolName === call.name ? candidate : undefined;
        if ((!operation && !receipt && snapshot?.activeRun?.id === item.run_id) || (update && update.runId === item.run_id)) {
          const running = !receipt && snapshot?.activeRun?.id === item.run_id;
          toolExecutions[id] ??= { toolCallId: id, operationId, name: String(call.name), args: json(call.arguments),
            status: receipt ? outcomeStatus(receipt.outcome) : running ? 'running' : 'unknown' };
          if (update?.runId === item.run_id) toolExecutions[id]!.partialResult = json({ details: update.details });
        }
        const child = children.get(operationId);
        if (child) {
          toolExecutions[id] ??= { toolCallId: id, name: String(call.name), args: json(call.arguments), status: receipt ? outcomeStatus(receipt.outcome) : 'background' };
          toolExecutions[id]!.agent = { threadId: child.child_thread_id, ...(child.avatar ? { avatar: child.avatar } : {}) };
        }
      }
      let entry = this.entries.get(item.id);
      if (!entry) {
        const base = { id: item.id, parentId: item.parent, timestamp: '', runId: item.run_id };
        if (item.source === 'user') {
          const text = typeof item.content === 'string' ? item.content : typeof envelope.text === 'string' ? envelope.text : '';
          entry = { ...base, type: 'message', message: { role: 'user', content: text, timestamp: 0 } };
        } else if (item.source !== 'assistant' && (content.kind === 'text' || content.kind === 'reasoning_summary')) {
          const sender = object(envelope.provenance).thread_id;
          entry = { ...base, type: 'custom_message', customType: item.source === 'agent' ? 'thread-message' : item.source, display: true, content: String(content.text ?? ''),
            ...(item.source === 'agent' && typeof sender === 'string' ? { details: { senderThreadId: sender } } : {}) };
        } else if (content.kind === 'text' || content.kind === 'reasoning_summary') {
          const text = String(content.text ?? '');
          entry = { ...base, type: 'message', message: assistant(item.id, [content.kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text }], configuration) };
        } else if (content.kind === 'tool_call') {
          entry = { ...base, type: 'message', message: assistant(item.id, [{ type: 'toolCall', id: callKey(item.run_id, request ?? item.id, String(call.call_id)),
            name: String(call.name), arguments: json(call.arguments) }], configuration) };
        } else if (content.kind === 'tool_result') {
          const toolResult = object(content.result);
          const completion = object(toolResult.completion);
          const id = callKey(item.run_id, String(toolResult.request_id), String(toolResult.call_id));
          const output = completion.content as OutputBody | undefined;
          entry = { ...base, type: 'message', message: { role: 'toolResult', historyId: item.id, toolCallId: id, toolName: calls.get(id)?.name ?? 'tool', timestamp: 0,
            isError: completion.kind === 'not_dispatched' || completion.outcome === 'failed',
            status: completion.kind === 'not_dispatched' ? 'error' : completion.kind === 'job_accepted' ? 'background' : outcomeStatus(completion.outcome),
            content: completion.kind === 'not_dispatched' ? [{ type: 'text', text: String(completion.reason ?? '') }] : outputParts(output),
            ...(output?.data == null ? {} : { details: json(presentedOutput(output.data)) }) } };
        } else if (content.kind === 'output') {
          entry = { ...base, type: 'message', message: { role: 'custom', customType: item.source, display: true, timestamp: 0,
            content: outputParts(content.output as OutputBody) } };
        } else if (content.kind === 'provider_only' && thinking) {
          entry = { ...base, type: 'message', message: assistant(item.id, [{ type: 'thinking', thinking }], configuration) };
        } else if (content.kind === 'provider_only') continue;
        else if (content.kind === 'media') {
          entry = { ...base, type: 'message', message: { role: 'custom', customType: 'media', content: '', display: true, timestamp: 0 } };
        } else {
          entry = { ...base, type: 'custom_message', customType: item.source, display: true,
            content: typeof item.content === 'string' ? item.content : typeof envelope.text === 'string' ? envelope.text : '',
            ...(typeof item.content === 'string' || typeof envelope.text === 'string' ? {} : { details: json(item.content) }) };
        }
        if (entry.type === 'message' && entry.message.role === 'assistant' && thinking && content.kind !== 'provider_only' && content.kind !== 'reasoning_summary') {
          entry.message.content.unshift({ type: 'thinking', thinking });
        }
        this.entries.set(item.id, entry);
      }
      result.push(entry);
    }
    const visible = new Set(result.map(entry => entry.id));
    const lastByRun = new Map<string, string>();
    const cutByRun = new Map(history.map(item => [item.run_id, item.id]));
    for (const item of history) if (visible.has(item.id)) lastByRun.set(item.run_id, item.id);
    const footers = new Map(runUsage.flatMap(run => {
      const after = lastByRun.get(run.runId);
      if (!after || cutByRun.get(run.runId) !== run.throughId || !run.requests.length) return [];
      const footer: ChatSessionEntry = { id: `run-usage:${run.runId}`, parentId: after, timestamp: '', type: 'run_usage', runId: run.runId,
        usages: run.requests.map(({ requestId, usage }) => ({ requestId, measurement: usage.measurement,
          unknownReceipts: usage.measurement === 'missing' || usage.inputTokens === null || usage.outputTokens === null ? 1 : 0,
          ...(usage.inputTokens === null ? {} : { input: usage.inputTokens }),
          ...(usage.outputTokens === null ? {} : { output: usage.outputTokens }),
          ...(usage.cachedInputTokens === null ? {} : { cacheRead: usage.cachedInputTokens }),
          ...(usage.cacheWriteTokens === null ? {} : { cacheWrite: usage.cacheWriteTokens }),
          ...(usage.reasoningTokens === null ? {} : { reasoning: usage.reasoningTokens }),
        })) };
      return [[after, footer] as const];
    }));
    return { entries: result.flatMap(entry => footers.has(entry.id) ? [entry, footers.get(entry.id)!] : [entry]), toolExecutions };
  }
}

function projectExecution(operation: Operation, id: string, call: Record<string, unknown>): ChatToolExecutionState {
  const completion = operation.call_completion;
  const output = completion && completion.kind !== 'not_dispatched' ? completion.content : undefined;
  return { toolCallId: id, operationId: operation.id, name: String(call.name), args: json(call.arguments),
    status: operation.phase === 'terminal' ? outcomeStatus(operation.outcome) : operation.executor === 'ask_user' ? 'waiting' : 'running',
    ...(output?.data == null ? {} : { result: json(presentedOutput(output.data)) }) };
}

function outcomeStatus(outcome: unknown): ChatToolExecutionState['status'] {
  return outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'error' : outcome === 'cancelled' ? 'cancelled' : 'unknown';
}
