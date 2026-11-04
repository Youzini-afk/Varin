import { parseConversationContent, type UiReceipt } from '@varin/application-client';
import type { HistoryReference } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { toolOperationId } from '../kernel/protocol.generated.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fixedReceipt = (value: unknown): string | undefined => {
  const receipt = object(value);
  return receipt.kind === 'ui' && typeof receipt.ref === 'string' && /^ui:[a-zA-Z0-9_-]+@[1-9]\d*$/.test(receipt.ref) ? receipt.ref : undefined;
};
/** A receipt-looking object is not an anchor. Bind the original native tool-result envelope
 * to the UI owner's committed operation receipt. Gateway outputs additionally prove parentage. */
export async function historicalUiRevision(reference: HistoryReference, runtime: Pick<AgentRuntimeClient, 'historyItem' | 'findOperation'>,
  receiptForOperation: (operationId: string) => Promise<UiReceipt | null>, signal?: AbortSignal): Promise<string | undefined> {
  if (reference.source !== 'tool') return undefined;
  const item = await runtime.historyItem(reference, signal), content = object(object(item.content).content);
  if (content.kind !== 'tool_result') return undefined;
  const result = object(content.result), completion = object(result.completion);
  if (typeof result.request_id !== 'string' || !result.request_id || typeof result.call_id !== 'string' || !result.call_id
    || completion.kind !== 'result' || completion.outcome !== 'succeeded') return undefined;
  const operationId = toolOperationId({ kind: 'model_step', request_id: result.request_id }, result.call_id);
  const data = object(completion.content).data, direct = fixedReceipt(data);
  if (direct) {
    if (completion.effect !== 'confirmed') return undefined;
    const saved = await receiptForOperation(operationId);
    return saved?.ref === direct ? direct : undefined;
  }
  const gateway = object(data), nestedRef = fixedReceipt(gateway.result), summary = object(gateway.completion);
  if (!nestedRef || object(gateway.reference).name !== 'render_ui' || typeof gateway.operationId !== 'string'
    || summary.kind !== 'result' || summary.outcome !== 'succeeded') return undefined;
  // Only the native owner can establish gateway parentage. Do not dereference an
  // arbitrary operation ID supplied by another tool's receipt-shaped output.
  // findOperation maps only the native NotFound case to null; other failures propagate.
  const parent = await runtime.findOperation(operationId, signal);
  if (!parent || parent.id !== operationId || parent.run_id !== reference.run_id) return undefined;
  const parentCall = object(object(parent.intent).call);
  if (parentCall.name !== 'tool_invoke' || object(object(parentCall.arguments).reference).name !== 'render_ui') return undefined;
  const nested = await runtime.findOperation(gateway.operationId, signal);
  if (!nested) return undefined;
  const childIntent = object(nested.intent), childCall = object(childIntent.call), origin = object(childIntent.origin);
  const nestedCompletion = nested.call_completion;
  if (nested.id !== gateway.operationId || nested.run_id !== parent.run_id
    || childCall.name !== 'render_ui' || typeof childCall.call_id !== 'string'
    || nested.id !== toolOperationId({ kind: 'nested_call', parent_operation_id: parent.id }, childCall.call_id) || origin.kind !== 'nested_call' || origin.parent_operation_id !== parent.id
    || !nestedCompletion || nestedCompletion.kind !== 'result' || nestedCompletion.outcome !== 'succeeded' || nestedCompletion.effect !== 'confirmed'
    || fixedReceipt(nestedCompletion.content.data) !== nestedRef) return undefined;
  const saved = await receiptForOperation(nested.id);
  return saved?.ref === nestedRef ? nestedRef : undefined;
}

/** Explicit assistant embeds are a presentation anchor even when another family branch
 * produced the work. Plain text, quoted code, user content and tool data remain opaque. */
export async function historicalUiEmbeds(reference: HistoryReference, runtime: Pick<AgentRuntimeClient, 'historyItem'>,
  resolveFixedRef: (ref: string) => Promise<boolean>, signal?: AbortSignal): Promise<string[]> {
  if (reference.source !== 'assistant') return [];
  const item = await runtime.historyItem(reference, signal), body = object(object(item.content).content);
  const texts: string[] = [];
  if (body.kind === 'text' && typeof body.text === 'string') texts.push(body.text);
  else if (body.kind === 'output') {
    const parts = object(body.output).parts;
    if (Array.isArray(parts)) for (const part of parts) { const value = object(part); if (value.kind === 'text' && typeof value.text === 'string') texts.push(value.text); }
  }
  const refs = new Set<string>();
  for (const text of texts) for (const part of parseConversationContent(text, { role: 'assistant' })) {
    if (part.kind === 'ui' && part.node.type === 'embed') refs.add(part.node.ref);
  }
  const available: string[] = [];
  for (const ref of refs) if (await resolveFixedRef(ref)) available.push(ref);
  return available;
}
