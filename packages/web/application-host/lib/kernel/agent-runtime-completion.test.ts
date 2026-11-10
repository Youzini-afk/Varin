import { expect, it, vi } from 'vitest';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { MediaReadChunk, Operation, OutputBody, StoredMedia } from './protocol.generated.js';

it.each(['result', 'job_accepted'] as const)('rehydrates %s media without changing the original raw or model receipt', async kind => {
  const media: StoredMedia = { media_type: 'image/png', source: { kind: 'operation', operation_id: 'original-operation' },
    content_ref: { content_object: 'original-media' } };
  const bytes = Buffer.from('original image bytes');
  const requests = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'runtime.run.inspect') return { thread_id: 'original-thread', branch_id: 'original-branch' };
    if (method !== 'runtime.output.media.read') throw new Error(`Unexpected request: ${method}`);
    expect(params).toMatchObject({ threadId: 'original-thread', branchId: 'original-branch',
      holder: { kind: 'operation', operationId: 'original-operation', output: 'completion' }, partIndex: 1,
      expectedContentRef: 'original-media' });
    const chunkIndex = params.chunkIndex as number;
    const chunk: MediaReadChunk = { media, partIndex: 1, chunkIndex, chunkCount: 2, totalBytes: bytes.length,
      bytesBase64: (chunkIndex === 0 ? bytes.subarray(0, 5) : bytes.subarray(5)).toString('base64') };
    return chunk;
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  for (const projection of [undefined, null, { operationRef: 'env:7', result: 'readable result' }]) {
    const body: OutputBody = { data: { operationId: 'original-operation', receiptEpoch: 'original-epoch' },
      ...(projection === undefined ? {} : { model_data: projection }),
      parts: [{ kind: 'text', text: 'Before image' }, { kind: 'media', media }, { kind: 'text', text: 'After image' }] };
    const operation: Operation = { id: 'original-operation', run_id: 'original-run', epoch: 1, revision: 3,
      phase: 'running', outcome: null, effect: 'dispatched', cancel_requested: false, lifetime: 'thread',
      handed_off: false, executor: 'original-host', waiting_on: null, intent: {}, result: null,
      execution_owner: { kind: 'external', identity: 'original-host', epoch: 'original-epoch' }, external_receipt: null,
      call_completion: kind === 'result' ? { kind, outcome: 'succeeded', effect: 'confirmed', content: body }
        : { kind, operation_id: 'original-operation', phase: 'running', effect: 'dispatched', lifetime: 'thread', content: body } };
    const original = structuredClone(operation);
    const hydrated = await runtime.inlineCompletion(operation);
    expect(hydrated).toEqual({ ...operation.call_completion, content: { ...body,
      parts: [body.parts[0], { kind: 'media', media: { media_type: media.media_type, data_base64: bytes.toString('base64') } }, body.parts[2]] } });
    expect(operation).toEqual(original);
    if (hydrated.kind === 'not_dispatched' || !hydrated.content) throw new Error('Expected original content');
    expect(Object.hasOwn(hydrated.content, 'model_data')).toBe(projection !== undefined);
  }
});
