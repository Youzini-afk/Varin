import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { ModelReferenceRecord } from './protocol.generated.js';

/** Host assertions use the Catalog's original identity, never a model-facing alias. */
export async function originalProcessOperationId(kernel: KernelClient, reference: string): Promise<string> {
  if (!/^proc:[1-9][0-9]*$/.test(reference)) throw new Error('Expected a model process reference');
  const record = await kernel.agentRuntimeRequest<ModelReferenceRecord, 'runtime.model_reference.resolve'>(
    'runtime.model_reference.resolve', { kind: 'process', reference });
  const target = record.target as { operationId?: unknown };
  if (typeof target.operationId !== 'string' || !target.operationId || target.operationId === reference) {
    throw new Error('Expected the original native process Operation identity');
  }
  return target.operationId;
}

/** Read retained owner output for Host/source assertions without giving it to the model. */
export async function originalToolOutput<T>(runtime: AgentRuntimeClient, branchId: string, callId: string, runId?: string): Promise<{ data: T; model_data?: unknown }> {
  const matches: Array<{ data: T; model_data?: unknown }> = [];
  for (const item of await runtime.history(branchId)) {
    if (item.source !== 'tool' || runId !== undefined && item.run_id !== runId) continue;
    const result = (item.content as { content?: { result?: { call_id?: string; completion?: { content?: { data: T; model_data?: unknown } } } } }).content?.result;
    if (result?.call_id === callId && result.completion?.content) matches.push(result.completion.content);
  }
  if (matches.length !== 1) throw new Error(`Expected one retained tool output for ${callId}, got ${matches.length}`);
  return matches[0]!;
}
